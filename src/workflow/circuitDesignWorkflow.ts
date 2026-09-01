import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createAgentSdk,
  type HadamardAgentClient,
  type AgentRunResult,
  type AgentSession,
} from 'actoviq-agent-sdk';

import { getWorkflowAgents } from '../agents/index.js';
import { confirmAgentTransition } from '../cli/confirmAgentTransition.js';
import {
  printStageSummary,
  type StageArtifactSummary,
} from '../cli/printStageSummary.js';
import type { WorkflowReadline } from '../cli/startInteractiveCli.js';
import { loadActoviqConfig } from '../config/loadActoviqConfig.js';
import { PROJECT_ROOT, SCRIPT_ROOT, WORKSPACE_ROOT } from '../config/projectPaths.js';

import { runNetlistsvgPipeline } from '../pipelines/runNetlistsvgPipeline.js';


import { getWorkflowSkills } from '../skills/index.js';
import { ACTOVIQ_CIRCUIT_AGENT_VERSION } from '../config/version.js';
import { registerCircuitTools } from '../tools/registerCircuitTools.js';
import { runPythonJson } from '../utils/processUtils.js';
import { classifyError } from '../utils/errors.js';
import {
  colorBoldRed,
  formatErrorMessage,
  isRetryableTransportError,
  sleep,
  writeStderr,
  writeStdout,
} from '../utils/runtimeSupport.js';
import { generateSafeJobNaming } from '../utils/jobNaming.js';
import { streamToConsole } from '../utils/streamUtils.js';
import { createWorkflowStages } from './stagePromptRegistry.js';
import {
  autoTuneRcCutoffInVerifier,
  alignNetlistNodesToSpec,
  composeFinalNetlistFromModules,
  normalizePhysicalSpecAssumptions,
  repairModuleInterfaceNetReuse,
  refreshSignalChainComparatorVerification,
  repairSignalChainComparatorNetlist,
  ensureModuleManifest,
} from '../utils/workflowFixups.js';

export interface JobPaths {
  jobId: string;
  jobRoot: string;
  inputsDir: string;
  planningDir: string;
  designDir: string;
  verificationDir: string;
  simulationDir: string;
  finalSimulationDir: string;
  renderDir: string;
  reportsDir: string;
  logsDir: string;
  userRequirementPath: string;
  requirementBriefPath: string;
  specRawPath: string;
  specNormalizedPath: string;
  technicalSolutionPath: string;
  executionChecklistPath: string;
  assetReusePlanPath: string;
  architecturePath: string;
  verificationPlanPath: string;
  modulePlanPath: string;
  templateNetlistPath: string;
  modulesDir: string;
  moduleManifestPath: string;
  designFinalPath: string;
  designNotesPath: string;
  detailedDesignReportPath: string;
  patchPlanPath: string;
  strictCheckPath: string;
  primitiveCheckPath: string;
  finalReviewPath: string;
  designJsonPath: string;
  netlistsvgPath: string;
  netlistsvgGeometryPath: string;
  netlistsvgLayoutReportPath: string;
  netlistsvgNotesPath: string;
  schemdrawPath: string;
  schemdrawNotesPath: string;
  sceneHintsPath: string;
  agentSvgPath: string;
  agentSvgNotesPath: string;
  finalSummaryPath: string;
  manifestPath: string;
  workflowStatePath: string;
}

export type ApprovalPolicy = 'manual' | 'execution' | 'all';
export type StageCategory = 'planning' | 'execution' | 'rendering' | 'summary';

export interface WorkflowStage {
  key: string;
  label: string;
  agentName: string;
  skillName: string;
  category: StageCategory;
  expectedArtifacts: Array<{ label: string; path: (paths: JobPaths) => string }>;
  buildPrompt: (paths: JobPaths) => string;
  requiresConfirmation?: boolean;
}

interface StageExecutionRecord {
  key: string;
  label: string;
  agentName: string;
  skillName: string;
  responsePath: string;
  artifacts: StageArtifactSummary[];
  toolCalls: number;
  completedAt: string;
  status: 'completed' | 'error';
  errorMessage?: string;
  errorExplanation?: string;
}

export interface RunCircuitDesignWorkflowOptions {
  rl: WorkflowReadline;
  requirement: string;
  autoApprove?: boolean;
  approvalPolicy?: ApprovalPolicy;
  jobName?: string;
  resumeJob?: string;
  jobParentDir?: string;
  rerunFromStage?: string;
}

export interface WorkflowRunSummary {
  jobId: string;
  jobRoot: string;
  finalSummaryPath: string;
  manifestPath: string;
  workflowStatePath: string;
}

interface WorkflowStateFile {
  jobId: string;
  projectRoot?: string;
  jobRoot: string;
  createdAt?: string;
  completedStages: StageExecutionRecord[];
  lastUpdatedAt?: string;
}

function allArtifactsExist(artifacts: StageArtifactSummary[]): boolean {
  return artifacts.every((artifact) => artifact.exists);
}

function canRecoverStageFromArtifacts(record: StageExecutionRecord, artifacts: StageArtifactSummary[]): boolean {
  return record.status === 'error' && allArtifactsExist(artifacts) && isRetryableTransportError(record.errorMessage ?? '');
}

function deriveStageStatusFromArtifacts(
  record: StageExecutionRecord,
  artifacts: StageArtifactSummary[],
): StageExecutionRecord['status'] {
  if (record.status === 'completed') {
    return allArtifactsExist(artifacts) ? 'completed' : 'error';
  }
  return canRecoverStageFromArtifacts(record, artifacts) ? 'completed' : 'error';
}

function withRecoveredStageStatus(
  record: StageExecutionRecord,
  artifacts: StageArtifactSummary[],
): StageExecutionRecord {
  const status = deriveStageStatusFromArtifacts(record, artifacts);
  if (status === 'completed') {
    return {
      ...record,
      artifacts,
      status,
      errorMessage: undefined,
    };
  }
  return {
    ...record,
    artifacts,
    status,
  };
}

const SESSION_DIRECTORY = path.resolve(WORKSPACE_ROOT, 'actoviq-sessions');
const STAGE_MAX_ATTEMPTS = 3;
const STAGE_RETRY_BACKOFF_MS = [2000, 5000];
const CRASH_GUARD_CLEANUP_DELAY_MS = 5000;
const DEFAULT_STAGE_TIMEOUT_MS = Number.parseInt(
  process.env.ACTOVIQ_CIRCUIT_AGENT_STAGE_TIMEOUT_MS ?? '',
  10,
);
const STAGE_TIMEOUT_MS =
  Number.isFinite(DEFAULT_STAGE_TIMEOUT_MS) && DEFAULT_STAGE_TIMEOUT_MS > 0
    ? DEFAULT_STAGE_TIMEOUT_MS
    : 10 * 60 * 1000;

const GLOBAL_SYSTEM_PROMPT = [
  'You are part of the vibe-analog workflow.',
  'Write prose artifacts in Chinese unless the task explicitly asks for code, JSON, SPICE, or SVG.',
  'Use absolute paths exactly as given in the stage packet.',
  'Call file tools with top-level JSON arguments such as {"file_path":"...","content":"..."}; do not wrap arguments inside raw/input/payload helper objects.',
  'If a tool result is an error, read the complete error text, fix the root cause before retrying, and report the exact reason in the stage artifact when it affects progress.',
  'When editing an existing file with the file tools, read it first.',
  'Keep work inside the job workspace unless a tool explicitly points to bundled reusable assets.',
  'Never expose secrets from config files or environment variables.',
].join('\n');

function timestampForId(date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

export function buildJobId(slug: string, date = new Date()): string {
  return `${timestampForId(date)}-${slug}`;
}

export async function buildUniqueJobId(slug: string, jobParentDir: string, date = new Date()): Promise<string> {
  const baseJobId = buildJobId(slug, date);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? baseJobId : `${baseJobId}-${attempt + 1}`;
    if (!(await fileExists(path.resolve(jobParentDir, candidate)))) {
      return candidate;
    }
  }
  return `${baseJobId}-${Date.now().toString(36)}`;
}

function resolveApprovalPolicy(options: RunCircuitDesignWorkflowOptions): ApprovalPolicy {
  if (options.approvalPolicy) {
    return options.approvalPolicy;
  }
  return options.autoApprove ? 'all' : 'manual';
}

function shouldAutoApproveStage(policy: ApprovalPolicy, stage: WorkflowStage): boolean {
  if (stage.requiresConfirmation === false) {
    return true;
  }
  if (policy === 'all') {
    return true;
  }
  if (policy === 'execution') {
    return stage.category !== 'planning';
  }
  return false;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function appendWorkflowFixupNotes(logPath: string, title: string, notes: string[]): Promise<void> {
  if (notes.length === 0) {
    return;
  }
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(
    logPath,
    [`## ${title}`, '', ...notes.map((note) => `- ${note}`), ''].join('\n'),
    'utf8',
  );
}

function buildJobPaths(jobRoot: string, jobId: string): JobPaths {
  const inputsDir = path.resolve(jobRoot, 'inputs');
  const planningDir = path.resolve(jobRoot, 'planning');
  const designDir = path.resolve(jobRoot, 'design');
  const verificationDir = path.resolve(jobRoot, 'verification');
  const simulationDir = path.resolve(verificationDir, 'simulation');
  const finalSimulationDir = path.resolve(verificationDir, 'final-simulation');
  const renderDir = path.resolve(jobRoot, 'render');
  const reportsDir = path.resolve(jobRoot, 'reports');
  const logsDir = path.resolve(jobRoot, 'logs');

  return {
    jobId,
    jobRoot,
    inputsDir,
    planningDir,
    designDir,
    verificationDir,
    simulationDir,
    finalSimulationDir,
    renderDir,
    reportsDir,
    logsDir,
    userRequirementPath: path.resolve(inputsDir, 'user-requirements.md'),
    requirementBriefPath: path.resolve(planningDir, 'requirements-brief.md'),
    specRawPath: path.resolve(planningDir, 'spec.raw.json'),
    specNormalizedPath: path.resolve(planningDir, 'spec.normalized.json'),
    technicalSolutionPath: path.resolve(planningDir, 'technical-solution.md'),
    executionChecklistPath: path.resolve(planningDir, 'execution-checklist.md'),
    assetReusePlanPath: path.resolve(planningDir, 'asset-reuse-plan.md'),
    architecturePath: path.resolve(planningDir, 'architecture.md'),
    verificationPlanPath: path.resolve(planningDir, 'verification-plan.md'),
    modulePlanPath: path.resolve(planningDir, 'module-plan.json'),
    templateNetlistPath: path.resolve(designDir, 'template.cir'),
    modulesDir: path.resolve(designDir, 'modules'),
    moduleManifestPath: path.resolve(designDir, 'module-manifest.json'),
    designFinalPath: path.resolve(designDir, 'design.final.cir'),
    designNotesPath: path.resolve(designDir, 'design-notes.md'),
    detailedDesignReportPath: path.resolve(designDir, 'detailed-design-report.md'),
    patchPlanPath: path.resolve(designDir, 'patch-plan.json'),
    strictCheckPath: path.resolve(verificationDir, 'strict-param-check.json'),
    primitiveCheckPath: path.resolve(verificationDir, 'primitive-check.json'),
    finalReviewPath: path.resolve(verificationDir, 'final-review.md'),
    designJsonPath: path.resolve(renderDir, 'design.json'),
    netlistsvgPath: path.resolve(renderDir, 'netlistsvg.svg'),
    netlistsvgGeometryPath: path.resolve(renderDir, 'netlistsvg.geometry.json'),
    netlistsvgLayoutReportPath: path.resolve(renderDir, 'netlistsvg.layout.json'),
    netlistsvgNotesPath: path.resolve(renderDir, 'netlistsvg-notes.md'),
    schemdrawPath: path.resolve(renderDir, 'schemdraw.svg'),
    schemdrawNotesPath: path.resolve(renderDir, 'schemdraw-notes.md'),
    sceneHintsPath: path.resolve(renderDir, 'scene-hints.json'),
    agentSvgPath: path.resolve(renderDir, 'agent-layout.svg'),
    agentSvgNotesPath: path.resolve(renderDir, 'agent-layout-notes.md'),
    finalSummaryPath: path.resolve(reportsDir, 'final-summary.md'),
    manifestPath: path.resolve(reportsDir, 'manifest.json'),
    workflowStatePath: path.resolve(logsDir, 'workflow-state.json'),
  };
}

function buildJobPathsFromJobRoot(jobRoot: string, jobId: string): JobPaths {
  return buildJobPaths(jobRoot, jobId);
}

async function scaffoldJobWorkspace(
  jobId: string,
  requirement: string,
  jobParentDir = path.resolve(WORKSPACE_ROOT, 'jobs'),
): Promise<JobPaths> {
  await mkdir(jobParentDir, { recursive: true });
  const paths = buildJobPaths(path.resolve(jobParentDir, jobId), jobId);
  await mkdir(paths.jobRoot, { recursive: false });

  await Promise.all(
    [
      paths.inputsDir,
      paths.planningDir,
      paths.designDir,
      paths.modulesDir,
      paths.verificationDir,
      paths.simulationDir,
      paths.finalSimulationDir,
      paths.renderDir,
      paths.reportsDir,
      paths.logsDir,
      SESSION_DIRECTORY,
    ].map((dir) => mkdir(dir, { recursive: true })),
  );

  await writeFile(
    paths.userRequirementPath,
    ['# User Requirement', '', requirement.trim(), ''].join('\n'),
    'utf8',
  );

  await writeJson(paths.workflowStatePath, {
    jobId,
    projectRoot: PROJECT_ROOT,
    jobRoot: paths.jobRoot,
    createdAt: new Date().toISOString(),
    completedStages: [],
  });

  return paths;
}
async function readWorkflowStateFile(workflowStatePath: string): Promise<WorkflowStateFile> {
  return JSON.parse(await readFile(workflowStatePath, 'utf8')) as WorkflowStateFile;
}

function extractRequirementFromMarkdown(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .filter((line, index) => !(index === 0 && line.trim() === '# User Requirement'))
    .join('\n')
    .trim();
}

async function resolveResumePaths(resumeJob: string): Promise<JobPaths> {
  const candidate = path.resolve(resumeJob.trim());
  let jobRoot = candidate;
  let workflowStatePath = path.resolve(candidate, 'logs', 'workflow-state.json');

  if (candidate.toLowerCase().endsWith('workflow-state.json')) {
    workflowStatePath = candidate;
    jobRoot = path.dirname(path.dirname(candidate));
  } else if (!(await fileExists(workflowStatePath))) {
    const byIdJobRoot = path.resolve(WORKSPACE_ROOT, 'jobs', resumeJob.trim());
    const byIdState = path.resolve(byIdJobRoot, 'logs', 'workflow-state.json');
    if (await fileExists(byIdState)) {
      workflowStatePath = byIdState;
      jobRoot = byIdJobRoot;
    }
  }

  if (!(await fileExists(workflowStatePath))) {
    throw new Error(`resume target not found or missing workflow-state.json: ${resumeJob}`);
  }

  const state = await readWorkflowStateFile(workflowStatePath);
  return buildJobPathsFromJobRoot(path.resolve(state.jobRoot ?? jobRoot), state.jobId);
}

function latestStageStatusByKey(state: WorkflowStateFile): Map<string, StageExecutionRecord> {
  const latest = new Map<string, StageExecutionRecord>();
  for (const record of state.completedStages ?? []) {
    latest.set(record.key, record);
  }
  return latest;
}

function determineResumeStageIndex(
  stages: WorkflowStage[],
  state: WorkflowStateFile,
): number {
  const latest = latestStageStatusByKey(state);
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index]!;
    const record = latest.get(stage.key);
    if (!record || record.status !== 'completed') {
      return index;
    }
  }
  return stages.length;
}

function resolveStageIndex(stages: WorkflowStage[], stageKeyOrLabel: string): number {
  const target = stageKeyOrLabel.trim().toLowerCase();
  return stages.findIndex((stage) =>
    stage.key.toLowerCase() === target ||
    stage.label.toLowerCase() === target ||
    stage.label.toLowerCase().includes(target)
  );
}

async function inspectArtifacts(
  paths: JobPaths,
  expectedArtifacts: WorkflowStage['expectedArtifacts'],
): Promise<StageArtifactSummary[]> {
  const entries: StageArtifactSummary[] = [];
  for (const artifact of expectedArtifacts) {
    const target = artifact.path(paths);
    entries.push({
      label: artifact.label,
      path: target,
      exists: await fileExists(target),
    });
  }
  return entries;
}

function createArtifactCompletedResult(stage: WorkflowStage, error: unknown): AgentRunResult {
  const now = new Date().toISOString();
  const message = formatErrorMessage(error);
  return {
    runId: `${stage.key}-artifact-complete-${Date.now()}`,
    model: 'local-artifact-check',
    startedAt: now,
    completedAt: now,
    text: `Stage stream ended with a retryable error, but all expected artifacts already exist. Original error: ${message}`,
    toolCalls: [],
  } as unknown as AgentRunResult;
}

async function appendStageLog(
  paths: JobPaths,
  stage: WorkflowStage,
  prompt: string,
  result: AgentRunResult,
  suffix = 'response',
): Promise<string> {
  const responsePath = path.resolve(paths.logsDir, `${stage.key}.${suffix}.md`);
  const toolSummary = result.toolCalls
    .map(
      (call) =>
        `- ${call.publicName} (${call.isError ? 'error' : 'ok'}) at ${call.completedAt}`,
    )
    .join('\n');

  const content = [
    `# ${stage.label}`,
    '',
    `- Agent: ${stage.agentName}`,
    `- Skill: ${stage.skillName}`,
    `- Run ID: ${result.runId}`,
    `- Model: ${result.model}`,
    `- Started At: ${result.startedAt}`,
    `- Completed At: ${result.completedAt}`,
    '',
    '## Prompt',
    '',
    '```text',
    prompt,
    '```',
    '',
    '## Response',
    '',
    result.text.trim() || '(empty response)',
    '',
    '## Tool Calls',
    '',
    toolSummary || '(no tool calls)',
    '',
  ].join('\n');

  await writeFile(responsePath, content, 'utf8');
  return responsePath;
}

async function appendStageErrorLog(
  paths: JobPaths,
  stage: WorkflowStage,
  prompt: string,
  error: unknown,
  suffix = 'error',
): Promise<string> {
  const responsePath = path.resolve(paths.logsDir, `${stage.key}.${suffix}.md`);
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error && error.stack ? error.stack : '';
  const content = [
    `# ${stage.label}`,
    '',
    `- Agent: ${stage.agentName}`,
    `- Skill: ${stage.skillName}`,
    `- Logged At: ${new Date().toISOString()}`,
    '',
    '## Prompt',
    '',
    '```text',
    prompt,
    '```',
    '',
    '## Error',
    '',
    message,
    '',
    stack ? '## Stack' : '',
    stack ? '```text' : '',
    stack,
    stack ? '```' : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');

  await writeFile(responsePath, content, 'utf8');
  return responsePath;
}

function fallbackErrorExplanation(record: StageExecutionRecord, stage: WorkflowStage): string {
  const classification = classifyError(record.errorMessage ?? 'unknown error');
  const reason = classification.message;
  const explanations: Record<typeof classification.kind, { likelyCause: string; nextStep: string }> = {
    timeout: {
      likelyCause: '最可能是 provider 响应超时，或该阶段工具调用过多导致执行窗口耗尽。',
      nextStep: '优先使用 --resume-job 继续任务；如果反复超时，缩小需求范围或检查 provider 稳定性。',
    },
    rate_limit: {
      likelyCause: '最可能是当前模型提供商触发限流或配额上限，不是本地网表或文件路径本身出错。',
      nextStep: '等待限流恢复、切换 provider 配置，或让 workflow 走可用的 deterministic fallback。',
    },
    broken_pipe: {
      likelyCause: '最可能是流式输出通道中断，电路设计结果不一定损坏。',
      nextStep: '重新 resume 当前任务；如果频繁出现，保留日志并检查终端或管道环境。',
    },
    insufficient_balance: {
      likelyCause: '最可能是模型提供商余额不足或账号额度受限。',
      nextStep: '补充额度或切换到可用配置文件，然后 resume 当前任务。',
    },
    credential: {
      likelyCause: '最可能是 Vibe Analog/provider 配置文件缺失、路径不正确或凭据无效。',
      nextStep: '检查 actoviq 配置路径、API key、provider 和 model 是否生效。',
    },
    file_tool: {
      likelyCause: '最可能是文件工具参数格式、路径、权限或目标文件缺失问题。',
      nextStep: '检查工具调用是否使用顶层 JSON 参数，路径是否为绝对路径且仍在 job workspace 内。',
    },
    transport: {
      likelyCause: '最可能是网络或 provider 连接层临时失败。',
      nextStep: '稍后 resume 当前任务；如果持续失败，检查网络、代理和 provider 服务状态。',
    },
    unknown: {
      likelyCause: '阶段执行期间出现未分类异常，需要结合阶段日志进一步定位。',
      nextStep: '查看该阶段 response/error 日志，确认是路径、工具参数、provider 响应还是脚本执行异常。',
    },
  };
  const explanation = explanations[classification.kind] ?? explanations.unknown;

  return [
    '1. 原始错误信息',
    reason,
    '2. 错误分类',
    `${classification.kind} / retryable=${classification.retryable}`,
    '3. 最可能原因',
    explanation.likelyCause,
    '4. 建议下一步',
    explanation.nextStep,
    '5. 阶段信息',
    `${stage.label} (${stage.key})`,
  ].join('\n');
}
async function explainStageError(
  sdk: HadamardAgentClient,
  paths: JobPaths,
  stage: WorkflowStage,
  record: StageExecutionRecord,
): Promise<string> {
  if (!record.errorMessage) {
    return '';
  }

  const prompt = [
    `Stage label: ${stage.label}`,
    `Agent: ${stage.agentName}`,
    `Skill: ${stage.skillName}`,
    `Job root: ${paths.jobRoot}`,
    `Error log: ${record.responsePath}`,
    `Raw error: ${record.errorMessage}`,
    'Artifacts:',
    ...record.artifacts.map((artifact) => `- ${artifact.label}: ${artifact.exists ? 'exists' : 'missing'} (${artifact.path})`),
    '',
    'Explain the failure in Chinese for the user.',
  ].join('\n');

  const explanationStage: WorkflowStage = {
    key: `${stage.key}-error-explainer`,
    label: `${stage.label} Error Explainer`,
    agentName: 'error-explainer',
    skillName: 'error-explanation',
    category: 'summary',
    expectedArtifacts: [],
    buildPrompt: () => prompt,
  };

  try {
    const result = await runStageSkillWithRetries({
      sdk,
      paths,
      stage: explanationStage,
      prompt,
      streamLabel: `${stage.label} Error Explainer`,
      repairMode: true,
    });
    const explanation = result.text.trim();
    const responsePath = path.resolve(paths.logsDir, `${stage.key}.user-error.md`);
    await writeFile(responsePath, `${explanation}\n`, 'utf8');
    return explanation || fallbackErrorExplanation(record, stage);
  } catch {
    const explanation = fallbackErrorExplanation(record, stage);
    const responsePath = path.resolve(paths.logsDir, `${stage.key}.user-error.md`);
    await writeFile(responsePath, `${explanation}\n`, 'utf8');
    return explanation;
  }
}

async function ensureDesignJsonForFallback(paths: JobPaths): Promise<void> {
  const spec = JSON.parse(await readFile(paths.specNormalizedPath, 'utf8')) as {
    input_node?: string;
    output_node?: string;
  };
  const args = ['--netlist-path', paths.designFinalPath, '--json-path', paths.designJsonPath, '--view', 'schematic'];
  if (spec.input_node) {
    args.push('--input-node', String(spec.input_node));
  }
  if (spec.output_node) {
    args.push('--output-node', String(spec.output_node));
  }
  if (await fileExists(paths.moduleManifestPath)) {
    args.push('--module-manifest-path', paths.moduleManifestPath);
  }
  await runPythonJson<Record<string, unknown>>({
    scriptPath: path.resolve(SCRIPT_ROOT, 'netlist_to_json.py'),
    args,
  });
}

async function writeLocalRenderFallbackArtifacts(
  paths: JobPaths,
  stage: WorkflowStage,
  record: StageExecutionRecord,
): Promise<StageExecutionRecord> {
  if (stage.key !== 'netlistsvg-renderer') {
    return record;
  }

  const notes: string[] = [];
  try {
    await ensureDesignJsonForFallback(paths);
    notes.push('Generated design.json locally from the final netlist.');

    const result = await runNetlistsvgPipeline({
      designJsonPath: paths.designJsonPath,
      svgPath: paths.netlistsvgPath,
    });
    if (result.ok) {
      notes.push('Rendered netlistsvg schematic via local fallback pipeline.');
    }
    if (!(await fileExists(paths.netlistsvgNotesPath))) {
      await writeFile(
        paths.netlistsvgNotesPath,
        [
          '# netlistsvg Notes',
          '',
          '- This note was generated by local fallback rendering.',
          '- netlistsvg is the primary schematic renderer.',
          `- Source design JSON: ${paths.designJsonPath}`,
          `- Output SVG: ${paths.netlistsvgPath}`,
          `- Geometry report: ${paths.netlistsvgGeometryPath}`,
          `- Layout/readability report: ${paths.netlistsvgLayoutReportPath}`,
          '',
        ].join('\n'),
        'utf8',
      );
    }
  } catch (error) {
    notes.push(`Local render fallback failed: ${formatErrorMessage(error)}`);
  }

  if (notes.length > 0) {
    await appendWorkflowFixupNotes(path.resolve(paths.logsDir, 'deterministic-fixups.md'), `Local Fallback for ${stage.label}`, notes);
  }

  const artifacts = await inspectArtifacts(paths, stage.expectedArtifacts);
  return withRecoveredStageStatus(
    {
      ...record,
      artifacts,
    },
    artifacts,
  );
}

async function updateWorkflowState(
  paths: JobPaths,
  stageRecord: StageExecutionRecord,
): Promise<void> {
  const current = JSON.parse(await readFile(paths.workflowStatePath, 'utf8')) as {
    completedStages: StageExecutionRecord[];
  };
  const completedStages = [...(current.completedStages ?? []), stageRecord];
  await writeJson(paths.workflowStatePath, {
    ...current,
    completedStages,
    lastUpdatedAt: new Date().toISOString(),
  });
}

async function runWithStageCrashGuard<T>(runner: () => Promise<T>): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      process.off('unhandledRejection', onUnhandledRejection);
      process.off('uncaughtException', onUncaughtException);
    };

    const finalizeReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
      setTimeout(cleanup, CRASH_GUARD_CLEANUP_DELAY_MS);
    };

    const onUnhandledRejection = (reason: unknown) => {
      finalizeReject(reason);
    };

    const onUncaughtException = (error: Error) => {
      finalizeReject(error);
    };

    process.on('unhandledRejection', onUnhandledRejection);
    process.on('uncaughtException', onUncaughtException);

    runner()
      .then((value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      })
      .catch((error) => {
        finalizeReject(error);
      });
  });
}

function buildRetryMetadataStage(stage: WorkflowStage, repairMode: boolean): string {
  return repairMode ? `${stage.key}:repair` : stage.key;
}

async function runStageSkillWithRetries(options: {
  sdk: HadamardAgentClient;
  paths: JobPaths;
  stage: WorkflowStage;
  prompt: string;
  streamLabel: string;
  repairMode?: boolean;
}): Promise<AgentRunResult> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= STAGE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await runWithStageCrashGuard(async () => {
        const controller = new AbortController();
        const metadataStage = buildRetryMetadataStage(options.stage, options.repairMode ?? false);
        let timeoutHandle: NodeJS.Timeout | null = null;

        try {
          const timeoutPromise = new Promise<AgentRunResult>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              const timeoutError = new Error(
                `stage ${options.streamLabel} attempt ${attempt} timed out after ${STAGE_TIMEOUT_MS} ms`,
              );
              controller.abort(timeoutError);
              reject(timeoutError);
            }, STAGE_TIMEOUT_MS);
          });

          const runPromise = (async () => {
            const session: AgentSession = await options.sdk.createAgentSession(options.stage.agentName, {
              title: `${options.paths.jobId}:${metadataStage}:attempt-${attempt}`,
              metadata: {
                jobId: options.paths.jobId,
                jobRoot: options.paths.jobRoot,
                stage: metadataStage,
                attempt,
              },
            });

            return await streamToConsole(
              session.streamSkill(options.stage.skillName, options.prompt, {
                metadata: {
                  jobId: options.paths.jobId,
                  jobRoot: options.paths.jobRoot,
                  stage: metadataStage,
                  attempt,
                },
                signal: controller.signal,
              }),
              options.streamLabel,
            );
          })();
          runPromise.catch(() => undefined);

          return await Promise.race([runPromise, timeoutPromise]);
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
      });
    } catch (error) {
      lastError = error;
      if (isRetryableTransportError(error)) {
        const artifacts = await inspectArtifacts(options.paths, options.stage.expectedArtifacts);
        if (allArtifactsExist(artifacts)) {
          writeStdout(
            `\n[artifact-complete] ${options.streamLabel}: ${formatErrorMessage(error)}; all expected artifacts exist, continuing.\n`,
          );
          return createArtifactCompletedResult(options.stage, error);
        }
      }
      const shouldRetry =
        attempt < STAGE_MAX_ATTEMPTS && isRetryableTransportError(error);
      if (!shouldRetry) {
        throw error;
      }

      const delayMs =
        STAGE_RETRY_BACKOFF_MS[Math.min(attempt - 1, STAGE_RETRY_BACKOFF_MS.length - 1)] ?? 5000;
      writeStdout(
        `\n[retry] ${options.streamLabel} attempt ${attempt + 1}/${STAGE_MAX_ATTEMPTS} in ${delayMs}ms: ${formatErrorMessage(error)}\n`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function executeStage(
  sdk: HadamardAgentClient,
  paths: JobPaths,
  stage: WorkflowStage,
): Promise<StageExecutionRecord> {
  const prompt = stage.buildPrompt(paths);
  try {
    const result = await runStageSkillWithRetries({
      sdk,
      paths,
      stage,
      prompt,
      streamLabel: stage.label,
    });

    const responsePath = await appendStageLog(paths, stage, prompt, result);
    const artifacts = await inspectArtifacts(paths, stage.expectedArtifacts);

    return {
      key: stage.key,
      label: stage.label,
      agentName: stage.agentName,
      skillName: stage.skillName,
      responsePath,
      artifacts,
      toolCalls: result.toolCalls.length,
      completedAt: result.completedAt,
      status: 'completed',
    };
  } catch (error) {
    const responsePath = await appendStageErrorLog(paths, stage, prompt, error);
    const artifacts = await inspectArtifacts(paths, stage.expectedArtifacts);
    return {
      key: stage.key,
      label: stage.label,
      agentName: stage.agentName,
      skillName: stage.skillName,
      responsePath,
      artifacts,
      toolCalls: 0,
      completedAt: new Date().toISOString(),
      status: 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

async function repairMissingArtifacts(
  sdk: HadamardAgentClient,
  paths: JobPaths,
  stage: WorkflowStage,
  record: StageExecutionRecord,
): Promise<StageExecutionRecord> {
  if (record.status === 'error' && isRetryableTransportError(record.errorMessage ?? '')) {
    return record;
  }

  const missing = record.artifacts.filter((artifact) => !artifact.exists);
  if (missing.length === 0) {
    return record;
  }

  const repairPrompt = [
    stage.buildPrompt(paths),
    '',
    '补写要求:',
    `阶段: ${stage.label}`,
    '以下文件仍然缺失，必须现在补齐:',
    ...missing.map((artifact) => `- ${artifact.label}: ${artifact.path}`),
    '',
    '严格要求:',
    '- 不要解释将要做什么。',
    '- 先使用 Write 工具创建缺失文件，再做简短总结。',
    '- 只处理缺失文件，不要重做整个阶段。',
    '- 如果缺失文件是 markdown，请写成完整工程文档，而不是提纲占位符。',
    '- 当所有缺失文件都已创建后立刻停止。',
  ].join('\n');

  try {
    const result = await runStageSkillWithRetries({
      sdk,
      paths,
      stage,
      prompt: repairPrompt,
      streamLabel: `${stage.label} Repair`,
      repairMode: true,
    });

    const responsePath = await appendStageLog(paths, stage, repairPrompt, result, 'repair');
    const artifacts = await inspectArtifacts(paths, stage.expectedArtifacts);
    return {
      ...record,
      responsePath,
      artifacts,
      toolCalls: record.toolCalls + result.toolCalls.length,
      completedAt: result.completedAt,
      status: artifacts.every((artifact) => artifact.exists) ? 'completed' : 'error',
    };
  } catch (error) {
    const responsePath = await appendStageErrorLog(paths, stage, repairPrompt, error, 'repair-error');
    const artifacts = await inspectArtifacts(paths, stage.expectedArtifacts);
    return {
      ...record,
      responsePath,
      artifacts,
      status: 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

async function writeFallbackArtifacts(
  paths: JobPaths,
  stage: WorkflowStage,
  record: StageExecutionRecord,
): Promise<StageExecutionRecord> {
  if (stage.key === 'netlist-designer') {
    const notes: string[] = [];
    try {
      const result = await composeFinalNetlistFromModules(paths);
      notes.push(...result.notes);
    } catch (error) {
      notes.push(`Module composition fallback failed: ${formatErrorMessage(error)}`);
    }
    if (notes.length > 0) {
      await appendWorkflowFixupNotes(path.resolve(paths.logsDir, 'deterministic-fixups.md'), `Local Fallback for ${stage.label}`, notes);
    }
    const artifacts = await inspectArtifacts(paths, stage.expectedArtifacts);
    if (artifacts.every((artifact) => artifact.exists)) {
      return withRecoveredStageStatus({ ...record, artifacts }, artifacts);
    }
    record = { ...record, artifacts };
  }

  const localFallbackRecord = await writeLocalRenderFallbackArtifacts(paths, stage, record);
  const missingAfterLocalFallback = localFallbackRecord.artifacts.filter((artifact) => !artifact.exists);
  if (missingAfterLocalFallback.length === 0) {
    return localFallbackRecord;
  }

  const responseExcerpt = (await readFile(localFallbackRecord.responsePath, 'utf8'))
    .replace(/\s+/g, ' ')
    .slice(0, 1200);
  const placeholderLabels: string[] = [];

  for (const artifact of missingAfterLocalFallback) {
    if (!artifact.path.endsWith('.md')) {
      continue;
    }
    placeholderLabels.push(artifact.label);

    let content = [
      `# ${artifact.label}`,
      '',
      '> WARNING: fallback-placeholder',
      '',
      'This diagnostic placeholder was generated because the stage agent did not persist the required markdown artifact.',
      'It preserves context for debugging, but it is not a semantic design approval and must be replaced or reviewed before delivery.',
      '',
      `- Stage: ${stage.label}`,
      `- Agent: ${stage.agentName}`,
      `- Skill: ${stage.skillName}`,
      '- Status: fallback-placeholder',
      `- Source log: ${localFallbackRecord.responsePath}`,
      '',
      '## Stage Context',
      '',
      'Refer to the original stage prompt and response log for the full execution details.',
      '',
      '## Response Excerpt',
      '',
      responseExcerpt || '(no response excerpt available)',
      '',
      '## Next Action',
      '',
      'Review the upstream planning artifacts and replace this fallback note with a fuller hand-authored document if needed.',
      '',
    ].join('\n');

    if (stage.key === 'workflow-lead') {
      content = [
        '# Final Summary',
        '',
        '> WARNING: fallback-placeholder',
        '',
        'This diagnostic summary was generated because the workflow-lead agent did not persist `final-summary.md`.',
        'It preserves artifact links only; it is not a semantic final approval.',
        '',
        '## Delivered Artifacts',
        '',
        `- Requirement brief: ${paths.requirementBriefPath}`,
        `- Normalized spec: ${paths.specNormalizedPath}`,
        `- Technical solution: ${paths.technicalSolutionPath}`,
        `- Asset reuse plan: ${paths.assetReusePlanPath}`,
        `- Architecture note: ${paths.architecturePath}`,
        `- Module plan: ${paths.modulePlanPath}`,
        `- Module manifest: ${paths.moduleManifestPath}`,
        `- Final netlist: ${paths.designFinalPath}`,
        `- Design notes: ${paths.designNotesPath}`,
        `- Detailed design report: ${paths.detailedDesignReportPath}`,
        `- Final review: ${paths.finalReviewPath}`,
        `- netlistsvg SVG: ${paths.netlistsvgPath}`,
        `- schemdraw SVG: ${paths.schemdrawPath}`,
        `- agent layout SVG: ${paths.agentSvgPath}`,
        '',
        '## Workflow Status',
        '',
        `- Workflow state: ${paths.workflowStatePath}`,
        `- Stage log: ${localFallbackRecord.responsePath}`,
        '',
        '## Notes',
        '',
        responseExcerpt || '(no response excerpt available)',
        '',
      ].join('\n');
    }

    await writeFile(artifact.path, content, 'utf8');
  }

  const artifacts = await inspectArtifacts(paths, stage.expectedArtifacts);
  if (placeholderLabels.length > 0) {
    return {
      ...localFallbackRecord,
      artifacts,
      status: 'error',
      errorMessage: [
        localFallbackRecord.errorMessage ?? `Stage ${stage.label} did not persist all required artifacts.`,
        `Fallback placeholder artifacts were written for: ${placeholderLabels.join(', ')}. Semantic review is required.`,
      ].join(' '),
    };
  }
  return withRecoveredStageStatus(localFallbackRecord, artifacts);
}

interface DeterministicStageFixup {
  requiredArtifactLabel?: string;
  run: (paths: JobPaths) => Promise<unknown>;
}

const DETERMINISTIC_STAGE_FIXUPS: Record<string, DeterministicStageFixup[]> = {
  'solution-analyst': [
    {
      requiredArtifactLabel: 'normalized spec',
      run: normalizePhysicalSpecAssumptions,
    },
  ],
  'netlist-designer': [
    {
      requiredArtifactLabel: 'final netlist',
      run: alignNetlistNodesToSpec,
    },
    {
      requiredArtifactLabel: 'final netlist',
      run: repairModuleInterfaceNetReuse,
    },
    {
      requiredArtifactLabel: 'final netlist',
      run: repairSignalChainComparatorNetlist,
    },
    {
      requiredArtifactLabel: 'final netlist',
      run: ensureModuleManifest,
    },
  ],
  'simulation-verifier': [
    {
      requiredArtifactLabel: 'final review',
      run: autoTuneRcCutoffInVerifier,
    },
    {
      run: refreshSignalChainComparatorVerification,
    },
  ],
};

async function applyDeterministicStageFixups(
  paths: JobPaths,
  stage: WorkflowStage,
  record: StageExecutionRecord,
): Promise<StageExecutionRecord> {
  const existingArtifacts = new Set(record.artifacts.filter((artifact) => artifact.exists).map((artifact) => artifact.label));
  for (const fixup of DETERMINISTIC_STAGE_FIXUPS[stage.key] ?? []) {
    if (fixup.requiredArtifactLabel && !existingArtifacts.has(fixup.requiredArtifactLabel)) {
      continue;
    }
    await fixup.run(paths);
  }

  const artifacts = await inspectArtifacts(paths, stage.expectedArtifacts);
  return withRecoveredStageStatus(record, artifacts);
}

async function writeManifest(paths: JobPaths, requirement: string): Promise<void> {
  await writeJson(paths.manifestPath, {
    jobId: paths.jobId,
    jobRoot: paths.jobRoot,
    requirementPreview: requirement.slice(0, 300),
    majorArtifacts: {
      userRequirement: paths.userRequirementPath,
      requirementBrief: paths.requirementBriefPath,
      specRaw: paths.specRawPath,
      specNormalized: paths.specNormalizedPath,
      technicalSolution: paths.technicalSolutionPath,
      executionChecklist: paths.executionChecklistPath,
      assetReusePlan: paths.assetReusePlanPath,
      architecture: paths.architecturePath,
      verificationPlan: paths.verificationPlanPath,
      modulePlan: paths.modulePlanPath,
      moduleManifest: paths.moduleManifestPath,
      finalNetlist: paths.designFinalPath,
      designNotes: paths.designNotesPath,
      detailedDesignReport: paths.detailedDesignReportPath,
      finalReview: paths.finalReviewPath,
      designJson: paths.designJsonPath,
      netlistsvg: paths.netlistsvgPath,
      schemdraw: paths.schemdrawPath,
      sceneHints: paths.sceneHintsPath,
      agentSvg: paths.agentSvgPath,
      finalSummary: paths.finalSummaryPath,
      workflowState: paths.workflowStatePath,
    },
  });
}

function buildWorkflowRunSummary(paths: JobPaths): WorkflowRunSummary {
  return {
    jobId: paths.jobId,
    jobRoot: paths.jobRoot,
    finalSummaryPath: paths.finalSummaryPath,
    manifestPath: paths.manifestPath,
    workflowStatePath: paths.workflowStatePath,
  };
}

export async function runCircuitDesignWorkflow(
  options: RunCircuitDesignWorkflowOptions,
): Promise<WorkflowRunSummary> {
  const config = await loadActoviqConfig();
  const approvalPolicy = resolveApprovalPolicy(options);
  const isResume = Boolean(options.resumeJob?.trim());
  const generatedNaming = isResume
    ? null
    : await generateSafeJobNaming({
        requirement: options.requirement.trim(),
        explicitName: options.jobName,
        sessionDirectory: SESSION_DIRECTORY,
      });
  const jobParentDir = options.jobParentDir ?? path.resolve(WORKSPACE_ROOT, 'jobs');
  const newJobId = isResume
    ? null
    : await buildUniqueJobId(generatedNaming?.slug ?? 'circuit-design-job', jobParentDir);
  const paths = isResume
    ? await resolveResumePaths(options.resumeJob!.trim())
    : await scaffoldJobWorkspace(
        newJobId!,
        options.requirement.trim(),
        jobParentDir,
      );
  const requirement = isResume
    ? extractRequirementFromMarkdown(await readFile(paths.userRequirementPath, 'utf8'))
    : options.requirement.trim();

  writeStdout(`\n[workspace] ${paths.jobRoot}\n`);
  writeStdout(`[requirement-file] ${paths.userRequirementPath}\n`);
  if (generatedNaming) {
    writeStdout(`[job-slug] ${generatedNaming.slug} (${generatedNaming.source})\n`);
  }
  if (isResume) {
    writeStdout(`[resume] ${paths.workflowStatePath}\n`);
  }
  writeStdout(`[approval-policy] ${approvalPolicy}\n`);

  writeStdout(`[actoviq-config] ${config.source}\n`);

  const sdk = await createAgentSdk({
    workDir: paths.jobRoot,
    sessionDirectory: SESSION_DIRECTORY,
    clientName: 'vibe-analog',
    clientVersion: ACTOVIQ_CIRCUIT_AGENT_VERSION,
    systemPrompt: GLOBAL_SYSTEM_PROMPT,
    maxToolIterations: 80,
    tools: registerCircuitTools(paths.jobRoot),
    agents: getWorkflowAgents(),
    skills: getWorkflowSkills(),
    disableDefaultSkills: true,
    loadDefaultSkillDirectories: false,
  });

  try {
    const stages = createWorkflowStages(paths, requirement);
    const state = await readWorkflowStateFile(paths.workflowStatePath);
    const requestedRerunStage = options.rerunFromStage?.trim();
    const rerunIndex = requestedRerunStage ? resolveStageIndex(stages, requestedRerunStage) : -1;
    if (requestedRerunStage && rerunIndex < 0) {
      throw new Error(`Unknown workflow stage for rerun: ${requestedRerunStage}`);
    }
    const resumeIndex = rerunIndex >= 0 ? rerunIndex : determineResumeStageIndex(stages, state);
    const latestStatuses = latestStageStatusByKey(state);
    let lastStageLabel = resumeIndex > 0 ? (stages[resumeIndex - 1]?.label ?? '用户输入') : '用户输入';

    if (isResume && rerunIndex >= 0) {
      writeStdout(`[rerun-from-stage] ${stages[rerunIndex]!.key} (${stages[rerunIndex]!.label})\n`);
    }

    if (isResume && resumeIndex >= stages.length) {
      writeStdout('[workflow] 所有阶段都已完成，本次 resume 无需继续执行。\n');
      await writeManifest(paths, requirement);
      writeStdout(`[summary] ${paths.finalSummaryPath}\n`);
      writeStdout(`[manifest] ${paths.manifestPath}\n`);
      writeStdout(`[state] ${paths.workflowStatePath}\n`);
      return buildWorkflowRunSummary(paths);
    }

    for (let index = resumeIndex; index < stages.length; index += 1) {
      const stage = stages[index]!;
      const priorRecord = latestStatuses.get(stage.key);
      if (isResume && priorRecord && canRecoverStageFromArtifacts(priorRecord, priorRecord.artifacts)) {
        const recoveredRecord = withRecoveredStageStatus(priorRecord, priorRecord.artifacts);
        await updateWorkflowState(paths, recoveredRecord);
        latestStatuses.set(stage.key, recoveredRecord);
        writeStdout(`\n[resume-stage] reusing existing artifacts for ${stage.label}\n`);
        lastStageLabel = stage.label;
        continue;
      }
      if (isResume && priorRecord?.status === 'error') {
        writeStdout(`\n[resume-stage] retrying ${stage.label}\n`);
      }
      if (index > 0) {
        const autoApproveStage = shouldAutoApproveStage(approvalPolicy, stage);
        if (stage.requiresConfirmation === false) {
          writeStdout(`\n[auto-transition] ${lastStageLabel} -> ${stage.label} (closed-loop ReAct)\n`);
        } else if (autoApproveStage) {
          writeStdout(`\n[auto-approve:${approvalPolicy}] ${lastStageLabel} -> ${stage.label}\n`);
        } else {
          const approved = await confirmAgentTransition(
            options.rl,
            lastStageLabel,
            stage.label,
            false,
          );
          if (!approved) {
            writeStdout('\n[workflow] 用户取消了后续 agent 切换，流程提前结束。\n');
            break;
          }
        }
      }

      const initialRecord = await executeStage(sdk, paths, stage);
      const repairedRecord = await repairMissingArtifacts(sdk, paths, stage, initialRecord);
      const fallbackRecord = await writeFallbackArtifacts(paths, stage, repairedRecord);
      const fixedRecord = await applyDeterministicStageFixups(paths, stage, fallbackRecord);
      const record =
        fixedRecord.status === 'error'
          ? {
              ...fixedRecord,
              errorExplanation: await explainStageError(sdk, paths, stage, fixedRecord),
            }
          : fixedRecord;
      await updateWorkflowState(paths, record);

      const responseText = await readFile(record.responsePath, 'utf8');
      printStageSummary({
        stageLabel: stage.label,
        artifacts: record.artifacts,
        toolCount: record.toolCalls,
        responseText,
        status: record.status,
        errorMessage: record.errorMessage,
        errorExplanation: record.errorExplanation,
      });

      if (record.status === 'error') {
        writeStderr(colorBoldRed('\n[workflow] current stage failed; preserved artifacts and stopped.\n'));
        writeStderr(colorBoldRed('[workflow] 当前阶段发生错误，流程在保留已生成工件后停止。\n'));
        break;
      }

      lastStageLabel = stage.label;
    }

    await writeManifest(paths, requirement);

    writeStdout('\n[done] 工作流执行结束。\n');
    writeStdout(`[summary] ${paths.finalSummaryPath}\n`);
    writeStdout(`[manifest] ${paths.manifestPath}\n`);
    writeStdout(`[state] ${paths.workflowStatePath}\n`);
    return buildWorkflowRunSummary(paths);
  } finally {
    await sdk.close();
  }
}


