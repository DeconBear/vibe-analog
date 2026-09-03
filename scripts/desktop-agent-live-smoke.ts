import assert from 'node:assert/strict';
import { readdir, readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Live-provider end-to-end smoke for the desktop CodeAct agent.
 *
 * Tiers (ACTOVIQ_LIVE_SMOKE_TIER):
 *  - connectivity: the provider answers a trivial turn through the full agent loop.
 *  - design:       the provider drives circuit tools end to end (project + module v2
 *                  JSON lands in the workspace and the compile pipeline emits
 *                  netlist/SVG artifacts) without simulation.
 *
 * Required env:
 *  - ACTOVIQ_LIVE_PROVIDER=1
 *  - ACTOVIQ_API_KEY        (provider API key; never written to disk or logs)
 * Optional env:
 *  - ACTOVIQ_BASE_URL       (default: Zhipu coding plan OpenAI-compatible endpoint)
 *  - ACTOVIQ_MODEL          (default: glm-5.3-flash)
 *  - ACTOVIQ_LIVE_SMOKE_TIER connectivity | design (default: connectivity)
 *  - ACTOVIQ_LIVE_SMOKE_TIMEOUT_MS (default: 480000)
 */

interface DesktopAgentEvent {
  type: string;
  [key: string]: unknown;
}

interface DesktopAgentChatResponse {
  text: string;
  isError?: boolean;
  model?: string;
  usage?: Record<string, unknown>;
}

const DESIGN_TIER = 'design';
const tier = process.argv.includes('--tier')
  ? process.argv[process.argv.indexOf('--tier') + 1] === DESIGN_TIER
    ? DESIGN_TIER
    : 'connectivity'
  : process.env.ACTOVIQ_LIVE_SMOKE_TIER === DESIGN_TIER
    ? DESIGN_TIER
    : 'connectivity';
const timeoutMs = Number.parseInt(process.env.ACTOVIQ_LIVE_SMOKE_TIMEOUT_MS ?? '', 10) || 480_000;

const apiKey = process.env.ACTOVIQ_API_KEY?.trim() ?? '';
const baseURL = process.env.ACTOVIQ_BASE_URL?.trim() || 'https://open.bigmodel.cn/api/coding/paas/v4';
const model = process.env.ACTOVIQ_MODEL?.trim() || 'glm-5.3-flash';

const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'actoviq-live-smoke-ws-'));
const homeDir = await mkdtemp(path.join(tmpdir(), 'actoviq-live-smoke-home-'));
process.env.ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT = workspaceRoot;
process.env.ACTOVIQ_E2E_WORKSPACE_ROOT = workspaceRoot;

const { closeDesktopAgentService, startDesktopAgentRun } = await import(
  '../electron/agent/desktopAgentService.ts'
);

async function* walkFiles(root: string): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(entryPath);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}

async function assertSecretAbsentFromFiles(): Promise<void> {
  for (const root of [homeDir, workspaceRoot]) {
    for await (const filePath of walkFiles(root)) {
      const stat = await readFile(filePath).catch(() => null);
      if (!stat) continue;
      assert.ok(
        !stat.includes(apiKey),
        `provider API key leaked to disk at ${filePath}`,
      );
    }
  }
}

async function findWorkspaceArtifact(predicate: (filePath: string, content: Buffer) => boolean) {
  for await (const filePath of walkFiles(workspaceRoot)) {
    const content = await readFile(filePath).catch(() => null);
    if (content && predicate(filePath, content)) return filePath;
  }
  return null;
}

function timeoutGuard(): { promise: Promise<never>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`live smoke tier=${tier} exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function runSmokeTier(): Promise<void> {
  const message =
    tier === DESIGN_TIER
      ? [
          'Create a simulation project named "Live Smoke RC".',
          'Design one module: a first-order RC low-pass filter with R=1k and C=160nF (fc ~ 1kHz),',
          'with a SPICE netlist notebook containing the .ac dec analysis directive.',
          'Compile the project so the netlist and schematic SVG artifacts are produced.',
          'Do NOT run any simulation. Keep the design minimal; finish after compiling.',
        ].join(' ')
      : 'Reply briefly that the built-in circuit assistant is ready. Do not create a design.';

  const events: DesktopAgentEvent[] = [];
  const guard = timeoutGuard();
  try {
    const handle = startDesktopAgentRun(
      { provider: 'openai', apiKey, baseURL, model, homeDir, workDir: process.cwd() },
      {
        conversationId: `live-smoke-${tier}-${Date.now()}`,
        message,
        context: { activeJobId: null, activeProject: null, approvalPolicy: 'all', workspaceRoot },
      },
      (event) => events.push(event),
    );

    const result = (await Promise.race([handle.result, guard.promise])) as DesktopAgentChatResponse;
    assert.equal(result.isError, undefined, `the live provider returned an agent error: ${result.text?.slice(0, 400)}`);
    assert.ok(events.some((event) => event.type === 'completed'), 'the run never emitted a completed event');

    if (tier === DESIGN_TIER) {
      const moduleJson = await findWorkspaceArtifact(
        (filePath, content) =>
          filePath.endsWith('.json') && content.includes('actoviq.module.v2'),
      );
      assert.ok(moduleJson, 'no actoviq.module.v2 module JSON was written to the workspace');
      const compiledArtifact = await findWorkspaceArtifact(
        (filePath, content) =>
          filePath.endsWith('.svg') || /\.spice$|\.cir$|\.net$/.test(filePath) || content.includes('.ac dec'),
      );
      assert.ok(compiledArtifact, 'no compiled netlist/SVG artifact was found in the workspace');
      console.log(`live smoke design artifacts: ${moduleJson}`);
      console.log(`live smoke compiled artifact: ${compiledArtifact}`);
    }

    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes(apiKey), 'provider API key leaked into agent events');
    if (typeof result.usage === 'object' && result.usage) {
      console.log(`live smoke usage: ${JSON.stringify(result.usage)}`);
    }
  } finally {
    guard.cancel();
    await closeDesktopAgentService().catch(() => undefined);
    await assertSecretAbsentFromFiles();
    await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (process.env.ACTOVIQ_LIVE_PROVIDER !== '1' || !apiKey) {
  console.log('live provider smoke: skipped (set ACTOVIQ_LIVE_PROVIDER=1 and ACTOVIQ_API_KEY to enable)');
  await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  process.exit(0);
}

console.log(`live provider smoke: tier=${tier} model=${model} base=${baseURL}`);
await runSmokeTier();
console.log(`live provider smoke: passed (${tier})`);
