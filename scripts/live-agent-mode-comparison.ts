import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Live desktop-agent A/B harness: runs one circuit design task through the
 * real desktop agent service against a live provider and records metrics.
 *
 * Usage:
 *   ACTOVIQ_API_KEY=... VIBE_DESKTOP_AGENT_MODE=codeact npx tsx scripts/live-agent-mode-comparison.ts
 *
 * Env:
 *   ACTOVIQ_API_KEY    (required) live provider key
 *   ACTOVIQ_BASE_URL   default https://ark.cn-beijing.volces.com/api/plan
 *   ACTOVIQ_MODEL      default glm-5.3
 *   VIBE_DESKTOP_AGENT_MODE  react | codeact (default codeact)
 *   ACTOVIQ_CASE_ID    stable output subdirectory name, default baseline
 *   ACTOVIQ_ROUNDS     rounds per invocation, default 1
 *   ACTOVIQ_TASK       overrides the design task prompt
 */

const DEFAULT_TASK = [
  '设计一个两级放大电路并完成验证：',
  '第一级为NMOS共源放大器（电阻负载、源极负反馈电阻+旁路电容），',
  '第二级为NPN射极跟随器（发射极电阻到地），两级间用耦合电容连接，供电12V。',
  '要求：创建项目、应用事务、运行ERC并修复阻塞错误、编译、运行AC仿真（10Hz-10MHz）。',
  '器件数超过8个时必须拆分多个模块。完成后用中文总结项目id、修订号、ERC结果、模块数和仿真状态。',
].join('');

const COMPLEX_TASKS: Record<string, string> = {
  'differential-chain': [
    '设计并验证一个多模块、三级双极型晶体管差分放大链，使用±12V供电。',
    '输入级必须是NPN长尾差分对（差分AC激励、集电极电阻、公共发射极尾电阻）；',
    '第二级必须是经电容耦合并由电阻分压偏置的NPN共射级；',
    '第三级必须是经电容耦合并由电阻分压偏置的NPN射极跟随器，输出端接1kΩ负载和负载电容。',
    '总器件数不少于14个，按“激励与供电、差分输入级、电压增益级、输出缓冲级”拆成至少4个模块，任何模块不超过8个器件。',
    '只使用R/C/Q/V/I原语和模块内.model，不使用X/E/F/G/H/B/A/U、.subckt、.include或独立网标。',
    '要求创建项目、尽量批量应用事务、运行ERC并修复阻塞错误、编译，并运行当前修订的项目级AC仿真（10Hz-10MHz）。',
    '若第一次编译或仿真失败，读取当前修订结果，做最小修复后重新ERC、编译和项目级仿真。',
    '完成后用中文总结项目id、当前修订号、ERC错误数、模块数、项目级仿真状态，并从仿真数据估算1kHz附近电压增益。',
  ].join(''),
  'ring-oscillator': [
    '设计并验证一个1.8V、三级CMOS环形振荡器及隔离输出缓冲器，重点验证瞬态启动和持续振荡。',
    '环振核心使用3个CMOS反相器（共6个M原语）闭环；独立动态负载/启动模块给三个环节点各加电容，并用短脉冲电流源打破对称；',
    '独立输出缓冲模块再用1个CMOS反相器驱动负载电容；另设供电与分析模块。',
    '总器件数不少于12个，至少4个模块，任何模块不超过8个器件；MOS必须使用模块内LEVEL=1的NMOS/PMOS .model。',
    '只使用M/C/V/I/R原语，不使用X/E/F/G/H/B/A/U、.subckt、.include或独立网标。',
    '要求创建项目、批量应用事务、正确连接跨模块反馈和电源、运行ERC并修复阻塞错误、编译，',
    '并运行当前修订的项目级瞬态仿真（建议步长不大于20ps、时长至少100ns）。',
    '若第一次仿真没有成功或没有形成持续振荡，读取结果后最小调整启动脉冲/负载/器件参数，再从当前修订重新验证。',
    '完成后用中文总结项目id、当前修订号、ERC错误数、模块数、项目级仿真状态，以及缓冲输出是否持续振荡和估算频率。',
  ].join(''),
};

interface RunMetrics {
  caseId: string;
  mode: string;
  round: number;
  isError: boolean;
  errorText?: string;
  wallClockMs: number;
  modelRequests: number;
  codeCellCalls: number;
  hostToolCalls: number;
  hostToolErrors: number;
  toolCallCounts: Record<string, number>;
  toolErrorCounts: Record<string, number>;
  promptTokens: number;
  completionTokens: number;
  usageAvailable: boolean;
  finalText: string;
  projectId?: string;
  project: {
    created: boolean;
    revision?: number;
    moduleCount?: number;
    moduleIds?: string[];
    ercBlocking?: boolean;
    ercErrors?: number;
    buildStatus?: string;
    simulationStatus?: string;
    simulated?: boolean;
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function readJson(filePath: string): Promise<any> {
  return readFile(filePath, 'utf8').then((text) => JSON.parse(text));
}

async function assessProject(
  projectsRoot: string,
  projectId?: string,
  snapshotRoot?: string,
): Promise<RunMetrics['project']> {
  const result: RunMetrics['project'] = { created: false };
  let root: string | undefined;
  if (projectId && path.isAbsolute(projectId)) {
    // The service may surface a resolved project root as the touched id.
    if (await exists(projectId)) root = projectId;
  } else if (projectId) {
    const candidate = path.join(projectsRoot, projectId);
    if (await exists(candidate)) root = candidate;
  }
  if (!root) {
    // Fallback: newest project directory.
    try {
      const entries = await readdir(projectsRoot, { withFileTypes: true });
      const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(projectsRoot, entry.name));
      let newestMtime = 0;
      for (const dir of dirs) {
        const projectFile = path.join(dir, 'project.circuit.json');
        if (!(await exists(projectFile))) continue;
        const { stat } = await import('node:fs/promises');
        const info = await stat(projectFile);
        if (info.mtimeMs > newestMtime) {
          newestMtime = info.mtimeMs;
          root = dir;
        }
      }
    } catch {
      // ignore
    }
  }
  if (!root) return result;
  result.created = true;
  if (snapshotRoot) {
    await mkdir(path.dirname(snapshotRoot), { recursive: true });
    await cp(root, snapshotRoot, { recursive: true, force: true });
  }
  try {
    const project = await readJson(path.join(root, 'project.circuit.json'));
    result.revision = project.revision;
    result.moduleCount = Array.isArray(project.modules) ? project.modules.length : 0;
    result.moduleIds = (project.modules ?? []).map((module: { id: string }) => module.id);
  } catch {
    // ignore
  }
  try {
    const erc = await readJson(path.join(root, 'build', 'erc.json'));
    result.ercBlocking = Boolean(erc.blocking);
    result.ercErrors = erc?.summary?.errors;
  } catch {
    // ignore
  }
  try {
    const manifest = await readJson(path.join(root, 'build', 'build-manifest.json'));
    result.buildStatus = manifest.status;
  } catch {
    // ignore
  }
  try {
    const simulation = await readJson(path.join(root, 'build', 'system', 'simulation', 'result.json'));
    result.simulationStatus = simulation.execution_status;
    result.simulated = simulation.execution_status === 'success';
  } catch {
    // ignore
  }
  return result;
}

async function runRound(
  caseId: string,
  mode: string,
  round: number,
  outputRoot: string,
): Promise<RunMetrics> {
  const apiKey = process.env.ACTOVIQ_API_KEY?.trim();
  if (!apiKey) throw new Error('ACTOVIQ_API_KEY is required');
  const baseURL = process.env.ACTOVIQ_BASE_URL?.trim() || 'https://ark.cn-beijing.volces.com/api/plan';
  const model = process.env.ACTOVIQ_MODEL?.trim() || 'glm-5.3';
  const task = process.env.ACTOVIQ_TASK?.trim() || COMPLEX_TASKS[caseId] || DEFAULT_TASK;

  // The workspace env var must be set before the service module loads.
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), `live-agent-ws-${mode}-${round}-`));
  process.env.ACTOVIQ_E2E_WORKSPACE_ROOT = workspaceRoot;
  const homeDir = await mkdtemp(path.join(tmpdir(), `live-agent-home-${mode}-${round}-`));
  const projectsRoot = path.join(workspaceRoot, 'projects');
  // Redirect the OS home so the Node-side workspace state does not pick up the
  // developer's real ~/.actoviq workspace config (which would disagree with
  // the Python CLI's env-override workspace and split project lookups).
  process.env.USERPROFILE = homeDir;

  // The user's execution-profile registry pins simulation to their real
  // workspace roots. Point the run at a throwaway registry whose allowedRoots
  // cover this temp workspace (reusing their ngspice executable), so the full
  // design->compile->simulate loop can complete in isolation.
  const profileRegistryPath = path.join(workspaceRoot, 'execution-profiles.json');
  await mkdir(workspaceRoot, { recursive: true });
  const ngspiceExecutable = process.env.ACTOVIQ_NGSPICE?.trim() || 'ngspice';
  await writeFile(profileRegistryPath, `${JSON.stringify({
    schema: 'actoviq.execution-profile-registry.v1',
    profiles: [{
      schema: 'actoviq.execution-profile.v1',
      id: 'ngspice-local',
      providerId: 'ngspice',
      target: 'local_windows',
      executable: ngspiceExecutable,
      allowedRoots: [workspaceRoot],
      environmentKeys: [],
      qualification: 'configured',
    }],
  }, null, 2)}\n`, 'utf8');
  process.env.ACTOVIQ_EXECUTION_PROFILE_REGISTRY = profileRegistryPath;

  const { startDesktopAgentRun, closeDesktopAgentService } = await import('../electron/agent/desktopAgentService.ts');

  const events: Array<Record<string, unknown>> = [];
  const started = Date.now();
  const metrics: RunMetrics = {
    caseId,
    mode,
    round,
    isError: false,
    wallClockMs: 0,
    modelRequests: 0,
    codeCellCalls: 0,
    hostToolCalls: 0,
    hostToolErrors: 0,
    toolCallCounts: {},
    toolErrorCounts: {},
    promptTokens: 0,
    completionTokens: 0,
    usageAvailable: false,
    finalText: '',
    project: { created: false },
  };

  let activeHandle: ReturnType<typeof startDesktopAgentRun> | undefined;
  let timedOut = false;
  try {
    activeHandle = startDesktopAgentRun({
      provider: 'openai',
      apiKey,
      baseURL,
      model,
      homeDir,
      workDir: process.cwd(),
    }, {
      conversationId: `live-${mode}-${round}-${Date.now()}`,
      message: task,
      context: { activeJobId: null, activeProject: null },
    }, (event) => {
      const entry: Record<string, unknown> = { type: event.type, timestamp: event.timestamp };
      if (event.toolName) entry.toolName = event.toolName;
      if (event.label) entry.label = event.label;
      if (event.isError !== undefined) entry.isError = event.isError;
      if (event.usage) entry.usage = event.usage;
      events.push(entry);

      switch (event.type) {
        case 'tool-call':
          if (event.toolName !== 'CodeCell') {
            metrics.hostToolCalls += 1;
            metrics.toolCallCounts[event.toolName] = (metrics.toolCallCounts[event.toolName] ?? 0) + 1;
          }
          break;
        case 'tool-result':
          if (event.isError && event.toolName) {
            metrics.hostToolErrors += 1;
            metrics.toolErrorCounts[event.toolName] = (metrics.toolErrorCounts[event.toolName] ?? 0) + 1;
          }
          break;
        case 'status':
          if (event.label === 'Thinking and selecting tools') metrics.modelRequests += 1;
          if (event.label === 'Executing Python cell') metrics.codeCellCalls += 1;
          break;
        case 'usage': {
          const usage = event.usage as Record<string, number> | undefined;
          if (usage) {
            metrics.usageAvailable = true;
            metrics.promptTokens += Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
            metrics.completionTokens += Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
          }
          break;
        }
        default:
          break;
      }
    });

    const timeoutMs = Number(process.env.ACTOVIQ_RUN_TIMEOUT_MS ?? 900_000);
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        activeHandle?.cancel(`run exceeded ${timeoutMs}ms`);
        reject(new Error(`run exceeded ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const result = await Promise.race([activeHandle.result, timeoutPromise]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });

    metrics.isError = Boolean(result.isError);
    metrics.finalText = result.text;
    metrics.projectId = result.touchedProjectId;
    const finalUsage = result.usage as Record<string, number> | undefined;
    if (finalUsage && metrics.promptTokens === 0) {
      metrics.usageAvailable = true;
      metrics.promptTokens = Number(finalUsage.input_tokens ?? finalUsage.prompt_tokens ?? 0) || 0;
      metrics.completionTokens = Number(finalUsage.output_tokens ?? finalUsage.completion_tokens ?? 0) || 0;
    }
  } catch (error) {
    if (timedOut && activeHandle) {
      let settleTimer: NodeJS.Timeout | undefined;
      const settled = await Promise.race([
        activeHandle.result.catch(() => undefined),
        new Promise<undefined>((resolve) => {
          settleTimer = setTimeout(resolve, 5_000);
        }),
      ]).finally(() => {
        if (settleTimer) clearTimeout(settleTimer);
      });
      const finalUsage = settled?.usage as Record<string, number> | undefined;
      if (finalUsage) {
        metrics.usageAvailable = true;
        metrics.promptTokens = Number(finalUsage.input_tokens ?? finalUsage.prompt_tokens ?? 0) || 0;
        metrics.completionTokens = Number(finalUsage.output_tokens ?? finalUsage.completion_tokens ?? 0) || 0;
      }
    }
    metrics.isError = true;
    metrics.errorText = error instanceof Error ? error.message : String(error);
    metrics.finalText = metrics.errorText;
  } finally {
    metrics.wallClockMs = Date.now() - started;
    await closeDesktopAgentService().catch(() => undefined);
  }

  await mkdir(outputRoot, { recursive: true });
  metrics.project = await assessProject(
    projectsRoot,
    metrics.projectId,
    path.join(outputRoot, 'artifacts', `${mode}-round${round}`),
  );
  await writeFile(
    path.join(outputRoot, `${mode}-round${round}.json`),
    `${JSON.stringify({ task, metrics, events }, null, 2)}\n`,
    'utf8',
  );

  // Best-effort cleanup of run artifacts.
  await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);

  return metrics;
}

async function main(): Promise<void> {
  const mode = process.env.VIBE_DESKTOP_AGENT_MODE?.trim().toLowerCase() || 'codeact';
  const caseId = (process.env.ACTOVIQ_CASE_ID?.trim() || 'baseline')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'baseline';
  const rounds = Math.max(1, Number(process.env.ACTOVIQ_ROUNDS ?? 1) || 1);
  const outputRoot = path.resolve(process.cwd(), 'output', 'live-agent-comparison', caseId);
  const all: RunMetrics[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const metrics = await runRound(caseId, mode, round, outputRoot);
    all.push(metrics);
    // eslint-disable-next-line no-console
    console.log(`AGENT_MODE_RESULT ${JSON.stringify(metrics)}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
