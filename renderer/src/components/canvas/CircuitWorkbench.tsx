import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent as ReactUIEvent,
} from 'react';
import { useAppStore } from '../../store/appStore';
import type {
  CircuitCommand,
  CircuitCommandV2,
  CircuitHistoryEntry,
  DesignMemoryItem,
  CircuitModule,
  CircuitModuleRef,
  CircuitPort,
  HdlVerificationRun,
  LayoutOptimizationResult,
  PendingCircuitCommand,
  ProjectKind,
  SchematicOverrides,
  SimulationRun,
  StoredExecutionProfile,
} from '../../types';
import {
  SchematicEditor,
  type SchematicLocateTarget,
  type SchematicProbeSelection,
} from './SchematicEditor';
import { WorkbenchToolbar } from './WorkbenchToolbar';
import { SchematicDocumentSvg } from '../../schematic/SchematicDocumentSvg';
import { useKicadSymbolDefinitions } from '../../schematic/useKicadSymbolDefinitions';
import {
  projectSchematicArtifact,
  projectSchematicDocument as createSchematicDocument,
} from '../../schematic-core/projection/facade';
import { useSchematicProjection } from '../../schematic-core/projection/useSchematicProjection';
import {
  modulePortEndpointKey as endpointKey,
  resolveSystemNetworks,
  type SystemNetworkMap,
} from '../../schematic-core/connectivity/modulePortGraph';
import { diffModuleToOperations } from '../../schematic-core/commands/diffModule';
import type { TransactionOperation } from '../../schematic-core/commands/applyTransaction';
import type { PdkDeviceCatalog } from './componentParams';
import {
  searchProjectSchematic,
  type SchematicSearchResult,
} from '../../schematic-core/search/projectSearch';

interface RegisteredPdkInstallation {
  installation_id: string;
  logical_id: string;
  name: string;
  process?: string;
  version?: string;
  fingerprint?: string;
  root?: string;
  support_status?: string;
  capabilities?: Record<string, boolean>;
  views?: Record<string, string[]>;
  diagnostics?: string[];
  device_catalog?: PdkDeviceCatalog | null;
}

interface Props {
  onCreateProject: (demo: boolean, name: string, projectKind?: ProjectKind) => Promise<void>;
  onCreateProjectFromTemplate: (templateId: string, defaultName: string) => Promise<void>;
  onReloadProject: (projectId: string) => Promise<void>;
  onReferencesChanged?: () => Promise<void>;
}

interface ModuleEditorState {
  mode: 'add' | 'edit';
  id: string;
  name: string;
  kind: string;
  functionText: string;
  parametersText: string;
  position: { x: number; y: number };
}

interface EmptyProjectFormState {
  demo: boolean;
  name: string;
  projectKind: ProjectKind;
}

type SchematicIoFormat = 'kicad' | 'jlceda' | 'altium' | 'allegro' | 'virtuoso' | 'xschem';

interface SchematicIoFormState {
  format: SchematicIoFormat;
  path: string;
}

interface PhysicalVerificationForm {
  operation: 'klayout_drc' | 'klayout_lvs' | 'magic_extract' | 'magic_pex' | 'netgen_lvs' | 'post_layout_simulation';
  layout: string;
  schematic: string;
  ruleDeck: string;
  techFile: string;
  extracted: string;
  setupFile: string;
  topCell: string;
  extractedCell: string;
  schematicCell: string;
  deck: string;
  lvsRun: string;
}

interface HierarchyPathEntry {
  moduleId: string;
  instanceId?: string;
  instanceName?: string;
}

interface HierarchyTrace {
  id: string;
  moduleId: string;
  net: string;
  netId?: string;
  label: string;
}

const BOARD_MARGIN = 1200;

const PROJECT_KIND_OPTIONS: Array<{ value: ProjectKind; label: string }> = [
  { value: 'simulation', label: 'Simulation' },
  { value: 'pcb_schematic', label: 'PCB Schematic' },
  { value: 'analog_ic', label: 'Analog IC' },
  { value: 'mixed_signal_ic', label: 'Mixed-Signal IC' },
];

function supportsSchematicIo(projectKind?: ProjectKind): boolean {
  return projectKind === 'pcb_schematic'
    || projectKind === 'analog_ic'
    || projectKind === 'mixed_signal_ic';
}

function schematicIoFormats(projectKind?: ProjectKind): Array<{ value: SchematicIoFormat; label: string }> {
  if (projectKind === 'pcb_schematic') {
    return [
      { value: 'kicad', label: 'KiCad' },
      { value: 'jlceda', label: '嘉立创 EDA' },
      { value: 'altium', label: 'Altium Designer' },
      { value: 'allegro', label: 'Allegro / OrCAD' },
    ];
  }
  if (projectKind === 'analog_ic' || projectKind === 'mixed_signal_ic') {
    return [
      { value: 'virtuoso', label: 'Virtuoso (SPICE/CDL)' },
      { value: 'xschem', label: 'Xschem' },
    ];
  }
  return [];
}

function defaultSchematicIoFormat(projectKind?: ProjectKind): SchematicIoFormat {
  return schematicIoFormats(projectKind)[0]?.value ?? 'kicad';
}

function currentVectorCandidates(instance: string, type?: CircuitModule['components'][number]['type']): string[] {
  const parameter = ({
    R: 'i', C: 'i', L: 'i', D: 'id', M: 'id', Q: 'ic', I: 'current',
  } as Partial<Record<CircuitModule['components'][number]['type'], string>>)[type ?? 'BLOCK'];
  return [
    ...(parameter ? [`i(@${instance}[${parameter}])`] : []),
    `i(${instance})`,
  ];
}

function powerVectorCandidates(instance: string): string[] {
  return [`@${instance}[p]`, `p(${instance})`, `power(${instance})`];
}
const BOARD_MIN_WIDTH = 3600;
const BOARD_MIN_HEIGHT = 2600;
/** Matches `styles.boardViewport.padding`; used by zoom focal-point scroll math. */
const BOARD_VIEWPORT_PADDING = 20;

function commandId(): string {
  return `gui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampCanvasZoom(value: number): number {
  return Math.max(35, Math.min(160, value));
}

function modulePlaneMetrics(modules: CircuitModuleRef[]): {
  width: number;
  height: number;
  originX: number;
  originY: number;
} {
  const minX = Math.min(0, ...modules.map((module) => module.position.x));
  const minY = Math.min(0, ...modules.map((module) => module.position.y));
  const maxX = Math.max(0, ...modules.map((module) => module.position.x + module.size.width));
  const maxY = Math.max(0, ...modules.map((module) => module.position.y + module.size.height));
  return {
    width: Math.max(BOARD_MIN_WIDTH, maxX - minX + BOARD_MARGIN * 2),
    height: Math.max(BOARD_MIN_HEIGHT, maxY - minY + BOARD_MARGIN * 2),
    originX: BOARD_MARGIN - minX,
    originY: BOARD_MARGIN - minY,
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, button, [contenteditable="true"]'));
}

function prepareSvg(svg: string): string {
  const sanitized = svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
    // Drop external/script-bearing refs (js:, data:, http(s):, protocol-relative);
    // netlistsvg only uses internal "#id" references, which are preserved.
    .replace(/\s(?:href|xlink:href)\s*=\s*["']\s*(?:javascript:|data:|https?:|\/\/)[^"']*["']/gi, '');
  return sanitized.replace(
    /<svg\b([^>]*)>/i,
    (_match, attributes: string) => {
      const cleanedAttributes = attributes
        .replace(/\sstyle\s*=\s*["'][^"']*["']/gi, '')
        .replace(/\spreserveAspectRatio\s*=\s*["'][^"']*["']/gi, '');
      return `<svg${cleanedAttributes} style="width:100%;height:100%;display:block" preserveAspectRatio="xMidYMid meet">`;
    },
  );
}

function isGround(port: CircuitPort): boolean {
  const value = `${port.name} ${port.net}`.toLowerCase();
  return port.signal_type === 'ground' || /(?:^|\s)[adp]?gnd(?:\s|$)/.test(value);
}

function visibleInterfaces(module: CircuitModuleRef): {
  inputs: CircuitPort[];
  outputs: CircuitPort[];
  grounds: CircuitPort[];
} {
  return {
    inputs: module.ports.filter((port) => !isGround(port) && port.direction === 'input'),
    outputs: module.ports.filter((port) => !isGround(port) && port.direction === 'output'),
    grounds: module.ports.filter(isGround),
  };
}

function interfaceNetworks(
  moduleId: string,
  ports: CircuitPort[],
  tone: 'input' | 'output' | 'ground',
  systemNetworks: SystemNetworkMap,
): string[] {
  return [...new Set(ports.map((port) => {
    const systemNetwork = systemNetworks[endpointKey(moduleId, port.id)];
    if (systemNetwork) return systemNetwork.label;
    if (tone === 'ground' && /^(?:AGND|DGND|PGND)$/i.test(port.name)) {
      if (port.net === '0') return port.name;
      if (port.name.toLowerCase() === port.net.toLowerCase()) return port.net;
      return `${port.name} (${port.net})`;
    }
    return port.net;
  }))];
}

function fallbackParameters(module: CircuitModule | undefined): Record<string, string> {
  if (!module) return {};
  return Object.fromEntries(
    module.components.slice(0, 5).map((component) => [component.name, component.value]),
  );
}

function formatParameters(parameters: Record<string, string> | undefined): string {
  return Object.entries(parameters ?? {})
    .map(([name, value]) => `${name} = ${value}`)
    .join('\n');
}

function parseParameters(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.includes('=') ? '=' : ':';
        const index = line.indexOf(separator);
        if (index < 1) throw new Error(`Invalid parameter line: ${line}`);
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}

function isModuleEditorSubmittable(editor: ModuleEditorState, modules: CircuitModuleRef[]): boolean {
  const id = editor.id.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) return false;
  if (!editor.name.trim() || !editor.kind.trim()) return false;
  if (editor.mode === 'add' && modules.some((module) => module.id === id)) return false;
  try {
    parseParameters(editor.parametersText);
  } catch {
    return false;
  }
  return true;
}

function sanitizeSpiceToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'node';
}

function componentSpiceName(moduleId: string, component: CircuitModule['components'][number]): string {
  let name = sanitizeSpiceToken(`${moduleId}_${component.name}`);
  if (!name.toUpperCase().startsWith(component.type)) {
    name = `${component.type}${name}`;
  }
  return name;
}

function moduleToSpiceNetlist(moduleId: string, moduleData: CircuitModule): string {
  const lines = [
    `* ${moduleData.name}`,
    '* Editable schematic netlist generated from actoviq.module.v1',
  ];
  for (const component of moduleData.components) {
    if (component.type === 'GND') {
      // Ground symbols carry no SPICE card; their pin already ties net '0'.
      lines.push(`* GND ${component.name} on net 0`);
      continue;
    }
    if (component.type === 'BLOCK' || component.type === 'MODULE') {
      const pinSummary = component.pins.map((pin) => `${pin.name}=${pin.net}`).join(', ');
      lines.push(`* ${component.type} ${component.name}: ${component.value} [${pinSummary}]`);
      continue;
    }
    const nodes = component.pins.map((pin) => sanitizeSpiceToken(pin.net || `n_${component.id}_${pin.id}`));
    lines.push([
      componentSpiceName(moduleId, component),
      ...nodes,
      component.value.trim() || '1',
    ].join(' '));
  }
  if (!moduleData.spice?.generated_testbench) {
    for (const line of moduleData.spice?.opaque ?? []) lines.push(line);
  }
  for (const line of moduleData.spice?.models ?? []) lines.push(line);
  if (!moduleData.spice?.generated_testbench) {
    for (const line of moduleData.spice?.directives ?? []) lines.push(line);
  }
  lines.push('.end');
  return `${lines.join('\n')}\n`;
}

function moduleNotebookMarkdown(moduleId: string, moduleData: CircuitModule): string {
  return [
    `# ${moduleData.name}`,
    '',
    'Editable schematic source. Applying schematic edits rewrites this SPICE block and refreshes the netlistsvg preview.',
    '',
    '```spice',
    moduleToSpiceNetlist(moduleId, moduleData).trim(),
    '```',
    '',
  ].join('\n');
}

export function CircuitWorkbench({
  onCreateProject,
  onCreateProjectFromTemplate,
  onReloadProject,
  onReferencesChanged,
}: Props) {
  const bundle = useAppStore((state) => state.circuitProject);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const activeModuleId = useAppStore((state) => state.activeModuleId);
  const setActiveModuleId = useAppStore((state) => state.setActiveModuleId);
  const build = useAppStore((state) => state.circuitBuild);
  const busy = useAppStore((state) => state.circuitBusy);
  const error = useAppStore((state) => state.circuitError);
  const setBusy = useAppStore((state) => state.setCircuitBusy);
  const setError = useAppStore((state) => state.setCircuitError);
  const setBuild = useAppStore((state) => state.setCircuitBuild);
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const setSimulationProbeRequest = useAppStore((state) => state.setSimulationProbeRequest);
  const [view, setView] = useState<'board' | 'module'>('board');
  const [hierarchyPath, setHierarchyPath] = useState<HierarchyPathEntry[]>([]);
  const [hierarchyTrace, setHierarchyTrace] = useState<HierarchyTrace | null>(null);
  const [schematicSearchOpen, setSchematicSearchOpen] = useState(false);
  const [schematicSearchQuery, setSchematicSearchQuery] = useState('');
  const [schematicLocateTarget, setSchematicLocateTarget] = useState<SchematicLocateTarget | null>(null);
  const [zoom, setZoom] = useState(65);
  const [notice, setNotice] = useState('');
  const [layoutFeedback, setLayoutFeedback] = useState<Record<string, LayoutOptimizationResult>>({});
  const [copiedId, setCopiedId] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [isPanning, setIsPanning] = useState(false);
  const [spacePanActive, setSpacePanActive] = useState(false);
  const [canvasScroll, setCanvasScroll] = useState({ left: 0, top: 0 });
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    moduleId?: string;
    boardPosition: { x: number; y: number };
  } | null>(null);
  const [moduleEditor, setModuleEditor] = useState<ModuleEditorState | null>(null);
  const [moduleEditorError, setModuleEditorError] = useState('');
  const [emptyProjectForm, setEmptyProjectForm] = useState<EmptyProjectFormState | null>(null);
  const canvasPanelRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(zoom);
  const viewRef = useRef(view);
  const pendingCanvasScrollRef = useRef<{ left: number; top: number } | null>(null);
  const handleCanvasWheelRef = useRef<(event: WheelEvent) => void>(() => {});
  const suppressContextMenuRef = useRef(false);
  const emptyProjectCreateRef = useRef(false);
  zoomRef.current = zoom;
  viewRef.current = view;
  const [modulePreviewPositions, setModulePreviewPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [modulePreviewSizes, setModulePreviewSizes] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const [modulePreviewBusy, setModulePreviewBusy] = useState<Record<string, boolean>>({});
  const [lastPreviewBuildModule, setLastPreviewBuildModule] = useState('');
  const modulePreviewBusyRef = useRef<Set<string>>(new Set());
  const [moduleSimulation, setModuleSimulation] = useState<(SimulationRun & { module_id: string }) | null>(null);
  const [designMemory, setDesignMemory] = useState<{
    templates: DesignMemoryItem[];
    flows: DesignMemoryItem[];
  }>({ templates: [], flows: [] });
  const [designMemoryLoading, setDesignMemoryLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pendingCommandsOpen, setPendingCommandsOpen] = useState(false);
  const [pendingCommandsLoading, setPendingCommandsLoading] = useState(false);
  const [pendingCommands, setPendingCommands] = useState<PendingCircuitCommand[]>([]);
  const [ercOpen, setErcOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [history, setHistory] = useState<CircuitHistoryEntry[]>([]);
  const [edaExportOpen, setEdaExportOpen] = useState(false);
  const [edaImportOpen, setEdaImportOpen] = useState(false);
  const [edaExportNotice, setEdaExportNotice] = useState('');
  const [edaImportNotice, setEdaImportNotice] = useState('');
  const [edaExportForm, setEdaExportForm] = useState<SchematicIoFormState>({
    format: 'kicad',
    path: '',
  });
  const [edaImportForm, setEdaImportForm] = useState<SchematicIoFormState>({
    format: 'kicad',
    path: '',
  });
  const [simulationProfiles, setSimulationProfiles] = useState<StoredExecutionProfile[]>([]);
  const [registeredPdks, setRegisteredPdks] = useState<RegisteredPdkInstallation[]>([]);
  const [physicalOpen, setPhysicalOpen] = useState(false);
  const [physicalResult, setPhysicalResult] = useState<HdlVerificationRun | SimulationRun | null>(null);
  const [physicalForm, setPhysicalForm] = useState<PhysicalVerificationForm>({
    operation: 'klayout_drc',
    layout: '',
    schematic: '',
    ruleDeck: '',
    techFile: '',
    extracted: '',
    setupFile: '',
    topCell: '',
    extractedCell: '',
    schematicCell: '',
    deck: '',
    lvsRun: '',
  });

  const project = bundle?.project ?? null;
  const projectKind = project?.project_kind ?? 'simulation';
  const projectSimulationProfileId = project?.analog_ic_profile?.schema === 'actoviq.analog-ic-profile.v2'
    ? project.analog_ic_profile.simulation_profile_id
    : '';
  const projectPdkRef = project?.analog_ic_profile?.schema === 'actoviq.analog-ic-profile.v2'
    ? project.analog_ic_profile.pdk_binding.pdk_ref
    : '';
  const projectPdkBinding = project?.analog_ic_profile?.schema === 'actoviq.analog-ic-profile.v2'
    ? project.analog_ic_profile.pdk_binding
    : null;
  const pdkDeviceCatalog = useMemo(() => {
    if (!projectPdkRef) return null;
    const installation = registeredPdks.find((entry) => entry.logical_id === projectPdkRef);
    if (!installation?.device_catalog) return null;
    return {
      ...installation.device_catalog,
      binding: {
        default_corner: projectPdkBinding?.default_corner,
        corner_sweep: projectPdkBinding?.corner_sweep,
        model_library_available: Boolean(installation.capabilities?.model_library),
        installation_version: installation.version,
        installation_fingerprint: installation.fingerprint,
      },
    };
  }, [projectPdkBinding, projectPdkRef, registeredPdks]);
  const schematicSearchResults = useMemo(
    () => searchProjectSchematic(bundle?.modules ?? {}, schematicSearchQuery),
    [bundle?.modules, schematicSearchQuery],
  );
  const schematicIoEnabled = supportsSchematicIo(projectKind);
  const schematicFormats = schematicIoFormats(projectKind);
  const erc = bundle?.erc ?? build?.erc ?? null;
  const currentProjectId = project?.project_id ?? activeProjectId;
  const systemNetworks = useMemo(
    () => resolveSystemNetworks(project?.modules ?? [], project?.connections ?? []),
    [project],
  );
  const selectedRef = project?.modules.find((module) => module.id === activeModuleId) ?? null;
  const selectedModule = activeModuleId ? bundle?.modules[activeModuleId] : undefined;
  const selectedPreview = activeModuleId ? bundle?.module_previews[activeModuleId] : undefined;
  const selectedPreviewBusy = activeModuleId ? Boolean(modulePreviewBusy[activeModuleId]) : false;
  const anyPreviewBusy = Object.keys(modulePreviewBusy).length > 0;
  const moduleEditorCanSave = Boolean(
    moduleEditor && project && isModuleEditorSubmittable(moduleEditor, project.modules),
  );
  const displayedModules = useMemo(() => (
    project?.modules.map((module) => ({
      ...module,
      position: modulePreviewPositions[module.id] ?? module.position,
      size: modulePreviewSizes[module.id] ?? module.size,
    })) ?? []
  ), [modulePreviewPositions, modulePreviewSizes, project]);
  const boardMetrics = useMemo(() => modulePlaneMetrics(displayedModules), [displayedModules]);

  function isActiveProject(projectId: string): boolean {
    return useAppStore.getState().activeProjectId === projectId;
  }

  function openSimulationProbe(moduleId: string, probe: SchematicProbeSelection) {
    if (!currentProjectId) return;
    const mapped: string[] = [];
    if (probe.net) {
      for (const [node, source] of Object.entries(build?.sourceMap?.nodes ?? {})) {
        if (source.module_id === moduleId && source.local_net === probe.net) mapped.push(`v(${node})`);
      }
    }
    if (probe.componentId && probe.kind !== 'voltage') {
      for (const [instance, source] of Object.entries(build?.sourceMap?.components ?? {})) {
        if (source.module_id === moduleId && source.component_id === probe.componentId) {
          mapped.push(...(
            probe.kind === 'power'
              ? powerVectorCandidates(instance)
              : currentVectorCandidates(instance, probe.componentType)
          ));
        }
      }
    }
    const candidates = [...new Map(
      [...mapped, ...probe.candidates].map((candidate) => [candidate.toLowerCase(), candidate]),
    ).values()];
    setSimulationProbeRequest({
      id: Date.now(),
      projectId: currentProjectId,
      moduleId,
      kind: probe.kind,
      label: probe.label,
      candidates,
      entity: probe.wireId ? {
        kind: 'wire',
        id: probe.wireId,
        net: probe.net,
        netId: probe.netId,
      } : probe.pinId && probe.componentId ? {
        kind: 'pin',
        id: `${probe.componentId}:${probe.pinId}`,
        net: probe.net,
        netId: probe.netId,
        componentId: probe.componentId,
        pinId: probe.pinId,
      } : probe.componentId ? {
        kind: 'component',
        id: probe.componentId,
        componentId: probe.componentId,
      } : undefined,
    });
    setActiveTab('simulation');
  }

  useEffect(() => {
    if (!project) return;
    const currentExists = activeModuleId && project.modules.some((entry) => entry.id === activeModuleId);
    if (!currentExists) setActiveModuleId(project.modules[0]?.id ?? null);
  }, [activeModuleId, project, setActiveModuleId]);

  useEffect(() => {
    setNoteDraft(selectedRef?.notes ?? '');
    setModuleSimulation(null);
  }, [selectedRef?.id, selectedRef?.notes]);

  useEffect(() => {
    setBusy(false);
    setError('');
    setNotice('');
    setLayoutFeedback({});
    setModulePreviewPositions({});
    setModulePreviewSizes({});
    setModulePreviewBusy({});
    setLastPreviewBuildModule('');
    setEdaExportOpen(false);
    setEdaImportOpen(false);
    setEdaExportNotice('');
    setEdaImportNotice('');
    setEdaExportForm({ format: defaultSchematicIoFormat(projectKind), path: '' });
    setEdaImportForm({ format: defaultSchematicIoFormat(projectKind), path: '' });
    modulePreviewBusyRef.current = new Set();
    setHierarchyPath([]);
    setHierarchyTrace(null);
    setSchematicSearchOpen(false);
    setSchematicSearchQuery('');
    setSchematicLocateTarget(null);
    setView('board');
  }, [activeProjectId]);

  useEffect(() => {
    if (view !== 'board') return;
    const panel = canvasPanelRef.current;
    if (!panel) return;
    const scale = zoom / 100;
    window.requestAnimationFrame(() => {
      panel.scrollLeft = Math.round(boardMetrics.originX * scale);
      panel.scrollTop = Math.round(boardMetrics.originY * scale);
      setCanvasScroll({ left: panel.scrollLeft, top: panel.scrollTop });
    });
  }, [activeProjectId, project?.project_id, view]);

  useLayoutEffect(() => {
    const pending = pendingCanvasScrollRef.current;
    if (!pending) return;
    pendingCanvasScrollRef.current = null;
    const panel = canvasPanelRef.current;
    if (!panel) return;
    panel.scrollLeft = pending.left;
    panel.scrollTop = pending.top;
    setCanvasScroll({ left: panel.scrollLeft, top: panel.scrollTop });
  }, [zoom]);

  const refreshDesignMemory = useCallback(async () => {
    setDesignMemoryLoading(true);
    try {
      setDesignMemory(await window.electronAPI.listCircuitDesignMemory());
    } catch {
      setDesignMemory({ templates: [], flows: [] });
    } finally {
      setDesignMemoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshDesignMemory();
  }, [refreshDesignMemory, activeProjectId]);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.listExecutionProfiles()
      .then((registry) => {
        if (cancelled) return;
        setSimulationProfiles(registry.profiles.filter(
          (profile) => profile.providerId === 'ngspice' || profile.providerId === 'xyce',
        ));
      })
      .catch(() => {
        if (!cancelled) setSimulationProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  useEffect(() => {
    let cancelled = false;
    const loadRegisteredPdks = async () => {
      if (typeof window.electronAPI.listPdkInstallations !== 'function') {
        if (!cancelled) setRegisteredPdks([]);
        return;
      }
      try {
        const listed = await window.electronAPI.listPdkInstallations() as {
          installations?: Array<Record<string, unknown>>;
        };
        if (cancelled) return;
        const installations = Array.isArray(listed?.installations) ? listed.installations : [];
        setRegisteredPdks(installations.map((entry) => {
          const catalog = entry.device_catalog;
          const devices = catalog && typeof catalog === 'object' && Array.isArray((catalog as { devices?: unknown }).devices)
            ? (catalog as PdkDeviceCatalog)
            : null;
          return {
            installation_id: String(entry.installation_id ?? ''),
            logical_id: String(entry.logical_id ?? ''),
            name: String(entry.name ?? entry.logical_id ?? 'PDK'),
            process: typeof entry.process === 'string' ? entry.process : undefined,
            version: typeof entry.version === 'string' ? entry.version : undefined,
            fingerprint: typeof entry.fingerprint === 'string' ? entry.fingerprint : undefined,
            root: typeof entry.root === 'string' ? entry.root : undefined,
            support_status: typeof entry.support_status === 'string' ? entry.support_status : undefined,
            capabilities: entry.capabilities && typeof entry.capabilities === 'object'
              ? entry.capabilities as Record<string, boolean>
              : undefined,
            views: entry.views && typeof entry.views === 'object'
              ? entry.views as Record<string, string[]>
              : undefined,
            diagnostics: Array.isArray(entry.diagnostics) ? entry.diagnostics.map(String) : undefined,
            device_catalog: devices,
          };
        }).filter((entry) => entry.logical_id));
      } catch {
        if (!cancelled) setRegisteredPdks([]);
      }
    };
    void loadRegisteredPdks();
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, projectKind]);

  const refreshHistory = useCallback(async () => {
    if (!currentProjectId) {
      setHistory([]);
      return;
    }
    setHistoryLoading(true);
    try {
      setHistory(await window.electronAPI.listCircuitProjectHistory(currentProjectId));
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : String(historyError));
    } finally {
      setHistoryLoading(false);
    }
  }, [currentProjectId, setError]);

  const refreshPendingCommands = useCallback(async () => {
    if (!currentProjectId) {
      setPendingCommands([]);
      return;
    }
    setPendingCommandsLoading(true);
    try {
      const result = await window.electronAPI.listPendingCircuitCommands(currentProjectId);
      setPendingCommands(result.pending);
    } catch (pendingError) {
      setError(pendingError instanceof Error ? pendingError.message : String(pendingError));
    } finally {
      setPendingCommandsLoading(false);
    }
  }, [currentProjectId, setError]);

  useEffect(() => {
    void refreshPendingCommands();
  }, [bundle, refreshPendingCommands]);

  useEffect(() => {
    if (historyOpen) void refreshHistory();
  }, [historyOpen, project?.revision, refreshHistory]);

  async function reviewPendingCommand(commandId: string, decision: 'accept' | 'reject'): Promise<void> {
    if (!currentProjectId || busy) return;
    const operationProjectId = currentProjectId;
    setBusy(true);
    setError('');
    try {
      if (decision === 'accept') {
        await window.electronAPI.acceptPendingCircuitCommand(operationProjectId, commandId);
        await onReloadProject(operationProjectId);
        if (isActiveProject(operationProjectId)) setNotice(`Accepted Agent proposal ${commandId}`);
      } else {
        await window.electronAPI.rejectPendingCircuitCommand(
          operationProjectId,
          commandId,
          'Rejected in the schematic review panel',
        );
        if (isActiveProject(operationProjectId)) setNotice(`Rejected Agent proposal ${commandId}`);
      }
      await refreshPendingCommands();
    } catch (reviewError) {
      if (isActiveProject(operationProjectId)) {
        setError(reviewError instanceof Error ? reviewError.message : String(reviewError));
      }
      await refreshPendingCommands();
    } finally {
      if (isActiveProject(operationProjectId)) setBusy(false);
    }
  }

  async function restoreRevision(revision: number): Promise<void> {
    if (!currentProjectId || !project || busy) return;
    const operationProjectId = currentProjectId;
    setBusy(true);
    setError('');
    setNotice(`Restoring revision ${revision}...`);
    try {
      await window.electronAPI.restoreCircuitProjectRevision(
        operationProjectId,
        revision,
        project.revision,
      );
      await onReloadProject(operationProjectId);
      if (isActiveProject(operationProjectId)) setNotice(`Restored revision ${revision} as a new revision`);
      await refreshHistory();
    } catch (restoreError) {
      if (isActiveProject(operationProjectId)) {
        setError(restoreError instanceof Error ? restoreError.message : String(restoreError));
        setNotice('');
      }
    } finally {
      if (isActiveProject(operationProjectId)) setBusy(false);
    }
  }

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('pointerdown', closeMenu);
    return () => {
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('pointerdown', closeMenu);
    };
  }, []);

  useEffect(() => {
    const panel = canvasPanelRef.current;
    if (!panel || view !== 'board') return;
    const listener = (event: WheelEvent) => handleCanvasWheelRef.current(event);
    panel.addEventListener('wheel', listener, { passive: false });
    return () => panel.removeEventListener('wheel', listener);
  }, [view, project?.project_id]);

  async function applyOperations(
    message: string,
    operations: Array<Record<string, unknown>>,
  ): Promise<boolean> {
    if (!project || !currentProjectId) return false;
    const operationProjectId = currentProjectId;
    const command: CircuitCommand = {
      schema: 'actoviq.command.v1',
      command_id: commandId(),
      actor: 'user',
      project_id: operationProjectId,
      base_revision: project.revision,
      message,
      operations,
    };
    setBusy(true);
    setError('');
    try {
      await window.electronAPI.applyCircuitCommand(operationProjectId, command);
      await onReloadProject(operationProjectId);
      if (isActiveProject(operationProjectId)) setNotice(message);
      return isActiveProject(operationProjectId);
    } catch (commandError) {
      if (isActiveProject(operationProjectId)) {
        setError(commandError instanceof Error ? commandError.message : String(commandError));
      }
      return false;
    } finally {
      if (isActiveProject(operationProjectId)) setBusy(false);
    }
  }

  async function applyModuleOperations(
    message: string,
    moduleId: string,
    expectedModuleRevision: number,
    operations: TransactionOperation[],
    notebookMarkdown?: string,
  ): Promise<boolean> {
    if (!project || !currentProjectId) return false;
    if (operations.length === 0) return true;
    const operationProjectId = currentProjectId;
    const command: CircuitCommandV2 = {
      schema: 'actoviq.command.v2',
      command_id: commandId(),
      actor: 'user',
      project_id: operationProjectId,
      module_id: moduleId,
      base_revision: project.revision,
      expected_module_revision: expectedModuleRevision,
      message,
      source: 'gui',
      notebook_markdown: notebookMarkdown,
      operations,
    };
    setBusy(true);
    setError('');
    try {
      await window.electronAPI.applyCircuitCommand(operationProjectId, command);
      await onReloadProject(operationProjectId);
      if (isActiveProject(operationProjectId)) setNotice(message);
      return isActiveProject(operationProjectId);
    } catch (commandError) {
      if (isActiveProject(operationProjectId)) {
        setError(commandError instanceof Error ? commandError.message : String(commandError));
      }
      return false;
    } finally {
      if (isActiveProject(operationProjectId)) setBusy(false);
    }
  }

  function setModulePreviewBuildBusy(moduleId: string, value: boolean) {
    const next = new Set(modulePreviewBusyRef.current);
    if (value) {
      next.add(moduleId);
    } else {
      next.delete(moduleId);
    }
    modulePreviewBusyRef.current = next;
    setModulePreviewBusy(Object.fromEntries([...next].map((id) => [id, true])));
  }

  async function waitForModulePreviewBuilds(): Promise<boolean> {
    const deadline = Date.now() + 60_000;
    while (modulePreviewBusyRef.current.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return modulePreviewBusyRef.current.size === 0;
  }

  async function buildModulePreview(
    moduleId: string,
    showNotice = true,
    sourceModule?: CircuitModule,
  ): Promise<boolean> {
    if (!currentProjectId) return false;
    const operationProjectId = currentProjectId;
    if (modulePreviewBusyRef.current.has(moduleId)) {
      // A save carries a newer structured module snapshot than an open-time
      // background build. Queue that affected module behind the in-flight
      // compile so the old derived SVG cannot remain the final artifact.
      if (!sourceModule) return false;
      const deadline = Date.now() + 60_000;
      while (modulePreviewBusyRef.current.has(moduleId) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      if (modulePreviewBusyRef.current.has(moduleId) || !isActiveProject(operationProjectId)) {
        return false;
      }
    }
    setLastPreviewBuildModule(moduleId);
    setModulePreviewBuildBusy(moduleId, true);
    setError('');
    if (showNotice) setNotice('Rendering module with netlistsvg...');
    try {
      const artifactSource = sourceModule ?? bundle?.modules[moduleId];
      const result = await window.electronAPI.compileCircuitModule(
        operationProjectId,
        moduleId,
        artifactSource ? projectSchematicArtifact(artifactSource) : undefined,
      );
      if (!result.schematic_path) {
        throw new Error('netlistsvg did not produce a module SVG.');
      }
      await onReloadProject(operationProjectId);
      if (showNotice && isActiveProject(operationProjectId)) setNotice('Module SVG updated');
      return isActiveProject(operationProjectId);
    } catch (buildError) {
      if (isActiveProject(operationProjectId)) {
        setError(buildError instanceof Error ? buildError.message : String(buildError));
        setNotice('');
      }
      return false;
    } finally {
      if (isActiveProject(operationProjectId)) setModulePreviewBuildBusy(moduleId, false);
    }
  }

  async function optimizeModuleSchematic(moduleId: string): Promise<void> {
    if (!currentProjectId || !project) return;
    const operationProjectId = currentProjectId;
    const sourceRevision = project.revision;
    setBusy(true);
    setError('');
    setNotice('Scoring deterministic layouts and preparing multimodal review...');
    try {
      const result = await window.electronAPI.optimizeCircuitLayout(operationProjectId, {
        moduleId,
        sourceRevision,
      });
      if (!isActiveProject(operationProjectId)) return;
      await onReloadProject(operationProjectId);
      if (!isActiveProject(operationProjectId)) return;
      setLayoutFeedback((current) => ({ ...current, [moduleId]: result }));
      const before = Math.round(result.initial_quality.readability_score);
      const after = Math.round(result.final_quality.readability_score);
      const review = result.llm_invoked ? `${result.rounds.length} visual round${result.rounds.length === 1 ? '' : 's'}` : 'deterministic scoring';
      setNotice(result.changed
        ? `Layout updated: readability ${before} → ${after} (${review})`
        : `Layout kept: readability ${after} (${review}, no better candidate)`);
      if (result.compile_warning) {
        setError(`Layout was saved, but the netlistsvg preview rebuild failed: ${result.compile_warning}`);
      }
    } catch (layoutError) {
      if (isActiveProject(operationProjectId)) {
        setError(layoutError instanceof Error ? layoutError.message : String(layoutError));
        setNotice('');
      }
    } finally {
      if (isActiveProject(operationProjectId)) setBusy(false);
    }
  }

  async function moveSchematicItem(moduleId: string, itemId: string, x: number, y: number): Promise<void> {
    const saved = await applyOperations(`Move schematic item ${itemId}`, [{
      op: 'move_schematic_item',
      module_id: moduleId,
      item_id: itemId,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
    }]);
    if (saved) {
      await buildModulePreview(moduleId, false);
      setNotice(`Moved ${itemId}`);
    }
  }

  async function resetSchematicItem(moduleId: string, itemId: string): Promise<void> {
    const saved = await applyOperations(`Reset schematic item ${itemId}`, [{
      op: 'reset_schematic_item',
      module_id: moduleId,
      item_id: itemId,
    }]);
    if (saved) {
      await buildModulePreview(moduleId, false);
      setNotice(`Reset ${itemId}`);
    }
  }

  async function resetSchematicLayout(moduleId: string, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) {
      setNotice('No schematic layout overrides to reset');
      return;
    }
    const saved = await applyOperations('Reset schematic layout', itemIds.map((itemId) => ({
      op: 'reset_schematic_item',
      module_id: moduleId,
      item_id: itemId,
    })));
    if (saved) {
      await buildModulePreview(moduleId, false);
      setNotice('Reset schematic layout');
    }
  }

  async function saveModuleSchematic(moduleId: string, moduleData: CircuitModule): Promise<boolean> {
    if (!currentProjectId) return false;
    const operationProjectId = currentProjectId;
    const previous = bundle?.modules[moduleId];
    if (!previous) {
      setError(`Cannot save schematic ${moduleId}: source module is not loaded`);
      return false;
    }
    const diff = diffModuleToOperations(previous, moduleData);
    if (diff.unsupported.length > 0) {
      setError(
        `Cannot save schematic ${moduleId}: command.v2 does not cover changed fields `
        + diff.unsupported.join(', '),
      );
      return false;
    }
    const saved = await applyModuleOperations(
      `Edit schematic ${moduleId}`,
      moduleId,
      previous.revision,
      diff.operations,
      moduleNotebookMarkdown(moduleId, moduleData),
    );
    if (saved) {
      setNotice('Schematic saved. Rebuilding the affected module SVG in the background...');
      // The editor draft still has the pre-apply revision; stamp the post-apply
      // revision so compile's schematic-document write matches disk.
      const artifactModule = diff.operations.length > 0
        ? { ...moduleData, revision: previous.revision + 1 }
        : moduleData;
      void buildModulePreview(moduleId, false, artifactModule).then((built) => {
        if (built && isActiveProject(operationProjectId)) {
          setNotice('Applied netlist and affected module SVG rebuilt');
        }
      });
    }
    return saved;
  }

  async function openModule(moduleId: string): Promise<void> {
    const moduleName = project?.modules.find((entry) => entry.id === moduleId)?.name;
    setHierarchyPath([{ moduleId, instanceName: moduleName }]);
    setHierarchyTrace(null);
    setSchematicLocateTarget(null);
    setActiveModuleId(moduleId);
    setView('module');
  }

  async function openChildModule(
    moduleId: string,
    instanceId: string,
    pinId?: string,
  ): Promise<void> {
    if (!selectedRef || !selectedModule) return;
    setSchematicLocateTarget(null);
    const instance = selectedModule.components.find((component) => component.id === instanceId);
    const child = bundle?.modules[moduleId];
    if (!instance || instance.type !== 'MODULE' || !child) {
      setError(`Cannot enter child module ${moduleId}: instance or module is unavailable.`);
      return;
    }
    const existingIndex = hierarchyPath.findIndex((entry) => entry.moduleId === moduleId);
    if (existingIndex >= 0) {
      setNotice(`Hierarchy cycle stopped at ${moduleId}.`);
      setHierarchyPath((current) => current.slice(0, existingIndex + 1));
    } else {
      setHierarchyPath((current) => {
        const base = current.at(-1)?.moduleId === selectedRef.id
          ? current
          : [{ moduleId: selectedRef.id, instanceName: selectedRef.name }];
        return [...base, {
          moduleId,
          instanceId,
          instanceName: instance.name,
        }];
      });
    }
    if (pinId) {
      const parentPin = instance.pins.find((pin) => pin.id === pinId);
      const childPort = child.ports.find((port) => port.id === pinId);
      if (parentPin && childPort) {
        setHierarchyTrace({
          id: `${Date.now()}-${instanceId}-${pinId}`,
          moduleId,
          net: childPort.net,
          netId: childPort.net_id,
          label: `${selectedRef.name}/${instance.name}.${parentPin.name}`,
        });
      } else {
        setHierarchyTrace(null);
        setError(`Cannot trace ${instance.name}.${pinId}: explicit child port mapping is missing.`);
      }
    } else {
      setHierarchyTrace(null);
    }
    setActiveModuleId(moduleId);
    setView('module');
  }

  function navigateHierarchy(index: number) {
    const target = hierarchyPath[index];
    if (!target) return;
    setHierarchyPath((current) => current.slice(0, index + 1));
    setHierarchyTrace(null);
    setSchematicLocateTarget(null);
    setActiveModuleId(target.moduleId);
    setView('module');
  }

  function backToHierarchyParent() {
    if (hierarchyPath.length <= 1) {
      setHierarchyPath([]);
      setHierarchyTrace(null);
      setView('board');
      return;
    }
    navigateHierarchy(hierarchyPath.length - 2);
  }

  function backToBoard() {
    setHierarchyPath([]);
    setHierarchyTrace(null);
    setSchematicLocateTarget(null);
    setView('board');
  }

  async function locateSchematicSearchResult(result: SchematicSearchResult) {
    const module = bundle?.modules[result.moduleId];
    if (!module) return;
    setHierarchyPath([{ moduleId: result.moduleId, instanceName: module.name }]);
    setHierarchyTrace(null);
    setActiveModuleId(result.moduleId);
    setView('module');
    setSchematicLocateTarget({
      id: `${Date.now()}-${result.id}`,
      moduleId: result.moduleId,
      kind: result.kind === 'net'
        ? 'net'
        : result.kind === 'module' ? 'module' : 'component',
      entityId: result.entityId,
      net: result.net,
      netId: result.netId,
    });
  }

  async function togglePreview(module: CircuitModuleRef): Promise<void> {
    const enabled = !(module.preview_enabled ?? true);
    await applyOperations(enabled ? 'Show module preview' : 'Hide module preview', [{
      op: 'set_module_preview',
      module_id: module.id,
      enabled,
    }]);
    if (enabled && !bundle?.module_previews[module.id]) {
      await buildModulePreview(module.id, false);
    }
  }

  async function runBuild(simulate: boolean) {
    if (!currentProjectId || !project) return;
    const operationProjectId = currentProjectId;
    if (!(await waitForModulePreviewBuilds())) {
      setError('Timed out waiting for module preview build to finish.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice(simulate ? 'Running system simulation...' : 'Building netlist and module SVG previews...');
    try {
      // Project compile assembles the system netlist and refreshes every module
      // SVG before returning, so the manifest never exposes a half-built module set.
      await window.electronAPI.compileCircuitProject(operationProjectId);
      if (simulate) {
        await window.electronAPI.simulateCircuitProject(operationProjectId);
      }
      const nextBuild = await window.electronAPI.readCircuitBuild(operationProjectId);
      if (isActiveProject(operationProjectId)) setBuild(nextBuild);
      await onReloadProject(operationProjectId);
      if (isActiveProject(operationProjectId)) setNotice(simulate ? 'System simulation complete' : 'Netlist and previews updated');
    } catch (buildError) {
      if (isActiveProject(operationProjectId)) {
        setError(buildError instanceof Error ? buildError.message : String(buildError));
        setNotice('');
      }
    } finally {
      if (isActiveProject(operationProjectId)) setBusy(false);
    }
  }

  async function saveDesignMemory(kind: 'template' | 'flow') {
    if (!currentProjectId) return;
    const operationProjectId = currentProjectId;
    if (!(await waitForModulePreviewBuilds())) {
      setError('Timed out waiting for module preview build to finish.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice(kind === 'template' ? 'Saving reusable design template...' : 'Saving design flow...');
    try {
      if (kind === 'template') {
        await window.electronAPI.compileCircuitProject(operationProjectId);
        const nextBuild = await window.electronAPI.readCircuitBuild(operationProjectId);
        if (isActiveProject(operationProjectId)) setBuild(nextBuild);
        await onReloadProject(operationProjectId);
      }
      const result = kind === 'template'
        ? await window.electronAPI.saveCircuitDesignTemplate(operationProjectId)
        : await window.electronAPI.saveCircuitDesignFlow(operationProjectId);
      await refreshDesignMemory();
      await onReferencesChanged?.();
      if (isActiveProject(operationProjectId)) setNotice(
        kind === 'template'
          ? `Saved template ${result.id}`
          : `Saved flow ${result.id}`,
      );
    } catch (saveError) {
      if (isActiveProject(operationProjectId)) {
        setError(saveError instanceof Error ? saveError.message : String(saveError));
        setNotice('');
      }
    } finally {
      if (isActiveProject(operationProjectId)) setBusy(false);
    }
  }

  async function openDesignMemoryItem(kind: 'template' | 'flow', id: string): Promise<void> {
    setError('');
    try {
      const result = await window.electronAPI.openCircuitDesignMemory({ kind, id });
      if (result) throw new Error(result);
      setNotice(`Opened ${kind} ${id}`);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    }
  }

  async function openProjectFolder(): Promise<void> {
    if (!currentProjectId) return;
    setError('');
    setNotice('');
    try {
      const openedPath = await window.electronAPI.openCircuitProjectFolder(currentProjectId);
      setNotice(`Opened project folder: ${openedPath}`);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    }
  }

  useEffect(() => {
    const format = defaultSchematicIoFormat(projectKind);
    setEdaExportForm((current) => (
      schematicIoFormats(projectKind).some((entry) => entry.value === current.format)
        ? current
        : { format, path: '' }
    ));
    setEdaImportForm((current) => (
      schematicIoFormats(projectKind).some((entry) => entry.value === current.format)
        ? current
        : { format, path: '' }
    ));
  }, [projectKind]);

  async function chooseSchematicExportPath(): Promise<void> {
    const selected = await window.electronAPI.chooseSchematicExportPath(edaExportForm.format);
    if (selected) setEdaExportForm((current) => ({ ...current, path: selected }));
  }

  async function chooseSchematicImportSource(): Promise<void> {
    const selected = await window.electronAPI.chooseSchematicImportSource(edaImportForm.format);
    if (selected) setEdaImportForm((current) => ({ ...current, path: selected }));
  }

  async function runSchematicExport(): Promise<void> {
    if (!currentProjectId || !project || !schematicIoEnabled || !edaExportForm.path.trim()) return;
    if ((edaExportForm.format === 'xschem' || edaExportForm.format === 'virtuoso') && !activeModuleId) {
      setError('Open a module before exporting for Analog IC projects.');
      return;
    }
    const operationProjectId = currentProjectId;
    setBusy(true);
    setError('');
    setEdaExportNotice('');
    setNotice(`Exporting ${edaExportForm.format} schematic...`);
    try {
      const result = await window.electronAPI.exportSchematicHandoff(operationProjectId, {
        format: edaExportForm.format,
        outputPath: edaExportForm.path.trim(),
        moduleId: activeModuleId ?? undefined,
        sourceRevision: project.revision,
      });
      if (isActiveProject(operationProjectId)) {
        setEdaExportNotice(result.output_path);
        setNotice(`Exported ${edaExportForm.format} to ${result.output_path}`);
      }
    } catch (exportError) {
      if (isActiveProject(operationProjectId)) {
        setError(exportError instanceof Error ? exportError.message : String(exportError));
        setNotice('');
      }
    } finally {
      if (isActiveProject(operationProjectId)) setBusy(false);
    }
  }

  async function runSchematicImport(): Promise<void> {
    if (!currentProjectId || !schematicIoEnabled || !edaImportForm.path.trim()) return;
    if (!activeModuleId) {
      setError('Open a module before importing a schematic.');
      return;
    }
    const operationProjectId = currentProjectId;
    setBusy(true);
    setError('');
    setEdaImportNotice('');
    setNotice(`Importing ${edaImportForm.format} schematic...`);
    try {
      const result = await window.electronAPI.importSchematicHandoff(operationProjectId, {
        format: edaImportForm.format,
        sourcePath: edaImportForm.path.trim(),
        moduleId: activeModuleId,
      });
      await onReloadProject(operationProjectId);
      if (isActiveProject(operationProjectId)) {
        setEdaImportNotice(`Imported ${result.created} component(s) (${result.fidelity ?? 'best-effort'})`);
        setNotice(`Imported ${result.created} component(s) from ${edaImportForm.format}`);
      }
    } catch (importError) {
      if (isActiveProject(operationProjectId)) {
        setError(importError instanceof Error ? importError.message : String(importError));
        setNotice('');
      }
    } finally {
      if (isActiveProject(operationProjectId)) setBusy(false);
    }
  }

  async function createProjectFromSavedTemplate(template: DesignMemoryItem): Promise<void> {
    setError('');
    try {
      await onCreateProjectFromTemplate(template.id, `${template.name} copy`);
      await refreshDesignMemory();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  async function runModuleSimulation() {
    if (!currentProjectId || !activeModuleId) return;
    const operationProjectId = currentProjectId;
    const operationModuleId = activeModuleId;
    setBusy(true);
    setError('');
    setNotice('Running module testbench...');
    try {
      const result = await window.electronAPI.simulateCircuitModule(operationProjectId, operationModuleId);
      if (isActiveProject(operationProjectId)) setModuleSimulation(result);
      await onReloadProject(operationProjectId);
      if (isActiveProject(operationProjectId)) setNotice('Module simulation complete');
    } catch (simulationError) {
      if (isActiveProject(operationProjectId)) {
        setError(simulationError instanceof Error ? simulationError.message : String(simulationError));
        setNotice('');
      }
    } finally {
      if (isActiveProject(operationProjectId)) setBusy(false);
    }
  }

  async function setSimulationProfile(simulationProfileId: string): Promise<void> {
    const analogProfile = project?.analog_ic_profile;
    if (!analogProfile || analogProfile.schema !== 'actoviq.analog-ic-profile.v2') return;
    await applyOperations('Set simulation execution profile', [{
      op: 'set_analog_ic_profile',
      profile: {
        ...analogProfile,
        simulation_profile_id: simulationProfileId,
      },
    }]);
  }

  async function setPdkBinding(logicalId: string): Promise<void> {
    if (!project || busy) return;
    const trimmed = logicalId.trim();
    if (!trimmed) return;
    const installation = registeredPdks.find((entry) => entry.logical_id === trimmed);
    if (!installation) {
      setError(`Registered PDK not found: ${trimmed}. Open Settings → IC tools and PDKs to register one.`);
      return;
    }
    const existing = project.analog_ic_profile;
    let simulationProfileId = existing?.schema === 'actoviq.analog-ic-profile.v2'
      ? existing.simulation_profile_id
      : (simulationProfiles[0]?.id ?? '');
    let nextProfiles = simulationProfiles;
    if (!simulationProfileId.trim()) {
      try {
        const settings = await window.electronAPI.getSettings();
        const workspaceRoot = useAppStore.getState().activeWorkspace?.root?.trim() || '';
        const defaultPdkRoot = typeof window.electronAPI.getDefaultPdkRoot === 'function'
          ? await window.electronAPI.getDefaultPdkRoot().catch(() => '')
          : '';
        const isAbsoluteRoot = (value: string) => (
          /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/')
        );
        const allowedRoots = [...new Set([
          workspaceRoot,
          installation.root?.trim() || '',
          settings.workspaceRoot?.trim() || '',
          settings.pdkInstallRoot?.trim() || '',
          typeof defaultPdkRoot === 'string' ? defaultPdkRoot.trim() : '',
        ].filter((root) => root && isAbsoluteRoot(root)))];
        if (!allowedRoots.length) {
          setError('Could not determine an allowed workspace/PDK root for the default ngspice profile. Set Workspace root or PDK install root in Settings, then retry.');
          return;
        }
        const defaultProfile: StoredExecutionProfile = {
          schema: 'actoviq.execution-profile.v1',
          id: 'ngspice-local',
          providerId: 'ngspice',
          target: navigator.platform.toLowerCase().includes('win') ? 'local_windows' : 'local_linux',
          executable: settings.ngspiceBin?.trim() || undefined,
          allowedRoots,
          environmentKeys: [],
          qualification: 'configured',
        };
        const registry = await window.electronAPI.saveExecutionProfile(defaultProfile);
        nextProfiles = registry.profiles.filter(
          (profile) => profile.providerId === 'ngspice' || profile.providerId === 'xyce',
        );
        setSimulationProfiles(nextProfiles);
        simulationProfileId = nextProfiles.find((profile) => profile.id === 'ngspice-local')?.id
          ?? nextProfiles[0]?.id
          ?? '';
      } catch (profileError) {
        setError(profileError instanceof Error
          ? profileError.message
          : 'Could not create a default ngspice execution profile. Add one in Settings first.');
        return;
      }
    }
    if (!simulationProfileId.trim()) {
      setError('Create an ngspice/Xyce execution profile in Settings before binding a PDK.');
      return;
    }
    const sizing = existing && typeof existing === 'object' && 'sizing' in existing && existing.sizing
      ? existing.sizing
      : { require_explicit_w_l: true as const, require_scale_suffix: true as const };
    await applyOperations(`Bind PDK ${installation.name}`, [{
      op: 'set_analog_ic_profile',
      profile: {
        schema: 'actoviq.analog-ic-profile.v2',
        simulation_profile_id: simulationProfileId,
        pdk_binding: {
          schema: 'actoviq.pdk-binding.v1',
          pdk_ref: installation.logical_id,
          ...(installation.fingerprint ? { fingerprint: installation.fingerprint } : {}),
          ...(installation.version ? { version: installation.version } : {}),
        },
        sizing,
      },
    }]);
  }

  async function setProjectKind(nextKind: ProjectKind): Promise<void> {
    if (!project || nextKind === projectKind || busy) return;
    const previousLabel = PROJECT_KIND_OPTIONS.find((entry) => entry.value === projectKind)?.label ?? projectKind;
    const nextLabel = PROJECT_KIND_OPTIONS.find((entry) => entry.value === nextKind)?.label ?? nextKind;
    const leavingIc = (projectKind === 'analog_ic' || projectKind === 'mixed_signal_ic')
      && nextKind !== 'analog_ic'
      && nextKind !== 'mixed_signal_ic'
      && Boolean(project.analog_ic_profile);
    const confirmed = window.confirm(
      leavingIc
        ? `Change project type from ${previousLabel} to ${nextLabel}?\n\nThe Analog IC profile will be cleared. Modules must remain valid for the new type.`
        : `Change project type from ${previousLabel} to ${nextLabel}?\n\nModules must remain valid for the new type.`,
    );
    if (!confirmed) return;
    await applyOperations(`Set project kind to ${nextKind}`, [{
      op: 'set_project_kind',
      project_kind: nextKind,
    }]);
  }

  async function choosePhysicalPath(
    key: keyof Pick<PhysicalVerificationForm, 'layout' | 'schematic' | 'ruleDeck' | 'techFile' | 'extracted' | 'setupFile' | 'deck' | 'lvsRun'>,
    label: string,
  ): Promise<void> {
    const selected = await window.electronAPI.choosePhysicalVerificationFile(label);
    if (selected) setPhysicalForm((current) => ({ ...current, [key]: selected }));
  }

  async function runPhysicalVerification(): Promise<void> {
    if (!currentProjectId || busy) return;
    setBusy(true);
    setError('');
    setPhysicalResult(null);
    setNotice(`Running ${physicalForm.operation.replaceAll('_', ' ')}...`);
    try {
      const result = await window.electronAPI.runPhysicalVerification(currentProjectId, { ...physicalForm });
      setPhysicalResult(result);
      setNotice(`Physical verification ${'status' in result ? result.status : result.execution_status}.`);
    } catch (physicalError) {
      setError(physicalError instanceof Error ? physicalError.message : String(physicalError));
      setNotice('');
    } finally {
      setBusy(false);
    }
  }

  async function copyModuleId(moduleId: string) {
    try {
      await navigator.clipboard.writeText(moduleId);
      setCopiedId(moduleId);
      window.setTimeout(() => setCopiedId(''), 1400);
    } catch {
      setError('Could not copy the module ID to the clipboard.');
    }
  }

  function beginModuleDrag(event: ReactPointerEvent, module: CircuitModuleRef) {
    if (event.button !== 0) return;
    if (event.altKey || spacePanActive) return;
    if ((event.target as HTMLElement).closest('button, input, textarea, label, [data-resize-handle]')) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = modulePreviewPositions[module.id] ?? module.position;
    let moved = false;
    const scale = zoom / 100;
    const move = (moveEvent: PointerEvent) => {
      if (!moved && Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) < 12) return;
      moved = true;
      setModulePreviewPositions((current) => ({
        ...current,
        [module.id]: {
          x: origin.x + (moveEvent.clientX - startX) / scale,
          y: origin.y + (moveEvent.clientY - startY) / scale,
        },
      }));
    };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) return;
      const position = {
        x: origin.x + (upEvent.clientX - startX) / scale,
        y: origin.y + (upEvent.clientY - startY) / scale,
      };
      void applyOperations(`Move module ${module.name}`, [{
        op: 'move_module',
        module_id: module.id,
        x: Math.round(position.x),
        y: Math.round(position.y),
      }]).then((saved) => {
        if (!saved) return;
        setModulePreviewPositions((current) => {
          const next = { ...current };
          delete next[module.id];
          return next;
        });
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }

  function beginModuleResize(event: ReactPointerEvent, module: CircuitModuleRef) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = modulePreviewSizes[module.id] ?? module.size;
    const scale = zoom / 100;
    let resized = false;
    const nextSize = (clientX: number, clientY: number) => ({
      width: Math.max(260, Math.min(760, origin.width + (clientX - startX) / scale)),
      height: Math.max(220, Math.min(640, origin.height + (clientY - startY) / scale)),
    });
    const move = (moveEvent: PointerEvent) => {
      if (!resized && Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) < 6) return;
      resized = true;
      setModulePreviewSizes((current) => ({
        ...current,
        [module.id]: nextSize(moveEvent.clientX, moveEvent.clientY),
      }));
    };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!resized) return;
      const size = nextSize(upEvent.clientX, upEvent.clientY);
      void applyOperations(`Resize module ${module.name}`, [{
        op: 'resize_module',
        module_id: module.id,
        width: Math.round(size.width),
        height: Math.round(size.height),
      }]).then((saved) => {
        if (!saved) return;
        setModulePreviewSizes((current) => {
          const next = { ...current };
          delete next[module.id];
          return next;
        });
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }

  async function arrangeModules() {
    if (!project) return;
    const operations = project.modules.map((module, index) => ({
      op: 'move_module',
      module_id: module.id,
      x: 100 + (index % 3) * 400,
      y: 110 + Math.floor(index / 3) * 340,
    }));
    await applyOperations('Arrange module canvas', operations);
  }

  function zoomCanvasAroundPoint(nextZoom: number, focalX: number, focalY: number) {
    const panel = canvasPanelRef.current;
    const clampedZoom = clampCanvasZoom(nextZoom);
    const currentZoom = zoomRef.current;
    if (!panel || clampedZoom === currentZoom) return;
    const oldScale = currentZoom / 100;
    const nextScale = clampedZoom / 100;
    const pad = BOARD_VIEWPORT_PADDING;
    const boardX = (panel.scrollLeft + focalX - pad) / oldScale;
    const boardY = (panel.scrollTop + focalY - pad) / oldScale;
    pendingCanvasScrollRef.current = {
      left: boardX * nextScale - focalX + pad,
      top: boardY * nextScale - focalY + pad,
    };
    setZoom(clampedZoom);
  }

  function handleCanvasWheel(event: WheelEvent) {
    if (viewRef.current !== 'board') return;
    event.preventDefault();
    const panel = canvasPanelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    zoomCanvasAroundPoint(
      zoomRef.current + (event.deltaY < 0 ? 10 : -10),
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  }
  handleCanvasWheelRef.current = handleCanvasWheel;

  function zoomCanvasAtPanelCenter(nextZoom: number) {
    const panel = canvasPanelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    zoomCanvasAroundPoint(nextZoom, rect.width / 2, rect.height / 2);
  }

  function resetCanvasView() {
    pendingCanvasScrollRef.current = null;
    setZoom(65);
    const panel = canvasPanelRef.current;
    if (!panel) return;
    window.requestAnimationFrame(() => {
      const scale = 0.65;
      panel.scrollLeft = Math.round(boardMetrics.originX * scale);
      panel.scrollTop = Math.round(boardMetrics.originY * scale);
      setCanvasScroll({ left: panel.scrollLeft, top: panel.scrollTop });
    });
  }

  function handleCanvasKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (view !== 'board' || isEditableTarget(event.target)) return;
    if (event.key === ' ') {
      event.preventDefault();
      setSpacePanActive(true);
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomCanvasAtPanelCenter(zoom + 10);
      return;
    }
    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomCanvasAtPanelCenter(zoom - 10);
      return;
    }
    if (event.key === 'Home' || event.key === '0') {
      event.preventDefault();
      resetCanvasView();
    }
  }

  function handleCanvasKeyUp(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === ' ') {
      event.preventDefault();
      setSpacePanActive(false);
    }
  }

  function handleCanvasScroll(event: ReactUIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    setCanvasScroll({ left: target.scrollLeft, top: target.scrollTop });
  }

  function beginCanvasPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (view !== 'board') return;
    const leftTemporaryPan = event.button === 0 && (event.altKey || spacePanActive);
    const rightPan = event.button === 2;
    if (event.button !== 1 && !leftTemporaryPan && !rightPan) return;
    const panel = canvasPanelRef.current;
    if (!panel) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = panel.scrollLeft;
    const startTop = panel.scrollTop;
    let moved = false;
    if (rightPan) suppressContextMenuRef.current = false;
    setIsPanning(true);
    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      moved = true;
      if (rightPan) {
        // Sticky suppress: Linux/Electron may emit contextmenu after pointerup,
        // sometimes more than once. Keep the flag until a short timeout clears it.
        suppressContextMenuRef.current = true;
        setContextMenu(null);
      }
      panel.scrollLeft = startLeft - dx;
      panel.scrollTop = startTop - dy;
      setCanvasScroll({ left: panel.scrollLeft, top: panel.scrollTop });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setIsPanning(false);
      if (rightPan && moved) {
        suppressContextMenuRef.current = true;
        setContextMenu(null);
        window.setTimeout(() => {
          suppressContextMenuRef.current = false;
        }, 250);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
  }

  function openCanvasContextMenu(
    event: ReactMouseEvent,
    moduleId?: string,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (suppressContextMenuRef.current) {
      setContextMenu(null);
      return;
    }
    const panel = canvasPanelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const scale = zoom / 100;
    setContextMenu({
      // Clamp to the viewport so the menu never opens partly off-screen near an edge.
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 200)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 150)),
      moduleId,
      boardPosition: {
        x: Math.round((panel.scrollLeft + event.clientX - rect.left - 20) / scale - boardMetrics.originX),
        y: Math.round((panel.scrollTop + event.clientY - rect.top - 20) / scale - boardMetrics.originY),
      },
    });
  }

  function openAddModuleEditor(position: { x: number; y: number }) {
    setContextMenu(null);
    setModuleEditorError('');
    setModuleEditor({
      mode: 'add',
      id: `module-${Date.now().toString(36)}`,
      name: 'New circuit module',
      kind: 'module',
      functionText: '',
      parametersText: '',
      position,
    });
  }

  function openEditModuleEditor(module: CircuitModuleRef) {
    setContextMenu(null);
    setActiveModuleId(module.id);
    setModuleEditorError('');
    setModuleEditor({
      mode: 'edit',
      id: module.id,
      name: module.name,
      kind: module.kind,
      functionText: module.function ?? '',
      parametersText: formatParameters(module.parameters),
      position: module.position,
    });
  }

  async function createProjectFromEmptyState() {
    if (!emptyProjectForm) return;
    const name = emptyProjectForm.name.trim();
    if (!name || busy || emptyProjectCreateRef.current) return;
    emptyProjectCreateRef.current = true;
    setError('');
    setNotice('');
    try {
      await onCreateProject(emptyProjectForm.demo, name, emptyProjectForm.projectKind);
      setEmptyProjectForm(null);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      emptyProjectCreateRef.current = false;
    }
  }

  function handleEmptyProjectFormKeyDown(event: ReactKeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void createProjectFromEmptyState();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setEmptyProjectForm(null);
    }
  }

  async function saveModuleEditor() {
    if (!moduleEditor || !project) return;
    const id = moduleEditor.id.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
      setModuleEditorError('ID may contain lowercase letters, numbers, hyphens, and underscores.');
      return;
    }
    if (!moduleEditor.name.trim() || !moduleEditor.kind.trim()) {
      setModuleEditorError('Name and kind are required.');
      return;
    }
    if (moduleEditor.mode === 'add' && project.modules.some((module) => module.id === id)) {
      setModuleEditorError(`Module ID "${id}" already exists.`);
      return;
    }
    let parameters: Record<string, string>;
    try {
      parameters = parseParameters(moduleEditor.parametersText);
    } catch (parameterError) {
      setModuleEditorError(parameterError instanceof Error ? parameterError.message : String(parameterError));
      return;
    }
    const operation = moduleEditor.mode === 'add'
      ? {
          op: 'upsert_module',
          module_ref: {
            id,
            name: moduleEditor.name.trim(),
            kind: moduleEditor.kind.trim(),
            function: moduleEditor.functionText.trim(),
            parameters,
            notes: '',
            preview_enabled: false,
            source: `modules/${id}/module.circuit.json`,
            position: moduleEditor.position,
            size: { width: 320, height: 250 },
            ports: [
              { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
              { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
              { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
            ],
          },
          module: {
            schema: 'actoviq.module.v1',
            module_id: id,
            name: moduleEditor.name.trim(),
            revision: 0,
            ports: [
              { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
              { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
              { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
            ],
            components: [],
            wires: [],
            annotations: [],
          },
        }
      : {
          op: 'set_module_metadata',
          module_id: id,
          name: moduleEditor.name.trim(),
          kind: moduleEditor.kind.trim(),
          function: moduleEditor.functionText.trim(),
          parameters,
        };
    const saved = await applyOperations(
      moduleEditor.mode === 'add' ? `Add module ${id}` : `Edit module ${id}`,
      [operation],
    );
    if (saved) {
      setActiveModuleId(id);
      setModuleEditor(null);
      setModuleEditorError('');
    }
  }

  if (!project || !bundle) {
    return (
      <div style={styles.empty} data-testid="circuit-empty-state">
        <div style={styles.emptyBadge}>SCHEMATIC HUB</div>
        <h1 style={styles.emptyTitle}>Start a modular circuit project</h1>
        <p style={styles.emptyText}>
          Claude Code, Codex, and this desktop share the same module netlists and netlistsvg output.
        </p>
        <div style={styles.actionRow}>
          <button
            type="button"
            style={styles.primaryButton}
            onClick={() => {
              setError('');
              setNotice('');
              setEmptyProjectForm({ demo: false, name: 'New circuit project', projectKind: 'simulation' });
            }}
            disabled={busy}
            title="Create project"
            aria-label="Create project"
            data-testid="create-project"
          >
            + Project
          </button>
        </div>
        {emptyProjectForm ? (
          <div
            style={styles.emptyCreatePanel}
            data-testid="empty-project-create-panel"
            onKeyDown={handleEmptyProjectFormKeyDown}
          >
            <div style={styles.emptyCreateTitle}>New project</div>
            <input
              value={emptyProjectForm.name}
              onChange={(event) => setEmptyProjectForm({ ...emptyProjectForm, name: event.target.value })}
              placeholder="Project name"
              style={styles.emptyProjectInput}
              disabled={busy}
              autoFocus
              data-testid="empty-project-name-input"
            />
            <label style={styles.emptyProjectKindField}>
              <span style={styles.emptyProjectKindLabel}>Project kind</span>
              <select
                value={emptyProjectForm.projectKind}
                onChange={(event) => setEmptyProjectForm({
                  ...emptyProjectForm,
                  projectKind: event.target.value as ProjectKind,
                })}
                style={styles.emptyProjectKindSelect}
                disabled={busy}
                data-testid="empty-project-kind-select"
              >
                {PROJECT_KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <div style={styles.emptyCreateActions}>
              <button
                type="button"
                style={styles.secondaryButton}
                onClick={() => setEmptyProjectForm(null)}
                disabled={busy}
                title="Cancel project creation"
                aria-label="Cancel project creation"
                data-testid="empty-project-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                style={styles.primaryButton}
                onClick={() => void createProjectFromEmptyState()}
                disabled={busy || !emptyProjectForm.name.trim()}
                title="Create project"
                aria-label="Create project"
                data-testid="empty-project-create-submit"
              >
                Create
              </button>
            </div>
          </div>
        ) : null}
        {error ? (
          <div style={{ ...styles.emptyNotice, ...styles.noticeError }} role="alert">
            {error}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      style={styles.root}
      data-testid="circuit-workbench"
      data-project-id={project.project_id}
      data-action-project-id={currentProjectId ?? ''}
      data-hierarchy-path={hierarchyPath.map((entry) => entry.moduleId).join('/')}
      data-preview-build-modules={Object.keys(modulePreviewBusy).sort().join(',')}
      data-last-preview-build-module={lastPreviewBuildModule}
    >
      <header style={styles.header} className="av-workbench-header">
        <div style={styles.titleBlock} className="av-workbench-header__title">
          <div style={styles.eyebrow}>Schematic Module Hub</div>
          <div style={styles.projectTitle} data-testid="project-title" data-project-id={project.project_id}>
            {project.name}
          </div>
          <div style={styles.projectMeta} data-testid="project-meta">
            revision {project.revision} | {project.modules.length} modules
            {build ? ` | ${build.manifest.status}` : ''}
            {build && (build.manifest.source_revision ?? build.manifest.revision) !== project.revision ? ' | build stale' : ''}
            {erc ? ` | ERC ${erc.status}` : ''}
          </div>
          <label style={styles.projectKindField} data-testid="project-kind-editor">
            <span>Type</span>
            <select
              value={projectKind}
              onChange={(event) => { void setProjectKind(event.target.value as ProjectKind); }}
              disabled={busy}
              aria-label="Project type"
              data-testid="project-kind-select"
            >
              {PROJECT_KIND_OPTIONS.map((entry) => (
                <option key={entry.value} value={entry.value}>{entry.label}</option>
              ))}
            </select>
          </label>
          {projectKind === 'analog_ic' || projectKind === 'mixed_signal_ic' ? (
            <label style={styles.simulationProfile} data-testid="project-pdk-binding">
              <span>PDK</span>
              <select
                value={projectPdkRef}
                onChange={(event) => { void setPdkBinding(event.target.value); }}
                disabled={busy || registeredPdks.length === 0}
                aria-label="Bind registered PDK"
                data-testid="project-pdk-select"
              >
                <option value="">
                  {registeredPdks.length === 0
                    ? 'No registered PDK (open Settings)'
                    : project?.analog_ic_profile?.schema === 'actoviq.analog-ic-profile.v1'
                      ? 'Legacy profile — select PDK to migrate'
                      : 'Bind registered PDK...'}
                </option>
                {projectPdkRef
                  && !registeredPdks.some((entry) => entry.logical_id === projectPdkRef) ? (
                    <option value={projectPdkRef}>
                      {projectPdkRef} · not in registry
                    </option>
                  ) : null}
                {registeredPdks.map((entry) => (
                  <option key={entry.installation_id || entry.logical_id} value={entry.logical_id}>
                    {entry.name}
                    {entry.process ? ` · ${entry.process}` : ''}
                    {entry.version ? ` · ${entry.version}` : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {projectKind === 'analog_ic' || projectKind === 'mixed_signal_ic' ? (
            <label style={styles.simulationProfile} data-testid="project-simulation-profile">
              <span>Simulation</span>
              <select
                value={projectSimulationProfileId}
                onChange={(event) => { void setSimulationProfile(event.target.value); }}
                disabled={busy || project.analog_ic_profile?.schema !== 'actoviq.analog-ic-profile.v2'}
                aria-label="Project simulation execution profile"
              >
                <option value="">
                  {project.analog_ic_profile?.schema === 'actoviq.analog-ic-profile.v1'
                    ? 'Legacy ngspice profile (explicit migration required)'
                    : projectPdkRef
                      ? 'Select execution profile...'
                      : 'Configure PDK binding first'}
                </option>
                {projectSimulationProfileId
                  && !simulationProfiles.some((profile) => profile.id === projectSimulationProfileId) ? (
                    <option value={projectSimulationProfileId}>
                      {projectSimulationProfileId} · unavailable
                    </option>
                  ) : null}
                {simulationProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.id} · {profile.providerId} · {profile.target}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {projectKind === 'analog_ic' || projectKind === 'mixed_signal_ic' ? (
            <button
              type="button"
              style={styles.physicalButton}
              onClick={() => setPhysicalOpen(true)}
              data-testid="open-physical-verification"
            >
              Physical verification
            </button>
          ) : null}
          <button
            type="button"
            style={pendingCommands.length > 0 ? styles.pendingReviewButtonActive : styles.pendingReviewButton}
            onClick={() => {
              setErcOpen(false);
              setHistoryOpen(false);
              setPendingCommandsOpen(true);
              void refreshPendingCommands();
            }}
            data-testid="open-pending-command-review"
          >
            Agent proposals {pendingCommands.length}
          </button>
        </div>
        <WorkbenchToolbar
          view={view}
          zoom={zoom}
          busy={busy}
          previewBusy={anyPreviewBusy}
          erc={erc ? {
            status: erc.status,
            errors: erc.summary.errors,
            warnings: erc.summary.warnings,
          } : null}
          showSchematicIo={schematicIoEnabled}
          onBackToBoard={backToBoard}
          onArrangeModules={arrangeModules}
          onZoomOut={() => zoomCanvasAtPanelCenter(zoom - 10)}
          onZoomIn={() => zoomCanvasAtPanelCenter(zoom + 10)}
          onBuild={() => { void runBuild(false); }}
          onSimulate={() => { void runBuild(true); }}
          onSaveTemplate={() => { void saveDesignMemory('template'); }}
          onSaveFlow={() => { void saveDesignMemory('flow'); }}
          onOpenEdaImport={() => {
            setEdaImportNotice('');
            setEdaImportOpen(true);
          }}
          onOpenEdaExport={() => {
            setEdaExportNotice('');
            setEdaExportOpen(true);
          }}
          onOpenErc={() => {
            setHistoryOpen(false);
            setPendingCommandsOpen(false);
            setErcOpen(true);
          }}
          onOpenHistory={() => {
            setErcOpen(false);
            setPendingCommandsOpen(false);
            setHistoryOpen(true);
          }}
          onOpenFolder={() => { void openProjectFolder(); }}
        />
      </header>

      {view === 'module' && hierarchyPath.length > 0 ? (
        <nav
          style={styles.hierarchyBar}
          aria-label="Schematic hierarchy"
          data-testid="schematic-hierarchy-breadcrumb"
          data-instance-path={hierarchyPath.map((entry) => entry.instanceId || entry.moduleId).join('/')}
        >
          <button
            type="button"
            style={styles.hierarchyBackButton}
            onClick={backToHierarchyParent}
            data-testid="schematic-hierarchy-parent"
          >
            {hierarchyPath.length > 1 ? 'Parent' : 'All modules'}
          </button>
          {hierarchyPath.map((entry, index) => {
            const moduleRef = project.modules.find((candidate) => candidate.id === entry.moduleId);
            return (
              <span key={`${entry.moduleId}-${index}`} style={styles.hierarchyCrumbGroup}>
                {index > 0 ? <span style={styles.hierarchySeparator}>/</span> : null}
                <button
                  type="button"
                  style={{
                    ...styles.hierarchyCrumb,
                    ...(index === hierarchyPath.length - 1 ? styles.hierarchyCrumbActive : {}),
                  }}
                  onClick={() => navigateHierarchy(index)}
                  data-testid={`schematic-hierarchy-crumb-${index}`}
                >
                  {entry.instanceName ? `${entry.instanceName}:` : ''}
                  {moduleRef?.name || entry.moduleId}
                </button>
              </span>
            );
          })}
          <button
            type="button"
            style={styles.hierarchySearchButton}
            onClick={() => setSchematicSearchOpen((current) => !current)}
            data-testid="schematic-search-toggle"
          >
            Find
          </button>
          {hierarchyTrace ? (
            <span style={styles.hierarchyTrace} data-testid="schematic-hierarchy-trace">
              Trace {hierarchyTrace.label} → {hierarchyTrace.netId || hierarchyTrace.net}
            </span>
          ) : null}
        </nav>
      ) : null}
      {view === 'module' && schematicSearchOpen ? (
        <section style={styles.schematicSearch} data-testid="schematic-search-panel">
          <input
            style={styles.schematicSearchInput}
            value={schematicSearchQuery}
            onChange={(event) => setSchematicSearchQuery(event.target.value)}
            placeholder="Find refdes, net, model, or module instance"
            aria-label="Find schematic entity"
            data-testid="schematic-search-input"
            autoFocus
          />
          {schematicSearchQuery.trim() ? (
            <div style={styles.schematicSearchResults} data-testid="schematic-search-results">
              {schematicSearchResults.length === 0 ? (
                <div style={styles.schematicSearchEmpty}>No schematic matches.</div>
              ) : null}
              {schematicSearchResults.map((result) => (
                <button
                  key={result.id}
                  type="button"
                  style={styles.schematicSearchResult}
                  onClick={() => void locateSchematicSearchResult(result)}
                  data-testid={`schematic-search-result-${result.kind}-${result.moduleId}-${result.entityId || 'module'}`}
                >
                  <span style={styles.schematicSearchKind}>{result.kind.replace('_', ' ')}</span>
                  <strong>{result.title}</strong>
                  <small>{result.subtitle}</small>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {(error || notice) && (
        <div style={{ ...styles.notice, ...(error ? styles.noticeError : {}) }} role={error ? 'alert' : 'status'}>
          {error || notice}
        </div>
      )}

      {physicalOpen ? (
        <div style={styles.historyOverlay} data-testid="physical-verification-dialog">
          <section className="av-sheet" aria-label="External physical verification">
            <div className="av-sheet__header">
              <div>
                <div className="av-sheet__title">External physical verification</div>
                <div className="av-sheet__subtitle">Rule decks remain in the selected PDK installation and are never modified.</div>
              </div>
              <button type="button" className="av-btn av-btn--secondary" onClick={() => setPhysicalOpen(false)} disabled={busy}>
                Close
              </button>
            </div>
            <div className="av-sheet__body">
              <label className="av-form-field">
                <span>Operation</span>
                <select
                  value={physicalForm.operation}
                  onChange={(event) => setPhysicalForm((current) => ({
                    ...current,
                    operation: event.target.value as PhysicalVerificationForm['operation'],
                  }))}
                  data-testid="physical-operation"
                >
                  <option value="klayout_drc">KLayout DRC</option>
                  <option value="klayout_lvs">KLayout LVS</option>
                  <option value="magic_extract">Magic extraction</option>
                  <option value="magic_pex">Magic parasitic extraction</option>
                  <option value="netgen_lvs">Netgen LVS</option>
                  <option value="post_layout_simulation">Post-layout simulation (clean LVS required)</option>
                </select>
              </label>
              {physicalForm.operation !== 'netgen_lvs' ? (
                <PhysicalPathField label="Layout" value={physicalForm.layout} onChange={(value) => setPhysicalForm((current) => ({ ...current, layout: value }))} onBrowse={() => choosePhysicalPath('layout', 'layout')} />
              ) : (
                <PhysicalPathField label="Extracted netlist" value={physicalForm.extracted} onChange={(value) => setPhysicalForm((current) => ({ ...current, extracted: value }))} onBrowse={() => choosePhysicalPath('extracted', 'extracted netlist')} />
              )}
              {physicalForm.operation === 'klayout_drc' || physicalForm.operation === 'klayout_lvs' ? (
                <PhysicalPathField label="KLayout rule deck" value={physicalForm.ruleDeck} onChange={(value) => setPhysicalForm((current) => ({ ...current, ruleDeck: value }))} onBrowse={() => choosePhysicalPath('ruleDeck', 'KLayout rule deck')} />
              ) : null}
              {physicalForm.operation === 'klayout_lvs' || physicalForm.operation === 'netgen_lvs' || physicalForm.operation === 'post_layout_simulation' ? (
                <PhysicalPathField label="Schematic SPICE/CDL" value={physicalForm.schematic} onChange={(value) => setPhysicalForm((current) => ({ ...current, schematic: value }))} onBrowse={() => choosePhysicalPath('schematic', 'schematic netlist')} />
              ) : null}
              {physicalForm.operation === 'magic_extract' || physicalForm.operation === 'magic_pex' ? (
                <>
                  <PhysicalPathField label="Magic technology/rc file" value={physicalForm.techFile} onChange={(value) => setPhysicalForm((current) => ({ ...current, techFile: value }))} onBrowse={() => choosePhysicalPath('techFile', 'Magic technology file')} />
                  <label className="av-form-field"><span>Top cell</span><input value={physicalForm.topCell} onChange={(event) => setPhysicalForm((current) => ({ ...current, topCell: event.target.value }))} /></label>
                </>
              ) : null}
              {physicalForm.operation === 'netgen_lvs' ? (
                <>
                  <PhysicalPathField label="Netgen setup" value={physicalForm.setupFile} onChange={(value) => setPhysicalForm((current) => ({ ...current, setupFile: value }))} onBrowse={() => choosePhysicalPath('setupFile', 'Netgen setup file')} />
                  <label className="av-form-field"><span>Extracted cell</span><input value={physicalForm.extractedCell} onChange={(event) => setPhysicalForm((current) => ({ ...current, extractedCell: event.target.value }))} /></label>
                  <label className="av-form-field"><span>Schematic cell</span><input value={physicalForm.schematicCell} onChange={(event) => setPhysicalForm((current) => ({ ...current, schematicCell: event.target.value }))} /></label>
                </>
              ) : null}
              {physicalForm.operation === 'post_layout_simulation' ? (
                <>
                  <PhysicalPathField label="Self-contained PEX testbench" value={physicalForm.deck} onChange={(value) => setPhysicalForm((current) => ({ ...current, deck: value }))} onBrowse={() => choosePhysicalPath('deck', 'post-layout simulation deck')} />
                  <PhysicalPathField label="Clean KLayout LVS run.json" value={physicalForm.lvsRun} onChange={(value) => setPhysicalForm((current) => ({ ...current, lvsRun: value }))} onBrowse={() => choosePhysicalPath('lvsRun', 'clean LVS run result')} />
                  <p className="av-form-hint">The deck is copied into the project run directory; use absolute model/include paths. Layout and schematic hashes must match the selected clean LVS result.</p>
                </>
              ) : null}
              <button type="button" className="av-btn av-btn--primary" onClick={() => { void runPhysicalVerification(); }} disabled={busy} data-testid="run-physical-verification">
                {busy ? 'Running...' : 'Run controlled provider'}
              </button>
              {physicalForm.layout ? (
                <button
                  type="button"
                  className="av-btn av-btn--secondary"
                  onClick={() => {
                    if (!currentProjectId) return;
                    void window.electronAPI.openPhysicalArtifact(currentProjectId, physicalForm.layout);
                  }}
                  data-testid="open-physical-layout"
                >
                  Open layout externally
                </button>
              ) : null}
              {physicalResult ? (
                <div className={`av-form-status${(
                  'status' in physicalResult ? physicalResult.status === 'passed' : physicalResult.ok
                ) ? '' : ' av-form-status--error'}`} data-testid="physical-verification-result">
                  <strong>
                    {'kind' in physicalResult ? physicalResult.kind : 'post_layout_simulation'}:
                    {'status' in physicalResult ? ` ${physicalResult.status}` : ` ${physicalResult.execution_status}`}
                  </strong>
                  {'artifacts' in physicalResult ? <div>{physicalResult.artifacts.length} artifacts</div> : null}
                  {'artifacts' in physicalResult ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {physicalResult.artifacts.map((artifact) => (
                        <button
                          key={`${artifact.kind}-${artifact.path}`}
                          type="button"
                          className="av-btn av-btn--secondary"
                          onClick={() => {
                            if (!currentProjectId) return;
                            void window.electronAPI.openPhysicalArtifact(currentProjectId, artifact.path);
                          }}
                        >
                          Open {artifact.kind}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {'metadata' in physicalResult && typeof physicalResult.metadata.violation_count === 'number' ? (
                    <div>Violations: {physicalResult.metadata.violation_count}</div>
                  ) : null}
                  {'metadata' in physicalResult && Array.isArray(physicalResult.metadata.items) ? (
                    <pre style={{ maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                      {physicalResult.metadata.items.slice(0, 20).map((item) => JSON.stringify(item)).join('\n')}
                    </pre>
                  ) : null}
                  {'diagnostics' in physicalResult && Array.isArray(physicalResult.diagnostics)
                    ? physicalResult.diagnostics.map((diagnostic, index) => <div key={`${diagnostic}-${index}`}>{diagnostic}</div>)
                    : null}
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {edaImportOpen ? (
        <div style={styles.historyOverlay} data-testid="eda-import-dialog">
          <section className="av-sheet" aria-label="Import external schematic">
            <div className="av-sheet__header">
              <div>
                <div className="av-sheet__title">Import schematic</div>
                <div className="av-sheet__subtitle">
                  Choose the source EDA format, then select a schematic file or folder.
                </div>
              </div>
              <button
                type="button"
                className="av-btn av-btn--secondary"
                onClick={() => setEdaImportOpen(false)}
                disabled={busy}
                data-testid="close-eda-import"
              >
                Close
              </button>
            </div>
            <div className="av-sheet__body">
              <div className="av-form-field">
                <span>Source format</span>
                <div className="av-form-checks">
                  {schematicFormats.map((entry) => (
                    <label key={entry.value} className="av-form-check">
                      <input
                        type="radio"
                        name="eda-import-format"
                        checked={edaImportForm.format === entry.value}
                        onChange={() => setEdaImportForm((current) => ({ ...current, format: entry.value, path: '' }))}
                        disabled={busy}
                        data-testid={`eda-import-format-${entry.value}`}
                      />
                      {entry.label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="av-form-field">
                <span>Source path</span>
                <div style={styles.edaMappingRow}>
                  <input
                    className="av-form-control"
                    value={edaImportForm.path}
                    readOnly
                    placeholder="Select an external schematic"
                    data-testid="eda-import-source-path"
                  />
                  <button
                    type="button"
                    className="av-btn av-btn--secondary"
                    onClick={() => void chooseSchematicImportSource()}
                    disabled={busy}
                    data-testid="eda-import-choose-source"
                  >
                    Choose...
                  </button>
                </div>
                <p className="av-form-hint">
                  Imports into the currently open module as Vibe Analog-native blocks.
                  {edaImportForm.format === 'altium' || edaImportForm.format === 'allegro'
                    ? ' Altium/Allegro direct import is not available yet — use KiCad (.kicad_sch).'
                    : ''}
                </p>
              </div>
              {edaImportNotice ? (
                <div className="av-form-status av-form-status--ok" data-testid="eda-import-result">
                  {edaImportNotice}
                </div>
              ) : null}
            </div>
            <div className="av-sheet__footer">
              <button
                type="button"
                className="av-btn av-btn--primary"
                onClick={() => void runSchematicImport()}
                disabled={busy || !edaImportForm.path.trim() || !activeModuleId}
                data-testid="run-eda-import"
              >
                {busy ? 'Importing...' : 'Import'}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {edaExportOpen ? (
        <div style={styles.historyOverlay} data-testid="eda-export-dialog">
          <section className="av-sheet" aria-label="Export schematic">
            <div className="av-sheet__header">
              <div>
                <div className="av-sheet__title">Export schematic</div>
                <div className="av-sheet__subtitle">
                  Choose a target EDA format and output path. Revision {project.revision}.
                </div>
              </div>
              <button
                type="button"
                className="av-btn av-btn--secondary"
                onClick={() => setEdaExportOpen(false)}
                disabled={busy}
                data-testid="close-eda-export"
              >
                Close
              </button>
            </div>
            <div className="av-sheet__body">
              <div className="av-form-field">
                <span>Target format</span>
                <div className="av-form-checks">
                  {schematicFormats.map((entry) => (
                    <label key={entry.value} className="av-form-check">
                      <input
                        type="radio"
                        name="eda-export-format"
                        checked={edaExportForm.format === entry.value}
                        onChange={() => setEdaExportForm((current) => ({ ...current, format: entry.value, path: '' }))}
                        disabled={busy}
                        data-testid={`eda-export-format-${entry.value}`}
                      />
                      {entry.label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="av-form-field">
                <span>Output path</span>
                <div style={styles.edaMappingRow}>
                  <input
                    className="av-form-control"
                    value={edaExportForm.path}
                    readOnly
                    placeholder={edaExportForm.format === 'xschem' ? 'Select .sch output file' : 'Select output folder'}
                    data-testid="eda-export-output-path"
                  />
                  <button
                    type="button"
                    className="av-btn av-btn--secondary"
                    onClick={() => void chooseSchematicExportPath()}
                    disabled={busy}
                    data-testid="eda-export-choose-output"
                  >
                    Choose...
                  </button>
                </div>
              </div>
              {edaExportNotice ? (
                <div className="av-form-status av-form-status--ok" data-testid="eda-export-result">
                  {edaExportNotice}
                </div>
              ) : null}
            </div>
            <div className="av-sheet__footer">
              <button
                type="button"
                className="av-btn av-btn--primary"
                onClick={() => void runSchematicExport()}
                disabled={busy || !edaExportForm.path.trim()}
                data-testid="run-eda-export"
              >
                {busy ? 'Exporting...' : 'Export'}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {ercOpen ? (
        <div style={styles.historyOverlay} data-testid="project-erc-panel">
          <section className="av-sheet" style={{ width: 520 }} aria-label="Electrical rules check">
            <div className="av-sheet__header">
              <div>
                <div className="av-sheet__title">Electrical Rules Check</div>
                <div className="av-sheet__subtitle">
                  Revision {erc?.source_revision ?? project.revision} | {erc?.summary.errors ?? 0} errors | {erc?.summary.warnings ?? 0} warnings
                </div>
              </div>
              <button
                type="button"
                className="av-btn av-btn--secondary"
                onClick={() => setErcOpen(false)}
                aria-label="Close electrical rules check"
                data-testid="close-project-erc"
              >
                Close
              </button>
            </div>
            <div style={styles.historyList}>
              {!erc || erc.diagnostics.length === 0 ? (
                <div style={styles.ercClean} data-testid="erc-clean-state">
                  No electrical rule violations at this revision.
                </div>
              ) : null}
              {erc?.diagnostics.map((diagnostic) => (
                <div
                  key={diagnostic.id}
                  style={{
                    ...styles.ercDiagnostic,
                    ...(diagnostic.severity === 'error'
                      ? styles.ercDiagnosticError
                      : diagnostic.severity === 'warning' ? styles.ercDiagnosticWarning : {}),
                  }}
                  data-testid={`erc-diagnostic-${diagnostic.code}`}
                >
                  <div style={styles.ercDiagnosticHeader}>
                    <strong>{diagnostic.code.replaceAll('_', ' ')}</strong>
                    <span>{diagnostic.severity}</span>
                  </div>
                  <div style={styles.ercDiagnosticMessage}>{diagnostic.message}</div>
                  {diagnostic.module_id ? (
                    <div style={styles.ercDiagnosticLocation}>
                      {[diagnostic.module_id, diagnostic.component_id, diagnostic.pin_id ?? diagnostic.port_id]
                        .filter(Boolean)
                        .join(' / ')}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {historyOpen ? (
        <div style={styles.historyOverlay} data-testid="project-history-panel">
          <section className="av-sheet" style={{ width: 520 }} aria-label="Project revision history">
            <div className="av-sheet__header">
              <div>
                <div className="av-sheet__title">Project History</div>
                <div className="av-sheet__subtitle">{project.name} | current revision {project.revision}</div>
              </div>
              <button
                type="button"
                className="av-btn av-btn--secondary"
                onClick={() => setHistoryOpen(false)}
                aria-label="Close project history"
                data-testid="close-project-history"
              >
                Close
              </button>
            </div>
            <div style={styles.historyList}>
              {historyLoading ? <div style={styles.historyEmpty}>Loading history...</div> : null}
              {!historyLoading && history.length === 0 ? (
                <div style={styles.historyEmpty}>No committed project revisions yet.</div>
              ) : null}
              {history.map((entry) => (
                <div key={entry.revision} style={styles.historyEntry} data-testid={`history-revision-${entry.revision}`}>
                  <div style={styles.historyEntryHeader}>
                    <div>
                      <strong>Revision {entry.revision}</strong>
                      <span style={styles.historyActor}> by {entry.actor}</span>
                    </div>
                    <button
                      type="button"
                      style={styles.secondaryButton}
                      onClick={() => { void restoreRevision(entry.revision); }}
                      disabled={busy || !entry.restorable}
                      data-testid={`restore-history-revision-${entry.revision}`}
                    >
                      Restore
                    </button>
                  </div>
                  <div style={styles.historyMessage}>{entry.message || 'Circuit document update'}</div>
                  <div style={styles.historyMeta}>
                    {entry.createdAt ? new Date(entry.createdAt).toLocaleString() : 'Unknown time'}
                    {entry.buildStatus ? ` | build ${entry.buildStatus}` : ''}
                    {entry.documentHash ? ` | ${entry.documentHash.slice(0, 10)}` : ''}
                  </div>
                  <details style={styles.historyDiff} data-testid={`history-netlist-diff-${entry.revision}`}>
                    <summary>
                      Netlist diff +{entry.netlistDiff.added.length} -{entry.netlistDiff.removed.length}
                    </summary>
                    {entry.netlistDiff.added.length > 0 ? (
                      <pre style={styles.historyDiffText}>{entry.netlistDiff.added.map((line) => `+ ${line}`).join('\n')}</pre>
                    ) : null}
                    {entry.netlistDiff.removed.length > 0 ? (
                      <pre style={styles.historyDiffRemoved}>{entry.netlistDiff.removed.map((line) => `- ${line}`).join('\n')}</pre>
                    ) : null}
                  </details>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {pendingCommandsOpen ? (
        <div style={styles.historyOverlay} data-testid="pending-command-review-panel">
          <section className="av-sheet" style={{ width: 560 }} aria-label="Agent transaction review">
            <div className="av-sheet__header">
              <div>
                <div className="av-sheet__title">Agent proposals</div>
                <div className="av-sheet__subtitle">
                  Review complete transactions before they change {project.name}.
                </div>
              </div>
              <button
                type="button"
                className="av-btn av-btn--secondary"
                onClick={() => setPendingCommandsOpen(false)}
                aria-label="Close Agent proposal review"
                data-testid="close-pending-command-review"
              >
                Close
              </button>
            </div>
            <div style={styles.historyList}>
              {pendingCommandsLoading && pendingCommands.length === 0
                ? <div style={styles.historyEmpty}>Loading proposals...</div>
                : null}
              {!pendingCommandsLoading && pendingCommands.length === 0 ? (
                <div style={styles.historyEmpty}>No Agent transactions are waiting for review.</div>
              ) : null}
              {pendingCommands.map((proposal) => {
                const stale = proposal.command.base_revision !== project.revision;
                return (
                  <div
                    key={proposal.command_id}
                    style={styles.historyEntry}
                    data-testid={`pending-command-${proposal.command_id}`}
                    data-stale={stale ? 'true' : 'false'}
                  >
                    <div style={styles.historyEntryHeader}>
                      <div>
                        <strong>{proposal.command.message || proposal.command_id}</strong>
                        <span style={styles.historyActor}> by {proposal.command.actor}</span>
                      </div>
                      <span style={stale ? styles.pendingStale : styles.pendingReady}>
                        {stale ? 'stale' : 'ready'}
                      </span>
                    </div>
                    <div style={styles.historyMeta}>
                      base revision {proposal.command.base_revision}
                      {' | '}
                      {proposal.summary.operation_count} operation{proposal.summary.operation_count === 1 ? '' : 's'}
                      {proposal.summary.affected_modules.length > 0
                        ? ` | modules ${proposal.summary.affected_modules.join(', ')}`
                        : ''}
                    </div>
                    <details style={styles.historyDiff} open>
                      <summary>Transaction diff</summary>
                      <ul style={styles.pendingOperationList}>
                        {proposal.summary.operations.map((operation, index) => (
                          <li key={`${operation.op}-${index}`}>
                            <code>{operation.op}</code>
                            {operation.entities.length > 0 ? ` | ${operation.entities.join(', ')}` : ''}
                          </li>
                        ))}
                      </ul>
                    </details>
                    <div style={styles.pendingActions}>
                      <button
                        type="button"
                        style={styles.secondaryButton}
                        onClick={() => { void reviewPendingCommand(proposal.command_id, 'reject'); }}
                        disabled={busy}
                        data-testid={`reject-pending-command-${proposal.command_id}`}
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        style={stale ? styles.primaryButtonDisabled : styles.primaryButton}
                        onClick={() => { void reviewPendingCommand(proposal.command_id, 'accept'); }}
                        disabled={busy || stale}
                        title={stale ? 'The project changed after this proposal was created.' : 'Accept transaction'}
                        data-testid={`accept-pending-command-${proposal.command_id}`}
                      >
                        Accept transaction
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}

      <div style={styles.body}>
        <div
          ref={canvasPanelRef}
          style={{ ...styles.canvasPanel, cursor: isPanning ? 'grabbing' : spacePanActive ? 'grab' : 'default' }}
          onPointerDown={beginCanvasPan}
          onKeyDown={handleCanvasKeyDown}
          onKeyUp={handleCanvasKeyUp}
          onBlur={() => setSpacePanActive(false)}
          onScroll={handleCanvasScroll}
          onContextMenu={(event) => openCanvasContextMenu(event)}
          tabIndex={0}
          data-testid="canvas-panel"
          data-canvas-zoom={zoom}
          data-space-pan={spacePanActive ? 'true' : 'false'}
          data-panning={isPanning ? 'true' : 'false'}
          data-canvas-scroll={JSON.stringify(canvasScroll)}
        >
          {view === 'board' ? (
            <ModuleBoard
              modules={displayedModules}
              moduleData={bundle.modules}
              previews={bundle.module_previews}
              systemNetworks={systemNetworks}
              selectedId={activeModuleId}
              zoom={zoom}
              metrics={boardMetrics}
              onSelect={setActiveModuleId}
              onOpen={openModule}
              onTogglePreview={togglePreview}
              onCopyId={copyModuleId}
              copiedId={copiedId}
              onDragStart={beginModuleDrag}
              onResizeStart={beginModuleResize}
              onContextMenu={openCanvasContextMenu}
            />
          ) : selectedRef ? (
            <ModuleSchematic
              projectId={currentProjectId ?? project.project_id}
              module={selectedRef}
              moduleData={selectedModule}
              svg={selectedPreview?.svg ?? ''}
              overrides={selectedPreview?.schematicOverrides}
              busy={busy}
              previewBusy={selectedPreviewBusy}
              projectKind={projectKind}
              pdkDeviceCatalog={pdkDeviceCatalog}
              projectModules={(project?.modules || []).map((entry) => ({
                module_id: entry.id,
                name: entry.name,
                revision: bundle?.modules[entry.id]?.revision ?? 0,
                ports: bundle?.modules[entry.id]?.ports || entry.ports || [],
                parameter_defs: bundle?.modules[entry.id]?.parameter_defs,
              }))}
              onBuild={() => buildModulePreview(selectedRef.id, true, selectedModule)}
              onOptimize={() => optimizeModuleSchematic(selectedRef.id)}
              layoutFeedback={layoutFeedback[selectedRef.id]}
              onSaveSchematic={(moduleData) => saveModuleSchematic(selectedRef.id, moduleData)}
              onMoveItem={(itemId, x, y) => moveSchematicItem(selectedRef.id, itemId, x, y)}
              onResetItem={(itemId) => resetSchematicItem(selectedRef.id, itemId)}
              onResetLayout={(itemIds) => resetSchematicLayout(selectedRef.id, itemIds)}
              onProbe={(probe) => openSimulationProbe(selectedRef.id, probe)}
              hierarchyTrace={hierarchyTrace?.moduleId === selectedRef.id ? hierarchyTrace : null}
              locateTarget={schematicLocateTarget?.moduleId === selectedRef.id ? schematicLocateTarget : null}
              onOpenChildModule={(moduleId, instanceId, pinId) => {
                void openChildModule(moduleId, instanceId, pinId);
              }}
            />
          ) : null}
        </div>

        <ModuleInspector
          module={selectedRef}
          moduleData={selectedModule}
          systemNetworks={systemNetworks}
          noteDraft={noteDraft}
          onNoteChange={setNoteDraft}
          onSaveNote={() => {
            if (!selectedRef) return;
            void applyOperations('Update module Agent note', [{
              op: 'set_module_note',
              module_id: selectedRef.id,
              notes: noteDraft,
            }]);
          }}
          onCopyId={copyModuleId}
          copied={copiedId === selectedRef?.id}
          onOpen={() => selectedRef && openModule(selectedRef.id)}
          onSimulate={runModuleSimulation}
          moduleSimulation={moduleSimulation}
          systemSimulation={build?.simulation ?? null}
          designMemory={designMemory}
          designMemoryLoading={designMemoryLoading}
          onRefreshDesignMemory={refreshDesignMemory}
          onOpenDesignMemory={openDesignMemoryItem}
          onCreateProjectFromTemplate={createProjectFromSavedTemplate}
          busy={busy}
        />
      </div>

      {contextMenu ? (
        <div
          style={{ ...styles.contextMenu, left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          data-testid="canvas-context-menu"
        >
          {contextMenu.moduleId ? (
            <>
              <button
                style={styles.contextMenuItem}
                onClick={() => {
                  const module = project.modules.find((entry) => entry.id === contextMenu.moduleId);
                  if (module) openEditModuleEditor(module);
                }}
                data-testid="context-edit-module"
              >
                Edit module details
              </button>
              <button
                style={styles.contextMenuItem}
                onClick={() => contextMenu.moduleId && void openModule(contextMenu.moduleId)}
              >
                Open schematic
              </button>
            </>
          ) : null}
          <button
            style={styles.contextMenuItem}
            onClick={() => openAddModuleEditor(contextMenu.boardPosition)}
            data-testid="context-add-module"
          >
            Add module here
          </button>
        </div>
      ) : null}

      {moduleEditor ? (
        <div style={styles.modalBackdrop} data-testid="module-editor">
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <div>
                <span style={styles.moduleKind}>{moduleEditor.mode === 'add' ? 'New module' : 'Edit module'}</span>
                <h2 style={styles.modalTitle}>{moduleEditor.mode === 'add' ? 'Add circuit module' : moduleEditor.id}</h2>
              </div>
              <button style={styles.modalClose} onClick={() => setModuleEditor(null)}>Close</button>
            </div>
            <label style={styles.fieldLabel}>
              Stable ID
              <input
                style={styles.fieldInput}
                value={moduleEditor.id}
                disabled={moduleEditor.mode === 'edit'}
                onChange={(event) => setModuleEditor({ ...moduleEditor, id: event.target.value })}
                data-testid="module-editor-id"
              />
            </label>
            <div style={styles.fieldGrid}>
              <label style={styles.fieldLabel}>
                Name
                <input
                  style={styles.fieldInput}
                  value={moduleEditor.name}
                  onChange={(event) => setModuleEditor({ ...moduleEditor, name: event.target.value })}
                  data-testid="module-editor-name"
                />
              </label>
              <label style={styles.fieldLabel}>
                Kind
                <input
                  style={styles.fieldInput}
                  value={moduleEditor.kind}
                  onChange={(event) => setModuleEditor({ ...moduleEditor, kind: event.target.value })}
                  data-testid="module-editor-kind"
                />
              </label>
            </div>
            <label style={styles.fieldLabel}>
              Function
              <textarea
                style={{ ...styles.fieldInput, minHeight: 74, resize: 'vertical' }}
                value={moduleEditor.functionText}
                onChange={(event) => setModuleEditor({ ...moduleEditor, functionText: event.target.value })}
                data-testid="module-editor-function"
              />
            </label>
            <label style={styles.fieldLabel}>
              Parameters, one name = value per line
              <textarea
                style={{ ...styles.fieldInput, minHeight: 100, resize: 'vertical', fontFamily: 'Consolas, monospace' }}
                value={moduleEditor.parametersText}
                onChange={(event) => setModuleEditor({ ...moduleEditor, parametersText: event.target.value })}
                data-testid="module-editor-parameters"
              />
            </label>
            {moduleEditorError ? <div style={styles.modalError}>{moduleEditorError}</div> : null}
            <div style={styles.modalActions}>
              <button style={styles.secondaryButton} onClick={() => setModuleEditor(null)}>Cancel</button>
              <button
                style={styles.primaryButton}
                onClick={() => void saveModuleEditor()}
                disabled={busy || !moduleEditorCanSave}
                data-testid="save-module-editor"
              >
                {moduleEditor.mode === 'add' ? 'Add module' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ModuleBoard({
  modules,
  moduleData,
  previews,
  systemNetworks,
  selectedId,
  zoom,
  metrics,
  onSelect,
  onOpen,
  onTogglePreview,
  onCopyId,
  copiedId,
  onDragStart,
  onResizeStart,
  onContextMenu,
}: {
  modules: CircuitModuleRef[];
  moduleData: Record<string, CircuitModule>;
  previews: Record<string, { svg: string }>;
  systemNetworks: SystemNetworkMap;
  selectedId: string | null;
  zoom: number;
  metrics: ReturnType<typeof modulePlaneMetrics>;
  onSelect: (moduleId: string) => void;
  onOpen: (moduleId: string) => void;
  onTogglePreview: (module: CircuitModuleRef) => void;
  onCopyId: (moduleId: string) => void;
  copiedId: string;
  onDragStart: (event: ReactPointerEvent, module: CircuitModuleRef) => void;
  onResizeStart: (event: ReactPointerEvent, module: CircuitModuleRef) => void;
  onContextMenu: (event: ReactMouseEvent, moduleId?: string) => void;
}) {
  const scale = zoom / 100;
  const pad = BOARD_VIEWPORT_PADDING;
  return (
    <div
      style={{
        ...styles.boardViewport,
        width: metrics.width * scale + pad * 2,
        height: metrics.height * scale + pad * 2,
        padding: pad,
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
      data-testid="system-canvas"
      data-board-origin-x={metrics.originX}
      data-board-origin-y={metrics.originY}
      data-board-width={metrics.width}
      data-board-height={metrics.height}
    >
      <div
        style={{
          ...styles.board,
          width: metrics.width,
          height: metrics.height,
          transform: `scale(${scale})`,
        }}
      >
        <div style={{ ...styles.boardGuide, left: metrics.originX + 28, top: metrics.originY + 24 }}>
          Drag modules anywhere | scroll to zoom | right-drag to pan | double-click to open the netlistsvg schematic
        </div>
        {modules.map((module) => (
          <ModuleCard
            key={module.id}
            module={module}
            origin={{ x: metrics.originX, y: metrics.originY }}
            moduleData={moduleData[module.id]}
            svg={previews[module.id]?.svg ?? ''}
            systemNetworks={systemNetworks}
            selected={selectedId === module.id}
            copied={copiedId === module.id}
            onSelect={() => onSelect(module.id)}
            onOpen={() => onOpen(module.id)}
            onTogglePreview={() => onTogglePreview(module)}
            onCopyId={() => onCopyId(module.id)}
            onDragStart={(event) => onDragStart(event, module)}
            onResizeStart={(event) => onResizeStart(event, module)}
            onContextMenu={(event) => onContextMenu(event, module.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ModuleCard({
  module,
  origin,
  moduleData,
  svg,
  systemNetworks,
  selected,
  copied,
  onSelect,
  onOpen,
  onTogglePreview,
  onCopyId,
  onDragStart,
  onResizeStart,
  onContextMenu,
}: {
  module: CircuitModuleRef;
  origin: { x: number; y: number };
  moduleData?: CircuitModule;
  svg: string;
  systemNetworks: SystemNetworkMap;
  selected: boolean;
  copied: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onTogglePreview: () => void;
  onCopyId: () => void;
  onDragStart: (event: ReactPointerEvent) => void;
  onResizeStart: (event: ReactPointerEvent) => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const cardRef = useRef<HTMLElement | null>(null);
  const [projectionEnabled, setProjectionEnabled] = useState(false);
  const previewEnabled = module.preview_enabled ?? true;
  const interfaces = visibleInterfaces(module);
  const parameters = module.parameters && Object.keys(module.parameters).length > 0
    ? module.parameters
    : fallbackParameters(moduleData);
  const schematicProjection = useSchematicProjection(
    moduleData,
    previewEnabled && projectionEnabled,
  );
  const schematicDocument = schematicProjection?.document ?? null;
  useEffect(() => {
    const node = cardRef.current;
    if (!node || projectionEnabled) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setProjectionEnabled(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setProjectionEnabled(true);
      observer.disconnect();
    }, { rootMargin: '240px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [projectionEnabled]);
  return (
    <article
      ref={cardRef}
      style={{
        ...styles.moduleCard,
        left: module.position.x + origin.x,
        top: module.position.y + origin.y,
        width: module.size.width || 320,
        height: module.size.height || 250,
        ...(selected ? styles.moduleCardSelected : {}),
      }}
      onClick={(event) => {
        onSelect();
        if (event.detail === 2) onOpen();
      }}
      onPointerDown={onDragStart}
      onContextMenu={onContextMenu}
      data-testid={`module-card-${module.id}`}
      data-projection-execution="lazy-worker"
      data-projection-mode={schematicProjection?.mode ?? ''}
      data-projection-affected={schematicProjection?.affectedEntities.join(',') ?? ''}
      data-projection-ready={schematicDocument ? 'true' : 'false'}
      data-interactive-quality={schematicProjection?.quality.readabilityScore ?? ''}
    >
      <div style={styles.moduleCardHeader}>
        <div style={styles.moduleTitleGroup}>
          <span style={styles.moduleKind}>{module.kind}</span>
          <strong style={styles.moduleName}>{module.name}</strong>
        </div>
        <label style={styles.previewToggle} title="Show SVG preview on canvas">
          <input
            type="checkbox"
            checked={previewEnabled}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => {
              event.stopPropagation();
              onTogglePreview();
            }}
            onClick={(event) => event.stopPropagation()}
            readOnly
            data-testid={`preview-toggle-${module.id}`}
          />
          Preview
        </label>
      </div>

      {previewEnabled ? (
        <div style={styles.previewBody}>
          {schematicDocument ? (
            <div
              style={styles.svgPreview}
              data-testid={`module-preview-${module.id}`}
              data-schematic-source="document"
            >
              <SchematicDocumentSvg
                document={schematicDocument}
                testId={`module-preview-document-svg-${module.id}`}
              />
            </div>
          ) : svg ? (
            <div
              style={styles.svgPreview}
              dangerouslySetInnerHTML={{ __html: prepareSvg(svg) }}
              data-testid={`module-preview-${module.id}`}
              data-schematic-source="netlistsvg"
            />
          ) : (
            <div style={styles.previewMissing}>
              <span>SVG preview not built</span>
              <small>Double-click to render with netlistsvg</small>
            </div>
          )}
        </div>
      ) : (
        <div style={styles.summaryBody} data-testid={`module-summary-${module.id}`}>
          <p style={styles.functionText}>{module.function || 'No function summary yet.'}</p>
          <div style={styles.parameterGrid}>
            {Object.entries(parameters).slice(0, 4).map(([name, value]) => (
              <div key={name} style={styles.parameterRow}>
                <span>{name}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={styles.interfaceStrip}>
        <InterfaceBadge moduleId={module.id} label="IN" ports={interfaces.inputs} tone="input" systemNetworks={systemNetworks} />
        <InterfaceBadge moduleId={module.id} label="OUT" ports={interfaces.outputs} tone="output" systemNetworks={systemNetworks} />
        <InterfaceBadge moduleId={module.id} label="GND" ports={interfaces.grounds} tone="ground" systemNetworks={systemNetworks} />
      </div>

      <div style={styles.cardFooter}>
        <button
          style={styles.idButton}
          onClick={(event) => {
            event.stopPropagation();
            onCopyId();
          }}
          data-testid={`copy-id-${module.id}`}
        >
          {copied ? 'Copied' : `ID: ${module.id}`}
        </button>
        <div style={styles.cardFlags}>
          {module.notes?.trim() ? <span>Agent note</span> : null}
          <span>Double-click</span>
        </div>
      </div>
      <div
        style={styles.resizeHandle}
        onPointerDown={onResizeStart}
        data-resize-handle
        data-testid={`resize-module-${module.id}`}
        title="Drag to resize module"
      />
    </article>
  );
}

function InterfaceBadge({
  moduleId,
  label,
  ports,
  tone,
  systemNetworks,
}: {
  moduleId: string;
  label: string;
  ports: CircuitPort[];
  tone: 'input' | 'output' | 'ground';
  systemNetworks: SystemNetworkMap;
}) {
  if (ports.length === 0) return null;
  const networks = interfaceNetworks(moduleId, ports, tone, systemNetworks);
  const endpoints = [...new Set(ports.flatMap((port) => (
    systemNetworks[endpointKey(moduleId, port.id)]?.endpoints ?? [`${moduleId}.${port.id}`]
  )))];
  return (
    <span
      style={{ ...styles.interfaceBadge, ...styles[`interface_${tone}`] }}
      data-testid={`interface-${tone}`}
      title={`System network endpoints: ${endpoints.join(', ')}`}
    >
      <b>{label}:</b>
      {' '}
      <span style={styles.interfaceNetworks}>{networks.join(', ')}</span>
    </span>
  );
}

function PhysicalPathField({
  label,
  value,
  onChange,
  onBrowse,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBrowse: () => Promise<void>;
}) {
  return (
    <label className="av-form-field">
      <span>{label}</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={value} onChange={(event) => onChange(event.target.value)} style={{ flex: 1 }} />
        <button type="button" className="av-btn av-btn--secondary" onClick={() => { void onBrowse(); }}>Browse</button>
      </div>
    </label>
  );
}

function ModuleSchematic({
  projectId,
  module,
  moduleData,
  svg,
  overrides,
  busy,
  previewBusy,
  projectKind = 'simulation',
  pdkDeviceCatalog = null,
  projectModules = [],
  onBuild,
  onOptimize,
  layoutFeedback,
  onSaveSchematic,
  onMoveItem,
  onResetItem,
  onResetLayout,
  onProbe,
  hierarchyTrace,
  locateTarget,
  onOpenChildModule,
}: {
  projectId: string;
  module: CircuitModuleRef;
  moduleData?: CircuitModule;
  svg: string;
  overrides?: SchematicOverrides;
  busy: boolean;
  previewBusy: boolean;
  projectKind?: ProjectKind;
  pdkDeviceCatalog?: PdkDeviceCatalog | null;
  projectModules?: Array<{
    module_id: string;
    name: string;
    revision: number;
    ports: CircuitModule['ports'];
    parameter_defs?: CircuitModule['parameter_defs'];
  }>;
  onBuild: () => void;
  onOptimize: () => Promise<void>;
  layoutFeedback?: LayoutOptimizationResult;
  onSaveSchematic: (moduleData: CircuitModule) => Promise<boolean | void>;
  onMoveItem: (itemId: string, x: number, y: number) => Promise<void>;
  onResetItem: (itemId: string) => Promise<void>;
  onResetLayout: (itemIds: string[]) => Promise<void>;
  onProbe: (probe: SchematicProbeSelection) => void;
  hierarchyTrace?: HierarchyTrace | null;
  locateTarget?: SchematicLocateTarget | null;
  onOpenChildModule?: (moduleId: string, instanceId: string, pinId?: string) => void;
}) {
  const [viewMode, setViewMode] = useState<'editor' | 'document' | 'compatibility'>('editor');
  const [editLayout, setEditLayout] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [draggedItem, setDraggedItem] = useState('');
  const [selectedItem, setSelectedItem] = useState('');
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [undoStack, setUndoStack] = useState<Array<{
    itemId: string;
    from: { x: number; y: number; overridden: boolean };
    to: { x: number; y: number };
  }>>([]);
  const [redoStack, setRedoStack] = useState<Array<{
    itemId: string;
    from: { x: number; y: number; overridden: boolean };
    to: { x: number; y: number };
  }>>([]);
  const svgContainerRef = useRef<HTMLDivElement | null>(null);
  const editLayoutRef = useRef(editLayout);
  const busyRef = useRef(busy);
  const onMoveItemRef = useRef(onMoveItem);
  const onResetItemRef = useRef(onResetItem);
  const selectedItemRef = useRef(selectedItem);
  const snapToGridRef = useRef(snapToGrid);
  const overridesRef = useRef(overrides);
  const nativeDragHandlersRef = useRef<{
    node: HTMLDivElement;
    pointerDown: (event: PointerEvent) => void;
    mouseDown: (event: MouseEvent) => void;
  } | null>(null);
  const dragRef = useRef<{
    itemId: string;
    group: SVGGElement;
    startClient: { x: number; y: number };
    origin: { x: number; y: number };
    scale: { x: number; y: number };
    fromOverride?: { x: number; y: number };
  } | null>(null);

  editLayoutRef.current = editLayout;
  busyRef.current = busy;
  onMoveItemRef.current = onMoveItem;
  onResetItemRef.current = onResetItem;
  selectedItemRef.current = selectedItem;
  snapToGridRef.current = snapToGrid;
  overridesRef.current = overrides;

  const overrideItems = useMemo(
    () => Object.entries(overrides?.items ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    [overrides],
  );
  const compatibilityMapping = useMemo(() => {
    const candidates = new Map<string, string>();
    for (const component of moduleData?.components ?? []) {
      const baseName = `${module.id}_${component.name}`.replace(/[^A-Za-z0-9_.:+-]+/g, '_');
      const renderId = baseName.toUpperCase().startsWith(component.type.toUpperCase())
        ? baseName
        : `${component.type}${baseName}`;
      for (const candidate of [component.id, component.name, renderId]) {
        candidates.set(candidate.toLowerCase(), component.id);
      }
    }
    const mapped = overrideItems.filter(([itemId]) => candidates.has(itemId.toLowerCase())).length;
    return { mapped, unmapped: overrideItems.length - mapped };
  }, [module.id, moduleData, overrideItems]);
  const selectedOverride = selectedItem ? overrides?.items[selectedItem] : undefined;
  const symbolDefinitions = useKicadSymbolDefinitions(moduleData);
  const schematicDocument = useMemo(
    () => moduleData ? createSchematicDocument(moduleData, { symbolDefinitions }) : null,
    [moduleData, symbolDefinitions],
  );

  useEffect(() => {
    if (!moduleData && viewMode !== 'compatibility') setViewMode('compatibility');
  }, [moduleData, viewMode]);

  useEffect(() => {
    setEditorDirty(false);
  }, [module.id]);

  function svgClientDeltaScale(svgElement: SVGSVGElement): { x: number; y: number } {
    const matrix = svgElement.getScreenCTM();
    if (!matrix) return { x: 1, y: 1 };
    const scaleX = Math.hypot(matrix.a, matrix.b);
    const scaleY = Math.hypot(matrix.c, matrix.d);
    return {
      x: scaleX > 0 ? 1 / scaleX : 1,
      y: scaleY > 0 ? 1 / scaleY : 1,
    };
  }

  function parseSvgTranslate(transform: string | null): { x: number; y: number } | null {
    const match = /translate\(\s*([-+]?\d*\.?\d+)\s*,\s*([-+]?\d*\.?\d+)\s*\)/.exec(transform ?? '');
    if (!match) return null;
    return { x: Number.parseFloat(match[1] ?? '0'), y: Number.parseFloat(match[2] ?? '0') };
  }

  function snapPosition(position: { x: number; y: number }): { x: number; y: number } {
    if (!snapToGridRef.current) return position;
    return {
      x: Math.round(position.x / 10) * 10,
      y: Math.round(position.y / 10) * 10,
    };
  }

  function groupForItem(itemId: string): SVGGElement | null {
    const container = svgContainerRef.current;
    return container?.querySelector(`svg #cell_${CSS.escape(itemId)}`) as SVGGElement | null;
  }

  function currentItemPosition(itemId: string): { x: number; y: number } | null {
    return parseSvgTranslate(groupForItem(itemId)?.getAttribute('transform') ?? null);
  }

  function findSchematicCellGroup(
    target: Element | null,
    container: HTMLDivElement,
    clientX: number,
    clientY: number,
  ): SVGGElement | null {
    const directGroup = target?.closest('g[id^="cell_"]') as SVGGElement | null;
    if (directGroup) return directGroup;

    const groups = Array.from(container.querySelectorAll('svg g[id^="cell_"]')) as SVGGElement[];
    let best: { group: SVGGElement; distance: number } | null = null;
    const padding = 8;
    for (const group of groups) {
      const rect = group.getBoundingClientRect();
      if (
        clientX < rect.left - padding ||
        clientX > rect.right + padding ||
        clientY < rect.top - padding ||
        clientY > rect.bottom + padding
      ) {
        continue;
      }
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const distance = (clientX - centerX) ** 2 + (clientY - centerY) ** 2;
      if (!best || distance < best.distance) best = { group, distance };
    }
    return best?.group ?? null;
  }

  function beginSchematicItemDrag(event: PointerEvent | MouseEvent, container: HTMLDivElement) {
    if (!editLayoutRef.current || busyRef.current || event.button !== 0) return;
    if (dragRef.current) return;
    const target = event.target instanceof Element ? event.target : null;
    const group = findSchematicCellGroup(target, container, event.clientX, event.clientY);
    const svgElement = group?.ownerSVGElement;
    if (!group || !svgElement) return;
    const cellId = group.id.replace(/^cell_/, '');
    const origin = parseSvgTranslate(group.getAttribute('transform'));
    if (!cellId || !origin) return;

    event.preventDefault();
    event.stopPropagation();
    const scale = svgClientDeltaScale(svgElement);
    const fromOverride = overridesRef.current?.items?.[cellId];
    dragRef.current = {
      itemId: cellId,
      group,
      startClient: { x: event.clientX, y: event.clientY },
      origin,
      scale,
      fromOverride,
    };
    setDraggedItem(cellId);
    setSelectedItem(cellId);

    const isPointerDrag = 'pointerId' in event;
    const moveEventName = isPointerDrag ? 'pointermove' : 'mousemove';
    const upEventName = isPointerDrag ? 'pointerup' : 'mouseup';
    let moved = false;
    const move = (moveEvent: PointerEvent | MouseEvent) => {
      const current = dragRef.current;
      if (!current) return;
      if (!moved && Math.abs(moveEvent.clientX - current.startClient.x) + Math.abs(moveEvent.clientY - current.startClient.y) < 4) return;
      moved = true;
      const next = snapPosition({
        x: current.origin.x + (moveEvent.clientX - current.startClient.x) * current.scale.x,
        y: current.origin.y + (moveEvent.clientY - current.startClient.y) * current.scale.y,
      });
      const nextX = next.x;
      const nextY = next.y;
      current.group.setAttribute('transform', `translate(${nextX.toFixed(3)},${nextY.toFixed(3)})`);
    };
    const up = (upEvent: PointerEvent | MouseEvent) => {
      window.removeEventListener(moveEventName, move as EventListener);
      window.removeEventListener(upEventName, up as EventListener);
      const current = dragRef.current;
      dragRef.current = null;
      if (!current) {
        setDraggedItem('');
        return;
      }
      if (!moved) {
        setDraggedItem('');
        return;
      }
      const next = snapPosition({
        x: current.origin.x + (upEvent.clientX - current.startClient.x) * current.scale.x,
        y: current.origin.y + (upEvent.clientY - current.startClient.y) * current.scale.y,
      });
      const nextX = next.x;
      const nextY = next.y;
      current.group.setAttribute('transform', `translate(${nextX.toFixed(3)},${nextY.toFixed(3)})`);
      setDraggedItem('');
      setUndoStack((currentStack) => [
        ...currentStack,
        {
          itemId: current.itemId,
          from: current.fromOverride
            ? { x: current.fromOverride.x, y: current.fromOverride.y, overridden: true }
            : { x: current.origin.x, y: current.origin.y, overridden: false },
          to: { x: nextX, y: nextY },
        },
      ].slice(-30));
      setRedoStack([]);
      void onMoveItemRef.current(current.itemId, nextX, nextY);
    };
    window.addEventListener(moveEventName, move as EventListener);
    window.addEventListener(upEventName, up as EventListener, { once: true });
  }

  async function moveSelectedItem(dx: number, dy: number): Promise<void> {
    if (!selectedItem || busy) return;
    const currentPosition = currentItemPosition(selectedItem);
    if (!currentPosition) return;
    const fromOverride = overrides?.items[selectedItem];
    const next = snapPosition({ x: currentPosition.x + dx, y: currentPosition.y + dy });
    groupForItem(selectedItem)?.setAttribute('transform', `translate(${next.x.toFixed(3)},${next.y.toFixed(3)})`);
    setUndoStack((currentStack) => [
      ...currentStack,
      {
        itemId: selectedItem,
        from: fromOverride
          ? { x: fromOverride.x, y: fromOverride.y, overridden: true }
          : { x: currentPosition.x, y: currentPosition.y, overridden: false },
        to: next,
      },
    ].slice(-30));
    setRedoStack([]);
    await onMoveItem(selectedItem, next.x, next.y);
  }

  async function undoLayoutMove(): Promise<void> {
    const entry = undoStack.at(-1);
    if (!entry || busy) return;
    setUndoStack((currentStack) => currentStack.slice(0, -1));
    setRedoStack((currentStack) => [...currentStack, entry].slice(-30));
    setSelectedItem(entry.itemId);
    if (entry.from.overridden) {
      await onMoveItem(entry.itemId, entry.from.x, entry.from.y);
    } else {
      await onResetItem(entry.itemId);
    }
  }

  async function redoLayoutMove(): Promise<void> {
    const entry = redoStack.at(-1);
    if (!entry || busy) return;
    setRedoStack((currentStack) => currentStack.slice(0, -1));
    setUndoStack((currentStack) => [...currentStack, entry].slice(-30));
    setSelectedItem(entry.itemId);
    await onMoveItem(entry.itemId, entry.to.x, entry.to.y);
  }

  async function resetSelectedItem(): Promise<void> {
    if (!selectedItem || busy) return;
    await onResetItem(selectedItem);
    setSelectedItem('');
    setUndoStack([]);
    setRedoStack([]);
  }

  async function resetAllItems(): Promise<void> {
    if (busy || overrideItems.length === 0) return;
    await onResetLayout(overrideItems.map(([itemId]) => itemId));
    setSelectedItem('');
    setUndoStack([]);
    setRedoStack([]);
  }

  const setSvgContainer = useCallback((node: HTMLDivElement | null) => {
    const existing = nativeDragHandlersRef.current;
    if (existing) {
      existing.node.removeEventListener('pointerdown', existing.pointerDown, true);
      existing.node.removeEventListener('mousedown', existing.mouseDown, true);
      nativeDragHandlersRef.current = null;
    }
    svgContainerRef.current = node;
    if (!node) return;

    const pointerDown = (event: PointerEvent) => beginSchematicItemDrag(event, node);
    const mouseDown = (event: MouseEvent) => beginSchematicItemDrag(event, node);
    node.addEventListener('pointerdown', pointerDown, true);
    node.addEventListener('mousedown', mouseDown, true);
    nativeDragHandlersRef.current = { node, pointerDown, mouseDown };
  }, []);

  useEffect(() => {
    const container = svgContainerRef.current;
    if (!container) return;
    const groups = Array.from(container.querySelectorAll('svg g[id^="cell_"]')) as SVGGElement[];
    for (const group of groups) {
      group.style.filter = '';
      group.style.cursor = editLayout ? 'move' : '';
      group.removeAttribute('data-actoviq-selected');
    }
    if (!selectedItem) return;
    const selected = groupForItem(selectedItem);
    if (!selected) return;
    selected.style.filter = 'drop-shadow(0 0 3px rgba(37, 99, 235, 0.95))';
    selected.setAttribute('data-actoviq-selected', 'true');
  }, [editLayout, selectedItem, svg]);

  useEffect(() => {
    if (selectedItem && svgContainerRef.current && !groupForItem(selectedItem)) {
      setSelectedItem('');
    }
  }, [selectedItem, svg]);

  return (
    <div style={styles.moduleViewer} data-testid="module-canvas" data-preview-busy={previewBusy ? 'true' : 'false'}>
      <div style={styles.moduleViewerHeader}>
        <div>
          <span style={styles.moduleKind}>{module.kind}</span>
          <h2 style={styles.moduleViewerTitle}>{module.name}</h2>
          <span style={styles.moduleViewerId}>Module ID: {module.id}</span>
        </div>
        <div style={styles.moduleViewerActions}>
          <button
            style={viewMode === 'editor' ? styles.primaryButton : styles.secondaryButton}
            onClick={() => {
              setViewMode('editor');
              setEditLayout(false);
            }}
            disabled={busy || !moduleData}
            data-testid="schematic-editor-tab"
          >
            Editable model
          </button>
          <button
            style={viewMode === 'document' ? styles.primaryButton : styles.secondaryButton}
            onClick={() => {
              setViewMode('document');
              setEditLayout(false);
            }}
            disabled={busy || !moduleData}
            data-testid="schematic-svg-tab"
          >
            Projected SVG
          </button>
          <button
            style={viewMode === 'compatibility' ? styles.primaryButton : styles.secondaryButton}
            onClick={() => {
              setViewMode('compatibility');
              setEditLayout(false);
            }}
            disabled={busy}
            title="Derived netlistsvg preview for compatibility and export checks. It is not the editable source."
            data-testid="schematic-netlistsvg-compatibility-tab"
          >
            netlistsvg (compat)
          </button>
          <button
            style={styles.secondaryButton}
            onClick={onBuild}
            disabled={busy || previewBusy}
            title="Refresh the legacy netlistsvg build artifact used by compile/export checks."
            data-testid="rebuild-module-svg"
          >
            {previewBusy ? 'Building netlistsvg' : 'Build netlistsvg'}
          </button>
          <button
            style={styles.primaryButton}
            onClick={() => void onOptimize()}
            disabled={busy || previewBusy || !moduleData || editorDirty}
            title={editorDirty
              ? 'Save or undo manual edits before running layout optimization.'
              : 'Use the verified multimodal layout model when deterministic routing remains below 90 or leaves crossings, overlaps, congestion, or flow issues.'}
            data-testid="optimize-schematic-layout"
          >
            AI layout
          </button>
        </div>
      </div>
      {layoutFeedback ? (
        <div style={styles.layoutFeedback} data-testid="layout-optimization-feedback">
          <strong>Layout quality {Math.round(layoutFeedback.initial_quality.readability_score)} → {Math.round(layoutFeedback.final_quality.readability_score)}</strong>
          <span>
            {layoutFeedback.llm_invoked
              ? `${layoutFeedback.rounds.length} visual review round${layoutFeedback.rounds.length === 1 ? '' : 's'} · ${layoutFeedback.stopped_reason}`
              : `deterministic candidates · ${layoutFeedback.stopped_reason}`}
          </span>
          <span>Connectivity {layoutFeedback.connectivity_hash.slice(0, 12)}… preserved</span>
          <span>
            Visible full schematic {Math.round(layoutFeedback.visible_quality.readability_score)}
            {layoutFeedback.visible_quality_unresolved ? ' · unresolved quality issues' : ' · clean'}
          </span>
        </div>
      ) : null}
      {viewMode === 'compatibility' ? (
        <div style={styles.layoutFeedback} data-testid="schematic-compatibility-notice">
          <strong>Compatibility/export preview</strong>
          <span>
            This SVG and schematic.overrides.json are derived legacy artifacts. Editable model
            (actoviq.module.v2) remains the only native edit source.
          </span>
          <span data-testid="schematic-overrides-migration-summary">
            Migration report: {overrideItems.length} override{overrideItems.length === 1 ? '' : 's'};
            {' '}{compatibilityMapping.mapped} renderer id{compatibilityMapping.mapped === 1 ? '' : 's'} mapped,
            {' '}{compatibilityMapping.unmapped} require review; 0 applied automatically.
          </span>
          <button
            type="button"
            style={styles.secondaryButton}
            onClick={() => setEditLayout((current) => !current)}
            disabled={busy || !svg}
            data-testid="schematic-compatibility-layout-toggle"
          >
            {editLayout ? 'Stop compatibility editing' : 'Edit legacy placement overrides'}
          </button>
        </div>
      ) : null}
      {viewMode === 'compatibility' && editLayout ? (
        <div style={styles.layoutToolbar} data-testid="schematic-layout-tools">
          <label style={styles.layoutCheck}>
            <input
              type="checkbox"
              checked={snapToGrid}
              onChange={(event) => setSnapToGrid(event.target.checked)}
              data-testid="schematic-snap-toggle"
            />
            Snap 10px
          </label>
          <button
            style={styles.secondaryButton}
            onClick={() => void undoLayoutMove()}
            disabled={busy || undoStack.length === 0}
            data-testid="schematic-undo"
          >
            Undo
          </button>
          <button
            style={styles.secondaryButton}
            onClick={() => void redoLayoutMove()}
            disabled={busy || redoStack.length === 0}
            data-testid="schematic-redo"
          >
            Redo
          </button>
          <button
            style={styles.secondaryButton}
            onClick={() => void resetSelectedItem()}
            disabled={busy || !selectedOverride}
            data-testid="schematic-reset-selected"
          >
            Reset selected
          </button>
          <button
            style={styles.secondaryButton}
            onClick={() => void resetAllItems()}
            disabled={busy || overrideItems.length === 0}
            data-testid="schematic-reset-all"
          >
            Reset all
          </button>
          <div style={styles.layoutNudgeGroup} data-testid="schematic-nudge-controls">
            <button style={styles.nudgeButton} onClick={() => void moveSelectedItem(0, -10)} disabled={busy || !selectedItem} title="Nudge up" data-testid="schematic-nudge-up">Up</button>
            <button style={styles.nudgeButton} onClick={() => void moveSelectedItem(-10, 0)} disabled={busy || !selectedItem} title="Nudge left" data-testid="schematic-nudge-left">Left</button>
            <button style={styles.nudgeButton} onClick={() => void moveSelectedItem(10, 0)} disabled={busy || !selectedItem} title="Nudge right" data-testid="schematic-nudge-right">Right</button>
            <button style={styles.nudgeButton} onClick={() => void moveSelectedItem(0, 10)} disabled={busy || !selectedItem} title="Nudge down" data-testid="schematic-nudge-down">Down</button>
          </div>
          <span style={styles.layoutSelectedText} data-testid="schematic-selected-item">
            {selectedItem ? `${selectedItem}${selectedOverride ? ` @ ${selectedOverride.x}, ${selectedOverride.y}` : ''}` : 'Select a symbol'}
          </span>
        </div>
      ) : null}
      <div style={styles.fullSvgStage}>
        {viewMode === 'editor' && moduleData ? (
          <>
            {moduleData.schematic_peer?.mode === 'external' ? (
              <div className="av-form-status" data-testid="schematic-external-readonly">
                Xschem is authoritative. This Vibe Analog canvas is read-only until ownership is taken explicitly.
              </div>
            ) : null}
            <SchematicEditor
              projectId={projectId}
              module={moduleData}
              busy={busy || moduleData.schematic_peer?.mode === 'external'}
              buildBusy={previewBusy}
              projectModules={projectModules}
              projectKind={projectKind}
              pdkDeviceCatalog={pdkDeviceCatalog}
              onSave={onSaveSchematic}
              onBuild={onBuild}
              onProbe={onProbe}
              onDirtyChange={setEditorDirty}
              hierarchyTrace={hierarchyTrace}
              locateTarget={locateTarget}
              onOpenChildModule={onOpenChildModule}
            />
          </>
        ) : viewMode === 'document' && schematicDocument ? (
          <div
            style={styles.documentSvgPanel}
            data-testid="module-netlistsvg"
            data-schematic-source="document"
          >
            <SchematicDocumentSvg
              document={schematicDocument}
              testId="module-document-svg"
            />
          </div>
        ) : viewMode === 'compatibility' && svg ? (
          <>
            <div
              style={{
                ...styles.fullSvg,
                ...(editLayout ? styles.fullSvgEditing : {}),
              }}
              ref={setSvgContainer}
              dangerouslySetInnerHTML={{ __html: prepareSvg(svg) }}
              data-testid="module-netlistsvg"
              data-schematic-source="netlistsvg-compatibility"
              data-layout-editing={editLayout ? 'true' : 'false'}
              data-dragged-item={draggedItem}
            />
            {editLayout ? (
              <aside style={styles.overridePanel} data-testid="schematic-overrides-panel">
                <div style={styles.overridePanelTitle}>Legacy overrides (compatibility only)</div>
                <div style={styles.overrideEmpty}>
                  Import/export/report: circuit_project.py schematic-overrides-*. Coordinates are
                  never copied into module.v2 automatically.
                </div>
                {overrideItems.length === 0 ? (
                  <div style={styles.overrideEmpty}>No layout overrides yet.</div>
                ) : overrideItems.map(([itemId, item]) => (
                  <div
                    key={itemId}
                    style={{
                      ...styles.overrideItem,
                      ...(selectedItem === itemId ? styles.overrideItemSelected : {}),
                    }}
                    data-testid={`schematic-override-${itemId}`}
                  >
                    <button
                      style={styles.overrideSelectButton}
                      onClick={() => setSelectedItem(itemId)}
                      data-testid={`select-schematic-override-${itemId}`}
                    >
                      <strong>{itemId}</strong>
                      <span>{item.x}, {item.y}</span>
                    </button>
                    <button
                      style={styles.memoryRefreshButton}
                      onClick={() => void onResetItem(itemId)}
                      disabled={busy}
                      data-testid={`reset-schematic-override-${itemId}`}
                    >
                      Reset
                    </button>
                  </div>
                ))}
              </aside>
            ) : null}
          </>
        ) : (
          <div style={styles.fullSvgEmpty}>
            <strong>No module SVG yet</strong>
            <span>Build the module to run the existing netlist to netlistsvg pipeline.</span>
            <button style={styles.primaryButton} onClick={onBuild} disabled={busy || previewBusy}>
              {previewBusy ? 'Building preview' : 'Build preview'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ModuleInspector({
  module,
  moduleData,
  systemNetworks,
  noteDraft,
  onNoteChange,
  onSaveNote,
  onCopyId,
  copied,
  onOpen,
  onSimulate,
  moduleSimulation,
  systemSimulation,
  designMemory,
  designMemoryLoading,
  onRefreshDesignMemory,
  onOpenDesignMemory,
  onCreateProjectFromTemplate,
  busy,
}: {
  module: CircuitModuleRef | null;
  moduleData?: CircuitModule;
  systemNetworks: SystemNetworkMap;
  noteDraft: string;
  onNoteChange: (value: string) => void;
  onSaveNote: () => void;
  onCopyId: (moduleId: string) => void;
  copied: boolean;
  onOpen: () => void;
  onSimulate: () => void;
  moduleSimulation: (SimulationRun & { module_id: string }) | null;
  systemSimulation: SimulationRun | null;
  designMemory: { templates: DesignMemoryItem[]; flows: DesignMemoryItem[] };
  designMemoryLoading: boolean;
  onRefreshDesignMemory: () => void;
  onOpenDesignMemory: (kind: 'template' | 'flow', id: string) => Promise<void>;
  onCreateProjectFromTemplate: (template: DesignMemoryItem) => Promise<void>;
  busy: boolean;
}) {
  if (!module) {
    return (
      <aside style={styles.inspector} data-testid="circuit-inspector">
        <div style={styles.inspectorEmpty}>Select a module to inspect it.</div>
      </aside>
    );
  }
  const interfaces = visibleInterfaces(module);
  const parameters = module.parameters && Object.keys(module.parameters).length > 0
    ? module.parameters
    : fallbackParameters(moduleData);
  return (
    <aside style={styles.inspector} data-testid="circuit-inspector">
      <div style={styles.inspectorHeading}>
        <div>
          <span style={styles.moduleKind}>{module.kind}</span>
          <h2 style={styles.inspectorTitle}>{module.name}</h2>
        </div>
        <button style={styles.copyButton} onClick={() => onCopyId(module.id)} data-testid="copy-selected-module-id">
          {copied ? 'Copied' : 'Copy ID'}
        </button>
      </div>
      <code style={styles.moduleId}>{module.id}</code>

      <div style={styles.sectionTitle}>Function</div>
      <p style={styles.inspectorFunction}>{module.function || 'No function summary yet.'}</p>

      <div style={styles.sectionTitle}>Interfaces</div>
      <div style={styles.inspectorInterfaces}>
        <InterfaceBadge moduleId={module.id} label="IN" ports={interfaces.inputs} tone="input" systemNetworks={systemNetworks} />
        <InterfaceBadge moduleId={module.id} label="OUT" ports={interfaces.outputs} tone="output" systemNetworks={systemNetworks} />
        <InterfaceBadge moduleId={module.id} label="GND" ports={interfaces.grounds} tone="ground" systemNetworks={systemNetworks} />
      </div>

      <div style={styles.sectionTitle}>Parameters</div>
      <div style={styles.inspectorParameters}>
        {Object.entries(parameters).map(([name, value]) => (
          <div key={name} style={styles.inspectorParameterRow}>
            <span>{name}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <div style={styles.sectionTitle}>Agent modification note</div>
      <textarea
        value={noteDraft}
        onChange={(event) => onNoteChange(event.target.value)}
        placeholder={`Tell the Agent how to modify module "${module.id}"...`}
        style={styles.noteInput}
        data-testid="module-note"
      />
      <button
        style={styles.primaryButton}
        onClick={onSaveNote}
        disabled={busy || noteDraft === (module.notes ?? '')}
        data-testid="save-module-note"
      >
        Save note
      </button>

      <div style={styles.inspectorActions}>
        <button style={styles.secondaryButton} onClick={onOpen}>Open schematic</button>
        <button style={styles.secondaryButton} onClick={onSimulate} disabled={busy} data-testid="simulate-module">
          Simulate module
        </button>
      </div>

      <DesignMemoryPanel
        memory={designMemory}
        loading={designMemoryLoading}
        onRefresh={onRefreshDesignMemory}
        onOpen={onOpenDesignMemory}
        onUseTemplate={onCreateProjectFromTemplate}
      />

      {moduleSimulation ? (
        <SimulationMetrics title={`${moduleSimulation.module_id} module`} data={moduleSimulation} />
      ) : null}
      {systemSimulation ? <SimulationMetrics title="System" data={systemSimulation} /> : null}
    </aside>
  );
}

function formatMemoryDate(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function DesignMemoryPanel({
  memory,
  loading,
  onRefresh,
  onOpen,
  onUseTemplate,
}: {
  memory: { templates: DesignMemoryItem[]; flows: DesignMemoryItem[] };
  loading: boolean;
  onRefresh: () => void;
  onOpen: (kind: 'template' | 'flow', id: string) => Promise<void>;
  onUseTemplate: (template: DesignMemoryItem) => Promise<void>;
}) {
  const templates = memory.templates.slice(0, 4);
  const flows = memory.flows.slice(0, 4);
  return (
    <div style={styles.memoryPanel} data-testid="design-memory-panel">
      <div style={styles.memoryHeader}>
        <div style={styles.sectionTitle}>Design memory</div>
        <button
          style={styles.memoryRefreshButton}
          onClick={onRefresh}
          disabled={loading}
          data-testid="refresh-design-memory"
        >
          {loading ? '...' : 'Refresh'}
        </button>
      </div>
      <MemoryList
        title="Templates"
        items={templates}
        empty="No saved templates yet."
        onOpen={onOpen}
        onUseTemplate={onUseTemplate}
      />
      <MemoryList
        title="Flows"
        items={flows}
        empty="No saved flows yet."
        onOpen={onOpen}
        onUseTemplate={onUseTemplate}
      />
    </div>
  );
}

function MemoryList({
  title,
  items,
  empty,
  onOpen,
  onUseTemplate,
}: {
  title: string;
  items: DesignMemoryItem[];
  empty: string;
  onOpen: (kind: 'template' | 'flow', id: string) => Promise<void>;
  onUseTemplate: (template: DesignMemoryItem) => Promise<void>;
}) {
  return (
    <div style={styles.memoryGroup}>
      <div style={styles.memoryGroupTitle}>{title}</div>
      {items.length === 0 ? (
        <div style={styles.memoryEmpty}>{empty}</div>
      ) : items.map((item) => (
        <div
          key={`${item.kind}-${item.id}`}
          style={styles.memoryItem}
          data-testid={`design-memory-${item.kind}-${item.id}`}
        >
          <div style={styles.memoryItemTop}>
            <strong style={styles.memoryName}>{item.name}</strong>
            <span style={styles.memoryDate}>{formatMemoryDate(item.createdAt)}</span>
          </div>
          <code style={styles.memoryPath}>{item.relativePath}</code>
          <div style={styles.memoryMeta}>
            {item.sourceRevision !== undefined ? `rev ${item.sourceRevision}` : item.id}
            {' | '}{item.validationStatus ?? 'legacy_unverified'}
            {item.simulationCoverage?.length ? ` | ${item.simulationCoverage.join(', ')}` : ''}
          </div>
          <div style={styles.memoryActions}>
            {item.kind === 'template' ? (
              <button
                style={styles.memoryActionButton}
                onClick={() => void onUseTemplate(item)}
                data-testid={`use-design-memory-template-${item.id}`}
              >
                Use
              </button>
            ) : null}
            <button
              style={styles.memoryActionButton}
              onClick={() => void onOpen(item.kind, item.id)}
              data-testid={`open-design-memory-${item.kind}-${item.id}`}
            >
              Open
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function SimulationMetrics({
  title,
  data,
}: {
  title: string;
  data: {
    ok: boolean;
    metrics?: Array<{ name: string; value: number | null; unit: string; pass?: boolean }>;
  };
}) {
  return (
    <div style={styles.simulationBlock}>
      <div style={styles.sectionTitle}>{title} simulation</div>
      <div style={styles.simStatus}>{data.ok ? 'ngspice passed' : 'ngspice failed'}</div>
      {data.metrics?.map((metric) => (
        <div key={metric.name} style={styles.metricRow}>
          <span>{metric.name}</span>
          <strong>{typeof metric.value === 'number' ? metric.value.toFixed(2) : '—'} {metric.unit}</strong>
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  root: { height: '100%', display: 'flex', flexDirection: 'column', background: '#f3f4f6', color: '#20242a' },
  historyOverlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 90,
    display: 'flex',
    justifyContent: 'flex-end',
    background: 'rgba(32, 39, 48, 0.24)',
  },
  historyPanel: {
    width: 520,
    maxWidth: 'calc(100vw - 28px)',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: '#ffffff',
    borderLeft: '1px solid #cbd1d8',
    boxShadow: '-10px 0 32px rgba(32, 39, 48, 0.16)',
  },
  edaExportPanel: {
    width: 620,
    maxWidth: 'calc(100vw - 28px)',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: '#ffffff',
    borderLeft: '1px solid #cbd1d8',
    boxShadow: '-10px 0 32px rgba(32, 39, 48, 0.16)',
  },
  edaExportBody: { minHeight: 0, flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 16 },
  edaExportField: { display: 'flex', flexDirection: 'column', gap: 7, color: '#3d4651', fontSize: 12, fontWeight: 700 },
  edaExportTargets: { display: 'flex', flexWrap: 'wrap', gap: '8px 18px' },
  edaMappingRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', gap: 7 },
  edaIntegrationDivider: { height: 1, background: '#e3e8ee', margin: '12px 0' },
  edaBridgeActions: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  edaBridgeRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 10,
    alignItems: 'flex-start',
    padding: '8px 0',
    borderTop: '1px solid #edf1f5',
  },
  edaBridgeRowActions: { display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' },
  lcscResults: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, maxHeight: 180, overflow: 'auto' },
  lcscResultRow: { display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: '#303741' },
  edaExportResult: { border: '1px solid #ccd7ce', borderRadius: 6, padding: 12, background: '#f5faf6', color: '#34433a', fontSize: 12 },
  edaExportStatus: { display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 6, textTransform: 'capitalize' },
  edaExportActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 16px', borderTop: '1px solid #dfe3e8' },
  historyHeader: {
    minHeight: 68,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    padding: '12px 16px',
    borderBottom: '1px solid #dfe3e8',
  },
  historyTitle: { color: '#252d37', fontSize: 17, fontWeight: 750 },
  historySubtitle: { marginTop: 3, color: '#737d89', fontSize: 11 },
  historyList: { minHeight: 0, flex: 1, overflowY: 'auto' },
  historyEmpty: { padding: 24, color: '#7a838e', fontSize: 12, textAlign: 'center' },
  historyEntry: { padding: '13px 16px', borderBottom: '1px solid #e5e8ec' },
  historyEntryHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 12 },
  historyActor: { color: '#68727e', fontWeight: 400 },
  historyMessage: { marginTop: 5, color: '#343d48', fontSize: 12, lineHeight: 1.45 },
  historyMeta: { marginTop: 4, color: '#89919b', fontSize: 10 },
  historyDiff: { marginTop: 8, color: '#53606d', fontSize: 11, cursor: 'pointer' },
  historyDiffText: {
    margin: '7px 0 0',
    padding: 8,
    overflowX: 'auto',
    background: '#edf8f1',
    color: '#256942',
    fontSize: 10,
    whiteSpace: 'pre-wrap',
  },
  historyDiffRemoved: {
    margin: '4px 0 0',
    padding: 8,
    overflowX: 'auto',
    background: '#fff0f2',
    color: '#98323e',
    fontSize: 10,
    whiteSpace: 'pre-wrap',
  },
  pendingReady: { color: '#15803d', fontSize: 10, fontWeight: 750, textTransform: 'uppercase' },
  pendingStale: { color: '#b45309', fontSize: 10, fontWeight: 750, textTransform: 'uppercase' },
  pendingOperationList: {
    margin: '7px 0 0',
    paddingLeft: 20,
    color: '#475569',
    fontSize: 11,
    lineHeight: 1.7,
  },
  pendingActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 10,
  },
  ercClean: { padding: 28, color: '#286744', fontSize: 12, textAlign: 'center' },
  ercDiagnostic: { padding: '13px 16px', borderBottom: '1px solid #e5e8ec', borderLeft: '3px solid #9ca6b2' },
  ercDiagnosticError: { borderLeftColor: '#b83242', background: '#fff8f8' },
  ercDiagnosticWarning: { borderLeftColor: '#c18a18', background: '#fffcf4' },
  ercDiagnosticHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    color: '#313a45',
    fontSize: 11,
    textTransform: 'uppercase',
  },
  ercDiagnosticMessage: { marginTop: 5, color: '#434d58', fontSize: 12, lineHeight: 1.45 },
  ercDiagnosticLocation: { marginTop: 5, color: '#7a838e', fontFamily: 'Consolas, monospace', fontSize: 10 },
  header: {
    minHeight: 66,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 16px',
    gap: 16,
    background: '#ffffff',
    borderBottom: '1px solid #d8dce2',
  },
  titleBlock: { minWidth: 0 },
  eyebrow: { fontSize: 10, color: '#7a818b', textTransform: 'uppercase', fontWeight: 750 },
  projectTitle: { fontSize: 18, fontWeight: 760, marginTop: 2 },
  projectMeta: { fontSize: 11, color: '#7a818b', marginTop: 2 },
  hierarchyBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    minHeight: 34,
    padding: '5px 14px',
    borderBottom: '1px solid #d8dce2',
    background: '#f8fafc',
    overflowX: 'auto',
    fontSize: 11,
  },
  hierarchyBackButton: {
    border: '1px solid #c5cbd3',
    borderRadius: 4,
    background: '#ffffff',
    color: '#425166',
    padding: '3px 7px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  hierarchyCrumbGroup: { display: 'inline-flex', alignItems: 'center', gap: 5 },
  hierarchySeparator: { color: '#94a3b8' },
  hierarchyCrumb: {
    border: 0,
    background: 'transparent',
    color: '#475569',
    padding: '3px 4px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  hierarchyCrumbActive: { color: '#1d4ed8', fontWeight: 750 },
  hierarchySearchButton: {
    marginLeft: 'auto',
    border: '1px solid #c5cbd3',
    borderRadius: 4,
    background: '#ffffff',
    color: '#334155',
    padding: '3px 8px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  hierarchyTrace: {
    padding: '3px 7px',
    borderRadius: 999,
    background: '#ede9fe',
    color: '#6d28d9',
    whiteSpace: 'nowrap',
  },
  schematicSearch: {
    position: 'relative',
    zIndex: 22,
    display: 'grid',
    gridTemplateColumns: 'minmax(280px, 460px)',
    gap: 5,
    padding: '7px 14px',
    borderBottom: '1px solid #d8dce2',
    background: '#f8fafc',
  },
  schematicSearchInput: {
    border: '1px solid #94a3b8',
    borderRadius: 5,
    padding: '6px 8px',
    fontSize: 11,
    color: '#172033',
    background: '#fff',
  },
  schematicSearchResults: {
    position: 'absolute',
    top: 39,
    left: 14,
    width: 'min(520px, calc(100vw - 290px))',
    maxHeight: 300,
    overflow: 'auto',
    display: 'grid',
    gap: 3,
    padding: 6,
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    background: '#fff',
    boxShadow: '0 12px 28px rgba(15, 23, 42, 0.18)',
  },
  schematicSearchResult: {
    display: 'grid',
    gridTemplateColumns: '82px minmax(0, 1fr)',
    gap: '2px 8px',
    alignItems: 'center',
    border: 0,
    borderRadius: 4,
    background: '#fff',
    padding: '6px 7px',
    textAlign: 'left',
    color: '#172033',
    cursor: 'pointer',
  },
  schematicSearchKind: {
    gridRow: '1 / span 2',
    fontSize: 9,
    textTransform: 'uppercase',
    color: '#2563eb',
    fontWeight: 750,
  },
  schematicSearchEmpty: { padding: 8, color: '#64748b', fontSize: 11 },
  projectKindField: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    fontSize: 11,
    color: '#7a818b',
  },
  simulationProfile: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    fontSize: 11,
    color: '#7a818b',
  },
  physicalButton: {
    marginTop: 6,
    width: 'fit-content',
    border: '1px solid #aeb8c4',
    borderRadius: 4,
    background: '#fff',
    color: '#435160',
    cursor: 'pointer',
    fontSize: 10,
    padding: '3px 7px',
  },
  pendingReviewButton: {
    marginTop: 6,
    width: 'fit-content',
    border: '1px solid #aeb8c4',
    borderRadius: 4,
    background: '#fff',
    color: '#435160',
    cursor: 'pointer',
    fontSize: 10,
    padding: '3px 7px',
  },
  pendingReviewButtonActive: {
    marginTop: 6,
    width: 'fit-content',
    border: '1px solid #d97706',
    borderRadius: 4,
    background: '#fff7ed',
    color: '#9a3412',
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 750,
    padding: '3px 7px',
  },
  primaryButton: {
    border: '1px solid #2563eb',
    borderRadius: 6,
    background: '#2563eb',
    color: '#fff',
    padding: '7px 12px',
    cursor: 'pointer',
    fontWeight: 680,
    fontSize: 12,
  },
  primaryButtonDisabled: {
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    background: '#e2e8f0',
    color: '#64748b',
    padding: '7px 12px',
    cursor: 'not-allowed',
    fontWeight: 680,
    fontSize: 12,
  },
  secondaryButton: {
    border: '1px solid #c5cbd3',
    borderRadius: 6,
    background: '#fff',
    color: '#303741',
    padding: '7px 12px',
    cursor: 'pointer',
    fontWeight: 650,
    fontSize: 12,
  },
  iconButton: {
    border: '1px solid #c5cbd3',
    borderRadius: 6,
    background: '#fff',
    color: '#525b66',
    padding: '7px 9px',
    cursor: 'pointer',
    fontSize: 11,
  },
  notice: { padding: '6px 14px', background: '#e9f7ee', color: '#23653e', borderBottom: '1px solid #c2e2ce', fontSize: 12 },
  noticeError: { background: '#fbe9e9', color: '#9c2525', borderBottom: '1px solid #e9b7b7' },
  body: { flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 310px' },
  canvasPanel: {
    overflow: 'auto',
    position: 'relative',
    background: '#f3f4f6',
    minWidth: 0,
    overflowAnchor: 'none',
  },
  boardViewport: { position: 'relative' },
  board: {
    position: 'relative',
    transformOrigin: 'top left',
    backgroundColor: '#fbfbfc',
    backgroundImage: 'radial-gradient(circle, #d7dbe0 1px, transparent 1px)',
    backgroundSize: '24px 24px',
    border: '1px solid #e0e3e8',
    boxShadow: '0 1px 3px rgba(24, 32, 44, 0.06)',
  },
  boardGuide: {
    position: 'absolute',
    top: 24,
    left: 28,
    color: '#9aa1aa',
    fontSize: 13,
    userSelect: 'none',
  },
  moduleCard: {
    position: 'absolute',
    display: 'flex',
    flexDirection: 'column',
    background: '#fff',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: '#d2d7de',
    borderRadius: 8,
    boxShadow: '0 5px 18px rgba(27, 38, 51, 0.10)',
    overflow: 'hidden',
    cursor: 'grab',
    userSelect: 'none',
    touchAction: 'none',
  },
  moduleCardSelected: {
    borderColor: '#2563eb',
    boxShadow: '0 0 0 3px rgba(37, 99, 235, 0.13), 0 8px 24px rgba(27, 38, 51, 0.12)',
  },
  moduleCardHeader: {
    minHeight: 50,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    padding: '9px 11px',
    borderBottom: '1px solid #e5e7eb',
    background: '#fff',
  },
  moduleTitleGroup: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  moduleKind: { color: '#8a929d', fontSize: 9, textTransform: 'uppercase', fontWeight: 800 },
  moduleName: { fontSize: 13, color: '#20242a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  previewToggle: { display: 'flex', alignItems: 'center', gap: 4, color: '#69727d', fontSize: 10, cursor: 'pointer' },
  previewBody: { flex: 1, minHeight: 80, padding: 9, background: '#f7f8fa' },
  svgPreview: { width: '100%', height: '100%', overflow: 'hidden', background: '#fff', border: '1px solid #e5e7eb' },
  previewMissing: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 5,
    border: '1px dashed #c7cdd5',
    color: '#77818d',
    fontSize: 12,
  },
  summaryBody: { flex: 1, minHeight: 80, padding: 12, background: '#fff', overflowY: 'auto' },
  functionText: { minHeight: 44, margin: 0, color: '#4f5965', fontSize: 11, lineHeight: 1.5 },
  parameterGrid: { marginTop: 8, borderTop: '1px solid #eceff2' },
  parameterRow: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 0', color: '#77818d', fontSize: 10 },
  interfaceStrip: { display: 'flex', gap: 5, flexWrap: 'wrap', padding: '8px 10px', borderTop: '1px solid #e8ebef' },
  interfaceBadge: { display: 'inline-flex', maxWidth: '100%', gap: 4, alignItems: 'center', borderRadius: 4, padding: '3px 6px', fontSize: 9 },
  interfaceNetworks: { minWidth: 0, overflowWrap: 'anywhere', fontFamily: 'Consolas, monospace' },
  interface_input: { background: '#eaf3ff', color: '#245a9b' },
  interface_output: { background: '#ebf7ee', color: '#2f6d40' },
  interface_ground: { background: '#f0f1f3', color: '#555f69' },
  cardFooter: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '7px 20px 7px 10px', background: '#fafbfc' },
  resizeHandle: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    width: 15,
    height: 15,
    cursor: 'nwse-resize',
    borderRight: '2px solid #8e98a4',
    borderBottom: '2px solid #8e98a4',
    borderRadius: 1,
    zIndex: 3,
    touchAction: 'none',
  },
  idButton: { border: 0, background: 'transparent', color: '#2563eb', fontFamily: 'Consolas, monospace', fontSize: 9, cursor: 'pointer', padding: 0 },
  cardFlags: { display: 'flex', gap: 7, color: '#9aa1aa', fontSize: 9 },
  inspector: { background: '#fff', borderLeft: '1px solid #d8dce2', padding: 15, overflowY: 'auto' },
  inspectorHeading: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  inspectorTitle: { margin: '3px 0 0', fontSize: 16, color: '#20242a' },
  copyButton: { border: '1px solid #cbd0d7', borderRadius: 5, background: '#fff', color: '#4e5965', padding: '5px 8px', cursor: 'pointer', fontSize: 10 },
  moduleId: { display: 'block', marginTop: 8, padding: '6px 8px', background: '#f3f5f7', color: '#2563eb', fontSize: 10, wordBreak: 'break-all' },
  sectionTitle: { margin: '18px 0 7px', color: '#7b8490', fontSize: 10, textTransform: 'uppercase', fontWeight: 800 },
  inspectorFunction: { margin: 0, color: '#4f5965', fontSize: 12, lineHeight: 1.55 },
  inspectorInterfaces: { display: 'flex', flexWrap: 'wrap', gap: 5 },
  inspectorParameters: { borderTop: '1px solid #eceff2' },
  inspectorParameterRow: { display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: '1px solid #eceff2', color: '#69727d', fontSize: 11 },
  noteInput: { width: '100%', minHeight: 110, resize: 'vertical', border: '1px solid #c8ced6', borderRadius: 6, padding: 9, color: '#303741', fontFamily: 'inherit', fontSize: 11, lineHeight: 1.5, marginBottom: 8 },
  inspectorActions: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, marginTop: 12 },
  inspectorEmpty: { color: '#8a929d', fontSize: 12, textAlign: 'center', marginTop: 80 },
  simulationBlock: { marginTop: 8 },
  simStatus: { color: '#277448', fontSize: 11, fontWeight: 750, marginBottom: 5 },
  metricRow: { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 0', fontSize: 9, borderBottom: '1px solid #eceff2' },
  memoryPanel: { marginTop: 12, borderTop: '1px solid #eceff2', paddingTop: 2 },
  memoryHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  memoryRefreshButton: {
    border: '1px solid #cbd0d7',
    borderRadius: 5,
    background: '#fff',
    color: '#4e5965',
    padding: '4px 7px',
    cursor: 'pointer',
    fontSize: 10,
  },
  memoryGroup: { marginTop: 8 },
  memoryGroupTitle: { color: '#69727d', fontSize: 10, fontWeight: 760, marginBottom: 6 },
  memoryEmpty: { color: '#9aa1aa', fontSize: 10, padding: '5px 0' },
  memoryItem: {
    padding: '7px 0',
    borderTop: '1px solid #eef1f4',
  },
  memoryItemTop: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' },
  memoryName: { minWidth: 0, color: '#303741', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  memoryDate: { flexShrink: 0, color: '#8a929d', fontSize: 9 },
  memoryPath: { display: 'block', marginTop: 4, color: '#2563eb', fontSize: 9, overflowWrap: 'anywhere' },
  memoryMeta: { marginTop: 3, color: '#7b8490', fontSize: 9 },
  memoryActions: { display: 'flex', gap: 6, marginTop: 6 },
  memoryActionButton: {
    border: '1px solid #cbd0d7',
    borderRadius: 5,
    background: '#fff',
    color: '#303741',
    padding: '4px 7px',
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 700,
  },
  moduleViewer: { minWidth: 720, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column', padding: 16, boxSizing: 'border-box' },
  moduleViewerHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  moduleViewerActions: { display: 'flex', alignItems: 'center', gap: 8 },
  moduleViewerTitle: { margin: '2px 0', fontSize: 18 },
  moduleViewerId: { color: '#7b8490', fontFamily: 'Consolas, monospace', fontSize: 10 },
  xschemPeerPanel: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    margin: '-2px 0 10px',
    padding: '8px 10px',
    border: '1px solid #d7dce3',
    borderRadius: 6,
    background: '#ffffff',
  },
  xschemPeerSummary: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    color: '#4e5965',
    fontSize: 11,
  },
  xschemPeerPath: {
    maxWidth: 320,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: '#7b8490',
    fontFamily: 'Consolas, monospace',
    fontSize: 10,
  },
  xschemPeerActions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 6,
  },
  layoutFeedback: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    margin: '-2px 0 10px',
    padding: '7px 10px',
    border: '1px solid #bfdbfe',
    borderRadius: 6,
    background: '#eff6ff',
    color: '#1e3a5f',
    fontSize: 11,
  },
  layoutToolbar: {
    minHeight: 40,
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
    padding: '7px 9px',
    border: '1px solid #d7dce3',
    borderRadius: 6,
    background: '#fff',
  },
  layoutCheck: { display: 'inline-flex', alignItems: 'center', gap: 6, color: '#4e5965', fontSize: 11, fontWeight: 700 },
  layoutNudgeGroup: { display: 'inline-flex', alignItems: 'center', gap: 4 },
  nudgeButton: {
    minWidth: 44,
    height: 30,
    padding: '0 7px',
    border: '1px solid #c5cbd3',
    borderRadius: 5,
    background: '#fff',
    color: '#303741',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 800,
  },
  layoutSelectedText: { flex: '1 1 120px', minWidth: 120, color: '#69727d', fontFamily: 'Consolas, monospace', fontSize: 10, overflowWrap: 'anywhere' },
  fullSvgStage: { flex: 1, minHeight: 0, display: 'flex', background: '#fff', border: '1px solid #d9dde3', boxShadow: '0 2px 8px rgba(27, 38, 51, 0.08)', overflow: 'auto' },
  fullSvg: { flex: 1, minWidth: 680, minHeight: 500, padding: 18 },
  documentSvgPanel: { flex: 1, minWidth: 0, minHeight: 0, height: '100%', padding: 18, boxSizing: 'border-box' },
  fullSvgEditing: { minWidth: 0, overflow: 'auto', outline: '2px solid rgba(37, 99, 235, 0.32)', outlineOffset: -2, cursor: 'move', touchAction: 'none' },
  fullSvgEmpty: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 10, color: '#7b8490', fontSize: 12 },
  overridePanel: {
    flex: '0 0 260px',
    minWidth: 220,
    maxWidth: 300,
    borderLeft: '1px solid #d9dde3',
    background: '#fbfcfd',
    padding: 12,
    overflowY: 'auto',
  },
  overridePanelTitle: { color: '#7b8490', fontSize: 10, textTransform: 'uppercase', fontWeight: 800, marginBottom: 8 },
  overrideEmpty: { color: '#8a929d', fontSize: 11, padding: '8px 0' },
  overrideItem: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: 7,
    padding: '7px 0',
    borderTop: '1px solid #edf0f3',
  },
  overrideItemSelected: { background: '#edf5ff' },
  overrideSelectButton: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    border: 0,
    background: 'transparent',
    color: '#303741',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: 'Consolas, monospace',
    fontSize: 10,
    overflow: 'hidden',
  },
  contextMenu: {
    position: 'fixed',
    zIndex: 40,
    minWidth: 180,
    padding: 5,
    border: '1px solid #c8ced6',
    borderRadius: 6,
    background: '#fff',
    boxShadow: '0 10px 30px rgba(26, 35, 48, 0.20)',
  },
  contextMenuItem: {
    display: 'block',
    width: '100%',
    padding: '8px 10px',
    border: 0,
    borderRadius: 4,
    background: '#fff',
    color: '#303741',
    textAlign: 'left',
    cursor: 'pointer',
    fontSize: 11,
  },
  modalBackdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 50,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    background: 'rgba(20, 27, 38, 0.36)',
  },
  modal: {
    width: 'min(520px, 100%)',
    maxHeight: 'calc(100vh - 48px)',
    overflowY: 'auto',
    padding: 18,
    border: '1px solid #cbd0d7',
    borderRadius: 8,
    background: '#fff',
    boxShadow: '0 18px 50px rgba(20, 27, 38, 0.24)',
  },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 },
  modalTitle: { margin: '3px 0 0', color: '#20242a', fontSize: 18 },
  modalClose: { border: 0, background: 'transparent', color: '#69727d', cursor: 'pointer', fontSize: 11 },
  fieldGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 11, color: '#69727d', fontSize: 10, fontWeight: 700 },
  fieldInput: { width: '100%', border: '1px solid #c8ced6', borderRadius: 5, padding: '8px 9px', color: '#303741', background: '#fff', fontFamily: 'inherit', fontSize: 12, fontWeight: 400 },
  modalError: { marginBottom: 10, padding: '7px 9px', borderRadius: 5, background: '#fbe9e9', color: '#9c2525', fontSize: 11 },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  empty: { height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', background: '#f5f6f8', color: '#334155', padding: 32, textAlign: 'center' },
  emptyBadge: { border: '1px solid #b9c0c9', borderRadius: 5, padding: '8px 14px', fontSize: 10, fontWeight: 800, color: '#2563eb' },
  emptyTitle: { fontSize: 24, margin: '18px 0 4px' },
  emptyText: { maxWidth: 560, color: '#69727d', lineHeight: 1.6, fontSize: 13 },
  emptyCreatePanel: {
    width: 'min(420px, 100%)',
    marginTop: 14,
    padding: 12,
    border: '1px solid #d8dee8',
    borderRadius: 6,
    background: '#fff',
    boxShadow: '0 6px 18px rgba(27, 38, 51, 0.08)',
    display: 'grid',
    gap: 10,
  },
  emptyCreateTitle: { color: '#4f5965', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', textAlign: 'left' },
  emptyProjectInput: { width: '100%', border: '1px solid #c8ced6', borderRadius: 5, padding: '8px 9px', color: '#303741', background: '#fff', fontFamily: 'inherit', fontSize: 12, fontWeight: 400 },
  emptyProjectKindField: { display: 'flex', flexDirection: 'column', gap: 4 },
  emptyProjectKindLabel: { color: '#59636e', fontSize: 11, fontWeight: 600 },
  emptyProjectKindSelect: { width: '100%', border: '1px solid #c8ced6', borderRadius: 5, padding: '8px 9px', color: '#303741', background: '#fff', fontFamily: 'inherit', fontSize: 12 },
  emptyCreateActions: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
  emptyNotice: { width: 'min(420px, 100%)', marginTop: 10, padding: '7px 9px', borderRadius: 5, fontSize: 11, textAlign: 'left' },
  actionRow: { display: 'flex', gap: 8, marginTop: 14 },
};
