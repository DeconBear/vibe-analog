import type {
  AppSettings,
  BridgeListResult,
  BridgePullResult,
  BridgeStatusResult,
  ChatModelTier,
  EdaColdStartImportResult,
  LayoutModelTestResult,
  IcDiagnostics,
  HdlVerificationRun,
  LcscBindResult,
  LcscPartResult,
  LcscSearchResult,
  ProjectKind,
  ProviderTestResult,
  DesktopAgentEvent,
  ChatResponse,
  JobSummary,
  ReferenceDocument,
  CircuitBuildState,
  CircuitAgentContext,
  CircuitCommand,
  CircuitErcResult,
  CircuitHistoryEntry,
  CircuitProjectBundle,
  CircuitProjectSummary,
  CircuitTrashItem,
  CircuitSkillStatus,
  DesignMemoryItem,
  EdaBridgePeerKind,
  EdaExportRequest,
  EdaExportResult,
  ExecutionProfileProbe,
  ExecutionProfileRegistry,
  LayoutOptimizationRequest,
  LayoutOptimizationResult,
  PendingCircuitCommand,
  SavedDesignMemorySummary,
  SimulationDataset,
  SimulationRun,
  StoredExecutionProfile,
  TechnicalReportResult,
  WorkflowEvent,
  WorkspaceSummary,
  XschemSyncResult,
} from './types';
import type { SerializableSchematicDocument } from './schematic/schematicDocument';
import type { SymbolIrBundle } from './schematic/symbolIr';

export {};

declare global {
  interface Window {
    electronAPI: {
      isE2E(): boolean;
      startWorkflow(params: {
        requirement?: string;
        approvalPolicy: 'manual' | 'execution' | 'all';
        jobName?: string;
        configPath?: string;
        revisionBaseJob?: string;
        resumeJob?: string;
        jobParentDir?: string;
        rerunFromStage?: string;
      }): void;
      pauseWorkflow(): void;
      resumeWorkflow(): void;
      stopWorkflow(): void;
      retryStage(): void;
      sendConfirmResponse(answer: 'y' | 'n'): void;
      onMenuAction(callback: (action:
        | 'new-design'
        | 'open-settings'
        | 'start-workflow'
        | 'pause-workflow'
        | 'resume-workflow'
        | 'validate-netlist'
        | 'run-simulation'
        | 'render-schematic'
      ) => void): () => void;
      onWorkflowEvent(callback: (event: WorkflowEvent) => void): () => void;
      readJobFile(jobId: string, relativePath: string): Promise<string>;
      writeJobFile(jobId: string, relativePath: string, content: string): Promise<void>;
      listJobs(): Promise<JobSummary[]>;
      openJobFolder(jobId: string): void;
      exportJob(jobId: string): Promise<string>;
      listWorkspaces(): Promise<WorkspaceSummary[]>;
      getActiveWorkspace(): Promise<WorkspaceSummary>;
      createWorkspace(input: { name?: string; root?: string }): Promise<WorkspaceSummary>;
      selectWorkspace(id: string): Promise<WorkspaceSummary>;
      chooseWorkspaceRoot(): Promise<string | null>;
      openWorkspaceRoot(): Promise<string>;
      openWorkspaceReferences(): Promise<string>;
      listReferenceDocuments(): Promise<ReferenceDocument[]>;
      runReferenceOcr(relativePath: string): Promise<{ textPath: string; text: string }>;
      listReferenceCatalog(): Promise<{ ok: boolean; assets: Array<Record<string, unknown>>; count: number }>;
      importCircuitReference(): Promise<Record<string, unknown>>;
      importVisualReference(): Promise<Record<string, unknown>>;
      createProjectFromReference(input: { assetId: string; name?: string; projectKind?: string }): Promise<Record<string, unknown>>;
      insertModuleFromReference(input: { projectId: string; assetId: string; moduleId?: string }): Promise<Record<string, unknown>>;
      applyLayoutReference(input: { projectId: string; moduleId: string; assetId: string }): Promise<Record<string, unknown>>;
      prepareLayoutReference(input: { projectId: string; moduleId: string; assetId: string }): Promise<Record<string, unknown>>;
      promoteVisualReferenceFromModule(input: {
        projectId: string;
        moduleId: string;
        assetId: string;
        name?: string;
      }): Promise<Record<string, unknown>>;
      attachReferenceToChat(input: { assetId: string }): Promise<Record<string, unknown>>;
      listCircuitProjects(): Promise<CircuitProjectSummary[]>;
      trashCircuitProjects(projectIds: string[]): Promise<CircuitTrashItem[]>;
      listCircuitTrash(): Promise<CircuitTrashItem[]>;
      restoreCircuitProjects(trashIds: string[]): Promise<CircuitProjectSummary[]>;
      purgeCircuitProjects(trashIds: string[]): Promise<void>;
      listCircuitProjectHistory(projectId: string): Promise<CircuitHistoryEntry[]>;
      restoreCircuitProjectRevision(projectId: string, revision: number, baseRevision: number): Promise<{
        ok: true;
        revision: number;
        changed_modules: string[];
      }>;
      createCircuitProject(input: { name: string; demo?: boolean; projectKind?: ProjectKind }): Promise<CircuitProjectBundle>;
      createCircuitProjectFromTemplate(input: { templateId: string; name?: string }): Promise<CircuitProjectBundle>;
      getCircuitProject(projectId: string): Promise<CircuitProjectBundle>;
      resolveKicadSymbolIr(symbolIds: string[]): Promise<SymbolIrBundle>;
      listHdlFiles(projectId: string): Promise<string[]>;
      readHdlFile(projectId: string, relativePath: string): Promise<string>;
      writeHdlFile(
        projectId: string,
        relativePath: string,
        content: string,
      ): Promise<{ ok: true; path: string; hash: string }>;
      initializeHdlWorkspace(projectId: string): Promise<{ files: string[] }>;
      createHdlFile(projectId: string, relativePath: string): Promise<{ ok: true; path: string }>;
      runHdlAction(
        projectId: string,
        action: 'simulate' | 'synthesize' | 'gate-regression' | 'openroad' | 'mixed-contract',
      ): Promise<HdlVerificationRun>;
      applyCircuitCommand(projectId: string, command: CircuitCommand): Promise<{
        ok: true;
        revision: number;
        changed_modules: string[];
        erc: CircuitErcResult;
      }>;
      stageCircuitCommand(projectId: string, command: CircuitCommand): Promise<PendingCircuitCommand & { ok: true }>;
      listPendingCircuitCommands(projectId: string): Promise<{
        ok: true;
        pending: PendingCircuitCommand[];
        count: number;
      }>;
      acceptPendingCircuitCommand(projectId: string, commandId: string): Promise<{
        ok: true;
        accepted: string;
        revision: number;
        changed_modules: string[];
        erc: CircuitErcResult;
      }>;
      rejectPendingCircuitCommand(projectId: string, commandId: string, reason?: string): Promise<{
        ok: true;
        rejected: string;
        project_id: string;
      }>;
      runCircuitErc(projectId: string): Promise<CircuitErcResult & { ok: true }>;
      getCircuitAgentContext(projectId: string): Promise<CircuitAgentContext>;
      compileCircuitProject(projectId: string): Promise<{
        ok: true;
        revision: number;
        netlist_path: string;
      }>;
      exportCircuitEda(projectId: string, input: EdaExportRequest): Promise<EdaExportResult>;
      optimizeCircuitLayout(projectId: string, input: LayoutOptimizationRequest): Promise<LayoutOptimizationResult>;
      chooseCircuitEdaMapping(): Promise<string | null>;
      chooseCircuitEdaOutputDir(): Promise<string | null>;
      chooseEdaBridgePeerRoot(): Promise<string | null>;
      listEdaBridges(projectId: string): Promise<BridgeListResult>;
      edaBridgeStatus(projectId: string, peerKind?: EdaBridgePeerKind): Promise<BridgeStatusResult>;
      linkEdaBridge(projectId: string, input: {
        peerKind: EdaBridgePeerKind;
        peerRoot: string;
        policy?: string;
      }): Promise<BridgeStatusResult>;
      unlinkEdaBridge(projectId: string, peerKind: EdaBridgePeerKind): Promise<BridgeStatusResult>;
      pushEdaBridge(projectId: string, peerKind: EdaBridgePeerKind): Promise<BridgeStatusResult>;
      pullEdaBridge(projectId: string, peerKind: EdaBridgePeerKind, policy?: string): Promise<BridgePullResult>;
      importEdaColdStart(input: {
        peerKind: EdaBridgePeerKind;
        peerRoot: string;
        name?: string;
        projectKind?: ProjectKind;
      }): Promise<EdaColdStartImportResult>;
      exportSchematicHandoff(projectId: string, input: {
        format: string;
        outputPath: string;
        moduleId?: string;
        sourceRevision: number;
      }): Promise<{
        ok: true;
        format: string;
        output_path: string;
        files?: string[];
        module_id?: string;
        export_id?: string;
      }>;
      importSchematicHandoff(projectId: string, input: {
        format: string;
        sourcePath: string;
        moduleId: string;
      }): Promise<{
        ok: true;
        format: string;
        module_id: string;
        revision: number;
        created: number;
        fidelity?: string;
        note?: string;
      }>;
      chooseSchematicImportSource(format: string): Promise<string | null>;
      chooseSchematicExportPath(format: string): Promise<string | null>;
      searchLcscParts(query: string, opts?: { limit?: number; useFallback?: boolean }): Promise<LcscSearchResult>;
      getLcscPart(lcscId: string, opts?: { useFallback?: boolean }): Promise<LcscPartResult>;
      bindLcscPart(
        projectId: string,
        moduleId: string,
        componentId: string,
        lcscId: string,
        opts?: { useFallback?: boolean },
      ): Promise<LcscBindResult>;
      simulateCircuitProject(projectId: string): Promise<SimulationRun>;
      generateCircuitTechnicalReport(projectId: string, sourceRevision: number): Promise<TechnicalReportResult>;
      compileCircuitModule(
        projectId: string,
        moduleId: string,
        schematicDocument?: SerializableSchematicDocument,
      ): Promise<{
        ok: true;
        module_id: string;
        revision: number;
        netlist_path: string;
        schematic_path: string;
        schematic_document_path?: string;
        render_map_path?: string;
        render: {
          ok: boolean;
          svg_path?: string;
          renderer?: string;
          error?: string;
        };
      }>;
      saveCircuitModuleNotebook(projectId: string, moduleId: string, markdown: string, baseRevision?: number): Promise<{
        ok: true;
        module_id: string;
        revision: number;
        netlist_path: string;
        schematic_path: string;
        render: {
          ok: boolean;
          svg_path?: string;
          renderer?: string;
          error?: string;
        };
      }>;
      simulateCircuitModule(projectId: string, moduleId: string): Promise<SimulationRun & { module_id: string }>;
      simulateCircuitDual(projectId: string, input: {
        leftProfileId: string;
        rightProfileId: string;
        relativeTolerance: number;
        absoluteTolerance: number;
      }): Promise<HdlVerificationRun>;
      choosePhysicalVerificationFile(label: string): Promise<string | null>;
      openPhysicalArtifact(projectId: string, artifactPath: string): Promise<string>;
      runPhysicalVerification(
        projectId: string,
        input: Record<string, unknown>,
      ): Promise<HdlVerificationRun | SimulationRun>;
      chooseLicensedEdaInput(): Promise<string | null>;
      runLicensedEda(projectId: string, input: {
        profileId: string;
        inputPath: string;
        kind: string;
        top?: string;
        measurementCsv?: string;
      }): Promise<HdlVerificationRun>;
      readCircuitBuild(projectId: string): Promise<CircuitBuildState | null>;
      readCircuitSimulationDataset(projectId: string, input: {
        runId: string;
        analysisId: string;
        moduleId?: string;
        maxPoints?: number;
        xMin?: number;
        xMax?: number;
      }): Promise<SimulationDataset>;
      saveCircuitDesignTemplate(projectId: string): Promise<SavedDesignMemorySummary>;
      saveCircuitDesignFlow(projectId: string): Promise<SavedDesignMemorySummary>;
      listCircuitDesignMemory(): Promise<{ templates: DesignMemoryItem[]; flows: DesignMemoryItem[] }>;
      openCircuitDesignMemory(input: { kind: 'template' | 'flow'; id: string }): Promise<string>;
      watchCircuitProject(projectId: string): Promise<void>;
      onCircuitProjectChanged(
        callback: (event: { projectId: string; timestamp: number }) => void,
      ): () => void;
      onCircuitProjectListChanged(
        callback: (event: { timestamp: number }) => void,
      ): () => void;
      openCircuitProjectFolder(projectId: string): Promise<string>;
      openCircuitEdaExportFolder(projectId: string, exportId: string, exportRoot?: string): Promise<string>;
      getSettings(): Promise<AppSettings>;
      revealActoviqAuthToken(): Promise<string | null>;
      saveSettings(settings: AppSettings): Promise<AppSettings>;
      testProviderSettings(settings: AppSettings): Promise<ProviderTestResult>;
      testLayoutModelSettings(settings: AppSettings): Promise<LayoutModelTestResult>;
      getIcDiagnostics(): Promise<IcDiagnostics>;
      listExecutionProfiles(): Promise<ExecutionProfileRegistry>;
      saveExecutionProfile(profile: StoredExecutionProfile): Promise<ExecutionProfileRegistry>;
      deleteExecutionProfile(id: string): Promise<ExecutionProfileRegistry>;
      probeExecutionProfile(id: string): Promise<ExecutionProfileProbe>;
      choosePdkRoot(): Promise<string | null>;
      choosePdkMappingPack(): Promise<string | null>;
      choosePdkInstallDestination(): Promise<string | null>;
      listPdkInstallations(): Promise<Record<string, unknown>>;
      listOpenPdkCatalog(): Promise<{ ok: true; pdks: Array<{
        adapter_id: string;
        name: string;
        vendor: string;
        process: string;
        license: string;
        support_status: string;
        source_url: string;
        homepage_url: string;
        notes: string;
      }> }>;
      getOpenPdkLocalStatus(): Promise<{
        ok: true;
        defaultRoot: string;
        items: Array<{
          adapter_id: string;
          present: boolean;
          registered: boolean;
          destination: string;
          root: string;
          installation_ids: string[];
        }>;
      }>;
      getDefaultPdkRoot(): Promise<string>;
      choosePdkInstallRoot(): Promise<string | null>;
      openPdkExternalUrl(url: string): Promise<{ ok: true; url: string }>;
      installOpenPdk(input: {
        adapter: 'ihp-sg13g2' | 'sky130' | 'gf180mcu';
        destination: string;
        revision?: string;
        licenseAccepted: boolean;
      }): Promise<{ ok: true; receipt?: Record<string, unknown> }>;
      installOpenPdkDefault(input: {
        adapter: 'ihp-sg13g2' | 'sky130' | 'gf180mcu';
        licenseAccepted: boolean;
        register?: boolean;
      }): Promise<{
        ok: true;
        destination: string;
        defaultRoot: string;
        receipt?: Record<string, unknown>;
        scan?: { installation?: Record<string, unknown> };
        registration?: { installation?: Record<string, unknown> } | null;
      }>;
      scanPdkInstallation(input: {
        root: string;
        adapter: 'ihp-sg13g2' | 'sky130' | 'gf180mcu' | 'commercial';
        version?: string;
        revision?: string;
        mappingFile?: string;
      }): Promise<{ ok: true; installation?: Record<string, unknown> }>;
      registerPdkInstallation(input: {
        root: string;
        adapter: 'ihp-sg13g2' | 'sky130' | 'gf180mcu' | 'commercial';
        version?: string;
        revision?: string;
        mappingFile?: string;
        licenseAccepted: boolean;
      }): Promise<{ ok: true; installation?: Record<string, unknown> }>;
      chooseXschemPeerFile(mode: 'bridge' | 'external'): Promise<string | null>;
      linkXschemPeer(projectId: string, input: {
        moduleId: string;
        mode: 'native' | 'bridge' | 'external';
        peerFile?: string;
      }): Promise<XschemSyncResult>;
      pushXschemPeer(projectId: string, moduleId: string): Promise<XschemSyncResult>;
      pullXschemPeer(projectId: string, moduleId: string): Promise<XschemSyncResult>;
      takeXschemOwnership(projectId: string, moduleId: string): Promise<XschemSyncResult>;
      validateXschemPeer(
        projectId: string,
        moduleId: string,
        peerFile: string,
      ): Promise<Record<string, unknown>>;
      getAppVersion(): Promise<string>;
      getCircuitSkillStatus(): Promise<CircuitSkillStatus>;
      syncCircuitSkill(): Promise<CircuitSkillStatus>;
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
      ): Promise<ChatResponse>;
      stopChat(conversationId?: string): Promise<boolean>;
      onChatEvent(callback: (event: DesktopAgentEvent) => void): () => void;
    };
  }
}
