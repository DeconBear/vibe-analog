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
} from 'react';
import type { CircuitComponent, CircuitModule, CircuitPin, CircuitPort, CircuitPosition, CircuitWire, ProjectKind } from '../../types';
import { SchematicDocumentSvg } from '../../schematic/SchematicDocumentSvg';
import { useKicadSymbolDefinitions } from '../../schematic/useKicadSymbolDefinitions';
import {
  applyPdkDeviceToComponent,
  ComponentParamForm,
  PdkDeviceBrowser,
  pdkDeviceToolType,
  type PdkDeviceCatalog,
  type PdkDeviceCatalogDevice,
} from './componentParams';
import { EditorCommandToolbar, FloatingComponentPalette } from './toolbars/SchematicToolbars';
import {
  collapseWireTopology,
  cutWireTopology,
  joinWireTopology,
  splitWireTopology,
  trimWireTopology,
} from '../../schematic-core/connectivity/wireTopology';
import {
  branchWireIds,
  netWireIds,
  wireSelectionScope,
} from '../../schematic-core/selection/netSelection';
import {
  deriveLiveErc,
  deriveLiveErcIncremental,
  summarizeLiveErc,
  type LiveErcDiagnostic,
} from '../../schematic-core/diagnostics/liveErc';
import {
  interactionStateFromSnapshot,
  interactionStatus,
  type InteractionStateName,
} from '../../schematic-core/commands/interactionStateMachine';
import {
  inspectModuleInstance,
  refreshModuleInstanceBinding,
} from '../../schematic-core/hierarchy/moduleInstance';
import {
  addWire,
  AUTO_LAYOUT_COMPONENT_LIMIT,
  cloneModule,
  COMPONENT_TYPES,
  componentBounds,
  hitComponent,
  hitEndpoint,
  hitPort,
  hitWire,
  makeId,
  makePlacedBlock,
  makePlacedComponent,
  makePlacedModuleInstance,
  netLabelBounds,
  normalizeConnectivity,
  normalizeRotation,
  pointToSegmentDistance,
  pointEndpoint,
  RAIL_LABEL_STUB,
  removeWireAndUpdateConnectivity,
  rerouteStoredWires,
  SCHEMATIC_GRID,
  snapPoint,
  type BlockDefinition,
  type BlockPinSide,
  type EndpointHit,
  type SchematicDocument,
  type SchematicBounds,
  type SchematicNetLabel,
  type SchematicSelection,
  type ToolComponentType,
  distance,
  pinWorld,
} from '../../schematic/schematicDocument';
import {
  projectSchematicDocument as createSchematicDocument,
  projectSchematicDocumentIncremental,
  type SchematicProjectionSnapshot,
} from '../../schematic-core/projection/facade';
import { analyzeSchematicComplexity } from '../../schematic-core/performance/complexity';

type ToolMode = 'select' | 'wire' | 'cut' | 'place' | 'place-block' | 'place-module';
type ComponentMoveMode = 'stretch' | 'free';
type EditorCursor = 'default' | 'crosshair' | 'grab' | 'grabbing' | 'copy' | 'move';

const AUTOPAN_MARGIN_PX = 44;
const AUTOPAN_STEP_RATIO = 0.055;
const MAX_BLOCK_PINS = 32;
const MAX_RENDERED_LIVE_DIAGNOSTICS = 120;

export interface ProjectModuleLibraryItem {
  module_id: string;
  name: string;
  revision: number;
  ports: CircuitPort[];
  parameter_defs?: CircuitModule['parameter_defs'];
}

interface BlockDraftPin {
  id: string;
  name: string;
  net: string;
  side: BlockPinSide;
}

interface BlockDraft {
  name: string;
  value: string;
  width: number;
  height: number;
  pins: BlockDraftPin[];
}

function defaultBlockDraft(): BlockDraft {
  return {
    name: '',
    value: 'Functional block',
    width: 180,
    height: 120,
    pins: [
      { id: 'p1', name: 'IN', net: 'block_in', side: 'left' },
      { id: 'p2', name: 'EN', net: 'block_en', side: 'left' },
      { id: 'p3', name: 'OUT', net: 'block_out', side: 'right' },
      { id: 'p4', name: 'GND', net: '0', side: 'bottom' },
    ],
  };
}

interface Props {
  projectId: string;
  module: CircuitModule;
  busy: boolean;
  buildBusy?: boolean;
  projectModules?: ProjectModuleLibraryItem[];
  projectKind?: ProjectKind;
  pdkDeviceCatalog?: PdkDeviceCatalog | null;
  onSave: (module: CircuitModule) => Promise<boolean | void>;
  onBuild: () => void;
  onProbe?: (probe: SchematicProbeSelection) => void;
  onDirtyChange?: (dirty: boolean) => void;
  hierarchyTrace?: {
    id: string;
    moduleId: string;
    net: string;
    netId?: string;
    label: string;
  } | null;
  locateTarget?: SchematicLocateTarget | null;
  onOpenChildModule?: (moduleId: string, instanceId: string, pinId?: string) => void;
}

interface EditorSession {
  sourceRevision: number;
  draft: CircuitModule;
  dirty: boolean;
  history: CircuitModule[];
  future: CircuitModule[];
  preserveNextRevision: boolean;
  viewport: SchematicBounds | null;
  selection: SchematicSelection;
}

const editorSessions = new Map<string, EditorSession>();

function cloneSelectionValue(selection: SchematicSelection): SchematicSelection {
  if (!selection) return null;
  if (selection.kind === 'components' || selection.kind === 'wires') {
    return { kind: selection.kind, ids: [...selection.ids] };
  }
  return { ...selection };
}

function freshEditorSession(module: CircuitModule): EditorSession {
  return {
    sourceRevision: module.revision,
    draft: createSchematicDocument(module).module,
    dirty: false,
    history: [],
    future: [],
    preserveNextRevision: false,
    viewport: null,
    selection: null,
  };
}

function initialEditorSession(key: string, module: CircuitModule): EditorSession {
  const cached = editorSessions.get(key);
  if (!cached) return freshEditorSession(module);
  if (cached.sourceRevision === module.revision) {
    return {
      ...cached,
      draft: cloneModule(cached.draft),
      history: cached.history.map(cloneModule),
      future: cached.future.map(cloneModule),
      viewport: cached.viewport ? { ...cached.viewport } : null,
      selection: cloneSelectionValue(cached.selection),
    };
  }
  if (cached.preserveNextRevision && module.revision > cached.sourceRevision) {
    return {
      sourceRevision: module.revision,
      draft: createSchematicDocument(module).module,
      dirty: false,
      history: cached.history.map(cloneModule),
      future: cached.future.map(cloneModule),
      preserveNextRevision: false,
      viewport: cached.viewport ? { ...cached.viewport } : null,
      selection: cloneSelectionValue(cached.selection),
    };
  }
  if (cached.dirty) {
    // Preserve the unsaved draft against an external revision bump. Its
    // original sourceRevision remains the save precondition, so a later save
    // is rejected as stale instead of silently merging.
    return {
      ...cached,
      draft: cloneModule(cached.draft),
      history: cached.history.map(cloneModule),
      future: cached.future.map(cloneModule),
      viewport: cached.viewport ? { ...cached.viewport } : null,
      selection: cloneSelectionValue(cached.selection),
    };
  }
  return freshEditorSession(module);
}

export interface SchematicProbeSelection {
  kind: 'voltage' | 'current' | 'power';
  label: string;
  candidates: string[];
  net?: string;
  netId?: string;
  wireId?: string;
  componentId?: string;
  pinId?: string;
  componentType?: CircuitComponent['type'];
}

function componentCurrentCandidates(component: CircuitComponent): string[] {
  const parameter = ({
    R: 'i', C: 'i', L: 'i', D: 'id', M: 'id', Q: 'ic', I: 'current',
  } as Partial<Record<CircuitComponent['type'], string>>)[component.type];
  return [
    ...(parameter ? [`i(@${component.name}[${parameter}])`] : []),
    `i(${component.name})`,
  ];
}

function componentPowerCandidates(component: CircuitComponent): string[] {
  return [
    `@${component.name}[p]`,
    `p(${component.name})`,
    `power(${component.name})`,
  ];
}

export interface SchematicLocateTarget {
  id: string;
  moduleId: string;
  kind: 'module' | 'component' | 'net';
  entityId?: string;
  net?: string;
  netId?: string;
}

interface DragState {
  mode: ComponentMoveMode;
  componentIds: string[];
  startWorld: CircuitPosition;
  originalPositions: Record<string, CircuitPosition>;
  lastPositions: Record<string, CircuitPosition>;
  originalModule: CircuitModule;
  originalDirty: boolean;
  moved: boolean;
  originalWires: CircuitWire[];
  largePreviewComponentNodes?: Map<string, SVGGElement>;
  largePreviewWireNodes?: Map<string, SVGGElement>;
  largePreviewWirePolylines?: Map<string, SVGPolylineElement[]>;
}

interface PortDragState {
  portId: string;
  startWorld: CircuitPosition;
  originalPosition: CircuitPosition;
  lastPosition: CircuitPosition;
  originalModule: CircuitModule;
  originalDirty: boolean;
  moved: boolean;
}

interface LabelDragState {
  componentId: string;
  pinId: string;
  startWorld: CircuitPosition;
  originalOffset: CircuitPosition;
  lastOffset: CircuitPosition;
  originalModule: CircuitModule;
  originalDirty: boolean;
  moved: boolean;
}

interface WireDragState {
  start: EndpointHit;
  startClient: CircuitPosition;
  moved: boolean;
}

interface PanState {
  startClient: CircuitPosition;
  originalViewBox: SchematicBounds;
}

interface WireSegmentDragState {
  wireId: string;
  segmentIndex: number;
  startWorld: CircuitPosition;
  originalPoints: CircuitPosition[];
  lastPoints: CircuitPosition[];
  originalModule: CircuitModule;
  originalDirty: boolean;
  moved: boolean;
  materializedWire?: CircuitWire;
}

interface WirePointDragState {
  wireId: string;
  pointIndex: number;
  startWorld: CircuitPosition;
  originalPoint: CircuitPosition;
  originalPoints: CircuitPosition[];
  originalModule: CircuitModule;
  originalDirty: boolean;
  moved: boolean;
}

interface MarqueeState {
  startWorld: CircuitPosition;
  currentWorld: CircuitPosition;
  startClient: CircuitPosition;
  moved: boolean;
}

interface ContextMenuState {
  x: number;
  y: number;
  world: CircuitPosition;
  selection: NonNullable<SchematicSelection>;
  pin?: { componentId: string; pinId: string };
}

type DraftUpdate = (current: CircuitModule) => CircuitModule;

export function SchematicEditor({
  projectId,
  module,
  busy,
  buildBusy = false,
  projectModules = [],
  projectKind = 'simulation',
  pdkDeviceCatalog = null,
  onSave,
  onBuild,
  onProbe,
  onDirtyChange,
  hierarchyTrace = null,
  locateTarget = null,
  onOpenChildModule,
}: Props) {
  const sessionKey = `${projectId}:${module.module_id}`;
  const initialSessionRef = useRef<EditorSession | null>(null);
  if (!initialSessionRef.current) {
    initialSessionRef.current = initialEditorSession(sessionKey, module);
  }
  const initialSession = initialSessionRef.current;
  const activeSessionKeyRef = useRef(sessionKey);
  const sourceRevisionRef = useRef(initialSession.sourceRevision);
  const [draft, setDraft] = useState(() => cloneModule(initialSession.draft));
  const [dirty, setDirty] = useState(initialSession.dirty);
  const [tool, setTool] = useState<ToolMode>('select');
  const [componentMoveMode, setComponentMoveMode] = useState<ComponentMoveMode>('stretch');
  const [placeType, setPlaceType] = useState<ToolComponentType>('R');
  const [placeRotation, setPlaceRotation] = useState(0);
  const [blockDialogOpen, setBlockDialogOpen] = useState(false);
  const [blockDraft, setBlockDraft] = useState<BlockDraft>(() => defaultBlockDraft());
  const [pendingBlock, setPendingBlock] = useState<BlockDefinition | null>(null);
  const [pendingModule, setPendingModule] = useState<ProjectModuleLibraryItem | null>(null);
  const [pdkBrowserOpen, setPdkBrowserOpen] = useState(false);
  const [pendingPdkPlacement, setPendingPdkPlacement] = useState<{
    device: PdkDeviceCatalogDevice;
    parameters: Record<string, string>;
  } | null>(null);
  const [selection, setSelection] = useState<SchematicSelection>(() => cloneSelectionValue(initialSession.selection));
  const [wireStart, setWireStart] = useState<EndpointHit | null>(null);
  const [hoverWorld, setHoverWorld] = useState<CircuitPosition | null>(null);
  const [hoverEndpoint, setHoverEndpoint] = useState<EndpointHit | null>(null);
  const [hoverSelection, setHoverSelection] = useState<SchematicSelection>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [interactionCursor, setInteractionCursor] = useState<EditorCursor>('default');
  const [viewport, setViewport] = useState<SchematicBounds | null>(
    () => initialSession.viewport ? { ...initialSession.viewport } : null,
  );
  const [editorFocused, setEditorFocused] = useState(false);
  const [marqueeBounds, setMarqueeBounds] = useState<SchematicBounds | null>(null);
  const [spacePanActive, setSpacePanActive] = useState(false);
  const [dragPreviewPositions, setDragPreviewPositions] = useState<Record<string, CircuitPosition> | null>(null);
  const [clipboardComponentCount, setClipboardComponentCount] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<CircuitModule[]>(() => initialSession.history.map(cloneModule));
  const [future, setFuture] = useState<CircuitModule[]>(() => initialSession.future.map(cloneModule));
  const editorShellRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const portDragRef = useRef<PortDragState | null>(null);
  const labelDragRef = useRef<LabelDragState | null>(null);
  const wireDragRef = useRef<WireDragState | null>(null);
  const wireSegmentDragRef = useRef<WireSegmentDragState | null>(null);
  const wirePointDragRef = useRef<WirePointDragState | null>(null);
  const marqueeRef = useRef<MarqueeState | null>(null);
  const panRef = useRef<PanState | null>(null);
  const componentClipboardRef = useRef<CircuitComponent[]>([]);
  const pasteSerialRef = useRef(0);
  const draftUpdateFrameRef = useRef<number | null>(null);
  const pendingDraftUpdateRef = useRef<DraftUpdate | null>(null);
  // M2-04: when true, the next module.revision change (from a successful
  // save) must not clear undo/redo history. Set before save, cleared by the
  // revision-change effect so only the save-induced bump is skipped.
  const preserveHistoryOnRevisionChangeRef = useRef(false);
  const viewportUpdateFrameRef = useRef<number | null>(null);
  const pendingViewportRef = useRef<SchematicBounds | null>(null);
  const dragPreviewFrameRef = useRef<number | null>(null);
  const pendingDragPreviewRef = useRef<Record<string, CircuitPosition> | null>(null);
  const previousBaseProjectionRef = useRef<SchematicProjectionSnapshot | null>(null);
  const previousBaseDiagnosticsRef = useRef<LiveErcDiagnostic[] | null>(null);
  const symbolDefinitions = useKicadSymbolDefinitions(draft);

  const baseProjection = useMemo(() => projectSchematicDocumentIncremental(
    draft,
    { autoLayout: false, symbolDefinitions },
    previousBaseProjectionRef.current,
  ), [draft, symbolDefinitions]);
  const baseDocument = baseProjection.document;
  useLayoutEffect(() => {
    previousBaseProjectionRef.current = baseProjection.snapshot;
  }, [baseProjection]);
  const previewDraft = useMemo(() => {
    if (!dragPreviewPositions) return draft;
    return moduleWithComponentPositions(draft, dragPreviewPositions);
  }, [draft, dragPreviewPositions]);
  const document = useMemo(() => (
    dragPreviewPositions
      ? createDragPreviewDocument(
          baseDocument,
          previewDraft,
          Object.keys(dragPreviewPositions),
          dragRef.current?.mode ?? componentMoveMode,
        )
      : baseDocument
  ), [baseDocument, componentMoveMode, dragPreviewPositions, previewDraft]);
  const baseLiveErc = useMemo(() => deriveLiveErcIncremental(
    baseDocument,
    baseProjection,
    previousBaseDiagnosticsRef.current,
  ), [baseDocument, baseProjection]);
  const baseLiveDiagnostics = baseLiveErc.diagnostics;
  useLayoutEffect(() => {
    previousBaseDiagnosticsRef.current = baseLiveDiagnostics;
  }, [baseLiveDiagnostics]);
  const liveDiagnostics = useMemo(() => (
    dragPreviewPositions && (dragRef.current?.mode ?? componentMoveMode) === 'stretch'
      ? baseLiveDiagnostics
      : deriveLiveErc(document)
  ), [baseLiveDiagnostics, componentMoveMode, document, dragPreviewPositions]);
  const liveErcMode = dragPreviewPositions ? 'full' : baseLiveErc.mode;
  const liveErcSummary = useMemo(() => summarizeLiveErc(liveDiagnostics), [liveDiagnostics]);
  const renderedLiveDiagnostics = useMemo(
    () => liveDiagnostics.slice(0, MAX_RENDERED_LIVE_DIAGNOSTICS),
    [liveDiagnostics],
  );
  const complexity = useMemo(() => analyzeSchematicComplexity(draft), [draft]);
  const rubberBandWireIds = useMemo(() => (
    dragPreviewPositions && (dragRef.current?.mode ?? componentMoveMode) === 'stretch'
      ? previewWireIdsForComponents(baseDocument.wires, Object.keys(dragPreviewPositions))
      : undefined
  ), [baseDocument.wires, componentMoveMode, dragPreviewPositions]);
  const detachedWireIds = useMemo(() => (
    dragPreviewPositions && (dragRef.current?.mode ?? componentMoveMode) === 'free'
      ? previewWireIdsForComponents(baseDocument.wires, Object.keys(dragPreviewPositions))
      : undefined
  ), [baseDocument.wires, componentMoveMode, dragPreviewPositions]);
  const displayedComponentPositions = useMemo(() => {
    return componentPositionsById(previewDraft, previewDraft.components.map((component) => component.id));
  }, [previewDraft]);
  const activeViewBox = viewport ?? document.viewBox;
  const zoom = Math.max(
    0.05,
    (document.viewBox.maxX - document.viewBox.minX) / Math.max(1, activeViewBox.maxX - activeViewBox.minX),
  );
  const selectedComponentIds = componentIdsForSelection(selection);
  const selectedComponent = selection?.kind === 'component'
    ? draft.components.find((component) => component.id === selection.id) ?? null
    : null;
  const selectedSymbolDefinition = selectedComponent?.eda?.symbol
    ? baseDocument.symbolDefinitions[selectedComponent.eda.symbol]
    : undefined;
  const selectedPackageOptions = useMemo(() => {
    if (!selectedComponent?.eda?.symbol) return [];
    const unit = selectedComponent.eda.unit ?? 1;
    const packages = new Map<string, CircuitComponent[]>();
    for (const component of draft.components) {
      const packageId = component.eda?.package_id;
      if (!packageId || component.eda?.symbol !== selectedComponent.eda.symbol) continue;
      const members = packages.get(packageId) ?? [];
      members.push(component);
      packages.set(packageId, members);
    }
    return [...packages.entries()]
      .filter(([packageId, members]) => packageId === selectedComponent.eda?.package_id
        || !members.some((member) => (member.eda?.unit ?? 1) === unit))
      .map(([id, members]) => ({ id, label: `${members[0]?.eda?.refdes ?? members[0]?.name ?? id} · ${id}` }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [draft.components, selectedComponent]);
  const selectedChildModule = selectedComponent?.type === 'MODULE'
    ? projectModules.find((entry) => (
        entry.module_id === (selectedComponent.module_ref?.module_id || selectedComponent.value)
      )) ?? null
    : null;
  const selectedModuleInspection = selectedComponent?.type === 'MODULE'
    ? inspectModuleInstance(selectedComponent, selectedChildModule
      ? {
          module_id: selectedChildModule.module_id,
          name: selectedChildModule.name,
          revision: selectedChildModule.revision,
          ports: selectedChildModule.ports,
          parameter_defs: selectedChildModule.parameter_defs,
        }
      : undefined)
    : null;
  const selectedPort = selection?.kind === 'port'
    ? draft.ports.find((port) => port.id === selection.id) ?? null
    : null;
  const selectedWire = selection?.kind === 'wire'
    ? document.wires.find((wire) => wire.id === selection.id) ?? null
    : null;
  const selectedWireIds = wireIdsForSelection(selection);
  const selectedWireScope = wireSelectionScope(document.wires, selectedWireIds);
  const selectedNetLabel = selection?.kind === 'netlabel'
    ? document.netLabels.find((label) => label.id === selection.id) ?? null
    : null;
  const wirePreview = hoverWorld
    ? hoverEndpoint ?? pointEndpoint(snapPoint(hoverWorld))
    : null;
  function readInteractionState(): InteractionStateName {
    return interactionStateFromSnapshot({
      dialogOpen: blockDialogOpen,
      panning: Boolean(panRef.current),
      editingWirePoint: Boolean(wirePointDragRef.current),
      editingWireSegment: Boolean(wireSegmentDragRef.current),
      moving: dragRef.current?.mode
        ?? (portDragRef.current || labelDragRef.current ? 'stretch' : null),
      selectingMarquee: Boolean(marqueeRef.current),
      wiring: Boolean(wireStart || wireDragRef.current || tool === 'wire'),
      placing: tool === 'place-module'
        ? 'module'
        : tool === 'place' || tool === 'place-block'
          ? 'component'
          : null,
      cutting: tool === 'cut',
    });
  }
  const interactionStateName = readInteractionState();
  const interactionStatusText = interactionStatus(interactionStateName);

  useEffect(() => {
    if (!hierarchyTrace?.id || hierarchyTrace.moduleId !== document.moduleId) return;
    const wireIds = document.wires
      .filter((wire) => (
        wire.net === hierarchyTrace.net
        || wire.net_id === hierarchyTrace.net
        || Boolean(hierarchyTrace.netId && wire.net_id === hierarchyTrace.netId)
      ))
      .map((wire) => wire.id);
    const frame = window.requestAnimationFrame(() => {
      setSelection(selectionForWireIds(wireIds));
      setActionNotice(
        `Hierarchy trace: ${hierarchyTrace.label} → ${hierarchyTrace.netId || hierarchyTrace.net}`,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [document.moduleId, hierarchyTrace?.id]);

  useEffect(() => {
    if (!locateTarget?.id || locateTarget.moduleId !== document.moduleId) return;
    const frame = window.requestAnimationFrame(() => {
      if (locateTarget.kind === 'module') {
        setSelection(null);
        setViewport(null);
        setActionNotice(`Located module ${document.module.name}`);
        return;
      }
      if (locateTarget.kind === 'component' && locateTarget.entityId) {
        const component = draft.components.find((entry) => entry.id === locateTarget.entityId);
        if (!component) return;
        const bounds = componentBounds(component);
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerY = (bounds.minY + bounds.maxY) / 2;
        const width = Math.max(360, bounds.maxX - bounds.minX + 240);
        const height = Math.max(280, bounds.maxY - bounds.minY + 200);
        setSelection({ kind: 'component', id: component.id });
        setViewport({
          minX: centerX - width / 2,
          minY: centerY - height / 2,
          maxX: centerX + width / 2,
          maxY: centerY + height / 2,
        });
        setActionNotice(`Located ${component.name}`);
        return;
      }
      const matchingWires = document.wires.filter((wire) => (
        Boolean(locateTarget.netId && wire.net_id === locateTarget.netId)
        || Boolean(locateTarget.net && wire.net === locateTarget.net)
      ));
      if (matchingWires.length > 0) {
        const points = matchingWires.flatMap((wire) => wire.points);
        const minX = Math.min(...points.map((point) => point.x));
        const minY = Math.min(...points.map((point) => point.y));
        const maxX = Math.max(...points.map((point) => point.x));
        const maxY = Math.max(...points.map((point) => point.y));
        const width = Math.max(420, maxX - minX + 240);
        const height = Math.max(300, maxY - minY + 200);
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        setSelection(selectionForWireIds(matchingWires.map((wire) => wire.id)));
        setViewport({
          minX: centerX - width / 2,
          minY: centerY - height / 2,
          maxX: centerX + width / 2,
          maxY: centerY + height / 2,
        });
        setActionNotice(`Located net ${locateTarget.net || locateTarget.netId}`);
        return;
      }
      const component = draft.components.find((entry) => entry.pins.some((pin) => (
        Boolean(locateTarget.netId && pin.net_id === locateTarget.netId)
        || Boolean(locateTarget.net && pin.net === locateTarget.net)
      )));
      if (component) {
        setSelection({ kind: 'component', id: component.id });
        setActionNotice(`Located ${locateTarget.net || locateTarget.netId} at ${component.name}`);
        return;
      }
      const port = draft.ports.find((entry) => (
        Boolean(locateTarget.netId && entry.net_id === locateTarget.netId)
        || Boolean(locateTarget.net && entry.net === locateTarget.net)
      ));
      if (port) setSelection({ kind: 'port', id: port.id });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [document.moduleId, locateTarget?.id]);

  // qucs-style placement ghost: the pending symbol follows the cursor (grid-snapped,
  // rotated by placeRotation) until placement mode is exited via Esc/right tool.
  const placeGhost = useMemo(() => {
    if (busy || contextMenu) return null;
    if (tool === 'place-block') {
      if (!pendingBlock || !hoverWorld) return null;
      const ghost = makePlacedBlock(cloneModule(draft), snapPoint(hoverWorld), pendingBlock);
      ghost.rotation = normalizeRotation(placeRotation);
      return ghost;
    }
    if (tool === 'place-module') {
      if (!pendingModule || !hoverWorld) return null;
      return makePlacedModuleInstance(cloneModule(draft), snapPoint(hoverWorld), {
        module_id: pendingModule.module_id,
        name: pendingModule.name,
        revision: pendingModule.revision,
        ports: pendingModule.ports,
        parameter_defs: pendingModule.parameter_defs,
      });
    }
    if (tool !== 'place' || !hoverWorld) return null;
    const baseGhost = makePlacedComponent(cloneModule(draft), placeType, snapPoint(hoverWorld), { projectKind });
    const ghost = pendingPdkPlacement && pdkDeviceCatalog
      ? applyPdkDeviceToComponent(
          baseGhost,
          pendingPdkPlacement.device,
          pdkDeviceCatalog,
          pendingPdkPlacement.parameters,
        )
      : baseGhost;
    ghost.rotation = normalizeRotation(ghost.rotation + placeRotation);
    return ghost;
  }, [
    busy,
    contextMenu,
    tool,
    pendingBlock,
    pendingModule,
    pendingPdkPlacement,
    pdkDeviceCatalog,
    hoverWorld,
    draft,
    placeType,
    placeRotation,
    projectKind,
  ]);
  const editorCursor: EditorCursor = (() => {
    if (interactionCursor === 'grabbing') return 'grabbing';
    if (spacePanActive) return 'grab';
    if (tool === 'wire' || tool === 'cut') return 'crosshair';
    if (tool === 'place' || tool === 'place-block' || tool === 'place-module') return 'copy';
    return interactionCursor;
  })();

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    const activeSessionKey = activeSessionKeyRef.current;
    const previous = editorSessions.get(activeSessionKey);
    editorSessions.set(activeSessionKey, {
      sourceRevision: sourceRevisionRef.current,
      draft: cloneModule(draft),
      dirty,
      history: history.map(cloneModule),
      future: future.map(cloneModule),
      preserveNextRevision: previous?.preserveNextRevision ?? false,
      viewport: viewport ? { ...viewport } : null,
      selection: cloneSelectionValue(selection),
    });
  }, [dirty, draft, future, history, selection, viewport]);

  useEffect(() => {
    const sessionChanged = activeSessionKeyRef.current !== sessionKey;
    let restoredSession: EditorSession | null = null;
    if (!sessionChanged && sourceRevisionRef.current === module.revision) return;
    if (sessionChanged) {
      const nextSession = initialEditorSession(sessionKey, module);
      restoredSession = nextSession;
      activeSessionKeyRef.current = sessionKey;
      sourceRevisionRef.current = nextSession.sourceRevision;
      preserveHistoryOnRevisionChangeRef.current = false;
      setDraft(cloneModule(nextSession.draft));
      setDirty(nextSession.dirty);
      setHistory(nextSession.history.map(cloneModule));
      setFuture(nextSession.future.map(cloneModule));
      setSaveError(
        nextSession.dirty && nextSession.sourceRevision !== module.revision
          ? (
              `Module revision changed from ${nextSession.sourceRevision} to ${module.revision} `
              + 'while this draft has unsaved edits. Save will remain blocked until the conflict is resolved.'
            )
          : null,
      );
    } else {
      const cached = editorSessions.get(sessionKey);
      const preserving = (
        preserveHistoryOnRevisionChangeRef.current
        || cached?.preserveNextRevision === true
      );
      preserveHistoryOnRevisionChangeRef.current = false;
      if (preserving) {
        sourceRevisionRef.current = module.revision;
        const nextDraft = createSchematicDocument(module).module;
        setDraft(nextDraft);
        setDirty(false);
        editorSessions.set(sessionKey, {
          sourceRevision: module.revision,
          draft: cloneModule(nextDraft),
          dirty: false,
          history: history.map(cloneModule),
          future: future.map(cloneModule),
          preserveNextRevision: false,
          viewport: viewport ? { ...viewport } : null,
          selection: cloneSelectionValue(selection),
        });
      } else if (dirty) {
        setSaveError(
          `Module revision changed from ${sourceRevisionRef.current} to ${module.revision} `
          + 'while this draft has unsaved edits. Save will remain blocked until the conflict is resolved.',
        );
        return;
      } else {
        sourceRevisionRef.current = module.revision;
        setDraft(createSchematicDocument(module).module);
        setDirty(false);
        setHistory([]);
        setFuture([]);
      }
    }
    cancelPendingViewportUpdate();
    cancelPendingDragPreviewUpdate();
    setTool('select');
    setPlaceRotation(0);
    setSelection(restoredSession ? cloneSelectionValue(restoredSession.selection) : null);
    setBlockDialogOpen(false);
    setBlockDraft(defaultBlockDraft());
    setPendingBlock(null);
    setWireStart(null);
    setHoverWorld(null);
    setHoverEndpoint(null);
    setHoverSelection(null);
    setContextMenu(null);
    setInteractionCursor('default');
    setViewport(restoredSession
      ? (restoredSession.viewport ? { ...restoredSession.viewport } : null)
      : viewport);
    setMarqueeBounds(null);
    setSpacePanActive(false);
    setDragPreviewPositions(null);
    if (!sessionChanged && !dirty) setSaveError(null);
    setActionNotice(null);
    componentClipboardRef.current = [];
    pasteSerialRef.current = 0;
    setClipboardComponentCount(0);
    // M2-04: a save bumps module.revision; the draft already matches the
    // saved content. Keep undo/redo history across save so Ctrl+Z works
    // after Apply (ADR-0004). A module switch restores that module's session.
  }, [module.module_id, module.revision, sessionKey]);

  const commitDraft = useCallback((next: CircuitModule, previous = draft) => {
    setHistory((items) => [...items, cloneModule(previous)].slice(-40));
    setFuture([]);
    setDraft(next);
    setDirty(true);
    setSaveError(null);
    setActionNotice(null);
  }, [draft]);

  function scheduleDraftUpdate(update: DraftUpdate) {
    pendingDraftUpdateRef.current = update;
    if (draftUpdateFrameRef.current !== null) return;
    draftUpdateFrameRef.current = window.requestAnimationFrame(() => {
      draftUpdateFrameRef.current = null;
      const pending = pendingDraftUpdateRef.current;
      pendingDraftUpdateRef.current = null;
      if (pending) setDraft(pending);
    });
  }

  function flushPendingDraftUpdate() {
    const pending = pendingDraftUpdateRef.current;
    pendingDraftUpdateRef.current = null;
    if (draftUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(draftUpdateFrameRef.current);
      draftUpdateFrameRef.current = null;
    }
    if (pending) setDraft(pending);
  }

  function cancelPendingDraftUpdate() {
    pendingDraftUpdateRef.current = null;
    if (draftUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(draftUpdateFrameRef.current);
      draftUpdateFrameRef.current = null;
    }
  }

  function scheduleViewportUpdate(next: SchematicBounds) {
    pendingViewportRef.current = next;
    if (viewportUpdateFrameRef.current !== null) return;
    viewportUpdateFrameRef.current = window.requestAnimationFrame(() => {
      viewportUpdateFrameRef.current = null;
      const pending = pendingViewportRef.current;
      pendingViewportRef.current = null;
      if (pending) setViewport(pending);
    });
  }

  function flushPendingViewportUpdate() {
    const pending = pendingViewportRef.current;
    pendingViewportRef.current = null;
    if (viewportUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(viewportUpdateFrameRef.current);
      viewportUpdateFrameRef.current = null;
    }
    if (pending) setViewport(pending);
  }

  function cancelPendingViewportUpdate() {
    pendingViewportRef.current = null;
    if (viewportUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(viewportUpdateFrameRef.current);
      viewportUpdateFrameRef.current = null;
    }
  }

  function scheduleDragPreviewPositions(next: Record<string, CircuitPosition>) {
    pendingDragPreviewRef.current = next;
    if (dragPreviewFrameRef.current !== null) return;
    dragPreviewFrameRef.current = window.requestAnimationFrame(() => {
      dragPreviewFrameRef.current = null;
      const pending = pendingDragPreviewRef.current;
      pendingDragPreviewRef.current = null;
      if (pending) setDragPreviewPositions(pending);
    });
  }

  function cancelPendingDragPreviewUpdate() {
    pendingDragPreviewRef.current = null;
    if (dragPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(dragPreviewFrameRef.current);
      dragPreviewFrameRef.current = null;
    }
  }

  function clearImperativeLargeDragPreview(drag: DragState | null) {
    const svg = svgRef.current;
    if (!svg || !drag) return;
    const componentNodes = drag.largePreviewComponentNodes?.values()
      ?? svg.querySelectorAll<SVGGElement>('[data-large-drag-component="true"]').values();
    for (const node of componentNodes) {
      node.removeAttribute('transform');
      node.removeAttribute('data-large-drag-component');
    }
    const originalById = new Map(drag.originalWires.map((wire) => [wire.id, wire]));
    const wireNodes = drag.largePreviewWireNodes?.values()
      ?? svg.querySelectorAll<SVGGElement>('[data-large-drag-wire="true"]').values();
    for (const node of wireNodes) {
      node.querySelector('[data-large-drag-overlay="true"]')?.remove();
      const wireId = node.getAttribute('data-wire-id') ?? '';
      const wire = originalById.get(wireId);
      if (wire) {
        const points = wire.points.map((point) => `${point.x},${point.y}`).join(' ');
        const polylines = drag.largePreviewWirePolylines?.get(wireId)
          ?? [...node.querySelectorAll<SVGPolylineElement>('polyline')];
        for (const polyline of polylines) {
          polyline.setAttribute('points', points);
        }
      }
      node.removeAttribute('data-large-drag-wire');
    }
    editorShellRef.current?.setAttribute('data-drag-preview', 'false');
    editorShellRef.current?.setAttribute('data-projection-scope', 'module');
    svg.style.cursor = 'grab';
  }

  function renderImperativeLargeDragPreview(
    drag: DragState,
    nextPositions: Record<string, CircuitPosition>,
  ) {
    const svg = svgRef.current;
    if (!svg) return;
    clearImperativeLargeDragPreview(drag);
    const draggedIds = new Set(drag.componentIds);
    for (const componentId of drag.componentIds) {
      const node = drag.largePreviewComponentNodes?.get(componentId);
      if (!node) continue;
      const original = drag.originalPositions[componentId];
      const next = nextPositions[componentId];
      if (!original || !next) continue;
      node.setAttribute('transform', `translate(${next.x - original.x} ${next.y - original.y})`);
      node.setAttribute('data-large-drag-component', 'true');
    }
    const sampleId = drag.componentIds[0];
    const original = sampleId ? drag.originalPositions[sampleId] : undefined;
    const next = sampleId ? nextPositions[sampleId] : undefined;
    const dx = original && next ? next.x - original.x : 0;
    const dy = original && next ? next.y - original.y : 0;
    for (const wire of drag.originalWires) {
      if (!wireTouchesPreviewComponent(wire, draggedIds)) continue;
      const previewWire = (
        drag.mode === 'free' && !wireOnlyTouchesDraggedComponents(wire, draggedIds)
      )
        ? wire
        : moveWireWithComponentSelection(wire, draggedIds, dx, dy);
      const node = drag.largePreviewWireNodes?.get(wire.id);
      if (!node) continue;
      const points = previewWire.points.map((point) => `${point.x},${point.y}`).join(' ');
      const polylines = drag.largePreviewWirePolylines?.get(wire.id)
        ?? [...node.querySelectorAll<SVGPolylineElement>('polyline')];
      for (const polyline of polylines) {
        polyline.setAttribute('points', points);
      }
      const overlay = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      overlay.setAttribute('points', points);
      overlay.setAttribute('fill', 'none');
      overlay.setAttribute('stroke', drag.mode === 'free' ? '#dc2626' : '#22c55e');
      overlay.setAttribute('stroke-width', '5');
      overlay.setAttribute('stroke-linecap', 'round');
      overlay.setAttribute('stroke-linejoin', 'round');
      overlay.setAttribute('stroke-dasharray', drag.mode === 'free' ? '5 6' : '10 8');
      overlay.setAttribute('opacity', drag.mode === 'free' ? '0.7' : '0.35');
      overlay.setAttribute('pointer-events', 'none');
      overlay.setAttribute('data-large-drag-overlay', 'true');
      overlay.setAttribute(
        'data-testid',
        drag.mode === 'free' ? 'schematic-detached-wire-preview' : 'schematic-rubber-band-wire',
      );
      node.appendChild(overlay);
      node.setAttribute('data-large-drag-wire', 'true');
    }
    editorShellRef.current?.setAttribute('data-drag-preview', 'true');
    editorShellRef.current?.setAttribute('data-projection-scope', 'affected-entities');
  }

  function markDirty() {
    setDirty((current) => (current ? current : true));
  }

  function beginComponentGroupDrag(componentIds: string[], world: CircuitPosition) {
    const largeSheet = draft.components.length > AUTO_LAYOUT_COMPONENT_LIMIT;
    if (largeSheet) {
      if (svgRef.current) svgRef.current.style.cursor = 'grabbing';
    } else {
      setInteractionCursor('grabbing');
    }
    const draggedIdSet = new Set(componentIds);
    const originalWires = (() => {
      const touchedNets = new Set(
        document.wires
          .filter((wire) => wireTouchesPreviewComponent(wire, draggedIdSet))
          .map((wire) => wire.net_id ?? wire.net)
          .filter((net): net is string => Boolean(net)),
      );
      return document.wires
        .filter((wire) => (
          wireTouchesPreviewComponent(wire, draggedIdSet)
          || touchedNets.has(wire.net_id ?? wire.net ?? '')
        ))
        .map((wire) => materializeEditableWire(wire));
    })();
    const drag: DragState = {
      mode: componentMoveMode,
      componentIds,
      startWorld: world,
      originalPositions: componentPositionsById(draft, componentIds),
      lastPositions: componentPositionsById(draft, componentIds),
      originalModule: cloneModule(draft),
      originalDirty: dirty,
      moved: false,
      // Persist the FULL nets of every wire touching the dragged set. draft.wires is
      // often empty until the first edit, so live generated wires must be captured —
      // but storing only the touching wires lets the >=4-endpoint spine/tree generator
      // re-decompose the rest of the net and add a parallel link after the move.
      originalWires,
    };
    if (largeSheet && svgRef.current) {
      drag.largePreviewComponentNodes = new Map(
        [...svgRef.current.querySelectorAll<SVGGElement>('[data-layer="components"] > [data-component-id]')]
          .map((node) => [node.getAttribute('data-component-id') ?? '', node] as const)
          .filter(([id]) => draggedIdSet.has(id)),
      );
      const affectedWireIds = new Set(originalWires.map((wire) => wire.id));
      drag.largePreviewWireNodes = new Map(
        [...svgRef.current.querySelectorAll<SVGGElement>('[data-wire-id]')]
          .map((node) => [node.getAttribute('data-wire-id') ?? '', node] as const)
          .filter(([id]) => affectedWireIds.has(id)),
      );
      drag.largePreviewWirePolylines = new Map(
        [...drag.largePreviewWireNodes].map(([id, node]) => [
          id,
          [...node.querySelectorAll<SVGPolylineElement>('polyline')],
        ]),
      );
    }
    dragRef.current = drag;
  }

  useEffect(() => () => {
    cancelPendingDraftUpdate();
    cancelPendingViewportUpdate();
    cancelPendingDragPreviewUpdate();
  }, []);

  function clientToWorld(svg: SVGSVGElement, clientX: number, clientY: number): CircuitPosition {
    svgRef.current = svg;
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const matrix = svg.getScreenCTM()?.inverse();
    if (!matrix) return { x: 0, y: 0 };
    const transformed = point.matrixTransform(matrix);
    return { x: transformed.x, y: transformed.y };
  }

  function screenToWorld(event: ReactPointerEvent<SVGSVGElement>): CircuitPosition {
    return clientToWorld(event.currentTarget, event.clientX, event.clientY);
  }

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;

    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (!svg) return;
      zoomAtClientPoint(svg, event.clientX, event.clientY, event.deltaY);
    }

    svg.addEventListener('wheel', handleWheel, { passive: false });
    return () => svg.removeEventListener('wheel', handleWheel);
  }, [activeViewBox, document.viewBox]);

  function zoomAtClientPoint(svg: SVGSVGElement, clientX: number, clientY: number, deltaY: number) {
    editorShellRef.current?.focus();
    const current = activeViewBox;
    const world = clientToWorld(svg, clientX, clientY);
    zoomAtWorldPoint(world, deltaY > 0 ? 1.14 : 0.88);
  }

  function zoomAtWorldPoint(world: CircuitPosition, factor: number) {
    const current = activeViewBox;
    const width = current.maxX - current.minX;
    const height = current.maxY - current.minY;
    const baseWidth = document.viewBox.maxX - document.viewBox.minX;
    const nextWidth = clamp(width * factor, Math.max(120, baseWidth * 0.18), Math.max(2400, baseWidth * 5));
    const nextHeight = nextWidth * (height / Math.max(1, width));
    const ratioX = (world.x - current.minX) / Math.max(1, width);
    const ratioY = (world.y - current.minY) / Math.max(1, height);
    const minX = world.x - ratioX * nextWidth;
    const minY = world.y - ratioY * nextHeight;
    setViewport({ minX, minY, maxX: minX + nextWidth, maxY: minY + nextHeight });
  }

  function autoPanViewport(svg: SVGSVGElement, clientX: number, clientY: number) {
    const box = svg.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const xDirection = clientX <= box.left + AUTOPAN_MARGIN_PX
      ? -1
      : clientX >= box.right - AUTOPAN_MARGIN_PX ? 1 : 0;
    const yDirection = clientY <= box.top + AUTOPAN_MARGIN_PX
      ? -1
      : clientY >= box.bottom - AUTOPAN_MARGIN_PX ? 1 : 0;
    if (xDirection === 0 && yDirection === 0) return;
    const current = pendingViewportRef.current ?? activeViewBox;
    const width = current.maxX - current.minX;
    const height = current.maxY - current.minY;
    const dx = xDirection * width * AUTOPAN_STEP_RATIO;
    const dy = yDirection * height * AUTOPAN_STEP_RATIO;
    scheduleViewportUpdate({
      minX: current.minX + dx,
      minY: current.minY + dy,
      maxX: current.maxX + dx,
      maxY: current.maxY + dy,
    });
  }

  function zoomAtViewCenter(factor: number) {
    const current = activeViewBox;
    zoomAtWorldPoint({
      x: (current.minX + current.maxX) / 2,
      y: (current.minY + current.maxY) / 2,
    }, factor);
  }

  function fitViewport() {
    cancelPendingViewportUpdate();
    panRef.current = null;
    setViewport(null);
    setInteractionCursor('default');
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (busy || (event.button !== 0 && event.button !== 1)) return;
    event.preventDefault();
    event.stopPropagation();
    svgRef.current = event.currentTarget;
    editorShellRef.current?.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    setHoverSelection(null);
    setContextMenu(null);

    if (event.button === 1 || (event.button === 0 && (event.altKey || spacePanActive))) {
      panRef.current = {
        startClient: { x: event.clientX, y: event.clientY },
        originalViewBox: activeViewBox,
      };
      setInteractionCursor('grabbing');
      return;
    }

    const world = screenToWorld(event);
    setHoverWorld(snapPoint(world));
    setHoverEndpoint(tool === 'wire' || tool === 'cut' || tool === 'place' || wireStart ? hitEndpoint(document, world) : null);

    if (tool === 'place-block') {
      if (!pendingBlock) {
        setBlockDialogOpen(true);
        return;
      }
      const next = cloneModule(draft);
      const component = makePlacedBlock(next, snapPoint(world), pendingBlock);
      component.rotation = normalizeRotation(placeRotation);
      next.components.push(component);
      commitDraft(next);
      setSelection({ kind: 'component', id: component.id });
      // Keep place-block mode armed (qucs-style continuous placement); Esc or the
      // select tool exits, and the pending block definition stays for the next click.
      setPlaceRotation(0);
      return;
    }

    if (tool === 'place-module') {
      if (!pendingModule) return;
      if (pendingModule.module_id === draft.module_id) return;
      const next = cloneModule(draft);
      const component = makePlacedModuleInstance(next, snapPoint(world), {
        module_id: pendingModule.module_id,
        name: pendingModule.name,
        revision: pendingModule.revision,
        ports: pendingModule.ports,
        parameter_defs: pendingModule.parameter_defs,
      });
      next.components.push(component);
      commitDraft(next);
      setSelection({ kind: 'component', id: component.id });
      setPlaceRotation(0);
      return;
    }

    if (tool === 'place') {
      const next = cloneModule(draft);
      const baseComponent = makePlacedComponent(next, placeType, snapPoint(world), { projectKind });
      const component = pendingPdkPlacement && pdkDeviceCatalog
        ? applyPdkDeviceToComponent(
            baseComponent,
            pendingPdkPlacement.device,
            pdkDeviceCatalog,
            pendingPdkPlacement.parameters,
          )
        : baseComponent;
      component.rotation = normalizeRotation((component.rotation ?? 0) + placeRotation);
      next.components.push(component);
      commitDraft(next);
      setSelection({ kind: 'component', id: component.id });
      // Stay in place mode so another symbol can be placed right away (qucs parity);
      // the next pending symbol starts from its default orientation again.
      setPlaceRotation(0);
      return;
    }

    if (tool === 'wire') {
      const hit = hitEndpoint(document, world) ?? pointEndpoint(snapPoint(world));
      if (!wireStart) {
        setWireStart(hit);
        wireDragRef.current = {
          start: hit,
          startClient: { x: event.clientX, y: event.clientY },
          moved: false,
        };
        return;
      }
      const next = cloneModule(draft);
      const nextWireStart = addWire(next, wireStart, hit, document.wires);
      if (!nextWireStart) return;
      commitDraft(next);
      setSelection({ kind: 'wire', id: next.wires.at(-1)?.id ?? '' });
      setWireStart(nextWireStart);
      setHoverWorld(null);
      setHoverEndpoint(null);
      wireDragRef.current = null;
      return;
    }

    if (tool === 'cut') {
      const hit = hitEditableWireSegment(document.wires, draft, world);
      if (!hit) {
        setActionNotice('Cut: click a wire segment');
        return;
      }
      applyWireCut(hit.wire.id, nearestPointOnWire(hit.wire, world));
      setTool('select');
      setHoverEndpoint(null);
      return;
    }

    // Prefer an explicit port hit-target before nearby pin/wire geometry. On dense
    // sheets (and some Linux pointer backends) ports otherwise lose to wire points.
    const portFromTarget = portFromPointerTarget(document, event.target);
    if (tool === 'select' && portFromTarget) {
      const position = document.portPositions.get(portFromTarget.id);
      if (position) {
        setSelection({ kind: 'port', id: portFromTarget.id });
        setInteractionCursor('grabbing');
        portDragRef.current = {
          portId: portFromTarget.id,
          startWorld: world,
          originalPosition: { ...position },
          lastPosition: { ...position },
          originalModule: cloneModule(draft),
          originalDirty: dirty,
          moved: false,
        };
        return;
      }
    }

    const directPinTarget = event.target instanceof Element
      && Boolean(event.target.closest('[data-endpoint-kind="pin"]'));
    const directPin = directPinTarget ? hitEndpoint(document, world) : null;
    const directPinComponent = directPin?.kind === 'pin'
      ? draft.components.find((component) => component.id === directPin.component_id)
      : undefined;
    if (
      tool === 'select'
      && directPin?.kind === 'pin'
      && directPinComponent?.type !== 'GND'
      && !endpointIsConnected(document, directPin)
    ) {
      setTool('wire');
      setWireStart(directPin);
      setHoverEndpoint(directPin);
      setHoverWorld(snapPoint(world));
      setSelection(null);
      setActionNotice(`Wiring from unconnected pin ${directPin.label}`);
      wireDragRef.current = {
        start: directPin,
        startClient: { x: event.clientX, y: event.clientY },
        moved: false,
      };
      return;
    }

    const wirePointHit = hitSelectedStoredWirePoint(document.wires, draft, selection, world);
    if (wirePointHit) {
      setSelection({ kind: 'wire', id: wirePointHit.wire.id });
      setInteractionCursor('grabbing');
      wirePointDragRef.current = {
        wireId: wirePointHit.wire.id,
        pointIndex: wirePointHit.pointIndex,
        startWorld: world,
        originalPoint: { ...wirePointHit.point },
        originalPoints: clonePoints(wirePointHit.wire.points),
        originalModule: cloneModule(draft),
        originalDirty: dirty,
        moved: false,
      };
      return;
    }

    const portHit = portFromPointerTarget(document, event.target) ?? hitPort(document, world);
    if (portHit) {
      const position = document.portPositions.get(portHit.id);
      if (!position) return;
      setSelection({ kind: 'port', id: portHit.id });
      setInteractionCursor('grabbing');
      portDragRef.current = {
        portId: portHit.id,
        startWorld: world,
        originalPosition: { ...position },
        lastPosition: { ...position },
        originalModule: cloneModule(draft),
        originalDirty: dirty,
        moved: false,
      };
      return;
    }

    const railLabelHit = railNetLabelFromPointerTarget(document, event.target)
      ?? hitRailNetLabel(document, world);
    if (railLabelHit) {
      const parentId = railLabelHit.endpoint.component_id;
      const currentComponentIds = componentIdsForSelection(selection);
      // When the parent is already in the selection, clicking its rail label
      // keeps the group and starts a component drag (parity with body/frame).
      // Otherwise the rail label is first-class: select it and drag the anchor.
      if (parentId && currentComponentIds.includes(parentId) && !event.shiftKey) {
        beginComponentGroupDrag(currentComponentIds, world);
        return;
      }
      setSelection({ kind: 'netlabel', id: railLabelHit.id });
      const labelComponent = draft.components.find((entry) => entry.id === railLabelHit.endpoint.component_id);
      const labelPinIndex = labelComponent?.pins.findIndex((entry) => entry.id === railLabelHit.endpoint.pin_id) ?? -1;
      const labelPin = labelPinIndex >= 0 ? labelComponent?.pins[labelPinIndex] : undefined;
      if (labelComponent && labelPin) {
        setInteractionCursor('grabbing');
        const originalOffset = labelPin.label_offset ?? defaultRailLabelOffset(railLabelHit.kind);
        labelDragRef.current = {
          componentId: labelComponent.id,
          pinId: labelPin.id,
          startWorld: world,
          originalOffset: { ...originalOffset },
          lastOffset: { ...originalOffset },
          originalModule: cloneModule(draft),
          originalDirty: dirty,
          moved: false,
        };
      } else {
        setInteractionCursor('default');
      }
      return;
    }

    const selectedHandleHit = selectedComponentHandleFromPointerTarget(document, event.target);
    const netLabelComponentHit = componentFromNetLabelPointerTarget(document, event.target)
      ?? hitNetLabelComponent(document, world);
    const directComponentHit = componentFromPointerTarget(document, event.target)
      ?? hitComponent(document, world)
      ?? netLabelComponentHit;
    const selectedFrameHit = selectedHandleHit ?? (!directComponentHit ? hitSelectedComponentFrame(document, selection, world) : null);
    const componentHit = selectedHandleHit ??
      directComponentHit ??
      selectedFrameHit ??
      null;
    if (componentHit) {
      const currentComponentIds = componentIdsForSelection(selection);
      if (event.shiftKey) {
        const nextComponentIds = currentComponentIds.includes(componentHit.id)
          ? currentComponentIds.filter((componentId) => componentId !== componentHit.id)
          : [...currentComponentIds, componentHit.id];
        setSelection(selectionForComponentIds(nextComponentIds));
        setInteractionCursor(nextComponentIds.includes(componentHit.id) ? 'grab' : 'default');
        return;
      }
      const alreadySelected = currentComponentIds.includes(componentHit.id);
      // Keep multi-selection and drag the whole group when clicking any selected member
      // (body, signal net-label, or selection frame/corner). Rail labels on an already
      // selected parent take the same path above; an unselected rail label stays first-class.
      const componentIds = alreadySelected && currentComponentIds.length > 0
        ? currentComponentIds
        : [componentHit.id];
      if (!alreadySelected) {
        setSelection(selectionForComponentIds(componentIds));
      }
      beginComponentGroupDrag(componentIds, world);
      return;
    }

    const wireSegmentHit = hitEditableWireSegment(document.wires, draft, world);
    if (wireSegmentHit) {
      if (event.shiftKey) {
        // Shift+click toggles wires in/out of a multi-wire selection without
        // starting a segment drag (component group drag stays mouse-only).
        const currentWireIds = wireIdsForSelection(selection);
        const nextWireIds = currentWireIds.includes(wireSegmentHit.wire.id)
          ? currentWireIds.filter((wireId) => wireId !== wireSegmentHit.wire.id)
          : [...currentWireIds, wireSegmentHit.wire.id];
        setSelection(selectionForWireIds(nextWireIds));
        setInteractionCursor('default');
        return;
      }
      setSelection({ kind: 'wire', id: wireSegmentHit.wire.id });
      const materializedWire = isStoredWire(wireSegmentHit.wire, draft)
        ? undefined
        : materializeEditableWire(wireSegmentHit.wire);
      setInteractionCursor('grabbing');
      wireSegmentDragRef.current = {
        wireId: wireSegmentHit.wire.id,
        segmentIndex: wireSegmentHit.segmentIndex,
        startWorld: world,
        originalPoints: clonePoints(wireSegmentHit.wire.points),
        lastPoints: clonePoints(wireSegmentHit.wire.points),
        originalModule: cloneModule(draft),
        originalDirty: dirty,
        moved: false,
        materializedWire,
      };
      return;
    }
    if (tool === 'select') {
      marqueeRef.current = {
        startWorld: world,
        currentWorld: world,
        startClient: { x: event.clientX, y: event.clientY },
        moved: false,
      };
      setMarqueeBounds(null);
      setInteractionCursor('default');
      return;
    }
    setSelection(null);
    setInteractionCursor('default');
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    event.stopPropagation();
    const pan = panRef.current;
    if (pan) {
      setHoverSelection(null);
      const svgBox = event.currentTarget.getBoundingClientRect();
      const width = pan.originalViewBox.maxX - pan.originalViewBox.minX;
      const height = pan.originalViewBox.maxY - pan.originalViewBox.minY;
      const dx = (event.clientX - pan.startClient.x) * (width / Math.max(1, svgBox.width));
      const dy = (event.clientY - pan.startClient.y) * (height / Math.max(1, svgBox.height));
      scheduleViewportUpdate({
        minX: pan.originalViewBox.minX - dx,
        minY: pan.originalViewBox.minY - dy,
        maxX: pan.originalViewBox.maxX - dx,
        maxY: pan.originalViewBox.maxY - dy,
      });
      setInteractionCursor('grabbing');
      return;
    }
    const world = screenToWorld(event);
    if (tool === 'wire' || tool === 'cut' || tool === 'place' || tool === 'place-block' || wireStart) {
      setHoverSelection(null);
      const hit = hitEndpoint(document, world);
      setHoverEndpoint((current) => (
        endpointIdentity(current) === endpointIdentity(hit) ? current : hit
      ));
      const nextHoverWorld = snapPoint(world);
      setHoverWorld((current) => (samePosition(current, nextHoverWorld) ? current : nextHoverWorld));
    } else if (tool === 'select') {
      const hit = hitEndpoint(document, world);
      const next = hit?.kind === 'pin' && !endpointIsConnected(document, hit) ? hit : null;
      setHoverEndpoint((current) => (
        endpointIdentity(current) === endpointIdentity(next) ? current : next
      ));
    }
    const wireDrag = wireDragRef.current;
    if (wireDrag && !wireDrag.moved) {
      wireDrag.moved = Math.abs(event.clientX - wireDrag.startClient.x) + Math.abs(event.clientY - wireDrag.startClient.y) > 8;
    }
    if (wireDrag) {
      setHoverSelection(null);
      if (wireDrag.moved) autoPanViewport(event.currentTarget, event.clientX, event.clientY);
      return;
    }
    const wirePointDrag = wirePointDragRef.current;
    if (wirePointDrag) {
      setHoverSelection(null);
      setInteractionCursor((current) => (current === 'grabbing' ? current : 'grabbing'));
      const nextPoint = snapPoint({
        x: wirePointDrag.originalPoint.x + world.x - wirePointDrag.startWorld.x,
        y: wirePointDrag.originalPoint.y + world.y - wirePointDrag.startWorld.y,
      });
      const nextPoints = clonePoints(wirePointDrag.originalPoints);
      nextPoints[wirePointDrag.pointIndex] = nextPoint;
      if (samePoints(nextPoints, wirePointDrag.originalPoints)) return;
      wirePointDrag.moved = true;
      scheduleDraftUpdate((current) => applyWirePointDrag(current, wirePointDrag, nextPoints));
      markDirty();
      autoPanViewport(event.currentTarget, event.clientX, event.clientY);
      return;
    }
    const wireSegmentDrag = wireSegmentDragRef.current;
    if (wireSegmentDrag) {
      setHoverSelection(null);
      setInteractionCursor((current) => (current === 'grabbing' ? current : 'grabbing'));
      const nextPoints = dragWireSegmentPoints(
        wireSegmentDrag.originalPoints,
        wireSegmentDrag.segmentIndex,
        world.x - wireSegmentDrag.startWorld.x,
        world.y - wireSegmentDrag.startWorld.y,
      );
      if (samePoints(nextPoints, wireSegmentDrag.lastPoints)) return;
      wireSegmentDrag.lastPoints = clonePoints(nextPoints);
      wireSegmentDrag.moved = true;
      scheduleDraftUpdate((current) => {
        const next = cloneModule(current);
        if (!next.wires) next.wires = [];
        let wire = next.wires.find((entry) => entry.id === wireSegmentDrag.wireId);
        if (!wire && wireSegmentDrag.materializedWire) {
          const materialized = cloneWire(wireSegmentDrag.materializedWire);
          next.wires.push(materialized);
          wire = materialized;
        }
        if (wire) wire.points = clonePoints(nextPoints);
        return next;
      });
      markDirty();
      autoPanViewport(event.currentTarget, event.clientX, event.clientY);
      return;
    }
    const portDrag = portDragRef.current;
    if (portDrag) {
      setHoverSelection(null);
      setInteractionCursor((current) => (current === 'grabbing' ? current : 'grabbing'));
      const nextPosition = snapPoint({
        x: portDrag.originalPosition.x + world.x - portDrag.startWorld.x,
        y: portDrag.originalPosition.y + world.y - portDrag.startWorld.y,
      });
      if (samePosition(portDrag.lastPosition, nextPosition)) return;
      portDrag.lastPosition = { ...nextPosition };
      portDrag.moved = true;
      scheduleDraftUpdate((current) => {
        const next = cloneModule(current);
        const port = next.ports.find((entry) => entry.id === portDrag.portId);
        if (port) port.position = { ...nextPosition };
        next.wires = rerouteStoredWires(next, { portIds: [portDrag.portId] });
        return next;
      });
      markDirty();
      autoPanViewport(event.currentTarget, event.clientX, event.clientY);
      return;
    }
    const labelDrag = labelDragRef.current;
    if (labelDrag) {
      setHoverSelection(null);
      setInteractionCursor((current) => (current === 'grabbing' ? current : 'grabbing'));
      const nextOffset = snapPoint({
        x: labelDrag.originalOffset.x + world.x - labelDrag.startWorld.x,
        y: labelDrag.originalOffset.y + world.y - labelDrag.startWorld.y,
      });
      if (samePosition(labelDrag.lastOffset, nextOffset)) return;
      labelDrag.lastOffset = { ...nextOffset };
      labelDrag.moved = true;
      scheduleDraftUpdate((current) => {
        const next = cloneModule(current);
        const component = next.components.find((entry) => entry.id === labelDrag.componentId);
        const pin = component?.pins.find((entry) => entry.id === labelDrag.pinId);
        if (pin) pin.label_offset = { ...nextOffset };
        return next;
      });
      markDirty();
      autoPanViewport(event.currentTarget, event.clientX, event.clientY);
      return;
    }
    const marquee = marqueeRef.current;
    if (marquee) {
      setHoverSelection(null);
      marquee.currentWorld = world;
      if (!marquee.moved) {
        marquee.moved = Math.abs(event.clientX - marquee.startClient.x) + Math.abs(event.clientY - marquee.startClient.y) > 6;
      }
      setMarqueeBounds(marquee.moved ? normalizedBounds(marquee.startWorld, world) : null);
      setInteractionCursor('default');
      if (marquee.moved) autoPanViewport(event.currentTarget, event.clientX, event.clientY);
      return;
    }
    const drag = dragRef.current;
    if (!drag) {
      if (tool === 'select') {
        const nextHoverSelection = hoverSelectionForWorld(document, draft, selection, world);
        setHoverSelection((current) => (
          selectionAttribute(current) === selectionAttribute(nextHoverSelection) ? current : nextHoverSelection
        ));
        setInteractionCursor((current) => {
          const next = cursorForWorld(document, draft, selection, world);
          return current === next ? current : next;
        });
      } else {
        setHoverSelection(null);
      }
      return;
    }
    const largeSheetPreview = draft.components.length > AUTO_LAYOUT_COMPONENT_LIMIT;
    if (!largeSheetPreview) {
      setHoverSelection(null);
      setInteractionCursor((current) => (current === 'grabbing' ? current : 'grabbing'));
    }
    const previewStartedAt = performance.now();
    const dx = world.x - drag.startWorld.x;
    const dy = world.y - drag.startWorld.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
    drag.moved = true;
    const nextPositions = Object.fromEntries(
      drag.componentIds.map((componentId) => {
        const original = drag.originalPositions[componentId];
        return [componentId, original ? snapPoint({ x: original.x + dx, y: original.y + dy }) : undefined];
      }).filter((entry): entry is [string, CircuitPosition] => Boolean(entry[1])),
    );
    if (samePositionMap(drag.lastPositions, nextPositions)) return;
    drag.lastPositions = clonePositionMap(nextPositions);
    if (largeSheetPreview) {
      renderImperativeLargeDragPreview(drag, nextPositions);
      // Force the affected SVG geometry through layout before recording the
      // sample. This captures DOM mutation + layout cost without folding the
      // monitor's refresh interval (typically 16.7ms at 60Hz) into the metric.
      void svgRef.current?.getBoundingClientRect().width;
    } else {
      scheduleDragPreviewPositions(nextPositions);
    }
    const metricsWindow = window as Window & { __actoviqDragPreviewMs?: number[] };
    const timings = metricsWindow.__actoviqDragPreviewMs;
    // Performance tests opt in by pre-seeding this array. Normal product use
    // does not publish or retain instrumentation on the global object.
    if (Array.isArray(timings)) {
      timings.push(performance.now() - previewStartedAt);
      if (timings.length > 200) timings.splice(0, timings.length - 200);
    }
    autoPanViewport(event.currentTarget, event.clientX, event.clientY);
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    flushPendingDraftUpdate();
    flushPendingViewportUpdate();
    if (panRef.current) {
      panRef.current = null;
      setInteractionCursor('default');
      return;
    }
    const wireDrag = wireDragRef.current;
    wireDragRef.current = null;
    if (wireDrag && tool === 'wire') {
      // Some Linux/Electron pointer paths deliver the release without intermediate
      // moves. Re-check client distance here so drag-to-wire still commits.
      const dragged = wireDrag.moved ||
        Math.abs(event.clientX - wireDrag.startClient.x) + Math.abs(event.clientY - wireDrag.startClient.y) > 8;
      if (dragged) {
        const world = screenToWorld(event);
        const end = hitEndpoint(document, world) ?? pointEndpoint(snapPoint(world));
        const next = cloneModule(draft);
        const nextWireStart = addWire(next, wireDrag.start, end, document.wires);
        if (!nextWireStart) {
          setInteractionCursor('default');
          return;
        }
        commitDraft(next);
        setSelection({ kind: 'wire', id: next.wires.at(-1)?.id ?? '' });
        setWireStart(nextWireStart);
        setHoverWorld(null);
        setHoverEndpoint(null);
        setInteractionCursor('default');
        return;
      }
      // Pure click: keep wireStart so the next click can finish the wire.
      setInteractionCursor('default');
      return;
    }
    const drag = dragRef.current;
    clearImperativeLargeDragPreview(drag);
    const portDrag = portDragRef.current;
    const labelDrag = labelDragRef.current;
    const wirePointDrag = wirePointDragRef.current;
    const wireSegmentDrag = wireSegmentDragRef.current;
    const marquee = marqueeRef.current;
    dragRef.current = null;
    portDragRef.current = null;
    labelDragRef.current = null;
    wirePointDragRef.current = null;
    wireSegmentDragRef.current = null;
    marqueeRef.current = null;
    cancelPendingDragPreviewUpdate();
    setMarqueeBounds(null);
    setDragPreviewPositions(null);
    const world = screenToWorld(event);
    setInteractionCursor(cursorForWorld(document, draft, selection, world));
    if (marquee) {
      setSelection(marquee.moved ? selectionForMarquee(document, normalizedBounds(marquee.startWorld, marquee.currentWorld)) : null);
      return;
    }
    if (labelDrag?.moved) {
      setHistory((items) => [...items, labelDrag.originalModule].slice(-40));
      setFuture([]);
      setDraft((current) => {
        const next = cloneModule(current);
        const component = next.components.find((entry) => entry.id === labelDrag.componentId);
        const pin = component?.pins.find((entry) => entry.id === labelDrag.pinId);
        if (pin) pin.label_offset = { ...labelDrag.lastOffset };
        return next;
      });
      setDirty(true);
      return;
    }
    if (wirePointDrag?.moved) {
      setHistory((items) => [...items, wirePointDrag.originalModule].slice(-40));
      setFuture([]);
      return;
    }
    if (wireSegmentDrag?.moved) {
      setHistory((items) => [...items, wireSegmentDrag.originalModule].slice(-40));
      setFuture([]);
      return;
    }
    if (portDrag) {
      const releaseWorld = screenToWorld(event);
      const releasePosition = snapPoint({
        x: portDrag.originalPosition.x + releaseWorld.x - portDrag.startWorld.x,
        y: portDrag.originalPosition.y + releaseWorld.y - portDrag.startWorld.y,
      });
      // Linux/Electron may omit intermediate moves; still commit when the release
      // point left the original snapped port position.
      const dragged = portDrag.moved || !samePosition(releasePosition, portDrag.originalPosition);
      if (dragged) {
        const finalPosition = portDrag.moved ? portDrag.lastPosition : releasePosition;
        setHistory((items) => [...items, portDrag.originalModule].slice(-40));
        setFuture([]);
        setDraft((current) => {
          const next = cloneModule(current);
          const port = next.ports.find((entry) => entry.id === portDrag.portId);
          if (port) port.position = { ...finalPosition };
          next.wires = rerouteStoredWires(next, { portIds: [portDrag.portId] });
          return next;
        });
        setDirty(true);
        return;
      }
    }
    if (!drag?.moved) {
      if (drag) setInteractionCursor('grab');
      return;
    }
    setHistory((items) => [...items, drag.originalModule].slice(-40));
    setFuture([]);
    setDraft((current) => {
      const next = cloneModule(current);
      applyComponentPositions(next, drag.lastPositions);
      const sampleId = drag.componentIds[0];
      const original = sampleId ? drag.originalPositions[sampleId] : null;
      const latest = sampleId ? drag.lastPositions[sampleId] : null;
      const dx = original && latest ? latest.x - original.x : 0;
      const dy = original && latest ? latest.y - original.y : 0;
      next.wires = commitWiresAfterComponentGroupMove(
        next,
        drag.componentIds,
        drag.originalWires,
        dx,
        dy,
        drag.mode,
      );
      return next;
    });
    setDirty(true);
  }

  function handlePointerCancel(event: ReactPointerEvent<SVGSVGElement>) {
    event.stopPropagation();
    // Only abort an in-flight drag/pan. Place / wire / cut modes survive
    // pointer capture loss and OS gesture cancellations.
    cancelActiveDrag();
  }

  function handlePointerLeave(event: ReactPointerEvent<SVGSVGElement>) {
    event.stopPropagation();
    setHoverSelection(null);
    if (!wireStart) {
      setHoverEndpoint(null);
      setHoverWorld(null);
    }
  }

  function handleContextMenu(event: ReactMouseEvent<SVGSVGElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (tool === 'place' || tool === 'place-block') {
      // qucs parity: right-click rotates the pending symbol during placement
      // (Esc exits place mode); it must not cancel the placement gesture.
      setPlaceRotation((current) => normalizeRotation(current + 90));
      return;
    }
    const activeGesture = Boolean(
      wireStart || tool !== 'select' || dragRef.current || portDragRef.current || labelDragRef.current || wireDragRef.current || wirePointDragRef.current || wireSegmentDragRef.current || marqueeRef.current || panRef.current,
    );
    const world = clientToWorld(event.currentTarget, event.clientX, event.clientY);
    const hitSelection = activeGesture
      ? null
      : contextMenuSelectionForTarget(document, draft, event.target, world);
    const pinTarget = activeGesture ? null : pinFromPointerTarget(document, event.target);
    // Right-clicking a member of the current multi-wire selection keeps the
    // group so the menu's Delete applies to all of them.
    const menuSelection = hitSelection?.kind === 'wire' &&
      selection?.kind === 'wires' &&
      selection.ids.includes(hitSelection.id)
      ? selection
      : hitSelection;
    cancelActiveDrag();
    setWireStart(null);
    setHoverWorld(null);
    setHoverEndpoint(null);
    setHoverSelection(null);
    setMarqueeBounds(null);
    setSpacePanActive(false);
    setTool('select');
    setInteractionCursor('default');
    if (menuSelection) {
      setSelection(menuSelection);
      const selectedWireId = menuSelection.kind === 'wire'
        ? menuSelection.id
        : menuSelection.kind === 'wires'
          ? menuSelection.ids[0]
          : undefined;
      const selectedWire = selectedWireId
        ? document.wires.find((wire) => wire.id === selectedWireId)
        : undefined;
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        world: selectedWire ? nearestPointOnWire(selectedWire, world) : snapPoint(world),
        selection: menuSelection,
        pin: pinTarget
          ? { componentId: pinTarget.component.id, pinId: pinTarget.pin.id }
          : undefined,
      });
    } else {
      setSelection(null);
      setContextMenu(null);
    }
  }

  function handleDoubleClick(event: ReactMouseEvent<SVGSVGElement>) {
    if (busy) return;
    if (tool === 'wire') {
      // qucs/KiCad parity: double-click ends the in-progress wire. The clicks
      // themselves already committed the final segment (or were rejected as
      // zero-length), so this only has to close the chain.
      if (!wireStart) return;
      event.preventDefault();
      event.stopPropagation();
      setWireStart(null);
      setHoverWorld(null);
      setHoverEndpoint(null);
      wireDragRef.current = null;
      setTool('select');
      return;
    }
    if (tool !== 'select') return;
    const world = clientToWorld(event.currentTarget, event.clientX, event.clientY);
    // Prefer components over nearby wires so double-clicking a symbol body opens
    // the inspector even when a routed net passes close to the artwork.
    const component = componentFromPointerTarget(document, event.target)
      ?? hitComponent(document, world)
      ?? componentFromNetLabelPointerTarget(document, event.target)
      ?? hitNetLabelComponent(document, world);
    if (component) {
      event.preventDefault();
      event.stopPropagation();
      setSelection({ kind: 'component', id: component.id });
      if (component.type === 'MODULE' && component.module_ref?.module_id && onOpenChildModule) {
        onOpenChildModule(component.module_ref.module_id, component.id);
        return;
      }
      // qucs parity: double-click edits the component. The property editor lives in
      // the side panel, so focus the primary param field and select its current text.
      // Defer past React commit + layout; Linux/Electron often needs more than one rAF.
      window.setTimeout(() => {
        const input = editorShellRef.current?.querySelector<HTMLInputElement>([
          '[data-testid="schematic-param-magnitude"]',
          '[data-testid="schematic-param-dc"]',
          '[data-testid="schematic-param-w"]',
          '[data-testid="schematic-editor-component-value"]',
        ].join(', '));
        input?.focus();
        input?.select();
      }, 0);
      return;
    }
    const wire = hitEditableWireSegment(document.wires, draft, world)?.wire
      ?? hitWire(document, world);
    if (wire) {
      event.preventDefault();
      event.stopPropagation();
      const selectNet = event.ctrlKey || event.metaKey;
      const wireIds = selectNet
        ? netWireIds(document.wires, wire.id)
        : branchWireIds(document.wires, wire.id);
      setSelection(selectionForWireIds(wireIds));
      setActionNotice(
        selectNet
          ? `Selected net ${wire.net ?? wire.id} (${wireIds.length} wires)`
          : `Selected branch (${wireIds.length} wires)`,
      );
    }
  }

  function cancelActiveDrag() {
    cancelPendingDraftUpdate();
    cancelPendingViewportUpdate();
    cancelPendingDragPreviewUpdate();
    const drag = dragRef.current;
    clearImperativeLargeDragPreview(drag);
    dragRef.current = null;
    const portDrag = portDragRef.current;
    portDragRef.current = null;
    const labelDrag = labelDragRef.current;
    labelDragRef.current = null;
    wireDragRef.current = null;
    const wirePointDrag = wirePointDragRef.current;
    wirePointDragRef.current = null;
    const wireSegmentDrag = wireSegmentDragRef.current;
    wireSegmentDragRef.current = null;
    marqueeRef.current = null;
    panRef.current = null;
    setMarqueeBounds(null);
    setDragPreviewPositions(null);
    setHoverSelection(null);
    setContextMenu(null);
    setInteractionCursor('default');
    if (wirePointDrag?.moved) {
      setDraft(wirePointDrag.originalModule);
      setDirty(wirePointDrag.originalDirty);
      return;
    }
    if (wireSegmentDrag?.moved) {
      setDraft(wireSegmentDrag.originalModule);
      setDirty(wireSegmentDrag.originalDirty);
      return;
    }
    if (labelDrag?.moved) {
      setDraft(labelDrag.originalModule);
      setDirty(labelDrag.originalDirty);
      return;
    }
    if (portDrag?.moved) {
      setDraft(portDrag.originalModule);
      setDirty(portDrag.originalDirty);
      return;
    }
    if (!drag) return;
    if (drag.moved) {
      setDraft(drag.originalModule);
      setDirty(drag.originalDirty);
    }
  }

  function cancelEditorInteraction() {
    cancelActiveDrag();
    setWireStart(null);
    setHoverWorld(null);
    setHoverEndpoint(null);
    setHoverSelection(null);
    setMarqueeBounds(null);
    setSpacePanActive(false);
    setBlockDialogOpen(false);
    setPdkBrowserOpen(false);
    setPendingBlock(null);
    setPendingModule(null);
    setPendingPdkPlacement(null);
    setPlaceRotation(0);
    setTool('select');
    setInteractionCursor('default');
    setActionNotice(null);
  }

  function nudgeSelectedComponents(dx: number, dy: number) {
    if (busy) return;
    const next = cloneModule(draft);
    if (selectedPort) {
      const port = next.ports.find((entry) => entry.id === selectedPort.id);
      const position = document.portPositions.get(selectedPort.id);
      if (!port || !position) return;
      port.position = snapPoint({ x: position.x + dx, y: position.y + dy });
      next.wires = rerouteStoredWires(next, { portIds: [selectedPort.id] });
      commitDraft(next);
      return;
    }
    if (selectedComponentIds.length === 0) return;
    let changed = false;
    for (const componentId of selectedComponentIds) {
      const component = next.components.find((entry) => entry.id === componentId);
      if (!component) continue;
      const nextPosition = snapPoint({
        x: component.position.x + dx,
        y: component.position.y + dy,
      });
      if (component.position.x === nextPosition.x && component.position.y === nextPosition.y) continue;
      component.position = nextPosition;
      changed = true;
    }
    if (!changed) return;
    next.wires = rerouteStoredWires(next, { componentIds: selectedComponentIds });
    commitDraft(next);
    setContextMenu(null);
  }

  function rotateSelectedComponents(targetSelection: SchematicSelection = selection) {
    const componentIds = componentIdsForSelection(targetSelection);
    if (componentIds.length === 0 || busy) return;
    const next = cloneModule(draft);
    let changed = false;
    for (const componentId of componentIds) {
      const component = next.components.find((entry) => entry.id === componentId);
      if (!component) continue;
      component.rotation = normalizeRotation((component.rotation ?? 0) + 90);
      changed = true;
    }
    if (!changed) return;
    next.wires = rerouteStoredWires(next, { componentIds });
    commitDraft(next);
    setContextMenu(null);
  }

  function duplicateSelectedComponents(targetSelection: SchematicSelection = selection) {
    const componentIds = componentIdsForSelection(targetSelection);
    if (componentIds.length === 0 || busy) return;
    const next = cloneModule(draft);
    const selectedIds = new Set(componentIds);
    const selectedComponents = draft.components.filter((component) => selectedIds.has(component.id));
    const copiedComponentIds = appendCopiedComponents(next, selectedComponents, SCHEMATIC_GRID * 2);
    if (copiedComponentIds.length === 0) return;
    commitDraft(next);
    setSelection(selectionForComponentIds(copiedComponentIds));
    setTool('select');
    setWireStart(null);
    setHoverEndpoint(null);
    setContextMenu(null);
    setInteractionCursor('grab');
  }

  function copySelectedComponents(targetSelection: SchematicSelection = selection) {
    const componentIds = componentIdsForSelection(targetSelection);
    if (componentIds.length === 0) return;
    const selectedIds = new Set(componentIds);
    componentClipboardRef.current = draft.components
      .filter((component) => selectedIds.has(component.id))
      .map(cloneComponent);
    setClipboardComponentCount(componentClipboardRef.current.length);
    pasteSerialRef.current = 0;
  }

  function pasteCopiedComponents() {
    if (busy || componentClipboardRef.current.length === 0) return;
    pasteSerialRef.current += 1;
    const next = cloneModule(draft);
    const copiedComponentIds = appendCopiedComponents(
      next,
      componentClipboardRef.current,
      SCHEMATIC_GRID * 2 * pasteSerialRef.current,
    );
    if (copiedComponentIds.length === 0) return;
    commitDraft(next);
    setSelection(selectionForComponentIds(copiedComponentIds));
    setTool('select');
    setWireStart(null);
    setHoverEndpoint(null);
    setHoverSelection(null);
    setContextMenu(null);
    setInteractionCursor('grab');
  }

  function handleKeyboardEvent(event: Pick<KeyboardEvent | ReactKeyboardEvent<HTMLDivElement>, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'preventDefault' | 'shiftKey' | 'target'>) {
    if (isEditableKeyboardTarget(event.target)) return;
    const key = event.key.toLowerCase();
    // Let the browser handle clipboard shortcuts when page text is selected
    // (e.g. AI chat transcript). Window-level listeners otherwise steal Ctrl+C.
    if ((event.ctrlKey || event.metaKey) && (key === 'c' || key === 'x' || key === 'a') && hasNonCollapsedDomTextSelection()) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (contextMenu) {
        setContextMenu(null);
        return;
      }
      const dialogWasOpen = blockDialogOpen;
      cancelEditorInteraction();
      if (!dialogWasOpen) setSelection(null);
      return;
    }
    if (event.key === 'Enter' && wireStart) {
      event.preventDefault();
      setWireStart(null);
      setHoverWorld(null);
      setHoverEndpoint(null);
      wireDragRef.current = null;
      setTool('select');
      setInteractionCursor('default');
      setActionNotice('Wire finished');
      return;
    }
    if (isSpacePanKey(event) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      setSpacePanActive(true);
      setInteractionCursor((current) => (current === 'grabbing' ? current : 'default'));
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selection) {
      event.preventDefault();
      deleteSelection();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'a') {
      event.preventDefault();
      setTool('select');
      setWireStart(null);
      setHoverEndpoint(null);
      setHoverSelection(null);
      setContextMenu(null);
      setSelection(selectionForComponentIds(draft.components.map((component) => component.id)));
      setInteractionCursor('default');
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 's') {
      event.preventDefault();
      if (!busy && dirty && !saveError) void saveAndRebuild();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'c') {
      event.preventDefault();
      copySelectedComponents();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'v') {
      event.preventDefault();
      pasteCopiedComponents();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'd') {
      event.preventDefault();
      duplicateSelectedComponents();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    if ((event.key === '+' || event.key === '=') && !event.altKey) {
      event.preventDefault();
      zoomAtViewCenter(0.88);
      return;
    }
    if ((event.key === '-' || event.key === '_') && !event.altKey) {
      event.preventDefault();
      zoomAtViewCenter(1.14);
      return;
    }
    if (event.key === 'Home' || ((event.ctrlKey || event.metaKey) && key === '0')) {
      event.preventDefault();
      fitViewport();
      return;
    }
    if (event.key === 'F7' || event.key === 'F8') {
      event.preventDefault();
      cancelActiveDrag();
      setTool('select');
      setComponentMoveMode(event.key === 'F7' ? 'free' : 'stretch');
      setWireStart(null);
      setHoverEndpoint(null);
      setHoverSelection(null);
      setInteractionCursor('default');
      return;
    }
    if (event.key.startsWith('Arrow') && (selectedComponentIds.length > 0 || selectedPort)) {
      event.preventDefault();
      const step = event.shiftKey ? SCHEMATIC_GRID * 5 : SCHEMATIC_GRID;
      if (event.key === 'ArrowLeft') nudgeSelectedComponents(-step, 0);
      if (event.key === 'ArrowRight') nudgeSelectedComponents(step, 0);
      if (event.key === 'ArrowUp') nudgeSelectedComponents(0, -step);
      if (event.key === 'ArrowDown') nudgeSelectedComponents(0, step);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (key === 'f') {
      event.preventDefault();
      fitViewport();
      return;
    }
    if (key === 'r' && (tool === 'place' || tool === 'place-block')) {
      // While placing, R rotates the pending symbol (qucs parity) instead of
      // rotating whatever component happens to be selected.
      event.preventDefault();
      setPlaceRotation((current) => normalizeRotation(current + 90));
      return;
    }
    if (key === 'r' && selectedComponentIds.length > 0) {
      event.preventDefault();
      setTool('select');
      setWireStart(null);
      setHoverEndpoint(null);
      setHoverSelection(null);
      setInteractionCursor('default');
      rotateSelectedComponents();
      return;
    }
    if (key === 'w') {
      event.preventDefault();
      setTool('wire');
      setWireStart(null);
      setHoverEndpoint(null);
      setHoverSelection(null);
      setInteractionCursor('default');
      return;
    }
    if (key === 'k') {
      event.preventDefault();
      cancelActiveDrag();
      setTool('cut');
      setWireStart(null);
      setHoverEndpoint(null);
      setHoverSelection(null);
      setInteractionCursor('crosshair');
      setActionNotice('Cut: click one wire segment; Esc cancels');
      return;
    }
    if (key === 's') {
      event.preventDefault();
      setTool('select');
      setWireStart(null);
      setHoverEndpoint(null);
      setHoverSelection(null);
      setInteractionCursor('default');
      return;
    }
    if (key === 'b') {
      event.preventDefault();
      openBlockDialog();
      return;
    }
    if (key === 'g') {
      // qucs parity: G places a ground symbol (multi-char type, so it needs an
      // explicit branch ahead of the single-letter component hotkeys).
      event.preventDefault();
      setTool('place');
      setPlaceType('GND');
      setPendingPdkPlacement(null);
      setPlaceRotation(0);
      setWireStart(null);
      setHoverEndpoint(null);
      setHoverSelection(null);
      setInteractionCursor('default');
      return;
    }
    const componentType = event.key.toUpperCase() as ToolComponentType;
    if ((COMPONENT_TYPES as readonly string[]).includes(componentType)) {
      event.preventDefault();
      setTool('place');
      setPlaceType(componentType);
      setPendingPdkPlacement(null);
      setPlaceRotation(0);
      setWireStart(null);
      setHoverEndpoint(null);
      setHoverSelection(null);
      setInteractionCursor('default');
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    handleKeyboardEvent(event);
  }

  function handleKeyUp(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (isSpacePanKey(event)) {
      event.preventDefault();
      setSpacePanActive(false);
      if (!panRef.current) setInteractionCursor('default');
    }
  }

  useEffect(() => {
    function handleWindowKeyDown(event: KeyboardEvent) {
      const shell = editorShellRef.current;
      if (!shell || event.defaultPrevented || isEditableKeyboardTarget(event.target)) return;
      const target = event.target;
      const activeElement = window.document.activeElement;
      if (target instanceof Node && shell.contains(target)) return;
      if (activeElement && activeElement !== window.document.body && !shell.contains(activeElement)) return;
      handleKeyboardEvent(event);
    }

    function handleWindowKeyUp(event: KeyboardEvent) {
      if (!isSpacePanKey(event) || isEditableKeyboardTarget(event.target)) return;
      setSpacePanActive(false);
      if (!panRef.current) setInteractionCursor('default');
    }

    function handleWindowBlur() {
      setSpacePanActive(false);
      if (!panRef.current) setInteractionCursor('default');
      cancelActiveDrag();
    }

    window.addEventListener('keydown', handleWindowKeyDown);
    window.addEventListener('keyup', handleWindowKeyUp);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown);
      window.removeEventListener('keyup', handleWindowKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  });

  function undo() {
    const previous = history.at(-1);
    if (!previous || busy) return;
    setFuture((items) => [...items, cloneModule(draft)].slice(-40));
    setHistory((items) => items.slice(0, -1));
    setDraft(previous);
    setDirty(true);
    setSelection(null);
    setWireStart(null);
    setHoverEndpoint(null);
    setHoverSelection(null);
    setContextMenu(null);
    setMarqueeBounds(null);
    setInteractionCursor('default');
  }

  function redo() {
    const next = future.at(-1);
    if (!next || busy) return;
    setHistory((items) => [...items, cloneModule(draft)].slice(-40));
    setFuture((items) => items.slice(0, -1));
    setDraft(next);
    setDirty(true);
    setSelection(null);
    setWireStart(null);
    setHoverEndpoint(null);
    setHoverSelection(null);
    setContextMenu(null);
    setMarqueeBounds(null);
    setInteractionCursor('default');
  }

  function topologyModuleForWireIds(wireIds: string[]): CircuitModule {
    const next = cloneModule(draft);
    if (!next.wires) next.wires = [];
    const existing = new Set(next.wires.map((wire) => wire.id));
    for (const wireId of wireIds) {
      if (existing.has(wireId)) continue;
      const visible = document.wires.find((wire) => wire.id === wireId);
      if (!visible) throw new Error(`wire ${wireId} is no longer visible`);
      next.wires.push(materializeEditableWire(visible, next));
      existing.add(wireId);
    }
    return next;
  }

  function commitWireTopology(
    action: string,
    update: () => { module: CircuitModule; affectedWireIds: string[]; removedWireIds: string[] },
  ) {
    try {
      const result = update();
      result.module.revision = draft.revision;
      commitDraft(result.module);
      const remaining = result.affectedWireIds.filter((wireId) => (
        !result.removedWireIds.includes(wireId)
        && result.module.wires.some((wire) => wire.id === wireId)
      ));
      setSelection(
        remaining.length > 1
          ? { kind: 'wires', ids: remaining }
          : remaining[0]
            ? { kind: 'wire', id: remaining[0] }
            : null,
      );
      setContextMenu(null);
      setActionNotice(action);
    } catch (error) {
      setContextMenu(null);
      setActionNotice(`${action} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function applyWireSplit(wireId: string, point: CircuitPosition) {
    const junctionIds = new Set(
      document.wires.flatMap((wire) => (
        [wire.from?.junction_id, wire.to?.junction_id]
          .filter((value): value is string => Boolean(value))
      )),
    );
    const junctionId = makeId('j', junctionIds);
    commitWireTopology('Wire split with explicit junction', () => (
      splitWireTopology(topologyModuleForWireIds([wireId]), wireId, point, junctionId)
    ));
  }

  function applyWireCut(wireId: string, point: CircuitPosition) {
    commitWireTopology('Wire cut into two electrical nets', () => (
      cutWireTopology(topologyModuleForWireIds([wireId]), wireId, point)
    ));
  }

  function applyWireTrim(wireId: string, point: CircuitPosition) {
    commitWireTopology('Dangling wire trimmed', () => (
      trimWireTopology(topologyModuleForWireIds([wireId]), wireId, point)
    ));
  }

  function applyWireCollapse(wireId: string) {
    commitWireTopology('Wire path collapsed', () => (
      collapseWireTopology(topologyModuleForWireIds([wireId]), wireId)
    ));
  }

  function applyWireJoin(wireIds: string[]) {
    commitWireTopology('Wire chain joined', () => (
      joinWireTopology(topologyModuleForWireIds(wireIds), wireIds)
    ));
  }

  function selectWireBranch(wireId: string) {
    const wireIds = branchWireIds(document.wires, wireId);
    setSelection(selectionForWireIds(wireIds));
    setContextMenu(null);
    setActionNotice(`Selected branch (${wireIds.length} wires)`);
  }

  function selectWireNet(wireId: string) {
    const wire = document.wires.find((candidate) => candidate.id === wireId);
    const wireIds = netWireIds(document.wires, wireId);
    setSelection(selectionForWireIds(wireIds));
    setContextMenu(null);
    setActionNotice(`Selected net ${wire?.net ?? wireId} (${wireIds.length} wires)`);
  }

  function togglePinNoConnect(componentId: string, pinId: string) {
    const component = document.module.components.find((candidate) => candidate.id === componentId);
    const pinIndex = component?.pins.findIndex((candidate) => candidate.id === pinId) ?? -1;
    const pin = pinIndex >= 0 ? component?.pins[pinIndex] : undefined;
    if (!component || !pin) {
      setContextMenu(null);
      setActionNotice('Pin is no longer available');
      return;
    }
    const point = pinWorld(component, pin, pinIndex);
    if (
      !pin.no_connect
      && endpointIsConnected(document, {
        kind: 'pin',
        x: point.x,
        y: point.y,
        component_id: component.id,
        pin_id: pin.id,
        label: `${component.name}.${pin.name}`,
        net: pin.net,
        net_id: pin.net_id,
      })
    ) {
      setContextMenu(null);
      setActionNotice('Disconnect the pin before marking it no-connect');
      return;
    }
    const next = cloneModule(draft);
    const nextPin = next.components
      .find((candidate) => candidate.id === componentId)
      ?.pins.find((candidate) => candidate.id === pinId);
    if (!nextPin) return;
    if (nextPin.no_connect) {
      delete nextPin.no_connect;
    } else {
      nextPin.no_connect = true;
    }
    commitDraft(next);
    setSelection({ kind: 'component', id: componentId });
    setContextMenu(null);
    setActionNotice(nextPin.no_connect ? 'Pin marked no-connect' : 'No-connect marker cleared');
  }

  function focusLiveDiagnostic(diagnostic: LiveErcDiagnostic) {
    if (diagnostic.component_id) {
      setSelection({ kind: 'component', id: diagnostic.component_id });
    } else if (diagnostic.port_id) {
      setSelection({ kind: 'port', id: diagnostic.port_id });
    } else if (diagnostic.wire_ids.length > 0) {
      setSelection(selectionForWireIds(diagnostic.wire_ids));
    }
    setActionNotice(diagnostic.message);
    setContextMenu(null);
  }

  function deleteSelection(targetSelection: SchematicSelection = selection) {
    if (!targetSelection || busy) return;
    if (targetSelection.kind === 'port') return;
    const next = cloneModule(draft);
    const componentIds = componentIdsForSelection(targetSelection);
    if (componentIds.length > 0) {
      const selectedIds = new Set(componentIds);
      next.components = next.components.filter((component) => !selectedIds.has(component.id));
      next.wires = (next.wires ?? []).filter((wire) => (
        !selectedIds.has(wire.from?.component_id ?? '') &&
        !selectedIds.has(wire.to?.component_id ?? '')
      ));
    } else if (targetSelection.kind === 'wire') {
      const selectedWire = document.wires.find((wire) => wire.id === targetSelection.id);
      if (selectedWire && !isStoredWire(selectedWire, next)) {
        next.wires = [
          ...(next.wires ?? []),
          ...document.wires
            .filter((wire) => wire.id !== selectedWire.id && wire.net === selectedWire.net && !isStoredWire(wire, next))
            .map((wire) => materializeEditableWire(wire, next)),
        ];
      }
      const updated = removeWireAndUpdateConnectivity(next, selectedWire ?? targetSelection.id);
      next.components = updated.components;
      next.ports = updated.ports;
      next.wires = updated.wires;
    } else if (targetSelection.kind === 'netlabel') {
      const label = document.netLabels.find((entry) => entry.id === targetSelection.id);
      if (!label || !label.endpoint.component_id || !label.endpoint.pin_id) return;
      const component = next.components.find((entry) => entry.id === label.endpoint.component_id);
      const pinIndex = component?.pins.findIndex((entry) => entry.id === label.endpoint.pin_id) ?? -1;
      const pin = pinIndex >= 0 ? component?.pins[pinIndex] : undefined;
      if (!component || !pin) return;
      // Convert the rail-labeled pin into a physical wire: deleting a rail label
      // keeps the net connected by wiring the pin to the nearest same-net node.
      const pinPoint = pinWorld(component, pin, pinIndex);
      const target = nearestNetEndpoint(document, pin.net, pinPoint, {
        componentId: component.id,
        pinId: pin.id,
      });
      if (!target) {
        setActionNotice(`Cannot delete ${label.name}: it is the only connection on net ${pin.net}`);
        return;
      }
      addWire(next, {
        kind: 'pin',
        x: pinPoint.x,
        y: pinPoint.y,
        component_id: component.id,
        pin_id: pin.id,
        label: `${component.name}.${pin.name}`,
        net: pin.net,
      }, target, document.wires);
    } else if (targetSelection.kind === 'wires') {
      // The whole batch is being deleted: never (re)materialize a sibling whose
      // id is in the selection, otherwise a same-net wire deleted earlier in
      // this loop would come back when a later generated wire is processed.
      const batchIds = new Set(targetSelection.ids);
      for (const wireId of targetSelection.ids) {
        const selectedWire = document.wires.find((wire) => wire.id === wireId);
        if (selectedWire && !isStoredWire(selectedWire, next)) {
          next.wires = [
            ...(next.wires ?? []),
            ...document.wires
              .filter((wire) => wire.id !== selectedWire.id && !batchIds.has(wire.id) && wire.net === selectedWire.net && !isStoredWire(wire, next))
              .map((wire) => materializeEditableWire(wire, next)),
          ];
        }
        const updated = removeWireAndUpdateConnectivity(next, selectedWire ?? wireId);
        next.components = updated.components;
        next.ports = updated.ports;
        next.wires = updated.wires;
      }
    }
    commitDraft(next);
    setSelection(null);
    setHoverSelection(null);
    setContextMenu(null);
    setInteractionCursor('default');
  }

  function openBlockDialog() {
    setBlockDraft(defaultBlockDraft());
    setBlockDialogOpen(true);
    setPendingBlock(null);
    setTool('select');
    setWireStart(null);
    setHoverEndpoint(null);
    setHoverSelection(null);
    setContextMenu(null);
  }

  function setBlockPinCount(value: number) {
    const count = clamp(Math.round(value || 1), 1, MAX_BLOCK_PINS);
    setBlockDraft((current) => {
      const pins = current.pins.slice(0, count);
      while (pins.length < count) {
        const index = pins.length;
        pins.push({
          id: `p${index + 1}`,
          name: `PIN${index + 1}`,
          net: `block_${index + 1}`,
          side: index % 2 === 0 ? 'left' : 'right',
        });
      }
      return { ...current, pins };
    });
  }

  function updateBlockDraftPin(index: number, patch: Partial<BlockDraftPin>) {
    setBlockDraft((current) => ({
      ...current,
      pins: current.pins.map((pin, pinIndex) => pinIndex === index ? { ...pin, ...patch } : pin),
    }));
  }

  function beginBlockPlacement() {
    const definition: BlockDefinition = {
      name: blockDraft.name,
      value: blockDraft.value,
      width: blockDraft.width,
      height: blockDraft.height,
      pins: blockDraft.pins.map((pin, index) => ({ ...pin, order: index })),
    };
    setPendingBlock(definition);
    setBlockDialogOpen(false);
    setTool('place-block');
    setWireStart(null);
    setHoverEndpoint(null);
    setHoverSelection(null);
    setInteractionCursor('default');
    editorShellRef.current?.focus();
  }

  function updateSelectedBlockPin(pinId: string, patch: Partial<CircuitPin>) {
    if (!selectedComponent || selectedComponent.type !== 'BLOCK') return;
    const next = cloneModule(draft);
    const component = next.components.find((entry) => entry.id === selectedComponent.id);
    const pin = component?.pins.find((entry) => entry.id === pinId);
    if (!component || !pin) return;
    const previousNet = pin.net;
    Object.assign(pin, patch);
    if (patch.net !== undefined) {
      pin.net = patch.net.trim() || previousNet;
      for (const wire of next.wires ?? []) {
        const touchesPin = [wire.from, wire.to].some((endpoint) => (
          endpoint?.component_id === component.id && endpoint.pin_id === pin.id
        ));
        if (touchesPin) wire.net = pin.net;
      }
    }
    next.wires = rerouteStoredWires(next, { componentIds: [component.id] });
    commitDraft(next);
  }

  function addSelectedBlockPin() {
    if (!selectedComponent || selectedComponent.type !== 'BLOCK' || selectedComponent.pins.length >= MAX_BLOCK_PINS) return;
    const next = cloneModule(draft);
    const component = next.components.find((entry) => entry.id === selectedComponent.id);
    if (!component) return;
    const existing = new Set(component.pins.map((pin) => pin.id));
    const pinId = makeId('p', existing);
    const index = component.pins.length;
    component.pins.push({
      id: pinId,
      name: `PIN${index + 1}`,
      net: `n_${component.id}_${index + 1}`,
      side: index % 2 === 0 ? 'left' : 'right',
      order: index,
    });
    next.wires = rerouteStoredWires(next, { componentIds: [component.id] });
    commitDraft(next);
  }

  function removeSelectedBlockPin(pinId: string) {
    if (!selectedComponent || selectedComponent.type !== 'BLOCK' || selectedComponent.pins.length <= 1) return;
    const next = cloneModule(draft);
    const component = next.components.find((entry) => entry.id === selectedComponent.id);
    if (!component) return;
    component.pins = component.pins.filter((pin) => pin.id !== pinId);
    next.wires = (next.wires ?? []).filter((wire) => ![wire.from, wire.to].some((endpoint) => (
      endpoint?.component_id === component.id && endpoint.pin_id === pinId
    )));
    next.wires = rerouteStoredWires(next, { componentIds: [component.id] });
    commitDraft(next);
  }

  function updateSelectedComponent(patch: Partial<CircuitComponent>) {
    if (!selectedComponent) return;
    const next = cloneModule(draft);
    const component = next.components.find((entry) => entry.id === selectedComponent.id);
    if (!component) return;
    Object.assign(component, patch);
    const packageId = component.eda?.package_id;
    if (packageId && (patch.name !== undefined || patch.value !== undefined || patch.eda !== undefined)) {
      const sharedEdaFields = ['refdes', 'footprint', 'footprint_hint', 'lcsc_id', 'mpn', 'manufacturer'] as const;
      for (const member of next.components) {
        if (member.id === component.id || member.eda?.package_id !== packageId) continue;
        if (patch.name !== undefined) member.name = component.name;
        if (patch.value !== undefined) member.value = component.value;
        if (patch.eda !== undefined) {
          const memberEda = { ...(member.eda ?? {}) };
          for (const field of sharedEdaFields) {
            const value = component.eda?.[field];
            if (value === undefined || value === '') delete memberEda[field];
            else memberEda[field] = value;
          }
          member.eda = memberEda;
        }
      }
    }
    if (patch.rotation !== undefined) {
      component.rotation = normalizeRotation(Number(patch.rotation));
      next.wires = rerouteStoredWires(next, { componentIds: [component.id] });
    }
    commitDraft(next);
  }

  function changeSelectedSymbolUnit(unit: number) {
    if (!selectedComponent || !selectedSymbolDefinition || unit === (selectedComponent.eda?.unit ?? 1)) return;
    const electricallyConnected = (draft.wires ?? []).some((wire) => [wire.from, wire.to].some((endpoint) => (
      endpoint?.component_id === selectedComponent.id
    ))) || selectedComponent.pins.some((pin) => (
      draft.ports.some((port) => port.net === pin.net)
      || draft.components.some((component) => component.id !== selectedComponent.id
        && component.pins.some((candidate) => candidate.net === pin.net))
    ));
    if (electricallyConnected) {
      setActionNotice('Disconnect every pin before changing a multi-unit symbol unit.');
      return;
    }
    const target = selectedSymbolDefinition.variants.find((variant) => (
      variant.unit === unit && variant.variant === (selectedComponent.eda?.symbol_variant ?? 1)
    ));
    if (!target) {
      setActionNotice(`KiCad symbol unit ${unit} is unavailable.`);
      return;
    }
    const packageId = selectedComponent.eda?.package_id;
    if (packageId && draft.components.some((component) => (
      component.id !== selectedComponent.id
      && component.eda?.package_id === packageId
      && (component.eda.unit ?? 1) === unit
    ))) {
      setActionNotice(`Package ${packageId} already contains unit ${unit}.`);
      return;
    }
    const next = cloneModule(draft);
    const component = next.components.find((entry) => entry.id === selectedComponent.id);
    if (!component) return;
    component.eda = { ...(component.eda ?? {}), unit };
    component.pins = target.pins.map((pin, index) => ({
      id: pin.number,
      name: pin.name && pin.name !== '~' ? pin.name : pin.number,
      net: `nc_${component.id}_${pin.number}`,
      side: pin.angle === 0 ? 'left' : pin.angle === 180 ? 'right' : pin.angle === 90 ? 'top' : 'bottom',
      order: index,
      no_connect: true,
    }));
    commitDraft(next);
    setActionNotice(`Changed ${component.name} to unit ${unit}; all target-unit pins are explicit no-connects.`);
  }

  function changeSelectedPackage(packageId: string) {
    if (!selectedComponent || !packageId || packageId === selectedComponent.eda?.package_id) return;
    const source = draft.components.find((component) => component.eda?.package_id === packageId);
    if (!source || source.eda?.symbol !== selectedComponent.eda?.symbol) return;
    const unit = selectedComponent.eda?.unit ?? 1;
    if (draft.components.some((component) => component.eda?.package_id === packageId && (component.eda.unit ?? 1) === unit)) {
      setActionNotice(`Package ${packageId} already contains unit ${unit}.`);
      return;
    }
    const sharedFields = ['refdes', 'footprint', 'footprint_hint', 'lcsc_id', 'mpn', 'manufacturer'] as const;
    const eda = { ...(selectedComponent.eda ?? {}), package_id: packageId };
    for (const field of sharedFields) {
      const value = source.eda?.[field];
      if (value === undefined || value === '') delete eda[field];
      else eda[field] = value;
    }
    updateSelectedComponent({ name: source.name, value: source.value, eda });
  }

  function refreshSelectedModuleInstance() {
    if (!selectedComponent || selectedComponent.type !== 'MODULE' || !selectedChildModule) return;
    const next = cloneModule(draft);
    const component = next.components.find((entry) => entry.id === selectedComponent.id);
    if (!component) return;
    const refreshed = refreshModuleInstanceBinding(component, {
      module_id: selectedChildModule.module_id,
      name: selectedChildModule.name,
      revision: selectedChildModule.revision,
      ports: selectedChildModule.ports,
      parameter_defs: selectedChildModule.parameter_defs,
    });
    const nextPinIds = new Set(refreshed.pins.map((pin) => pin.id));
    next.wires = (next.wires ?? []).filter((wire) => ![wire.from, wire.to].some((endpoint) => (
      endpoint?.component_id === component.id
      && endpoint.pin_id
      && !nextPinIds.has(endpoint.pin_id)
    )));
    Object.assign(component, refreshed);
    next.wires = rerouteStoredWires(next, { componentIds: [component.id] });
    commitDraft(next);
    setActionNotice(`Updated ${component.name} to ${selectedChildModule.module_id} revision ${selectedChildModule.revision}`);
  }

  async function saveAndRebuild() {
    if (saveError) return;
    try {
      const normalized = normalizeConnectivity(draft);
      // M2-04: set the preserve flag BEFORE onSave so the revision bump that
      // happens during onSave (applyOperations -> onReloadProject, plus
      // buildModulePreview -> onReloadProject) does not clear undo/redo.
      preserveHistoryOnRevisionChangeRef.current = true;
      const cached = editorSessions.get(sessionKey);
      if (cached) {
        editorSessions.set(sessionKey, { ...cached, preserveNextRevision: true });
      }
      const saved = await onSave(normalized);
      if (saved === false) throw new Error('Apply command was rejected');
      // Re-arm in case buildModulePreview triggers a second revision bump
      // after the first useEffect consumed the flag.
      preserveHistoryOnRevisionChangeRef.current = true;
      setSaveError(null);
      setDirty(false);
      // M2-04: keep undo/redo history across save so Ctrl+Z works after Apply
      // (ADR-0004). Previously save cleared history/future, which broke the
      // undo loop and made "place -> move -> save -> undo" impossible.
    } catch (error) {
      preserveHistoryOnRevisionChangeRef.current = false;
      const cached = editorSessions.get(sessionKey);
      if (cached) {
        editorSessions.set(sessionKey, { ...cached, preserveNextRevision: false });
      }
      // Keep the draft dirty and surface the failure — previously a topology
      // validation throw or a rejected apply left no trace (silent data loss).
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div
      ref={editorShellRef}
      style={editorFocused ? { ...styles.editorShell, ...styles.editorShellFocused } : styles.editorShell}
      data-testid="schematic-editor"
      data-module-id={draft.module_id}
      data-tool={tool}
      data-move-mode={componentMoveMode}
      data-busy={busy ? 'true' : 'false'}
      data-preview-busy={buildBusy ? 'true' : 'false'}
      data-dirty={dirty ? 'true' : 'false'}
      data-history-count={String(history.length)}
      data-future-count={String(future.length)}
      data-source-revision={String(sourceRevisionRef.current)}
      data-save-error={saveError ?? ''}
      data-place-rotation={tool === 'place' || tool === 'place-block' ? String(placeRotation) : ''}
      data-selected={selectionAttribute(selection)}
      data-selected-component-count={String(selectedComponentIds.length)}
      data-selected-wire-count={String(wireIdsForSelection(selection).length)}
      data-selected-wire-scope={selectedWireScope}
      data-clipboard-component-count={String(clipboardComponentCount)}
      data-hover-target={selectionAttribute(hoverSelection)}
      data-hover-endpoint={hoverEndpoint ? hoverEndpoint.label : ''}
      data-wire-start={endpointIdentity(wireStart)}
      data-cursor-mode={editorCursor}
      data-zoom={zoom.toFixed(3)}
      data-space-pan={spacePanActive ? 'true' : 'false'}
      data-block-dialog={blockDialogOpen ? 'true' : 'false'}
      data-block-placement-ready={pendingBlock ? 'true' : 'false'}
      data-viewport={JSON.stringify(activeViewBox)}
      data-projection-mode={baseProjection.mode}
      data-projection-affected={baseProjection.affectedEntities.join(',')}
      data-projection-routing-reused={baseProjection.reused.routing ? 'true' : 'false'}
      data-live-erc-mode={liveErcMode}
      data-component-count={draft.components.length}
      data-components={JSON.stringify(draft.components)}
      data-port-count={draft.ports.length}
      data-ports={JSON.stringify(draft.ports)}
      data-wire-count={document.wires.length}
      data-net-label-count={document.netLabels.length}
      data-live-erc-status={liveErcSummary.status}
      data-live-erc-error-count={liveErcSummary.errors}
      data-live-erc-warning-count={liveErcSummary.warnings}
      data-live-erc-rendered-count={renderedLiveDiagnostics.length}
      data-live-erc-scope={
        dragPreviewPositions && (dragRef.current?.mode ?? componentMoveMode) === 'stretch'
          ? 'connectivity-preserving-cache'
          : 'affected-document'
      }
      data-projection-scope={dragPreviewPositions ? 'affected-entities' : 'module'}
      data-interaction-state={interactionStateName}
      data-interaction-status={interactionStatusText}
      data-hierarchy-trace={hierarchyTrace?.netId || hierarchyTrace?.net || ''}
      data-locate-target={locateTarget?.id || ''}
      data-drag-preview={dragPreviewPositions ? 'true' : 'false'}
      data-component-positions={JSON.stringify(displayedComponentPositions)}
      data-port-positions={JSON.stringify(Object.fromEntries(document.portPositions))}
      data-component-rotations={JSON.stringify(Object.fromEntries(
        draft.components.map((component) => [component.id, normalizeRotation(component.rotation)]),
      ))}
      data-wire-points={JSON.stringify(document.wires.map((wire) => wire.points))}
      data-wires={JSON.stringify(document.wires.map((wire) => ({
        id: wire.id,
        net: wire.net,
        source: wire.source,
        from: wire.from,
        to: wire.to,
        points: wire.points,
      })))}
      data-schematic-source="document"
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onFocus={() => setEditorFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setEditorFocused(false);
      }}
      tabIndex={0}
    >
      <EditorCommandToolbar
        selectActive={tool === 'select'}
        wireActive={tool === 'wire'}
        cutActive={tool === 'cut'}
        moveMode={componentMoveMode}
        disabled={busy}
        canUndo={history.length > 0}
        canRedo={future.length > 0}
        hasSelection={Boolean(selection)}
        dirty={dirty}
        saveBlocked={Boolean(saveError)}
        buildBusy={buildBusy}
        status={interactionStateName === 'dialog'
          ? 'Configure custom block · Enter confirms · Esc cancels'
          : actionNotice
          ?? (saveError
            ? `Save failed: ${saveError}`
            : wireStart
            ? `Wire from ${wireStart.label}${hoverEndpoint ? ` to ${hoverEndpoint.label}` : ''}`
            : tool === 'cut'
              ? 'Cut: click one wire segment; Esc cancels'
            : tool === 'place'
              ? `Placing ${placeType}: click to place, R / right-click rotates, Esc to exit`
              : tool === 'place-block'
                ? 'Placing block: click to place, Esc to exit'
                : tool === 'place-module'
                  ? `Placing module ${pendingModule?.name || ''}: click to place, Esc to exit`
                : hoverEndpoint
                  ? `Snap ${hoverEndpoint.label}`
                  : dirty
                    ? 'Unsaved'
                    : liveErcSummary.status !== 'clean'
                      ? `Live ERC ${liveErcSummary.errors}/${liveErcSummary.warnings}`
                      : `Saved · conn ${orderedConnectivityFingerprint(draft)}`)}
        zoom={zoom}
        onSelect={() => {
          setTool('select');
          setPendingBlock(null);
          setPendingModule(null);
          setPlaceRotation(0);
          setWireStart(null);
          setHoverEndpoint(null);
          setHoverSelection(null);
        }}
        onWire={() => {
          setTool('wire');
          setPendingBlock(null);
          setPendingModule(null);
          setPlaceRotation(0);
          setWireStart(null);
          setHoverEndpoint(null);
          setHoverSelection(null);
        }}
        onCut={() => {
          cancelActiveDrag();
          setTool('cut');
          setPendingBlock(null);
          setPendingModule(null);
          setPlaceRotation(0);
          setWireStart(null);
          setHoverEndpoint(null);
          setHoverSelection(null);
          setActionNotice('Cut: click one wire segment; Esc cancels');
        }}
        onMoveMode={(mode) => {
          cancelActiveDrag();
          setTool('select');
          setComponentMoveMode(mode);
          setPendingBlock(null);
          setPendingModule(null);
          setPlaceRotation(0);
          setWireStart(null);
          setHoverEndpoint(null);
          setHoverSelection(null);
          setActionNotice(mode === 'free'
            ? 'Free Move: external wires will detach'
            : 'Stretch Move: connected wires remain attached');
        }}
        onUndo={undo}
        onRedo={redo}
        onDelete={() => deleteSelection()}
        onSave={() => void saveAndRebuild()}
        onFit={fitViewport}
        onBuild={onBuild}
      />

      {complexity.hierarchyRecommended ? (
        <div className="av-form-status" data-testid="schematic-hierarchy-recommendation">
          <strong>Large-sheet guidance:</strong> {complexity.reason}. Consider extracting functional
          blocks into child modules. Vibe Analog will not rewrite the hierarchy automatically.
        </div>
      ) : null}

      <div style={styles.content}>
        <div style={styles.stage}>
          <FloatingComponentPalette
            activeType={tool === 'place' ? placeType : null}
            blockActive={tool === 'place-block' || blockDialogOpen}
            pdkBrowserActive={pdkBrowserOpen}
            pdkBrowserAvailable={Boolean(
              (projectKind === 'analog_ic' || projectKind === 'mixed_signal_ic')
              && pdkDeviceCatalog?.devices.length,
            )}
            disabled={busy}
            onSelectType={(type) => {
              setTool('place');
              setPendingBlock(null);
              setPendingModule(null);
              setPendingPdkPlacement(null);
              setPlaceType(type);
              setPlaceRotation(0);
              setWireStart(null);
              setHoverEndpoint(null);
              setHoverSelection(null);
            }}
            onSelectBlock={openBlockDialog}
            onOpenPdkBrowser={() => {
              setPdkBrowserOpen((current) => !current);
              setTool('select');
              setPendingPdkPlacement(null);
              setActionNotice(null);
            }}
          />
          {pdkBrowserOpen && pdkDeviceCatalog ? (
            <PdkDeviceBrowser
              catalog={pdkDeviceCatalog}
              busy={busy}
              onClose={() => setPdkBrowserOpen(false)}
              onPlace={(device, parameters) => {
                const nextType = pdkDeviceToolType(device);
                if (!nextType) return;
                setPendingPdkPlacement({ device, parameters });
                setPlaceType(nextType);
                setPlaceRotation(0);
                setTool('place');
                setPdkBrowserOpen(false);
                setWireStart(null);
                setHoverEndpoint(null);
                setHoverSelection(null);
                setActionNotice(`Place ${device.device_id} from ${pdkDeviceCatalog.pdk_ref}`);
                editorShellRef.current?.focus();
              }}
            />
          ) : null}
          {projectModules.filter((item) => item.module_id !== draft.module_id).length > 0 ? (
            <div style={styles.moduleLibrary} data-testid="schematic-module-library">
              <div style={styles.moduleLibraryTitle}>Project modules</div>
              {projectModules
                .filter((item) => item.module_id !== draft.module_id)
                .map((item) => (
                  <button
                    key={item.module_id}
                    type="button"
                    style={{
                      ...styles.moduleLibraryButton,
                      ...(pendingModule?.module_id === item.module_id ? styles.moduleLibraryButtonActive : {}),
                    }}
                    disabled={busy}
                    onClick={() => {
                      setTool('place-module');
                      setPendingBlock(null);
                      setPendingModule(item);
                      setPlaceRotation(0);
                      setWireStart(null);
                      setHoverEndpoint(null);
                      setHoverSelection(null);
                    }}
                    data-testid={`schematic-place-module-${item.module_id}`}
                  >
                    {item.name}
                  </button>
                ))}
            </div>
          ) : null}
          <SchematicDocumentSvg
            document={document}
            selection={selection}
            hoverSelection={hoverSelection}
            wireStart={wireStart}
            wirePreview={wirePreview}
            hoverEndpoint={hoverEndpoint}
            marqueeBounds={marqueeBounds}
            showGrid
            cursor={editorCursor}
            viewBoxOverride={activeViewBox}
            rubberBandWireIds={rubberBandWireIds}
            detachedWireIds={detachedWireIds}
            diagnostics={renderedLiveDiagnostics}
            placeGhost={placeGhost}
            testId="schematic-editor-svg"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onPointerLeave={handlePointerLeave}
            onContextMenu={handleContextMenu}
            onDoubleClick={handleDoubleClick}
            svgRef={svgRef}
          />
        </div>
        <aside style={styles.panel} data-testid="schematic-editor-panel">
          <div
            style={{
              ...styles.liveErcSummary,
              ...(liveErcSummary.errors > 0
                ? styles.liveErcSummaryError
                : liveErcSummary.warnings > 0
                  ? styles.liveErcSummaryWarning
                  : styles.liveErcSummaryClean),
            }}
            data-testid="schematic-live-erc-summary"
            data-status={liveErcSummary.status}
          >
            <strong>Live ERC</strong>
            <span>{liveErcSummary.errors} errors · {liveErcSummary.warnings} warnings</span>
          </div>
          {liveDiagnostics.length > 0 ? (
            <div style={styles.liveErcList} data-testid="schematic-live-erc-list">
              {renderedLiveDiagnostics.map((diagnostic) => (
                <button
                  key={diagnostic.id}
                  type="button"
                  style={styles.liveErcItem}
                  onClick={() => focusLiveDiagnostic(diagnostic)}
                  data-testid="schematic-live-erc-item"
                  data-code={diagnostic.code}
                  data-severity={diagnostic.severity}
                  title={diagnostic.message}
                >
                  <span>{diagnostic.severity === 'error' ? '×' : '!'}</span>
                  <span>{diagnostic.message}</span>
                </button>
              ))}
              {renderedLiveDiagnostics.length < liveDiagnostics.length ? (
                <div style={styles.paramHint} data-testid="schematic-live-erc-truncated">
                  Showing {renderedLiveDiagnostics.length} of {liveDiagnostics.length} diagnostics.
                  Resolve or filter the first items to reveal more.
                </div>
              ) : null}
            </div>
          ) : null}
          <div style={styles.panelTitle}>Selection</div>
          {selectedComponent ? (
            <>
              <label style={styles.fieldLabel}>
                Name
                <input
                  style={styles.input}
                  value={selectedComponent.name}
                  onChange={(event) => updateSelectedComponent({ name: event.target.value })}
                  disabled={busy}
                  data-testid="schematic-editor-component-name"
                />
              </label>
              <div style={styles.typeBadge} data-testid="schematic-editor-component-type">
                {selectedComponent.type}
                <span style={styles.typeBadgeKind}>{projectKind}</span>
              </div>
              {selectedComponent.type === 'MODULE' || selectedComponent.type === 'GND' || (
                selectedComponent.type === 'BLOCK'
                && !(projectKind === 'pcb_schematic' && selectedComponent.eda?.symbol)
              ) ? (
                <label style={styles.fieldLabel}>
                  Value
                  <input
                    style={styles.input}
                    value={selectedComponent.value}
                    onChange={(event) => updateSelectedComponent({ value: event.target.value })}
                    disabled={busy}
                    data-testid="schematic-editor-component-value"
                  />
                </label>
              ) : null}
              {selectedComponent.type !== 'MODULE' && selectedComponent.type !== 'GND' && (
                selectedComponent.type !== 'BLOCK'
                || (projectKind === 'pcb_schematic' && selectedComponent.eda?.symbol)
              ) ? (
                <ComponentParamForm
                  projectKind={projectKind}
                  component={selectedComponent}
                  busy={busy}
                  pdkCatalog={pdkDeviceCatalog}
                  fieldLabelStyle={styles.fieldLabel ?? {}}
                  inputStyle={styles.input ?? {}}
                  hintStyle={styles.paramHint}
                  onPatch={updateSelectedComponent}
                  symbolDefinition={selectedSymbolDefinition}
                  packageOptions={selectedPackageOptions}
                  onUnitChange={changeSelectedSymbolUnit}
                  onPackageChange={changeSelectedPackage}
                />
              ) : null}
              <label style={styles.fieldLabel}>
                Rotation
                <select
                  style={styles.input}
                  value={String(selectedComponent.rotation ?? 0)}
                  onChange={(event) => updateSelectedComponent({ rotation: Number(event.target.value) })}
                  disabled={busy}
                  data-testid="schematic-editor-component-rotation"
                >
                  <option value="0">0</option>
                  <option value="90">90</option>
                  <option value="180">180</option>
                  <option value="270">270</option>
                </select>
              </label>
              {onProbe && selectedComponent.type !== 'BLOCK' && selectedComponent.type !== 'MODULE' && selectedComponent.type !== 'GND' ? (
                <div style={styles.probeActions}>
                  <button
                    type="button"
                    style={styles.smallButton}
                    onClick={() => onProbe({
                      kind: 'current',
                      label: `Current through ${selectedComponent.name}`,
                      candidates: componentCurrentCandidates(selectedComponent),
                      componentId: selectedComponent.id,
                      componentType: selectedComponent.type,
                    })}
                    disabled={busy || dirty}
                    title={dirty ? 'Apply schematic changes before probing' : `Plot current through ${selectedComponent.name}`}
                    data-testid="schematic-editor-probe-current"
                  >
                    Plot current
                  </button>
                  <button
                    type="button"
                    style={styles.smallButton}
                    onClick={() => onProbe({
                      kind: 'power',
                      label: `Power in ${selectedComponent.name}`,
                      candidates: componentPowerCandidates(selectedComponent),
                      componentId: selectedComponent.id,
                      componentType: selectedComponent.type,
                    })}
                    disabled={busy || dirty}
                    title={dirty ? 'Apply schematic changes before probing' : `Plot power in ${selectedComponent.name}`}
                    data-testid="schematic-editor-probe-power"
                  >
                    Plot power
                  </button>
                </div>
              ) : null}
              {selectedComponent.type === 'MODULE' ? (
                <>
                  <div
                    className={`av-form-status${selectedModuleInspection?.upToDate ? '' : ' av-form-status--error'}`}
                    data-testid="schematic-editor-module-ref"
                    data-module-ref-status={selectedModuleInspection?.upToDate ? 'current' : 'stale'}
                  >
                    Child module: {selectedComponent.module_ref?.module_id || selectedComponent.value}
                    {' · '}instance revision {selectedComponent.module_ref?.revision ?? 'unknown'}
                    {selectedChildModule ? ` · current ${selectedChildModule.revision}` : ''}
                  </div>
                  {selectedModuleInspection?.diagnostics.map((diagnostic) => (
                    <div
                      key={`${diagnostic.code}-${diagnostic.pin_id ?? ''}`}
                      style={styles.hierarchyDiagnostic}
                      data-testid="schematic-module-diagnostic"
                      data-code={diagnostic.code}
                    >
                      {diagnostic.message}
                    </div>
                  ))}
                  {selectedModuleInspection && selectedModuleInspection.portMap.length > 0 ? (
                    <div style={styles.hierarchyPortMap} data-testid="schematic-module-port-map">
                      {selectedModuleInspection.portMap.map((entry) => (
                        <div key={entry.pin_id} style={styles.hierarchyPortMapRow}>
                          <code>{entry.pin_name}</code>
                          <span>{entry.parent_net} → {entry.child_net}</span>
                          {onOpenChildModule && selectedChildModule ? (
                            <button
                              type="button"
                              style={styles.probeIconButton}
                              onClick={() => onOpenChildModule(
                                selectedChildModule.module_id,
                                selectedComponent.id,
                                entry.pin_id,
                              )}
                              disabled={busy}
                              title={`Trace ${entry.parent_net} into ${entry.child_net}`}
                              data-testid={`schematic-module-trace-${entry.pin_id}`}
                            >
                              Trace
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <label style={styles.fieldLabel}>
                    Instance parameters (key=value per line)
                    <textarea
                      style={{ ...styles.input, minHeight: 72 }}
                      value={Object.entries(selectedComponent.parameters || {})
                        .map(([key, value]) => `${key}=${value}`)
                        .join('\n')}
                      onChange={(event) => {
                        const parameters: Record<string, string> = {};
                        for (const line of event.target.value.split(/\r?\n/)) {
                          const trimmed = line.trim();
                          if (!trimmed || !trimmed.includes('=')) continue;
                          const [rawKey, ...rest] = trimmed.split('=');
                          const key = rawKey?.trim();
                          if (!key) continue;
                          parameters[key] = rest.join('=').trim();
                        }
                        updateSelectedComponent({ parameters });
                      }}
                      disabled={busy}
                      data-testid="schematic-editor-module-parameters"
                    />
                  </label>
                  {onOpenChildModule && selectedComponent.module_ref?.module_id ? (
                    <div style={styles.moduleInstanceActions}>
                      <button
                        type="button"
                        style={styles.smallButton}
                        onClick={() => onOpenChildModule(
                          selectedComponent.module_ref!.module_id,
                          selectedComponent.id,
                        )}
                        disabled={busy}
                        data-testid="schematic-editor-open-child-module"
                      >
                        Open child module
                      </button>
                      {!selectedModuleInspection?.upToDate && selectedChildModule ? (
                        <button
                          type="button"
                          style={styles.smallButton}
                          onClick={refreshSelectedModuleInstance}
                          disabled={busy}
                          data-testid="schematic-editor-update-module-instance"
                        >
                          Update instance
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : null}
              {selectedComponent.type === 'BLOCK' && !(projectKind === 'pcb_schematic' && selectedComponent.eda?.symbol) ? (
                <>
                  <div style={styles.fieldGrid}>
                    <label style={styles.fieldLabel}>
                      Width
                      <input
                        type="number"
                        min="120"
                        max="480"
                        step="20"
                        style={styles.input}
                        value={selectedComponent.block?.width ?? 180}
                        onChange={(event) => updateSelectedComponent({
                          block: { ...selectedComponent.block, width: Number(event.target.value) },
                        })}
                        disabled={busy}
                        data-testid="schematic-editor-block-width"
                      />
                    </label>
                    <label style={styles.fieldLabel}>
                      Height
                      <input
                        type="number"
                        min="84"
                        max="480"
                        step="20"
                        style={styles.input}
                        value={selectedComponent.block?.height ?? 120}
                        onChange={(event) => updateSelectedComponent({
                          block: { ...selectedComponent.block, height: Number(event.target.value) },
                        })}
                        disabled={busy}
                        data-testid="schematic-editor-block-height"
                      />
                    </label>
                  </div>
                  <div style={styles.pinEditorHeader}>
                    <span>Pins ({selectedComponent.pins.length})</span>
                    <button
                      type="button"
                      style={styles.smallButton}
                      onClick={addSelectedBlockPin}
                      disabled={busy || selectedComponent.pins.length >= MAX_BLOCK_PINS}
                      data-testid="schematic-editor-block-add-pin"
                    >
                      Add pin
                    </button>
                  </div>
                  <div style={styles.blockPinList} data-testid="schematic-editor-block-pins">
                    {selectedComponent.pins.map((pin) => (
                      <div key={pin.id} style={styles.blockPinRow} data-testid={`schematic-editor-block-pin-${pin.id}`}>
                        <code style={styles.pinId}>{pin.id}</code>
                        <input
                          style={styles.compactInput}
                          value={pin.name}
                          onChange={(event) => updateSelectedBlockPin(pin.id, { name: event.target.value })}
                          aria-label={`Pin ${pin.id} label`}
                          data-testid={`schematic-editor-block-pin-label-${pin.id}`}
                        />
                        <input
                          style={styles.compactInput}
                          value={pin.net}
                          onChange={(event) => updateSelectedBlockPin(pin.id, { net: event.target.value })}
                          aria-label={`Pin ${pin.id} net`}
                          data-testid={`schematic-editor-block-pin-net-${pin.id}`}
                        />
                        <select
                          style={styles.compactInput}
                          value={pin.side ?? 'left'}
                          onChange={(event) => updateSelectedBlockPin(pin.id, { side: event.target.value as BlockPinSide })}
                          aria-label={`Pin ${pin.id} side`}
                          data-testid={`schematic-editor-block-pin-side-${pin.id}`}
                        >
                          <option value="left">Left</option>
                          <option value="right">Right</option>
                          <option value="top">Top</option>
                          <option value="bottom">Bottom</option>
                        </select>
                        <button
                          type="button"
                          style={styles.removePinButton}
                          onClick={() => removeSelectedBlockPin(pin.id)}
                          disabled={busy || selectedComponent.pins.length <= 1}
                          aria-label={`Remove pin ${pin.id}`}
                          title={`Remove pin ${pin.id}`}
                          data-testid={`schematic-editor-block-pin-remove-${pin.id}`}
                        >
                          X
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div style={styles.pinList}>
                  {selectedComponent.pins.map((pin) => (
                    <div key={pin.id} style={styles.pinRow}>
                      <span>{pin.name}</span>
                      <span style={styles.pinProbeGroup}>
                        <code>{pin.net}</code>
                        {onProbe ? (
                          <button
                            type="button"
                            style={styles.probeIconButton}
                            onClick={() => onProbe({
                              kind: 'voltage',
                              label: `Voltage at ${pin.net}`,
                              candidates: [`v(${pin.net})`],
                              net: pin.net,
                              netId: pin.net_id,
                              componentId: selectedComponent.id,
                              pinId: pin.id,
                              componentType: selectedComponent.type,
                            })}
                            disabled={busy || dirty}
                            aria-label={`Plot voltage at ${pin.net}`}
                            title={dirty ? 'Apply schematic changes before probing' : `Plot voltage at ${pin.net}`}
                            data-testid={`schematic-editor-probe-pin-${pin.id}`}
                          >
                            V
                          </button>
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : selection?.kind === 'components' ? (
            <div style={styles.emptyText}>{selection.ids.length} components selected</div>
          ) : selection?.kind === 'wires' ? (
            <div style={styles.emptyText} data-testid="schematic-editor-wires-panel">
              {selection.ids.length} wires selected · {selectedWireScope}
            </div>
          ) : selectedNetLabel ? (
            <div style={styles.pinList} data-testid="schematic-editor-netlabel-panel">
              <div style={styles.pinRow}>
                <span>Rail label</span>
                <code data-testid="schematic-editor-netlabel-name">{selectedNetLabel.name}</code>
              </div>
              <div style={styles.pinRow}>
                <span>Net</span>
                <code data-testid="schematic-editor-netlabel-net">{selectedNetLabel.net}</code>
              </div>
              <div style={styles.pinRow}>
                <span>Attached</span>
                <code data-testid="schematic-editor-netlabel-pin">
                  {selectedNetLabel.endpoint.component_id}.{selectedNetLabel.endpoint.pin_id}
                </code>
              </div>
              <div style={styles.emptyText}>Delete converts this pin to a wired connection.</div>
            </div>
          ) : selectedPort ? (
            <div style={styles.pinList} data-testid="schematic-editor-port-panel">
              <div style={styles.pinRow}>
                <span>Port</span>
                <code>{selectedPort.name}</code>
              </div>
              <div style={styles.pinRow}>
                <span>Net</span>
                <code data-testid="schematic-editor-port-net">{selectedPort.net}</code>
              </div>
              <div style={styles.pinRow}>
                <span>Position</span>
                <code data-testid="schematic-editor-port-position">
                  {document.portPositions.get(selectedPort.id)
                    ? `${document.portPositions.get(selectedPort.id)?.x}, ${document.portPositions.get(selectedPort.id)?.y}`
                    : '-'}
                </code>
              </div>
            </div>
          ) : selectedWire ? (
            <div style={styles.pinList} data-testid="schematic-editor-wire-panel">
              <div style={styles.pinRow}>
                <span>Wire</span>
                <code>{selectedWire.id}</code>
              </div>
              <div style={styles.pinRow}>
                <span>Net</span>
                <code data-testid="schematic-editor-wire-net">{selectedWire.net ?? '-'}</code>
              </div>
              <div style={styles.pinRow}>
                <span>Source</span>
                <code data-testid="schematic-editor-wire-source">{selectedWire.source ?? 'net'}</code>
              </div>
              <div style={styles.pinRow}>
                <span>Points</span>
                <code data-testid="schematic-editor-wire-point-count">{selectedWire.points.length}</code>
              </div>
              {onProbe && selectedWire.net ? (
                <button
                  type="button"
                  style={styles.smallButton}
                  onClick={() => onProbe({
                    kind: 'voltage',
                    label: `Voltage at ${selectedWire.net}`,
                    candidates: [`v(${selectedWire.net})`],
                    net: selectedWire.net,
                    netId: selectedWire.net_id,
                    wireId: selectedWire.id,
                  })}
                  disabled={busy || dirty}
                  title={dirty ? 'Apply schematic changes before probing' : `Plot voltage at ${selectedWire.net}`}
                  data-testid="schematic-editor-probe-wire"
                >
                  Plot voltage
                </button>
              ) : null}
            </div>
          ) : (
            <div style={styles.emptyText}>No item selected</div>
          )}
        </aside>
      </div>
      {contextMenu ? (
        <div
          style={{ ...styles.contextMenu, left: contextMenu.x, top: contextMenu.y }}
          data-testid="schematic-context-menu"
          data-menu-target={selectionAttribute(contextMenu.selection)}
          data-menu-kind={
            contextMenu.selection.kind === 'wire' || contextMenu.selection.kind === 'wires'
              ? 'wire'
              : contextMenu.selection.kind === 'netlabel'
                ? 'netlabel'
                : 'component'
          }
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          {contextMenu.selection.kind === 'component' || contextMenu.selection.kind === 'components' ? (
            <>
              <button
                type="button"
                style={styles.contextMenuItem}
                onClick={() => rotateSelectedComponents(contextMenu.selection)}
                data-testid="schematic-context-menu-rotate"
              >
                Rotate
              </button>
              <button
                type="button"
                style={styles.contextMenuItem}
                onClick={() => duplicateSelectedComponents(contextMenu.selection)}
                data-testid="schematic-context-menu-duplicate"
              >
                Duplicate
              </button>
            </>
          ) : null}
          {contextMenu.selection.kind === 'wire' ? (
            <>
              <button
                type="button"
                style={styles.contextMenuItem}
                onClick={() => selectWireBranch(wireIdsForSelection(contextMenu.selection)[0]!)}
                data-testid="schematic-context-menu-select-branch"
              >
                Select branch
              </button>
              <button
                type="button"
                style={styles.contextMenuItem}
                onClick={() => selectWireNet(wireIdsForSelection(contextMenu.selection)[0]!)}
                data-testid="schematic-context-menu-select-net"
              >
                Select whole net
              </button>
              <button
                type="button"
                style={styles.contextMenuItem}
                onClick={() => applyWireSplit(wireIdsForSelection(contextMenu.selection)[0]!, contextMenu.world)}
                data-testid="schematic-context-menu-split"
              >
                Split + junction
              </button>
              <button
                type="button"
                style={styles.contextMenuItem}
                onClick={() => applyWireCut(wireIdsForSelection(contextMenu.selection)[0]!, contextMenu.world)}
                data-testid="schematic-context-menu-cut"
              >
                Cut net
              </button>
              <button
                type="button"
                style={styles.contextMenuItem}
                onClick={() => applyWireTrim(wireIdsForSelection(contextMenu.selection)[0]!, contextMenu.world)}
                data-testid="schematic-context-menu-trim"
              >
                Trim dangling end
              </button>
              <button
                type="button"
                style={styles.contextMenuItem}
                onClick={() => applyWireCollapse(wireIdsForSelection(contextMenu.selection)[0]!)}
                data-testid="schematic-context-menu-collapse"
              >
                Collapse path
              </button>
            </>
          ) : null}
          {contextMenu.pin ? (
            <button
              type="button"
              style={styles.contextMenuItem}
              onClick={() => togglePinNoConnect(contextMenu.pin!.componentId, contextMenu.pin!.pinId)}
              data-testid="schematic-context-menu-no-connect"
            >
              {draft.components
                .find((component) => component.id === contextMenu.pin?.componentId)
                ?.pins.find((pin) => pin.id === contextMenu.pin?.pinId)
                ?.no_connect
                ? 'Clear no-connect'
                : 'Mark no-connect'}
            </button>
          ) : null}
          {contextMenu.selection.kind === 'wires' ? (
            <button
              type="button"
              style={styles.contextMenuItem}
              onClick={() => applyWireJoin(wireIdsForSelection(contextMenu.selection))}
              data-testid="schematic-context-menu-join"
            >
              Join wire chain
            </button>
          ) : null}
          <button
            type="button"
            style={styles.contextMenuItemDanger}
            onClick={() => deleteSelection(contextMenu.selection)}
            data-testid="schematic-context-menu-delete"
          >
            Delete
          </button>
        </div>
      ) : null}
      {blockDialogOpen ? (
        <div
          style={styles.modalBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label="Configure custom block"
          data-testid="schematic-block-dialog"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
              event.preventDefault();
              setBlockDialogOpen(false);
              return;
            }
            if (
              event.key === 'Enter'
              && !(event.target instanceof HTMLButtonElement)
              && blockDraft.value.trim()
              && blockDraft.pins.length > 0
            ) {
              event.preventDefault();
              beginBlockPlacement();
            }
          }}
        >
          <div style={styles.blockModal}>
            <div style={styles.modalHeader}>
              <div>
                <div style={styles.panelTitle}>Custom symbol</div>
                <div style={styles.modalTitle}>Place block</div>
              </div>
              <button
                type="button"
                style={styles.modalCloseButton}
                onClick={() => setBlockDialogOpen(false)}
                aria-label="Close block dialog"
                title="Close"
                data-testid="schematic-block-cancel-x"
              >
                X
              </button>
            </div>
            <div style={styles.fieldGrid}>
              <label style={styles.fieldLabel}>
                Reference
                <input
                  style={styles.input}
                  value={blockDraft.name}
                  onChange={(event) => setBlockDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder="U1"
                  data-testid="schematic-block-name"
                />
              </label>
              <label style={styles.fieldLabel}>
                Block label
                <input
                  style={styles.input}
                  value={blockDraft.value}
                  onChange={(event) => setBlockDraft((current) => ({ ...current, value: event.target.value }))}
                  data-testid="schematic-block-value"
                />
              </label>
              <label style={styles.fieldLabel}>
                Width
                <input
                  type="number"
                  min="120"
                  max="480"
                  step="20"
                  style={styles.input}
                  value={blockDraft.width}
                  onChange={(event) => setBlockDraft((current) => ({ ...current, width: clamp(Number(event.target.value), 120, 480) }))}
                  data-testid="schematic-block-width"
                />
              </label>
              <label style={styles.fieldLabel}>
                Height
                <input
                  type="number"
                  min="84"
                  max="480"
                  step="20"
                  style={styles.input}
                  value={blockDraft.height}
                  onChange={(event) => setBlockDraft((current) => ({ ...current, height: clamp(Number(event.target.value), 84, 480) }))}
                  data-testid="schematic-block-height"
                />
              </label>
            </div>
            <label style={styles.fieldLabel}>
              Pin count
              <input
                type="number"
                min="1"
                max={MAX_BLOCK_PINS}
                style={styles.input}
                value={blockDraft.pins.length}
                onChange={(event) => setBlockPinCount(Number(event.target.value))}
                data-testid="schematic-block-pin-count"
              />
            </label>
            <div style={styles.blockDraftHeader} aria-hidden="true">
              <span>ID</span><span>Label</span><span>Net</span><span>Side</span>
            </div>
            <div style={styles.blockDraftPins} data-testid="schematic-block-pin-config">
              {blockDraft.pins.map((pin, index) => (
                <div key={pin.id} style={styles.blockDraftPinRow} data-testid={`schematic-block-draft-pin-${index + 1}`}>
                  <code style={styles.pinId}>{pin.id}</code>
                  <input
                    style={styles.compactInput}
                    value={pin.name}
                    onChange={(event) => updateBlockDraftPin(index, { name: event.target.value })}
                    aria-label={`Block pin ${index + 1} label`}
                    data-testid={`schematic-block-draft-pin-label-${index + 1}`}
                  />
                  <input
                    style={styles.compactInput}
                    value={pin.net}
                    onChange={(event) => updateBlockDraftPin(index, { net: event.target.value })}
                    aria-label={`Block pin ${index + 1} net`}
                    data-testid={`schematic-block-draft-pin-net-${index + 1}`}
                  />
                  <select
                    style={styles.compactInput}
                    value={pin.side}
                    onChange={(event) => updateBlockDraftPin(index, { side: event.target.value as BlockPinSide })}
                    aria-label={`Block pin ${index + 1} side`}
                    data-testid={`schematic-block-draft-pin-side-${index + 1}`}
                  >
                    <option value="left">Left</option>
                    <option value="right">Right</option>
                    <option value="top">Top</option>
                    <option value="bottom">Bottom</option>
                  </select>
                </div>
              ))}
            </div>
            <div style={styles.modalActions}>
              <button
                type="button"
                style={styles.toolButton}
                onClick={() => setBlockDialogOpen(false)}
                data-testid="schematic-block-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                style={styles.primaryButton}
                onClick={beginBlockPlacement}
                disabled={!blockDraft.value.trim() || blockDraft.pins.length === 0}
                data-testid="schematic-block-place"
              >
                Place on canvas
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function endpointIdentity(endpoint: EndpointHit | null): string {
  if (!endpoint) return '';
  if (endpoint.component_id && endpoint.pin_id) return `pin:${endpoint.component_id}:${endpoint.pin_id}`;
  if (endpoint.port_id) return `port:${endpoint.port_id}`;
  return `point:${endpoint.x},${endpoint.y}`;
}

function nearestPointOnWire(
  wire: CircuitWire,
  point: CircuitPosition,
): CircuitPosition {
  let best = wire.points[0] ? { ...wire.points[0] } : snapPoint(point);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < wire.points.length; index += 1) {
    const left = wire.points[index - 1]!;
    const right = wire.points[index]!;
    const dx = right.x - left.x;
    const dy = right.y - left.y;
    const lengthSquared = dx * dx + dy * dy;
    const ratio = lengthSquared <= 0
      ? 0
      : Math.max(0, Math.min(1, (
          (point.x - left.x) * dx + (point.y - left.y) * dy
        ) / lengthSquared));
    const candidate = {
      x: left.x + ratio * dx,
      y: left.y + ratio * dy,
    };
    const candidateDistance = distance(candidate, point);
    if (candidateDistance < bestDistance) {
      best = candidate;
      bestDistance = candidateDistance;
    }
  }
  return best;
}

function endpointIsConnected(
  document: SchematicDocument,
  endpoint: EndpointHit,
): boolean {
  if (endpoint.kind !== 'pin' || !endpoint.component_id || !endpoint.pin_id) {
    return false;
  }
  return document.wires.some((wire) => (
    (
      wire.from?.component_id === endpoint.component_id
      && wire.from?.pin_id === endpoint.pin_id
    )
    || (
      wire.to?.component_id === endpoint.component_id
      && wire.to?.pin_id === endpoint.pin_id
    )
  ));
}

function cloneComponent(component: CircuitComponent): CircuitComponent {
  return {
    ...component,
    position: { ...component.position },
    pins: component.pins.map((pin) => ({ ...pin })),
    block: component.block ? { ...component.block } : undefined,
  };
}

function appendCopiedComponents(
  module: CircuitModule,
  sourceComponents: CircuitComponent[],
  offset: number,
): string[] {
  const existingIds = new Set(module.components.map((component) => component.id));
  const sourceIds = new Set(sourceComponents.map((component) => component.id));
  const netTable = new Map((module.nets ?? []).map((net) => [net.name, net]));
  const railPortNets = new Set(
    module.ports
      .filter((port) => port.signal_type === 'ground' || port.signal_type === 'power')
      .map((port) => port.net),
  );
  // Nets used by components outside the copied set must not be joined by the
  // paste (that would short the copy into the original circuit). Ports and
  // junction wires do not prove externality on their own: a net shared inside
  // the copied set keeps its internal wiring (fresh shared net) even when a
  // module port carries the same name or a wire bound the net to a port —
  // rails are still kept by isRailNet, and wires bound to a port are never
  // copied, so the paste stays isolated from the port itself.
  const externalNets = new Set<string>([
    ...module.components
      .filter((component) => !sourceIds.has(component.id))
      .flatMap((component) => component.pins.map((pin) => pin.net)),
    ...(module.wires ?? [])
      .filter((wire) => [wire.from, wire.to].some((endpoint) => (
        endpoint?.component_id ? !sourceIds.has(endpoint.component_id) : false
      )))
      .map((wire) => wire.net ?? ''),
  ].filter(Boolean));
  const usedNetNames = new Set<string>([
    ...externalNets,
    ...sourceComponents.flatMap((component) => component.pins.map((pin) => pin.net)),
    ...(module.nets ?? []).flatMap((net) => [net.name, ...(net.aliases ?? [])]),
  ].filter(Boolean));
  const isRailNet = (netName: string) => {
    if (netName === '0') return true;
    const entry = netTable.get(netName);
    if (entry && (entry.kind === 'ground' || entry.kind === 'power')) return true;
    return railPortNets.has(netName);
  };
  const sourceNetUse = new Map<string, number>();
  for (const component of sourceComponents) {
    for (const pin of component.pins) {
      sourceNetUse.set(pin.net, (sourceNetUse.get(pin.net) ?? 0) + 1);
    }
  }
  const makeFreshNetName = () => {
    let index = 1;
    while (usedNetNames.has(`n_paste_${index}`)) index += 1;
    const name = `n_paste_${index}`;
    usedNetNames.add(name);
    return name;
  };
  const sharedFreshNets = new Map<string, string>();
  const pinNetFor = (pin: CircuitPin, newComponentId: string, pinIndex: number): string => {
    const sourceNet = pin.net;
    // Ground / power rails stay shared so the pasted copy keeps its supplies
    // connected (qucs pastes power symbols as-is).
    if (isRailNet(sourceNet)) return sourceNet;
    // A net used only inside the copied set keeps its connectivity through one
    // fresh shared net; everything else dangles with a per-pin net (previous
    // behavior for all pins).
    if ((sourceNetUse.get(sourceNet) ?? 0) >= 2 && !externalNets.has(sourceNet)) {
      let fresh = sharedFreshNets.get(sourceNet);
      if (!fresh) {
        fresh = makeFreshNetName();
        sharedFreshNets.set(sourceNet, fresh);
      }
      return fresh;
    }
    return `n_${newComponentId}_${pinIndex + 1}`;
  };
  const componentIds: string[] = [];
  const componentIdMap = new Map<string, string>();
  const pinNetAssignments = new Map<string, string>();
  for (const source of sourceComponents) {
    const id = makeId(source.type.toLowerCase(), existingIds);
    existingIds.add(id);
    componentIdMap.set(source.id, id);
    const component: CircuitComponent = {
      ...cloneComponent(source),
      id,
      name: `${source.type}${id.replace(/^[a-z]+/i, '')}`,
      position: snapPoint({
        x: source.position.x + offset,
        y: source.position.y + offset,
      }),
      pins: source.pins.map((pin, index) => {
        const net = pinNetFor(pin, id, index);
        pinNetAssignments.set(`${source.id}:${pin.id}`, net);
        return { ...pin, net };
      }),
    };
    module.components.push(component);
    componentIds.push(id);
  }
  // Re-create stored wires that connected two copied components, keeping their
  // routed geometry. A stored wire merges its endpoint nets, so it is only
  // copied when both pins received the same paste net; junction-mediated chains
  // are preserved implicitly through the shared net (auto-routed).
  const storedWiresToCopy = (module.wires ?? []).filter((wire) => {
    const fromComponentId = wire.from?.component_id;
    const toComponentId = wire.to?.component_id;
    if (!fromComponentId || !toComponentId || fromComponentId === toComponentId) return false;
    if (!componentIdMap.has(fromComponentId) || !componentIdMap.has(toComponentId)) return false;
    const fromNet = pinNetAssignments.get(`${fromComponentId}:${wire.from?.pin_id}`);
    const toNet = pinNetAssignments.get(`${toComponentId}:${wire.to?.pin_id}`);
    return Boolean(fromNet) && fromNet === toNet;
  });
  if (storedWiresToCopy.length > 0) {
    const existingWireIds = new Set((module.wires ?? []).map((wire) => wire.id));
    const translate = (point: CircuitPosition) => snapPoint({ x: point.x + offset, y: point.y + offset });
    const pinPointFor = (componentId: string | undefined, pinId: string | undefined): CircuitPosition | null => {
      if (!componentId || !pinId) return null;
      const component = module.components.find((entry) => entry.id === componentId);
      if (!component) return null;
      const pinIndex = component.pins.findIndex((pin) => pin.id === pinId);
      const pin = pinIndex >= 0 ? component.pins[pinIndex] : undefined;
      if (!pin) return null;
      return pinWorld(component, pin, pinIndex);
    };
    const nextWires = [...(module.wires ?? [])];
    for (const wire of storedWiresToCopy) {
      const id = makeId('w', existingWireIds);
      existingWireIds.add(id);
      const net = pinNetAssignments.get(`${wire.from?.component_id}:${wire.from?.pin_id}`) ?? wire.net;
      const newFromComponentId = componentIdMap.get(wire.from?.component_id ?? '');
      const newToComponentId = componentIdMap.get(wire.to?.component_id ?? '');
      const translatedPoints = (wire.points ?? []).map(translate);
      // Anchor the translated route to the copied pin worlds so projection sync
      // does not treat sub-pixel drift as a move and rebuild a different Manhattan path.
      const fromPin = pinPointFor(newFromComponentId, wire.from?.pin_id);
      const toPin = pinPointFor(newToComponentId, wire.to?.pin_id);
      if (fromPin && translatedPoints.length > 0) translatedPoints[0] = { ...fromPin };
      if (toPin && translatedPoints.length > 1) {
        translatedPoints[translatedPoints.length - 1] = { ...toPin };
      }
      nextWires.push({
        ...cloneWire(wire),
        id,
        points: translatedPoints,
        from: wire.from ? {
          ...wire.from,
          ...(fromPin ?? translate(wire.from)),
          component_id: newFromComponentId,
          junction_id: undefined,
        } : undefined,
        to: wire.to ? {
          ...wire.to,
          ...(toPin ?? translate(wire.to)),
          component_id: newToComponentId,
          junction_id: undefined,
        } : undefined,
        net,
        net_id: undefined,
        source: 'stored',
      });
    }
    module.wires = nextWires;
  }
  return componentIds;
}

function cloneWire(wire: CircuitWire): CircuitWire {
  return {
    ...wire,
    points: clonePoints(wire.points),
    from: wire.from ? { ...wire.from } : undefined,
    to: wire.to ? { ...wire.to } : undefined,
  };
}

function isStoredWire(wire: CircuitWire, module: CircuitModule): boolean {
  return wire.source === 'stored' || Boolean((module.wires ?? []).some((entry) => entry.id === wire.id));
}

function materializeEditableWire(wire: CircuitWire, module?: CircuitModule): CircuitWire {
  const netId = wire.net_id ?? (
    wire.net
      ? module?.nets?.find((net) => net.name === wire.net)?.id
      : undefined
  );
  return {
    ...cloneWire(wire),
    ...(netId ? { net_id: netId } : {}),
    source: 'stored',
  };
}

function createDragPreviewDocument(
  baseDocument: SchematicDocument,
  previewModule: CircuitModule,
  draggedComponentIds: string[],
  mode: ComponentMoveMode,
): SchematicDocument {
  const draggedIds = new Set(draggedComponentIds);
  const sampleId = draggedComponentIds[0];
  const baseComponent = sampleId
    ? baseDocument.module.components.find((component) => component.id === sampleId)
    : undefined;
  const previewComponent = sampleId
    ? previewModule.components.find((component) => component.id === sampleId)
    : undefined;
  const dx = baseComponent && previewComponent
    ? previewComponent.position.x - baseComponent.position.x
    : 0;
  const dy = baseComponent && previewComponent
    ? previewComponent.position.y - baseComponent.position.y
    : 0;
  // Qucs-style drag preview: mutate only the selected components and the wires
  // attached to them. Unrelated wire objects remain identical and there is no
  // obstacle search, port recomputation, or document-wide bounds pass per frame.
  const wires = baseDocument.wires.map((wire) => (
    wireTouchesPreviewComponent(wire, draggedIds)
      ? (
          mode === 'free' && !wireOnlyTouchesDraggedComponents(wire, draggedIds)
            ? wire
            : moveWireWithComponentSelection(wire, draggedIds, dx, dy)
        )
      : wire
  ));
  const netLabels = baseDocument.netLabels.map((label) => {
    const componentId = label.endpoint.component_id;
    if (!componentId || !draggedIds.has(componentId) || (dx === 0 && dy === 0)) return label;
    return {
      ...label,
      position: { x: label.position.x + dx, y: label.position.y + dy },
      endpoint: {
        ...label.endpoint,
        x: label.endpoint.x + dx,
        y: label.endpoint.y + dy,
      },
    };
  });
  return {
    ...baseDocument,
    module: previewModule,
    wires,
    netLabels,
  };
}

/** Rigid-move only when both endpoints are components in the drag set (no free/junction/port ends). */
function wireOnlyTouchesDraggedComponents(wire: CircuitWire, componentIds: Set<string>): boolean {
  const fromId = wire.from?.component_id;
  const toId = wire.to?.component_id;
  if (!fromId || !toId) return false;
  // Port / free / junction ends stay anchored; the commit path reroutes those wires.
  if (wire.from?.port_id || wire.to?.port_id) return false;
  if (wire.from?.junction_id || wire.to?.junction_id) return false;
  return componentIds.has(fromId) && componentIds.has(toId);
}

function translateWireGeometry(wire: CircuitWire, dx: number, dy: number): CircuitWire {
  const shift = (point: CircuitPosition): CircuitPosition => ({ x: point.x + dx, y: point.y + dy });
  return {
    ...cloneWire(wire),
    points: (wire.points ?? []).map(shift),
    from: wire.from ? { ...wire.from, ...shift(wire.from) } : wire.from,
    to: wire.to ? { ...wire.to, ...shift(wire.to) } : wire.to,
  };
}

function moveWireWithComponentSelection(
  wire: CircuitWire,
  componentIds: Set<string>,
  dx: number,
  dy: number,
): CircuitWire {
  if (wireOnlyTouchesDraggedComponents(wire, componentIds)) {
    return translateWireGeometry(wire, dx, dy);
  }
  const next = cloneWire(wire);
  if (wire.from?.component_id && componentIds.has(wire.from.component_id)) {
    moveWireEndpoint(next, 'from', dx, dy);
  }
  if (wire.to?.component_id && componentIds.has(wire.to.component_id)) {
    moveWireEndpoint(next, 'to', dx, dy);
  }
  return next;
}

function moveWireEndpoint(
  wire: CircuitWire,
  side: 'from' | 'to',
  dx: number,
  dy: number,
) {
  const points = wire.points ?? [];
  if (points.length < 2) return;
  const movingIndex = side === 'from' ? 0 : points.length - 1;
  const neighborIndex = side === 'from' ? 1 : points.length - 2;
  const fixedIndex = side === 'from' ? points.length - 1 : 0;
  const moving = points[movingIndex];
  const neighbor = points[neighborIndex];
  const fixed = points[fixedIndex];
  if (!moving || !neighbor || !fixed) return;

  const moved = { x: moving.x + dx, y: moving.y + dy };
  const firstSegmentHorizontal = Math.abs(moving.y - neighbor.y) <= Math.abs(moving.x - neighbor.x);
  if (points.length === 2) {
    const dogleg = firstSegmentHorizontal
      ? (() => {
          const middleX = snapPoint({ x: (moved.x + fixed.x) / 2, y: 0 }).x;
          return [moved, { x: middleX, y: moved.y }, { x: middleX, y: fixed.y }, fixed];
        })()
      : (() => {
          const middleY = snapPoint({ x: 0, y: (moved.y + fixed.y) / 2 }).y;
          return [moved, { x: moved.x, y: middleY }, { x: fixed.x, y: middleY }, fixed];
        })();
    wire.points = side === 'from'
      ? compactOrthogonalPoints(dogleg)
      : compactOrthogonalPoints([...dogleg].reverse());
  } else {
    points[movingIndex] = moved;
    points[neighborIndex] = firstSegmentHorizontal
      ? { x: neighbor.x, y: moved.y }
      : { x: moved.x, y: neighbor.y };
    wire.points = compactOrthogonalPoints(points);
  }
  const endpoint = wire[side];
  if (endpoint) wire[side] = { ...endpoint, x: moved.x, y: moved.y };
}

function compactOrthogonalPoints(points: CircuitPosition[]): CircuitPosition[] {
  const compact: CircuitPosition[] = [];
  for (const point of points) {
    const previous = compact.at(-1);
    if (previous && samePosition(previous, point)) continue;
    const beforePrevious = compact.at(-2);
    if (
      beforePrevious &&
      previous &&
      (
        beforePrevious.x === previous.x && previous.x === point.x ||
        beforePrevious.y === previous.y && previous.y === point.y
      )
    ) {
      compact[compact.length - 1] = { ...point };
      continue;
    }
    compact.push({ ...point });
  }
  return compact;
}

function commitWiresAfterComponentGroupMove(
  module: CircuitModule,
  componentIds: string[],
  originalWires: CircuitWire[],
  dx: number,
  dy: number,
  mode: ComponentMoveMode,
): CircuitWire[] {
  const ids = new Set(componentIds);
  const originalById = new Map(originalWires.map((wire) => [wire.id, wire]));
  // Prefer the live module wire list, but take pre-drag geometry from originalWires so
  // rigid translates and partial reroutes start from the gesture's baseline paths.
  const sourceWires: CircuitWire[] = [];
  const seen = new Set<string>();
  for (const wire of module.wires ?? []) {
    sourceWires.push(originalById.get(wire.id) ?? wire);
    seen.add(wire.id);
  }
  for (const wire of originalWires) {
    if (seen.has(wire.id)) continue;
    sourceWires.push(wire);
  }
  const nextWires = sourceWires.map((wire) => {
    if (wireOnlyTouchesDraggedComponents(wire, ids)) {
      return translateWireGeometry(wire, dx, dy);
    }
    const next = cloneWire(wire);
    if (mode === 'free' && wireTouchesPreviewComponent(wire, ids)) {
      if (wire.from?.component_id && ids.has(wire.from.component_id)) {
        next.from = {
          x: wire.from.x,
          y: wire.from.y,
          junction_id: `j_detached_${wire.id}_from`,
        };
      }
      if (wire.to?.component_id && ids.has(wire.to.component_id)) {
        next.to = {
          x: wire.to.x,
          y: wire.to.y,
          junction_id: `j_detached_${wire.id}_to`,
        };
      }
      return materializeEditableWire(next);
    }
    return next;
  });
  if (mode === 'free') return nextWires;
  const working = { ...module, wires: nextWires };
  const needsReroute = nextWires.some(
    (wire) => wireTouchesPreviewComponent(wire, ids) && !wireOnlyTouchesDraggedComponents(wire, ids),
  );
  if (!needsReroute) {
    return nextWires.map((wire) => (
      wireTouchesPreviewComponent(wire, ids) ? materializeEditableWire(wire) : wire
    ));
  }
  const rerouted = rerouteStoredWires(working, { componentIds });
  return rerouted.map((wire) => {
    if (wireOnlyTouchesDraggedComponents(wire, ids)) {
      return materializeEditableWire(nextWires.find((entry) => entry.id === wire.id) ?? wire);
    }
    if (wireTouchesPreviewComponent(wire, ids)) {
      return materializeEditableWire(wire);
    }
    return wire;
  });
}

function wireTouchesPreviewComponent(wire: CircuitWire, componentIds: Set<string>): boolean {
  return Boolean(
    wire.from?.component_id && componentIds.has(wire.from.component_id) ||
    wire.to?.component_id && componentIds.has(wire.to.component_id),
  );
}

function previewWireIdsForComponents(wires: CircuitWire[], componentIds: string[]): Set<string> {
  const ids = new Set(componentIds);
  return new Set(
    wires
      .filter((wire) => wireTouchesPreviewComponent(wire, ids) && !wireOnlyTouchesDraggedComponents(wire, ids))
      .map((wire) => wire.id),
  );
}

function hitEditableWireSegment(
  wires: CircuitWire[],
  module: CircuitModule,
  world: CircuitPosition,
): { wire: CircuitWire; segmentIndex: number } | null {
  return hitWireSegment(wires, world, (wire) => isStoredWire(wire, module)) ??
    hitWireSegment(wires, world, (wire) => !isStoredWire(wire, module));
}

function hitWireSegment(
  wires: CircuitWire[],
  world: CircuitPosition,
  includeWire: (wire: CircuitWire) => boolean,
): { wire: CircuitWire; segmentIndex: number } | null {
  for (let wireIndex = wires.length - 1; wireIndex >= 0; wireIndex -= 1) {
    const wire = wires[wireIndex];
    if (!wire || !includeWire(wire)) continue;
    const points = wire.points ?? [];
    for (let segmentIndex = 1; segmentIndex < points.length; segmentIndex += 1) {
      const start = points[segmentIndex - 1];
      const end = points[segmentIndex];
      if (start && end && pointToSegmentDistance(world, start, end) < 7) {
        return { wire, segmentIndex };
      }
    }
  }
  return null;
}

function hitSelectedStoredWirePoint(
  wires: CircuitWire[],
  module: CircuitModule,
  selection: SchematicSelection,
  world: CircuitPosition,
): { wire: CircuitWire; pointIndex: number; point: CircuitPosition } | null {
  if (selection?.kind !== 'wire') return null;
  const storedIds = new Set((module.wires ?? []).map((wire) => wire.id));
  const wire = wires.find((entry) => entry.id === selection.id && (entry.source === 'stored' || storedIds.has(entry.id)));
  if (!wire) return null;
  const points = wire.points ?? [];
  for (let pointIndex = points.length - 1; pointIndex >= 0; pointIndex -= 1) {
    const point = points[pointIndex];
    if (!point || distanceSquared(point, world) > 12 * 12) continue;
    if (wirePointIsDraggable(wire, pointIndex)) return { wire, pointIndex, point };
  }
  return null;
}

function wirePointIsDraggable(wire: CircuitWire, pointIndex: number): boolean {
  if (pointIndex > 0 && pointIndex < wire.points.length - 1) return true;
  const endpoint = pointIndex === 0 ? wire.from : pointIndex === wire.points.length - 1 ? wire.to : undefined;
  // Shared semantic junctions must move as a whole graph. Until a junction-drag
  // gesture is active, keep them anchored instead of silently detaching one edge.
  return Boolean(endpoint && !endpoint.component_id && !endpoint.port_id && !endpoint.junction_id);
}

function cursorForWorld(
  document: ReturnType<typeof createSchematicDocument>,
  module: CircuitModule,
  selection: SchematicSelection,
  world: CircuitPosition,
): EditorCursor {
  if (hitSelectedStoredWirePoint(document.wires, module, selection, world)) return 'move';
  if (hitPort(document, world)) return 'grab';
  if (hitRailNetLabel(document, world)) return 'grab';
  if (hitComponent(document, world)) return 'grab';
  if (hitSelectedComponentFrame(document, selection, world)) return 'grab';
  return hitEditableWireSegment(document.wires, module, world) ? 'move' : 'default';
}

function hoverSelectionForWorld(
  document: ReturnType<typeof createSchematicDocument>,
  module: CircuitModule,
  selection: SchematicSelection,
  world: CircuitPosition,
): SchematicSelection {
  const port = hitPort(document, world);
  if (port && !(selection?.kind === 'port' && selection.id === port.id)) {
    return { kind: 'port', id: port.id };
  }
  const railLabel = hitRailNetLabel(document, world);
  if (railLabel && !(selection?.kind === 'netlabel' && selection.id === railLabel.id)) {
    return { kind: 'netlabel', id: railLabel.id };
  }
  const component = hitComponent(document, world);
  if (component && !componentIdsForSelection(selection).includes(component.id)) {
    return { kind: 'component', id: component.id };
  }
  const wire = hitEditableWireSegment(document.wires, module, world)?.wire ?? hitWire(document, world);
  if (wire && !(selection?.kind === 'wire' && selection.id === wire.id)) {
    return { kind: 'wire', id: wire.id };
  }
  return null;
}

function contextMenuSelectionForTarget(
  document: ReturnType<typeof createSchematicDocument>,
  module: CircuitModule,
  target: EventTarget | null,
  world: CircuitPosition,
): SchematicSelection {
  const railLabel = railNetLabelFromPointerTarget(document, target) ?? hitRailNetLabel(document, world);
  if (railLabel) return { kind: 'netlabel', id: railLabel.id };
  const component = componentFromPointerTarget(document, target) ?? hitComponent(document, world);
  if (component) return { kind: 'component', id: component.id };
  const wire = hitEditableWireSegment(document.wires, module, world)?.wire ?? hitWire(document, world);
  return wire ? { kind: 'wire', id: wire.id } : null;
}

function hitSelectedComponentFrame(
  document: ReturnType<typeof createSchematicDocument>,
  selection: SchematicSelection,
  world: CircuitPosition,
): CircuitComponent | null {
  const selectedIds = new Set(componentIdsForSelection(selection));
  if (selectedIds.size === 0) return null;
  const frameInset = 6;
  const hitBand = 10;
  for (let index = document.module.components.length - 1; index >= 0; index -= 1) {
    const component = document.module.components[index];
    if (!component || !selectedIds.has(component.id)) continue;
    const bounds = componentBounds(component);
    const outer = {
      minX: bounds.minX - frameInset - hitBand,
      minY: bounds.minY - frameInset - hitBand,
      maxX: bounds.maxX + frameInset + hitBand,
      maxY: bounds.maxY + frameInset + hitBand,
    };
    const inner = {
      minX: bounds.minX - frameInset + hitBand,
      minY: bounds.minY - frameInset + hitBand,
      maxX: bounds.maxX + frameInset - hitBand,
      maxY: bounds.maxY + frameInset - hitBand,
    };
    const insideOuter = world.x >= outer.minX && world.x <= outer.maxX && world.y >= outer.minY && world.y <= outer.maxY;
    const insideInner = world.x >= inner.minX && world.x <= inner.maxX && world.y >= inner.minY && world.y <= inner.maxY;
    if (insideOuter && !insideInner) {
      return component;
    }
  }
  return null;
}

function componentFromPointerTarget(
  document: ReturnType<typeof createSchematicDocument>,
  target: EventTarget | null,
): CircuitComponent | null {
  if (!(target instanceof Element)) return null;
  const componentId = target.closest('[data-component-id]')?.getAttribute('data-component-id');
  if (!componentId) return null;
  // Net-label hit targets also carry data-component-id; prefer the dedicated helper
  // so we do not treat a GND click as a body hit before net-label handling.
  if (target.closest('[data-testid="schematic-net-label-hit-target"], [data-testid="schematic-net-label"]')) {
    return null;
  }
  return document.module.components.find((component) => component.id === componentId) ?? null;
}

function pinFromPointerTarget(
  document: ReturnType<typeof createSchematicDocument>,
  target: EventTarget | null,
): { component: CircuitComponent; pin: CircuitPin } | null {
  if (!(target instanceof Element)) return null;
  const pinNode = target.closest('[data-endpoint-kind="pin"][data-component-id][data-pin-id]');
  const componentId = pinNode?.getAttribute('data-component-id');
  const pinId = pinNode?.getAttribute('data-pin-id');
  if (!componentId || !pinId) return null;
  const component = document.module.components.find((candidate) => candidate.id === componentId);
  const pin = component?.pins.find((candidate) => candidate.id === pinId);
  return component && pin ? { component, pin } : null;
}

function componentFromNetLabelPointerTarget(
  document: ReturnType<typeof createSchematicDocument>,
  target: EventTarget | null,
): CircuitComponent | null {
  if (!(target instanceof Element)) return null;
  const labelNode = target.closest('[data-testid="schematic-net-label-hit-target"], [data-testid="schematic-net-label"]');
  const componentId = labelNode?.getAttribute('data-component-id')
    ?? labelNode?.closest('[data-component-id]')?.getAttribute('data-component-id');
  if (!componentId) return null;
  return document.module.components.find((component) => component.id === componentId) ?? null;
}

function hitNetLabelComponent(
  document: ReturnType<typeof createSchematicDocument>,
  world: CircuitPosition,
): CircuitComponent | null {
  for (let index = document.netLabels.length - 1; index >= 0; index -= 1) {
    const label = document.netLabels[index];
    if (!label) continue;
    const bounds = netLabelBounds(label);
    if (
      world.x >= bounds.minX && world.x <= bounds.maxX
      && world.y >= bounds.minY && world.y <= bounds.maxY
    ) {
      const componentId = label.endpoint.component_id;
      if (!componentId) continue;
      const component = document.module.components.find((entry) => entry.id === componentId);
      if (component) return component;
    }
  }
  return null;
}

function railNetLabelFromPointerTarget(
  document: ReturnType<typeof createSchematicDocument>,
  target: EventTarget | null,
): SchematicNetLabel | null {
  if (!(target instanceof Element)) return null;
  const labelNode = target.closest('[data-testid="schematic-net-label-hit-target"], [data-testid="schematic-net-label"]');
  const labelId = labelNode?.getAttribute('data-net-label-id');
  if (!labelId) return null;
  const label = document.netLabels.find((entry) => entry.id === labelId);
  return label && (label.kind === 'ground' || label.kind === 'power') ? label : null;
}

function hitRailNetLabel(
  document: ReturnType<typeof createSchematicDocument>,
  world: CircuitPosition,
): SchematicNetLabel | null {
  for (let index = document.netLabels.length - 1; index >= 0; index -= 1) {
    const label = document.netLabels[index];
    if (!label || (label.kind !== 'ground' && label.kind !== 'power')) continue;
    const bounds = netLabelBounds(label);
    if (
      world.x >= bounds.minX && world.x <= bounds.maxX
      && world.y >= bounds.minY && world.y <= bounds.maxY
    ) {
      return label;
    }
  }
  return null;
}

function defaultRailLabelOffset(kind: 'ground' | 'power' | 'signal'): CircuitPosition {
  // Signal labels sit on the pin itself; rail labels hang off a short stub.
  if (kind === 'signal') return { x: 0, y: 0 };
  return kind === 'ground' ? { x: 0, y: RAIL_LABEL_STUB } : { x: 0, y: -RAIL_LABEL_STUB };
}

function nearestNetEndpoint(
  document: ReturnType<typeof createSchematicDocument>,
  net: string,
  fromPoint: CircuitPosition,
  exclude: { componentId: string; pinId: string },
): EndpointHit | null {
  let best: EndpointHit | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const consider = (candidate: EndpointHit | null) => {
    if (!candidate) return;
    const candidateDistance = distance(candidate, fromPoint);
    if (candidateDistance > 0.5 && candidateDistance < bestDistance) {
      best = candidate;
      bestDistance = candidateDistance;
    }
  };
  for (const component of document.module.components) {
    component.pins.forEach((pin, index) => {
      if (pin.net !== net) return;
      if (component.id === exclude.componentId && pin.id === exclude.pinId) return;
      const point = pinWorld(component, pin, index);
      consider({
        kind: 'pin',
        x: point.x,
        y: point.y,
        component_id: component.id,
        pin_id: pin.id,
        label: `${component.name}.${pin.name}`,
        net: pin.net,
      });
    });
  }
  for (const port of document.module.ports) {
    if (port.net !== net) continue;
    const point = document.portPositions.get(port.id);
    if (!point) continue;
    consider({
      kind: 'port',
      x: point.x,
      y: point.y,
      port_id: port.id,
      label: port.name,
      net: port.net,
    });
  }
  for (const wire of document.wires) {
    if ((wire.net ?? '') !== net) continue;
    for (const endpoint of [wire.from, wire.to]) {
      if (!endpoint?.junction_id) continue;
      consider({
        kind: 'junction',
        x: endpoint.x,
        y: endpoint.y,
        junction_id: endpoint.junction_id,
        label: wire.net ? `Junction ${wire.net}` : 'Junction',
        net: wire.net,
        net_id: wire.net_id,
      });
    }
  }
  return best;
}

function portFromPointerTarget(
  document: ReturnType<typeof createSchematicDocument>,
  target: EventTarget | null,
): CircuitPort | null {
  if (!(target instanceof Element)) return null;
  const portId = target.closest('[data-port-id]')?.getAttribute('data-port-id');
  if (!portId) return null;
  return document.module.ports.find((port) => port.id === portId) ?? null;
}

function selectedComponentHandleFromPointerTarget(
  document: ReturnType<typeof createSchematicDocument>,
  target: EventTarget | null,
): CircuitComponent | null {
  if (!(target instanceof Element)) return null;
  const handle = target.closest('[data-testid="schematic-selected-component-frame"], [data-testid="schematic-selected-component-corner"]');
  const componentId = handle?.closest('[data-component-id]')?.getAttribute('data-component-id');
  if (!componentId) return null;
  return document.module.components.find((component) => component.id === componentId) ?? null;
}

function selectionForMarquee(
  document: ReturnType<typeof createSchematicDocument>,
  bounds: SchematicBounds,
): SchematicSelection {
  const componentIds: string[] = [];
  const seen = new Set<string>();
  const remember = (componentId: string | undefined) => {
    if (!componentId || seen.has(componentId)) return;
    seen.add(componentId);
    componentIds.push(componentId);
  };
  for (let index = document.module.components.length - 1; index >= 0; index -= 1) {
    const component = document.module.components[index];
    if (component && boundsIntersect(bounds, componentBounds(component))) {
      remember(component.id);
    }
  }
  for (const label of document.netLabels) {
    if (boundsIntersect(bounds, netLabelBounds(label))) {
      remember(label.endpoint.component_id);
    }
  }
  // Keep document order for stable selection ids.
  componentIds.sort((left, right) => {
    const leftIndex = document.module.components.findIndex((component) => component.id === left);
    const rightIndex = document.module.components.findIndex((component) => component.id === right);
    return leftIndex - rightIndex;
  });
  if (componentIds.length === 1) {
    const componentId = componentIds[0];
    return componentId ? { kind: 'component', id: componentId } : null;
  }
  if (componentIds.length > 1) return { kind: 'components', ids: componentIds };
  const wireIds = document.wires
    .filter((entry) => wireIntersectsBounds(entry, bounds))
    .map((entry) => entry.id);
  return selectionForWireIds(wireIds);
}

function componentIdsForSelection(selection: SchematicSelection): string[] {
  if (selection?.kind === 'component') return [selection.id];
  if (selection?.kind === 'components') return selection.ids;
  return [];
}

function wireIdsForSelection(selection: SchematicSelection): string[] {
  if (selection?.kind === 'wire') return [selection.id];
  if (selection?.kind === 'wires') return selection.ids;
  return [];
}

function selectionForWireIds(wireIds: string[]): SchematicSelection {
  const uniqueIds = [...new Set(wireIds)].filter(Boolean);
  if (uniqueIds.length === 0) return null;
  const firstId = uniqueIds[0];
  if (uniqueIds.length === 1 && firstId) return { kind: 'wire', id: firstId };
  return { kind: 'wires', ids: uniqueIds };
}

function selectionForComponentIds(componentIds: string[]): SchematicSelection {
  const uniqueIds = [...new Set(componentIds)].filter(Boolean);
  if (uniqueIds.length === 0) return null;
  const firstId = uniqueIds[0];
  if (uniqueIds.length === 1 && firstId) return { kind: 'component', id: firstId };
  return { kind: 'components', ids: uniqueIds };
}

function selectionAttribute(selection: SchematicSelection): string {
  if (!selection) return '';
  if (selection.kind === 'components') return `components:${selection.ids.join(',')}`;
  if (selection.kind === 'wires') return `wires:${selection.ids.join(',')}`;
  return `${selection.kind}:${selection.id}`;
}

function componentPositionsById(module: CircuitModule, componentIds: string[]): Record<string, CircuitPosition> {
  return Object.fromEntries(
    componentIds
      .map((componentId) => {
        const component = module.components.find((entry) => entry.id === componentId);
        return component ? [componentId, { ...component.position }] : null;
      })
      .filter((entry): entry is [string, CircuitPosition] => Boolean(entry)),
  );
}

function applyComponentPositions(module: CircuitModule, positions: Record<string, CircuitPosition>) {
  for (const [componentId, position] of Object.entries(positions)) {
    const component = module.components.find((entry) => entry.id === componentId);
    if (component) component.position = { ...position };
  }
}

function moduleWithComponentPositions(
  module: CircuitModule,
  positions: Record<string, CircuitPosition>,
): CircuitModule {
  return {
    ...module,
    components: module.components.map((component) => {
      const position = positions[component.id];
      return position ? { ...component, position: { ...position } } : component;
    }),
  };
}

function clonePositionMap(positions: Record<string, CircuitPosition>): Record<string, CircuitPosition> {
  return Object.fromEntries(
    Object.entries(positions).map(([componentId, position]) => [componentId, { ...position }]),
  );
}

function samePosition(left: CircuitPosition | null, right: CircuitPosition | null): boolean {
  return left?.x === right?.x && left?.y === right?.y;
}

function samePositionMap(left: Record<string, CircuitPosition>, right: Record<string, CircuitPosition>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((componentId) => (
    left[componentId]?.x === right[componentId]?.x &&
    left[componentId]?.y === right[componentId]?.y
  ));
}

function normalizedBounds(start: CircuitPosition, end: CircuitPosition): SchematicBounds {
  return {
    minX: Math.min(start.x, end.x),
    minY: Math.min(start.y, end.y),
    maxX: Math.max(start.x, end.x),
    maxY: Math.max(start.y, end.y),
  };
}

function boundsIntersect(left: SchematicBounds, right: SchematicBounds): boolean {
  return left.minX <= right.maxX &&
    left.maxX >= right.minX &&
    left.minY <= right.maxY &&
    left.maxY >= right.minY;
}

function wireIntersectsBounds(wire: CircuitWire, bounds: SchematicBounds): boolean {
  const points = wire.points ?? [];
  if (points.some((point) => pointInBounds(point, bounds))) return true;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (start && end && segmentIntersectsBounds(start, end, bounds)) return true;
  }
  return false;
}

function pointInBounds(point: CircuitPosition, bounds: SchematicBounds): boolean {
  return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
}

function segmentIntersectsBounds(start: CircuitPosition, end: CircuitPosition, bounds: SchematicBounds): boolean {
  if (pointInBounds(start, bounds) || pointInBounds(end, bounds)) return true;
  const topLeft = { x: bounds.minX, y: bounds.minY };
  const topRight = { x: bounds.maxX, y: bounds.minY };
  const bottomRight = { x: bounds.maxX, y: bounds.maxY };
  const bottomLeft = { x: bounds.minX, y: bounds.maxY };
  const edges: Array<[CircuitPosition, CircuitPosition]> = [
    [topLeft, topRight],
    [topRight, bottomRight],
    [bottomRight, bottomLeft],
    [bottomLeft, topLeft],
  ];
  return edges.some(([edgeStart, edgeEnd]) => segmentsIntersect(start, end, edgeStart, edgeEnd));
}

function segmentsIntersect(a: CircuitPosition, b: CircuitPosition, c: CircuitPosition, d: CircuitPosition): boolean {
  const direction = (p: CircuitPosition, q: CircuitPosition, r: CircuitPosition) => (
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  );
  const abC = direction(a, b, c);
  const abD = direction(a, b, d);
  const cdA = direction(c, d, a);
  const cdB = direction(c, d, b);
  if (abC === 0 && pointInBounds(c, normalizedBounds(a, b))) return true;
  if (abD === 0 && pointInBounds(d, normalizedBounds(a, b))) return true;
  if (cdA === 0 && pointInBounds(a, normalizedBounds(c, d))) return true;
  if (cdB === 0 && pointInBounds(b, normalizedBounds(c, d))) return true;
  return (abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0);
}

function applyWirePointDrag(
  module: CircuitModule,
  drag: WirePointDragState,
  nextPoints: CircuitPosition[],
): CircuitModule {
  const next = cloneModule(module);
  const wire = next.wires?.find((entry) => entry.id === drag.wireId);
  if (!wire) return module;
  wire.points = compactEditorRoute(nextPoints);
  if (drag.pointIndex === 0 && wire.from && !wire.from.component_id && !wire.from.port_id) {
    wire.from = { ...wire.from, ...nextPoints[0] };
  }
  if (drag.pointIndex === drag.originalPoints.length - 1 && wire.to && !wire.to.component_id && !wire.to.port_id) {
    wire.to = { ...wire.to, ...nextPoints[nextPoints.length - 1] };
  }
  return next;
}

function dragWireSegmentPoints(
  points: CircuitPosition[],
  segmentIndex: number,
  dx: number,
  dy: number,
): CircuitPosition[] {
  const start = points[segmentIndex - 1];
  const end = points[segmentIndex];
  if (!start || !end) return clonePoints(points);
  const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
  const lastIndex = points.length - 1;
  const shiftedStart = horizontal
    ? { x: start.x, y: snapPoint({ x: 0, y: start.y + dy }).y }
    : { x: snapPoint({ x: start.x + dx, y: 0 }).x, y: start.y };
  const shiftedEnd = horizontal
    ? { x: end.x, y: shiftedStart.y }
    : { x: shiftedStart.x, y: end.y };
  const rebuilt: CircuitPosition[] = [];

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!point) continue;
    if (index === segmentIndex - 1) {
      if (index === 0) {
        rebuilt.push(point, shiftedStart);
      } else {
        rebuilt.push(shiftedStart);
      }
      continue;
    }
    if (index === segmentIndex) {
      if (index === lastIndex) {
        rebuilt.push(shiftedEnd, point);
      } else {
        rebuilt.push(shiftedEnd);
      }
      continue;
    }
    rebuilt.push(point);
  }
  return compactEditorRoute(rebuilt);
}

function compactEditorRoute(points: CircuitPosition[]): CircuitPosition[] {
  const deduped: CircuitPosition[] = [];
  for (const point of points) {
    const previous = deduped.at(-1);
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    deduped.push(point);
  }
  const orthogonal = orthogonalizeEditorRoute(deduped);
  if (orthogonal.length <= 2) return orthogonal;
  return orthogonal.filter((point, index) => {
    if (index === 0 || index === orthogonal.length - 1) return true;
    const previous = orthogonal[index - 1];
    const next = orthogonal[index + 1];
    if (!previous || !next) return true;
    return !(
      previous.x === point.x && point.x === next.x ||
      previous.y === point.y && point.y === next.y
    );
  });
}

function orthogonalizeEditorRoute(points: CircuitPosition[]): CircuitPosition[] {
  const routed: CircuitPosition[] = [];
  for (const point of points) {
    const previous = routed.at(-1);
    if (!previous) {
      routed.push(point);
      continue;
    }
    if (previous.x === point.x || previous.y === point.y) {
      routed.push(point);
      continue;
    }
    const beforePrevious = routed.length > 1 ? routed[routed.length - 2] : undefined;
    const elbow = chooseEditorRouteElbow(beforePrevious, previous, point);
    if (elbow.x !== previous.x || elbow.y !== previous.y) routed.push(elbow);
    routed.push(point);
  }
  return routed;
}

function chooseEditorRouteElbow(
  beforeStart: CircuitPosition | undefined,
  start: CircuitPosition,
  end: CircuitPosition,
): CircuitPosition {
  if (beforeStart?.y === start.y) return { x: end.x, y: start.y };
  if (beforeStart?.x === start.x) return { x: start.x, y: end.y };
  return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)
    ? { x: end.x, y: start.y }
    : { x: start.x, y: end.y };
}

function clonePoints(points: CircuitPosition[]): CircuitPosition[] {
  return points.map((point) => ({ x: point.x, y: point.y }));
}

function samePoints(left: CircuitPosition[], right: CircuitPosition[]): boolean {
  return left.length === right.length &&
    left.every((point, index) => point.x === right[index]?.x && point.y === right[index]?.y);
}

function distanceSquared(left: CircuitPosition, right: CircuitPosition): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function hasNonCollapsedDomTextSelection(): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return selection.toString().length > 0;
}

function isSpacePanKey(event: Pick<KeyboardEvent | ReactKeyboardEvent<HTMLDivElement>, 'key'>): boolean {
  return event.key === ' ' || event.key === 'Spacebar';
}

function orderedConnectivityFingerprint(module: CircuitModule): string {
  const rows: string[] = [];
  for (const port of module.ports || []) {
    rows.push(`port|${port.id}|${port.net_id || port.net || ''}`);
  }
  for (const component of module.components || []) {
    const identity = component.stable_id || component.id;
    for (const pin of component.pins || []) {
      rows.push(`pin|${identity}|${pin.id}|${pin.net_id || pin.net || ''}`);
    }
  }
  let hash = 2166136261;
  const text = rows.join(';');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const styles: Record<string, CSSProperties> = {
  editorShell: {
    display: 'flex',
    flexDirection: 'column',
    flex: '1 1 auto',
    minWidth: 0,
    minHeight: 0,
    height: '100%',
    position: 'relative',
    border: '1px solid #d8dee8',
    background: '#ffffff',
    outline: 'none',
  },
  editorShellFocused: {
    border: '1px solid #93b4ff',
    boxShadow: '0 0 0 2px rgba(37, 99, 235, 0.16)',
  },
  moduleLibrary: {
    position: 'absolute',
    left: 12,
    top: 96,
    zIndex: 4,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: 8,
    background: 'rgba(255,255,255,0.94)',
    border: '1px solid #d0d7de',
    borderRadius: 8,
    maxWidth: 180,
    maxHeight: 220,
    overflow: 'auto',
  },
  moduleLibraryTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: '#57606a',
    marginBottom: 2,
  },
  moduleLibraryButton: {
    textAlign: 'left' as const,
    border: '1px solid #d0d7de',
    background: '#fff',
    borderRadius: 6,
    padding: '4px 8px',
    fontSize: 12,
    cursor: 'pointer',
  },
  moduleLibraryButtonActive: {
    borderColor: '#0969da',
    background: '#ddf4ff',
  },
  toolButton: {
    minWidth: 42,
    height: 32,
    padding: '0 10px',
    border: '1px solid #c7ced6',
    borderRadius: 5,
    background: '#ffffff',
    color: '#253041',
    fontWeight: 650,
    cursor: 'pointer',
  },
  primaryButton: {
    minWidth: 58,
    height: 32,
    padding: '0 12px',
    border: 'none',
    borderRadius: 5,
    background: '#2563eb',
    color: '#ffffff',
    fontWeight: 700,
    cursor: 'pointer',
  },
  content: { display: 'flex', flexDirection: 'column', minHeight: 520, flex: '1 1 520px' },
  stage: {
    flex: '1 1 420px',
    minHeight: 420,
    position: 'relative',
    overflow: 'hidden',
    background: '#ffffff',
  },
  panel: {
    borderTop: '1px solid #d8dee8',
    padding: 12,
    overflow: 'auto',
    background: '#fbfcfe',
    boxSizing: 'border-box',
    flex: '0 0 min(220px, 28vh)',
    height: 'min(220px, 28vh)',
    minHeight: 160,
    maxHeight: 'min(220px, 28vh)',
  },
  panelTitle: {
    color: '#697386',
    fontSize: 11,
    fontWeight: 800,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  liveErcSummary: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '7px 9px',
    marginBottom: 7,
    border: '1px solid',
    borderRadius: 5,
    fontSize: 11,
  },
  liveErcSummaryError: { color: '#991b1b', borderColor: '#fecaca', background: '#fef2f2' },
  liveErcSummaryWarning: { color: '#92400e', borderColor: '#fde68a', background: '#fffbeb' },
  liveErcSummaryClean: { color: '#166534', borderColor: '#bbf7d0', background: '#f0fdf4' },
  liveErcList: {
    display: 'grid',
    gap: 4,
    marginBottom: 10,
    maxHeight: 92,
    overflow: 'auto',
  },
  liveErcItem: {
    display: 'grid',
    gridTemplateColumns: '16px minmax(0, 1fr)',
    gap: 5,
    alignItems: 'start',
    width: '100%',
    padding: '3px 6px',
    border: 0,
    borderRadius: 3,
    background: '#ffffff',
    color: '#596274',
    textAlign: 'left',
    fontSize: 10,
    lineHeight: 1.3,
    cursor: 'pointer',
  },
  hierarchyDiagnostic: {
    padding: '5px 7px',
    marginBottom: 5,
    borderRadius: 4,
    background: '#fff7ed',
    color: '#9a3412',
    fontSize: 10,
    lineHeight: 1.35,
  },
  hierarchyPortMap: {
    display: 'grid',
    gap: 4,
    margin: '8px 0 10px',
  },
  hierarchyPortMapRow: {
    display: 'grid',
    gridTemplateColumns: '52px minmax(0, 1fr) auto',
    gap: 6,
    alignItems: 'center',
    fontSize: 10,
    color: '#536172',
  },
  moduleInstanceActions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },
  fieldLabel: { display: 'grid', gap: 5, fontSize: 12, color: '#536172', marginBottom: 10, fontWeight: 650 },
  fieldGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0 10px' },
  typeBadge: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 10,
    fontSize: 12,
    fontWeight: 750,
    color: '#243247',
  },
  typeBadgeKind: {
    fontSize: 10,
    fontWeight: 700,
    color: '#697386',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  paramHint: { fontSize: 11, color: '#7a818b', margin: '0 0 10px' },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    border: '1px solid #c7ced6',
    borderRadius: 4,
    padding: '6px 8px',
    color: '#202a37',
    background: '#ffffff',
  },
  pinList: { display: 'grid', gap: 6, marginTop: 12 },
  probeActions: { display: 'flex', justifyContent: 'flex-end', margin: '2px 0 10px' },
  pinProbeGroup: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  probeIconButton: {
    width: 26,
    height: 26,
    border: '1px solid #b8c6d8',
    borderRadius: 4,
    background: '#ffffff',
    color: '#1f5f96',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 800,
  },
  pinRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '6px 8px',
    border: '1px solid #e2e7ee',
    borderRadius: 4,
    background: '#ffffff',
    fontSize: 12,
  },
  pinEditorHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 4,
    color: '#536172',
    fontSize: 12,
    fontWeight: 750,
  },
  blockPinList: { display: 'grid', gap: 5, marginTop: 8 },
  blockPinRow: {
    display: 'grid',
    gridTemplateColumns: '48px minmax(92px, 1fr) minmax(110px, 1.2fr) 96px 30px',
    gap: 6,
    alignItems: 'center',
  },
  compactInput: {
    minWidth: 0,
    width: '100%',
    boxSizing: 'border-box',
    height: 30,
    border: '1px solid #c7ced6',
    borderRadius: 4,
    padding: '4px 6px',
    color: '#202a37',
    background: '#ffffff',
    fontSize: 12,
  },
  pinId: { color: '#64748b', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' },
  smallButton: {
    height: 28,
    padding: '0 8px',
    border: '1px solid #c7ced6',
    borderRadius: 4,
    background: '#ffffff',
    color: '#253041',
    cursor: 'pointer',
    fontWeight: 650,
    fontSize: 11,
  },
  removePinButton: {
    width: 30,
    height: 30,
    border: '1px solid #d8a5a5',
    borderRadius: 4,
    background: '#ffffff',
    color: '#a32626',
    cursor: 'pointer',
    fontWeight: 800,
  },
  emptyText: { color: '#748094', fontSize: 12, lineHeight: 1.5 },
  contextMenu: {
    position: 'fixed',
    zIndex: 1000,
    display: 'grid',
    gap: 2,
    minWidth: 132,
    padding: 5,
    border: '1px solid #c7ced6',
    borderRadius: 5,
    background: '#ffffff',
    boxShadow: '0 12px 28px rgba(15, 23, 42, 0.16)',
  },
  contextMenuItem: {
    height: 30,
    padding: '0 10px',
    border: 'none',
    borderRadius: 4,
    background: '#ffffff',
    color: '#253041',
    textAlign: 'left',
    fontWeight: 650,
    cursor: 'pointer',
  },
  contextMenuItemDanger: {
    height: 30,
    padding: '0 10px',
    border: 'none',
    borderRadius: 4,
    background: '#ffffff',
    color: '#b42318',
    textAlign: 'left',
    fontWeight: 700,
    cursor: 'pointer',
  },
  modalBackdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 1200,
    display: 'grid',
    placeItems: 'center',
    padding: 20,
    background: 'rgba(15, 23, 42, 0.34)',
  },
  blockModal: {
    width: 'min(760px, calc(100vw - 40px))',
    maxHeight: 'min(760px, calc(100vh - 40px))',
    overflow: 'auto',
    boxSizing: 'border-box',
    padding: 16,
    border: '1px solid #c7ced6',
    borderRadius: 6,
    background: '#ffffff',
    boxShadow: '0 18px 46px rgba(15, 23, 42, 0.24)',
  },
  modalHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
    marginBottom: 14,
  },
  modalTitle: { color: '#1f2937', fontSize: 18, fontWeight: 760 },
  modalCloseButton: {
    width: 30,
    height: 30,
    border: '1px solid #c7ced6',
    borderRadius: 4,
    background: '#ffffff',
    color: '#526071',
    cursor: 'pointer',
    fontWeight: 750,
  },
  blockDraftHeader: {
    display: 'grid',
    gridTemplateColumns: '48px minmax(120px, 1fr) minmax(140px, 1.2fr) 104px',
    gap: 6,
    padding: '0 0 5px',
    color: '#697386',
    fontSize: 10,
    fontWeight: 800,
    textTransform: 'uppercase',
  },
  blockDraftPins: { display: 'grid', gap: 6, maxHeight: 310, overflow: 'auto', paddingRight: 3 },
  blockDraftPinRow: {
    display: 'grid',
    gridTemplateColumns: '48px minmax(120px, 1fr) minmax(140px, 1.2fr) 104px',
    gap: 6,
    alignItems: 'center',
  },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
};
