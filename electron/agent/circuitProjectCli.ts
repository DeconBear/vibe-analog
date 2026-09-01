import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

const activeProjectTools = new Set<ChildProcessWithoutNullStreams>();
let projectToolsStopping = false;

interface PendingWorkerRequest {
  resolve(result: Record<string, unknown>): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

let kicadWorker: ChildProcessWithoutNullStreams | null = null;
let kicadWorkerReady: Promise<void> | null = null;
let kicadWorkerReadyResolve: (() => void) | null = null;
let kicadWorkerReadyReject: ((error: Error) => void) | null = null;
let kicadWorkerStartupTimeout: NodeJS.Timeout | null = null;
let kicadWorkerStdout = '';
let kicadWorkerStderr = '';
let nextKicadWorkerRequestId = 1;
const pendingKicadWorkerRequests = new Map<number, PendingWorkerRequest>();

interface ElectronAppLike {
  getAppPath(): string;
}

/**
 * Resolve the Electron `app` object when running inside the Electron main
 * process. Outside Electron (regression harnesses, Node scripts) `require('electron')`
 * resolves to the binary path string, so fall back to null and let callers
 * use process.cwd().
 */
function resolveElectronApp(): ElectronAppLike | null {
  try {
    const electronModule = createRequire(import.meta.url)('electron') as unknown;
    if (electronModule && typeof electronModule === 'object') {
      const app = (electronModule as { app?: ElectronAppLike }).app;
      return app ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

let cachedElectronApp: ElectronAppLike | null | undefined;

function electronApp(): ElectronAppLike | null {
  if (cachedElectronApp === undefined) cachedElectronApp = resolveElectronApp();
  return cachedElectronApp;
}

export function projectScriptPath(
  appPath = electronApp()?.getAppPath() ?? process.cwd(),
  resourcesPath = process.resourcesPath ?? '',
): string {
  const candidates = [
    path.resolve(appPath, 'skills', 'circuit-design-ngspice', 'scripts', 'circuit_project.py'),
    ...(resourcesPath ? [path.resolve(resourcesPath, 'skills', 'circuit-design-ngspice', 'scripts', 'circuit_project.py')] : []),
  ];
  const candidate = candidates.find((value) => existsSync(value));
  if (!candidate) {
    throw new Error('circuit_project.py is missing from the application bundle.');
  }
  return candidate;
}

export interface RunProjectToolOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

function workerScriptPath(): string {
  return path.join(path.dirname(projectScriptPath()), 'kicad_symbol_worker.py');
}

function resetKicadWorker(child: ChildProcessWithoutNullStreams, error: Error): void {
  activeProjectTools.delete(child);
  if (kicadWorker !== child) return;
  kicadWorker = null;
  kicadWorkerReady = null;
  kicadWorkerStdout = '';
  kicadWorkerStderr = '';
  if (kicadWorkerStartupTimeout) clearTimeout(kicadWorkerStartupTimeout);
  kicadWorkerStartupTimeout = null;
  kicadWorkerReadyReject?.(error);
  kicadWorkerReadyResolve = null;
  kicadWorkerReadyReject = null;
  for (const pending of pendingKicadWorkerRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
  pendingKicadWorkerRequests.clear();
}

function handleKicadWorkerLine(child: ChildProcessWithoutNullStreams, line: string): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    resetKicadWorker(child, new Error(`KiCad symbol worker returned invalid JSON: ${line}`));
    child.kill();
    return;
  }
  if (message.event === 'ready') {
    if (kicadWorkerStartupTimeout) clearTimeout(kicadWorkerStartupTimeout);
    kicadWorkerStartupTimeout = null;
    kicadWorkerReadyResolve?.();
    kicadWorkerReadyResolve = null;
    kicadWorkerReadyReject = null;
    return;
  }
  if (message.event === 'error') {
    resetKicadWorker(child, new Error(String(message.error ?? 'KiCad symbol worker failed to start.')));
    child.kill();
    return;
  }
  const id = Number(message.id);
  const pending = pendingKicadWorkerRequests.get(id);
  if (!pending) return;
  pendingKicadWorkerRequests.delete(id);
  clearTimeout(pending.timeout);
  if (message.ok !== true || !message.result || typeof message.result !== 'object') {
    pending.reject(new Error(String(message.error ?? 'KiCad symbol worker request failed.')));
    return;
  }
  pending.resolve(message.result as Record<string, unknown>);
}

function ensureKicadWorker(options: RunProjectToolOptions = {}): Promise<void> {
  if (projectToolsStopping) return Promise.reject(new Error('Circuit project tools are stopping.'));
  if (kicadWorker && kicadWorkerReady) return kicadWorkerReady;
  const python = process.env.PYTHON_BIN?.trim() || 'python';
  const cwd = options.cwd ?? electronApp()?.getAppPath() ?? process.cwd();
  const child = spawn(python, [workerScriptPath()], {
    cwd,
    windowsHide: true,
    env: options.env ?? process.env,
  });
  kicadWorker = child;
  kicadWorkerStdout = '';
  kicadWorkerStderr = '';
  activeProjectTools.add(child);
  kicadWorkerReady = new Promise<void>((resolve, reject) => {
    kicadWorkerReadyResolve = resolve;
    kicadWorkerReadyReject = reject;
  });
  kicadWorkerStartupTimeout = setTimeout(() => {
    resetKicadWorker(child, new Error('KiCad symbol worker timed out during startup.'));
    child.kill();
  }, options.timeoutMs ?? 120_000);
  child.stdout.on('data', (chunk: Buffer) => {
    kicadWorkerStdout += chunk.toString();
    const lines = kicadWorkerStdout.split(/\r?\n/);
    kicadWorkerStdout = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) handleKicadWorkerLine(child, line);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    kicadWorkerStderr = `${kicadWorkerStderr}${chunk.toString()}`.slice(-8_000);
  });
  child.once('error', (error) => resetKicadWorker(child, error));
  child.once('close', (code) => {
    const detail = kicadWorkerStderr.trim();
    resetKicadWorker(
      child,
      new Error(detail || `KiCad symbol worker exited with ${code ?? 'an unknown code'}.`),
    );
  });
  return kicadWorkerReady;
}

export async function prewarmKicadSymbolWorker(): Promise<void> {
  await ensureKicadWorker();
}

export async function resolveKicadSymbolIr(
  symbolIds: string[],
  options: RunProjectToolOptions = {},
): Promise<Record<string, unknown>> {
  try {
    await ensureKicadWorker(options);
    const child = kicadWorker;
    if (!child || child.stdin.destroyed) throw new Error('KiCad symbol worker is unavailable.');
    const id = nextKicadWorkerRequestId++;
    const timeoutMs = options.timeoutMs ?? 120_000;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error('KiCad symbol worker timed out.');
        resetKicadWorker(child, error);
        child.kill();
      }, timeoutMs);
      pendingKicadWorkerRequests.set(id, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify({ id, method: 'symbol-ir', symbol_ids: symbolIds })}\n`, (error) => {
        if (!error) return;
        const pending = pendingKicadWorkerRequests.get(id);
        if (!pending) return;
        pendingKicadWorkerRequests.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(error);
      });
    });
  } catch (error) {
    if (projectToolsStopping) throw error;
    return runProjectTool([
      'kicad-symbol-ir',
      ...symbolIds.flatMap((symbolId) => ['--symbol', symbolId]),
    ], options);
  }
}

/**
 * Run a circuit_project.py subcommand and parse the last JSON line.
 * Same contract used by Skill agents and Electron IPC.
 */
export function runProjectTool(
  args: string[],
  options: RunProjectToolOptions = {},
): Promise<Record<string, unknown>> {
  if (projectToolsStopping) return Promise.reject(new Error('Circuit project tools are stopping.'));
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON_BIN?.trim() || 'python';
    const cwd = options.cwd ?? electronApp()?.getAppPath() ?? process.cwd();
    const timeoutMs = options.timeoutMs ?? 120_000;
    const child = spawn(python, [projectScriptPath(), ...args], {
      cwd,
      windowsHide: true,
      env: options.env ?? process.env,
    });
    activeProjectTools.add(child);
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Circuit project tool timed out.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      activeProjectTools.delete(child);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      activeProjectTools.delete(child);
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(line) as Record<string, unknown>;
      } catch {
        reject(new Error(stderr.trim() || stdout.trim() || `Circuit project tool exited with ${code}`));
        return;
      }
      if (code !== 0 || result.ok !== true) {
        reject(new Error(String(result.error ?? stderr.trim() ?? `Circuit project tool exited with ${code}`)));
        return;
      }
      resolve(result);
    });
  });
}

export async function stopActiveProjectTools(): Promise<void> {
  projectToolsStopping = true;
  const children = [...activeProjectTools];
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null || child.pid === undefined) return;
    const closed = new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        child.off('close', finish);
        resolve();
      };
      const timer = setTimeout(finish, 5_000);
      child.once('close', finish);
    });
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const killer = spawn(
          'taskkill',
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        );
        killer.once('error', () => resolve());
        killer.once('close', () => resolve());
      });
    } else {
      child.kill('SIGTERM');
    }
    await closed;
    activeProjectTools.delete(child);
  }));
}

export function summarizeToolResult(result: Record<string, unknown>, maxChars = 8_000): string {
  try {
    const text = JSON.stringify(result, null, 2);
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text;
  } catch {
    return String(result);
  }
}
