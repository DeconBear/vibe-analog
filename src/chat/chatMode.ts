import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { formatErrorMessage, writeError, writeStdout } from '../utils/runtimeSupport.js';
import type { ApprovalPolicy } from '../workflow/circuitDesignWorkflow.js';

/**
 * Terminal front-end for the desktop CodeAct agent (the same
 * electron/agent/desktopAgentService the Electron chat uses).
 *
 * electron/ and src/ are compiled by separate tsconfigs with disjoint
 * rootDirs, so the service module is resolved and imported at runtime and
 * its events are matched structurally here instead of via a static import.
 */

interface ChatAgentEvent {
  type: string;
  text?: string;
  delta?: string;
  label?: string;
  toolName?: string;
  isError?: boolean;
}

interface ChatAgentHandle {
  result: Promise<{ text?: string; isError?: boolean }>;
  cancel: (reason?: string) => void;
}

interface ChatAgentService {
  startDesktopAgentRun: (
    config: { provider: string; apiKey: string; baseURL: string; model: string; workDir: string },
    input: {
      conversationId: string;
      message: string;
      context?: Record<string, unknown>;
    },
    onEvent: (event: ChatAgentEvent) => void,
  ) => ChatAgentHandle;
  closeDesktopAgentService: () => Promise<void>;
}

const APPROVAL_MODES: readonly ApprovalPolicy[] = ['manual', 'execution', 'all'];

const HELP_TEXT = `Commands:
  /help              Show this help.
  /new               Start a new conversation (fresh session id).
  /approval <mode>   Set approval policy: manual | execution | all (default: execution).
  /exit              Leave the chat (also: /quit, Ctrl+C, Ctrl+D).
Anything else is sent to the circuit design agent.`;

function resolveServiceModule(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  const candidates = [
    path.join(repoRoot, 'dist-electron', 'agent', 'desktopAgentService.js'),
    path.join(repoRoot, 'electron', 'agent', 'desktopAgentService.ts'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return pathToFileUrl(candidate);
  }
  throw new Error(
    'desktopAgentService module not found; run "npm run build:electron" for a packaged checkout.',
  );
}

function pathToFileUrl(filePath: string): string {
  return `file://${filePath.replace(/\\/g, '/')}`;
}

function loadSettingsEnv(explicitPath?: string): Record<string, string> {
  const candidates = explicitPath
    ? [path.resolve(explicitPath)]
    : [path.resolve(process.cwd(), 'agent.settings.json')];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { env?: Record<string, string> };
    return parsed.env ?? {};
  }
  return {};
}

function envValue(name: string, settingsEnv: Record<string, string>): string {
  return process.env[name]?.trim() || settingsEnv[name]?.trim() || '';
}

export interface ChatModeOptions {
  settingsPath?: string;
  approvalPolicy?: ApprovalPolicy;
}

export async function startChatMode(options: ChatModeOptions = {}): Promise<void> {
  const settingsEnv = loadSettingsEnv(options.settingsPath);
  const provider = envValue('ACTOVIQ_PROVIDER', settingsEnv) || 'openai';
  const apiKey = envValue('ACTOVIQ_API_KEY', settingsEnv);
  const baseURL = envValue('ACTOVIQ_BASE_URL', settingsEnv);
  const model = envValue('ACTOVIQ_MODEL', settingsEnv);

  if (!apiKey || !baseURL || !model) {
    writeError(
      'Chat needs ACTOVIQ_API_KEY, ACTOVIQ_BASE_URL and ACTOVIQ_MODEL (env or agent.settings.json "env" block).',
    );
    process.exitCode = 1;
    return;
  }

  const service: ChatAgentService = await import(resolveServiceModule());
  const workspaceRoot = envValue('ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT', settingsEnv) || process.cwd();
  let approvalPolicy: ApprovalPolicy = options.approvalPolicy ?? 'execution';
  let conversationId = `cli-${randomUUID()}`;

  writeStdout(`vibe-analog chat (CodeAct) — model ${model}`);
  writeStdout(`workspace: ${workspaceRoot} · approval: ${approvalPolicy}`);
  writeStdout(`${HELP_TEXT}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closing = false;

  const close = async () => {
    if (closing) return;
    closing = true;
    rl.close();
    await service.closeDesktopAgentService().catch(() => undefined);
  };
  rl.on('SIGINT', () => {
    void close().then(() => process.exit(0));
  });

  try {
    while (!closing) {
      const line = await rl.question('you> ').catch(() => null);
      if (line === null) break;
      const message = line.trim();
      if (!message) continue;

      if (message === '/exit' || message === '/quit') break;
      if (message === '/help') {
        writeStdout(`${HELP_TEXT}\n`);
        continue;
      }
      if (message === '/new') {
        conversationId = `cli-${randomUUID()}`;
        writeStdout('started a new conversation.\n');
        continue;
      }
      if (message.startsWith('/approval')) {
        const mode = message.split(/\s+/)[1]?.trim().toLowerCase() as ApprovalPolicy | undefined;
        if (!mode || !APPROVAL_MODES.includes(mode)) {
          writeStdout(`usage: /approval ${APPROVAL_MODES.join(' | ')}\n`);
          continue;
        }
        approvalPolicy = mode;
        writeStdout(`approval policy set to ${approvalPolicy}.\n`);
        continue;
      }

      let streamed = false;
      const handle = service.startDesktopAgentRun(
        { provider, apiKey, baseURL, model, workDir: process.cwd() },
        {
          conversationId,
          message,
          context: { activeJobId: null, activeProject: null, workspaceRoot, approvalPolicy },
        },
        (event) => {
          switch (event.type) {
            case 'text-progress': {
              if (event.delta) {
                streamed = true;
                writeStdout(event.delta);
              }
              break;
            }
            case 'tool-call':
              writeStdout(`\n[tool] ${event.toolName ?? 'tool'}`);
              break;
            case 'tool-result':
              writeStdout('');
              break;
            case 'error':
              writeError(`\n[agent error] ${event.label ?? event.text ?? 'unknown error'}`);
              break;
            case 'retry':
            case 'model-fallback':
              writeStdout(`\n[notice] ${event.label ?? event.type}`);
              break;
            default:
              break;
          }
        },
      );
      const result = await handle.result.catch((error: unknown) => {
        writeError(`agent run failed: ${formatErrorMessage(error)}`);
        return null;
      });
      if (streamed) writeStdout('\n');
      if (result && !streamed && result.text) writeStdout(`agent> ${result.text}\n`);
      writeStdout('');
    }
  } finally {
    await close();
  }
}
