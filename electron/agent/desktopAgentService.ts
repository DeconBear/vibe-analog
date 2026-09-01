import { createHash } from 'node:crypto';
import path from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import {
  createAgentSdk,
  skill,
  type HadamardAgentClient,
  type AgentEvent,
  type AgentRunResult,
  type AgentSession,
  type HadamardSkillDefinition,
  type CreateAgentSdkOptions,
} from 'actoviq-agent-sdk';

import { createDesktopCircuitTools } from './desktopCircuitTools.js';
import { createDisabledTaskTool, withAgentFacingToolErrorsForAll } from './toolHelpers.js';
import { createAssistantRoundTracker, type DesktopAgentRound } from './assistantRounds.js';
import { createSanitizedProviderModelApi } from './sanitizedModelApi.js';

export type { DesktopAgentRound } from './assistantRounds.js';

const DESKTOP_AGENT_NAME = 'actoviq-circuit-desktop';
const REPORT_AGENT_NAME = 'actoviq-circuit-report-writer';
const MAX_INITIAL_HISTORY_MESSAGES = 20;
const MAX_TOOL_ITERATIONS = 60;

type DesktopAgentMode = 'react' | 'codeact' | 'hybrid';

function resolveDesktopAgentMode(): DesktopAgentMode {
  const override = process.env.VIBE_DESKTOP_AGENT_MODE?.trim().toLowerCase();
  return override === 'react' || override === 'codeact' || override === 'hybrid' ? override : 'codeact';
}

/** The main agent's execution mode. CodeAct by default; override for A/B evaluation. */
export const DESKTOP_AGENT_MODE: DesktopAgentMode = resolveDesktopAgentMode();

const INTENT_SYSTEM_PROMPT_BODY = `Protocol loop (actoviq.project-agent.v2):
1. Resolve workspace with workspace_active / workspace_list / workspace_use when needed.
2. For a new design: create_circuit_project, then agent_context, then apply_circuit_command.
3. For a revision: agent_context first and use the exact base_revision returned.
4. After apply: run_erc; fix blocking errors with another apply if needed.
5. compile_circuit_project (or compile_circuit_module), then simulate when the design has stimulus/analysis.
6. When the user asks for documentation, call generate_technical_report after compile/simulation with the verified source revision.
7. Prefer reference_catalog_list / reference_insert_module / prepare_layout_from_reference before inventing topology.
8. For pcb_schematic part selection, use lcsc_search / lcsc_bind. For analog_ic, run analog_ic_audit before simulation.

apply_circuit_command operations MUST be flat objects with an "op" field, e.g.
{"op":"upsert_module_netlist","module_id":"power_stage","name":"Power Stage","netlist_notebook":"..."}.
connect_ports MUST use {"op":"connect_ports","from":{"module_id":"source","port_id":"out"},"to":{"module_id":"load","port_id":"in"}}.
Put .ac/.tran analysis directives in an upsert_module_netlist stimulus notebook; there is no set_analysis operation and command-level analyses do not replace a transaction.
Do NOT nest as {"upsert_module":{...}} or {"add_component":{...}} — that fails apply and leaves 0 modules on the canvas.
Prefer upsert_module_netlist (netlist_notebook as a single string) over many add_component calls.
After apply, verify the tool result shows ok/revision/module count before claiming the canvas has modules.
If apply_circuit_command returns status "pending", the transaction is waiting for explicit user review:
do not run ERC, compile, or simulation against it, and tell the user to accept or reject the proposal in the canvas.

Module composition (default for desktop canvas):
- Prefer functional modules: stimuli / cores / encode-load, then add_port + connect_ports.
- A single upsert_module_netlist is ONLY for trivial paths (about ≤8 devices, one signal chain).
- Designs with >8 devices or multiple stages MUST be split; do not leave a monolithic oversized module.
- Canvas card positions are auto-unstacked by the project tool when omitted or overlapping; still prefer distinct positions when known.

Hard constraints:
- simulation kind: flat SPICE primitives only (R C L Q M D V I). No .subckt/.ends, no B/E/F/G/H/X.
- Never claim success without reading tool results.
- For greetings or non-circuit questions, answer briefly without tools.
- Prefer concise Chinese or English matching the user.
- After tools finish, summarize what changed (project id, revision, ERC, sim status, module count) in natural language.
`;

const INTENT_SYSTEM_PROMPT_CODEACT = `You are Vibe Analog, the built-in assistant in the Vibe Analog desktop circuit design app.

You design and revise circuits through CodeAct: you write Python code cells, and the circuit tools run as typed host functions (the hadamard.<tool_name>(...) stubs in the SDK section). Tool calls return structured Python values - always read them before deciding the next step. Do not invent file contents under build/.

CodeAct discipline:
- Prefer one coherent Python cell per protocol step (e.g. create + agent_context); assign results to variables and assert preconditions (project id, base_revision, ok flags) before continuing.
- Call agent_context exactly once immediately before each apply_circuit_command. Reuse that response while building the transaction; after a successful apply, keep the returned project id/revision in Python variables and do not poll agent_context again before ERC, compile, or simulation. Read it again only immediately before the next repair transaction or when the project/revision is genuinely unknown.
- Call typed hadamard.<tool_name> stubs with keyword arguments only; positional arguments are not supported.
- Inspect tool results in Python (print or check fields) instead of assuming success; a failed host call raises an error you must handle.
- Batch independent operations into one transaction, then compile once after the requested design is complete and simulate once after a successful compile. Do not add optional measurements or repeat successful verification unless the user requested them.
- After any repair transaction, compile and simulate the current revision again. A module-level simulation does not replace simulate_circuit_project when the user requested project verification; claim success only from a current-revision project result with execution_status="success".
- Keep cells bounded: no unbounded loops, no network access, no filesystem reads outside tool results.

${INTENT_SYSTEM_PROMPT_BODY}`;

const INTENT_SYSTEM_PROMPT_REACT = `You are Vibe Analog, the built-in assistant in the Vibe Analog desktop circuit design app.

You design and revise circuits by calling tools (ReAct). Tools wrap the same circuit_project.py CLI that external Skill agents use. Do not invent file contents under build/.

${INTENT_SYSTEM_PROMPT_BODY}`;

const INTENT_SYSTEM_PROMPT = DESKTOP_AGENT_MODE === 'react' ? INTENT_SYSTEM_PROMPT_REACT : INTENT_SYSTEM_PROMPT_CODEACT;

const REPORT_SYSTEM_PROMPT = `You are the built-in Vibe Analog circuit technical report writer.

Write a precise engineering report in Markdown from the supplied immutable project, ERC, build, and simulation evidence.

Required sections:
1. Executive summary
2. Requirements and assumptions
3. Circuit architecture and signal flow
4. Component and parameter rationale
5. ERC and connectivity status
6. Simulation setup
7. Results and specification assessment
8. Limitations and risks
9. Reproduction steps

Rules:
- Never invent a measurement, pass result, topology, model, or test that is absent from the evidence.
- Clearly label missing or stale evidence.
- Quote component IDs, net names, analysis directives, revision, and hashes when useful.
- Distinguish execution_status, measurement_status, and specification_status.
- Use concise tables for measurements and specifications when data exists.
- Do not call tools and do not wrap the report in a Markdown code fence.`;

export interface DesktopAgentConfig {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  baseURL: string;
  model: string;
  workDir?: string;
  homeDir?: string;
}

export interface DesktopAgentContext {
  activeJobId?: string | null;
  activeProjectId?: string | null;
  workspaceRoot?: string | null;
  approvalPolicy?: 'manual' | 'execution' | 'all';
  /** @deprecated Prefer agent_context tool; kept for prompt hints only. */
  activeProject?: Record<string, unknown> | null;
}

export interface DesktopAgentRunInput {
  conversationId: string;
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  context?: DesktopAgentContext;
}

export interface DesktopAgentChatResponse {
  text: string;
  /** All assistant text rounds of the run (text may only carry the final one). */
  rounds?: DesktopAgentRound[];
  /** Legacy flags retained for type compatibility; always false on the ReAct path. */
  isDesignRequest: boolean;
  isRevisionRequest?: boolean;
  formalizedRequirement?: string;
  revisionRequest?: string;
  targetStage?: string;
  projectName?: string;
  projectKind?: 'simulation' | 'pcb_schematic' | 'analog_ic' | 'mixed_signal_ic';
  projectOperations?: Array<Record<string, unknown>>;
  compileAfterApply?: boolean;
  simulateAfterApply?: boolean;
  isError?: boolean;
  runId?: string;
  sessionId?: string;
  model?: string;
  usage?: Record<string, unknown>;
  /** Best-effort project id touched during the run (from tool args). */
  touchedProjectId?: string;
}

export type DesktopAgentEventType =
  | 'run-started'
  | 'status'
  | 'text-progress'
  | 'assistant-round'
  | 'thinking-delta'
  | 'tool-call'
  | 'tool-result'
  | 'compacted'
  | 'model-fallback'
  | 'retry'
  | 'usage'
  | 'completed'
  | 'cancelled'
  | 'error';

export interface DesktopAgentEvent {
  type: DesktopAgentEventType;
  conversationId: string;
  sequence: number;
  timestamp: number;
  runId?: string;
  sessionId?: string;
  model?: string;
  text?: string;
  delta?: string;
  label?: string;
  iteration?: number;
  toolName?: string;
  toolUseId?: string;
  isError?: boolean;
  usage?: Record<string, unknown>;
  rounds?: DesktopAgentRound[];
}

export interface DesktopAgentRunHandle {
  result: Promise<DesktopAgentChatResponse>;
  cancel: (reason?: string) => void;
}

interface CachedClient {
  signature: string;
  hasTechnicalReportTool: boolean;
  client: HadamardAgentClient;
}

let cachedClient: CachedClient | null = null;
let clientTransition: Promise<void> = Promise.resolve();
let cachedReportClient: Omit<CachedClient, 'hasTechnicalReportTool'> | null = null;
let reportClientTransition: Promise<void> = Promise.resolve();

export interface DesktopAgentRunOptions {
  approvalPolicy?: 'manual' | 'execution' | 'all';
  generateTechnicalReport?: (input: {
    projectId: string;
    sourceRevision: number;
  }) => Promise<Record<string, unknown>>;
}

function configSignature(
  config: DesktopAgentConfig,
  approvalPolicy: 'manual' | 'execution' | 'all' = 'execution',
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      provider: config.provider,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model,
      workDir: config.workDir,
      homeDir: config.homeDir,
      approvalPolicy,
    }))
    .digest('hex');
}

async function loadCircuitDesignSkill(): Promise<HadamardSkillDefinition | null> {
  try {
    const skillPath = path.resolve(
      process.cwd(),
      'skills',
      'circuit-design-ngspice',
      'SKILL.md',
    );
    const markdown = await readFile(skillPath, 'utf8');
    // Strip YAML frontmatter for the prompt body.
    const prompt = markdown.replace(/^---[\s\S]*?---\s*/, '').trim();
    return skill({
      name: 'circuit-design-ngspice',
      description: 'Vibe Analog circuit-design-ngspice project protocol and CLI map.',
      whenToUse: 'Use when designing, revising, simulating, or exporting Vibe Analog circuit projects.',
      prompt: [
        'You are following /circuit-design-ngspice.',
        'Use the registered desktop circuit tools (same CLI as this skill).',
        '',
        prompt.slice(0, 12_000),
        '',
        'Arguments / context:',
        '$ARGUMENTS',
      ].join('\n'),
      source: 'custom',
      loadedFrom: 'custom',
    });
  } catch {
    return null;
  }
}

async function getClient(
  config: DesktopAgentConfig,
  options: DesktopAgentRunOptions = {},
): Promise<HadamardAgentClient> {
  const signature = configSignature(config, options.approvalPolicy);
  const needsTechnicalReportTool = Boolean(options.generateTechnicalReport);
  if (
    cachedClient?.signature === signature
    && (!needsTechnicalReportTool || cachedClient.hasTechnicalReportTool)
  ) {
    return cachedClient.client;
  }

  let resolved: HadamardAgentClient | null = null;
  clientTransition = clientTransition.then(async () => {
    if (
      cachedClient?.signature === signature
      && (!needsTechnicalReportTool || cachedClient.hasTechnicalReportTool)
    ) {
      resolved = cachedClient.client;
      return;
    }
    if (cachedClient) {
      await cachedClient.client.close().catch(() => undefined);
      cachedClient = null;
    }
    const workDir = path.resolve(config.workDir || process.cwd());
    const homeDir = path.resolve(config.homeDir || path.join(homedir(), '.actoviq'));
    const circuitTools = withAgentFacingToolErrorsForAll([
      createDisabledTaskTool(),
      ...createDesktopCircuitTools({
        approvalPolicy: options.approvalPolicy,
        generateTechnicalReport: options.generateTechnicalReport,
      }),
    ]);
    const circuitSkill = await loadCircuitDesignSkill();
    const sdkOptions: CreateAgentSdkOptions = {
      provider: config.provider,
      apiKey: config.apiKey,
      authToken: config.provider === 'anthropic' ? config.apiKey : undefined,
      baseURL: config.baseURL,
      model: config.model,
      workDir,
      homeDir,
      sessionDirectory: path.join(homeDir, 'circuit-agent-desktop', 'sessions'),
      clientName: 'vibe-analog-desktop',
      clientVersion: '0.1.11',
      tools: circuitTools,
      mcpServers: [],
      disableDefaultAgents: true,
      loadDefaultAgentDirectories: false,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
      skills: circuitSkill ? [circuitSkill] : [],
      // Tool approval for circuit mutations is enforced inside apply_circuit_command
      // (pending-stage transactions under approvalPolicy "manual"), so the SDK-level
      // gate must not block the CodeCell action space it dispatches through.
      permissions: [{ toolName: '*', behavior: 'allow', source: 'desktop-agent' }],
      permissionMode: 'default',
      maxToolIterations: MAX_TOOL_ITERATIONS,
      // Keep the desktop agent on the persistent CodeCell plane. Project-level
      // PTC settings must not add the stateless run_code action beside CodeCell.
      toolPresentation: 'native',
      agents: [{
        name: DESKTOP_AGENT_NAME,
        description: 'Built-in CodeAct circuit design agent driving Skill-aligned tools from Python cells.',
        systemPrompt: INTENT_SYSTEM_PROMPT,
        model: config.model,
        agentMode: DESKTOP_AGENT_MODE,
        toolPresentation: 'native',
        tools: circuitTools,
        allowedTools: circuitTools.map((entry) => entry.name),
        mcpServers: [],
        inheritDefaultTools: false,
        inheritDefaultMcpServers: false,
        allowNestedAgents: false,
        maxToolIterations: MAX_TOOL_ITERATIONS,
        skills: circuitSkill ? [circuitSkill.name] : [],
        source: 'custom',
      }, {
        name: REPORT_AGENT_NAME,
        description: 'Writes a revision-bound technical report from verified circuit artifacts.',
        systemPrompt: REPORT_SYSTEM_PROMPT,
        model: config.model,
        tools: [],
        allowedTools: [],
        mcpServers: [],
        inheritDefaultTools: false,
        inheritDefaultMcpServers: false,
        allowNestedAgents: false,
        maxToolIterations: 0,
        source: 'custom',
      }],
    };
    // Provider error bodies can echo credentials; the SDK persists raw run
    // errors into its on-disk audit store, so redact at the ModelApi boundary.
    sdkOptions.modelApi = await createSanitizedProviderModelApi(sdkOptions);
    const client = await createAgentSdk(sdkOptions);
    cachedClient = {
      signature,
      hasTechnicalReportTool: needsTechnicalReportTool,
      client,
    };
    resolved = client;
  });
  await clientTransition;
  if (!resolved) throw new Error('Unable to initialize the desktop agent runtime.');
  return resolved;
}

async function getReportClient(config: DesktopAgentConfig): Promise<HadamardAgentClient> {
  const signature = configSignature(config);
  if (cachedReportClient?.signature === signature) return cachedReportClient.client;

  let resolved: HadamardAgentClient | null = null;
  reportClientTransition = reportClientTransition.then(async () => {
    if (cachedReportClient?.signature === signature) {
      resolved = cachedReportClient.client;
      return;
    }
    if (cachedReportClient) {
      await cachedReportClient.client.close().catch(() => undefined);
      cachedReportClient = null;
    }
    const workDir = path.resolve(config.workDir || process.cwd());
    const homeDir = path.resolve(config.homeDir || path.join(homedir(), '.actoviq'));
    const reportSdkOptions: CreateAgentSdkOptions = {
      provider: config.provider,
      apiKey: config.apiKey,
      authToken: config.provider === 'anthropic' ? config.apiKey : undefined,
      baseURL: config.baseURL,
      model: config.model,
      workDir,
      homeDir,
      sessionDirectory: path.join(homeDir, 'circuit-agent-desktop-report', 'sessions'),
      clientName: 'vibe-analog-report',
      clientVersion: '0.1.11',
      tools: [],
      mcpServers: [],
      disableDefaultAgents: true,
      loadDefaultAgentDirectories: false,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
      permissionMode: 'default',
      maxToolIterations: 0,
      agents: [{
        name: REPORT_AGENT_NAME,
        description: 'Writes a revision-bound technical report from verified circuit artifacts.',
        systemPrompt: REPORT_SYSTEM_PROMPT,
        model: config.model,
        tools: [],
        allowedTools: [],
        mcpServers: [],
        inheritDefaultTools: false,
        inheritDefaultMcpServers: false,
        allowNestedAgents: false,
        maxToolIterations: 0,
        source: 'custom',
      }],
    };
    reportSdkOptions.modelApi = await createSanitizedProviderModelApi(reportSdkOptions);
    const client = await createAgentSdk(reportSdkOptions);
    cachedReportClient = { signature, client };
    resolved = client;
  });
  await reportClientTransition;
  if (!resolved) throw new Error('Unable to initialize the desktop report agent runtime.');
  return resolved;
}

function normalizeSessionId(conversationId: string): string {
  const readable = conversationId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 72) || 'conversation';
  const suffix = createHash('sha256').update(conversationId).digest('hex').slice(0, 12);
  return `circuit-${readable}-${suffix}`;
}

async function getSession(
  client: HadamardAgentClient,
  config: DesktopAgentConfig,
  input: DesktopAgentRunInput,
): Promise<AgentSession> {
  const sessionId = normalizeSessionId(input.conversationId);
  try {
    const session = await client.sessions.get(sessionId);
    if (session.model !== config.model) await session.setModel(config.model);
    return session;
  } catch {
    const initialMessages = (input.history ?? [])
      .slice(-MAX_INITIAL_HISTORY_MESSAGES)
      .map((message) => ({ role: message.role, content: message.content }));
    return client.createAgentSession(DESKTOP_AGENT_NAME, {
      id: sessionId,
      title: input.message.slice(0, 80),
      model: config.model,
      initialMessages,
      tags: ['desktop', 'circuit-design', 'react'],
      metadata: { desktopConversationId: input.conversationId },
    });
  }
}

function buildPrompt(input: DesktopAgentRunInput): string {
  const activeProjectHint = input.context?.activeProject
    ? JSON.stringify({
      project_id: (input.context.activeProject as { project_id?: string }).project_id
        ?? input.context.activeProjectId,
      base_revision: (input.context.activeProject as { base_revision?: number }).base_revision,
      next_action: (input.context.activeProject as { next_action?: unknown }).next_action,
    }).slice(0, 4_000)
    : '(none — call agent_context after create or when revising)';
  return [
    'Desktop context:',
    `- activeJobId: ${input.context?.activeJobId ?? '(none)'}`,
    `- activeProjectId: ${input.context?.activeProjectId ?? '(none)'}`,
    `- workspaceRoot: ${input.context?.workspaceRoot ?? '(none)'}`,
    `- approvalPolicy: ${input.context?.approvalPolicy ?? 'execution'}`,
    `- activeProjectHint: ${activeProjectHint}`,
    '',
    'User message:',
    input.message,
  ].join('\n');
}

function toolLabel(name: string, phase: 'call' | 'result'): string {
  const labels: Record<string, string> = {
    workspace_list: 'Listing workspaces',
    workspace_active: 'Reading active workspace',
    workspace_use: 'Switching workspace',
    create_circuit_project: 'Creating circuit project',
    agent_context: 'Reading agent context',
    project_summary: 'Reading project summary',
    apply_circuit_command: 'Applying project transaction',
    run_erc: 'Running ERC',
    compile_circuit_project: 'Compiling project',
    compile_circuit_module: 'Compiling module',
    simulate_circuit_project: 'Running simulation',
    simulate_circuit_module: 'Simulating module',
    generate_technical_report: 'Generating technical report',
    analog_ic_audit: 'Auditing analog IC constraints',
    export_eda: 'Exporting EDA package',
    lcsc_search: 'Searching LCSC parts',
    lcsc_bind: 'Binding LCSC part',
    reference_catalog_list: 'Listing reference catalog',
    reference_insert_module: 'Inserting reference module',
    prepare_layout_from_reference: 'Checking layout reference',
    apply_layout_from_reference: 'Applying layout reference',
  };
  const base = labels[name] || name;
  return phase === 'result' ? `${base} · done` : base;
}

function extractTouchedProjectId(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const projectId = record.project_id ?? record.projectId;
  if (typeof projectId === 'string' && projectId.trim()) return projectId.trim();
  if (toolName === 'create_circuit_project') return undefined;
  return undefined;
}

export function sanitizeAgentError(error: unknown): string {
  const source = error instanceof Error ? error.message : String(error);
  return source
    .replace(/\b(?:sk|ark|ak)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[redacted]')
    .replace(/((?:api[_ -]?key|auth[_ -]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 1200);
}

export function startDesktopAgentRun(
  config: DesktopAgentConfig,
  input: DesktopAgentRunInput,
  onEvent: (event: DesktopAgentEvent) => void,
  options: DesktopAgentRunOptions = {},
): DesktopAgentRunHandle {
  const abortController = new AbortController();
  let activeStream: { cancel: (reason?: string) => void } | null = null;
  let sequence = 0;
  let lastRunId: string | undefined;
  let lastSessionId: string | undefined;
  let lastModel = config.model;
  let touchedProjectId = input.context?.activeProjectId ?? undefined;

  const emit = (event: Omit<DesktopAgentEvent, 'conversationId' | 'sequence' | 'timestamp'>): void => {
    onEvent({
      ...event,
      conversationId: input.conversationId,
      sequence: sequence += 1,
      timestamp: Date.now(),
    });
  };

  const runAttempt = async (session: AgentSession, prompt: string): Promise<{
    raw: string;
    rounds: DesktopAgentRound[];
    runId?: string;
    sessionId?: string;
    model: string;
    usage?: Record<string, unknown>;
  }> => {
    let raw = '';
    let visibleText = '';
    let usage: Record<string, unknown> | undefined;
    // Per-round assistant text. The SDK's response.text.delta snapshot is scoped to
    // a single ReAct iteration, so each new request.started boundary finalizes the
    // previous round; stream.result.requests is the authoritative fallback.
    const roundTracker = createAssistantRoundTracker();
    let requestSummaries: AgentRunResult['requests'] | undefined;
    const stream = session.stream(prompt, {
      signal: abortController.signal,
      maxTokens: 8192,
      temperature: 0.2,
      metadata: { surface: 'desktop-react' },
    });
    activeStream = stream;
    for await (const event of stream) {
      const sdkEvent = event as AgentEvent;
      lastRunId = sdkEvent.runId;
      switch (sdkEvent.type) {
        case 'run.started':
          lastSessionId = sdkEvent.sessionId;
          lastModel = sdkEvent.model;
          emit({ type: 'run-started', runId: sdkEvent.runId, sessionId: sdkEvent.sessionId, model: sdkEvent.model });
          break;
        case 'request.started': {
          const round = roundTracker.flushRequestBoundary();
          if (round) {
            emit({ type: 'assistant-round', runId: sdkEvent.runId, iteration: round.iteration, text: round.text });
          }
          raw = '';
          visibleText = '';
          emit({
            type: 'status',
            runId: sdkEvent.runId,
            iteration: sdkEvent.iteration,
            label: 'Thinking and selecting tools',
          });
          break;
        }
        case 'response.text.delta': {
          const snapshot = typeof sdkEvent.snapshot === 'string' ? sdkEvent.snapshot : '';
          const delta = typeof sdkEvent.delta === 'string' ? sdkEvent.delta : '';
          raw = roundTracker.handleTextDelta(sdkEvent.iteration, snapshot, delta);
          const nextText = raw;
          if (nextText !== visibleText) {
            const textDelta = nextText.startsWith(visibleText) ? nextText.slice(visibleText.length) : (delta || nextText);
            visibleText = nextText;
            emit({ type: 'text-progress', runId: sdkEvent.runId, text: nextText, delta: textDelta });
          }
          break;
        }
        case 'response.thinking.delta':
          emit({ type: 'thinking-delta', runId: sdkEvent.runId, delta: sdkEvent.delta });
          break;
        case 'tool.call': {
          const name = sdkEvent.call.name;
          const fromInput = extractTouchedProjectId(name, sdkEvent.call.input);
          if (fromInput) touchedProjectId = fromInput;
          if (name === 'CodeCell') {
            // CodeAct outer action: the host sub-calls below carry the user-visible labels.
            emit({
              type: 'status',
              runId: sdkEvent.runId,
              iteration: sdkEvent.iteration,
              label: 'Executing Python cell',
            });
            break;
          }
          emit({
            type: 'tool-call',
            runId: sdkEvent.runId,
            iteration: sdkEvent.iteration,
            toolName: name,
            toolUseId: sdkEvent.call.id,
            label: toolLabel(name, 'call'),
          });
          break;
        }
        case 'tool.code_dispatch': {
          // CodeAct host sub-call result. The nested executor already emits
          // tool.call for the sub-call; only the settle carries the outcome.
          if (sdkEvent.phase !== 'settle') break;
          let resultLabel = toolLabel(sdkEvent.name, 'result');
          if (sdkEvent.summary) {
            const match = /"project_id"\s*:\s*"([^"]+)"/.exec(sdkEvent.summary);
            if (match?.[1]) {
              touchedProjectId = match[1];
              resultLabel = `${resultLabel} · ${match[1]}`;
            }
          }
          emit({
            type: 'tool-result',
            runId: sdkEvent.runId,
            iteration: sdkEvent.iteration,
            toolName: sdkEvent.name,
            toolUseId: sdkEvent.subCallId,
            isError: sdkEvent.isError,
            label: sdkEvent.isError ? `${resultLabel} · error` : resultLabel,
          });
          break;
        }
        case 'tool.result': {
          const name = sdkEvent.result.name;
          if (name === 'CodeCell') break; // sub-dispatch events already surfaced the host tools
          let resultLabel = toolLabel(name, 'result');
          // Best-effort: parse create/result JSON for project id
          try {
            const content = sdkEvent.result.outputText
              || (typeof sdkEvent.result.output === 'string'
                ? sdkEvent.result.output
                : JSON.stringify(sdkEvent.result.output ?? ''));
            const match = /"project_id"\s*:\s*"([^"]+)"/.exec(content)
              || /"projectId"\s*:\s*"([^"]+)"/.exec(content);
            if (match?.[1]) {
              touchedProjectId = match[1];
              resultLabel = `${resultLabel} · ${match[1]}`;
            }
          } catch {
            // ignore
          }
          emit({
            type: 'tool-result',
            runId: sdkEvent.runId,
            iteration: sdkEvent.iteration,
            toolName: name,
            toolUseId: sdkEvent.result.id,
            isError: sdkEvent.result.isError,
            label: sdkEvent.result.isError ? `${resultLabel} · error` : resultLabel,
          });
          break;
        }
        case 'session.compacted':
        case 'conversation.compacted':
          emit({ type: 'compacted', runId: sdkEvent.runId, label: 'Conversation context compacted' });
          break;
        case 'model.fallback':
          lastModel = sdkEvent.toModel;
          emit({
            type: 'model-fallback',
            runId: sdkEvent.runId,
            model: sdkEvent.toModel,
            label: `${sdkEvent.fromModel} → ${sdkEvent.toModel}`,
          });
          break;
        case 'response.completed':
          raw = sdkEvent.result.text || raw;
          requestSummaries = sdkEvent.result.requests;
          usage = sdkEvent.result.usage as unknown as Record<string, unknown> | undefined;
          if (usage) emit({ type: 'usage', runId: sdkEvent.runId, usage });
          break;
        case 'error':
          throw new Error(sanitizeAgentError(sdkEvent.error.message));
        default:
          break;
      }
    }
    const result = await stream.result;
    activeStream = null;
    // Authoritative per-iteration texts win; fall back to rounds flushed while
    // streaming plus the final accumulated round.
    const finalRaw = result.text || raw;
    return {
      raw: finalRaw,
      rounds: roundTracker.finalize(requestSummaries ?? result.requests, finalRaw),
      runId: result.runId,
      sessionId: result.sessionId,
      model: result.model,
      usage: (result.usage as unknown as Record<string, unknown> | undefined) ?? usage,
    };
  };

  const result = (async (): Promise<DesktopAgentChatResponse> => {
    try {
      const client = await getClient(config, options);
      const session = await getSession(client, config, input);
      const first = await runAttempt(session, buildPrompt(input));
      const text = (first.raw || '').trim() || 'Done.';
      const completed: DesktopAgentChatResponse = {
        text,
        rounds: first.rounds.length > 0 ? first.rounds : [{ iteration: 1, text }],
        isDesignRequest: false,
        isRevisionRequest: false,
        runId: first.runId,
        sessionId: first.sessionId ?? session.id,
        model: first.model,
        usage: first.usage,
        touchedProjectId,
      };
      emit({
        type: 'completed',
        runId: completed.runId,
        sessionId: completed.sessionId,
        model: completed.model,
        text: completed.text,
        rounds: completed.rounds,
        usage: completed.usage,
      });
      return completed;
    } catch (error) {
      const message = sanitizeAgentError(error);
      if (abortController.signal.aborted) {
        emit({ type: 'cancelled', runId: lastRunId, sessionId: lastSessionId, model: lastModel, label: message || 'Cancelled' });
        return {
          text: 'The request was stopped.',
          isDesignRequest: false,
          isRevisionRequest: false,
          isError: true,
          runId: lastRunId,
          sessionId: lastSessionId,
          model: lastModel,
          touchedProjectId,
        };
      }
      emit({ type: 'error', runId: lastRunId, sessionId: lastSessionId, model: lastModel, label: message });
      return {
        text: `Agent error: ${message}`,
        isDesignRequest: false,
        isRevisionRequest: false,
        isError: true,
        runId: lastRunId,
        sessionId: lastSessionId,
        model: lastModel,
        touchedProjectId,
      };
    } finally {
      activeStream = null;
    }
  })();

  return {
    result,
    cancel: (reason = 'Stopped by user') => {
      abortController.abort(reason);
      activeStream?.cancel(reason);
    },
  };
}

export async function closeDesktopAgentService(): Promise<void> {
  await Promise.all([clientTransition, reportClientTransition]);
  const clients = [cachedClient?.client, cachedReportClient?.client].filter(
    (client): client is HadamardAgentClient => Boolean(client),
  );
  cachedClient = null;
  cachedReportClient = null;
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
}

export interface TechnicalReportInput {
  projectId: string;
  sourceRevision: number;
  documentHash?: string;
  evidence: Record<string, unknown>;
}

export interface TechnicalReportResult {
  report: string;
  model: string;
  runId: string;
  usage?: Record<string, unknown>;
}

export async function generateDesktopTechnicalReport(
  config: DesktopAgentConfig,
  input: TechnicalReportInput,
): Promise<TechnicalReportResult> {
  const client = await getReportClient(config);
  const evidence = JSON.stringify(input.evidence).slice(0, 120_000);
  const result = await client.runWithAgent(REPORT_AGENT_NAME, [
    `Project: ${input.projectId}`,
    `Source revision: ${input.sourceRevision}`,
    `Document hash: ${input.documentHash ?? '(unavailable)'}`,
    '',
    'Verified evidence JSON:',
    evidence,
  ].join('\n'), {
    model: config.model,
    maxTokens: 7000,
    temperature: 0.1,
    metadata: {
      surface: 'desktop-technical-report',
      projectId: input.projectId,
      sourceRevision: input.sourceRevision,
    },
  });
  const report = result.text.trim();
  if (!report || report.length < 200) {
    throw new Error('The report agent returned an incomplete technical report.');
  }
  return {
    report,
    model: result.model,
    runId: result.runId,
    usage: result.usage as unknown as Record<string, unknown> | undefined,
  };
}
