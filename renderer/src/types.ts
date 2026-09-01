export interface ChatMessageTool {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  label?: string;
  detail?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  isError?: boolean;
  conversationId?: string;
  runId?: string;
  sessionId?: string;
  model?: string;
  usage?: Record<string, unknown>;
  /** Tool / host-step timeline captured for this turn (visible in history). */
  tools?: ChatMessageTool[];
  /** Optional thinking trace captured with the assistant turn. */
  thinking?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  lastMessage: string;
  messageCount: number;
  updatedAt: number;
  jobId?: string;
  /** When true, auto-title from the first user message is skipped. */
  titleLocked?: boolean;
  /** Circuit project this conversation belongs to; null/undefined = workspace/legacy. */
  projectId?: string | null;
}

export interface StageState {
  key: string;
  name: string;
  status: 'waiting' | 'running' | 'done' | 'error';
}

export interface ToolCallEntry {
  tool: string;
  stageKey: string;
  timestamp: number;
}

export interface StageDef {
  key: string;
  name: string;
}

export interface ChatResponse {
  text: string;
  /** All assistant text rounds of a ReAct run (text may only carry the final one). */
  rounds?: Array<{ iteration: number; text: string }>;
  isDesignRequest: boolean;
  formalizedRequirement?: string;
  isRevisionRequest?: boolean;
  revisionRequest?: string;
  targetStage?: string;
  projectName?: string;
  projectKind?: ProjectKind;
  /** @deprecated ReAct path applies via tools; kept for compatibility. */
  projectOperations?: Array<Record<string, unknown>>;
  compileAfterApply?: boolean;
  simulateAfterApply?: boolean;
  isError?: boolean;
  runId?: string;
  sessionId?: string;
  model?: string;
  usage?: Record<string, unknown>;
  /** Project id touched by desktop ReAct tools (for GUI reload). */
  touchedProjectId?: string;
}

export interface DesktopAgentEvent {
  type:
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
  rounds?: Array<{ iteration: number; text: string }>;
}

export interface WorkflowEvent {
  type:
    | 'stage-list'
    | 'stage-start'
    | 'stage-complete'
    | 'stage-error'
    | 'output'
    | 'stream-chunk'
    | 'tool-call'
    | 'workflow-complete'
    | 'job-info'
    | 'confirm-request'
    | 'confirm-rejected';
  stageKey?: string;
  stageName?: string;
  data?: unknown;
  timestamp: number;
}

export interface JobSummary {
  jobId: string;
  jobRoot: string;
  createdAt: string;
  stageCount: number;
  completedStages: number;
  status: 'running' | 'completed' | 'failed' | 'unknown' | 'incomplete';
}

export interface ModuleManifest {
  version?: string;
  strategy: 'single_block' | 'partitioned';
  module_count: number;
  component_count: number;
  modules: Array<{
    order?: number;
    name: string;
    file: string;
    component_count: number;
  }>;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  root: string;
  jobsDir: string;
  projectsDir: string;
  referencesDir: string;
  createdAt: string;
  lastOpenedAt: string;
}

export type ProjectKind = 'simulation' | 'pcb_schematic' | 'analog_ic' | 'mixed_signal_ic';
export type ModuleDomain = 'analog' | 'digital' | 'mixed_boundary' | 'testbench';
export type EdaBridgePeerKind = 'kicad' | 'jlceda';

export interface PdkBinding {
  schema: 'actoviq.pdk-binding.v1';
  pdk_ref: string;
  version?: string;
  fingerprint?: string;
  model_set?: string;
  default_corner?: string;
  corner_sweep?: string[];
  temperature_c?: number;
  device_mapping?: string;
}

export type AnalogIcProfile = {
  schema: 'actoviq.analog-ic-profile.v1';
  simulator: 'ngspice';
  pdk: {
    name: string;
    model_library: string;
    corner?: string;
    temperature_c?: number;
  };
  sizing?: {
    require_explicit_w_l?: boolean;
    require_scale_suffix?: boolean;
  };
} | {
  schema: 'actoviq.analog-ic-profile.v2';
  simulation_profile_id: string;
  pdk_binding: PdkBinding;
  sizing?: {
    require_explicit_w_l?: boolean;
    require_scale_suffix?: boolean;
  };
};

export type PortDirection = 'input' | 'output' | 'bidirectional';
export type SignalType = 'analog' | 'digital' | 'power' | 'ground';

export interface CircuitPort {
  id: string;
  name: string;
  direction: PortDirection;
  signal_type: SignalType;
  net: string;
  position?: CircuitPosition;
  net_id?: string;
  inferred?: boolean;
  network?: string;
}

export interface CircuitNet {
  id: string;
  name: string;
  kind?: SignalType | 'signal';
  aliases?: string[];
  conflict?: boolean;
}

export interface CircuitPosition {
  x: number;
  y: number;
}

export interface CircuitModuleRef {
  id: string;
  name: string;
  kind: string;
  domain?: ModuleDomain;
  function?: string;
  parameters?: Record<string, string>;
  notes?: string;
  preview_enabled?: boolean;
  source: string;
  position: CircuitPosition;
  size: { width: number; height: number };
  ports: CircuitPort[];
}

export interface CircuitConnection {
  id: string;
  from: { module_id: string; port_id: string };
  to: { module_id: string; port_id: string };
  network?: string;
}

export interface CircuitProjectComposition {
  mode: 'flat' | 'hierarchical';
  top_module_id?: string;
}

export interface CircuitProject {
  schema: 'actoviq.project.v1' | 'actoviq.project.v2';
  project_id: string;
  name: string;
  revision: number;
  created_at: string;
  updated_at: string;
  project_kind?: ProjectKind;
  analog_ic_profile?: AnalogIcProfile;
  hdl_manifest?: string;
  mixed_signal_contract?: string;
  stable_id?: string;
  composition?: CircuitProjectComposition;
  modules: CircuitModuleRef[];
  connections: CircuitConnection[];
  analyses?: Record<string, unknown>;
}

export interface CircuitPin {
  id: string;
  name: string;
  net: string;
  net_id?: string;
  side?: 'left' | 'right' | 'top' | 'bottom';
  order?: number;
  /** Explicitly marks an intentionally unused pin; no implicit wire is generated. */
  no_connect?: boolean;
  /** Optional rail-label anchor offset from the pin (draggable label position). */
  label_offset?: CircuitPosition;
}

export interface CircuitBlockStyle {
  width?: number;
  height?: number;
}

export interface CircuitSpiceSource {
  models?: string[];
  directives?: string[];
  opaque?: string[];
  source?: string;
  generated_testbench?: boolean;
}

export interface CircuitWireEndpoint {
  x: number;
  y: number;
  component_id?: string;
  pin_id?: string;
  port_id?: string;
  /** Stable electrical node for a free wire endpoint or an explicit wire junction. */
  junction_id?: string;
}

export interface CircuitWire {
  id: string;
  points: CircuitPosition[];
  from?: CircuitWireEndpoint;
  to?: CircuitWireEndpoint;
  net?: string;
  net_id?: string;
  source?: 'stored' | 'net';
}

export interface CircuitComponentEda {
  symbol?: string;
  footprint?: string;
  library?: string;
  unit?: number;
  symbol_variant?: number;
  package_id?: string;
  lcsc_id?: string;
  mpn?: string;
  manufacturer?: string;
  datasheet_url?: string;
  jlc_basic?: boolean;
  footprint_hint?: string;
  refdes?: string;
  foreign_symbol?: string;
  [k: string]: unknown;
}

export interface CircuitModuleRefBinding {
  module_id: string;
  revision?: number;
}

export interface CircuitParameterDef {
  id: string;
  default: string;
  unit?: string;
  description?: string;
}

export interface CircuitComponent {
  id: string;
  type: 'R' | 'C' | 'L' | 'D' | 'Q' | 'M' | 'V' | 'I' | 'E' | 'BLOCK' | 'MODULE' | 'U' | 'X' | 'F' | 'G' | 'H' | 'B' | 'GND';
  name: string;
  value: string;
  position: CircuitPosition;
  rotation: number;
  pins: CircuitPin[];
  stable_id?: string;
  eda?: CircuitComponentEda;
  block?: CircuitBlockStyle;
  module_ref?: CircuitModuleRefBinding;
  parameters?: Record<string, string>;
  spice?: { raw?: string; simulated?: boolean };
}

export interface CircuitModule {
  schema: 'actoviq.module.v1' | 'actoviq.module.v2';
  module_id: string;
  name: string;
  revision: number;
  domain?: ModuleDomain;
  nets?: CircuitNet[];
  spice?: CircuitSpiceSource;
  parameter_defs?: CircuitParameterDef[];
  ports: CircuitPort[];
  components: CircuitComponent[];
  wires: CircuitWire[];
  annotations: unknown[];
  schematic_peer?: {
    schema: 'actoviq.schematic-peer-binding.v1';
    peer_kind: 'xschem';
    mode: 'native' | 'bridge' | 'external';
    peer_file?: string;
    base_module_hash?: string;
    base_peer_hash?: string;
    base_connectivity_hash?: string;
  };
}

export interface XschemSyncConflict {
  kind: string;
  field?: string;
  component?: string;
  message: string;
}

export interface XschemSyncResult {
  ok: true;
  revision?: number;
  peer_file?: string;
  connectivity_hash?: string;
  requires_review?: boolean;
  conflicts?: XschemSyncConflict[];
  opaque_record_count?: number;
}

export interface CircuitProjectSummary {
  projectId: string;
  name: string;
  revision: number;
  updatedAt: string;
  projectRoot: string;
  moduleCount: number;
}

export interface CircuitTrashItem extends CircuitProjectSummary {
  trashId: string;
  deletedAt: string;
  originalPath: string;
  trashPath: string;
}

export interface CircuitHistoryEntry {
  revision: number;
  baseRevision: number;
  actor: string;
  message: string;
  createdAt: string;
  documentHash?: string;
  restorable: boolean;
  buildStatus?: string;
  netlistDiff: { added: string[]; removed: string[] };
}

export interface CircuitErcDiagnostic {
  id: string;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  module_id?: string;
  component_id?: string;
  pin_id?: string;
  port_id?: string;
  net_id?: string;
  model?: string;
}

export interface CircuitErcResult {
  schema: 'actoviq.erc.v1';
  source_revision: number;
  document_hash: string;
  status: 'clean' | 'warning' | 'error';
  blocking: boolean;
  summary: { errors: number; warnings: number; infos: number };
  diagnostics: CircuitErcDiagnostic[];
  checked_at: string;
}

export interface SchematicOverrideItem {
  x: number;
  y: number;
  locked?: boolean;
}

export interface SchematicOverrides {
  schema: 'actoviq.schematic-overrides.v1';
  project_id: string;
  module_id: string;
  updated_at?: string;
  items: Record<string, SchematicOverrideItem>;
}

export interface CircuitProjectBundle {
  ok: true;
  project: CircuitProject;
  modules: Record<string, CircuitModule>;
  erc: CircuitErcResult;
  module_previews: Record<string, {
    svg: string;
    svgPath: string;
    netlistPath: string;
    netlist: string;
    notebook: string;
    notebookPath: string;
    builtRevision?: number;
    schematicOverrides?: SchematicOverrides;
  }>;
  project_root: string;
}

export interface CircuitCommandV1 {
  schema: 'actoviq.command.v1';
  command_id: string;
  actor: 'user' | 'claude-code' | 'codex' | string;
  project_id: string;
  base_revision: number;
  message: string;
  operations: Array<Record<string, unknown>>;
}

export interface CircuitCommandV2 {
  schema: 'actoviq.command.v2';
  command_id: string;
  actor: 'user' | 'claude-code' | 'codex' | string;
  project_id: string;
  module_id: string;
  base_revision: number;
  expected_module_revision: number;
  message: string;
  source?: string;
  notebook_markdown?: string;
  operations: unknown[];
}

export type CircuitCommand = CircuitCommandV1 | CircuitCommandV2;

export interface PendingCircuitCommand {
  schema: 'actoviq.pending-command.v1';
  command_id: string;
  project_id: string;
  status: 'pending';
  staged_at: string;
  command: CircuitCommand;
  summary: {
    operation_count: number;
    operations: Array<{ op: string; entities: string[] }>;
    affected_modules: string[];
    affected_entities: string[];
  };
}

export interface CircuitBuildState {
  manifest: {
    schema: string;
    project_id: string;
    revision: number;
    source_revision?: number;
    document_hash?: string;
    built_at: string;
    status: string;
    netlist?: string;
  };
  erc?: CircuitErcResult | null;
  simulation: SimulationRun | null;
  sourceMap?: {
    components?: Record<string, { module_id?: string; component_id?: string }>;
    nodes?: Record<string, { module_id?: string; local_net?: string }>;
  } | null;
  report?: string;
  technicalReport?: Record<string, unknown> | null;
}

export interface TechnicalReportResult {
  ok: true;
  report: string;
  metadata: {
    schema: 'actoviq.technical-report.v1';
    project_id: string;
    source_revision: number;
    document_hash?: string;
    generated_at: string;
    generator: 'actoviq-agent-sdk';
    model: string;
    run_id: string;
    report_sha256: string;
    usage?: Record<string, unknown>;
  };
}

export interface SimulationProbeRequest {
  id: number;
  projectId: string;
  moduleId: string;
  kind: 'voltage' | 'current' | 'power';
  label: string;
  candidates: string[];
  entity?: {
    kind: 'wire' | 'pin' | 'component';
    id: string;
    net?: string;
    netId?: string;
    componentId?: string;
    pinId?: string;
  };
}

export interface SimulationRunMetric {
  name: string;
  value: number | null;
  unit: string;
  pass?: boolean;
  measurement_status?: 'measured' | 'failed';
  specification_status?: 'not_evaluated' | 'passed' | 'failed' | 'missing';
  specification?: { minimum: number | null; maximum: number | null; unit: string };
  source?: string;
}

export interface SimulationAnalysisSummary {
  id: string;
  type:
    | 'op'
    | 'dc'
    | 'ac'
    | 'tran'
    | 'sparameter'
    | 'noise'
    | 'pz'
    | 'fft'
    | 'parameter_sweep'
    | 'monte_carlo'
    | string;
  directive: string;
  status: 'completed' | 'failed' | 'configuration_error' | string;
  execution_status: string;
  measurement_status: string;
  specification_status: string;
  diagnostics?: string[];
  metrics?: SimulationRunMetric[];
  dataset?: {
    path: string;
    id: string;
    plotname: string;
    point_count: number;
    x_name: string;
    x_unit: string;
    traces: Array<{ name: string; unit: string; complex: boolean }>;
  } | null;
}

export interface SimulationRun {
  schema?: string;
  run_id?: string;
  scope?: string;
  source_revision?: number;
  document_hash?: string;
  ok: boolean;
  execution_status?: string;
  measurement_status?: string;
  specification_status?: string;
  verified?: boolean;
  specifications?: Array<{
    metric: string;
    minimum: number | null;
    maximum: number | null;
    unit: string;
    value: number | null;
    status: 'passed' | 'failed' | 'missing';
  }>;
  specification_diagnostics?: string[];
  analysis_count?: number;
  analyses?: SimulationAnalysisSummary[];
  metrics?: SimulationRunMetric[];
  stderr?: string;
  simulated_at?: string;
  provider?: {
    id: string;
    executable?: string;
    version?: string;
  };
  execution_target?: 'local_linux' | 'ssh_linux' | 'container' | 'local_windows' | 'wsl2';
  pdk_fingerprint?: string;
  layout_hash?: string;
  verification?: {
    executed: boolean;
    measured: boolean;
    spec_passed: boolean;
    lvs_clean: boolean | null;
    ams_verified: boolean;
  };
}

export interface CircuitAgentContext {
  ok: true;
  protocol_version: 'actoviq.project-agent.v2';
  project_id: string;
  project_root: string;
  workspace_root: string;
  base_revision: number;
  document_hash: string;
  project: CircuitProject;
  modules: Record<string, CircuitModule>;
  erc: CircuitErcResult;
  build: { state: 'current' | 'stale' | 'missing'; manifest: Record<string, unknown> | null };
  simulation: { state: 'current' | 'stale' | 'missing'; run: SimulationRun | null };
  next_action: 'fix_erc' | 'compile' | 'simulate' | 'evaluate_specifications' | 'ready';
  transaction: {
    schema: 'actoviq.command.v1';
    project_id: string;
    base_revision: number;
    allowed_operations: string[];
  };
}

export interface SimulationDatasetTrace {
  name: string;
  unit: string;
  real: number[];
  imag?: number[];
  magnitude?: number[];
  db?: number[];
  phase_deg?: number[];
}

export interface SimulationDataset {
  schema: string;
  id: string;
  analysis_id: string;
  analysis_type: string;
  plotname: string;
  point_count: number;
  total_point_count?: number;
  x: { name: string; unit: string; values: number[] };
  traces: SimulationDatasetTrace[];
}

export interface DesignMemoryItem {
  id: string;
  kind: 'template' | 'flow';
  name: string;
  rootPath: string;
  relativePath: string;
  sourceProjectId?: string;
  sourceRevision?: number;
  sourceDocumentHash?: string;
  createdAt?: string;
  circuitFamilies?: string[];
  validationStatus?: string;
  preferredForAgentReuse?: boolean;
  simulationCoverage?: string[];
  guidePath?: string;
  templatePath?: string;
  flowPath?: string;
}

export interface SavedDesignMemorySummary extends DesignMemoryItem {
  ok: true;
}

export type EdaExportTarget = 'kicad' | 'altium' | 'orcad' | 'virtuoso';

export interface BridgeManifest {
  peer_kind: EdaBridgePeerKind;
  peer_root: string;
  linked_at?: string;
  policy?: string;
  source_revision?: number;
  [k: string]: unknown;
}

export interface BridgeConflict {
  field?: string;
  local?: unknown;
  remote?: unknown;
  message?: string;
  [k: string]: unknown;
}

export interface BridgeListResult {
  ok: true;
  bridges: BridgeManifest[];
  [k: string]: unknown;
}

export interface BridgeStatusResult {
  ok: true;
  bridges?: BridgeManifest[];
  bridge?: BridgeManifest | null;
  conflicts?: BridgeConflict[];
  [k: string]: unknown;
}

export interface BridgePullResult extends BridgeStatusResult {
  changed?: boolean;
}

export interface LcscPart {
  lcsc_id: string;
  mpn?: string;
  manufacturer?: string;
  description?: string;
  datasheet_url?: string;
  jlc_basic?: boolean;
  footprint_hint?: string;
  [k: string]: unknown;
}

export interface LcscSearchResult {
  ok: true;
  parts: LcscPart[];
  [k: string]: unknown;
}

export interface LcscPartResult {
  ok: true;
  part: LcscPart;
  [k: string]: unknown;
}

export interface LcscBindResult {
  ok: true;
  module_id: string;
  component_id: string;
  lcsc_id: string;
  [k: string]: unknown;
}

export interface EdaColdStartImportResult {
  ok: true;
  project: CircuitProject;
  project_root: string;
  [k: string]: unknown;
}

export interface LayoutOptimizationRequest {
  moduleId: string;
  sourceRevision: number;
}

export interface LayoutOptimizationQuality {
  readability_score: number;
  lexicographic_cost: number[];
}

export interface LayoutOptimizationRound {
  round: number;
  improved: boolean;
  before_score: number;
  after_score: number;
  preview_path?: string;
  report_path?: string;
}

export interface LayoutOptimizationResult {
  ok: true;
  module_id: string;
  source_revision: number;
  revision: number;
  changed: boolean;
  model: string;
  llm_invoked: boolean;
  connectivity_hash: string;
  initial_quality: LayoutOptimizationQuality;
  final_quality: LayoutOptimizationQuality;
  visible_quality: LayoutOptimizationQuality;
  visible_quality_unresolved: boolean;
  visible_connectivity_hash: string;
  rounds: LayoutOptimizationRound[];
  stopped_reason: 'score_threshold' | 'no_improvement' | 'round_limit' | 'deterministic_only';
  preview_path?: string;
  report_path?: string;
  compile_warning?: string;
}

export interface EdaExportRequest {
  scope: 'project' | 'module';
  moduleId?: string;
  targets: EdaExportTarget[];
  view: 'design' | 'simulation';
  mappingFile?: string;
  nativeConvert: 'auto' | 'never' | 'required';
  strictLayout: boolean;
  sourceRevision: number;
  /** Optional parent directory. Export is written to <outputDir>/<export_id>/. */
  outputDir?: string;
}

export interface EdaExportResult {
  ok: true;
  export_id: string;
  export_root: string;
  layout_quality: {
    readability_score: number;
    lexicographic_cost: number[];
  };
  targets: Partial<Record<EdaExportTarget, {
    status: 'native' | 'import_ready' | 'warning' | 'failed';
    connectivity_hash: string;
    files: string[];
  }>>;
}

export interface ReferenceDocument {
  name: string;
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  updatedAt: string;
  ocrTextPath?: string;
}

export type ActoviqProvider = 'anthropic' | 'openai';
export type ActoviqProviderPreset = 'anthropic' | 'deepseek' | 'openai-compatible';
export type SecretStorageMode = 'encrypted' | 'plaintext-fallback' | 'environment' | 'none';
export type ChatModelTier = 'basic' | 'medium' | 'professional';
export type LayoutVisionVerificationStatus = 'unverified' | 'verified' | 'error';

export interface LayoutVisionVerification {
  status: LayoutVisionVerificationStatus;
  fingerprint: string;
  verifiedAt?: string;
  error?: string;
}

export interface AppSettings {
  actoviqProvider: ActoviqProvider;
  actoviqProviderPreset: ActoviqProviderPreset;
  actoviqBaseUrl: string;
  /** New API key input only; saved values are never returned to the renderer. */
  actoviqAuthToken: string;
  hasActoviqAuthToken: boolean;
  maskedActoviqAuthToken: string;
  clearActoviqAuthToken?: boolean;
  actoviqAuthTokenStorage: SecretStorageMode;
  basicModel: string;
  mediumModel: string;
  professionalModel: string;
  basicContext1M: boolean;
  mediumContext1M: boolean;
  professionalContext1M: boolean;
  preferredChatTier: ChatModelTier;
  /** Dedicated model; layout runs remain disabled until image capability is verified. */
  layoutVisionModel: string;
  layoutVisionVerification: LayoutVisionVerification;
  /** Synced aliases: chat/sonnet = medium, reasoning/opus = professional, haiku = basic. */
  chatModel: string;
  reasoningModel: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  ngspiceBin: string;
  workspaceRoot: string;
  /** Empty = app data `userData/pdks`. Users configure their own path. */
  pdkInstallRoot: string;
  yunzhishengOcrBaseUrl: string;
  yunzhishengOcrApiKey: string;
  yunzhishengOcrModel: string;
  /** LCSC Open API credentials — MVP stores plaintext in desktop settings file. */
  lcscApiKey: string;
  lcscApiSecret: string;
  lcscUseFallback: boolean;
}

export interface IcToolDiagnostic {
  id: string;
  label: string;
  domain: 'schematic' | 'simulation' | 'physical' | 'hdl' | 'commercial' | 'runtime';
  executable: string;
  available: boolean;
  version?: string;
  qualification: 'open_source' | 'configured' | 'unverified';
  diagnostic?: string;
}

export interface IcDiagnostics {
  schema: 'actoviq.ic-diagnostics.v1';
  platform: string;
  tools: IcToolDiagnostic[];
  pdkRegistry: {
    ok?: boolean;
    installations?: Array<Record<string, unknown>>;
    error?: string;
  };
  features: {
    schematicBridge: boolean;
    openSimulation: boolean;
    physicalVerification: boolean;
    hdlFlow: boolean;
    licensedEda: boolean;
  };
  generatedAt: string;
}

export type LicensedProviderId =
  | 'ngspice'
  | 'xyce'
  | 'cadence_spectre'
  | 'synopsys_primesim_hspice'
  | 'synopsys_primesim_xa'
  | 'siemens_afs'
  | 'cadence_xcelium_ams'
  | 'synopsys_vcs_ams'
  | 'siemens_questa_ams';

export interface StoredExecutionProfile {
  schema: 'actoviq.execution-profile.v1';
  id: string;
  providerId: LicensedProviderId;
  target: 'local_linux' | 'local_windows' | 'ssh_linux';
  executable?: string;
  allowedRoots: string[];
  environmentKeys: string[];
  ssh?: {
    host: string;
    executable?: string;
    scpExecutable?: string;
    remoteWorkingDirectory: string;
  };
  qualification: 'configured' | 'unverified' | 'native_verified';
}

export interface ExecutionProfileRegistry {
  schema: 'actoviq.execution-profile-registry.v1';
  profiles: StoredExecutionProfile[];
}

export interface ExecutionProfileProbe {
  providerId: string;
  available: boolean;
  executable: string;
  version?: string;
  target: StoredExecutionProfile['target'];
  diagnostics: string[];
}

export interface HdlVerificationRun {
  schema: 'actoviq.verification-run.v1';
  run_id: string;
  kind: string;
  provider_id: string;
  executed: boolean;
  status: 'passed' | 'failed' | 'cancelled';
  diagnostics: string[];
  artifacts: Array<{ kind: string; path: string; hash?: string }>;
  metadata: Record<string, unknown>;
  finished_at?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  provider: ActoviqProvider;
  model: string;
  latencyMs: number;
  error?: string;
}

export interface LayoutModelTestResult extends ProviderTestResult {
  status: 'verified' | 'error';
  fingerprint: string;
  verifiedAt?: string;
}

export interface CircuitSkillStatus {
  sourcePath: string;
  sourceVersion: string;
  protocolVersion: string;
  current: boolean;
  targets: Array<{
    agent: 'codex' | 'claude';
    path: string;
    effectivePath: string;
    status: 'current' | 'outdated' | 'missing';
    installedVersion?: string;
  }>;
}
