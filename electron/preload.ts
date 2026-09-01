import { contextBridge, ipcRenderer } from 'electron';

export interface WorkflowParams {
  requirement?: string;
  approvalPolicy: 'manual' | 'execution' | 'all';
  jobName?: string;
  configPath?: string;
  revisionBaseJob?: string;
  resumeJob?: string;
  jobParentDir?: string;
  rerunFromStage?: string;
}

export type MenuAction =
  | 'new-design'
  | 'open-settings'
  | 'start-workflow'
  | 'pause-workflow'
  | 'resume-workflow'
  | 'validate-netlist'
  | 'run-simulation'
  | 'render-schematic';

export interface WorkflowEvent {
  type: 'stage-list' | 'stage-start' | 'stage-complete' | 'stage-error' | 'output' | 'stream-chunk' | 'tool-call' | 'workflow-complete' | 'job-info' | 'confirm-request' | 'confirm-rejected';
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

export interface AppSettings {
  actoviqProvider: ActoviqProvider;
  actoviqProviderPreset: ActoviqProviderPreset;
  actoviqBaseUrl: string;
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
  layoutVisionModel: string;
  layoutVisionVerification: LayoutVisionVerification;
  chatModel: string;
  reasoningModel: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  ngspiceBin: string;
  workspaceRoot: string;
  /** Empty = app data `userData/pdks`. */
  pdkInstallRoot: string;
  yunzhishengOcrBaseUrl: string;
  yunzhishengOcrApiKey: string;
  yunzhishengOcrModel: string;
  lcscApiKey: string;
  lcscApiSecret: string;
  lcscUseFallback: boolean;
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

export interface DesktopAgentEvent {
  type:
    | 'run-started'
    | 'status'
    | 'text-progress'
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
}

const electronAPI = {
  isE2E(): boolean {
    return process.env.ACTOVIQ_E2E === '1';
  },

  startWorkflow(params: WorkflowParams): void {
    ipcRenderer.send('workflow:start', params);
  },

  pauseWorkflow(): void {
    ipcRenderer.send('workflow:pause');
  },

  resumeWorkflow(): void {
    ipcRenderer.send('workflow:resume');
  },

  stopWorkflow(): void {
    ipcRenderer.send('workflow:stop');
  },

  retryStage(): void {
    ipcRenderer.send('workflow:retry-stage');
  },

  sendConfirmResponse(answer: 'y' | 'n'): void {
    ipcRenderer.send('workflow:confirm-response', answer);
  },

  onMenuAction(callback: (action: MenuAction) => void): () => void {
    const channels: Record<string, MenuAction> = {
      'menu:new-design': 'new-design',
      'menu:open-settings': 'open-settings',
      'menu:start-workflow': 'start-workflow',
      'menu:pause-workflow': 'pause-workflow',
      'menu:resume-workflow': 'resume-workflow',
      'menu:validate-netlist': 'validate-netlist',
      'menu:run-simulation': 'run-simulation',
      'menu:render-schematic': 'render-schematic',
    };
    const removers = Object.entries(channels).map(([channel, action]) => {
      const handler = (): void => callback(action);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    });
    return () => {
      removers.forEach((remove) => remove());
    };
  },

  onWorkflowEvent(callback: (event: WorkflowEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: WorkflowEvent): void => {
      callback(data);
    };
    ipcRenderer.on('workflow:event', handler);
    return () => {
      ipcRenderer.removeListener('workflow:event', handler);
    };
  },

  readJobFile(jobId: string, relativePath: string): Promise<string> {
    return ipcRenderer.invoke('file:read', { jobId, relativePath });
  },

  writeJobFile(jobId: string, relativePath: string, content: string): Promise<void> {
    return ipcRenderer.invoke('file:write', { jobId, relativePath, content });
  },

  listJobs(): Promise<JobSummary[]> {
    return ipcRenderer.invoke('file:list-jobs');
  },

  openJobFolder(jobId: string): void {
    ipcRenderer.send('file:open-folder', { jobId });
  },

  exportJob(jobId: string): Promise<string> {
    return ipcRenderer.invoke('file:export', { jobId });
  },

  listWorkspaces(): Promise<WorkspaceSummary[]> {
    return ipcRenderer.invoke('workspace:list');
  },

  getActiveWorkspace(): Promise<WorkspaceSummary> {
    return ipcRenderer.invoke('workspace:active');
  },

  createWorkspace(input: { name?: string; root?: string }): Promise<WorkspaceSummary> {
    return ipcRenderer.invoke('workspace:create', input);
  },

  selectWorkspace(id: string): Promise<WorkspaceSummary> {
    return ipcRenderer.invoke('workspace:select', id);
  },

  chooseWorkspaceRoot(): Promise<string | null> {
    return ipcRenderer.invoke('workspace:choose-root');
  },

  openWorkspaceRoot(): Promise<string> {
    return ipcRenderer.invoke('workspace:open-root');
  },

  openWorkspaceReferences(): Promise<string> {
    return ipcRenderer.invoke('workspace:open-references');
  },

  listReferenceDocuments(): Promise<ReferenceDocument[]> {
    return ipcRenderer.invoke('workspace:list-references');
  },

  runReferenceOcr(relativePath: string): Promise<{ textPath: string; text: string }> {
    return ipcRenderer.invoke('workspace:ocr-reference', relativePath);
  },

  listCircuitProjects(): Promise<unknown[]> {
    return ipcRenderer.invoke('project:list');
  },

  trashCircuitProjects(projectIds: string[]): Promise<unknown[]> {
    return ipcRenderer.invoke('project:trash', projectIds);
  },

  listCircuitTrash(): Promise<unknown[]> {
    return ipcRenderer.invoke('project:list-trash');
  },

  restoreCircuitProjects(trashIds: string[]): Promise<unknown[]> {
    return ipcRenderer.invoke('project:restore-trash', trashIds);
  },

  purgeCircuitProjects(trashIds: string[]): Promise<void> {
    return ipcRenderer.invoke('project:purge-trash', trashIds);
  },

  listCircuitProjectHistory(projectId: string): Promise<unknown[]> {
    return ipcRenderer.invoke('project:list-history', projectId);
  },

  restoreCircuitProjectRevision(projectId: string, revision: number, baseRevision: number): Promise<unknown> {
    return ipcRenderer.invoke('project:restore-revision', projectId, revision, baseRevision);
  },

  createCircuitProject(input: { name: string; demo?: boolean; projectKind?: string }): Promise<unknown> {
    return ipcRenderer.invoke('project:create', input);
  },

  createCircuitProjectFromTemplate(input: { templateId: string; name?: string }): Promise<unknown> {
    return ipcRenderer.invoke('project:create-from-template', input);
  },

  getCircuitProject(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:get', projectId);
  },

  listHdlFiles(projectId: string): Promise<string[]> {
    return ipcRenderer.invoke('project:list-hdl-files', projectId);
  },

  readHdlFile(projectId: string, relativePath: string): Promise<string> {
    return ipcRenderer.invoke('project:read-hdl-file', projectId, relativePath);
  },

  writeHdlFile(projectId: string, relativePath: string, content: string): Promise<unknown> {
    return ipcRenderer.invoke('project:write-hdl-file', projectId, relativePath, content);
  },

  initializeHdlWorkspace(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:initialize-hdl', projectId);
  },

  createHdlFile(projectId: string, relativePath: string): Promise<unknown> {
    return ipcRenderer.invoke('project:create-hdl-file', projectId, relativePath);
  },

  runHdlAction(projectId: string, action: 'simulate' | 'synthesize' | 'gate-regression' | 'openroad' | 'mixed-contract'): Promise<unknown> {
    return ipcRenderer.invoke('project:run-hdl', projectId, action);
  },

  applyCircuitCommand(projectId: string, command: unknown): Promise<unknown> {
    return ipcRenderer.invoke('project:apply-command', projectId, command);
  },

  stageCircuitCommand(projectId: string, command: unknown): Promise<unknown> {
    return ipcRenderer.invoke('project:stage-command', projectId, command);
  },

  listPendingCircuitCommands(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:list-pending-commands', projectId);
  },

  acceptPendingCircuitCommand(projectId: string, commandId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:accept-pending-command', projectId, commandId);
  },

  rejectPendingCircuitCommand(projectId: string, commandId: string, reason?: string): Promise<unknown> {
    return ipcRenderer.invoke('project:reject-pending-command', projectId, commandId, reason);
  },

  runCircuitErc(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:run-erc', projectId);
  },

  getCircuitAgentContext(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:agent-context', projectId);
  },

  compileCircuitProject(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:compile', projectId);
  },

  optimizeCircuitLayout(projectId: string, input: {
    moduleId: string;
    sourceRevision: number;
  }): Promise<unknown> {
    return ipcRenderer.invoke('project:optimize-layout', projectId, input);
  },

  exportCircuitEda(projectId: string, input: {
    scope: 'project' | 'module';
    moduleId?: string;
    targets: Array<'kicad' | 'altium' | 'orcad' | 'virtuoso'>;
    view: 'design' | 'simulation';
    mappingFile?: string;
    nativeConvert: 'auto' | 'never' | 'required';
    strictLayout: boolean;
    sourceRevision: number;
    outputDir?: string;
  }): Promise<unknown> {
    return ipcRenderer.invoke('project:export-eda', projectId, input);
  },

  chooseCircuitEdaMapping(): Promise<string | null> {
    return ipcRenderer.invoke('project:choose-eda-mapping');
  },

  chooseCircuitEdaOutputDir(): Promise<string | null> {
    return ipcRenderer.invoke('project:choose-eda-output-dir');
  },

  choosePdkRoot(): Promise<string | null> {
    return ipcRenderer.invoke('pdk:choose-root');
  },

  choosePdkMappingPack(): Promise<string | null> {
    return ipcRenderer.invoke('pdk:choose-mapping-pack');
  },

  choosePdkInstallDestination(): Promise<string | null> {
    return ipcRenderer.invoke('pdk:choose-install-destination');
  },

  listPdkInstallations(): Promise<unknown> {
    return ipcRenderer.invoke('pdk:list');
  },

  listOpenPdkCatalog(): Promise<unknown> {
    return ipcRenderer.invoke('pdk:open-catalog');
  },

  getOpenPdkLocalStatus(): Promise<unknown> {
    return ipcRenderer.invoke('pdk:local-status');
  },

  getDefaultPdkRoot(): Promise<string> {
    return ipcRenderer.invoke('pdk:default-root');
  },

  choosePdkInstallRoot(): Promise<string | null> {
    return ipcRenderer.invoke('pdk:choose-install-root');
  },

  openPdkExternalUrl(url: string): Promise<unknown> {
    return ipcRenderer.invoke('pdk:open-external', url);
  },

  installOpenPdk(input: {
    adapter: 'ihp-sg13g2' | 'sky130' | 'gf180mcu';
    destination: string;
    revision?: string;
    licenseAccepted: boolean;
  }): Promise<unknown> {
    return ipcRenderer.invoke('pdk:install-open', input);
  },

  installOpenPdkDefault(input: {
    adapter: 'ihp-sg13g2' | 'sky130' | 'gf180mcu';
    licenseAccepted: boolean;
    register?: boolean;
  }): Promise<unknown> {
    return ipcRenderer.invoke('pdk:install-open-default', input);
  },

  scanPdkInstallation(input: {
    root: string;
    adapter: 'ihp-sg13g2' | 'sky130' | 'gf180mcu' | 'commercial';
    version?: string;
    revision?: string;
    mappingFile?: string;
  }): Promise<unknown> {
    return ipcRenderer.invoke('pdk:scan', input);
  },

  registerPdkInstallation(input: {
    root: string;
    adapter: 'ihp-sg13g2' | 'sky130' | 'gf180mcu' | 'commercial';
    version?: string;
    revision?: string;
    mappingFile?: string;
    licenseAccepted: boolean;
  }): Promise<unknown> {
    return ipcRenderer.invoke('pdk:register', input);
  },

  chooseXschemPeerFile(mode: 'bridge' | 'external'): Promise<string | null> {
    return ipcRenderer.invoke('project:choose-xschem-peer', mode);
  },

  linkXschemPeer(projectId: string, input: {
    moduleId: string;
    mode: 'native' | 'bridge' | 'external';
    peerFile?: string;
  }): Promise<unknown> {
    return ipcRenderer.invoke('project:xschem-link', projectId, input);
  },

  pushXschemPeer(projectId: string, moduleId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:xschem-push', projectId, moduleId);
  },

  pullXschemPeer(projectId: string, moduleId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:xschem-pull', projectId, moduleId);
  },

  takeXschemOwnership(projectId: string, moduleId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:xschem-take-ownership', projectId, moduleId);
  },

  validateXschemPeer(projectId: string, moduleId: string, peerFile: string): Promise<unknown> {
    return ipcRenderer.invoke('project:xschem-validate', projectId, moduleId, peerFile);
  },

  chooseEdaBridgePeerRoot(): Promise<string | null> {
    return ipcRenderer.invoke('project:choose-bridge-peer-root');
  },

  listEdaBridges(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:bridge-list', projectId);
  },

  edaBridgeStatus(projectId: string, peerKind?: string): Promise<unknown> {
    return ipcRenderer.invoke('project:bridge-status', projectId, peerKind);
  },

  linkEdaBridge(projectId: string, input: {
    peerKind: 'kicad' | 'jlceda';
    peerRoot: string;
    policy?: string;
  }): Promise<unknown> {
    return ipcRenderer.invoke('project:bridge-link', projectId, input);
  },

  unlinkEdaBridge(projectId: string, peerKind: 'kicad' | 'jlceda'): Promise<unknown> {
    return ipcRenderer.invoke('project:bridge-unlink', projectId, peerKind);
  },

  pushEdaBridge(projectId: string, peerKind: 'kicad' | 'jlceda'): Promise<unknown> {
    return ipcRenderer.invoke('project:bridge-push', projectId, peerKind);
  },

  pullEdaBridge(projectId: string, peerKind: 'kicad' | 'jlceda', policy?: string): Promise<unknown> {
    return ipcRenderer.invoke('project:bridge-pull', projectId, peerKind, policy);
  },

  importEdaColdStart(input: {
    peerKind: 'kicad' | 'jlceda';
    peerRoot: string;
    name?: string;
    projectKind?: string;
  }): Promise<unknown> {
    return ipcRenderer.invoke('project:bridge-import-cold', input);
  },

  exportSchematicHandoff(projectId: string, input: {
    format: string;
    outputPath: string;
    moduleId?: string;
    sourceRevision: number;
  }): Promise<unknown> {
    return ipcRenderer.invoke('project:schematic-export', projectId, input);
  },

  importSchematicHandoff(projectId: string, input: {
    format: string;
    sourcePath: string;
    moduleId: string;
  }): Promise<unknown> {
    return ipcRenderer.invoke('project:schematic-import', projectId, input);
  },

  chooseSchematicImportSource(format: string): Promise<string | null> {
    return ipcRenderer.invoke('project:choose-schematic-import-source', format);
  },

  chooseSchematicExportPath(format: string): Promise<string | null> {
    return ipcRenderer.invoke('project:choose-schematic-export-path', format);
  },

  searchLcscParts(query: string, opts?: { limit?: number; useFallback?: boolean }): Promise<unknown> {
    return ipcRenderer.invoke('project:lcsc-search', query, opts);
  },

  getLcscPart(lcscId: string, opts?: { useFallback?: boolean }): Promise<unknown> {
    return ipcRenderer.invoke('project:lcsc-get', lcscId, opts);
  },

  bindLcscPart(
    projectId: string,
    moduleId: string,
    componentId: string,
    lcscId: string,
    opts?: { useFallback?: boolean },
  ): Promise<unknown> {
    return ipcRenderer.invoke('project:lcsc-bind', projectId, moduleId, componentId, lcscId, opts);
  },

  simulateCircuitProject(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:simulate', projectId);
  },

  generateCircuitTechnicalReport(projectId: string, sourceRevision: number): Promise<unknown> {
    return ipcRenderer.invoke('project:generate-technical-report', projectId, sourceRevision);
  },

  compileCircuitModule(projectId: string, moduleId: string, schematicDocument?: unknown): Promise<unknown> {
    return ipcRenderer.invoke('project:compile-module', projectId, moduleId, schematicDocument);
  },

  saveCircuitModuleNotebook(projectId: string, moduleId: string, markdown: string, baseRevision?: number): Promise<unknown> {
    return ipcRenderer.invoke('project:save-module-notebook', projectId, moduleId, markdown, baseRevision);
  },

  simulateCircuitModule(projectId: string, moduleId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:simulate-module', projectId, moduleId);
  },

  simulateCircuitDual(projectId: string, input: {
    leftProfileId: string;
    rightProfileId: string;
    relativeTolerance: number;
    absoluteTolerance: number;
  }): Promise<unknown> {
    return ipcRenderer.invoke('project:simulate-dual', projectId, input);
  },

  choosePhysicalVerificationFile(label: string): Promise<string | null> {
    return ipcRenderer.invoke('project:choose-physical-file', label);
  },

  openPhysicalArtifact(projectId: string, artifactPath: string): Promise<string> {
    return ipcRenderer.invoke('project:open-physical-artifact', projectId, artifactPath);
  },

  runPhysicalVerification(projectId: string, input: Record<string, unknown>): Promise<unknown> {
    return ipcRenderer.invoke('project:run-physical-verification', projectId, input);
  },

  chooseLicensedEdaInput(): Promise<string | null> {
    return ipcRenderer.invoke('project:choose-licensed-eda-input');
  },

  runLicensedEda(projectId: string, input: {
    profileId: string;
    inputPath: string;
    kind: string;
    top?: string;
    measurementCsv?: string;
  }): Promise<unknown> {
    return ipcRenderer.invoke('project:run-licensed-eda', projectId, input);
  },

  readCircuitBuild(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:read-build', projectId);
  },

  readCircuitSimulationDataset(projectId: string, input: {
    runId: string;
    analysisId: string;
    moduleId?: string;
    maxPoints?: number;
    xMin?: number;
    xMax?: number;
  }): Promise<unknown> {
    return ipcRenderer.invoke('project:read-simulation-dataset', projectId, input);
  },

  saveCircuitDesignTemplate(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:save-design-template', projectId);
  },

  saveCircuitDesignFlow(projectId: string): Promise<unknown> {
    return ipcRenderer.invoke('project:save-design-flow', projectId);
  },

  listReferenceCatalog(): Promise<unknown> {
    return ipcRenderer.invoke('reference:list-catalog');
  },

  importCircuitReference(): Promise<unknown> {
    return ipcRenderer.invoke('reference:import-circuit');
  },

  importVisualReference(): Promise<unknown> {
    return ipcRenderer.invoke('reference:import-visual');
  },

  createProjectFromReference(input: { assetId: string; name?: string; projectKind?: string }): Promise<unknown> {
    return ipcRenderer.invoke('reference:create-project-from', input);
  },

  insertModuleFromReference(input: { projectId: string; assetId: string; moduleId?: string }): Promise<unknown> {
    return ipcRenderer.invoke('reference:insert-module', input);
  },

  applyLayoutReference(input: { projectId: string; moduleId: string; assetId: string }): Promise<unknown> {
    return ipcRenderer.invoke('reference:apply-layout', input);
  },

  prepareLayoutReference(input: { projectId: string; moduleId: string; assetId: string }): Promise<unknown> {
    return ipcRenderer.invoke('reference:prepare-layout', input);
  },

  promoteVisualReferenceFromModule(input: {
    projectId: string;
    moduleId: string;
    assetId: string;
    name?: string;
  }): Promise<unknown> {
    return ipcRenderer.invoke('reference:promote-visual-from-module', input);
  },

  attachReferenceToChat(input: { assetId: string }): Promise<unknown> {
    return ipcRenderer.invoke('reference:attach-to-chat', input);
  },

  listCircuitDesignMemory(): Promise<unknown> {
    return ipcRenderer.invoke('project:list-design-memory');
  },

  openCircuitDesignMemory(input: { kind: 'template' | 'flow'; id: string }): Promise<string> {
    return ipcRenderer.invoke('project:open-design-memory', input);
  },

  watchCircuitProject(projectId: string): Promise<void> {
    return ipcRenderer.invoke('project:watch', projectId);
  },

  onCircuitProjectChanged(callback: (event: { projectId: string; timestamp: number }) => void): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { projectId: string; timestamp: number },
    ): void => callback(data);
    ipcRenderer.on('project:changed', handler);
    return () => ipcRenderer.removeListener('project:changed', handler);
  },

  onCircuitProjectListChanged(callback: (event: { timestamp: number }) => void): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { timestamp: number },
    ): void => callback(data);
    ipcRenderer.on('project:list-changed', handler);
    return () => ipcRenderer.removeListener('project:list-changed', handler);
  },

  openCircuitProjectFolder(projectId: string): Promise<string> {
    return ipcRenderer.invoke('project:open-folder', projectId);
  },

  openCircuitEdaExportFolder(projectId: string, exportId: string, exportRoot?: string): Promise<string> {
    return ipcRenderer.invoke('project:open-export-folder', projectId, exportId, exportRoot);
  },

  getSettings(): Promise<AppSettings> {
    return ipcRenderer.invoke('settings:get');
  },

  revealActoviqAuthToken(): Promise<string | null> {
    return ipcRenderer.invoke('settings:reveal-actoviq-auth-token');
  },

  saveSettings(settings: AppSettings): Promise<AppSettings> {
    return ipcRenderer.invoke('settings:save', settings);
  },

  testProviderSettings(settings: AppSettings): Promise<ProviderTestResult> {
    return ipcRenderer.invoke('settings:test-provider', settings);
  },

  testLayoutModelSettings(settings: AppSettings): Promise<LayoutModelTestResult> {
    return ipcRenderer.invoke('settings:test-layout-model', settings);
  },

  getIcDiagnostics(): Promise<unknown> {
    return ipcRenderer.invoke('settings:ic-diagnostics');
  },

  listExecutionProfiles(): Promise<ExecutionProfileRegistry> {
    return ipcRenderer.invoke('settings:list-execution-profiles');
  },

  saveExecutionProfile(profile: StoredExecutionProfile): Promise<ExecutionProfileRegistry> {
    return ipcRenderer.invoke('settings:save-execution-profile', profile);
  },

  deleteExecutionProfile(id: string): Promise<ExecutionProfileRegistry> {
    return ipcRenderer.invoke('settings:delete-execution-profile', id);
  },

  probeExecutionProfile(id: string): Promise<unknown> {
    return ipcRenderer.invoke('settings:probe-execution-profile', id);
  },

  getAppVersion(): Promise<string> {
    return ipcRenderer.invoke('app:version');
  },

  getCircuitSkillStatus(): Promise<unknown> {
    return ipcRenderer.invoke('skill:circuit-status');
  },

  syncCircuitSkill(): Promise<unknown> {
    return ipcRenderer.invoke('skill:circuit-sync');
  },

  sendChatMessage(
    message: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
    context?: {
      conversationId?: string;
      activeJobId?: string | null;
      activeProjectId?: string | null;
      activeProject?: Record<string, unknown> | null;
      workspaceRoot?: string;
      modelTier?: ChatModelTier;
      approvalPolicy?: 'manual' | 'execution' | 'all';
    },
  ): Promise<ChatResponse> {
    return ipcRenderer.invoke('chat:send', message, history, context);
  },

  stopChat(conversationId?: string): Promise<boolean> {
    return ipcRenderer.invoke('chat:stop', conversationId);
  },

  onChatEvent(callback: (event: DesktopAgentEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: DesktopAgentEvent): void => callback(data);
    ipcRenderer.on('chat:event', handler);
    return () => ipcRenderer.removeListener('chat:event', handler);
  },
};

export interface ChatResponse {
  text: string;
  isDesignRequest: boolean;
  formalizedRequirement?: string;
  isRevisionRequest?: boolean;
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
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export type ElectronAPI = typeof electronAPI;
