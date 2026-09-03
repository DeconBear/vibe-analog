#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { startInteractiveCli } from './cli/startInteractiveCli.js';
import {
  ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT_ENV,
  CIRCUIT_ASSETS_ROOT,
  PROJECT_ROOT,
  RUNTIME_CWD,
  TOOL_PATHS_PATH,
  WORKSPACE_ROOT,
} from './config/projectPaths.js';
import { validateRuntimePaths } from './config/validateRuntimePaths.js';
import { startTuiApp } from './tui/TuiApp.js';
import { formatErrorMessage, writeError, writeStderr, writeStdout } from './utils/runtimeSupport.js';
import { resolveJobReference } from './workflow/jobArtifacts.js';
import { buildRevisionRequirement } from './workflow/revisionRequirement.js';
import type { ApprovalPolicy } from './workflow/circuitDesignWorkflow.js';

interface CliOptions {
  requirement?: string;
  requirementFile?: string;
  autoApprove: boolean;
  approvalPolicy?: ApprovalPolicy;
  jobName?: string;
  configPath?: string;
  resumeJob?: string;
  revisionBaseJob?: string;
  jobParentDir?: string;
  rerunFromStage?: string;
  legacyCli: boolean;
  showHelp: boolean;
  showVersion: boolean;
  chatMode: boolean;
  settingsPath?: string;
  error?: string;
}

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const packageJsonPath = path.resolve(currentDir, '..', 'package.json');
const packageVersion = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version as string;

function printHelp(): void {
  writeStdout(
    [
      'vibe-analog',
      '',
      'Usage:',
      '  vibe-analog [options]',
      '  vibe-analog chat [--settings <path>] [--approval-policy <mode>]',
      '',
      'Modes:',
      '  chat                   Conversational CodeAct agent (same engine as the desktop chat).',
      '                         Config via ACTOVIQ_API_KEY / ACTOVIQ_BASE_URL / ACTOVIQ_MODEL',
      '                         env vars or an agent.settings.json "env" block (--settings).',
      '',
      'Options:',
      '  --requirement <text>   Start the workflow with a requirement string.',
      '  --requirement-file <path> Load the requirement text from a UTF-8 file.',
      '  --job-name <name>      Provide a naming hint for the generated English job slug.',
      '  --config <path>        Load an explicit Vibe Analog JSON config file.',
      '  --resume-job <id|path> Resume an existing workflow job from the first incomplete stage.',
      '  --revision-base-job <id|path> Start a revision based on an existing job.',
      '  --job-parent-dir <path> Directory where a new workflow job should be created.',
      '  --rerun-from-stage <key> With --resume-job, rerun from a specific workflow stage key.',
      '  --auto-approve         Skip y-confirmation between agent stages.',
      '  --approval-policy <mode> manual | execution | all.',
      '  --legacy-cli, --no-tui  Use the previous one-shot readline requirement prompt.',
      '  -h, --help             Show this help text.',
      '  -v, --version          Show the CLI version.',
      '',
      'Environment:',
      '  ACTOVIQ_AGENT_CONFIG_PATH              Explicit Vibe Analog config path.',
      `  ${ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT_ENV}   Workspace root override.`,
      '  NGSPICE_BIN                            Override ngspice executable path.',
      '',
      'Defaults:',
      `  Package root: ${PROJECT_ROOT}`,
      `  Current working directory: ${RUNTIME_CWD}`,
      `  Workspace root: ${WORKSPACE_ROOT}`,
      `  Bundled circuit assets: ${CIRCUIT_ASSETS_ROOT}`,
      `  Bundled tool path config: ${TOOL_PATHS_PATH}`,
      '  Debug config fallback: <workspace>/actoviq.settings.json',
      '',
      'Examples:',
      '  vibe-analog',
      '  vibe-analog --requirement "Design a 1 kHz RC low-pass filter"',
      '  vibe-analog --auto-approve --job-name rc-demo',
      '  vibe-analog --resume-job 20260409-215611-lna-full-regression',
    ].join('\n'),
  );
  writeStdout('\n');
}

type BooleanCliKey = 'autoApprove' | 'legacyCli' | 'showHelp' | 'showVersion';
type ValueCliKey =
  | 'requirement'
  | 'requirementFile'
  | 'jobName'
  | 'configPath'
  | 'resumeJob'
  | 'revisionBaseJob'
  | 'jobParentDir'
  | 'rerunFromStage'
  | 'settingsPath';

const BOOLEAN_FLAGS: Record<string, BooleanCliKey> = {
  '--auto-approve': 'autoApprove',
  '--legacy-cli': 'legacyCli',
  '--no-tui': 'legacyCli',
  '--help': 'showHelp',
  '-h': 'showHelp',
  '--version': 'showVersion',
  '-v': 'showVersion',
};

const VALUE_FLAGS: Record<string, ValueCliKey> = {
  '--requirement': 'requirement',
  '--requirement-file': 'requirementFile',
  '--job-name': 'jobName',
  '--config': 'configPath',
  '--resume-job': 'resumeJob',
  '--revision-base-job': 'revisionBaseJob',
  '--job-parent-dir': 'jobParentDir',
  '--rerun-from-stage': 'rerunFromStage',
  '--settings': 'settingsPath',
};

function readFlagValue(argv: string[], index: number, arg: string): { value?: string; error?: string } {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    return { error: `missing value for ${arg}` };
  }
  return { value };
}

export function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    autoApprove: false,
    legacyCli: false,
    showHelp: false,
    showVersion: false,
    chatMode: false,
  };

  if (argv[0] === 'chat') {
    options.chatMode = true;
    argv = argv.slice(1);
  }

  const WORKFLOW_ONLY_VALUE_KEYS: ReadonlySet<ValueCliKey> = new Set([
    'requirement',
    'requirementFile',
    'jobName',
    'resumeJob',
    'revisionBaseJob',
    'jobParentDir',
    'rerunFromStage',
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const booleanKey = BOOLEAN_FLAGS[arg];
    if (booleanKey) {
      if (options.chatMode && (booleanKey === 'autoApprove' || booleanKey === 'legacyCli')) {
        options.error = `${arg} is not available in chat mode`;
        break;
      }
      options[booleanKey] = true;
      continue;
    }

    if (arg === '--approval-policy') {
      const { value, error } = readFlagValue(argv, index, arg);
      if (error || value === undefined) {
        options.error = error;
        break;
      }
      if (value !== 'manual' && value !== 'execution' && value !== 'all') {
        options.error = '--approval-policy must be manual, execution, or all';
        break;
      }
      options.approvalPolicy = value;
      index += 1;
      continue;
    }

    const valueKey = VALUE_FLAGS[arg];
    if (valueKey) {
      if (options.chatMode && WORKFLOW_ONLY_VALUE_KEYS.has(valueKey)) {
        options.error = `${arg} is not available in chat mode`;
        break;
      }
      const { value, error } = readFlagValue(argv, index, arg);
      if (error || value === undefined) {
        options.error = error;
        break;
      }
      options[valueKey] = value;
      index += 1;
      continue;
    }

    options.error = `unknown argument: ${arg}`;
    break;
  }

  return options;
}

function lookupNgspiceOnPath(): string | undefined {
  const lookup = process.platform === 'win32' ? 'where ngspice' : 'command -v ngspice';
  try {
    const result = execSync(lookup, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!result) {
      return undefined;
    }
    const firstLine = result.split(/\r?\n/)[0]?.trim();
    return firstLine || undefined;
  } catch {
    return undefined;
  }
}

function checkNgspice(): void {
  const envBin = process.env.NGSPICE_BIN?.trim();
  if (envBin) {
    if (existsSync(envBin)) {
      writeStdout(`ngspice: available -> ${envBin} (from NGSPICE_BIN)\n`);
      return;
    }
    writeError(`ngspice: NGSPICE_BIN points to a missing path: ${envBin}\n`);
  }

  try {
    const raw = readFileSync(TOOL_PATHS_PATH, 'utf8');
    const toolPaths = JSON.parse(raw) as { ngspice_bin?: string };
    const configured = toolPaths.ngspice_bin?.trim();
    if (configured) {
      if (existsSync(configured)) {
        writeStdout(`ngspice: available -> ${configured} (from tool_paths.json)\n`);
        return;
      }
      writeError(`ngspice: tool_paths.json ngspice_bin points to a missing path: ${configured}\n`);
    }
  } catch {
    // tool_paths.json not readable, continue
  }

  const onPath = lookupNgspiceOnPath();
  if (onPath) {
    writeStdout(`ngspice: available -> ${onPath} (from PATH)\n`);
    return;
  }

  writeError('\n');
  writeError('-- ngspice not available ----------------------------------------------------\n');
  writeError('  The simulation stage requires ngspice. Configure it via one of:\n');
  if (process.platform === 'win32') {
    writeError('    1. PowerShell (current session):\n');
    writeError("         $env:NGSPICE_BIN = 'C:\\path\\to\\ngspice.exe'\n");
    writeError('    2. PowerShell (persistent for current user):\n');
    writeError("         [Environment]::SetEnvironmentVariable('NGSPICE_BIN','C:\\path\\to\\ngspice.exe','User')\n");
    writeError("    3. Add the directory containing ngspice.exe to your system PATH\n");
  } else {
    writeError('    1. export NGSPICE_BIN=/path/to/ngspice\n');
    writeError('    2. Add ngspice to your system PATH\n');
  }
  writeError('  Download: https://ngspice.sourceforge.net/download.html\n');
  writeError('-----------------------------------------------------------------------------\n');
  writeError('\n');
}

export async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.error) {
    writeError(`Error: ${options.error}\n\n`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (options.showVersion) {
    writeStdout(`${packageVersion}\n`);
    return;
  }

  if (options.showHelp) {
    printHelp();
    return;
  }

  if (options.chatMode) {
    const { startChatMode } = await import('./chat/chatMode.js');
    await startChatMode({
      settingsPath: options.settingsPath,
      approvalPolicy: options.approvalPolicy,
    });
    return;
  }

  if (options.configPath?.trim()) {
    process.env.ACTOVIQ_AGENT_CONFIG_PATH = path.resolve(options.configPath.trim());
  }

  if (options.requirement && options.requirementFile) {
    writeError('Error: use either --requirement or --requirement-file, not both.\n');
    process.exitCode = 1;
    return;
  }

  if (options.resumeJob && options.revisionBaseJob) {
    writeError('Error: use either --resume-job or --revision-base-job, not both.\n');
    process.exitCode = 1;
    return;
  }

  if (options.rerunFromStage && !options.resumeJob) {
    writeError('Error: --rerun-from-stage requires --resume-job.\n');
    process.exitCode = 1;
    return;
  }

  const requirementFromFile = options.requirementFile?.trim()
    ? readFileSync(path.resolve(options.requirementFile.trim()), 'utf8')
    : undefined;
  const requestedRequirement = requirementFromFile ?? options.requirement;

  if (options.revisionBaseJob && !requestedRequirement?.trim()) {
    writeError('Error: --revision-base-job requires --requirement or --requirement-file as the revision request.\n');
    process.exitCode = 1;
    return;
  }

  const pathStatus = await validateRuntimePaths();
  const missing = pathStatus.filter((entry) => !entry.exists);
  if (missing.length > 0) {
    writeError('Missing required runtime paths:\n');
    for (const entry of missing) {
      const suffix = entry.envVar ? ` (set ${entry.envVar})` : '';
      writeError(`- ${entry.label}: ${entry.targetPath}${suffix}\n`);
    }
    writeStderr('\n');
    writeError('The CLI now bundles its circuit assets, but required packaged runtime files are missing.\n');
    process.exitCode = 1;
    return;
  }

  writeStdout(`vibe-analog v${packageVersion}\n`);
  writeStdout(`workspace: ${WORKSPACE_ROOT}\n`);
  writeStdout(
    'notice: this TUI drives the legacy multi-stage workflow. For the conversational CodeAct agent use `vibe-analog chat`.\n',
  );
  checkNgspice();
  if (!options.legacyCli && !options.requirement && !options.requirementFile && !options.resumeJob && !options.revisionBaseJob) {
    await startTuiApp();
    return;
  }

  let workflowRequirement = requestedRequirement;
  let workflowJobName = options.jobName;
  let workflowJobParentDir = options.jobParentDir?.trim()
    ? path.resolve(options.jobParentDir.trim())
    : undefined;

  if (options.revisionBaseJob) {
    const baseJob = await resolveJobReference(options.revisionBaseJob);
    workflowJobParentDir = workflowJobParentDir ?? path.resolve(baseJob.jobRoot, 'revisions');
    await mkdir(workflowJobParentDir, { recursive: true });
    workflowJobName = workflowJobName ?? `revision-${baseJob.jobId}`;
    workflowRequirement = await buildRevisionRequirement({
      baseJobId: baseJob.jobId,
      baseJobRoot: baseJob.jobRoot,
      revisionRequest: requestedRequirement ?? '',
    });
    writeStdout(`[revision-base] ${baseJob.jobId} -> ${workflowJobParentDir}\n`);
  }

  writeStdout(
    'interactive mode: enter a natural-language requirement; type y before stage transitions; netlist-to-simulation runs as a closed loop.\n',
  );

  await startInteractiveCli({
    requirement: workflowRequirement,
    autoApprove: options.autoApprove,
    approvalPolicy: options.approvalPolicy,
    jobName: workflowJobName,
    resumeJob: options.resumeJob,
    jobParentDir: workflowJobParentDir,
    rerunFromStage: options.rerunFromStage,
  });

  if (options.autoApprove || workflowRequirement || options.resumeJob) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    process.exit(process.exitCode ?? 0);
  }
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  main().catch((error) => {
    const message = error instanceof Error && error.stack ? error.stack : formatErrorMessage(error);
    writeError(`${message}\n`);
    process.exitCode = 1;
  });
}
