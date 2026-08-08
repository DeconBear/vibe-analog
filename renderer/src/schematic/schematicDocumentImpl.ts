import type {
  CircuitComponent,
  CircuitModule,
  CircuitPin,
  CircuitPort,
  CircuitPosition,
  CircuitWire,
  CircuitWireEndpoint,
  ProjectKind,
} from '../types';
import {
  defaultParametersForType,
  projectComponentValue,
} from '../components/canvas/componentParams/projectToValue';

export const SCHEMATIC_GRID = 20;
export const PIN_REACH = 12;
export const BLOCK_PIN_LEAD = 24;
export const AUTO_LAYOUT_COMPONENT_LIMIT = 80;
const ROUTE_OBSTACLE_PADDING = SCHEMATIC_GRID + 4;

export type ToolComponentType = Exclude<CircuitComponent['type'], 'E' | 'BLOCK' | 'MODULE' | 'U' | 'X' | 'F' | 'G' | 'H' | 'B'>;
export type BlockPinSide = NonNullable<CircuitPin['side']>;

export interface BlockDefinition {
  name?: string;
  value: string;
  width?: number;
  height?: number;
  pins: Array<Pick<CircuitPin, 'id' | 'name' | 'net' | 'side' | 'order'>>;
}

export type SchematicSelection =
  | { kind: 'component'; id: string }
  | { kind: 'components'; ids: string[] }
  | { kind: 'port'; id: string }
  | { kind: 'wire'; id: string }
  | { kind: 'wires'; ids: string[] }
  | { kind: 'netlabel'; id: string }
  | null;

type SignalPortSide = 'left' | 'right';
export type SchematicPortSide = 'left' | 'right' | 'top' | 'bottom';

export interface EndpointHit extends CircuitWireEndpoint {
  kind: 'pin' | 'port' | 'point' | 'junction';
  label: string;
  net?: string;
  net_id?: string;
  /** Transient reference used to split/materialize a wire when a branch is committed. */
  wire_id?: string;
  segment_index?: number;
}

export interface SchematicBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Routing keep-out zone; `net` marks the owning net so its own labels stay routable. */
type NetRouteObstacle = SchematicBounds & { net?: string };

export interface SchematicNetLabel {
  id: string;
  kind: 'power' | 'ground' | 'signal';
  net: string;
  name: string;
  /** Symbol / text anchor (offset from the pin for rail labels). */
  position: CircuitPosition;
  /** Pin or port attachment point that the stub wire connects to. */
  endpoint: CircuitWireEndpoint;
  side?: 'left' | 'right' | 'top' | 'bottom';
}

export type SchematicTextAnchor = 'start' | 'middle' | 'end';

/** Resolved text anchor (baseline position + SVG text-anchor) for one label. */
export interface SchematicTextPlacement extends CircuitPosition {
  anchor: SchematicTextAnchor;
}

/**
 * Font sizes used by the SVG renderer. The label-placement resolver and the
 * collision assertions approximate text extents with these exact sizes, so
 * the approximation never drifts from what is actually painted.
 */
export const NET_LABEL_FONT_SIZE = 16;
export const COMPONENT_NAME_FONT_SIZE = 17;
export const COMPONENT_VALUE_FONT_SIZE = 15;
export const PORT_LABEL_FONT_SIZE = 14;

/** Average em width of a bold Arial glyph, used for text extent approximation. */
const LABEL_CHAR_WIDTH_EM = 0.68;
/**
 * Vertical extents of a glyph run as a fraction of the font size (ascent /
 * descent of bold Arial, plus the white halo stroke), and the extra clearance
 * (px) added around each approximated text box.
 */
const LABEL_ASCENT_EM = 0.8;
const LABEL_DESCENT_EM = 0.3;
const LABEL_TEXT_MARGIN = 1;

/**
 * Approximate rendered bounds of a text run painted at (`x`, `y` baseline)
 * with the given SVG text-anchor. Shared by the deterministic label-placement
 * resolver and the regression assertions so both judge collisions with the
 * same metric.
 */
export function schematicTextBounds(
  text: string,
  fontSize: number,
  x: number,
  y: number,
  anchor: SchematicTextAnchor,
): SchematicBounds {
  const width = text.length * fontSize * LABEL_CHAR_WIDTH_EM;
  const minX = anchor === 'start' ? x : anchor === 'end' ? x - width : x - width / 2;
  return {
    minX: minX - LABEL_TEXT_MARGIN,
    maxX: minX + width + LABEL_TEXT_MARGIN,
    minY: y - fontSize * LABEL_ASCENT_EM - LABEL_TEXT_MARGIN,
    maxY: y + fontSize * LABEL_DESCENT_EM + LABEL_TEXT_MARGIN,
  };
}

export interface SchematicDocument {
  schema: 'actoviq.schematic-document.v1';
  moduleId: string;
  moduleName: string;
  module: CircuitModule;
  portPositions: Map<string, CircuitPosition>;
  connectedPortIds: Set<string>;
  netLabels: SchematicNetLabel[];
  wires: CircuitWire[];
  bounds: SchematicBounds;
  viewBox: SchematicBounds;
  /**
   * Deterministically resolved text anchors for labels whose default position
   * collided with another label. Keyed by `netlabel:<id>`, `port:<id>`, and
   * `component:<id>:name|value`; entries absent here render at their default
   * anchor. See resolveSchematicLabelPlacements.
   */
  labelPlacements: Map<string, SchematicTextPlacement>;
}

export interface SchematicDocumentOptions {
  autoLayout?: boolean;
}

/**
 * Serializable projection conforming to
 * `skills/circuit-design-ngspice/schemas/schematic-document.schema.json`.
 *
 * The TypeScript `SchematicDocument` uses `Map` and `Set` for efficient
 * lookup during interaction; this serializer turns them into plain JSON
 * structures so the projection can be validated against the schema and
 * shared with the Python/netlistsvg adapter. See ADR-0002.
 */
export interface SerializableSchematicDocument {
  schema: 'actoviq.schematic-document.v1';
  moduleId: string;
  moduleName: string;
  module: CircuitModule;
  portPositions: Record<string, CircuitPosition>;
  connectedPortIds: string[];
  netLabels: SchematicNetLabel[];
  wires: CircuitWire[];
  bounds: SchematicBounds;
  viewBox: SchematicBounds;
  labelPlacements: Record<string, SchematicTextPlacement>;
}

export function serializeSchematicDocument(document: SchematicDocument): SerializableSchematicDocument {
  const portPositions: Record<string, CircuitPosition> = {};
  for (const [id, position] of document.portPositions) {
    portPositions[id] = position;
  }
  const labelPlacements: Record<string, SchematicTextPlacement> = {};
  for (const [key, placement] of document.labelPlacements) {
    labelPlacements[key] = placement;
  }
  return {
    schema: 'actoviq.schematic-document.v1',
    moduleId: document.moduleId,
    moduleName: document.moduleName,
    module: document.module,
    portPositions,
    connectedPortIds: [...document.connectedPortIds],
    netLabels: document.netLabels,
    wires: document.wires,
    bounds: document.bounds,
    viewBox: document.viewBox,
    labelPlacements,
  };
}

export function deserializeSchematicDocument(
  document: SerializableSchematicDocument,
): SchematicDocument {
  return {
    ...document,
    portPositions: new Map(Object.entries(document.portPositions)),
    connectedPortIds: new Set(document.connectedPortIds),
    labelPlacements: new Map(Object.entries(document.labelPlacements ?? {})),
  };
}

export interface WireTopologyIssue {
  code:
    | 'invalid_wire'
    | 'invalid_endpoint'
    | 'net_mismatch'
    | 'junction_conflict'
    | 'unintended_contact';
  message: string;
  wire_ids: string[];
  point?: CircuitPosition;
}

export const COMPONENT_TYPES: ToolComponentType[] = ['R', 'C', 'L', 'D', 'M', 'Q', 'V', 'I', 'GND'];

export const DEFAULT_VALUES: Record<ToolComponentType, string> = {
  R: '1k',
  C: '1n',
  L: '1u',
  D: 'D',
  M: 'NMOS W=1u L=180n',
  Q: 'NPN',
  V: 'DC 1',
  I: 'DC 1m',
  GND: 'GND',
};

const PIN_DEFS: Record<ToolComponentType, Array<[string, string]>> = {
  R: [['a', '1'], ['b', '2']],
  C: [['a', '1'], ['b', '2']],
  L: [['a', '1'], ['b', '2']],
  D: [['a', 'A'], ['b', 'K']],
  V: [['p', '+'], ['n', '-']],
  I: [['p', '+'], ['n', '-']],
  Q: [['c', 'C'], ['b', 'B'], ['e', 'E']],
  M: [['d', 'D'], ['g', 'G'], ['s', 'S'], ['b', 'B']],
  GND: [['gnd', 'GND']],
};

export function cloneModule(module: CircuitModule): CircuitModule {
  return JSON.parse(JSON.stringify(module)) as CircuitModule;
}

export function createSchematicDocumentImplementation(
  module: CircuitModule,
  options: SchematicDocumentOptions = {},
): SchematicDocument {
  const shouldAutoLayout = (
    options.autoLayout !== false
    && (module.wires ?? []).length === 0
    && module.components.length <= AUTO_LAYOUT_COMPONENT_LIMIT
  );
  const next = shouldAutoLayout ? autoLayoutModule(cloneModule(module)) : cloneModule(module);
  next.ports = normalizeSchematicPorts(next.ports, next.components, next.wires);
  ensureStableNetModel(next);
  for (const component of next.components) {
    component.rotation = normalizeRotation(component.rotation);
    component.position = snapPoint(component.position);
  }
  const portPositions = computePortPositions(next);
  const connectedPortIds = computeConnectedPortIds(next);
  const netLabels = createNetLabels(next, portPositions);
  const wires = materializeNetWires(next, portPositions, netLabels);
  // Unconnected ports render dimmed as wire targets, so they also belong to the
  // plot bounds; only rail ports already represented by net-label stubs drop out.
  const visiblePortIds = new Set(
    next.ports
      .filter((port) => portVisibleForNetLabels(netLabels, port))
      .map((port) => port.id),
  );
  const bounds = moduleBounds(next, filterPortPositions(portPositions, visiblePortIds), wires, netLabels);
  const viewBox = padBounds(bounds, viewBoxPadding(bounds));
  const document: SchematicDocument = {
    schema: 'actoviq.schematic-document.v1',
    moduleId: next.module_id,
    moduleName: next.name,
    module: next,
    portPositions,
    connectedPortIds,
    netLabels,
    wires,
    bounds,
    viewBox,
    labelPlacements: new Map(),
  };
  document.labelPlacements = resolveSchematicLabelPlacements(document);
  return document;
}

/**
 * Normalize historical module data before projecting it into the editor.
 *
 * SPICE net names are case-insensitive, so an inferred VIN/OUT and an explicit
 * VIN/VOUT on the same net are one interface. Explicit named ports win over
 * inferred or generic IN/OUT aliases because project-level connections may
 * reference those ids. Stale inferred and generic IN/OUT ports are removed,
 * while named explicit module interfaces are preserved even when the local
 * schematic does not currently consume them.
 */
export function isGenericModulePort(port: Pick<CircuitPort, 'id' | 'name'>): boolean {
  const genericNames = new Set(['in', 'input', 'out', 'output']);
  return genericNames.has(port.id.trim().toLowerCase()) || genericNames.has(port.name.trim().toLowerCase());
}

function preferSchematicPortCandidate(
  current: { port: CircuitPort },
  candidate: { port: CircuitPort },
): boolean {
  const currentInferred = Boolean(current.port.inferred);
  const candidateInferred = Boolean(candidate.port.inferred);
  if (currentInferred && !candidateInferred) return true;
  if (!currentInferred && candidateInferred) return false;
  const currentGeneric = isGenericModulePort(current.port);
  const candidateGeneric = isGenericModulePort(candidate.port);
  if (currentGeneric && !candidateGeneric) return true;
  if (!currentGeneric && candidateGeneric) return false;
  return false;
}

export function normalizeSchematicPorts(
  ports: CircuitPort[],
  components: CircuitComponent[],
  wires: CircuitWire[] = [],
): CircuitPort[] {
  const liveNets = new Set(
    components.flatMap((component) => component.pins.map((pin) => pin.net.trim().toLowerCase())).filter(Boolean),
  );
  const sourceDrivenNets = new Set(
    components
      .filter((component) => component.type === 'V' || component.type === 'I')
      .map((component) => component.pins[0]?.net.trim().toLowerCase() ?? '')
      .filter(Boolean),
  );
  const wiredPortIds = new Set(
    wires.flatMap((wire) => (
      [wire.from?.port_id, wire.to?.port_id].filter((id): id is string => Boolean(id))
    )),
  );
  const candidates = ports.flatMap((port, index) => {
    const id = port.id.trim();
    const net = port.net.trim().toLowerCase();
    if (!id || !net) return [];
    const genericInterface = isGenericModulePort(port);
    if (!liveNets.has(net) && !wiredPortIds.has(id) && (port.inferred || genericInterface)) return [];
    if (
      port.inferred &&
      sourceDrivenNets.has(net) &&
      (port.signal_type === 'analog' || port.signal_type === 'power') &&
      port.direction === 'input'
    ) {
      return [];
    }
    return [{ index, port, id, net }];
  });

  const winnerByNet = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    const current = winnerByNet.get(candidate.net);
    if (!current || preferSchematicPortCandidate(current, candidate)) {
      winnerByNet.set(candidate.net, candidate);
    }
  }

  const usedIds = new Set<string>();
  return candidates.flatMap((candidate) => {
    if (winnerByNet.get(candidate.net)?.index !== candidate.index || usedIds.has(candidate.id)) return [];
    usedIds.add(candidate.id);
    return [candidate.port];
  });
}

export function snap(value: number): number {
  return Math.round(value / SCHEMATIC_GRID) * SCHEMATIC_GRID;
}

export function snapPoint(point: CircuitPosition): CircuitPosition {
  return { x: snap(point.x), y: snap(point.y) };
}

export function normalizeRotation(value: number | undefined): number {
  const rotation = ((Number(value ?? 0) % 360) + 360) % 360;
  return Math.round(rotation / 90) * 90;
}

export function makeId(prefix: string, existing: Set<string>): string {
  for (let index = 1; index < 10000; index += 1) {
    const id = `${prefix}${index}`;
    if (!existing.has(id)) return id;
  }
  return `${prefix}${Date.now()}`;
}

export function makePlacedComponent(
  module: CircuitModule,
  type: ToolComponentType,
  position: CircuitPosition,
  options?: { projectKind?: ProjectKind },
): CircuitComponent {
  const existingIds = new Set(module.components.map((component) => component.id));
  const id = makeId(type.toLowerCase(), existingIds);
  const name = `${type}${id.replace(/^[a-z]+/i, '')}`;
  const pins: CircuitPin[] = PIN_DEFS[type].map(([pinId, pinName], index) => ({
    id: pinId,
    name: pinName,
    // A placed ground symbol ties straight to the ground net instead of a
    // fresh floating net; mergeStableNets then grounds anything wired to it.
    net: type === 'GND' ? '0' : `n_${id}_${index + 1}`,
  }));
  const projectKind = options?.projectKind ?? 'simulation';
  const parameters = type === 'GND' ? undefined : defaultParametersForType(type);
  const value = type === 'GND'
    ? DEFAULT_VALUES[type]
    : projectComponentValue(type, parameters, DEFAULT_VALUES[type]);
  const component: CircuitComponent = {
    id,
    type,
    name,
    value,
    position,
    // Voltage / current sources default upright; resistors stay 0 and layout heuristics rotate.
    rotation: type === 'V' || type === 'I' ? 90 : 0,
    pins,
    ...(parameters ? { parameters } : {}),
  };
  if (projectKind === 'pcb_schematic' && type !== 'GND' && (type === 'R' || type === 'C' || type === 'L')) {
    component.eda = { footprint_hint: `${type}_0603` };
  }
  if ((projectKind === 'analog_ic' || projectKind === 'mixed_signal_ic') && type === 'M') {
    component.parameters = {
      ...(component.parameters || {}),
      device_id: 'nmos',
      model: 'NMOS',
    };
    component.value = projectComponentValue(type, component.parameters, value);
  }
  return component;
}

export function makePlacedBlock(
  module: CircuitModule,
  position: CircuitPosition,
  definition: BlockDefinition,
): CircuitComponent {
  const existingIds = new Set(module.components.map((component) => component.id));
  const id = makeId('block', existingIds);
  const numericId = id.replace(/^[a-z_-]+/i, '') || String(module.components.length + 1);
  const usedPinIds = new Set<string>();
  const pins = definition.pins.map((pin, index) => {
    const base = pin.id.trim().replace(/[^A-Za-z0-9_-]+/g, '_') || `p${index + 1}`;
    let pinId = base;
    let suffix = 2;
    while (usedPinIds.has(pinId)) {
      pinId = `${base}_${suffix}`;
      suffix += 1;
    }
    usedPinIds.add(pinId);
    return {
      id: pinId,
      name: pin.name.trim() || `PIN${index + 1}`,
      net: pin.net.trim() || `n_${id}_${index + 1}`,
      side: pin.side,
      order: typeof pin.order === 'number' && Number.isFinite(pin.order) ? pin.order : index,
    };
  });
  return {
    id,
    type: 'BLOCK',
    name: definition.name?.trim() || `U${numericId}`,
    value: definition.value.trim() || 'Custom block',
    position,
    rotation: 0,
    pins: pins.length > 0 ? pins : [{ id: 'p1', name: 'PIN1', net: `n_${id}_1`, side: 'left', order: 0 }],
    block: {
      width: definition.width,
      height: definition.height,
    },
  };
}

export function sideForPort(port: CircuitPort): BlockPinSide {
  if (port.signal_type === 'power') return 'top';
  if (port.signal_type === 'ground') return 'bottom';
  if (port.direction === 'output') return 'right';
  if (port.direction === 'input') return 'left';
  return 'left';
}

export function portsToSymbolGeometry(ports: CircuitPort[]): {
  pins: CircuitPin[];
  block: { width: number; height: number };
} {
  const bySide: Record<BlockPinSide, CircuitPort[]> = {
    left: [],
    right: [],
    top: [],
    bottom: [],
  };
  for (const port of ports) {
    bySide[sideForPort(port)].push(port);
  }
  (Object.keys(bySide) as BlockPinSide[]).forEach((side) => {
    bySide[side].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  });
  const pins: CircuitPin[] = [];
  (['left', 'right', 'top', 'bottom'] as BlockPinSide[]).forEach((side) => {
    bySide[side].forEach((port, index) => {
      pins.push({
        id: port.id,
        name: port.name || port.id,
        net: port.net || `n_${port.id}`,
        net_id: port.net_id,
        side,
        order: index,
      });
    });
  });
  const maxVertical = Math.max(bySide.left.length, bySide.right.length, 1);
  const maxHorizontal = Math.max(bySide.top.length, bySide.bottom.length, 1);
  return {
    pins,
    block: {
      width: Math.max(80, 40 + maxHorizontal * 24),
      height: Math.max(80, 40 + maxVertical * 24),
    },
  };
}

export function makePlacedModuleInstance(
  module: CircuitModule,
  position: CircuitPosition,
  child: Pick<CircuitModule, 'module_id' | 'name' | 'revision' | 'ports' | 'parameter_defs'>,
  parameters?: Record<string, string>,
): CircuitComponent {
  const existingIds = new Set(module.components.map((component) => component.id));
  const id = makeId('mod', existingIds);
  const numericId = id.replace(/^[a-z_-]+/i, '') || String(module.components.length + 1);
  const geometry = portsToSymbolGeometry(child.ports || []);
  const defaults = Object.fromEntries(
    (child.parameter_defs || [])
      .filter((item) => item.id)
      .map((item) => [item.id, item.default]),
  );
  return {
    id,
    type: 'MODULE',
    name: `X${child.name?.replace(/[^A-Za-z0-9_]+/g, '') || numericId}`,
    value: child.module_id,
    position,
    rotation: 0,
    pins: geometry.pins.map((pin, index) => ({
      ...pin,
      net: pin.net || `n_${id}_${index + 1}`,
    })),
    block: geometry.block,
    stable_id: `component-${id}`,
    module_ref: {
      module_id: child.module_id,
      revision: child.revision,
    },
    parameters: { ...defaults, ...(parameters || {}) },
  };
}

export function isBlockLike(component: CircuitComponent): boolean {
  return component.type === 'BLOCK' || component.type === 'MODULE';
}

function autoLayoutModule(module: CircuitModule): CircuitModule {
  if (module.components.length === 0) return module;
  const activeComponents = module.components.filter((component) => component.type === 'M' || component.type === 'Q');
  if (activeComponents.length > 0 && isBjtResetLikeModule(module, activeComponents)) return autoLayoutBjtResetModule(module, activeComponents);
  if (activeComponents.length > 0 && isLdoLikeModule(module, activeComponents)) return autoLayoutLdoModule(module, activeComponents);
  const differentialPairLayout = findDifferentialPairLayout(module, activeComponents);
  if (differentialPairLayout) return autoLayoutDifferentialPairModule(module, differentialPairLayout);
  const cmosRingLayout = findCmosRingLayout(module, activeComponents);
  if (cmosRingLayout) return autoLayoutCmosRingModule(module, cmosRingLayout);
  const cmosInverterLayout = findCmosInverterLayout(module, activeComponents);
  if (cmosInverterLayout) return autoLayoutCmosInverterModule(module, cmosInverterLayout);
  const currentMirrorLayout = findCurrentMirrorLayout(module, activeComponents);
  if (currentMirrorLayout) return autoLayoutCurrentMirrorModule(module, currentMirrorLayout);
  const buckConverterLayout = findBuckConverterLayout(module, activeComponents);
  if (buckConverterLayout) return autoLayoutBuckConverterModule(module, buckConverterLayout);
  const cascodeLayout = findCascodeLayout(module, activeComponents);
  if (cascodeLayout) return autoLayoutCascodeModule(module, cascodeLayout);
  const opampFeedbackLayout = findOpampFeedbackLayout(module);
  if (opampFeedbackLayout) return autoLayoutOpampFeedbackModule(module, opampFeedbackLayout);
  const halfBridgeLegsLayout = findHalfBridgeLegsLayout(module, activeComponents);
  if (halfBridgeLegsLayout) return autoLayoutHalfBridgeLegsModule(module, halfBridgeLegsLayout);
  if (activeComponents.length === 1 && isSingleTransistorStageLikeModule(activeComponents[0])) {
    return autoLayoutSingleTransistorStageModule(module, activeComponents[0]);
  }
  if (activeComponents.length > 0) return autoLayoutActiveModule(module, activeComponents);
  return autoLayoutPassiveModule(module);
}

function autoLayoutPassiveModule(module: CircuitModule): CircuitModule {
  if (isVoltageDividerLikeModule(module)) return autoLayoutVoltageDividerModule(module);
  const inputNet = preferredPortNet(module, 'input');
  const outputNet = preferredPortNet(module, 'output');
  const path = inputNet && outputNet ? findSeriesPath(module, inputNet, outputNet) : [];
  if (path.length === 0) return autoLayoutGenericModule(module);

  const pathComponents = new Set(path.map((entry) => entry.component.id));
  const nodeX = new Map<string, number>();
  const yMain = 180;
  const xStart = 210;
  const spacing = 280;

  path.forEach((entry, index) => {
    const center = { x: xStart + index * spacing, y: yMain };
    placeHorizontal(entry.component, entry.leftNet, entry.rightNet, center);
    rememberPinX(nodeX, entry.component);
  });

  const lowerCounts = new Map<string, number>();
  const upperCounts = new Map<string, number>();
  const floating: CircuitComponent[] = [];

  for (const component of module.components) {
    if (pathComponents.has(component.id)) continue;
    if (component.pins.length !== 2) {
      floating.push(component);
      continue;
    }
    const [first, second] = component.pins;
    if (!first || !second) continue;
    const firstSignal = nodeX.has(first.net) && !isRailNet(first.net, module);
    const secondSignal = nodeX.has(second.net) && !isRailNet(second.net, module);
    const firstRail = isRailNet(first.net, module);
    const secondRail = isRailNet(second.net, module);
    if (firstSignal && secondRail) {
      placeRailBranch(component, first.net, second.net, nodeX, lowerCounts, upperCounts, yMain, module);
      continue;
    }
    if (secondSignal && firstRail) {
      placeRailBranch(component, second.net, first.net, nodeX, lowerCounts, upperCounts, yMain, module);
      continue;
    }
    floating.push(component);
  }

  floating.forEach((component, index) => {
    component.position = snapPoint({ x: xStart + path.length * spacing + 120, y: yMain + index * 120 });
    component.rotation = normalizeRotation(component.rotation);
  });
  return module;
}

interface VoltageDividerLayout {
  top: CircuitComponent;
  bottom: CircuitComponent;
  powerNet: string;
  outputNet: string;
  groundNet: string;
}

interface CmosInverterLayout {
  pmos: CircuitComponent;
  nmos: CircuitComponent;
  inputNet: string;
  outputNet: string;
  powerNet: string;
  groundNet: string;
}

interface CmosRingStage {
  pmos: CircuitComponent;
  nmos: CircuitComponent;
  inputNet: string;
  outputNet: string;
}

interface CmosRingLayout {
  stages: CmosRingStage[];
  powerNet: string;
  groundNet: string;
}

interface DifferentialPairLayout {
  left: CircuitComponent;
  right: CircuitComponent;
  leftInputNet: string;
  rightInputNet: string;
  leftOutputNet: string;
  rightOutputNet: string;
  tailNet: string;
  powerNet: string;
  groundNet: string;
}

interface CurrentMirrorLayout {
  reference: CircuitComponent;
  output: CircuitComponent;
  gateNet: string;
  outputNet: string;
  commonSourceNet: string;
  powerNet: string;
  groundNet: string;
  pmos: boolean;
}

interface BuckConverterLayout {
  switchDevice: CircuitComponent;
  inductor: CircuitComponent;
  diode: CircuitComponent;
  outputCapacitor?: CircuitComponent;
  outputLoad?: CircuitComponent;
  inputSource?: CircuitComponent;
  gateSource?: CircuitComponent;
  inputNet: string;
  outputNet: string;
  switchNet: string;
  gateNet?: string;
  groundNet: string;
}

interface OpampFeedbackLayout {
  amplifier: CircuitComponent;
  outputNet: string;
  outputRefNet: string;
  nonInvertingNet: string;
  invertingNet: string;
  groundNet: string;
  powerNet?: string;
}

interface CascodeLayout {
  lower: CircuitComponent;
  upper: CircuitComponent;
  inputNet: string;
  biasNet: string;
  sourceNet: string;
  stackNet: string;
  outputDrainNet: string;
  outputNet?: string;
  powerNet: string;
  groundNet: string;
}

function isVoltageDividerLikeModule(module: CircuitModule): boolean {
  return Boolean(findVoltageDividerLayout(module));
}

function autoLayoutVoltageDividerModule(module: CircuitModule): CircuitModule {
  const layout = findVoltageDividerLayout(module);
  if (!layout) return module;

  const placed = new Set<string>();
  const xMain = 280;
  placeVertical(layout.top, layout.powerNet, layout.outputNet, { x: xMain, y: 150 });
  placed.add(layout.top.id);
  placeVertical(layout.bottom, layout.outputNet, layout.groundNet, { x: xMain, y: 330 });
  placed.add(layout.bottom.id);

  let shuntIndex = 0;
  let floatingIndex = 0;
  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    const [first, second] = component.pins;
    if (first && second && component.pins.length === 2) {
      const nets = new Set([first.net, second.net]);
      if (nets.has(layout.outputNet) && (nets.has(layout.groundNet) || nets.has(layout.powerNet))) {
        const railNet = nets.has(layout.groundNet) ? layout.groundNet : layout.powerNet;
        const topNet = railNet === layout.groundNet ? layout.outputNet : railNet;
        const bottomNet = railNet === layout.groundNet ? railNet : layout.outputNet;
        placeVertical(component, topNet, bottomNet, {
          x: xMain + 130 + shuntIndex * 110,
          y: railNet === layout.groundNet ? 330 : 150,
        });
        shuntIndex += 1;
        placed.add(component.id);
        continue;
      }
    }
    component.position = snapPoint({ x: xMain + 160 + (floatingIndex % 2) * 130, y: 150 + Math.floor(floatingIndex / 2) * 130 });
    component.rotation = normalizeRotation(component.rotation);
    floatingIndex += 1;
    placed.add(component.id);
  }
  return module;
}

function findCmosRingLayout(module: CircuitModule, activeComponents: CircuitComponent[]): CmosRingLayout | null {
  const mosComponents = activeComponents.filter((component) => component.type === 'M');
  if (mosComponents.length < 6 || mosComponents.length % 2 !== 0) return null;
  const powerNet = module.ports.find((port) => port.signal_type === 'power' && !isGroundPort(port))?.net;
  const groundNet = module.ports.find(isGroundPort)?.net ?? '0';
  if (!powerNet) return null;

  const pmosComponents = mosComponents.filter(isPmosComponent);
  const nmosComponents = mosComponents.filter((component) => !isPmosComponent(component));
  if (pmosComponents.length !== nmosComponents.length) return null;

  const usedNmos = new Set<string>();
  const stages: CmosRingStage[] = [];
  for (const pmos of [...pmosComponents].sort((left, right) => left.id.localeCompare(right.id))) {
    const pmosNets = activeNetMap(pmos);
    if (!pmosNets.gate || !pmosNets.drain || pmosNets.source !== powerNet) return null;
    const nmos = nmosComponents.find((candidate) => {
      if (usedNmos.has(candidate.id)) return false;
      const nets = activeNetMap(candidate);
      return nets.gate === pmosNets.gate && nets.drain === pmosNets.drain && nets.source === groundNet;
    });
    if (!nmos) return null;
    usedNmos.add(nmos.id);
    stages.push({
      pmos,
      nmos,
      inputNet: pmosNets.gate,
      outputNet: pmosNets.drain,
    });
  }
  if (stages.length < 3 || stages.length * 2 !== mosComponents.length) return null;

  const preferredOutputNet = preferredPortNet(module, 'output');
  const first = stages.find((stage) => stage.inputNet === preferredOutputNet) ??
    [...stages].sort((left, right) => left.outputNet.localeCompare(right.outputNet))[0];
  if (!first) return null;

  const ordered: CmosRingStage[] = [];
  const visited = new Set<string>();
  let current: CmosRingStage | undefined = first;
  while (current && !visited.has(current.outputNet)) {
    ordered.push(current);
    visited.add(current.outputNet);
    current = stages.find((stage) => stage.inputNet === current?.outputNet);
  }
  if (ordered.length !== stages.length || ordered.at(-1)?.outputNet !== first.inputNet) return null;
  return { stages: ordered, powerNet, groundNet };
}

function findCmosInverterLayout(module: CircuitModule, activeComponents: CircuitComponent[]): CmosInverterLayout | null {
  const mosComponents = activeComponents.filter((component) => component.type === 'M');
  const pmosComponents = mosComponents.filter(isPmosComponent);
  const nmosComponents = mosComponents.filter((component) => !isPmosComponent(component));
  if (pmosComponents.length === 0 || nmosComponents.length === 0) return null;

  const preferredOutputNet = preferredPortNet(module, 'output');
  const powerNets = module.ports
    .filter((port) => port.signal_type === 'power' && !isGroundPort(port))
    .map((port) => port.net);

  for (const pmos of pmosComponents) {
    const pmosNets = activeNetMap(pmos);
    for (const nmos of nmosComponents) {
      const nmosNets = activeNetMap(nmos);
      if (!pmosNets.gate || pmosNets.gate !== nmosNets.gate) continue;
      if (!pmosNets.drain || pmosNets.drain !== nmosNets.drain) continue;
      if (!pmosNets.source || !nmosNets.source) continue;
      if (preferredOutputNet && pmosNets.drain !== preferredOutputNet) continue;
      if (isGroundNet(pmosNets.source, module) || !isGroundNet(nmosNets.source, module)) continue;
      if (powerNets.length > 0 && !powerNets.includes(pmosNets.source)) continue;
      return {
        pmos,
        nmos,
        inputNet: pmosNets.gate,
        outputNet: pmosNets.drain,
        powerNet: pmosNets.source,
        groundNet: nmosNets.source,
      };
    }
  }
  return null;
}

function findDifferentialPairLayout(module: CircuitModule, activeComponents: CircuitComponent[]): DifferentialPairLayout | null {
  const powerNet = module.ports.find((port) => port.signal_type === 'power' && !isGroundPort(port))?.net ?? 'vdd';
  const groundNet = module.ports.find(isGroundPort)?.net ?? '0';
  for (let leftIndex = 0; leftIndex < activeComponents.length; leftIndex += 1) {
    const first = activeComponents[leftIndex];
    if (!first || (first.type === 'M' && isPmosComponent(first))) continue;
    const firstNets = activeNetMap(first);
    if (!firstNets.gate || !firstNets.drain || !firstNets.source) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < activeComponents.length; rightIndex += 1) {
      const second = activeComponents[rightIndex];
      if (!second || second.type !== first.type || (second.type === 'M' && isPmosComponent(second))) continue;
      const secondNets = activeNetMap(second);
      if (!secondNets.gate || !secondNets.drain || !secondNets.source) continue;
      if (firstNets.source !== secondNets.source) continue;
      if (firstNets.gate === secondNets.gate || firstNets.drain === secondNets.drain) continue;
      if (isRailNet(firstNets.source, module)) continue;

      const [left, right] = orderDifferentialPairDevices(module, first, second);
      const leftNets = activeNetMap(left);
      const rightNets = activeNetMap(right);
      if (!leftNets.gate || !rightNets.gate || !leftNets.drain || !rightNets.drain || !leftNets.source) continue;
      return {
        left,
        right,
        leftInputNet: leftNets.gate,
        rightInputNet: rightNets.gate,
        leftOutputNet: leftNets.drain,
        rightOutputNet: rightNets.drain,
        tailNet: leftNets.source,
        powerNet,
        groundNet,
      };
    }
  }
  return null;
}

function orderDifferentialPairDevices(
  module: CircuitModule,
  first: CircuitComponent,
  second: CircuitComponent,
): [CircuitComponent, CircuitComponent] {
  const firstGate = activeNetMap(first).gate ?? '';
  const secondGate = activeNetMap(second).gate ?? '';
  const firstRank = differentialInputRank(module, firstGate);
  const secondRank = differentialInputRank(module, secondGate);
  if (firstRank !== secondRank) return firstRank < secondRank ? [first, second] : [second, first];
  return first.id.localeCompare(second.id) <= 0 ? [first, second] : [second, first];
}

function differentialInputRank(module: CircuitModule, net: string): number {
  const portIndex = module.ports.findIndex((port) => port.net === net);
  const port = portIndex >= 0 ? module.ports[portIndex] : undefined;
  const label = `${port?.id ?? ''} ${port?.name ?? ''} ${net}`.toLowerCase();
  if (/inp|vinp|\bin\+|\+|plus|pos|noninv|non-inv/.test(label)) return 0;
  if (/inn|vinn|\bin-|-|minus|neg|inv/.test(label)) return 1;
  return 10 + (portIndex >= 0 ? portIndex : 100);
}

function autoLayoutDifferentialPairModule(module: CircuitModule, layout: DifferentialPairLayout): CircuitModule {
  const placed = new Set<string>();
  const nodeAnchors = new Map<string, CircuitPosition>();
  const activeDrainNets = new Set(
    module.components
      .filter((entry) => entry.type === 'M' || entry.type === 'Q')
      .map((entry) => activeNetMap(entry).drain)
      .filter(Boolean) as string[],
  );
  layout.left.position = snapPoint({ x: 320, y: 340 });
  layout.left.rotation = 0;
  placed.add(layout.left.id);
  rememberComponentPinAnchors(nodeAnchors, layout.left);
  layout.right.position = snapPoint({ x: 700, y: 340 });
  layout.right.rotation = 0;
  placed.add(layout.right.id);
  rememberComponentPinAnchors(nodeAnchors, layout.right);
  const pairMidX = snap((layout.left.position.x + layout.right.position.x) / 2);

  const activeLoads = module.components.filter((component) => (
    !placed.has(component.id) &&
    (component.type === 'M' || component.type === 'Q') &&
    (
      componentHasNets(component, layout.powerNet, layout.leftOutputNet) ||
      componentHasNets(component, layout.powerNet, layout.rightOutputNet)
    )
  ));
  for (const component of activeLoads) {
    const nets = activeNetMap(component);
    const outputNet = nets.drain === layout.leftOutputNet ? layout.leftOutputNet : layout.rightOutputNet;
    const anchor = outputNet === layout.leftOutputNet
      ? pinPointForComponentNet(layout.left, layout.leftOutputNet)
      : pinPointForComponentNet(layout.right, layout.rightOutputNet);
    component.position = snapPoint({ x: anchor?.x ?? component.position.x, y: 130 });
    component.rotation = 0;
    placed.add(component.id);
    rememberComponentPinAnchors(nodeAnchors, component);
  }

  const drainLoads = [
    { outputNet: layout.leftOutputNet, pair: layout.left, side: -1 },
    { outputNet: layout.rightOutputNet, pair: layout.right, side: 1 },
  ];
  for (const { outputNet, pair } of drainLoads) {
    const load = findTwoPinWithNets(module.components, placed, /r(d|c)|load|collector|drain/i, layout.powerNet, outputNet);
    const anchor = pinPointForComponentNet(pair, outputNet);
    if (load && anchor) {
      placeVertical(load, layout.powerNet, outputNet, { x: anchor.x, y: 165 });
      placed.add(load.id);
      rememberComponentPinAnchors(nodeAnchors, load);
    }
  }

  const tail = findTwoPinWithNets(module.components, placed, /tail|bias|i(ref)?|source/i, layout.tailNet, layout.groundNet);
  if (tail) {
    placeVertical(tail, layout.tailNet, layout.groundNet, { x: pairMidX, y: 525 });
    placed.add(tail.id);
    rememberComponentPinAnchors(nodeAnchors, tail);
  }

  let auxiliaryActiveIndex = 0;
  for (const component of module.components.filter((entry) => entry.type === 'M' || entry.type === 'Q')) {
    if (placed.has(component.id)) continue;
    component.position = snapPoint({
      x: layout.right.position.x + 520 + auxiliaryActiveIndex * 220,
      y: layout.right.position.y,
    });
    component.rotation = 0;
    placed.add(component.id);
    rememberComponentPinAnchors(nodeAnchors, component);
    auxiliaryActiveIndex += 1;
  }

  let fallbackIndex = 0;
  const inputSeriesCounts = new Map<string, number>();
  const inputRailCounts = new Map<string, number>();
  const continuationCounts = new Map<string, number>();
  const railBranchCounts = new Map<string, number>();
  let railOnlyIndex = 0;
  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    const [first, second] = component.pins;
    if (first && second && component.pins.length === 2) {
      const nets = new Set([first.net, second.net]);
      const leftOutputBranch = nets.has(layout.leftOutputNet) && nets.has(layout.groundNet);
      const rightOutputBranch = nets.has(layout.rightOutputNet) && nets.has(layout.groundNet);
      if (leftOutputBranch || rightOutputBranch) {
        const outputNet = leftOutputBranch ? layout.leftOutputNet : layout.rightOutputNet;
        const x = leftOutputBranch ? 220 : 760;
        const preservedAnchor = nodeAnchors.get(outputNet);
        placeVertical(component, outputNet, layout.groundNet, { x, y: 470 + fallbackIndex * 12 });
        rememberComponentPinAnchors(nodeAnchors, component);
        if (preservedAnchor) nodeAnchors.set(outputNet, preservedAnchor);
        placed.add(component.id);
        fallbackIndex += 1;
        continue;
      }
      if (nets.has(layout.leftInputNet) || nets.has(layout.rightInputNet)) {
        const inputNet = nets.has(layout.leftInputNet) ? layout.leftInputNet : layout.rightInputNet;
        const otherNet = first.net === inputNet ? second.net : first.net;
        const pair = inputNet === layout.leftInputNet ? layout.left : layout.right;
        const inputAnchor = pinPointForComponentNet(pair, inputNet) ?? {
          x: pair.position.x - 58,
          y: pair.position.y,
        };
        if (isRailNet(otherNet, module)) {
          const index = inputRailCounts.get(inputNet) ?? 0;
          inputRailCounts.set(inputNet, index + 1);
          const topNet = isGroundNet(otherNet, module) ? inputNet : otherNet;
          const bottomNet = isGroundNet(otherNet, module) ? otherNet : inputNet;
          const preservedAnchor = nodeAnchors.get(inputNet);
          placeVertical(component, topNet, bottomNet, {
            x: inputAnchor.x - 110 - index * 110,
            y: inputAnchor.y + (isGroundNet(otherNet, module) ? 135 : -135),
          });
          rememberComponentPinAnchors(nodeAnchors, component);
          if (preservedAnchor) nodeAnchors.set(inputNet, preservedAnchor);
        } else {
          const index = inputSeriesCounts.get(inputNet) ?? 0;
          inputSeriesCounts.set(inputNet, index + 1);
          placeHorizontal(component, otherNet, inputNet, {
            x: inputAnchor.x - 120 - index * 120,
            y: inputAnchor.y + index * 80,
          });
          rememberComponentPinAnchors(nodeAnchors, component);
        }
        placed.add(component.id);
        fallbackIndex += 1;
        continue;
      }

      const firstRail = isRailNet(first.net, module);
      const secondRail = isRailNet(second.net, module);
      if (firstRail && secondRail) {
        const topNet = isGroundNet(first.net, module) ? second.net : first.net;
        const bottomNet = topNet === first.net ? second.net : first.net;
        placeVertical(component, topNet, bottomNet, {
          x: 120 + railOnlyIndex * 125,
          y: isGroundNet(bottomNet, module) ? 165 : 120,
        });
        placed.add(component.id);
        railOnlyIndex += 1;
        fallbackIndex += 1;
        continue;
      }
      const signalNet = firstRail ? second.net : secondRail ? first.net : '';
      const railNet = firstRail ? first.net : secondRail ? second.net : '';
      const signalAnchor = signalNet ? nodeAnchors.get(signalNet) : undefined;
      if (railNet && signalAnchor) {
        const index = railBranchCounts.get(signalNet) ?? 0;
        railBranchCounts.set(signalNet, index + 1);
        const topNet = isGroundNet(railNet, module) ? signalNet : railNet;
        const bottomNet = isGroundNet(railNet, module) ? railNet : signalNet;
        placeVertical(component, topNet, bottomNet, {
          x: signalAnchor.x + index * 110,
          y: signalAnchor.y + (isGroundNet(railNet, module) ? 135 : -135),
        });
        rememberComponentPinAnchors(nodeAnchors, component);
        nodeAnchors.set(signalNet, signalAnchor);
        placed.add(component.id);
        fallbackIndex += 1;
        continue;
      }

      const firstAnchor = firstRail ? undefined : nodeAnchors.get(first.net);
      const secondAnchor = secondRail ? undefined : nodeAnchors.get(second.net);
      const anchorNet = firstAnchor ? first.net : secondAnchor ? second.net : '';
      const anchor = firstAnchor ?? secondAnchor;
      if (anchorNet && anchor) {
        const otherNet = anchorNet === first.net ? second.net : first.net;
        const otherAnchor = anchorNet === first.net ? secondAnchor : firstAnchor;
        const index = continuationCounts.get(anchorNet) ?? 0;
        continuationCounts.set(anchorNet, index + 1);
        const bridgesActiveDrains = Boolean(
          firstAnchor &&
          secondAnchor &&
          activeDrainNets.has(first.net) &&
          activeDrainNets.has(second.net),
        );
        const center = otherAnchor
          ? {
              x: snap((anchor.x + otherAnchor.x) / 2),
              y: bridgesActiveDrains
                ? snap(Math.min(anchor.y, otherAnchor.y) - 95)
                : snap((anchor.y + otherAnchor.y) / 2),
            }
          : { x: anchor.x + 135 + index * 150, y: anchor.y + index * 80 };
        placeHorizontal(component, anchorNet, otherNet, center);
        rememberComponentPinAnchors(nodeAnchors, component);
        if (bridgesActiveDrains) {
          if (firstAnchor) nodeAnchors.set(first.net, firstAnchor);
          if (secondAnchor) nodeAnchors.set(second.net, secondAnchor);
        }
        placed.add(component.id);
        fallbackIndex += 1;
        continue;
      }
    }
    component.position = snapPoint({
      x: 850 + (fallbackIndex % 3) * 150,
      y: 170 + Math.floor(fallbackIndex / 3) * 200,
    });
    component.rotation = normalizeRotation(component.rotation);
    placed.add(component.id);
    fallbackIndex += 1;
  }
  return module;
}

function findCurrentMirrorLayout(module: CircuitModule, activeComponents: CircuitComponent[]): CurrentMirrorLayout | null {
  const mosComponents = activeComponents.filter((component) => component.type === 'M');
  if (mosComponents.length < 2) return null;
  const preferredOutputNet = preferredPortNet(module, 'output');
  const powerNet = module.ports.find((port) => port.signal_type === 'power' && !isGroundPort(port))?.net ?? 'vdd';
  const groundNet = module.ports.find(isGroundPort)?.net ?? '0';

  for (let leftIndex = 0; leftIndex < mosComponents.length; leftIndex += 1) {
    const left = mosComponents[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < mosComponents.length; rightIndex += 1) {
      const right = mosComponents[rightIndex];
      if (!right || isPmosComponent(left) !== isPmosComponent(right)) continue;
      const layout = currentMirrorLayoutForPair(module, left, right, preferredOutputNet, powerNet, groundNet);
      if (layout) return layout;
    }
  }
  return null;
}

function currentMirrorLayoutForPair(
  module: CircuitModule,
  first: CircuitComponent,
  second: CircuitComponent,
  preferredOutputNet: string | null,
  powerNet: string,
  groundNet: string,
): CurrentMirrorLayout | null {
  const firstNets = activeNetMap(first);
  const secondNets = activeNetMap(second);
  if (!firstNets.gate || !firstNets.drain || !firstNets.source) return null;
  if (!secondNets.gate || !secondNets.drain || !secondNets.source) return null;
  if (firstNets.gate !== secondNets.gate) return null;
  if (firstNets.source !== secondNets.source) return null;
  if (firstNets.drain === secondNets.drain) return null;
  if (!isRailNet(firstNets.source, module)) return null;

  const firstDiodeConnected = firstNets.drain === firstNets.gate;
  const secondDiodeConnected = secondNets.drain === secondNets.gate;
  let reference = first;
  let output = second;
  let outputNet = secondNets.drain;

  if (firstDiodeConnected && !secondDiodeConnected) {
    reference = first;
    output = second;
    outputNet = secondNets.drain;
  } else if (secondDiodeConnected && !firstDiodeConnected) {
    reference = second;
    output = first;
    outputNet = firstNets.drain;
  } else if (preferredOutputNet && firstNets.drain === preferredOutputNet && secondDiodeConnected) {
    reference = second;
    output = first;
    outputNet = firstNets.drain;
  } else if (preferredOutputNet && secondNets.drain === preferredOutputNet && firstDiodeConnected) {
    reference = first;
    output = second;
    outputNet = secondNets.drain;
  } else {
    return null;
  }

  if (preferredOutputNet && outputNet !== preferredOutputNet) return null;
  return {
    reference,
    output,
    gateNet: firstNets.gate,
    outputNet,
    commonSourceNet: firstNets.source,
    powerNet,
    groundNet,
    pmos: isPmosComponent(reference),
  };
}

function autoLayoutCurrentMirrorModule(module: CircuitModule, layout: CurrentMirrorLayout): CircuitModule {
  const placed = new Set<string>();
  const mirrorY = layout.pmos ? 220 : 300;

  layout.reference.position = snapPoint({ x: 320, y: mirrorY });
  layout.reference.rotation = 0;
  placed.add(layout.reference.id);

  layout.output.position = snapPoint({ x: 560, y: mirrorY });
  layout.output.rotation = 0;
  placed.add(layout.output.id);

  const referenceDrain = pinPointForComponentNet(layout.reference, layout.gateNet);
  const outputDrain = pinPointForComponentNet(layout.output, layout.outputNet);
  const feedRailNet = layout.pmos ? layout.groundNet : layout.powerNet;
  const loadRailNet = layout.pmos ? layout.groundNet : layout.powerNet;
  const twoPinComponents = module.components.filter((component) => component.pins.length === 2);

  const referenceFeed = findTwoPinWithNets(
    twoPinComponents,
    placed,
    /i(ref)?|bias|ref|source|r(ref)?/i,
    feedRailNet,
    layout.gateNet,
  );
  if (referenceFeed && referenceDrain) {
    if (layout.pmos) {
      placeVertical(referenceFeed, layout.gateNet, layout.groundNet, {
        x: referenceDrain.x,
        y: referenceDrain.y + 90,
      });
    } else {
      placeVertical(referenceFeed, layout.powerNet, layout.gateNet, {
        x: referenceDrain.x,
        y: referenceDrain.y - 90,
      });
    }
    placed.add(referenceFeed.id);
  }

  const outputLoad = findTwoPinWithNets(
    twoPinComponents,
    placed,
    /r(load|out)|load|i(load|out)?/i,
    layout.outputNet,
    loadRailNet,
  );
  if (outputLoad && outputDrain) {
    if (layout.pmos) {
      placeVertical(outputLoad, layout.outputNet, layout.groundNet, {
        x: outputDrain.x,
        y: outputDrain.y + 90,
      });
    } else {
      placeVertical(outputLoad, layout.powerNet, layout.outputNet, {
        x: outputDrain.x,
        y: outputDrain.y - 90,
      });
    }
    placed.add(outputLoad.id);
  }

  let outputBranchIndex = 0;
  let gateBranchIndex = 0;
  let sourceBranchIndex = 0;
  let fallbackIndex = 0;
  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    const [first, second] = component.pins;
    if (first && second && component.pins.length === 2) {
      const nets = new Set([first.net, second.net]);
      if (nets.has(layout.outputNet) && (nets.has(layout.powerNet) || nets.has(layout.groundNet))) {
        const railNet = nets.has(layout.powerNet) ? layout.powerNet : layout.groundNet;
        const topNet = railNet === layout.groundNet ? layout.outputNet : railNet;
        const bottomNet = railNet === layout.groundNet ? railNet : layout.outputNet;
        placeVertical(component, topNet, bottomNet, {
          x: (outputDrain?.x ?? layout.output.position.x + 26) + 120 + outputBranchIndex * 120,
          y: (outputDrain?.y ?? mirrorY) + (railNet === layout.groundNet ? 95 : -95),
        });
        placed.add(component.id);
        outputBranchIndex += 1;
        continue;
      }
      if (nets.has(layout.gateNet) && (nets.has(layout.powerNet) || nets.has(layout.groundNet))) {
        const railNet = nets.has(layout.powerNet) ? layout.powerNet : layout.groundNet;
        const topNet = railNet === layout.groundNet ? layout.gateNet : railNet;
        const bottomNet = railNet === layout.groundNet ? railNet : layout.gateNet;
        placeVertical(component, topNet, bottomNet, {
          x: (referenceDrain?.x ?? layout.reference.position.x + 26) - 110 - gateBranchIndex * 110,
          y: (referenceDrain?.y ?? mirrorY) + (railNet === layout.groundNet ? 95 : -95),
        });
        placed.add(component.id);
        gateBranchIndex += 1;
        continue;
      }
      if (nets.has(layout.commonSourceNet) && (nets.has(layout.powerNet) || nets.has(layout.groundNet))) {
        const railNet = nets.has(layout.powerNet) ? layout.powerNet : layout.groundNet;
        const topNet = railNet === layout.groundNet ? layout.commonSourceNet : railNet;
        const bottomNet = railNet === layout.groundNet ? railNet : layout.commonSourceNet;
        placeVertical(component, topNet, bottomNet, {
          x: layout.reference.position.x + 120 + sourceBranchIndex * 120,
          y: mirrorY + (railNet === layout.groundNet ? 150 : -150),
        });
        placed.add(component.id);
        sourceBranchIndex += 1;
        continue;
      }
    }
    component.position = snapPoint({
      x: 760 + (fallbackIndex % 3) * 150,
      y: 170 + Math.floor(fallbackIndex / 3) * 200,
    });
    component.rotation = normalizeRotation(component.rotation);
    placed.add(component.id);
    fallbackIndex += 1;
  }
  return module;
}

function findBuckConverterLayout(module: CircuitModule, activeComponents: CircuitComponent[]): BuckConverterLayout | null {
  const outputNet = preferredPortNet(module, 'output');
  const groundNet = module.ports.find(isGroundPort)?.net ?? '0';
  const inputNet = module.ports.find((port) => (
    port.direction === 'input' &&
    !isGroundPort(port)
  ))?.net ?? module.ports.find((port) => port.signal_type === 'power' && !isGroundPort(port))?.net;
  if (!inputNet || !outputNet) return null;

  const twoPinComponents = module.components.filter((component) => component.pins.length === 2);
  for (const switchDevice of activeComponents.filter((component) => component.type === 'M')) {
    const nets = activeNetMap(switchDevice);
    if (!nets.gate || !nets.drain || !nets.source) continue;
    const gateNet = nets.gate;
    const switchNet = nets.source === inputNet ? nets.drain : nets.drain === inputNet ? nets.source : null;
    if (!switchNet || switchNet === outputNet || isRailNet(switchNet, module)) continue;

    const inductor = twoPinComponents.find((component) => (
      component.type === 'L' && componentHasNets(component, switchNet, outputNet)
    ));
    const diode = twoPinComponents.find((component) => (
      component.type === 'D' && componentHasNets(component, switchNet, groundNet)
    ));
    if (!inductor || !diode) continue;

    return {
      switchDevice,
      inductor,
      diode,
      outputCapacitor: twoPinComponents.find((component) => (
        component.type === 'C' && componentHasNets(component, outputNet, groundNet)
      )),
      outputLoad: twoPinComponents.find((component) => (
        component.type === 'R' && componentHasNets(component, outputNet, groundNet)
      )),
      inputSource: twoPinComponents.find((component) => (
        component.type === 'V' && componentHasNets(component, inputNet, groundNet)
      )),
      gateSource: twoPinComponents.find((component) => (
        component.type === 'V' && componentHasNets(component, gateNet, groundNet)
      )),
      inputNet,
      outputNet,
      switchNet,
      gateNet,
      groundNet,
    };
  }
  return null;
}

function autoLayoutBuckConverterModule(module: CircuitModule, layout: BuckConverterLayout): CircuitModule {
  const placed = new Set<string>();
  const busY = 280;

  layout.switchDevice.position = snapPoint({ x: 320, y: 228 });
  layout.switchDevice.rotation = 0;
  placed.add(layout.switchDevice.id);
  const switchPin = pinPointForComponentNet(layout.switchDevice, layout.switchNet) ?? { x: 346, y: busY };

  placeHorizontal(layout.inductor, layout.switchNet, layout.outputNet, {
    x: switchPin.x + 175,
    y: switchPin.y,
  });
  placed.add(layout.inductor.id);

  placeVertical(layout.diode, layout.switchNet, layout.groundNet, {
    x: switchPin.x,
    y: switchPin.y + 62,
  });
  placed.add(layout.diode.id);

  const inductorOutput = pinPointForComponentNet(layout.inductor, layout.outputNet) ?? {
    x: switchPin.x + 230,
    y: switchPin.y,
  };
  if (layout.outputCapacitor) {
    placeVertical(layout.outputCapacitor, layout.outputNet, layout.groundNet, {
      x: inductorOutput.x + 115,
      y: inductorOutput.y + 62,
    });
    placed.add(layout.outputCapacitor.id);
  }
  if (layout.outputLoad) {
    placeVertical(layout.outputLoad, layout.outputNet, layout.groundNet, {
      x: inductorOutput.x + 255,
      y: inductorOutput.y + 62,
    });
    placed.add(layout.outputLoad.id);
  }

  const gatePin = layout.gateNet ? pinPointForComponentNet(layout.switchDevice, layout.gateNet) : null;
  if (layout.gateSource && layout.gateNet) {
    placeVertical(layout.gateSource, layout.gateNet, layout.groundNet, {
      x: (gatePin?.x ?? layout.switchDevice.position.x - 58) - 120,
      y: gatePin?.y ?? layout.switchDevice.position.y,
    });
    placed.add(layout.gateSource.id);
  }
  if (layout.inputSource) {
    placeVertical(layout.inputSource, layout.inputNet, layout.groundNet, {
      x: layout.switchDevice.position.x - 150,
      y: switchPin.y + 190,
    });
    placed.add(layout.inputSource.id);
  }

  let outputShuntIndex = 0;
  let fallbackIndex = 0;
  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    const [first, second] = component.pins;
    if (first && second && component.pins.length === 2) {
      if (componentHasNets(component, layout.outputNet, layout.groundNet)) {
        placeVertical(component, layout.outputNet, layout.groundNet, {
          x: inductorOutput.x + 390 + outputShuntIndex * 135,
          y: inductorOutput.y + 62,
        });
        outputShuntIndex += 1;
        placed.add(component.id);
        continue;
      }
      if (layout.gateNet && componentHasNets(component, layout.gateNet, layout.groundNet)) {
        placeVertical(component, layout.gateNet, layout.groundNet, {
          x: (gatePin?.x ?? layout.switchDevice.position.x - 58) - 250 - fallbackIndex * 100,
          y: gatePin?.y ?? layout.switchDevice.position.y,
        });
        placed.add(component.id);
        fallbackIndex += 1;
        continue;
      }
    }
    component.position = snapPoint({
      x: inductorOutput.x + 390 + (fallbackIndex % 3) * 145,
      y: inductorOutput.y + 190 + Math.floor(fallbackIndex / 3) * 125,
    });
    component.rotation = normalizeRotation(component.rotation);
    placed.add(component.id);
    fallbackIndex += 1;
  }
  return module;
}

interface HalfBridgeLeg {
  highSide: CircuitComponent;
  lowSide: CircuitComponent;
  switchNet: string;
  topNet: string;
  bottomNet: string;
}

interface HalfBridgeLegsLayout {
  legs: HalfBridgeLeg[];
}

/**
 * Detect half-bridge legs: two active devices stacked on a shared switch node
 * (one device's source/drain tied to the other's drain), e.g. the two legs of a
 * 4-switch buck-boost, full-bridge stages, synchronous bucks, class-D outputs.
 */
function findHalfBridgeLegsLayout(module: CircuitModule, activeComponents: CircuitComponent[]): HalfBridgeLegsLayout | null {
  const candidates = activeComponents.filter((component) => {
    const nets = activeNetMap(component);
    return Boolean(nets.gate && nets.drain && nets.source);
  });
  const consumed = new Set<string>();
  const legs: HalfBridgeLeg[] = [];
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const first = candidates[leftIndex];
    if (!first || consumed.has(first.id)) continue;
    const firstNets = activeNetMap(first);
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const second = candidates[rightIndex];
      if (!second || consumed.has(second.id)) continue;
      const secondNets = activeNetMap(second);
      // Series link: share one conduction-terminal net, but never source-source —
      // a shared source is a differential pair / parallel devices, not a leg.
      let switchNet: string | null = null;
      if (firstNets.source && firstNets.source === secondNets.drain) switchNet = firstNets.source;
      else if (firstNets.drain && firstNets.drain === secondNets.source) switchNet = firstNets.drain;
      else if (firstNets.drain && firstNets.drain === secondNets.drain) switchNet = firstNets.drain;
      if (!switchNet || isRailNet(switchNet, module)) continue;
      const otherNetOf = (nets: { drain?: string; source?: string }): string | undefined => (
        nets.drain === switchNet ? nets.source : nets.drain
      );
      const firstOther = otherNetOf(firstNets);
      const secondOther = otherNetOf(secondNets);
      if (!firstOther || !secondOther || firstOther === secondOther) continue;
      const potentialRank = (net: string): number => (
        isGroundNet(net, module) ? 0 : isRailNet(net, module) ? 2 : 1
      );
      const firstRank = potentialRank(firstOther);
      const secondRank = potentialRank(secondOther);
      if (firstRank === secondRank) continue;
      let highSide = first;
      let lowSide = second;
      let topNet = firstOther;
      let bottomNet = secondOther;
      if (secondRank > firstRank) {
        highSide = second;
        lowSide = first;
        topNet = secondOther;
        bottomNet = firstOther;
      }
      legs.push({ highSide, lowSide, switchNet, topNet, bottomNet });
      consumed.add(highSide.id);
      consumed.add(lowSide.id);
      break;
    }
  }
  if (legs.length === 0) return null;
  return { legs };
}

/** nearestPinPointForNet variant that skips MOS body pins (they are never wired). */
function nearestWirablePinPointForNet(components: CircuitComponent[], net: string): CircuitPosition | null {
  for (const component of components) {
    for (let index = 0; index < component.pins.length; index += 1) {
      const pin = component.pins[index];
      if (!pin || pin.net !== net || isMosBodyPin(component, pin)) continue;
      return pinWorld(component, pin, index);
    }
  }
  return null;
}

function rememberWirablePinAnchors(anchors: Map<string, CircuitPosition>, component: CircuitComponent) {
  component.pins.forEach((pin, index) => {
    if (isMosBodyPin(component, pin)) return;
    anchors.set(pin.net, pinWorld(component, pin, index));
  });
}

/** BFS net distances from the input port through passives and leg channels. */
function halfBridgeFlowRanks(
  module: CircuitModule,
  legs: HalfBridgeLeg[],
  inputNet: string | null,
): Map<string, number> {
  const ranks = new Map<string, number>();
  if (!inputNet) return ranks;
  const adjacency = new Map<string, Set<string>>();
  const link = (left: string, right: string) => {
    if (!left || !right || left === right) return;
    adjacency.set(left, new Set([...(adjacency.get(left) ?? []), right]));
    adjacency.set(right, new Set([...(adjacency.get(right) ?? []), left]));
  };
  for (const component of module.components) {
    if (component.pins.length !== 2) continue;
    const [first, second] = component.pins;
    if (!first || !second) continue;
    if (isRailNet(first.net, module) || isRailNet(second.net, module)) continue;
    link(first.net, second.net);
  }
  for (const leg of legs) {
    link(leg.topNet, leg.switchNet);
    if (!isRailNet(leg.bottomNet, module)) link(leg.switchNet, leg.bottomNet);
  }
  const queue: string[] = [inputNet];
  ranks.set(inputNet, 0);
  while (queue.length > 0) {
    const net = queue.shift();
    if (!net) break;
    const rank = ranks.get(net) ?? 0;
    for (const next of adjacency.get(net) ?? []) {
      if (ranks.has(next)) continue;
      ranks.set(next, rank + 1);
      queue.push(next);
    }
  }
  return ranks;
}

function autoLayoutHalfBridgeLegsModule(module: CircuitModule, layout: HalfBridgeLegsLayout): CircuitModule {
  const placed = new Set<string>();
  const nodeAnchors = new Map<string, CircuitPosition>();
  // Row spacing tuned so the tap-row series part's name (y-42) sits between the
  // high-side value label (y+8) rows and its value (y+44) clears the low-side
  // diode name row (yLow-28).
  const yHigh = 120;
  const yLow = 280;
  // Legs start far enough right that the first leg's outside diode column and the
  // input shunt column both fit on the left.
  const xStart = 380;
  // Wide enough that a truncated MOS value label (x+52, ~150px) never reaches the
  // next leg's gate port flag (placed at gateX-110, body reaching ~70px left of it).
  const legPitch = 440;
  const diodeDx = 230;
  const inputNet = preferredPortNet(module, 'input')
    ?? module.ports.find((port) => port.signal_type === 'power' && !isGroundPort(port))?.net
    ?? null;
  const outputNet = preferredPortNet(module, 'output');
  const flowRank = halfBridgeFlowRanks(module, layout.legs, inputNet);
  const orderedLegs = [...layout.legs].sort((left, right) => (
    (flowRank.get(left.switchNet) ?? 99) - (flowRank.get(right.switchNet) ?? 99)
    || left.highSide.id.localeCompare(right.highSide.id)
  ));
  const legX = new Map<string, number>();
  orderedLegs.forEach((leg, index) => {
    const x = snap(xStart + index * legPitch);
    legX.set(leg.switchNet, x);
    leg.highSide.position = snapPoint({ x, y: yHigh });
    leg.highSide.rotation = 0;
    leg.lowSide.position = snapPoint({ x, y: yLow });
    leg.lowSide.rotation = 0;
    placed.add(leg.highSide.id);
    placed.add(leg.lowSide.id);
    rememberWirablePinAnchors(nodeAnchors, leg.highSide);
    rememberWirablePinAnchors(nodeAnchors, leg.lowSide);
  });

  // Freewheeling / antiparallel diodes sit OUTSIDE their leg — first leg's diodes
  // on its left, every other leg's on its right — so each switch node's fan-out
  // stays in its own x-zone and never crosses the tap-row corridor between legs.
  // The high-side diode rides one notch above the high-side row to keep its
  // switch-node lead tip clear of series passives on the tap row.
  orderedLegs.forEach((leg, legIndex) => {
    const x = legX.get(leg.switchNet);
    if (x === undefined) return;
    const columnX = legIndex === 0 ? x - diodeDx : x + diodeDx;
    for (const component of module.components) {
      if (placed.has(component.id) || component.type !== 'D' || component.pins.length !== 2) continue;
      if (componentHasNets(component, leg.switchNet, leg.topNet)) {
        placeVertical(component, leg.topNet, leg.switchNet, { x: columnX, y: yHigh - 40 });
        placed.add(component.id);
        continue;
      }
      if (componentHasNets(component, leg.switchNet, leg.bottomNet)) {
        placeVertical(component, leg.switchNet, leg.bottomNet, { x: columnX, y: yLow });
        placed.add(component.id);
      }
    }
  });
  for (const component of module.components) {
    if (placed.has(component.id)) rememberWirablePinAnchors(nodeAnchors, component);
  }

  // Series passives bridging two switch nodes (the buck-boost inductor) sit on the
  // switch-rail tap row, centered between the legs; with the diode columns outside
  // the corridor the tap row is free of foreign switch fan-out.
  for (const component of module.components) {
    if (placed.has(component.id) || component.pins.length !== 2) continue;
    const [first, second] = component.pins;
    if (!first || !second) continue;
    if (isRailNet(first.net, module) || isRailNet(second.net, module)) continue;
    const firstX = legX.get(first.net);
    const secondX = legX.get(second.net);
    if (firstX === undefined || secondX === undefined || firstX === secondX) continue;
    let leftX = firstX;
    let rightX = secondX;
    let leftNet = first.net;
    let rightNet = second.net;
    if (leftX > rightX) {
      leftX = secondX;
      rightX = firstX;
      leftNet = second.net;
      rightNet = first.net;
    }
    const centerX = (leftX + rightX) / 2 + 22;
    const clampedX = Math.min(Math.max(centerX, leftX + 120), rightX - 120);
    placeHorizontal(component, leftNet, rightNet, {
      x: clampedX,
      y: (yHigh + yLow) / 2,
    });
    placed.add(component.id);
    rememberWirablePinAnchors(nodeAnchors, component);
  }

  const lastLeg = orderedLegs[orderedLegs.length - 1];
  const lastLegX = (lastLeg ? legX.get(lastLeg.switchNet) : undefined) ?? xStart;
  const lastTopNet = lastLeg?.topNet;
  const inputBranchCounts = new Map<string, number>();
  const outputBranchCounts = new Map<string, number>();
  const midBranchCounts = new Map<string, number>();
  let overflowIndex = 0;
  const placedComponents = (): CircuitComponent[] => module.components.filter((entry) => placed.has(entry.id));
  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    if (component.pins.length !== 2) {
      component.position = snapPoint({ x: lastLegX + 360 + overflowIndex * 160, y: yHigh });
      component.rotation = normalizeRotation(component.rotation);
      placed.add(component.id);
      overflowIndex += 1;
      continue;
    }
    const [first, second] = component.pins;
    if (!first || !second) continue;
    const firstRail = isRailNet(first.net, module);
    const secondRail = isRailNet(second.net, module);
    let railNet = firstRail ? first.net : secondRail ? second.net : '';
    let signalNet = firstRail ? second.net : first.net;
    if (firstRail && secondRail) {
      // Both ends are rails (e.g. a VIN decoupling cap): anchor on the non-ground rail.
      if (isGroundNet(first.net, module)) {
        railNet = first.net;
        signalNet = second.net;
      } else {
        railNet = second.net;
        signalNet = first.net;
      }
    }
    if (railNet) {
      const anchor = nearestWirablePinPointForNet(placedComponents(), signalNet) ?? nodeAnchors.get(signalNet);
      if (isGroundNet(railNet, module)) {
        if (signalNet === inputNet) {
          const index = inputBranchCounts.get(signalNet) ?? 0;
          inputBranchCounts.set(signalNet, index + 1);
          // Between the first leg's outside diode column and the leg itself, far
          // enough left that the low-side gate drop clears the body padding.
          placeVertical(component, signalNet, railNet, { x: xStart - 120 - index * 120, y: yLow });
        } else if (signalNet === outputNet || (lastTopNet && signalNet === lastTopNet)) {
          const index = outputBranchCounts.get(signalNet) ?? 0;
          outputBranchCounts.set(signalNet, index + 1);
          placeVertical(component, signalNet, railNet, { x: lastLegX + 360 + index * 130, y: yLow });
        } else {
          const index = midBranchCounts.get(signalNet) ?? 0;
          midBranchCounts.set(signalNet, index + 1);
          placeVertical(component, signalNet, railNet, {
            x: (anchor?.x ?? lastLegX + 360) + index * 120,
            y: yLow + 150,
          });
        }
      } else {
        // Upper-rail shunt (e.g. VDD decoupling) sits above its signal anchor.
        const index = midBranchCounts.get(signalNet) ?? 0;
        midBranchCounts.set(signalNet, index + 1);
        placeVertical(component, railNet, signalNet, {
          x: (anchor?.x ?? xStart - 150) + index * 120,
          y: yHigh - 140,
        });
      }
      placed.add(component.id);
      rememberWirablePinAnchors(nodeAnchors, component);
      continue;
    }
    // Gate-side passives hang left of their device's gate; anything else overflows right.
    const ownerLeg = orderedLegs.find((leg) => {
      const gateNets = [activeNetMap(leg.highSide).gate, activeNetMap(leg.lowSide).gate];
      return gateNets.includes(first.net) || gateNets.includes(second.net);
    });
    if (ownerLeg) {
      const ownerX = legX.get(ownerLeg.switchNet) ?? xStart;
      const gateNet = [first.net, second.net].find((net) => (
        activeNetMap(ownerLeg.highSide).gate === net || activeNetMap(ownerLeg.lowSide).gate === net
      ));
      const otherNet = first.net === gateNet ? second.net : first.net;
      const gateY = activeNetMap(ownerLeg.highSide).gate === gateNet ? yHigh : yLow;
      placeHorizontal(component, otherNet, gateNet ?? first.net, { x: ownerX - 160, y: gateY });
      placed.add(component.id);
      rememberWirablePinAnchors(nodeAnchors, component);
      continue;
    }
    component.position = snapPoint({ x: lastLegX + 360 + overflowIndex * 160, y: yLow + 150 });
    component.rotation = normalizeRotation(component.rotation);
    placed.add(component.id);
    overflowIndex += 1;
  }
  return module;
}

function findCascodeLayout(module: CircuitModule, activeComponents: CircuitComponent[]): CascodeLayout | null {
  const mosComponents = activeComponents.filter((component) => component.type === 'M');
  if (mosComponents.length < 2) return null;
  const inputNet = preferredPortNet(module, 'input');
  const outputNet = preferredPortNet(module, 'output') ?? undefined;
  const groundNet = module.ports.find(isGroundPort)?.net ?? '0';
  const powerNet = module.ports.find((port) => port.signal_type === 'power' && !isGroundPort(port))?.net ?? 'vdd';

  for (const lower of mosComponents) {
    const lowerNets = activeNetMap(lower);
    if (!lowerNets.gate || !lowerNets.drain || !lowerNets.source) continue;
    if (inputNet && lowerNets.gate !== inputNet) continue;
    for (const upper of mosComponents) {
      if (upper.id === lower.id || isPmosComponent(upper) !== isPmosComponent(lower)) continue;
      const upperNets = activeNetMap(upper);
      if (!upperNets.gate || !upperNets.drain || !upperNets.source) continue;
      if (upperNets.source !== lowerNets.drain) continue;
      if (upperNets.gate === lowerNets.gate) continue;
      if (isRailNet(upperNets.gate, module)) continue;
      if (isRailNet(upperNets.drain, module)) continue;
      const outputDrainNet = upperNets.drain;
      if (outputNet && outputNet !== outputDrainNet) {
        const outputLink = module.components.some((component) => (
          component.pins.length === 2 && componentHasNets(component, outputDrainNet, outputNet)
        ));
        if (!outputLink) continue;
      }
      return {
        lower,
        upper,
        inputNet: lowerNets.gate,
        biasNet: upperNets.gate,
        sourceNet: lowerNets.source,
        stackNet: lowerNets.drain,
        outputDrainNet,
        outputNet,
        powerNet,
        groundNet,
      };
    }
  }
  return null;
}

function autoLayoutCascodeModule(module: CircuitModule, layout: CascodeLayout): CircuitModule {
  const placed = new Set<string>();
  layout.upper.position = snapPoint({ x: 470, y: 180 });
  layout.upper.rotation = 0;
  placed.add(layout.upper.id);
  layout.lower.position = snapPoint({ x: 470, y: 360 });
  layout.lower.rotation = 0;
  placed.add(layout.lower.id);

  const upperDrain = pinPointForComponentNet(layout.upper, layout.outputDrainNet) ?? { x: 496, y: 128 };
  const lowerGate = pinPointForComponentNet(layout.lower, layout.inputNet) ?? { x: 412, y: 360 };
  const upperGate = pinPointForComponentNet(layout.upper, layout.biasNet) ?? { x: 412, y: 180 };
  const lowerSource = pinPointForComponentNet(layout.lower, layout.sourceNet) ?? { x: 496, y: 412 };
  const outputNet = layout.outputNet ?? layout.outputDrainNet;
  const twoPinComponents = module.components.filter((component) => component.pins.length === 2);

  const drainLoad = findTwoPinWithNets(twoPinComponents, placed, /r(l|d|load)|drain|load/i, layout.powerNet, layout.outputDrainNet);
  if (drainLoad) {
    placeVertical(drainLoad, layout.powerNet, layout.outputDrainNet, {
      x: upperDrain.x,
      y: upperDrain.y - 85,
    });
    placed.add(drainLoad.id);
  }

  const sourceDegeneration = findTwoPinWithNets(twoPinComponents, placed, /r(s|e)|source|degeneration/i, layout.sourceNet, layout.groundNet);
  if (sourceDegeneration) {
    placeVertical(sourceDegeneration, layout.sourceNet, layout.groundNet, {
      x: lowerSource.x,
      y: lowerSource.y + 95,
    });
    placed.add(sourceDegeneration.id);
  }

  const outputSeries = outputNet !== layout.outputDrainNet
    ? findTwoPinWithNets(twoPinComponents, placed, /r(out|probe)|output|series/i, layout.outputDrainNet, outputNet)
    : undefined;
  if (outputSeries) {
    placeHorizontal(outputSeries, layout.outputDrainNet, outputNet, {
      x: upperDrain.x + 190,
      y: upperDrain.y,
    });
    placed.add(outputSeries.id);
  }

  let outputShuntIndex = 0;
  let inputBranchIndex = 0;
  let sourceBranchIndex = 0;
  let biasBranchIndex = 0;
  let railBranchIndex = 0;
  let fallbackIndex = 0;
  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    const [first, second] = component.pins;
    if (first && second && component.pins.length === 2) {
      const nets = new Set([first.net, second.net]);
      if (nets.has(outputNet) && nets.has(layout.groundNet)) {
        placeVertical(component, outputNet, layout.groundNet, {
          x: upperDrain.x + 330 + outputShuntIndex * 125,
          y: upperDrain.y + 180,
        });
        placed.add(component.id);
        outputShuntIndex += 1;
        continue;
      }
      if (nets.has(layout.outputDrainNet) && nets.has(layout.groundNet)) {
        placeVertical(component, layout.outputDrainNet, layout.groundNet, {
          x: upperDrain.x + 230 + outputShuntIndex * 105,
          y: upperDrain.y + 170,
        });
        placed.add(component.id);
        outputShuntIndex += 1;
        continue;
      }
      if (nets.has(layout.outputDrainNet) && nets.has(layout.inputNet)) {
        placeHorizontal(component, layout.inputNet, layout.outputDrainNet, {
          x: upperDrain.x + 120,
          y: lowerGate.y - 120,
        });
        placed.add(component.id);
        continue;
      }
      if (nets.has(layout.inputNet) && nets.has(layout.groundNet)) {
        placeVertical(component, layout.inputNet, layout.groundNet, {
          x: lowerGate.x - 170 - inputBranchIndex * 110,
          y: lowerGate.y + 75,
        });
        placed.add(component.id);
        inputBranchIndex += 1;
        continue;
      }
      if (nets.has(layout.biasNet) && nets.has(layout.groundNet)) {
        placeVertical(component, layout.biasNet, layout.groundNet, {
          x: upperGate.x - 165 - biasBranchIndex * 110,
          y: upperGate.y + 75,
        });
        placed.add(component.id);
        biasBranchIndex += 1;
        continue;
      }
      if (nets.has(layout.sourceNet) && (nets.has(layout.powerNet) || nets.has(layout.groundNet))) {
        const railNet = nets.has(layout.powerNet) ? layout.powerNet : layout.groundNet;
        const groundBranch = railNet === layout.groundNet;
        const topNet = railNet === layout.groundNet ? layout.sourceNet : railNet;
        const bottomNet = railNet === layout.groundNet ? railNet : layout.sourceNet;
        placeVertical(component, topNet, bottomNet, {
          x: lowerSource.x + (groundBranch ? 140 : 330) + sourceBranchIndex * 120,
          y: lowerSource.y + (groundBranch ? 95 : 60),
        });
        placed.add(component.id);
        sourceBranchIndex += 1;
        continue;
      }
      if (nets.has(layout.powerNet) && nets.has(layout.groundNet)) {
        placeVertical(component, layout.powerNet, layout.groundNet, {
          x: 130 + railBranchIndex * 120,
          y: 180,
        });
        placed.add(component.id);
        railBranchIndex += 1;
        continue;
      }
    }
    component.position = snapPoint({
      x: upperDrain.x + 470 + (fallbackIndex % 3) * 150,
      y: 170 + Math.floor(fallbackIndex / 3) * 200,
    });
    component.rotation = normalizeRotation(component.rotation);
    placed.add(component.id);
    fallbackIndex += 1;
  }
  return module;
}

function findOpampFeedbackLayout(module: CircuitModule): OpampFeedbackLayout | null {
  const amplifier = module.components.find((component) => component.type === 'E');
  if (!amplifier) return null;
  const nets = controlledSourceNetMap(amplifier);
  if (!nets.output || !nets.outputRef || !nets.plus || !nets.minus) return null;
  const preferredOutputNet = preferredPortNet(module, 'output');
  if (preferredOutputNet && nets.output !== preferredOutputNet) return null;
  const groundNet = module.ports.find(isGroundPort)?.net ?? '0';
  const powerNet = module.ports.find((port) => port.signal_type === 'power' && !isGroundPort(port))?.net;
  return {
    amplifier,
    outputNet: nets.output,
    outputRefNet: nets.outputRef,
    nonInvertingNet: nets.plus,
    invertingNet: nets.minus,
    groundNet,
    powerNet,
  };
}

function autoLayoutOpampFeedbackModule(module: CircuitModule, layout: OpampFeedbackLayout): CircuitModule {
  const placed = new Set<string>();
  layout.amplifier.position = snapPoint({ x: 380, y: 245 });
  layout.amplifier.rotation = 0;
  placed.add(layout.amplifier.id);

  const opampOutput = pinPointForComponentNet(layout.amplifier, layout.outputNet) ?? { x: 438, y: 245 };
  const opampMinus = pinPointForComponentNet(layout.amplifier, layout.invertingNet) ?? { x: 322, y: 220 };
  const opampPlus = pinPointForComponentNet(layout.amplifier, layout.nonInvertingNet) ?? { x: 322, y: 270 };

  const twoPinComponents = module.components.filter((component) => component.pins.length === 2);
  const feedback = findTwoPinWithNets(
    twoPinComponents,
    placed,
    /r(2f|f|fb)|feedback|gain/i,
    layout.outputNet,
    layout.invertingNet,
  );
  if (feedback) {
    placeHorizontal(feedback, layout.invertingNet, layout.outputNet, {
      x: opampMinus.x + 52,
      y: opampMinus.y - 110,
    });
    placed.add(feedback.id);
  }

  const feedbackCap = findTwoPinWithNets(
    twoPinComponents,
    placed,
    /c(f|comp|feedback)/i,
    layout.outputNet,
    layout.invertingNet,
  );
  if (feedbackCap) {
    placeHorizontal(feedbackCap, layout.invertingNet, layout.outputNet, {
      x: opampMinus.x + 52,
      y: opampMinus.y - 175,
    });
    placed.add(feedbackCap.id);
  }

  const lowerFeedback = findTwoPinWithNets(
    twoPinComponents,
    placed,
    /r(1f|in|g|bias)|feedback.*lower/i,
    layout.invertingNet,
    layout.groundNet,
  );
  if (lowerFeedback) {
    placeVertical(lowerFeedback, layout.invertingNet, layout.groundNet, {
      x: opampMinus.x,
      y: opampMinus.y + 190,
    });
    placed.add(lowerFeedback.id);
  }

  let inputIndex = 0;
  let outputShuntIndex = 0;
  let railIndex = 0;
  let fallbackIndex = 0;
  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    const [first, second] = component.pins;
    if (first && second && component.pins.length === 2) {
      const nets = new Set([first.net, second.net]);
      if (nets.has(layout.nonInvertingNet) && nets.has(layout.groundNet)) {
        placeVertical(component, layout.nonInvertingNet, layout.groundNet, {
          x: opampPlus.x - 260 - inputIndex * 110,
          y: opampPlus.y + 52,
        });
        placed.add(component.id);
        inputIndex += 1;
        continue;
      }
      if (nets.has(layout.outputNet) && nets.has(layout.groundNet)) {
        placeVertical(component, layout.outputNet, layout.groundNet, {
          x: opampOutput.x + 150 + outputShuntIndex * 130,
          y: opampOutput.y + 125,
        });
        placed.add(component.id);
        outputShuntIndex += 1;
        continue;
      }
      if (layout.powerNet && nets.has(layout.powerNet) && nets.has(layout.groundNet)) {
        placeVertical(component, layout.powerNet, layout.groundNet, {
          x: opampPlus.x - 190 - railIndex * 115,
          y: opampPlus.y - 150,
        });
        placed.add(component.id);
        railIndex += 1;
        continue;
      }
      if (nets.has(layout.invertingNet)) {
        const otherNet = first.net === layout.invertingNet ? second.net : first.net;
        placeHorizontal(component, otherNet, layout.invertingNet, {
          x: opampMinus.x - 145 - inputIndex * 110,
          y: opampMinus.y - 20 - inputIndex * 60,
        });
        placed.add(component.id);
        inputIndex += 1;
        continue;
      }
    }
    component.position = snapPoint({
      x: opampOutput.x + 300 + (fallbackIndex % 3) * 150,
      y: 170 + Math.floor(fallbackIndex / 3) * 200,
    });
    component.rotation = normalizeRotation(component.rotation);
    placed.add(component.id);
    fallbackIndex += 1;
  }
  return module;
}

function autoLayoutCmosRingModule(module: CircuitModule, layout: CmosRingLayout): CircuitModule {
  const placed = new Set<string>();
  const stageX = new Map<string, number>();
  const xStart = 300;
  const stageSpacing = 360;

  layout.stages.forEach((stage, index) => {
    const x = xStart + index * stageSpacing;
    stageX.set(stage.outputNet, x);
    stage.pmos.position = snapPoint({ x, y: 160 });
    stage.pmos.rotation = 0;
    stage.nmos.position = snapPoint({ x, y: 380 });
    stage.nmos.rotation = 0;
    placed.add(stage.pmos.id);
    placed.add(stage.nmos.id);
  });

  const shuntCounts = new Map<string, number>();
  let railBranchIndex = 0;
  let fallbackIndex = 0;
  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    const [first, second] = component.pins;
    if (first && second && component.pins.length === 2) {
      const stage = layout.stages.find((entry) => componentHasNets(component, entry.outputNet, layout.groundNet));
      if (stage) {
        const index = shuntCounts.get(stage.outputNet) ?? 0;
        shuntCounts.set(stage.outputNet, index + 1);
        placeVertical(component, stage.outputNet, layout.groundNet, {
          x: (stageX.get(stage.outputNet) ?? xStart) + 120 + index * 110,
          y: 560,
        });
        placed.add(component.id);
        continue;
      }
      if (componentHasNets(component, layout.powerNet, layout.groundNet)) {
        placeVertical(component, layout.powerNet, layout.groundNet, {
          x: 100 - railBranchIndex * 110,
          y: 280,
        });
        railBranchIndex += 1;
        placed.add(component.id);
        continue;
      }
    }
    component.position = snapPoint({
      x: xStart + layout.stages.length * stageSpacing + (fallbackIndex % 2) * 150,
      y: 180 + Math.floor(fallbackIndex / 2) * 200,
    });
    component.rotation = normalizeRotation(component.rotation);
    placed.add(component.id);
    fallbackIndex += 1;
  }
  return module;
}

function autoLayoutCmosInverterModule(module: CircuitModule, layout: CmosInverterLayout): CircuitModule {
  const placed = new Set<string>();
  layout.pmos.position = snapPoint({ x: 420, y: 150 });
  layout.pmos.rotation = 0;
  placed.add(layout.pmos.id);

  layout.nmos.position = snapPoint({ x: 420, y: 370 });
  layout.nmos.rotation = 0;
  placed.add(layout.nmos.id);

  let outputShuntIndex = 0;
  let inputBiasIndex = 0;
  let outputSeriesIndex = 0;
  let fallbackIndex = 0;
  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    const [first, second] = component.pins;
    if (first && second && component.pins.length === 2) {
      const nets = new Set([first.net, second.net]);
      if (nets.has(layout.outputNet) && nets.has(layout.groundNet)) {
        placeVertical(component, layout.outputNet, layout.groundNet, {
          x: 620 + outputShuntIndex * 130,
          y: 310 + outputShuntIndex * 20,
        });
        placed.add(component.id);
        outputShuntIndex += 1;
        continue;
      }
      if (nets.has(layout.powerNet) && nets.has(layout.outputNet)) {
        placeVertical(component, layout.powerNet, layout.outputNet, {
          x: 620 + outputShuntIndex * 130,
          y: 150,
        });
        placed.add(component.id);
        outputShuntIndex += 1;
        continue;
      }
      if (nets.has(layout.inputNet) && (nets.has(layout.groundNet) || nets.has(layout.powerNet))) {
        const railNet = nets.has(layout.groundNet) ? layout.groundNet : layout.powerNet;
        const topNet = railNet === layout.groundNet ? layout.inputNet : railNet;
        const bottomNet = railNet === layout.groundNet ? railNet : layout.inputNet;
        placeVertical(component, topNet, bottomNet, {
          x: 245 + inputBiasIndex * 120,
          y: railNet === layout.groundNet ? 405 : 110,
        });
        placed.add(component.id);
        inputBiasIndex += 1;
        continue;
      }
      if (nets.has(layout.outputNet)) {
        const rightNet = first.net === layout.outputNet ? second.net : first.net;
        placeHorizontal(component, layout.outputNet, rightNet, {
          x: 650 + outputSeriesIndex * 150,
          y: 260,
        });
        placed.add(component.id);
        outputSeriesIndex += 1;
        continue;
      }
      if (nets.has(layout.inputNet)) {
        const leftNet = first.net === layout.inputNet ? second.net : first.net;
        placeHorizontal(component, leftNet, layout.inputNet, {
          x: 250,
          y: 260 + inputBiasIndex * 90,
        });
        placed.add(component.id);
        inputBiasIndex += 1;
        continue;
      }
    }

    component.position = snapPoint({
      x: 760 + (fallbackIndex % 3) * 150,
      y: 170 + Math.floor(fallbackIndex / 3) * 200,
    });
    component.rotation = normalizeRotation(component.rotation);
    placed.add(component.id);
    fallbackIndex += 1;
  }
  return module;
}

function autoLayoutActiveModule(module: CircuitModule, activeComponents: CircuitComponent[]): CircuitModule {
  const sortedActive = [...activeComponents].sort((left, right) => (
    activePlacementScore(left) - activePlacementScore(right) || left.id.localeCompare(right.id)
  ));
  const mainY = 220;
  // MOS/BJT value labels are start-anchored at x+52 and extend right; size the
  // active pitch so a long value cannot run into the next device's body.
  const activeValueReach = Math.max(0, ...sortedActive.map((component) => (
    52 + displayLabelLength(component.value) * 7.5
  )));
  const activePitch = snap(Math.max(190, activeValueReach + 58 + 24));
  // Vertical rail branches carry end-anchored labels reaching left from x-46;
  // keep stacked branches clear of the previous branch's text.
  const branchLabelWidth = Math.max(0, ...module.components
    .filter((component) => component.pins.length === 2)
    .map((component) => Math.max(component.name.length * 9, displayLabelLength(component.value) * 7.5)));
  const branchDx = snap(Math.max(110, 46 + branchLabelWidth + 20));
  sortedActive.forEach((component, index) => {
    component.position = snapPoint({ x: 250 + index * activePitch, y: mainY });
    component.rotation = 0;
  });

  const primary = sortedActive[0];
  const primaryNets = primary ? activeNetMap(primary) : {};
  const placed = new Set(sortedActive.map((component) => component.id));
  const usedSlots = { right: 0 };
  const upperCounts = new Map<string, number>();
  const lowerCounts = new Map<string, number>();
  const outputCounts = new Map<string, number>();
  const nodeAnchors = new Map<string, CircuitPosition>();
  const activeDrainNets = new Set(sortedActive.map((component) => activeNetMap(component).drain).filter(Boolean) as string[]);
  const activeRightEdge = Math.max(...sortedActive.map((component) => componentBounds(component).maxX));
  sortedActive.forEach((component) => rememberComponentPinAnchors(nodeAnchors, component));

  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    if (component.pins.length !== 2) {
      component.position = snapPoint({ x: 250 + sortedActive.length * activePitch + usedSlots.right * 150, y: mainY });
      component.rotation = 0;
      usedSlots.right += 1;
      continue;
    }
    const [first, second] = component.pins;
    if (!first || !second) continue;
    const firstRail = isRailNet(first.net, module);
    const secondRail = isRailNet(second.net, module);
    const signalNet = firstRail ? second.net : first.net;
    const railNet = firstRail ? first.net : secondRail ? second.net : '';
    const activeSignalPin = nearestPinPointForNet(sortedActive, signalNet);
    const signalPin = activeSignalPin ?? nodeAnchors.get(signalNet);

    if (railNet && signalPin) {
      const passiveBranchOffset = activeSignalPin ? 0 : SCHEMATIC_GRID * 6;
      if (isGroundNet(railNet, module)) {
        const index = lowerCounts.get(signalNet) ?? 0;
        lowerCounts.set(signalNet, index + 1);
        placeVertical(component, signalNet, railNet, {
          x: signalPin.x + passiveBranchOffset + index * branchDx,
          y: signalPin.y + 90,
        });
      } else {
        const index = upperCounts.get(signalNet) ?? 0;
        upperCounts.set(signalNet, index + 1);
        placeVertical(component, railNet, signalNet, {
          x: signalPin.x + passiveBranchOffset + index * branchDx,
          y: signalPin.y - 90,
        });
      }
      rememberComponentPinAnchors(nodeAnchors, component);
      continue;
    }

    const outputNet = [first.net, second.net].find((net) => activeDrainNets.has(net));
    if (outputNet) {
      const anchor = nearestPinPointForNet(sortedActive, outputNet) ?? nodeAnchors.get(outputNet);
      if (anchor) {
        const index = outputCounts.get(outputNet) ?? 0;
        outputCounts.set(outputNet, index + 1);
        const ownerIndex = Math.max(0, sortedActive.findIndex((active) => activeNetMap(active).drain === outputNet));
        const otherNet = first.net === outputNet ? second.net : first.net;
        placeHorizontal(component, outputNet, otherNet, {
          x: Math.max(anchor.x + 170, activeRightEdge + 140) + index * 150,
          y: anchor.y + (sortedActive.length > 1 ? (ownerIndex % 2 === 0 ? -40 : 80) : 0),
        });
        rememberComponentPinAnchors(nodeAnchors, component);
        continue;
      }
    }

    if (primaryNets.gate && (first.net === primaryNets.gate || second.net === primaryNets.gate)) {
      placeHorizontal(component, first.net, second.net, {
        x: (primary?.position.x ?? 250) - 160,
        y: mainY,
      });
      rememberComponentPinAnchors(nodeAnchors, component);
      continue;
    }

    component.position = snapPoint({ x: 250 + sortedActive.length * activePitch + usedSlots.right * 150, y: mainY + 100 });
    component.rotation = 0;
    usedSlots.right += 1;
    rememberComponentPinAnchors(nodeAnchors, component);
  }
  return module;
}

function isSingleTransistorStageLikeModule(component: CircuitComponent | undefined): component is CircuitComponent {
  if (!component) return false;
  const nets = activeNetMap(component);
  return Boolean(nets.gate && nets.drain && nets.source);
}

function autoLayoutSingleTransistorStageModule(module: CircuitModule, active: CircuitComponent): CircuitModule {
  const placed = new Set<string>();
  const nets = activeNetMap(active);
  const inputNet = preferredPortNet(module, 'input');
  const outputNet = preferredPortNet(module, 'output');
  const groundNet = module.ports.find(isGroundPort)?.net ?? '0';
  const powerNet = module.ports.find((port) => port.signal_type === 'power' && !isGroundPort(port))?.net ?? 'vdd';

  active.position = snapPoint({ x: 380, y: 240 });
  active.rotation = 0;
  placed.add(active.id);

  const twoPinComponents = module.components.filter((component) => component.pins.length === 2 && !placed.has(component.id));
  const inputCoupling = inputNet && nets.gate && inputNet !== nets.gate
    ? findTwoPinWithNets(twoPinComponents, placed, /c(in|input|coupl)|input/i, inputNet, nets.gate)
    : undefined;
  if (inputCoupling && inputNet && nets.gate) {
    placeHorizontal(inputCoupling, inputNet, nets.gate, { x: 150, y: 240 });
    placed.add(inputCoupling.id);
  }

  const gatePullup = nets.gate
    ? findTwoPinWithNets(twoPinComponents, placed, /r(g|bias|1)|pull|up/i, powerNet, nets.gate)
    : undefined;
  if (gatePullup && nets.gate) {
    placeVertical(gatePullup, powerNet, nets.gate, { x: 280, y: 115 });
    placed.add(gatePullup.id);
  }

  const gatePulldown = nets.gate
    ? findTwoPinWithNets(twoPinComponents, placed, /r(g|bias|2)|pull|down/i, nets.gate, groundNet)
    : undefined;
  if (gatePulldown && nets.gate) {
    placeVertical(gatePulldown, nets.gate, groundNet, { x: 280, y: 365 });
    placed.add(gatePulldown.id);
  }

  const drainLoad = nets.drain
    ? findTwoPinWithNets(twoPinComponents, placed, /r(d|c)|drain|collector|load/i, powerNet, nets.drain)
    : undefined;
  if (drainLoad && nets.drain) {
    placeVertical(drainLoad, powerNet, nets.drain, { x: 405, y: 100 });
    placed.add(drainLoad.id);
  }

  const sourceResistor = nets.source
    ? findTwoPinWithNets(twoPinComponents, placed, /r(s|e)|source|emitter|degeneration/i, nets.source, groundNet)
    : undefined;
  if (sourceResistor && nets.source) {
    placeVertical(sourceResistor, nets.source, groundNet, { x: 405, y: 410 });
    placed.add(sourceResistor.id);
  }

  const sourceBypass = nets.source
    ? findTwoPinWithNets(twoPinComponents, placed, /c(s|e)|source|emitter|bypass/i, nets.source, groundNet)
    : undefined;
  if (sourceBypass && nets.source) {
    placeVertical(sourceBypass, nets.source, groundNet, { x: 540, y: 410 });
    placed.add(sourceBypass.id);
  }

  let outputLoadNet = outputNet && outputNet !== nets.drain ? outputNet : undefined;
  const outputCoupling = nets.drain
    ? findOutputCouplingComponent(twoPinComponents, placed, nets.drain, outputLoadNet, module)
    : undefined;
  if (outputCoupling && nets.drain) {
    outputLoadNet = outputLoadNet ?? otherComponentNet(outputCoupling, nets.drain);
    if (outputLoadNet) placeHorizontal(outputCoupling, nets.drain, outputLoadNet, { x: 590, y: 188 });
    placed.add(outputCoupling.id);
  }

  const outputLoad = outputLoadNet
    ? findTwoPinWithNets(twoPinComponents, placed, /r(load|out)|load/i, outputLoadNet, groundNet)
    : undefined;
  if (outputLoad && outputLoadNet) {
    placeVertical(outputLoad, outputLoadNet, groundNet, { x: 745, y: 360 });
    placed.add(outputLoad.id);
  }

  let fallbackIndex = 0;
  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    component.position = snapPoint({
      x: 700 + (fallbackIndex % 3) * 150,
      y: 180 + Math.floor(fallbackIndex / 3) * 200,
    });
    component.rotation = normalizeRotation(component.rotation);
    fallbackIndex += 1;
  }
  return module;
}

function isBjtResetLikeModule(module: CircuitModule, activeComponents: CircuitComponent[]): boolean {
  const bjtCount = activeComponents.filter((component) => component.type === 'Q').length;
  if (bjtCount < 2 || !module.components.some((component) => component.type === 'D')) return false;
  const text = [
    module.module_id,
    module.name,
    ...module.components.flatMap((component) => [
      component.id,
      component.name,
      component.value,
      ...component.pins.map((pin) => pin.net),
    ]),
  ].join(' ').toLowerCase();
  return /rst|reset/.test(text) && /dtr/.test(text) && /rts/.test(text) && /boot/.test(text);
}

function autoLayoutBjtResetModule(module: CircuitModule, activeComponents: CircuitComponent[]): CircuitModule {
  const placed = new Set<string>();
  const bjtComponents = activeComponents.filter((component) => component.type === 'Q');
  const reset = findNamedComponent(bjtComponents, /rst|reset/) ?? bjtComponents[1] ?? bjtComponents[0];
  const boot = findNamedComponent(bjtComponents, /boot/) ?? bjtComponents.find((component) => component.id !== reset?.id) ?? bjtComponents[0];
  const resetNets = reset ? activeNetMap(reset) : {};
  const bootNets = boot ? activeNetMap(boot) : {};
  const powerNet = module.ports.find((port) => port.signal_type === 'power' && !isGroundPort(port))?.net ?? 'vdd';

  if (boot) {
    boot.position = snapPoint({ x: 260, y: 300 });
    boot.rotation = 0;
    placed.add(boot.id);
  }
  if (reset) {
    reset.position = snapPoint({ x: 620, y: 220 });
    reset.rotation = 0;
    placed.add(reset.id);
  }

  const resetCollector = reset && resetNets.drain ? pinPointForComponentNet(reset, resetNets.drain) : null;
  const resetBase = reset && resetNets.gate ? pinPointForComponentNet(reset, resetNets.gate) : null;
  const resetEmitter = reset && resetNets.source ? pinPointForComponentNet(reset, resetNets.source) : null;
  const bootBase = boot && bootNets.gate ? pinPointForComponentNet(boot, bootNets.gate) : null;
  const bootEmitter = boot && bootNets.source ? pinPointForComponentNet(boot, bootNets.source) : null;

  const twoPinComponents = module.components.filter((component) => component.pins.length === 2 && !placed.has(component.id));
  const pullup = findTwoPinWithNets(twoPinComponents, placed, /r50|pull|up/i, powerNet, resetNets.drain);
  if (pullup && resetCollector && resetNets.drain) {
    placeVertical(pullup, powerNet, resetNets.drain, {
      x: resetCollector.x,
      y: resetCollector.y - 95,
    });
    placed.add(pullup.id);
  }

  const diode = findTwoPinWithNets(twoPinComponents, placed, /d|diode|rst|reset/i, undefined, resetNets.drain);
  if (diode && resetCollector && resetNets.drain) {
    const leftNet = diode.pins.find((pin) => pin.net !== resetNets.drain)?.net ?? diode.pins[0]?.net ?? resetNets.drain;
    placeHorizontal(diode, leftNet, resetNets.drain, {
      x: resetCollector.x - 165,
      y: resetCollector.y,
    });
    placed.add(diode.id);
  }

  const dtrResistor = findTwoPinWithNets(twoPinComponents, placed, /r51|dtr/i, resetNets.gate, undefined);
  if (dtrResistor && resetBase && resetNets.gate) {
    const rightNet = dtrResistor.pins.find((pin) => pin.net !== resetNets.gate)?.net ?? dtrResistor.pins[1]?.net ?? resetNets.gate;
    placeHorizontal(dtrResistor, resetNets.gate, rightNet, {
      x: resetBase.x + 170,
      y: resetBase.y,
    });
    placed.add(dtrResistor.id);
  }

  const rtsResistor = findTwoPinWithNets(twoPinComponents, placed, /r49|rts/i, bootNets.gate, resetNets.source);
  if (rtsResistor && bootBase && resetEmitter && bootNets.gate && resetNets.source) {
    placeHorizontal(rtsResistor, bootNets.gate, resetNets.source, {
      x: (bootBase.x + resetEmitter.x) / 2,
      y: resetEmitter.y + 54,
    });
    placed.add(rtsResistor.id);
  }

  const bootResistor = findTwoPinWithNets(twoPinComponents, placed, /r52|boot/i, bootNets.source, undefined);
  if (bootResistor && bootEmitter && bootNets.source) {
    const bottomNet = bootResistor.pins.find((pin) => pin.net !== bootNets.source)?.net ?? bootResistor.pins[1]?.net ?? bootNets.source;
    placeVertical(bootResistor, bootNets.source, bottomNet, {
      x: bootEmitter.x,
      y: bootEmitter.y + 100,
    });
    placed.add(bootResistor.id);
  }

  let fallbackIndex = 0;
  for (const component of module.components) {
    if (placed.has(component.id)) continue;
    component.position = snapPoint({
      x: 820 + (fallbackIndex % 3) * 170,
      y: 200 + Math.floor(fallbackIndex / 3) * 135,
    });
    component.rotation = normalizeRotation(component.rotation);
    fallbackIndex += 1;
  }
  return module;
}

function autoLayoutLdoModule(module: CircuitModule, activeComponents: CircuitComponent[]): CircuitModule {
  const placed = new Set<string>();
  const inputNet = preferredPortNet(module, 'input') ?? 'vin';
  const outputNet = preferredPortNet(module, 'output') ?? 'vout';
  const groundNet = module.ports.find(isGroundPort)?.net ?? '0';
  const powerNet = module.ports.find((port) => port.signal_type === 'power' && !isGroundPort(port))?.net ?? inputNet;

  const pass = findPassDevice(activeComponents, powerNet, outputNet);
  const differential = activeComponents
    .filter((component) => component.id !== pass?.id)
    .sort((left, right) => activePlacementScore(left) - activePlacementScore(right) || left.id.localeCompare(right.id));

  const currentSources = differential.filter((component) => /current|mirror|bias|load|p?mos/i.test(component.value) && isPmosComponent(component));
  const signalPair = differential.filter((component) => !isPmosComponent(component));
  const fallbackActives = differential.filter((component) => !currentSources.includes(component) && !signalPair.includes(component));

  const activeSlots: Array<{ component: CircuitComponent | undefined; x: number; y: number }> = [
    { component: currentSources[0], x: 320, y: 180 },
    { component: currentSources[1], x: 580, y: 180 },
    { component: signalPair[0] ?? fallbackActives[0], x: 320, y: 500 },
    { component: signalPair[1] ?? fallbackActives[1], x: 580, y: 500 },
    { component: pass, x: 820, y: 340 },
  ];

  activeSlots.forEach(({ component, x, y }) => {
    if (!component || placed.has(component.id)) return;
    component.position = snapPoint({ x, y });
    component.rotation = 0;
    placed.add(component.id);
  });

  const twoPinComponents = module.components.filter((component) => component.pins.length === 2 && !placed.has(component.id));
  const passGateNet = pass?.pins.find((pin) => /gate|\bg\b/i.test(`${pin.id} ${pin.name}`))?.net;
  placeNamedTwoPin(twoPinComponents, placed, /v(in|dd|supply)|input/i, powerNet, groundNet, { x: 130, y: 410 });
  placeNamedTwoPin(twoPinComponents, placed, /vref|reference/i, 'vref', groundNet, { x: 130, y: 650 });
  placeNamedTwoPin(twoPinComponents, placed, /itail|tail|bias/i, 'tail', groundNet, { x: 450, y: 700 });
  if (passGateNet) {
    placeNamedTwoPin(twoPinComponents, placed, /rpu|pull.*up/i, powerNet, passGateNet, { x: 700, y: 180 });
  }
  placeNamedTwoPin(twoPinComponents, placed, /r(top|fb1|upper)|feedback.*top/i, outputNet, 'fb', { x: 1020, y: 445 });
  placeNamedTwoPin(twoPinComponents, placed, /r(bot|fb2|lower)|feedback.*bot/i, 'fb', groundNet, { x: 1020, y: 680 });
  placeNamedTwoPin(twoPinComponents, placed, /r(load|out)|load/i, outputNet, groundNet, { x: 1160, y: 635 });
  placeNamedTwoPin(twoPinComponents, placed, /c(out|load)|output.*cap/i, outputNet, groundNet, { x: 1290, y: 635 });

  for (const component of twoPinComponents) {
    if (placed.has(component.id)) continue;
    const [first, second] = component.pins;
    if (!first || !second) continue;
    const firstRail = isRailNet(first.net, module);
    const secondRail = isRailNet(second.net, module);
    const signalNet = firstRail ? second.net : first.net;
    const railNet = firstRail ? first.net : secondRail ? second.net : '';
    const anchor = nearestPinPointForNet(activeComponents, signalNet);
    if (railNet && anchor) {
      placeVertical(component, signalNet, railNet, {
        x: anchor.x,
        y: anchor.y + (isGroundNet(railNet, module) ? 135 : -135),
      });
    } else {
      component.position = snapPoint({ x: 700 + placed.size * 60, y: 500 });
      component.rotation = normalizeRotation(component.rotation);
    }
    placed.add(component.id);
  }

  module.components.forEach((component, index) => {
    if (placed.has(component.id)) return;
    component.position = snapPoint({ x: 230 + (index % 4) * 150, y: 590 + Math.floor(index / 4) * 120 });
    component.rotation = normalizeRotation(component.rotation);
  });

  return module;
}

function autoLayoutGenericModule(module: CircuitModule): CircuitModule {
  const columns = Math.max(1, Math.ceil(Math.sqrt(module.components.length)));
  module.components.forEach((component, index) => {
    component.position = snapPoint({
      x: 180 + (index % columns) * 180,
      y: 170 + Math.floor(index / columns) * 200,
    });
    component.rotation = normalizeRotation(component.rotation);
  });
  keepBlockPinChannelsClear(module);
  return module;
}

/**
 * The naive grid can park discretes inside a block symbol's pin-lead zone,
 * caging its pins behind padded obstacles. Slide such components right
 * (deterministically, keeping their row) until they clear the block and
 * every already-placed neighbour, so a routing channel stays open around
 * the block's left/right edges.
 */
function keepBlockPinChannelsClear(module: CircuitModule): void {
  const blocks = module.components.filter(isBlockLike);
  if (blocks.length === 0) return;
  // The channel beside a block edge carries egress stubs and the signal
  // ports parked at pin +110; components must clear both.
  const placed = blocks.map((block) => padBounds(componentBounds(block), SCHEMATIC_GRID + 110));
  const rectanglesOverlap = (left: SchematicBounds, right: SchematicBounds) => (
    left.maxX > right.minX && left.minX < right.maxX &&
    left.maxY > right.minY && left.minY < right.maxY
  );
  for (const victim of module.components) {
    if (isBlockLike(victim)) continue;
    let bounds = componentBounds(victim);
    if (!placed.some((other) => rectanglesOverlap(bounds, other))) {
      placed.push(bounds);
      continue;
    }
    let x = victim.position.x;
    for (let guard = 0; guard < 40; guard += 1) {
      const blockers = placed.filter((other) => rectanglesOverlap(bounds, other));
      if (blockers.length === 0) break;
      const rightmost = Math.max(...blockers.map((blocker) => blocker.maxX));
      const halfWidth = (bounds.maxX - bounds.minX) / 2;
      x = snap(rightmost + SCHEMATIC_GRID + halfWidth);
      bounds = componentBounds({ ...victim, position: { x, y: victim.position.y } });
    }
    victim.position = { x, y: victim.position.y };
    placed.push(bounds);
  }
}

function placeRailBranch(
  component: CircuitComponent,
  signalNet: string,
  railNet: string,
  nodeX: Map<string, number>,
  lowerCounts: Map<string, number>,
  upperCounts: Map<string, number>,
  yMain: number,
  module: CircuitModule,
) {
  const xBase = nodeX.get(signalNet) ?? 240;
  if (isGroundNet(railNet, module)) {
    const index = lowerCounts.get(signalNet) ?? 0;
    lowerCounts.set(signalNet, index + 1);
    placeVertical(component, signalNet, railNet, {
      x: xBase + index * 130,
      y: yMain + 95 + index * 12,
    });
    return;
  }
  const index = upperCounts.get(signalNet) ?? 0;
  upperCounts.set(signalNet, index + 1);
  placeVertical(component, railNet, signalNet, {
    x: xBase + index * 130,
    y: yMain - 95 - index * 12,
  });
}

function placeHorizontal(component: CircuitComponent, leftNet: string, rightNet: string, center: CircuitPosition) {
  component.position = snapPoint(center);
  const [first, second] = component.pins;
  if (first?.net === leftNet && second?.net === rightNet) {
    component.rotation = 0;
  } else if (first?.net === rightNet && second?.net === leftNet) {
    component.rotation = 180;
  } else {
    component.rotation = 0;
  }
}

function placeVertical(component: CircuitComponent, topNet: string, bottomNet: string, center: CircuitPosition) {
  component.position = snapPoint(center);
  const [first, second] = component.pins;
  if (first?.net === topNet && second?.net === bottomNet) {
    component.rotation = 90;
  } else if (first?.net === bottomNet && second?.net === topNet) {
    component.rotation = 270;
  } else {
    component.rotation = 90;
  }
}

function rememberComponentPinAnchors(anchors: Map<string, CircuitPosition>, component: CircuitComponent) {
  component.pins.forEach((pin, index) => {
    anchors.set(pin.net, pinWorld(component, pin, index));
  });
}

interface SeriesPathEntry {
  component: CircuitComponent;
  leftNet: string;
  rightNet: string;
}

function findSeriesPath(module: CircuitModule, inputNet: string, outputNet: string): SeriesPathEntry[] {
  const graph = new Map<string, SeriesPathEntry[]>();
  for (const component of module.components) {
    if (component.pins.length !== 2) continue;
    const [first, second] = component.pins;
    if (!first || !second || first.net === second.net) continue;
    if (isRailNet(first.net, module) || isRailNet(second.net, module)) continue;
    const forward = { component, leftNet: first.net, rightNet: second.net };
    const reverse = { component, leftNet: second.net, rightNet: first.net };
    graph.set(first.net, [...(graph.get(first.net) ?? []), forward]);
    graph.set(second.net, [...(graph.get(second.net) ?? []), reverse]);
  }

  const queue: Array<{ net: string; path: SeriesPathEntry[]; used: Set<string> }> = [
    { net: inputNet, path: [], used: new Set() },
  ];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.net === outputNet) return current.path;
    if (visited.has(current.net)) continue;
    visited.add(current.net);
    for (const edge of graph.get(current.net) ?? []) {
      if (current.used.has(edge.component.id)) continue;
      queue.push({
        net: edge.rightNet,
        path: [...current.path, edge],
        used: new Set([...current.used, edge.component.id]),
      });
    }
  }
  return [];
}

function preferredPortNet(module: CircuitModule, direction: 'input' | 'output'): string | null {
  const port = module.ports.find((entry) => (
    entry.direction === direction &&
    entry.signal_type !== 'ground' &&
    entry.signal_type !== 'power'
  ));
  return port?.net ?? null;
}

function rememberPinX(nodeX: Map<string, number>, component: CircuitComponent) {
  component.pins.forEach((pin, index) => {
    const point = pinWorld(component, pin, index);
    nodeX.set(pin.net, point.x);
  });
}

function activeNetMap(component: CircuitComponent): { gate?: string; drain?: string; source?: string } {
  const result: { gate?: string; drain?: string; source?: string } = {};
  for (const pin of component.pins) {
    const key = `${pin.id} ${pin.name}`.toLowerCase();
    if (component.type === 'M') {
      if (/gate|\bg\b/.test(key)) result.gate = pin.net;
      if (/drain|\bd\b/.test(key)) result.drain = pin.net;
      if (/source|\bs\b/.test(key)) result.source = pin.net;
      continue;
    }
    if (/base|\bb\b/.test(key)) result.gate = pin.net;
    if (/collector|\bc\b/.test(key)) result.drain = pin.net;
    if (/emitter|\be\b/.test(key)) result.source = pin.net;
  }
  return result;
}

function controlledSourceNetMap(component: CircuitComponent): { output?: string; outputRef?: string; plus?: string; minus?: string } {
  const result: { output?: string; outputRef?: string; plus?: string; minus?: string } = {};
  for (let index = 0; index < component.pins.length; index += 1) {
    const pin = component.pins[index];
    if (!pin) continue;
    const key = `${pin.id} ${pin.name}`.toLowerCase();
    if (/out\+|\bp\b/.test(key) || index === 0) {
      result.output = pin.net;
    } else if (/out-|\bn\b|ref/.test(key) || index === 1) {
      result.outputRef = pin.net;
    } else if (/\+|non|cp|in\+/.test(key) || index === 2) {
      result.plus = pin.net;
    } else if (/-|inv|cn|in-/.test(key) || index === 3) {
      result.minus = pin.net;
    }
  }
  return result;
}

function activePlacementScore(component: CircuitComponent): number {
  const text = `${component.id} ${component.name}`.toLowerCase();
  if (/ref|bias|diode/.test(text)) return 0;
  if (/out|load/.test(text)) return 2;
  return 1;
}

/** Label length as rendered by displayComponentValue (long values collapse to 21 chars). */
function displayLabelLength(value: string | undefined): number {
  const text = (value ?? '').trim();
  return text.length > 22 ? 21 : text.length;
}

function isLdoLikeModule(module: CircuitModule, activeComponents: CircuitComponent[]): boolean {
  const moduleText = `${module.module_id} ${module.name}`.toLowerCase();
  const hasNamedPassDevice = activeComponents.some((component) => (
    /(^|[_-])m?p(ass)?($|[_-])|\bmp\b|pass|ldo/i.test(`${component.id} ${component.name}`)
  ));
  const hasInputOutputRails = module.ports.some((port) => port.direction === 'input' && !isGroundPort(port)) &&
    module.ports.some((port) => port.direction === 'output' && !isGroundPort(port));
  return activeComponents.length >= 2 && hasInputOutputRails && (/ldo|regulator/.test(moduleText) || hasNamedPassDevice);
}

function findPassDevice(activeComponents: CircuitComponent[], powerNet: string, outputNet: string): CircuitComponent | undefined {
  return activeComponents.find((component) => /(^|[_-])m?p(ass)?($|[_-])|\bmp\b|pass/i.test(`${component.id} ${component.name} ${component.value}`)) ??
    activeComponents.find((component) => (
      isPmosComponent(component) &&
      component.pins.some((pin) => pin.net === powerNet) &&
      component.pins.some((pin) => pin.net === outputNet)
    )) ??
    activeComponents.find(isPmosComponent);
}

function findNamedComponent(components: CircuitComponent[], pattern: RegExp): CircuitComponent | undefined {
  return components.find((component) => pattern.test(`${component.id} ${component.name} ${component.value}`));
}

function findVoltageDividerLayout(module: CircuitModule): VoltageDividerLayout | null {
  const groundNet = module.ports.find(isGroundPort)?.net ?? '0';
  const powerNets = module.ports
    .filter((port) => port.signal_type === 'power' && !isGroundPort(port))
    .map((port) => port.net);
  if (powerNets.length === 0) return null;

  const resistors = module.components.filter((component) => component.type === 'R' && component.pins.length === 2);
  if (resistors.length < 2) return null;
  const outputCandidates = uniqueStrings([
    preferredPortNet(module, 'output'),
    ...resistors.flatMap((component) => component.pins.map((pin) => pin.net))
      .filter((net) => net !== groundNet && !powerNets.includes(net)),
  ]);

  for (const outputNet of outputCandidates) {
    if (!outputNet) continue;
    for (const powerNet of powerNets) {
      const top = resistors.find((component) => componentHasNets(component, powerNet, outputNet));
      const bottom = resistors.find((component) => component.id !== top?.id && componentHasNets(component, outputNet, groundNet));
      if (top && bottom) return { top, bottom, powerNet, outputNet, groundNet };
    }
  }
  return null;
}

function findTwoPinWithNets(
  components: CircuitComponent[],
  placed: Set<string>,
  pattern: RegExp,
  firstNet?: string,
  secondNet?: string,
): CircuitComponent | undefined {
  const matchesNets = (component: CircuitComponent) => {
    const nets = new Set(component.pins.map((pin) => pin.net));
    return (!firstNet || nets.has(firstNet)) && (!secondNet || nets.has(secondNet));
  };
  return components.find((component) => !placed.has(component.id) && pattern.test(`${component.id} ${component.name} ${component.value}`) && matchesNets(component)) ??
    components.find((component) => !placed.has(component.id) && matchesNets(component));
}

function findOutputCouplingComponent(
  components: CircuitComponent[],
  placed: Set<string>,
  drainNet: string,
  preferredOutputNet: string | undefined,
  module: CircuitModule,
): CircuitComponent | undefined {
  if (preferredOutputNet) {
    return findTwoPinWithNets(components, placed, /c(out|output|coupl)|output/i, drainNet, preferredOutputNet);
  }
  return components.find((component) => {
    if (placed.has(component.id) || component.type !== 'C' || component.pins.length !== 2) return false;
    const otherNet = otherComponentNet(component, drainNet);
    return Boolean(otherNet && !isRailNet(otherNet, module));
  });
}

function otherComponentNet(component: CircuitComponent, net: string): string | undefined {
  return component.pins.find((pin) => pin.net !== net)?.net;
}

function componentHasNets(component: CircuitComponent, firstNet: string, secondNet: string): boolean {
  const nets = new Set(component.pins.map((pin) => pin.net));
  return nets.has(firstNet) && nets.has(secondNet);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function pinPointForComponentNet(component: CircuitComponent, net: string): CircuitPosition | null {
  const index = component.pins.findIndex((pin) => pin.net === net);
  const pin = index >= 0 ? component.pins[index] : undefined;
  return pin ? pinWorld(component, pin, index) : null;
}

function placeNamedTwoPin(
  components: CircuitComponent[],
  placed: Set<string>,
  pattern: RegExp,
  topNet: string,
  bottomNet: string,
  center: CircuitPosition,
) {
  const component = components.find((entry) => !placed.has(entry.id) && pattern.test(`${entry.id} ${entry.name} ${entry.value}`));
  if (!component) return;
  const [first, second] = component.pins;
  if (!first || !second) return;
  const nets = [first.net, second.net];
  const actualTop = nets.includes(topNet) ? topNet : first.net;
  const actualBottom = nets.includes(bottomNet) ? bottomNet : nets.find((net) => net !== actualTop) ?? second.net;
  placeVertical(component, actualTop, actualBottom, center);
  placed.add(component.id);
}

function nearestPinPointForNet(components: CircuitComponent[], net: string): CircuitPosition | null {
  for (const component of components) {
    for (let index = 0; index < component.pins.length; index += 1) {
      const pin = component.pins[index];
      if (!pin || pin.net !== net) continue;
      return pinWorld(component, pin, index);
    }
  }
  return null;
}

function isRailNet(net: string, module: CircuitModule): boolean {
  return isGroundNet(net, module) || module.ports.some((port) => port.net === net && port.signal_type === 'power');
}

function isGroundNet(net: string, module: CircuitModule): boolean {
  return net === '0' || module.ports.some((port) => port.net === net && isGroundPort(port));
}

export function pinWorld(component: CircuitComponent, pin: CircuitPin, index: number): CircuitPosition {
  const offset = pinOffset(component, pin, index);
  return {
    x: component.position.x + offset.x,
    y: component.position.y + offset.y,
  };
}

export function blockPinSide(component: CircuitComponent, pin: CircuitPin, index: number): BlockPinSide {
  if (pin.side) return pin.side;
  const key = `${pin.id} ${pin.name}`.toLowerCase();
  if (/\b(vdd|vcc|vin|v\+)\b/.test(key)) return 'top';
  if (/\b(gnd|vss|vee|0|v-)\b/.test(key)) return 'bottom';
  if (/\b(out|output|q)\b/.test(key)) return 'right';
  return index < Math.ceil(component.pins.length / 2) ? 'left' : 'right';
}

export function blockBodySize(component: CircuitComponent): { width: number; height: number } {
  const sideCounts: Record<BlockPinSide, number> = { left: 0, right: 0, top: 0, bottom: 0 };
  component.pins.forEach((pin, index) => {
    sideCounts[blockPinSide(component, pin, index)] += 1;
  });
  const requestedWidth = Number(component.block?.width);
  const requestedHeight = Number(component.block?.height);
  const minimumWidth = Math.max(120, Math.max(sideCounts.top, sideCounts.bottom) * 38 + 32);
  const minimumHeight = Math.max(84, Math.max(sideCounts.left, sideCounts.right) * 30 + 30);
  return {
    width: Math.min(480, Math.max(minimumWidth, Number.isFinite(requestedWidth) ? requestedWidth : 160)),
    height: Math.min(480, Math.max(minimumHeight, Number.isFinite(requestedHeight) ? requestedHeight : 100)),
  };
}

function blockPinLocalOffsets(
  component: CircuitComponent,
  pin: CircuitPin,
  index: number,
): { endpoint: CircuitPosition; body: CircuitPosition; side: BlockPinSide } {
  const side = blockPinSide(component, pin, index);
  const { width, height } = blockBodySize(component);
  const ordered = component.pins
    .map((entry, entryIndex) => ({
      pin: entry,
      index: entryIndex,
      order: typeof entry.order === 'number' && Number.isFinite(entry.order) ? entry.order : entryIndex,
    }))
    .filter((entry) => blockPinSide(component, entry.pin, entry.index) === side)
    .sort((left, right) => left.order - right.order || left.index - right.index);
  const rank = Math.max(0, ordered.findIndex((entry) => entry.index === index));
  if (side === 'left' || side === 'right') {
    const y = -height / 2 + height * ((rank + 1) / (ordered.length + 1));
    const bodyX = (side === 'left' ? -1 : 1) * width / 2;
    return {
      side,
      body: { x: bodyX, y },
      endpoint: { x: bodyX + (side === 'left' ? -BLOCK_PIN_LEAD : BLOCK_PIN_LEAD), y },
    };
  }
  const x = -width / 2 + width * ((rank + 1) / (ordered.length + 1));
  const bodyY = (side === 'top' ? -1 : 1) * height / 2;
  return {
    side,
    body: { x, y: bodyY },
    endpoint: { x, y: bodyY + (side === 'top' ? -BLOCK_PIN_LEAD : BLOCK_PIN_LEAD) },
  };
}

export function blockPinBodyWorld(component: CircuitComponent, pin: CircuitPin, index: number): CircuitPosition {
  const offset = rotateOffset(blockPinLocalOffsets(component, pin, index).body, normalizeRotation(component.rotation));
  return { x: component.position.x + offset.x, y: component.position.y + offset.y };
}

export function componentBounds(component: CircuitComponent): SchematicBounds {
  const pins = component.pins.map((pin, index) => pinWorld(component, pin, index));
  const bodyPoints = (component.type === 'BLOCK' || component.type === 'MODULE')
    ? (() => {
        const { width, height } = blockBodySize(component);
        return [
          { x: -width / 2, y: -height / 2 },
          { x: width / 2, y: -height / 2 },
          { x: width / 2, y: height / 2 },
          { x: -width / 2, y: height / 2 },
        ].map((point) => {
          const offset = rotateOffset(point, normalizeRotation(component.rotation));
          return { x: component.position.x + offset.x, y: component.position.y + offset.y };
        });
      })()
    : [
        { x: component.position.x - 52, y: component.position.y - 52 },
        { x: component.position.x + 52, y: component.position.y + 52 },
      ];
  const xs = [...bodyPoints.map((point) => point.x), ...pins.map((pin) => pin.x)];
  const ys = [...bodyPoints.map((point) => point.y), ...pins.map((pin) => pin.y)];
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/** Hit / marquee bounds for power / ground / signal net-label artwork. */
export function netLabelBounds(label: SchematicNetLabel): SchematicBounds {
  const { position, endpoint } = label;
  if (label.kind === 'ground') {
    return {
      minX: Math.min(position.x, endpoint.x) - 24,
      minY: Math.min(position.y, endpoint.y) - 4,
      maxX: Math.max(position.x, endpoint.x) + 24,
      maxY: Math.max(position.y + 42, endpoint.y),
    };
  }
  if (label.kind === 'power') {
    return {
      minX: Math.min(position.x, endpoint.x) - 24,
      minY: Math.min(position.y - 24, endpoint.y),
      maxX: Math.max(position.x, endpoint.x) + 24,
      maxY: Math.max(position.y, endpoint.y) + 6,
    };
  }
  const side = label.side ?? 'right';
  const stub = 34;
  const endX = position.x + (side === 'left' ? -stub : side === 'right' ? stub : 0);
  const endY = position.y + (side === 'top' ? -stub : side === 'bottom' ? stub : 0);
  return {
    minX: Math.min(position.x, endX, endpoint.x) - 28,
    minY: Math.min(position.y, endY, endpoint.y) - 18,
    maxX: Math.max(position.x, endX, endpoint.x) + 28,
    maxY: Math.max(position.y, endY, endpoint.y) + 18,
  };
}

/** Length of the drawn stub between a rail pin and its local GND/VDD symbol. */
export const RAIL_LABEL_STUB = SCHEMATIC_GRID * 2;

function pinPointsByNetName(module: CircuitModule): Map<string, CircuitPosition[]> {
  const points = new Map<string, CircuitPosition[]>();
  for (const component of module.components) {
    component.pins.forEach((pin, index) => {
      if (pin.no_connect) return;
      const point = pinWorld(component, pin, index);
      points.set(pin.net, [...(points.get(pin.net) ?? []), point]);
    });
  }
  return points;
}

function computeConnectedPortIds(module: CircuitModule): Set<string> {
  const pinNets = new Set(module.components.flatMap((component) => (
    component.pins.filter((pin) => !pin.no_connect).map((pin) => pin.net)
  )));
  const portNetCounts = new Map<string, number>();
  for (const port of module.ports) {
    portNetCounts.set(port.net, (portNetCounts.get(port.net) ?? 0) + 1);
  }
  const wiredPorts = new Set(
    (module.wires ?? []).flatMap((wire) => [wire.from?.port_id, wire.to?.port_id].filter(Boolean) as string[]),
  );
  return new Set(
    module.ports
      .filter((port) => pinNets.has(port.net) || wiredPorts.has(port.id) || (portNetCounts.get(port.net) ?? 0) > 1)
      .map((port) => port.id),
  );
}

function filterPortPositions(
  portPositions: Map<string, CircuitPosition>,
  connectedPortIds: Set<string>,
): Map<string, CircuitPosition> {
  return new Map([...portPositions].filter(([portId]) => connectedPortIds.has(portId)));
}

function leftmost(points: CircuitPosition[]): CircuitPosition | null {
  return points.reduce<CircuitPosition | null>((best, point) => (
    !best || point.x < best.x ? point : best
  ), null);
}

function rightmost(points: CircuitPosition[]): CircuitPosition | null {
  return points.reduce<CircuitPosition | null>((best, point) => (
    !best || point.x > best.x ? point : best
  ), null);
}

function topmost(points: CircuitPosition[]): CircuitPosition | null {
  return points.reduce<CircuitPosition | null>((best, point) => (
    !best || point.y < best.y ? point : best
  ), null);
}

function bottommost(points: CircuitPosition[]): CircuitPosition | null {
  return points.reduce<CircuitPosition | null>((best, point) => (
    !best || point.y > best.y ? point : best
  ), null);
}

export function computePortPositions(module: CircuitModule): Map<string, CircuitPosition> {
  const bounds = moduleBounds(module, new Map(), module.wires ?? []);
  const signalPorts = module.ports.filter((port) => !isGroundPort(port) && port.signal_type !== 'power');
  const powers = module.ports.filter((port) => !isGroundPort(port) && port.signal_type === 'power');
  const grounds = module.ports.filter(isGroundPort);
  const pinPointsByNet = pinPointsByNetName(module);
  const map = new Map<string, CircuitPosition>();
  const signalSideCounts: Record<SignalPortSide, number> = { left: 0, right: 0 };
  const signalSidePositions: Record<SignalPortSide, Record<'input' | 'output', CircuitPosition[]>> = {
    left: { input: [], output: [] },
    right: { input: [], output: [] },
  };

  signalPorts.forEach((port) => {
    const storedPosition = storedPortPosition(port);
    if (storedPosition) {
      map.set(port.id, storedPosition);
      return;
    }
    const wiredPosition = (module.wires ?? [])
      .flatMap((wire) => [wire.from, wire.to])
      .find((endpoint) => endpoint?.port_id === port.id);
    if (wiredPosition) {
      map.set(port.id, snapPoint(wiredPosition));
      return;
    }
    const points = pinPointsByNet.get(port.net) ?? [];
    const activeControlSide = activeControlInputPortSide(module, port);
    const blockEdgeSide = activeControlSide ? null : blockEdgePortSide(module, port);
    const side = activeControlSide ?? blockEdgeSide ?? signalPortSide(port, points, bounds);
    const index = signalSideCounts[side];
    signalSideCounts[side] += 1;
    const anchor = side === 'right' ? rightmost(points) : leftmost(points);
    const fallback = {
      x: side === 'right' ? bounds.maxX : bounds.minX,
      y: bounds.minY + 70 + index * 60,
    };
    const base = anchor ?? fallback;
    const sideGroup = port.direction === 'output' ? 'output' : 'input';
    const differentialOutput = isDifferentialOutputPort(module, port);
    const sideGroupIndex = signalSidePositions[side][sideGroup].length;
    const x = side === 'right'
      ? base.x + 110
      : base.x - 110;
    const preferredY = differentialOutput
      ? differentialOutputPortPreferredY(port, points, base.y, sideGroupIndex)
      // Block-edge fan-out ports track their own pin row; the global
      // per-side index drift otherwise parks ports far below their pins and
      // forces wrap-around routes through one congested channel.
      : activeControlSide || blockEdgeSide ? base.y : base.y + index * 16;
    const snappedX = snap(x);
    const y = blockEdgeSide
      ? avoidBlockEdgePortY(module, port, snappedX, preferredY, signalSidePositions[side][sideGroup])
      : avoidSignalPortY(module, port, snappedX, preferredY, signalSidePositions[side][sideGroup]);
    signalSidePositions[side][sideGroup].push({ x: snappedX, y });
    map.set(port.id, snapPoint({
      x,
      y,
    }));
  });
  powers.forEach((port, index) => {
    const storedPosition = storedPortPosition(port);
    if (storedPosition) {
      map.set(port.id, storedPosition);
      return;
    }
    const points = pinPointsByNet.get(port.net) ?? [];
    const anchor = topmost(points);
    map.set(port.id, snapPoint(anchor
      ? { x: anchor.x + index * 80, y: anchor.y - 110 }
      : { x: bounds.minX + 110 + index * 110, y: bounds.minY - 90 }));
  });
  grounds.forEach((port, index) => {
    const storedPosition = storedPortPosition(port);
    if (storedPosition) {
      map.set(port.id, storedPosition);
      return;
    }
    const points = pinPointsByNet.get(port.net) ?? [];
    const anchor = bottommost(points);
    map.set(port.id, snapPoint(anchor
      ? { x: anchor.x + index * 80, y: anchor.y + 120 }
      : { x: bounds.minX + 110 + index * 110, y: bounds.maxY + 100 }));
  });
  return map;
}

function storedPortPosition(port: CircuitPort): CircuitPosition | null {
  const position = port.position;
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  return snapPoint(position);
}

export function portRenderSide(
  document: SchematicDocument,
  port: CircuitPort,
  position: CircuitPosition,
): SchematicPortSide {
  if (isGroundPort(port)) return 'bottom';
  if (port.signal_type === 'power') return 'top';
  if (port.direction === 'output') return 'right';
  const pinPoints = document.module.components.flatMap((component) => (
    component.pins.flatMap((pin, index) => (
      pin.net === port.net ? [pinWorld(component, pin, index)] : []
    ))
  ));
  if (pinPoints.length === 0) return 'left';
  const nearest = pinPoints.reduce((best, point) => {
    const pointDx = position.x - point.x;
    const pointDy = position.y - point.y;
    const bestDx = position.x - best.x;
    const bestDy = position.y - best.y;
    return pointDx * pointDx + pointDy * pointDy < bestDx * bestDx + bestDy * bestDy ? point : best;
  });
  const dx = position.x - nearest.x;
  const dy = position.y - nearest.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

export function portInteractionBounds(position: CircuitPosition, side: SchematicPortSide): SchematicBounds {
  if (side === 'right') return { minX: position.x - 12, minY: position.y - 34, maxX: position.x + 94, maxY: position.y + 34 };
  if (side === 'left') return { minX: position.x - 94, minY: position.y - 34, maxX: position.x + 12, maxY: position.y + 34 };
  if (side === 'top') return { minX: position.x - 48, minY: position.y - 70, maxX: position.x + 48, maxY: position.y + 12 };
  return { minX: position.x - 48, minY: position.y - 12, maxX: position.x + 80, maxY: position.y + 58 };
}

export function isSchematicPortVisible(document: SchematicDocument, port: CircuitPort): boolean {
  return portVisibleForNetLabels(document.netLabels, port);
}

/**
 * Ports render even while unconnected (dimmed) so users can see and wire them;
 * rail ports stay hidden whenever the rail already renders as net-label stubs.
 */
function portVisibleForNetLabels(netLabels: SchematicNetLabel[], port: CircuitPort): boolean {
  const isRailPort = isGroundPort(port) || port.signal_type === 'power';
  return !isRailPort || !netLabels.some((label) => label.net === port.net);
}

/**
 * Block-like symbols (MCU / module instances) park a signal port beside the
 * body edge that actually carries the net's pins. The sheet-center heuristic
 * otherwise drops the port behind a wide block, so every fan-out wire wraps
 * around the body and converges on one congested vertical channel.
 */
function blockEdgePortSide(module: CircuitModule, port: CircuitPort): SignalPortSide | null {
  let leftPins = 0;
  let rightPins = 0;
  for (const component of module.components) {
    if (!isBlockLike(component)) continue;
    component.pins.forEach((pin, index) => {
      if (pin.no_connect || pin.net !== port.net) return;
      // Block pins carry an explicit edge assignment; only left/right edges
      // vote. Pins without a side fall back to the horizontal offset sign.
      if (pin.side === 'right') {
        rightPins += 1;
        return;
      }
      if (pin.side === 'left') {
        leftPins += 1;
        return;
      }
      if (pin.side === 'top' || pin.side === 'bottom') return;
      const point = pinWorld(component, pin, index);
      const dx = point.x - component.position.x;
      if (dx > 0) rightPins += 1;
      else if (dx < 0) leftPins += 1;
    });
  }
  if (rightPins > leftPins) return 'right';
  if (leftPins > rightPins) return 'left';
  return null;
}

function signalPortSide(port: CircuitPort, points: CircuitPosition[], bounds: SchematicBounds): SignalPortSide {
  if (points.length === 0) return port.direction === 'output' ? 'right' : 'left';
  if (port.direction === 'output') return 'right';
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const anchor = leftmost(points);
  if (!anchor) return 'left';
  return anchor.x > centerX + SCHEMATIC_GRID ? 'right' : 'left';
}

function activeControlInputPortSide(module: CircuitModule, port: CircuitPort): SignalPortSide | null {
  if (port.direction !== 'input') return null;
  const sides = module.components
    .filter((component) => component.type === 'M' || component.type === 'Q')
    .flatMap((component) => component.pins.map((pin, index) => ({ component, pin, index })))
    .filter(({ pin }) => pin.net === port.net && activeControlPinName(pin))
    .map(({ component, pin, index }): SignalPortSide => (
      pinWorld(component, pin, index).x <= component.position.x ? 'left' : 'right'
    ));
  if (sides.length === 0) return null;
  return sides.every((side) => side === sides[0]) ? sides[0]! : null;
}

function activeControlPinName(pin: CircuitPin): boolean {
  const key = `${pin.id} ${pin.name}`.toLowerCase();
  return /gate|\bg\b|base|\bb\b/.test(key);
}

function isDifferentialOutputPort(module: CircuitModule, port: CircuitPort): boolean {
  if (port.direction !== 'output') return false;
  const activeCount = module.components.filter((component) => component.type === 'M' || component.type === 'Q').length;
  if (activeCount < 2) return false;
  const text = `${port.id} ${port.name} ${port.net}`.toLowerCase();
  return /\bout[+-]?\b|outp|outn|output[+-]?/.test(text) && /[+-]|outp|outn/.test(text);
}

function differentialOutputPortPreferredY(
  port: CircuitPort,
  points: CircuitPosition[],
  fallbackY: number,
  fallbackIndex: number,
): number {
  const top = topmost(points)?.y ?? fallbackY;
  const text = `${port.id} ${port.name} ${port.net}`.toLowerCase();
  if (/[+]|\boutp\b/.test(text)) return top - SCHEMATIC_GRID;
  if (/[-]|\boutn\b/.test(text)) return top + SCHEMATIC_GRID * 3;
  return top + fallbackIndex * SCHEMATIC_GRID * 3;
}

function avoidPortY(preferredY: number, x: number, usedPositions: CircuitPosition[]): number {
  let y = preferredY;
  const minGap = SCHEMATIC_GRID * 3;
  for (
    let guard = 0;
    guard < 20 && usedPositions.some((used) => portPositionConflicts({ x, y }, used, minGap));
    guard += 1
  ) {
    y += minGap;
  }
  return y;
}

function portPositionConflicts(left: CircuitPosition, right: CircuitPosition, minYGap: number): boolean {
  return Math.abs(left.x - right.x) < SCHEMATIC_GRID * 7 && Math.abs(left.y - right.y) < minYGap;
}

/**
 * Block fan-out ports hug their own pin row: search outward from the pin's
 * y in both directions (one-way cascades drift ports hundreds of px away
 * from their pins and force long wrap-around routes).
 */
function avoidBlockEdgePortY(
  module: CircuitModule,
  port: CircuitPort,
  x: number,
  preferredY: number,
  usedPositions: CircuitPosition[],
): number {
  const minGap = SCHEMATIC_GRID * 2;
  const offsets = [0, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 8, -8, 10, -10, 12, -12].map((step) => step * SCHEMATIC_GRID);
  for (const offset of offsets) {
    const y = snap(preferredY + offset);
    if (usedPositions.some((used) => portPositionConflicts({ x, y }, used, minGap))) continue;
    if (!signalPortPointBlocked(module, port, { x, y })) return y;
  }
  return snap(preferredY);
}

function avoidSignalPortY(
  module: CircuitModule,
  port: CircuitPort,
  x: number,
  preferredY: number,
  usedPositions: CircuitPosition[],
): number {
  const baseY = avoidPortY(preferredY, x, usedPositions);
  const offsets = [0, 3, -3, 5, -5, 7, -7, 9, -9, 12, -12].map((step) => step * SCHEMATIC_GRID);
  for (const offset of offsets) {
    const y = snap(baseY + offset);
    if (usedPositions.some((used) => portPositionConflicts({ x, y }, used, SCHEMATIC_GRID * 3))) continue;
    if (!signalPortPointBlocked(module, port, { x, y })) return y;
  }
  return snap(baseY);
}

function signalPortPointBlocked(module: CircuitModule, port: CircuitPort, point: CircuitPosition): boolean {
  return module.components.some((component) => {
    if (component.pins.some((pin) => pin.net === port.net)) return false;
    const bounds = padBounds(componentBounds(component), ROUTE_OBSTACLE_PADDING);
    return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
  });
}

/**
 * Keep-out box for a net label's rendered TEXT only (glyph/stub excluded):
 * foreign routes must not slide under the text, but a wire passing beside a
 * rail glyph stays legal so existing fan-out topologies are preserved.
 */
function netLabelRouteObstacle(label: SchematicNetLabel): NetRouteObstacle {
  const halfTextWidth = label.name.length * 4 + 8;
  const text = netLabelTextAnchor(label);
  const minY = text.y - 13;
  const maxY = text.y + 5;
  if (text.anchor === 'start') {
    return { minX: text.x - 2, maxX: text.x + halfTextWidth * 2, minY, maxY, net: label.net };
  }
  if (text.anchor === 'end') {
    return { minX: text.x - halfTextWidth * 2, maxX: text.x + 2, minY, maxY, net: label.net };
  }
  return {
    minX: text.x - halfTextWidth,
    maxX: text.x + halfTextWidth,
    minY,
    maxY,
    net: label.net,
  };
}

/** Length of the stub drawn from the attachment point of a signal net label. */
export const SIGNAL_LABEL_STUB = 34;

/** Default baseline/anchor of a net label's text, mirroring the SVG label renderers. */
export function netLabelTextAnchor(label: SchematicNetLabel): SchematicTextPlacement {
  const { position } = label;
  if (label.kind === 'power') return { x: position.x, y: position.y - 18, anchor: 'middle' };
  if (label.kind === 'ground') return { x: position.x, y: position.y + 54, anchor: 'middle' };
  const side = label.side ?? 'right';
  const stub = SIGNAL_LABEL_STUB;
  const endX = position.x + (side === 'left' ? -stub : side === 'right' ? stub : 0);
  const endY = position.y + (side === 'top' ? -stub : side === 'bottom' ? stub : 0);
  if (side === 'left') return { x: endX - 6, y: endY + 4, anchor: 'end' };
  if (side === 'right') return { x: endX + 6, y: endY + 4, anchor: 'start' };
  if (side === 'top') return { x: endX, y: endY - 8, anchor: 'middle' };
  return { x: endX, y: endY + 18, anchor: 'middle' };
}

/** Default anchor of a port's name text, mirroring the SVG port renderer. */
export function portNamePosition(position: CircuitPosition, side: SchematicPortSide): SchematicTextPlacement {
  if (side === 'right') {
    return { x: position.x + 50, y: position.y - 4, anchor: 'start' };
  }
  if (side === 'left') {
    return { x: position.x - 50, y: position.y - 4, anchor: 'end' };
  }
  if (side === 'top') {
    return { x: position.x, y: position.y - 54, anchor: 'middle' };
  }
  return { x: position.x + 12, y: position.y + 38, anchor: 'start' };
}

/** Default anchors of a component's Reference (name) and Value texts. */
export function componentLabelPositions(component: CircuitComponent): {
  name: SchematicTextPlacement;
  value: SchematicTextPlacement;
} {
  const { x, y } = component.position;
  const rotation = ((component.rotation ?? 0) % 360 + 360) % 360;
  const isVerticalTwoPin = component.pins.length === 2 && (rotation === 90 || rotation === 270);
  // Gate-drive V/I sources sit left of MOSFET gates. Keep their text on the upper-left so
  // long PULSE(...) strings do not collide with the local GND stub under the negative pin.
  if (isVerticalTwoPin) {
    return {
      name: { x: x - 46, y: y - 28, anchor: 'end' },
      value: { x: x - 46, y: y - 6, anchor: 'end' },
    };
  }
  if (component.type === 'M') {
    // Name above the outline; value to the right of the channel so bottom rail stubs stay clear
    // and side-by-side MOS stages do not stack value text on neighboring gate drivers.
    return {
      name: { x, y: y - 66, anchor: 'middle' },
      value: { x: x + 52, y: y + 8, anchor: 'start' },
    };
  }
  if (component.type === 'Q') {
    return {
      name: { x: x + 52, y: y - 52, anchor: 'start' },
      value: { x: x + 52, y: y + 58, anchor: 'start' },
    };
  }
  if (component.type === 'E') {
    return {
      name: { x: x + 8, y: y - 70, anchor: 'middle' },
      value: { x: x + 8, y: y + 78, anchor: 'middle' },
    };
  }
  if ((component.type === 'BLOCK' || component.type === 'MODULE')) {
    const { height } = blockBodySize(component);
    return {
      name: { x, y: y - height / 2 - 18, anchor: 'middle' },
      value: { x, y, anchor: 'middle' },
    };
  }
  if ((component.type === 'V' || component.type === 'I') && (component.value ?? '').length > 14) {
    return {
      name: { x: x + 46, y: y - 22, anchor: 'start' },
      value: { x: x + 46, y: y + 24, anchor: 'start' },
    };
  }
  return {
    name: { x, y: y - 42, anchor: 'middle' },
    value: { x, y: y + 44, anchor: 'middle' },
  };
}

/** Compact long SPICE sources so canvas labels stay readable without changing stored values. */
export function displayComponentValue(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (!text) return '';
  if (text.length <= 22) return text;
  const pulse = text.match(/^PULSE\s*\(/i);
  if (pulse) return 'PULSE(...)';
  const pwl = text.match(/^PWL\s*\(/i);
  if (pwl) return 'PWL(...)';
  const sin = text.match(/^SIN\s*\(/i);
  if (sin) return 'SIN(...)';
  const exp = text.match(/^EXP\s*\(/i);
  if (exp) return 'EXP(...)';
  return `${text.slice(0, 20)}…`;
}

/**
 * One rendered text run that participates in label collision resolution.
 * `defaultPlacement` is the anchor the renderer would use without avoidance;
 * `placement` applies the resolved override from `document.labelPlacements`.
 */
export interface SchematicTextItem {
  key: string;
  kind: 'netlabel' | 'port' | 'component-name' | 'component-value';
  text: string;
  fontSize: number;
  defaultPlacement: SchematicTextPlacement;
  placement: SchematicTextPlacement;
  /** Owning net label / port side, used to keep avoidance candidates attached. */
  label?: SchematicNetLabel;
  portSide?: SchematicPortSide;
}

/**
 * Every visible text run of the projection, in the stable order used by the
 * placement resolver: wire-attached net labels first (least freedom), then
 * port labels, then component Reference and Value texts (most freedom).
 */
export function collectSchematicTextItems(document: SchematicDocument): SchematicTextItem[] {
  const items: SchematicTextItem[] = [];
  const apply = (
    item: Omit<SchematicTextItem, 'placement'>,
  ) => {
    items.push({ ...item, placement: document.labelPlacements.get(item.key) ?? item.defaultPlacement });
  };
  for (const label of document.netLabels) {
    apply({
      key: `netlabel:${label.id}`,
      kind: 'netlabel',
      text: label.name,
      fontSize: NET_LABEL_FONT_SIZE,
      defaultPlacement: netLabelTextAnchor(label),
      label,
    });
  }
  for (const port of document.module.ports) {
    const position = document.portPositions.get(port.id);
    if (!position || !isSchematicPortVisible(document, port)) continue;
    const side = portRenderSide(document, port, position);
    apply({
      key: `port:${port.id}`,
      kind: 'port',
      text: port.name,
      fontSize: PORT_LABEL_FONT_SIZE,
      defaultPlacement: portNamePosition(position, side),
      portSide: side,
    });
  }
  for (const component of document.module.components) {
    const labels = componentLabelPositions(component);
    if (component.type !== 'GND') {
      apply({
        key: `component:${component.id}:name`,
        kind: 'component-name',
        text: component.name,
        fontSize: COMPONENT_NAME_FONT_SIZE,
        defaultPlacement: labels.name,
      });
    }
    if (component.type !== 'BLOCK' && component.type !== 'MODULE' && component.type !== 'GND') {
      const value = displayComponentValue(component.value);
      if (value) {
        apply({
          key: `component:${component.id}:value`,
          kind: 'component-value',
          text: value,
          fontSize: COMPONENT_VALUE_FONT_SIZE,
          defaultPlacement: labels.value,
        });
      }
    }
  }
  return items;
}

function samePlacement(left: SchematicTextPlacement, right: SchematicTextPlacement): boolean {
  return left.x === right.x && left.y === right.y && left.anchor === right.anchor;
}

/**
 * Ordered avoidance candidates for one text item. Wire-attached labels only
 * slide along their own stub axis, flip to the other side of it, or step
 * perpendicular by whole grids, so the text never detaches from its wire;
 * component texts step on the grid freely. The first candidate is always the
 * default anchor.
 */
function labelPlacementCandidates(item: SchematicTextItem): SchematicTextPlacement[] {
  const base = item.defaultPlacement;
  const grid = SCHEMATIC_GRID;
  const at = (dx: number, dy: number): SchematicTextPlacement => ({ x: base.x + dx, y: base.y + dy, anchor: base.anchor });
  if (item.kind === 'netlabel' && item.label) {
    const label = item.label;
    if (label.kind === 'power') {
      return [at(0, 0), at(0, -grid), at(0, -2 * grid), at(0, -3 * grid), at(-grid, 0), at(grid, 0)];
    }
    if (label.kind === 'ground') {
      return [at(0, 0), at(0, grid), at(0, 2 * grid), at(0, 3 * grid), at(-grid, 0), at(grid, 0)];
    }
    const side = label.side ?? 'right';
    if (side === 'left' || side === 'right') {
      const dir = side === 'left' ? -1 : 1;
      return [
        at(0, 0),
        at(0, -grid), at(0, grid),
        at(0, -2 * grid), at(0, 2 * grid),
        at(dir * grid, 0), at(dir * 2 * grid, 0),
        at(dir * grid, -grid), at(dir * grid, grid),
      ];
    }
    const dir = side === 'top' ? -1 : 1;
    return [
      at(0, 0),
      at(-grid, 0), at(grid, 0),
      at(-2 * grid, 0), at(2 * grid, 0),
      at(0, dir * grid), at(0, dir * 2 * grid),
    ];
  }
  if (item.kind === 'port' && item.portSide) {
    const side = item.portSide;
    if (side === 'left' || side === 'right') {
      const outward = side === 'left' ? -1 : 1;
      return [
        at(0, 0),
        at(0, -grid), at(0, grid),
        at(0, -2 * grid), at(0, 2 * grid),
        at(outward * grid, 0), at(outward * 2 * grid, 0),
      ];
    }
    if (side === 'top') {
      return [at(0, 0), at(-grid, 0), at(grid, 0), at(0, -grid), at(0, -2 * grid)];
    }
    return [at(0, 0), at(0, grid), at(0, 2 * grid), at(-grid, 0), at(grid, 0)];
  }
  return [
    at(0, 0),
    at(0, -grid), at(0, grid),
    at(-grid, 0), at(grid, 0),
    at(0, -2 * grid), at(0, 2 * grid),
    at(-2 * grid, 0), at(2 * grid, 0),
    at(0, -3 * grid), at(-3 * grid, 0), at(3 * grid, 0), at(0, 3 * grid),
  ];
}

function boundsOverlap(left: SchematicBounds, right: SchematicBounds): boolean {
  return left.minX < right.maxX && left.maxX > right.minX && left.minY < right.maxY && left.maxY > right.minY;
}

/**
 * Deterministic label placement: walk all text runs in a stable order, try
 * each candidate offset in a fixed order, and take the first one whose
 * approximated text box collides with nothing already placed (falling back to
 * the least-colliding candidate when every option overlaps). Same module in,
 * same layout out. Only non-default anchors are recorded.
 */
export function resolveSchematicLabelPlacements(
  document: SchematicDocument,
): Map<string, SchematicTextPlacement> {
  const placements = new Map<string, SchematicTextPlacement>();
  const placed: SchematicBounds[] = [];
  const collisionCount = (item: SchematicTextItem, candidate: SchematicTextPlacement) => {
    const box = schematicTextBounds(item.text, item.fontSize, candidate.x, candidate.y, candidate.anchor);
    return placed.filter((other) => boundsOverlap(box, other)).length;
  };
  for (const item of collectSchematicTextItems(document)) {
    const candidates = labelPlacementCandidates(item);
    let best = candidates[0]!;
    let bestCollisions = collisionCount(item, best);
    for (let index = 1; index < candidates.length && bestCollisions > 0; index += 1) {
      const candidate = candidates[index]!;
      const collisions = collisionCount(item, candidate);
      if (collisions < bestCollisions) {
        best = candidate;
        bestCollisions = collisions;
      }
    }
    if (!samePlacement(best, item.defaultPlacement)) {
      placements.set(item.key, best);
    }
    placed.push(schematicTextBounds(item.text, item.fontSize, best.x, best.y, best.anchor));
  }
  return placements;
}

export function moduleBounds(
  module: CircuitModule,
  portPositions: Map<string, CircuitPosition>,
  wires: CircuitWire[],
  netLabels: SchematicNetLabel[] = [],
): SchematicBounds {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const component of module.components) {
    const bounds = componentBounds(component);
    xs.push(bounds.minX, bounds.maxX);
    ys.push(bounds.minY, bounds.maxY);
  }
  for (const wire of wires) {
    for (const point of wire.points ?? []) {
      xs.push(point.x);
      ys.push(point.y);
    }
  }
  for (const point of portPositions.values()) {
    xs.push(point.x - 110, point.x + 120);
    ys.push(point.y - 80, point.y + 80);
  }
  for (const label of netLabels) {
    xs.push(label.position.x - 72, label.position.x + 72);
    ys.push(label.position.y - 58, label.position.y + 58);
  }
  if (xs.length === 0) {
    xs.push(0, 600);
    ys.push(0, 360);
  }
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

export function padBounds(bounds: SchematicBounds, padding: number): SchematicBounds {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  };
}

function viewBoxPadding(bounds: SchematicBounds): number {
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const scaled = Math.round((span * 0.06) / SCHEMATIC_GRID) * SCHEMATIC_GRID;
  return Math.max(36, Math.min(70, scaled));
}

export function isGroundPort(port: CircuitPort): boolean {
  const text = `${port.name} ${port.net} ${port.signal_type}`.toLowerCase();
  return port.signal_type === 'ground' || text.includes('gnd') || port.net === '0';
}

export function isPmosComponent(component: CircuitComponent): boolean {
  return /pmos|pfet|p-channel|p channel|\bp\b/i.test(`${component.id} ${component.name} ${component.value}`);
}

export function endpointKey(endpoint: CircuitWireEndpoint | undefined): string | null {
  if (!endpoint) return null;
  if (endpoint.component_id && endpoint.pin_id) return `c:${endpoint.component_id}:${endpoint.pin_id}`;
  if (endpoint.port_id) return `p:${endpoint.port_id}`;
  if (endpoint.junction_id) return `j:${endpoint.junction_id}`;
  return null;
}

export function endpointNet(module: CircuitModule, endpoint: CircuitWireEndpoint | undefined): string | null {
  if (!endpoint) return null;
  const transientNet = (endpoint as EndpointHit).net;
  if (transientNet) return transientNet;
  if (endpoint.component_id && endpoint.pin_id) {
    const component = module.components.find((entry) => entry.id === endpoint.component_id);
    return component?.pins.find((pin) => pin.id === endpoint.pin_id)?.net ?? null;
  }
  if (endpoint.port_id) {
    return module.ports.find((port) => port.id === endpoint.port_id)?.net ?? null;
  }
  if (endpoint.junction_id) {
    return module.wires.find((wire) => (
      wire.from?.junction_id === endpoint.junction_id || wire.to?.junction_id === endpoint.junction_id
    ))?.net ?? null;
  }
  return null;
}

export function ensureStableNetModel(module: CircuitModule): CircuitModule {
  const existing = new Map((module.nets ?? []).map((net) => [net.id, net]));
  const byName = new Map<string, string>();
  for (const net of existing.values()) {
    byName.set(net.name, net.id);
    for (const alias of net.aliases ?? []) byName.set(alias, net.id);
  }
  const usedIds = new Set(existing.keys());
  const ensure = (name: string, currentId?: string): string => {
    if (currentId && existing.has(currentId)) {
      const current = existing.get(currentId);
      if (current?.name === name || current?.aliases?.includes(name)) return currentId;
    }
    const known = byName.get(name);
    if (known) return known;
    const base = `net_${wireIdToken(name)}`;
    let id = base;
    let suffix = 2;
    while (usedIds.has(id)) id = `${base}_${suffix++}`;
    usedIds.add(id);
    existing.set(id, { id, name, kind: name === '0' ? 'ground' : 'signal', aliases: [] });
    byName.set(name, id);
    return id;
  };
  for (const component of module.components) {
    for (const pin of component.pins) pin.net_id = ensure(pin.net, pin.net_id);
  }
  for (const port of module.ports) {
    port.net_id = ensure(port.net, port.net_id);
    const net = existing.get(port.net_id);
    if (net && (net.kind === 'signal' || !net.kind)) net.kind = port.signal_type;
  }
  for (const wire of module.wires ?? []) wire.net_id = ensure(wire.net ?? `n_${wire.id}`, wire.net_id);
  const junctionIds = new Set<string>();
  const junctionByCoordinate = new Map<string, string>();
  for (const wire of module.wires ?? []) {
    for (const endpoint of [wire.from, wire.to]) {
      if (!endpoint?.junction_id) continue;
      junctionIds.add(endpoint.junction_id);
      junctionByCoordinate.set(`${wire.net_id}:${roundCoordinate(endpoint.x)},${roundCoordinate(endpoint.y)}`, endpoint.junction_id);
    }
  }
  for (const wire of module.wires ?? []) {
    for (const endpoint of [wire.from, wire.to]) {
      if (!endpoint || endpointKey(endpoint)) continue;
      const coordinateKey = `${wire.net_id}:${roundCoordinate(endpoint.x)},${roundCoordinate(endpoint.y)}`;
      const junctionId = junctionByCoordinate.get(coordinateKey) ?? makeId('j', junctionIds);
      endpoint.junction_id = junctionId;
      junctionIds.add(junctionId);
      junctionByCoordinate.set(coordinateKey, junctionId);
    }
  }
  module.nets = [...existing.values()];
  module.schema = 'actoviq.module.v2';
  return module;
}

function endpointNetId(module: CircuitModule, endpoint: CircuitWireEndpoint | undefined): string | null {
  if (!endpoint) return null;
  const transientNetId = (endpoint as EndpointHit).net_id;
  if (transientNetId) return transientNetId;
  if (endpoint.component_id && endpoint.pin_id) {
    return module.components
      .find((entry) => entry.id === endpoint.component_id)
      ?.pins.find((pin) => pin.id === endpoint.pin_id)?.net_id ?? null;
  }
  if (endpoint.port_id) return module.ports.find((port) => port.id === endpoint.port_id)?.net_id ?? null;
  if (endpoint.junction_id) {
    return module.wires.find((wire) => (
      wire.from?.junction_id === endpoint.junction_id || wire.to?.junction_id === endpoint.junction_id
    ))?.net_id ?? null;
  }
  return null;
}

function syntheticNetName(name: string): boolean {
  return /^(n|net|node)(?:[_-]|\d|$)/i.test(name);
}

function mergeStableNets(
  module: CircuitModule,
  leftId: string | null,
  rightId: string | null,
): { id: string; name: string } {
  ensureStableNetModel(module);
  const nets = module.nets ?? [];
  const left = nets.find((net) => net.id === leftId);
  const right = nets.find((net) => net.id === rightId);
  if (!left && !right) {
    const existingNames = new Set(nets.map((net) => net.name));
    let index = 1;
    while (existingNames.has(`n_wire_${index}`)) index += 1;
    const name = `n_wire_${index}`;
    const id = makeId('net_wire_', new Set(nets.map((net) => net.id)));
    nets.push({ id, name, kind: 'signal', aliases: [] });
    return { id, name };
  }
  if (!left || !right || left.id === right.id) {
    const only = left ?? right!;
    return { id: only.id, name: only.name };
  }
  const score = (net: typeof left): number => {
    if (!net) return -1;
    if (net.name === '0' || net.kind === 'ground') return 100;
    if (net.kind === 'power') return 80;
    if (!syntheticNetName(net.name)) return 40;
    return 10;
  };
  const primary = score(left) > score(right) || (score(left) === score(right) && left.name.localeCompare(right.name) <= 0)
    ? left
    : right;
  const secondary = primary.id === left.id ? right : left;
  const aliases = new Set([...(primary.aliases ?? []), secondary.name, ...(secondary.aliases ?? [])]);
  aliases.delete(primary.name);
  primary.aliases = [...aliases].sort();
  primary.conflict = primary.conflict || secondary.conflict || (
    !syntheticNetName(primary.name) && !syntheticNetName(secondary.name) && primary.name !== secondary.name
  );
  for (const component of module.components) {
    for (const pin of component.pins) {
      if (pin.net_id === secondary.id) {
        pin.net_id = primary.id;
        pin.net = primary.name;
      }
    }
  }
  for (const port of module.ports) {
    if (port.net_id === secondary.id) {
      port.net_id = primary.id;
      port.net = primary.name;
    }
  }
  for (const wire of module.wires ?? []) {
    if (wire.net_id === secondary.id) {
      wire.net_id = primary.id;
      wire.net = primary.name;
    }
  }
  module.nets = nets.filter((net) => net.id !== secondary.id);
  return { id: primary.id, name: primary.name };
}

export function replaceNet(module: CircuitModule, oldNet: string, newNet: string) {
  if (oldNet === newNet) return;
  for (const component of module.components) {
    for (const pin of component.pins) {
      if (pin.net === oldNet) pin.net = newNet;
    }
  }
  for (const port of module.ports) {
    if (port.net === oldNet) port.net = newNet;
  }
  for (const wire of module.wires ?? []) {
    if (wire.net === oldNet) wire.net = newNet;
  }
}

export function chooseMergedNet(left: string | null, right: string | null): string {
  if (left === '0' || right === '0') return '0';
  return left || right || `n_${Date.now()}`;
}

export function addWire(
  module: CircuitModule,
  start: EndpointHit,
  end: EndpointHit,
  visibleWires: CircuitWire[] = [],
): EndpointHit | null {
  ensureStableNetModel(module);
  const attachedStart = ensureWireNode(module, start, visibleWires);
  // Reserve the start junction so two fresh free endpoints in the same commit
  // never collide on one id (a wire's two endpoints are distinct graph nodes).
  const attachedEnd = ensureWireNode(
    module,
    end,
    visibleWires,
    attachedStart.junction_id ? new Set([attachedStart.junction_id]) : undefined,
  );
  const startPoint = endpointDrawPoint(attachedStart);
  const endPoint = endpointDrawPoint(attachedEnd);
  if (sameCoordinate(startPoint, endPoint)) return null;
  const leftNet = endpointNet(module, attachedStart);
  const rightNet = endpointNet(module, attachedEnd);
  const merged = mergeStableNets(module, endpointNetId(module, attachedStart), endpointNetId(module, attachedEnd));
  const mergedNet = merged.name || chooseMergedNet(leftNet, rightNet);
  const id = makeId('w', new Set((module.wires ?? []).map((wire) => wire.id)));
  const from = stripEndpoint(startPoint, attachedStart);
  const to = stripEndpoint(endPoint, attachedEnd);
  const pair = [endpointKey(from), endpointKey(to)].sort().join('<->');
  const duplicate = module.wires.some((wire) => (
    [endpointKey(wire.from), endpointKey(wire.to)].sort().join('<->') === pair
  ));
  if (!duplicate) {
    module.wires.push({
      id,
      points: routePointsForModule(
        module,
        startPoint,
        endPoint,
        attachedStart,
        attachedEnd,
        mergedNet,
        module.wires,
      ),
      from,
      to,
      net: mergedNet,
      net_id: merged.id,
      source: 'stored',
    });
  }
  return {
    ...attachedEnd,
    kind: attachedEnd.kind === 'point' ? 'junction' : attachedEnd.kind,
    net: mergedNet,
    net_id: merged.id,
  };
}

function ensureWireNode(
  module: CircuitModule,
  endpoint: EndpointHit,
  visibleWires: CircuitWire[],
  reservedJunctionIds?: ReadonlySet<string>,
): EndpointHit {
  if (endpoint.kind === 'pin' || endpoint.kind === 'port' || endpoint.junction_id) return endpoint;
  if (endpoint.wire_id) {
    let wire = module.wires.find((entry) => entry.id === endpoint.wire_id);
    if (!wire) {
      const visible = visibleWires.find((entry) => entry.id === endpoint.wire_id);
      if (visible) {
        const existingIds = new Set(module.wires.map((entry) => entry.id));
        wire = {
          ...cloneWireRecord(visible),
          id: existingIds.has(visible.id) ? makeId('w', existingIds) : visible.id,
          source: 'stored',
        };
        const net = module.nets?.find((entry) => entry.id === visible.net_id)
          ?? module.nets?.find((entry) => entry.name === visible.net);
        wire.net = net?.name ?? visible.net;
        wire.net_id = net?.id;
        module.wires.push(wire);
        ensureStableNetModel(module);
      }
    }
    if (wire) return splitWireAtNode(module, wire, endpointDrawPoint(endpoint));
  }
  const point = endpointDrawPoint(endpoint);
  return {
    ...endpoint,
    kind: 'junction',
    x: point.x,
    y: point.y,
    junction_id: makeJunctionId(module, reservedJunctionIds),
  };
}

function splitWireAtNode(module: CircuitModule, wire: CircuitWire, point: CircuitPosition): EndpointHit {
  const snappedPoint = snapPoint(point);
  const points = compactRoute(wire.points.map((entry) => ({ ...entry })));
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return pointEndpoint(snappedPoint);
  if (sameCoordinate(snappedPoint, first)) {
    return bindWireEndpointToNode(module, wire, 'from', snappedPoint);
  }
  if (sameCoordinate(snappedPoint, last)) {
    return bindWireEndpointToNode(module, wire, 'to', snappedPoint);
  }

  let segmentIndex = -1;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (start && end && pointToSegmentDistance(snappedPoint, start, end) < 0.5) {
      segmentIndex = index;
      break;
    }
  }
  if (segmentIndex < 1) return pointEndpoint(snappedPoint);

  const junctionId = makeJunctionId(module);
  const junction = junctionEndpoint(snappedPoint, junctionId);
  const leftPoints = compactRoute([...points.slice(0, segmentIndex), snappedPoint]);
  const rightPoints = compactRoute([snappedPoint, ...points.slice(segmentIndex)]);
  const rightId = makeId(`${wire.id}_`, new Set(module.wires.map((entry) => entry.id)));
  const originalTo = wire.to ? { ...wire.to } : { x: last.x, y: last.y, junction_id: makeJunctionId(module) };
  wire.points = leftPoints;
  wire.to = junction;
  wire.source = 'stored';
  module.wires.push({
    ...wire,
    id: rightId,
    points: rightPoints,
    from: { ...junction },
    to: originalTo,
    source: 'stored',
  });
  return {
    kind: 'junction',
    ...snappedPoint,
    junction_id: junctionId,
    label: wire.net ? `Junction ${wire.net}` : 'Junction',
    net: wire.net,
    net_id: wire.net_id,
  };
}

function bindWireEndpointToNode(
  module: CircuitModule,
  wire: CircuitWire,
  side: 'from' | 'to',
  point: CircuitPosition,
): EndpointHit {
  const current = wire[side];
  if (current?.component_id && current.pin_id) {
    const component = module.components.find((entry) => entry.id === current.component_id);
    const pin = component?.pins.find((entry) => entry.id === current.pin_id);
    if (component && pin) {
      return { kind: 'pin', ...current, label: `${component.name}.${pin.name}`, net: pin.net, net_id: pin.net_id };
    }
  }
  if (current?.port_id) {
    const port = module.ports.find((entry) => entry.id === current.port_id);
    if (port) return { kind: 'port', ...current, label: port.name, net: port.net, net_id: port.net_id };
  }
  const junctionId = current?.junction_id ?? makeJunctionId(module);
  const bound = junctionEndpoint(point, junctionId);
  wire[side] = bound;
  return {
    kind: 'junction',
    ...bound,
    label: wire.net ? `Junction ${wire.net}` : 'Junction',
    net: wire.net,
    net_id: wire.net_id,
  };
}

function junctionEndpoint(point: CircuitPosition, junctionId: string): CircuitWireEndpoint {
  return { x: point.x, y: point.y, junction_id: junctionId };
}

function makeJunctionId(module: CircuitModule, reservedIds: ReadonlySet<string> = new Set()): string {
  const ids = new Set<string>(reservedIds);
  for (const wire of module.wires) {
    if (wire.from?.junction_id) ids.add(wire.from.junction_id);
    if (wire.to?.junction_id) ids.add(wire.to.junction_id);
  }
  return makeId('j', ids);
}

function cloneWireRecord(wire: CircuitWire): CircuitWire {
  return {
    ...wire,
    points: wire.points.map((point) => ({ ...point })),
    from: wire.from ? { ...wire.from } : undefined,
    to: wire.to ? { ...wire.to } : undefined,
  };
}

function sameCoordinate(left: CircuitPosition, right: CircuitPosition): boolean {
  return Math.abs(left.x - right.x) < 0.001 && Math.abs(left.y - right.y) < 0.001;
}

export function removeWireAndUpdateConnectivity(module: CircuitModule, wireOrId: CircuitWire | string): CircuitModule {
  const next = cloneModule(module);
  const selectedWire = typeof wireOrId === 'string'
    ? next.wires?.find((wire) => wire.id === wireOrId)
    : wireOrId;
  const selectedId = typeof wireOrId === 'string' ? wireOrId : wireOrId.id;
  next.wires = (next.wires ?? []).filter((wire) => wire.id !== selectedId);
  if (selectedWire) splitNetAfterWireRemoval(next, selectedWire);
  return normalizeConnectivity(next);
}

export function routePoints(startPoint: CircuitPosition, endPoint: CircuitPosition): CircuitPosition[] {
  if (startPoint.x === endPoint.x || startPoint.y === endPoint.y) {
    return [startPoint, endPoint];
  }
  const horizontalFirst = Math.abs(endPoint.x - startPoint.x) >= Math.abs(endPoint.y - startPoint.y);
  return horizontalFirst
    ? [startPoint, { x: endPoint.x, y: startPoint.y }, endPoint]
    : [startPoint, { x: startPoint.x, y: endPoint.y }, endPoint];
}

function routePointsForModule(
  module: CircuitModule,
  startPoint: CircuitPosition,
  endPoint: CircuitPosition,
  startEndpoint?: CircuitWireEndpoint,
  endEndpoint?: CircuitWireEndpoint,
  net?: string,
  occupiedWires: CircuitWire[] = [],
  labelObstacles: NetRouteObstacle[] = [],
): CircuitPosition[] {
  // qucs-style: leave the owning symbol along the pin outward axis before any
  // Manhattan detour. Start/end components are excluded from obstacles so a
  // naive start→end fallback can cut straight through the body during drag;
  // egress stubs make that path illegal and keep previews pin-attached.
  const startExit = endpointOutwardStep(module, startEndpoint, startPoint);
  const endExit = endpointOutwardStep(module, endEndpoint, endPoint);
  const obstacles = obstaclesForEndpoints(module, startEndpoint, endEndpoint, net);
  const midCandidates = orthogonalRouteCandidates(startExit, endExit, obstacles);
  const candidates = [
    ...midCandidates.map((mid) => compactRoute([startPoint, ...mid, endPoint])),
    ...orthogonalRouteCandidates(startPoint, endPoint, obstacles),
  ];
  const clear = candidates.filter((points) => routeIsClear(points, obstacles));
  if (clear.length > 0) {
    return clear.sort((left, right) => (
      routeCost(left) + routeCrossingPenalty(left, net, occupiedWires) +
        routeLabelPenalty(left, net, labelObstacles) +
        routeEndpointEgressPenalty(module, left, startEndpoint, endEndpoint) -
      routeCost(right) - routeCrossingPenalty(right, net, occupiedWires) -
        routeLabelPenalty(right, net, labelObstacles) -
        routeEndpointEgressPenalty(module, right, startEndpoint, endEndpoint)
    ))[0] ?? clear[0]!;
  }
  return compactRoute([startPoint, startExit, ...routePoints(startExit, endExit), endExit, endPoint]);
}

/**
 * One grid step out of a component along its pin axis (orthogonal). Non-pin
 * endpoints stay put so junction/port anchors remain fixed while the moving
 * pin rubber-bands toward them (qucs selection.moveCenter / node sync).
 */
function endpointOutwardStep(
  module: CircuitModule,
  endpoint: CircuitWireEndpoint | undefined,
  point: CircuitPosition,
  distance = SCHEMATIC_GRID,
): CircuitPosition {
  if (!endpoint?.component_id || !endpoint.pin_id) return point;
  const component = module.components.find((entry) => entry.id === endpoint.component_id);
  const pinIndex = component?.pins.findIndex((pin) => pin.id === endpoint.pin_id) ?? -1;
  const pin = pinIndex >= 0 ? component?.pins[pinIndex] : undefined;
  if (!component || !pin) return point;
  const pinPoint = pinWorld(component, pin, pinIndex);
  // Block pins know their edge: on tall/wide symbols the position delta is
  // dominated by the long axis and would egress along the edge, not out of it.
  if (isBlockLike(component) && pin.side) {
    if (pin.side === 'right') return snapPoint({ x: point.x + distance, y: point.y });
    if (pin.side === 'left') return snapPoint({ x: point.x - distance, y: point.y });
    if (pin.side === 'top') return snapPoint({ x: point.x, y: point.y - distance });
    return snapPoint({ x: point.x, y: point.y + distance });
  }
  const outward = { x: pinPoint.x - component.position.x, y: pinPoint.y - component.position.y };
  if (Math.abs(outward.x) < 0.5 && Math.abs(outward.y) < 0.5) return point;
  if (Math.abs(outward.x) >= Math.abs(outward.y)) {
    return snapPoint({ x: point.x + Math.sign(outward.x) * distance, y: point.y });
  }
  return snapPoint({ x: point.x, y: point.y + Math.sign(outward.y) * distance });
}

function routeCrossingPenalty(points: CircuitPosition[], net: string | undefined, occupiedWires: CircuitWire[]): number {
  if (!net || occupiedWires.length === 0) return 0;
  let conflicts = 0;
  let proximity = 0;
  for (const wire of occupiedWires) {
    if (!wire.net || wire.net === net) continue;
    const occupiedPoints = wire.points ?? [];
    for (let leftIndex = 1; leftIndex < points.length; leftIndex += 1) {
      const leftStart = points[leftIndex - 1];
      const leftEnd = points[leftIndex];
      if (!leftStart || !leftEnd) continue;
      for (let rightIndex = 1; rightIndex < occupiedPoints.length; rightIndex += 1) {
        const rightStart = occupiedPoints[rightIndex - 1];
        const rightEnd = occupiedPoints[rightIndex];
        if (!rightStart || !rightEnd) continue;
        if (orthogonalSegmentsConflict(leftStart, leftEnd, rightStart, rightEnd)) {
          conflicts += 1;
        } else {
          // Hugging an occupied track (< 2 grid lanes away) spreads parallel fan-out
          // runs across distinct channels instead of gluing them into one bundle.
          proximity += parallelSegmentProximity(leftStart, leftEnd, rightStart, rightEnd);
        }
      }
    }
  }
  return conflicts * 1_000_000 + proximity;
}

/**
 * Overlap-length penalty for parallel segments of different nets running on
 * adjacent (but not coincident) tracks; coincident overlap is already a conflict.
 */
function parallelSegmentProximity(
  leftStart: CircuitPosition,
  leftEnd: CircuitPosition,
  rightStart: CircuitPosition,
  rightEnd: CircuitPosition,
): number {
  const leftVertical = leftStart.x === leftEnd.x;
  const rightVertical = rightStart.x === rightEnd.x;
  if (leftVertical !== rightVertical) return 0;
  if (!leftVertical && leftStart.y !== leftEnd.y) return 0;
  if (!rightVertical && rightStart.y !== rightEnd.y) return 0;
  const trackDistance = leftVertical
    ? Math.abs(leftStart.x - rightStart.x)
    : Math.abs(leftStart.y - rightStart.y);
  if (trackDistance === 0 || trackDistance >= SCHEMATIC_GRID * 2) return 0;
  const leftMin = leftVertical ? Math.min(leftStart.y, leftEnd.y) : Math.min(leftStart.x, leftEnd.x);
  const leftMax = leftVertical ? Math.max(leftStart.y, leftEnd.y) : Math.max(leftStart.x, leftEnd.x);
  const rightMin = leftVertical ? Math.min(rightStart.y, rightEnd.y) : Math.min(rightStart.x, rightEnd.x);
  const rightMax = leftVertical ? Math.max(rightStart.y, rightEnd.y) : Math.max(rightStart.x, rightEnd.x);
  const overlap = Math.min(leftMax, rightMax) - Math.max(leftMin, rightMin);
  return overlap > 0 ? overlap : 0;
}

function orthogonalSegmentsConflict(
  leftStart: CircuitPosition,
  leftEnd: CircuitPosition,
  rightStart: CircuitPosition,
  rightEnd: CircuitPosition,
): boolean {
  const leftVertical = leftStart.x === leftEnd.x;
  const rightVertical = rightStart.x === rightEnd.x;
  const leftHorizontal = leftStart.y === leftEnd.y;
  const rightHorizontal = rightStart.y === rightEnd.y;
  if (leftVertical && rightVertical) {
    return leftStart.x === rightStart.x &&
      Math.max(Math.min(leftStart.y, leftEnd.y), Math.min(rightStart.y, rightEnd.y)) <=
        Math.min(Math.max(leftStart.y, leftEnd.y), Math.max(rightStart.y, rightEnd.y));
  }
  if (leftHorizontal && rightHorizontal) {
    return leftStart.y === rightStart.y &&
      Math.max(Math.min(leftStart.x, leftEnd.x), Math.min(rightStart.x, rightEnd.x)) <=
        Math.min(Math.max(leftStart.x, leftEnd.x), Math.max(rightStart.x, rightEnd.x));
  }
  const verticalStart = leftVertical ? leftStart : rightVertical ? rightStart : null;
  const verticalEnd = leftVertical ? leftEnd : rightVertical ? rightEnd : null;
  const horizontalStart = leftHorizontal ? leftStart : rightHorizontal ? rightStart : null;
  const horizontalEnd = leftHorizontal ? leftEnd : rightHorizontal ? rightEnd : null;
  if (!verticalStart || !verticalEnd || !horizontalStart || !horizontalEnd) return false;
  return verticalStart.x >= Math.min(horizontalStart.x, horizontalEnd.x) &&
    verticalStart.x <= Math.max(horizontalStart.x, horizontalEnd.x) &&
    horizontalStart.y >= Math.min(verticalStart.y, verticalEnd.y) &&
    horizontalStart.y <= Math.max(verticalStart.y, verticalEnd.y);
}
/**
 * Soft keep-out for foreign net labels: a route that slides under another
 * net's label text is strongly discouraged but never forces the obstacle-
 * ignoring fallback (unlike a hard obstacle would).
 */
function routeLabelPenalty(
  points: CircuitPosition[],
  net: string | undefined,
  labelObstacles: NetRouteObstacle[],
): number {
  if (labelObstacles.length === 0) return 0;
  let hits = 0;
  for (const obstacle of labelObstacles) {
    if (net && obstacle.net === net) continue;
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      if (!start || !end) continue;
      if (segmentIntersectsBounds(start, end, obstacle)) {
        hits += 1;
        break;
      }
    }
  }
  return hits * 250_000;
}

function obstaclesForEndpoints(
  module: CircuitModule,
  startEndpoint?: CircuitWireEndpoint,
  endEndpoint?: CircuitWireEndpoint,
  net?: string,
): SchematicBounds[] {
  const excludedComponentIds = new Set(
    [startEndpoint?.component_id, endEndpoint?.component_id].filter(Boolean) as string[],
  );
  return [
    ...module.components
    .filter((component) => !excludedComponentIds.has(component.id))
    .map((component) => {
      const padding = net && component.pins.some((pin) => pin.net === net) ? 0 : ROUTE_OBSTACLE_PADDING;
      return padBounds(componentBounds(component), padding);
    }),
    ...(net ? otherNetCorridorObstacles(module, net) : []),
  ];
}

function otherNetCorridorObstacles(module: CircuitModule, currentNet: string): SchematicBounds[] {
  const pointsByNet = new Map<string, CircuitPosition[]>();
  const portNets = new Set(module.ports.map((port) => port.net));
  for (const component of module.components) {
    component.pins.forEach((pin, index) => {
      if (!pin.net || pin.net === currentNet || isRailNet(pin.net, module)) return;
      if (!portNets.has(pin.net)) return;
      const point = pinWorld(component, pin, index);
      pointsByNet.set(pin.net, [...(pointsByNet.get(pin.net) ?? []), point]);
    });
  }

  const obstacles: SchematicBounds[] = [];
  const alignmentTolerance = SCHEMATIC_GRID * 2;
  for (const points of pointsByNet.values()) {
    for (let leftIndex = 0; leftIndex < points.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < points.length; rightIndex += 1) {
        const left = points[leftIndex];
        const right = points[rightIndex];
        if (!left || !right) continue;
        const nearlyVertical = Math.abs(left.x - right.x) <= alignmentTolerance;
        const nearlyHorizontal = Math.abs(left.y - right.y) <= alignmentTolerance;
        if (!nearlyVertical && !nearlyHorizontal) continue;
        obstacles.push(padBounds({
          minX: Math.min(left.x, right.x),
          minY: Math.min(left.y, right.y),
          maxX: Math.max(left.x, right.x),
          maxY: Math.max(left.y, right.y),
        }, ROUTE_OBSTACLE_PADDING));
      }
    }
  }
  return obstacles;
}

function orthogonalRouteCandidates(
  startPoint: CircuitPosition,
  endPoint: CircuitPosition,
  obstacles: SchematicBounds[],
): CircuitPosition[][] {
  const candidates = [
    routePoints(startPoint, endPoint),
    [startPoint, { x: startPoint.x, y: endPoint.y }, endPoint],
    [startPoint, { x: endPoint.x, y: startPoint.y }, endPoint],
  ];
  const detourXs = new Set<number>();
  const detourYs = new Set<number>();
  for (const obstacle of obstacles) {
    for (const margin of [1, 2, 3]) {
      detourXs.add(snap(obstacle.minX - SCHEMATIC_GRID * margin));
      detourXs.add(snap(obstacle.maxX + SCHEMATIC_GRID * margin));
      detourYs.add(snap(obstacle.minY - SCHEMATIC_GRID * margin));
      detourYs.add(snap(obstacle.maxY + SCHEMATIC_GRID * margin));
    }
  }
  for (const x of detourXs) {
    candidates.push([startPoint, { x, y: startPoint.y }, { x, y: endPoint.y }, endPoint]);
  }
  for (const y of detourYs) {
    candidates.push([startPoint, { x: startPoint.x, y }, { x: endPoint.x, y }, endPoint]);
  }
  for (const x of detourXs) {
    for (const y of detourYs) {
      candidates.push([
        startPoint,
        { x, y: startPoint.y },
        { x, y },
        { x: endPoint.x, y },
        endPoint,
      ]);
      candidates.push([
        startPoint,
        { x: startPoint.x, y },
        { x, y },
        { x, y: endPoint.y },
        endPoint,
      ]);
    }
  }
  return candidates.map(compactRoute);
}

function compactRoute(points: CircuitPosition[]): CircuitPosition[] {
  const deduped: CircuitPosition[] = [];
  for (const point of points) {
    const previous = deduped.at(-1);
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    deduped.push(point);
  }
  return removeCollinearRoutePoints(orthogonalizeRoute(deduped));
}

function orthogonalizeRoute(points: CircuitPosition[]): CircuitPosition[] {
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
    routed.push(chooseRouteElbow(previous, point), point);
  }
  return routed;
}

function chooseRouteElbow(start: CircuitPosition, end: CircuitPosition): CircuitPosition {
  return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)
    ? { x: end.x, y: start.y }
    : { x: start.x, y: end.y };
}

function removeCollinearRoutePoints(points: CircuitPosition[]): CircuitPosition[] {
  if (points.length <= 2) return points;
  return points.filter((point, index) => {
    if (index === 0 || index === points.length - 1) return true;
    const previous = points[index - 1];
    const next = points[index + 1];
    if (!previous || !next) return true;
    return !(
      previous.x === point.x && point.x === next.x ||
      previous.y === point.y && point.y === next.y
    );
  });
}

function routeIsClear(points: CircuitPosition[], obstacles: SchematicBounds[]): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!start || !end) continue;
    if (obstacles.some((obstacle) => segmentIntersectsBounds(start, end, obstacle))) return false;
  }
  return true;
}

function segmentIntersectsBounds(start: CircuitPosition, end: CircuitPosition, bounds: SchematicBounds): boolean {
  if (start.x === end.x) {
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    return start.x >= bounds.minX && start.x <= bounds.maxX && maxY >= bounds.minY && minY <= bounds.maxY;
  }
  if (start.y === end.y) {
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    return start.y >= bounds.minY && start.y <= bounds.maxY && maxX >= bounds.minX && minX <= bounds.maxX;
  }
  return segmentIntersectsBounds(start, { x: end.x, y: start.y }, bounds) ||
    segmentIntersectsBounds({ x: end.x, y: start.y }, end, bounds);
}

function routeCost(points: CircuitPosition[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!start || !end) continue;
    length += Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
  }
  return length + points.length * 8;
}

function routeEndpointEgressPenalty(
  module: CircuitModule,
  points: CircuitPosition[],
  startEndpoint?: CircuitWireEndpoint,
  endEndpoint?: CircuitWireEndpoint,
): number {
  if (points.length < 2) return 0;
  const start = points[0];
  const startAdjacent = points[1];
  const end = points.at(-1);
  const endAdjacent = points.at(-2);
  if (!start || !startAdjacent || !end || !endAdjacent) return 0;
  return endpointBacktrackPenalty(module, startEndpoint, start, startAdjacent) +
    endpointBacktrackPenalty(module, endEndpoint, end, endAdjacent);
}

function endpointBacktrackPenalty(
  module: CircuitModule,
  endpoint: CircuitWireEndpoint | undefined,
  endpointPoint: CircuitPosition,
  adjacentPoint: CircuitPosition,
): number {
  if (!endpoint?.component_id || !endpoint.pin_id) return 0;
  const component = module.components.find((entry) => entry.id === endpoint.component_id);
  const pinIndex = component?.pins.findIndex((pin) => pin.id === endpoint.pin_id) ?? -1;
  const pin = pinIndex >= 0 ? component?.pins[pinIndex] : undefined;
  if (!component || !pin) return 0;
  const pinPoint = pinWorld(component, pin, pinIndex);
  const outward = { x: pinPoint.x - component.position.x, y: pinPoint.y - component.position.y };
  const route = { x: adjacentPoint.x - endpointPoint.x, y: adjacentPoint.y - endpointPoint.y };
  return outward.x * route.x + outward.y * route.y < 0 ? 10_000_000 : 0;
}

export function stripEndpoint(point: CircuitPosition, endpoint: EndpointHit): CircuitWireEndpoint {
  const value: CircuitWireEndpoint = { x: point.x, y: point.y };
  if (endpoint.component_id && endpoint.pin_id) {
    value.component_id = endpoint.component_id;
    value.pin_id = endpoint.pin_id;
  }
  if (endpoint.port_id) value.port_id = endpoint.port_id;
  if (endpoint.junction_id) value.junction_id = endpoint.junction_id;
  return value;
}

export function endpointDrawPoint(endpoint: EndpointHit): CircuitPosition {
  if (endpoint.kind === 'point') return snapPoint(endpoint);
  return { x: endpoint.x, y: endpoint.y };
}

export function normalizeConnectivity(module: CircuitModule): CircuitModule {
  const next = cloneModule(module);
  ensureStableNetModel(next);
  for (const wire of next.wires) {
    const endpointIds = [endpointNetId(next, wire.from), endpointNetId(next, wire.to)].filter(
      (value): value is string => Boolean(value),
    );
    let merged = { id: wire.net_id ?? endpointIds[0] ?? '', name: wire.net ?? '' };
    for (const endpointId of endpointIds) {
      merged = mergeStableNets(next, merged.id || null, endpointId);
    }
    if (merged.id) {
      wire.net_id = merged.id;
      wire.net = merged.name;
    }
  }
  ensureStableNetModel(next);
  const nets = new Map((next.nets ?? []).map((net) => [net.id, net]));
  for (const component of next.components) {
    for (const pin of component.pins) {
      const net = pin.net_id ? nets.get(pin.net_id) : undefined;
      if (net) pin.net = net.name;
    }
  }
  for (const port of next.ports) {
    const net = port.net_id ? nets.get(port.net_id) : undefined;
    if (net) port.net = net.name;
  }
  for (const wire of next.wires) {
    const net = wire.net_id ? nets.get(wire.net_id) : undefined;
    if (net) wire.net = net.name;
  }
  const issues = validateWireTopology(next);
  if (issues.length > 0) {
    throw new Error(`Invalid schematic wire topology: ${issues.map((issue) => issue.message).join('; ')}`);
  }
  return next;
}

export function validateWireTopology(module: CircuitModule): WireTopologyIssue[] {
  const issues: WireTopologyIssue[] = [];
  const nets = new Map((module.nets ?? []).map((net) => [net.id, net]));
  const junctions = new Map<string, { point: CircuitPosition; netId?: string; wireId: string }>();
  const segments: Array<{ wire: CircuitWire; start: CircuitPosition; end: CircuitPosition }> = [];

  for (const wire of module.wires ?? []) {
    const points = wire.points ?? [];
    if (points.length < 2 || !wire.from || !wire.to) {
      issues.push({ code: 'invalid_wire', message: `${wire.id} must have two endpoints and at least two points`, wire_ids: [wire.id] });
      continue;
    }
    const net = wire.net_id ? nets.get(wire.net_id) : undefined;
    if (!wire.net_id || !net || net.name !== wire.net) {
      issues.push({ code: 'net_mismatch', message: `${wire.id} net/net_id does not match the module net table`, wire_ids: [wire.id] });
    }
    const first = points[0]!;
    const last = points.at(-1)!;
    if (!sameCoordinate(first, wire.from) || !sameCoordinate(last, wire.to)) {
      issues.push({ code: 'invalid_endpoint', message: `${wire.id} endpoint coordinates do not match its path`, wire_ids: [wire.id] });
    }
    for (const endpoint of [wire.from, wire.to]) {
      const key = endpointKey(endpoint);
      if (!key) {
        issues.push({ code: 'invalid_endpoint', message: `${wire.id} has an endpoint without pin, port, or junction identity`, wire_ids: [wire.id] });
        continue;
      }
      const endpointId = endpointNetId(module, endpoint);
      if ((endpoint.component_id || endpoint.port_id) && endpointId !== wire.net_id) {
        issues.push({ code: 'net_mismatch', message: `${wire.id} endpoint ${key} belongs to another net`, wire_ids: [wire.id], point: endpoint });
      }
      if (endpoint.junction_id) {
        const current = junctions.get(endpoint.junction_id);
        if (current && (!sameCoordinate(current.point, endpoint) || current.netId !== wire.net_id)) {
          issues.push({
            code: 'junction_conflict',
            message: `junction ${endpoint.junction_id} has inconsistent coordinates or nets`,
            wire_ids: [current.wireId, wire.id],
            point: endpoint,
          });
        } else if (!current) {
          junctions.set(endpoint.junction_id, { point: endpoint, netId: wire.net_id, wireId: wire.id });
        }
      }
    }
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1]!;
      const end = points[index]!;
      if (sameCoordinate(start, end) || (start.x !== end.x && start.y !== end.y)) {
        issues.push({ code: 'invalid_wire', message: `${wire.id} contains a zero-length or non-orthogonal segment`, wire_ids: [wire.id], point: start });
      } else {
        segments.push({ wire, start, end });
      }
    }
  }

  for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
    const left = segments[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
      const right = segments[rightIndex]!;
      if (left.wire.id === right.wire.id || left.wire.net_id === right.wire.net_id) continue;
      const contact = blockingSegmentContact(left.start, left.end, right.start, right.end);
      if (!contact) continue;
      issues.push({
        code: 'unintended_contact',
        message: `${left.wire.id} and ${right.wire.id} from different nets touch or overlap`,
        wire_ids: [left.wire.id, right.wire.id],
        point: contact,
      });
    }
  }
  return issues;
}

function blockingSegmentContact(
  leftStart: CircuitPosition,
  leftEnd: CircuitPosition,
  rightStart: CircuitPosition,
  rightEnd: CircuitPosition,
): CircuitPosition | null {
  const leftVertical = leftStart.x === leftEnd.x;
  const rightVertical = rightStart.x === rightEnd.x;
  if (leftVertical === rightVertical) {
    if (leftVertical && leftStart.x !== rightStart.x) return null;
    if (!leftVertical && leftStart.y !== rightStart.y) return null;
    const leftMin = leftVertical ? Math.min(leftStart.y, leftEnd.y) : Math.min(leftStart.x, leftEnd.x);
    const leftMax = leftVertical ? Math.max(leftStart.y, leftEnd.y) : Math.max(leftStart.x, leftEnd.x);
    const rightMin = rightVertical ? Math.min(rightStart.y, rightEnd.y) : Math.min(rightStart.x, rightEnd.x);
    const rightMax = rightVertical ? Math.max(rightStart.y, rightEnd.y) : Math.max(rightStart.x, rightEnd.x);
    const overlapStart = Math.max(leftMin, rightMin);
    const overlapEnd = Math.min(leftMax, rightMax);
    if (overlapStart > overlapEnd) return null;
    return leftVertical ? { x: leftStart.x, y: overlapStart } : { x: overlapStart, y: leftStart.y };
  }
  const verticalStart = leftVertical ? leftStart : rightStart;
  const verticalEnd = leftVertical ? leftEnd : rightEnd;
  const horizontalStart = leftVertical ? rightStart : leftStart;
  const horizontalEnd = leftVertical ? rightEnd : leftEnd;
  const point = { x: verticalStart.x, y: horizontalStart.y };
  const within = point.x >= Math.min(horizontalStart.x, horizontalEnd.x)
    && point.x <= Math.max(horizontalStart.x, horizontalEnd.x)
    && point.y >= Math.min(verticalStart.y, verticalEnd.y)
    && point.y <= Math.max(verticalStart.y, verticalEnd.y);
  if (!within) return null;
  const interiorVertical = point.y > Math.min(verticalStart.y, verticalEnd.y)
    && point.y < Math.max(verticalStart.y, verticalEnd.y);
  const interiorHorizontal = point.x > Math.min(horizontalStart.x, horizontalEnd.x)
    && point.x < Math.max(horizontalStart.x, horizontalEnd.x);
  return interiorVertical && interiorHorizontal ? null : point;
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function endpointWorldPosition(
  module: CircuitModule,
  endpoint: CircuitWireEndpoint | undefined,
  portPositions: Map<string, CircuitPosition>,
): CircuitPosition | null {
  if (!endpoint) return null;
  if (endpoint.component_id && endpoint.pin_id) {
    const component = module.components.find((entry) => entry.id === endpoint.component_id);
    if (!component) return { x: endpoint.x, y: endpoint.y };
    const pinIndex = component.pins.findIndex((pin) => pin.id === endpoint.pin_id);
    const pin = pinIndex >= 0 ? component.pins[pinIndex] : undefined;
    if (!pin) return { x: endpoint.x, y: endpoint.y };
    return pinWorld(component, pin, pinIndex);
  }
  if (endpoint.port_id) {
    return portPositions.get(endpoint.port_id) ?? { x: endpoint.x, y: endpoint.y };
  }
  return { x: endpoint.x, y: endpoint.y };
}

export function rerouteWire(
  module: CircuitModule,
  wire: CircuitWire,
  portPositions: Map<string, CircuitPosition>,
  occupiedWires: CircuitWire[] = [],
): CircuitWire {
  const start = endpointWorldPosition(module, wire.from, portPositions);
  const end = endpointWorldPosition(module, wire.to, portPositions);
  if (!start || !end) return wire;
  return {
    ...wire,
    from: wire.from ? { ...wire.from, x: start.x, y: start.y } : wire.from,
    to: wire.to ? { ...wire.to, x: end.x, y: end.y } : wire.to,
    points: routePointsForModule(module, start, end, wire.from, wire.to, wire.net, occupiedWires),
  };
}

function syncWireEndpointPoints(
  module: CircuitModule,
  wire: CircuitWire,
  portPositions: Map<string, CircuitPosition>,
): CircuitWire {
  const start = endpointWorldPosition(module, wire.from, portPositions);
  const end = endpointWorldPosition(module, wire.to, portPositions);
  if (!start || !end) return wire;
  const points = (wire.points ?? []).map((point) => ({ x: point.x, y: point.y }));
  if (points.length < 2) {
    return rerouteWire(module, wire, portPositions);
  }
  const oldStart = points[0];
  const oldEnd = points[points.length - 1];
  // Component/port moves leave stored paths anchored to stale endpoints. Stretching only the
  // first/last vertex (rubber-band sync) creates diagonals that cut through symbols/labels.
  // When either pin drifted, rebuild a Manhattan route instead of preserving midpoints.
  if (routeEndpointDrifted(oldStart, start) || routeEndpointDrifted(oldEnd, end)) {
    return rerouteWire(module, wire, portPositions);
  }
  return {
    ...wire,
    from: wire.from ? { ...wire.from, x: start.x, y: start.y } : wire.from,
    to: wire.to ? { ...wire.to, x: end.x, y: end.y } : wire.to,
    points: compactRoute(points),
  };
}

function routeEndpointDrifted(
  pathPoint: CircuitPosition | undefined,
  resolved: CircuitPosition,
): boolean {
  if (!pathPoint) return true;
  return Math.abs(pathPoint.x - resolved.x) > 0.5 || Math.abs(pathPoint.y - resolved.y) > 0.5;
}

export function rerouteStoredWires(
  module: CircuitModule,
  options: { componentIds?: Iterable<string>; portIds?: Iterable<string> } = {},
): CircuitWire[] {
  const portPositions = computePortPositions(module);
  const componentIds = new Set(options.componentIds ?? []);
  const portIds = new Set(options.portIds ?? []);
  const filterConnections = componentIds.size > 0 || portIds.size > 0;
  const wires = (module.wires ?? []).map(cloneWireRecord);
  const routingModule = { ...module, wires };
  for (let index = 0; index < wires.length; index += 1) {
    const wire = wires[index];
    if (!wire) continue;
    if (filterConnections && !wireTouchesAnyComponent(wire, componentIds) && !wireTouchesAnyPort(wire, portIds)) {
      continue;
    }
    const occupied = wires.filter((_, occupiedIndex) => occupiedIndex !== index);
    wires[index] = rerouteWire(routingModule, wire, portPositions, occupied);
    routingModule.wires = wires;
  }
  return wires;
}

function wireTouchesAnyComponent(wire: CircuitWire, componentIds: Set<string>): boolean {
  const leftComponentId = wire.from?.component_id;
  const rightComponentId = wire.to?.component_id;
  return Boolean(
    leftComponentId && componentIds.has(leftComponentId) ||
    rightComponentId && componentIds.has(rightComponentId),
  );
}

export function pointEndpoint(point: CircuitPosition): EndpointHit {
  return { kind: 'point', x: point.x, y: point.y, label: `${point.x},${point.y}` };
}

export function hitEndpoint(document: SchematicDocument, world: CircuitPosition): EndpointHit | null {
  const pinCandidates: Array<{ endpoint: EndpointHit; distance: number; key: string }> = [];
  for (const component of document.module.components) {
    for (let index = 0; index < component.pins.length; index += 1) {
      const pin = component.pins[index];
      if (!pin) continue;
      const point = pinWorld(component, pin, index);
      const hitDistance = distance(point, world);
      if (hitDistance <= PIN_REACH) {
        pinCandidates.push({
          distance: hitDistance,
          key: `${component.id}.${pin.id}`,
          endpoint: {
          kind: 'pin',
          x: point.x,
          y: point.y,
          component_id: component.id,
          pin_id: pin.id,
          label: `${component.name}.${pin.name}`,
          net: pin.net,
          net_id: pin.net_id,
          },
        });
      }
    }
  }
  pinCandidates.sort((left, right) => (
    left.distance - right.distance || left.key.localeCompare(right.key)
  ));
  if (pinCandidates[0]) return pinCandidates[0].endpoint;

  const portCandidates: Array<{ endpoint: EndpointHit; distance: number; key: string }> = [];
  for (const port of document.module.ports) {
    if (!isSchematicPortVisible(document, port)) continue;
    const point = document.portPositions.get(port.id);
    if (point) {
      const hitDistance = distance(point, world);
      if (hitDistance <= PIN_REACH + 3) {
        portCandidates.push({
          distance: hitDistance,
          key: port.id,
          endpoint: {
            kind: 'port',
            x: point.x,
            y: point.y,
            port_id: port.id,
            label: port.name,
            net: port.net,
            net_id: port.net_id,
          },
        });
      }
    }
  }
  portCandidates.sort((left, right) => (
    left.distance - right.distance || left.key.localeCompare(right.key)
  ));
  if (portCandidates[0]) return portCandidates[0].endpoint;
  return hitWireNode(document, world);
}

function hitWireNode(document: SchematicDocument, world: CircuitPosition): EndpointHit | null {
  const junctionCandidates: Array<{ endpoint: EndpointHit; distance: number; key: string }> = [];
  for (const wire of document.wires) {
    for (const endpoint of [wire.from, wire.to]) {
      if (!endpoint?.junction_id) continue;
      const hitDistance = distance(endpoint, world);
      if (hitDistance > PIN_REACH) continue;
      junctionCandidates.push({
        distance: hitDistance,
        key: `${endpoint.junction_id}:${wire.id}`,
        endpoint: {
          kind: 'junction',
          ...endpoint,
          label: wire.net ? `Junction ${wire.net}` : 'Junction',
          net: wire.net,
          net_id: wire.net_id,
          wire_id: wire.id,
        },
      });
    }
  }
  junctionCandidates.sort((left, right) => (
    left.distance - right.distance || left.key.localeCompare(right.key)
  ));
  if (junctionCandidates[0]) return junctionCandidates[0].endpoint;

  const candidates: Array<{
    wire: CircuitWire;
    segmentIndex: number;
    point: CircuitPosition;
    distance: number;
  }> = [];
  for (const wire of document.wires) {
    const points = wire.points ?? [];
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      if (!start || !end) continue;
      const hitDistance = pointToSegmentDistance(world, start, end);
      if (hitDistance > PIN_REACH) continue;
      candidates.push({
        wire,
        segmentIndex: index,
        point: snapPoint(nearestOrthogonalPoint(world, start, end)),
        distance: hitDistance,
      });
    }
  }
  candidates.sort((left, right) => left.distance - right.distance || left.wire.id.localeCompare(right.wire.id));
  const best = candidates[0];
  if (!best) return null;
  const coincident = candidates.filter((candidate) => (
    sameCoordinate(candidate.point, best.point) && Math.abs(candidate.distance - best.distance) < 0.5
  ));
  const netKeys = new Set(coincident.map((candidate) => candidate.wire.net_id ?? candidate.wire.net ?? ''));
  if (netKeys.size > 1) return null;
  return {
    kind: 'point',
    ...best.point,
    label: best.wire.net ? `Wire ${best.wire.net}` : 'Wire',
    net: best.wire.net,
    net_id: best.wire.net_id,
    wire_id: best.wire.id,
    segment_index: best.segmentIndex,
  };
}

function nearestOrthogonalPoint(
  point: CircuitPosition,
  start: CircuitPosition,
  end: CircuitPosition,
): CircuitPosition {
  if (Math.abs(start.x - end.x) < 0.001) {
    return {
      x: start.x,
      y: Math.max(Math.min(start.y, end.y), Math.min(Math.max(start.y, end.y), point.y)),
    };
  }
  if (Math.abs(start.y - end.y) < 0.001) {
    return {
      x: Math.max(Math.min(start.x, end.x), Math.min(Math.max(start.x, end.x), point.x)),
      y: start.y,
    };
  }
  return point;
}

function wireTouchesAnyPort(wire: CircuitWire, portIds: Set<string>): boolean {
  const leftPortId = wire.from?.port_id;
  const rightPortId = wire.to?.port_id;
  return Boolean(
    leftPortId && portIds.has(leftPortId) ||
    rightPortId && portIds.has(rightPortId),
  );
}

export function hitPort(document: SchematicDocument, world: CircuitPosition): CircuitPort | null {
  for (let index = document.module.ports.length - 1; index >= 0; index -= 1) {
    const port = document.module.ports[index];
    if (!port || !isSchematicPortVisible(document, port)) continue;
    const point = document.portPositions.get(port.id);
    if (!point) continue;
    const bounds = portInteractionBounds(point, portRenderSide(document, port, point));
    if (world.x >= bounds.minX && world.x <= bounds.maxX && world.y >= bounds.minY && world.y <= bounds.maxY) {
      return port;
    }
  }
  return null;
}

export function hitComponent(document: SchematicDocument, world: CircuitPosition): CircuitComponent | null {
  for (let index = document.module.components.length - 1; index >= 0; index -= 1) {
    const component = document.module.components[index];
    if (!component) continue;
    if (pointHitsComponentGraphic(component, world)) return component;
  }
  return null;
}

export function hitWire(document: SchematicDocument, world: CircuitPosition): CircuitWire | null {
  const wires = document.wires ?? [];
  const storedIds = new Set((document.module.wires ?? []).map((wire) => wire.id));
  const stored = wires.filter((wire) => wire.source === 'stored' || storedIds.has(wire.id));
  const generated = wires.filter((wire) => wire.source !== 'stored' && !storedIds.has(wire.id));
  return hitWireGroup(stored, world) ?? hitWireGroup(generated, world);
}

export function distance(left: CircuitPosition, right: CircuitPosition): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function pointHitsComponentGraphic(component: CircuitComponent, world: CircuitPosition): boolean {
  const pins = component.pins.map((pin, index) => pinWorld(component, pin, index));
  if (pins.some((point) => distance(point, world) <= PIN_REACH)) return true;
  if (component.pins.length === 2 && pointNearTwoPinLeads(component, world)) return true;

  if (component.type === 'M') return pointNearMosGraphic(component, world);
  if (component.type === 'Q') return pointNearBjtGraphic(component, world);
  if (component.type === 'E') return pointNearOpampGraphic(component, world);

  const local = componentLocalPoint(component, world);
  if ((component.type === 'BLOCK' || component.type === 'MODULE')) {
    const { width, height } = blockBodySize(component);
    return Math.abs(local.x) <= width / 2 && Math.abs(local.y) <= height / 2;
  }
  if (component.type === 'R') return Math.abs(local.x) <= 32 && Math.abs(local.y) <= 14;
  if (component.type === 'C') return Math.abs(local.x) <= 16 && Math.abs(local.y) <= 36;
  if (component.type === 'L') return Math.abs(local.x) <= 38 && Math.abs(local.y) <= 12;
  if (component.type === 'D') return local.x >= -26 && local.x <= 26 && local.y >= -29 && local.y <= 29;
  if (component.type === 'V' || component.type === 'I') return Math.hypot(local.x, local.y) <= 31;
  // The ground symbol art hangs below the anchor pin; cover the whole symbol so
  // clicking any part of it selects the pseudo-component (qucs parity).
  if (component.type === 'GND') return local.x >= -24 && local.x <= 24 && local.y >= -6 && local.y <= 44;
  return Math.hypot(local.x, local.y) <= 28;
}

function pointNearTwoPinLeads(component: CircuitComponent, world: CircuitPosition): boolean {
  const offsets = twoPinBodyTerminalOffsets(component);
  return component.pins.some((pin, index) => {
    const pinPoint = pinWorld(component, pin, index);
    const offset = offsets[index];
    if (!offset) return false;
    const bodyPoint = {
      x: component.position.x + offset.x,
      y: component.position.y + offset.y,
    };
    return pointToSegmentDistance(world, pinPoint, bodyPoint) <= 7;
  });
}

function twoPinBodyTerminalOffsets(component: CircuitComponent): [CircuitPosition, CircuitPosition] {
  let span = 28;
  if (component.type === 'C') span = 8;
  if (component.type === 'D') span = 22;
  if (component.type === 'L') span = 36;
  if (component.type === 'V' || component.type === 'I') span = 28;
  return [
    rotateOffset({ x: -span, y: 0 }, normalizeRotation(component.rotation)),
    rotateOffset({ x: span, y: 0 }, normalizeRotation(component.rotation)),
  ];
}

function componentLocalPoint(component: CircuitComponent, world: CircuitPosition): CircuitPosition {
  const dx = world.x - component.position.x;
  const dy = world.y - component.position.y;
  const rotation = normalizeRotation(component.rotation);
  if (rotation === 90) return { x: dy, y: -dx };
  if (rotation === 180) return { x: -dx, y: -dy };
  if (rotation === 270) return { x: -dy, y: dx };
  return { x: dx, y: dy };
}

function pointNearMosGraphic(component: CircuitComponent, world: CircuitPosition): boolean {
  const local = componentLocalPoint(component, world);
  if (Math.hypot(local.x - 2, local.y) <= 46) return true;
  const gateX = -20;
  const channelX = 4;
  const terminalX = 22;
  const segments: Array<[CircuitPosition, CircuitPosition]> = [
    [{ x: gateX, y: -34 }, { x: gateX, y: 34 }],
    [{ x: channelX, y: -36 }, { x: channelX, y: -14 }],
    [{ x: channelX, y: -7 }, { x: channelX, y: 7 }],
    [{ x: channelX, y: 14 }, { x: channelX, y: 36 }],
    [{ x: -58, y: 0 }, { x: gateX, y: 0 }],
    [{ x: channelX, y: -30 }, { x: terminalX, y: -30 }],
    [{ x: terminalX, y: -30 }, { x: terminalX, y: -52 }],
    [{ x: channelX, y: 30 }, { x: terminalX, y: 30 }],
    [{ x: terminalX, y: 30 }, { x: terminalX, y: 52 }],
    [{ x: channelX, y: 0 }, { x: 58, y: 0 }],
  ];
  return segments.some(([start, end]) => pointToSegmentDistance(local, start, end) <= 8);
}

function pointNearBjtGraphic(component: CircuitComponent, world: CircuitPosition): boolean {
  const local = componentLocalPoint(component, world);
  if (Math.abs(local.x) <= 44 && Math.abs(local.y) <= 58) return true;
  const segments: Array<[CircuitPosition, CircuitPosition]> = [
    [{ x: -18, y: -34 }, { x: -18, y: 34 }],
    [{ x: -58, y: 0 }, { x: -18, y: 0 }],
    [{ x: -18, y: -20 }, { x: 30, y: -52 }],
    [{ x: -18, y: 20 }, { x: 30, y: 52 }],
  ];
  return segments.some(([start, end]) => pointToSegmentDistance(local, start, end) <= 8);
}

function pointNearOpampGraphic(component: CircuitComponent, world: CircuitPosition): boolean {
  const local = componentLocalPoint(component, world);
  if (local.x >= -46 && local.x <= 58 && local.y >= -58 && local.y <= 58) return true;
  const segments: Array<[CircuitPosition, CircuitPosition]> = [
    [{ x: -58, y: -24 }, { x: -42, y: -24 }],
    [{ x: -58, y: 24 }, { x: -42, y: 24 }],
    [{ x: 52, y: 0 }, { x: 64, y: 0 }],
    [{ x: 0, y: 42 }, { x: 0, y: 58 }],
  ];
  return segments.some(([start, end]) => pointToSegmentDistance(local, start, end) <= 8);
}

export function pointToSegmentDistance(point: CircuitPosition, start: CircuitPosition, end: CircuitPosition): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(point, start);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
  return distance(point, { x: start.x + t * dx, y: start.y + t * dy });
}

export function wireIdToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'net';
}

function pinOffset(component: CircuitComponent, pin: CircuitPin, index: number): CircuitPosition {
  const key = `${pin.id} ${pin.name}`.toLowerCase();
  let offset: CircuitPosition;
  if ((component.type === 'BLOCK' || component.type === 'MODULE')) {
    offset = blockPinLocalOffsets(component, pin, index).endpoint;
  } else if (component.type === 'M') {
    const pmos = isPmosComponent(component);
    if (/gate|\bg\b/.test(key)) offset = { x: -58, y: 0 };
    else if (/drain|\bd\b/.test(key)) offset = { x: 22, y: pmos ? 52 : -52 };
    else if (/source|\bs\b/.test(key)) offset = { x: 22, y: pmos ? -52 : 52 };
    else offset = { x: 58, y: 0 };
  } else if (component.type === 'Q') {
    if (/base|\bb\b/.test(key)) offset = { x: -58, y: 0 };
    else if (/collector|\bc\b/.test(key)) offset = { x: 30, y: -52 };
    else offset = { x: 30, y: 52 };
  } else if (component.type === 'E') {
    if (/out\+|\bp\b/.test(key)) offset = { x: 64, y: 0 };
    else if (/out-|\bn\b|ref/.test(key)) offset = { x: 0, y: 58 };
    else if (/\+|non|cp|in\+/.test(key)) offset = { x: -58, y: 24 };
    else if (/-|inv|cn|in-/.test(key)) offset = { x: -58, y: -24 };
    else offset = { x: 0, y: 58 };
  } else if (component.type === 'GND') {
    // The component position IS the ground anchor pin; the symbol hangs below.
    offset = { x: 0, y: 0 };
  } else {
    const sign = index === 0 ? -1 : 1;
    offset = { x: sign * 52, y: 0 };
  }
  return rotateOffset(offset, normalizeRotation(component.rotation));
}

function rotateOffset(offset: CircuitPosition, rotation: number): CircuitPosition {
  if (rotation === 90) return { x: -offset.y, y: offset.x };
  if (rotation === 180) return { x: -offset.x, y: -offset.y };
  if (rotation === 270) return { x: offset.y, y: -offset.x };
  return offset;
}

function materializeNetWires(
  module: CircuitModule,
  portPositions: Map<string, CircuitPosition>,
  netLabels: SchematicNetLabel[] = [],
): CircuitWire[] {
  // Net-label text stays clear of generated routes: a fan-out wire should
  // not slide under another net's label text (deterministic soft penalties).
  const labelObstacles = netLabels.map(netLabelRouteObstacle);
  const stored = (module.wires ?? [])
    .filter((wire) => (wire.points ?? []).length >= 2)
    .map((wire) => ({ ...syncWireEndpointPoints(module, wire, portPositions), source: 'stored' as const }));
  const usedPairs = new Set(stored.map((wire) => endpointPairKey(wire.from, wire.to)));
  const existingIds = new Set(stored.map((wire) => wire.id));
  // Large sheets preserve every user-authored stored route, but any remaining
  // derived net fan-out uses the bounded orthogonal router. A single edited
  // net must not force hundreds of unrelated implicit nets back through the
  // obstacle-search router on the next projection.
  const fastImplicitRouting = module.components.length > AUTO_LAYOUT_COMPONENT_LIMIT;
  // Nets that already carry stored wires only get the anchor fan-out: the >=4-endpoint
  // spine/tree decomposition does not subtract partially-stored pairs and would add
  // parallel links (e.g. after a component move materialized one wire of the net).
  const netsWithStoredWires = new Set(stored.map((wire) => wire.net).filter(Boolean));
  const endpointsByNet = new Map<string, EndpointHit[]>();

  const remember = (net: string | undefined, endpoint: EndpointHit) => {
    if (!net) return;
    endpointsByNet.set(net, [...(endpointsByNet.get(net) ?? []), endpoint]);
  };

  for (const component of module.components) {
    component.pins.forEach((pin, index) => {
      // Body/bulk pins sit inside the MOSFET artwork; wiring them creates loops through the symbol.
      if (isMosBodyPin(component, pin) || pin.no_connect) return;
      const point = pinWorld(component, pin, index);
      remember(pin.net, {
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

  for (const port of module.ports) {
    const point = portPositions.get(port.id);
    if (!point) continue;
    remember(port.net, {
      kind: 'port',
      x: point.x,
      y: point.y,
      port_id: port.id,
      label: port.name,
      net: port.net,
    });
  }

  const wires: CircuitWire[] = [...stored];
  for (const [net, endpoints] of endpointsByNet) {
    if (endpoints.length < 2) continue;
    if (shouldRepresentNetWithLocalLabel(module, net)) continue;
    if (shouldRepresentSignalNetWithLocalLabel(module, net, endpoints)) continue;
    if (!fastImplicitRouting && endpoints.length >= 4 && !netsWithStoredWires.has(net)) {
      if (!isCmosRingFeedbackNet(module, net)) {
        const spineWires = materializeEndpointSpineWires(module, net, endpoints, existingIds, usedPairs, wires);
        if (spineWires.length > 0) {
          wires.push(...spineWires);
          continue;
        }
      }
      const treeWires = materializeEndpointTreeWires(module, net, endpoints, existingIds, usedPairs, wires, labelObstacles);
      if (treeWires.length > 0) {
        wires.push(...treeWires);
        continue;
      }
    }
    const anchor = chooseNetAnchor(module, net, endpoints);
    // Seed the connectivity state with the stored wires on this net so the
    // fan-out only adds links that actually merge disconnected members —
    // regenerating anchor->endpoint blindly duplicates a stored star whose
    // anchor differs from chooseNetAnchor (e.g. after a component move).
    const connectivity = new EndpointUnionFind();
    for (const wire of stored) {
      if ((wire.net ?? '') !== net) continue;
      const leftKey = endpointKey(wire.from) ?? `${wire.from?.x ?? ''},${wire.from?.y ?? ''}`;
      const rightKey = endpointKey(wire.to) ?? `${wire.to?.x ?? ''},${wire.to?.y ?? ''}`;
      if (leftKey && rightKey) connectivity.union(leftKey, rightKey);
    }
    const anchorKey = endpointKey(anchor) ?? `${anchor.x},${anchor.y}`;
    for (const endpoint of endpoints) {
      if (endpoint === anchor) continue;
      if (distance(endpointDrawPoint(anchor), endpointDrawPoint(endpoint)) < 1) continue;
      const pairKey = endpointPairKey(anchor, endpoint);
      if (usedPairs.has(pairKey)) continue;
      const endpointNodeKey = endpointKey(endpoint) ?? `${endpoint.x},${endpoint.y}`;
      if (!connectivity.union(anchorKey, endpointNodeKey)) continue;
      usedPairs.add(pairKey);
      const id = makeId(`net_${wireIdToken(net)}_`, existingIds);
      existingIds.add(id);
      const startPoint = endpointDrawPoint(anchor);
      const endPoint = endpointDrawPoint(endpoint);
      wires.push({
        id,
        points: fastImplicitRouting
          ? routePoints(startPoint, endPoint)
          : routePointsForModule(module, startPoint, endPoint, anchor, endpoint, net, wires, labelObstacles),
        from: stripEndpoint(startPoint, anchor),
        to: stripEndpoint(endPoint, endpoint),
        net,
        source: 'net',
      });
    }
  }
  return wires;
}

/** Minimal union-find over endpoint identities (pin / port / junction / coordinate keys). */
class EndpointUnionFind {
  private readonly parent = new Map<string, string>();

  private findRoot(key: string): string {
    let root = this.parent.get(key) ?? key;
    if (root !== key) {
      root = this.findRoot(root);
      this.parent.set(key, root);
    }
    return root;
  }

  union(left: string, right: string): boolean {
    const leftRoot = this.findRoot(left);
    const rightRoot = this.findRoot(right);
    if (leftRoot === rightRoot) return false;
    this.parent.set(leftRoot, rightRoot);
    return true;
  }
}

function materializeEndpointSpineWires(
  module: CircuitModule,
  net: string,
  endpoints: EndpointHit[],
  existingIds: Set<string>,
  usedPairs: Set<string>,
  occupiedWires: CircuitWire[],
): CircuitWire[] {
  const uniqueEndpoints = endpoints.filter((endpoint, index) => (
    endpoints.findIndex((candidate) => distance(endpointDrawPoint(endpoint), endpointDrawPoint(candidate)) < 1) === index
  ));
  if (uniqueEndpoints.length < 4) return [];

  const points = uniqueEndpoints.map(endpointDrawPoint);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  const orientation: 'horizontal' | 'vertical' = spanX >= spanY ? 'horizontal' : 'vertical';
  if (Math.max(spanX, spanY) < SCHEMATIC_GRID * 6) return [];

  const root = chooseSpineRoot(module, net, uniqueEndpoints, orientation);
  const routeSpecs = chooseSpineRouteSpecs(module, net, uniqueEndpoints, root, orientation, usedPairs, occupiedWires);
  if (!routeSpecs || routeSpecs.length < uniqueEndpoints.length - 1) return [];

  const localExistingIds = new Set(existingIds);
  const createdIds: string[] = [];
  const wires = routeSpecs.map((spec) => {
    const id = makeId(`net_${wireIdToken(net)}_`, localExistingIds);
    localExistingIds.add(id);
    createdIds.push(id);
    return {
      id,
      points: spec.points,
      from: stripEndpoint(spec.startPoint, root),
      to: stripEndpoint(spec.endPoint, spec.endpoint),
      net,
      source: 'net',
    } satisfies CircuitWire;
  });

  for (const id of createdIds) existingIds.add(id);
  for (const spec of routeSpecs) usedPairs.add(spec.pairKey);
  return wires;
}

function chooseSpineRoot(
  module: CircuitModule,
  net: string,
  endpoints: EndpointHit[],
  orientation: 'horizontal' | 'vertical',
): EndpointHit {
  const diodeAnchor = diodeConnectedDrainAnchor(module, net, endpoints);
  if (diodeAnchor) return diodeAnchor;
  const candidates = endpoints.filter((endpoint) => endpoint.kind === 'pin');
  const available = candidates.length > 0 ? candidates : endpoints;
  return [...available].sort((left, right) => (
    orientation === 'horizontal'
      ? (left.x - right.x) || (left.y - right.y)
      : (left.y - right.y) || (left.x - right.x)
  ))[0] ?? endpoints[0]!;
}

interface SpineRouteSpec {
  endpoint: EndpointHit;
  pairKey: string;
  startPoint: CircuitPosition;
  endPoint: CircuitPosition;
  points: CircuitPosition[];
  cost: number;
}

function chooseSpineRouteSpecs(
  module: CircuitModule,
  net: string,
  endpoints: EndpointHit[],
  root: EndpointHit,
  orientation: 'horizontal' | 'vertical',
  usedPairs: Set<string>,
  occupiedWires: CircuitWire[],
): SpineRouteSpec[] | null {
  const coordinates = endpoints
    .map((endpoint) => orientation === 'horizontal' ? endpoint.y : endpoint.x)
    .sort((left, right) => left - right);
  const rootCoordinate = orientation === 'horizontal' ? root.y : root.x;
  const min = coordinates[0] ?? rootCoordinate;
  const max = coordinates.at(-1) ?? rootCoordinate;
  const obstacleCoordinates = obstaclesForEndpoints(module, root, undefined, net).flatMap((obstacle) => (
    orientation === 'horizontal'
      ? [obstacle.minY - SCHEMATIC_GRID, obstacle.maxY + SCHEMATIC_GRID]
      : [obstacle.minX - SCHEMATIC_GRID, obstacle.maxX + SCHEMATIC_GRID]
  ));
  const candidates = [...new Set([
    rootCoordinate,
    ...coordinates,
    ...obstacleCoordinates,
    (min + max) / 2,
    min - SCHEMATIC_GRID * 2,
    max + SCHEMATIC_GRID * 2,
  ].map(snap))];

  let best: SpineRouteSpec[] | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const coordinate of candidates) {
    const specs: SpineRouteSpec[] = [];
    let totalCost = 0;
    let failed = false;
    for (const endpoint of endpoints) {
      if (endpoint === root) continue;
      const startPoint = endpointDrawPoint(root);
      const endPoint = endpointDrawPoint(endpoint);
      if (distance(startPoint, endPoint) < 1) continue;
      const pairKey = endpointPairKey(root, endpoint);
      if (usedPairs.has(pairKey)) {
        failed = true;
        break;
      }
      const points = compactRoute(spineRoutePoints(startPoint, endPoint, orientation, coordinate));
      if (!routeIsClear(points, obstaclesForEndpoints(module, root, endpoint, net))) {
        failed = true;
        break;
      }
      const cost = routeCost(points) + routeCrossingPenalty(points, net, occupiedWires) +
        routeEndpointEgressPenalty(module, points, root, endpoint);
      specs.push({ endpoint, pairKey, startPoint, endPoint, points, cost });
      totalCost += cost;
    }
    if (!failed && specs.length >= endpoints.length - 1 && totalCost < bestCost) {
      best = specs;
      bestCost = totalCost;
    }
  }
  return best;
}

function spineRoutePoints(
  startPoint: CircuitPosition,
  endPoint: CircuitPosition,
  orientation: 'horizontal' | 'vertical',
  spineCoordinate: number,
): CircuitPosition[] {
  if (orientation === 'horizontal') {
    return [
      startPoint,
      { x: startPoint.x, y: spineCoordinate },
      { x: endPoint.x, y: spineCoordinate },
      endPoint,
    ];
  }
  return [
    startPoint,
    { x: spineCoordinate, y: startPoint.y },
    { x: spineCoordinate, y: endPoint.y },
    endPoint,
  ];
}

function materializeEndpointTreeWires(
  module: CircuitModule,
  net: string,
  endpoints: EndpointHit[],
  existingIds: Set<string>,
  usedPairs: Set<string>,
  occupiedWires: CircuitWire[],
  labelObstacles: NetRouteObstacle[] = [],
): CircuitWire[] {
  const root = cmosRingFeedbackAnchor(module, net, endpoints) ??
    endpoints.find((endpoint) => endpoint.kind === 'port') ?? chooseNetAnchor(module, net, endpoints);
  const connected = [root];
  const remaining = endpoints.filter((endpoint) => endpoint !== root);
  const wires: CircuitWire[] = [];

  while (remaining.length > 0) {
    let best: {
      source: EndpointHit;
      target: EndpointHit;
      targetIndex: number;
      points: CircuitPosition[];
      cost: number;
      pairKey: string;
    } | null = null;

    for (const source of connected) {
      for (let targetIndex = 0; targetIndex < remaining.length; targetIndex += 1) {
        const target = remaining[targetIndex];
        if (!target) continue;
        if (distance(endpointDrawPoint(source), endpointDrawPoint(target)) < 1) continue;
        const pairKey = endpointPairKey(source, target);
        if (usedPairs.has(pairKey)) continue;
        const points = routePointsForModule(
          module,
          endpointDrawPoint(source),
          endpointDrawPoint(target),
          source,
          target,
          net,
          occupiedWires,
          labelObstacles,
        );
        const cost = routeCost(points) + routeCrossingPenalty(points, net, occupiedWires);
        if (!best || cost < best.cost) {
          best = { source, target, targetIndex, points, cost, pairKey };
        }
      }
    }

    if (!best) break;
    usedPairs.add(best.pairKey);
    const id = makeId(`net_${wireIdToken(net)}_`, existingIds);
    existingIds.add(id);
    const startPoint = endpointDrawPoint(best.source);
    const endPoint = endpointDrawPoint(best.target);
    wires.push({
      id,
      points: best.points,
      from: stripEndpoint(startPoint, best.source),
      to: stripEndpoint(endPoint, best.target),
      net,
      source: 'net',
    });
    connected.push(best.target);
    remaining.splice(best.targetIndex, 1);
  }

  return wires;
}

function createNetLabels(module: CircuitModule, portPositions: Map<string, CircuitPosition>): SchematicNetLabel[] {
  const labels: SchematicNetLabel[] = [];
  const endpointsByNet = new Map<string, EndpointHit[]>();

  const remember = (net: string | undefined, endpoint: EndpointHit) => {
    if (!net) return;
    endpointsByNet.set(net, [...(endpointsByNet.get(net) ?? []), endpoint]);
  };

  for (const component of module.components) {
    component.pins.forEach((pin, index) => {
      if (isMosBodyPin(component, pin) || pin.no_connect) return;
      const position = pinWorld(component, pin, index);
      remember(pin.net, {
        kind: 'pin',
        x: position.x,
        y: position.y,
        component_id: component.id,
        pin_id: pin.id,
        label: `${component.name}.${pin.name}`,
        net: pin.net,
      });
      if (!shouldRepresentNetWithLocalLabel(module, pin.net)) return;
      if (!shouldLabelRailPin(module, component, pin)) return;
      const kind = isGroundNet(pin.net, module) ? 'ground' : 'power';
      const stub = RAIL_LABEL_STUB;
      const offset = pin.label_offset ?? (kind === 'ground' ? { x: 0, y: stub } : { x: 0, y: -stub });
      const symbolPosition = { x: position.x + offset.x, y: position.y + offset.y };
      labels.push({
        id: `label_${wireIdToken(pin.net)}_${component.id}_${pin.id}`,
        kind,
        net: pin.net,
        name: railLabelName(module, pin.net),
        position: symbolPosition,
        endpoint: {
          x: position.x,
          y: position.y,
          component_id: component.id,
          pin_id: pin.id,
        },
      });
    });
  }

  for (const port of module.ports) {
    const position = portPositions.get(port.id);
    if (!position) continue;
    remember(port.net, {
      kind: 'port',
      x: position.x,
      y: position.y,
      port_id: port.id,
      label: port.name,
      net: port.net,
    });
  }

  for (const [net, endpoints] of endpointsByNet) {
    if (!shouldRepresentSignalNetWithLocalLabel(module, net, endpoints)) continue;
    for (const endpoint of endpoints) {
      if (endpoint.kind !== 'pin' || !endpoint.component_id || !endpoint.pin_id) continue;
      const component = module.components.find((entry) => entry.id === endpoint.component_id);
      const pinIndex = component?.pins.findIndex((pin) => pin.id === endpoint.pin_id) ?? -1;
      const pin = pinIndex >= 0 ? component?.pins[pinIndex] : undefined;
      if (!component || !pin) continue;
      labels.push({
        id: `label_${wireIdToken(net)}_${component.id}_${pin.id}`,
        kind: 'signal',
        net,
        name: formatSignalLabelName(net),
        position: { x: endpoint.x, y: endpoint.y },
        endpoint: {
          x: endpoint.x,
          y: endpoint.y,
          component_id: component.id,
          pin_id: pin.id,
        },
        side: labelSideForPin(component, pin, pinIndex),
      });
    }
  }
  return labels;
}

function shouldRepresentNetWithLocalLabel(module: CircuitModule, net: string | undefined): boolean {
  return Boolean(net && isRailNet(net, module));
}

function shouldLabelRailPin(module: CircuitModule, component: CircuitComponent, pin: CircuitPin): boolean {
  if (component.type === 'GND') return false;
  // A pin already tied with a stored wire keeps the wire; its rail label must
  // not duplicate (e.g. after a rail label was converted into a connection).
  if ((module.wires ?? []).some((wire) => (
    [wire.from, wire.to].some((endpoint) => endpoint?.component_id === component.id && endpoint?.pin_id === pin.id)
  ))) {
    return false;
  }
  if (component.type !== 'M') return true;
  const pinKey = `${pin.id} ${pin.name}`.toLowerCase();
  return /source|\bs\b/.test(pinKey);
}

function railLabelName(module: CircuitModule, net: string): string {
  if (isGroundNet(net, module)) {
    return module.ports.find((port) => port.net === net && isGroundPort(port))?.name || 'GND';
  }
  return module.ports.find((port) => port.net === net && port.signal_type === 'power')?.name || net.toUpperCase();
}

function shouldRepresentSignalNetWithLocalLabel(module: CircuitModule, net: string | undefined, endpoints: EndpointHit[]): boolean {
  if (!net || endpoints.length < 2) return false;
  if (!isReadableSignalNetName(net)) return false;
  if (module.ports.some((port) => port.net === net)) return false;
  if (isCmosRingSignalNet(module, net)) return false;
  if (isCurrentMirrorGateNet(module, net)) return false;
  if (isCascodeBiasNet(module, net)) return true;
  // Stored physical wires win. After a drag commit we persist touched routes; emitting local
  // labels for the same nets leaves duplicate floating stubs beside the kept wires.
  if ((module.wires ?? []).some((wire) => wire.net === net && (wire.points ?? []).length >= 2)) {
    return false;
  }
  const uniqueEndpoints = uniqueNetEndpoints(endpoints);
  if (uniqueEndpoints.length < 2) return false;
  const xs = uniqueEndpoints.map((endpoint) => endpoint.x);
  const ys = uniqueEndpoints.map((endpoint) => endpoint.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  if (isLdoInternalLabelNet(module, net)) {
    return spanX > 360 || spanY > 340;
  }
  // MOSFET switch / phase nodes must stay as continuous wires. Promoting them to local
  // labels after a manual drag leaves floating stubs (orphan "SW" segments).
  if (isSwitchStageSignalNet(module, net, uniqueEndpoints)) return false;
  return spanX > 260 || spanY > 180;
}

function uniqueNetEndpoints(endpoints: EndpointHit[]): EndpointHit[] {
  return endpoints.filter((endpoint, index) => (
    endpoints.findIndex((candidate) => distance(endpointDrawPoint(endpoint), endpointDrawPoint(candidate)) < 1) === index
  ));
}

/** Compact power-stage switch nodes (e.g. SW between high/low-side MOS drains). */
function isSwitchStageSignalNet(
  module: CircuitModule,
  net: string,
  endpoints: EndpointHit[],
): boolean {
  // Name-matched switch nodes always stay wired, whatever the endpoint count —
  // a 4-switch buck-boost has 5+ endpoints on each switch rail.
  if (/^(sw|switch|ph|phase|lx|vsw|mid|node_?sw)[\d_]*$/i.test(net)) return true;
  if (endpoints.length > 4) return false;
  const mosDrainOwners = new Set<string>();
  for (const component of module.components) {
    if (component.type !== 'M') continue;
    for (const pin of component.pins) {
      if (pin.net !== net) continue;
      if (!/drain|\bd\b/i.test(`${pin.id} ${pin.name}`)) continue;
      mosDrainOwners.add(component.id);
    }
  }
  return mosDrainOwners.size >= 2;
}

/** MOSFET body/bulk terminal — drawn inside the symbol, not a schematic wiring endpoint. */
export function isMosBodyPin(component: CircuitComponent, pin: CircuitPin): boolean {
  if (component.type !== 'M') return false;
  return /body|bulk|\bb\b/i.test(`${pin.id} ${pin.name}`);
}

function isCmosRingSignalNet(module: CircuitModule, net: string): boolean {
  const activeComponents = module.components.filter((component) => component.type === 'M' || component.type === 'Q');
  const layout = findCmosRingLayout(module, activeComponents);
  return Boolean(layout?.stages.some((stage) => stage.inputNet === net || stage.outputNet === net));
}
function isCmosRingFeedbackNet(module: CircuitModule, net: string): boolean {
  const activeComponents = module.components.filter((component) => component.type === 'M' || component.type === 'Q');
  const layout = findCmosRingLayout(module, activeComponents);
  const first = layout?.stages[0];
  const last = layout?.stages.at(-1);
  return Boolean(first && last && first.inputNet === net && last.outputNet === net);
}

function cmosRingFeedbackAnchor(
  module: CircuitModule,
  net: string,
  endpoints: EndpointHit[],
): EndpointHit | null {
  const activeComponents = module.components.filter((component) => component.type === 'M' || component.type === 'Q');
  const layout = findCmosRingLayout(module, activeComponents);
  const first = layout?.stages[0];
  const last = layout?.stages.at(-1);
  if (!first || !last || first.inputNet !== net || last.outputNet !== net) return null;
  const drainPin = last.pmos.pins.find((pin) => (
    pin.net === net && /drain|\bd\b/i.test(`${pin.id} ${pin.name}`)
  ));
  if (!drainPin) return null;
  return endpoints.find((endpoint) => (
    endpoint.kind === 'pin' &&
    endpoint.component_id === last.pmos.id &&
    endpoint.pin_id === drainPin.id
  )) ?? null;
}


function isLdoInternalLabelNet(module: CircuitModule, net: string): boolean {
  const moduleText = `${module.module_id} ${module.name}`.toLowerCase();
  if (!/ldo|regulator/.test(moduleText)) return false;
  return /^(fb|feedback|tail|bias|eaout|err(or)?_?out|vref|ref)$/i.test(net);
}

function isCurrentMirrorGateNet(module: CircuitModule, net: string): boolean {
  const mosComponents = module.components.filter((component) => component.type === 'M');
  for (let leftIndex = 0; leftIndex < mosComponents.length; leftIndex += 1) {
    const left = mosComponents[leftIndex];
    if (!left) continue;
    const leftNets = activeNetMap(left);
    if (leftNets.gate !== net || !leftNets.drain || !leftNets.source) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < mosComponents.length; rightIndex += 1) {
      const right = mosComponents[rightIndex];
      if (!right || isPmosComponent(left) !== isPmosComponent(right)) continue;
      const rightNets = activeNetMap(right);
      if (rightNets.gate !== net || !rightNets.drain || rightNets.source !== leftNets.source) continue;
      if (!isRailNet(leftNets.source, module)) continue;
      if (leftNets.drain === net || rightNets.drain === net) return true;
    }
  }
  return false;
}

function isCascodeBiasNet(module: CircuitModule, net: string): boolean {
  const mosComponents = module.components.filter((component) => component.type === 'M');
  for (const lower of mosComponents) {
    const lowerNets = activeNetMap(lower);
    if (!lowerNets.drain || !lowerNets.gate) continue;
    for (const upper of mosComponents) {
      if (upper.id === lower.id || isPmosComponent(upper) !== isPmosComponent(lower)) continue;
      const upperNets = activeNetMap(upper);
      if (!upperNets.source || !upperNets.gate) continue;
      if (upperNets.source === lowerNets.drain && upperNets.gate === net && upperNets.gate !== lowerNets.gate) {
        return true;
      }
    }
  }
  return false;
}

function isReadableSignalNetName(net: string): boolean {
  return !/^(n|net|node)[_-]?\d+$/i.test(net) && net.length <= 18;
}

function formatSignalLabelName(net: string): string {
  return net.replace(/_/g, ' ').toUpperCase();
}

function labelSideForPin(component: CircuitComponent, pin: CircuitPin, index: number): 'left' | 'right' | 'top' | 'bottom' {
  const point = pinWorld(component, pin, index);
  const dx = point.x - component.position.x;
  const dy = point.y - component.position.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'top' : 'bottom';
}

function hitWireGroup(wires: CircuitWire[], world: CircuitPosition): CircuitWire | null {
  for (let wireIndex = wires.length - 1; wireIndex >= 0; wireIndex -= 1) {
    const wire = wires[wireIndex];
    if (!wire) continue;
    const points = wire.points ?? [];
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      if (start && end && pointToSegmentDistance(world, start, end) < 7) return wire;
    }
  }
  return null;
}

function splitNetAfterWireRemoval(module: CircuitModule, removedWire: CircuitWire) {
  ensureStableNetModel(module);
  const affectedNet = removedWire.net ?? endpointNet(module, removedWire.from) ?? endpointNet(module, removedWire.to);
  const affectedNetId = removedWire.net_id ?? module.nets?.find((net) => net.name === affectedNet)?.id;
  const leftKey = endpointKey(removedWire.from);
  const rightKey = endpointKey(removedWire.to);
  if (!affectedNet || !leftKey || !rightKey) return;

  const affectedKeys = endpointKeysForNet(module, affectedNet, affectedNetId);
  if (!affectedKeys.has(leftKey) || !affectedKeys.has(rightKey)) return;

  const adjacency = new Map<string, Set<string>>();
  for (const key of affectedKeys) adjacency.set(key, new Set());
  for (const wire of module.wires ?? []) {
    const left = endpointKey(wire.from);
    const right = endpointKey(wire.to);
    if (!left || !right || !affectedKeys.has(left) || !affectedKeys.has(right)) continue;
    adjacency.get(left)?.add(right);
    adjacency.get(right)?.add(left);
  }

  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const key of affectedKeys) {
    if (seen.has(key)) continue;
    const group: string[] = [];
    const queue = [key];
    seen.add(key);
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      group.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    groups.push(group);
  }
  if (groups.length <= 1) return;

  const existingNets = collectNets(module);
  const keptGroup = groups.find((group) => group.includes(leftKey)) ?? groups[0];
  for (const group of groups) {
    if (group === keptGroup) continue;
    const nextNet = makeFreshNet(affectedNet, existingNets);
    existingNets.add(nextNet);
    const nextNetId = makeId('net_', new Set((module.nets ?? []).map((net) => net.id)));
    module.nets = [...(module.nets ?? []), { id: nextNetId, name: nextNet, kind: 'signal', aliases: [] }];
    for (const key of group) setEndpointNetByKey(module, key, nextNet, nextNetId);
    const groupKeys = new Set(group);
    for (const wire of module.wires) {
      if (groupKeys.has(endpointKey(wire.from) ?? '') || groupKeys.has(endpointKey(wire.to) ?? '')) {
        wire.net = nextNet;
        wire.net_id = nextNetId;
      }
    }
  }
}

function endpointKeysForNet(module: CircuitModule, net: string, netId?: string): Set<string> {
  const keys = new Set<string>();
  for (const component of module.components) {
    for (const pin of component.pins) {
      if (pin.net === net) keys.add(`c:${component.id}:${pin.id}`);
    }
  }
  for (const port of module.ports) {
    if (port.net === net) keys.add(`p:${port.id}`);
  }
  for (const wire of module.wires) {
    if (wire.net !== net && (!netId || wire.net_id !== netId)) continue;
    const from = endpointKey(wire.from);
    const to = endpointKey(wire.to);
    if (from) keys.add(from);
    if (to) keys.add(to);
  }
  return keys;
}

function collectNets(module: CircuitModule): Set<string> {
  const nets = new Set<string>();
  for (const component of module.components) {
    for (const pin of component.pins) {
      if (pin.net) nets.add(pin.net);
    }
  }
  for (const port of module.ports) {
    if (port.net) nets.add(port.net);
  }
  for (const wire of module.wires ?? []) {
    if (wire.net) nets.add(wire.net);
  }
  return nets;
}

function makeFreshNet(baseNet: string, existingNets: Set<string>): string {
  const token = wireIdToken(baseNet);
  for (let index = 1; index < 10000; index += 1) {
    const candidate = `n_${token}_${index}`;
    if (!existingNets.has(candidate)) return candidate;
  }
  return `n_${token}_${Date.now()}`;
}

function setEndpointNetByKey(module: CircuitModule, key: string, net: string, netId: string) {
  if (key.startsWith('c:')) {
    const [, componentId, pinId] = key.split(':');
    const component = module.components.find((entry) => entry.id === componentId);
    const pin = component?.pins.find((entry) => entry.id === pinId);
    if (pin) {
      pin.net = net;
      pin.net_id = netId;
    }
    return;
  }
  if (key.startsWith('p:')) {
    const [, portId] = key.split(':');
    const port = module.ports.find((entry) => entry.id === portId);
    if (port) {
      port.net = net;
      port.net_id = netId;
    }
    return;
  }
  if (key.startsWith('j:')) {
    const junctionId = key.slice(2);
    for (const wire of module.wires) {
      if (wire.from?.junction_id === junctionId || wire.to?.junction_id === junctionId) {
        wire.net = net;
        wire.net_id = netId;
      }
    }
  }
}

function chooseNetAnchor(module: CircuitModule, net: string, endpoints: EndpointHit[]): EndpointHit {
  const ports = endpoints.filter((endpoint) => endpoint.kind === 'port');
  const pins = endpoints.filter((endpoint) => endpoint.kind === 'pin');
  if (ports.length > 0 && pins.length > 0) {
    const port = ports[0];
    if (port && endpoints.length >= 4) return port;
    if (port) {
      return pins.reduce((best, endpoint) => (
        distance(endpoint, port) < distance(best, port) ? endpoint : best
      ), pins[0] ?? port);
    }
  }
  const diodeAnchor = diodeConnectedDrainAnchor(module, net, endpoints);
  if (diodeAnchor) return diodeAnchor;
  return [...endpoints].sort((left, right) => (left.x - right.x) || (left.y - right.y))[0] ?? endpoints[0]!;
}

function diodeConnectedDrainAnchor(module: CircuitModule, net: string, endpoints: EndpointHit[]): EndpointHit | null {
  for (const component of module.components) {
    if (component.type !== 'M' && component.type !== 'Q') continue;
    const activeNets = activeNetMap(component);
    if (activeNets.gate !== net || activeNets.drain !== net) continue;
    const drainPin = component.pins.find((pin) => (
      pin.net === net && /drain|collector|\bd\b|\bc\b/i.test(`${pin.id} ${pin.name}`)
    ));
    if (!drainPin) continue;
    const anchor = endpoints.find((endpoint) => (
      endpoint.kind === 'pin' &&
      endpoint.component_id === component.id &&
      endpoint.pin_id === drainPin.id
    ));
    if (anchor) return anchor;
  }
  return null;
}

function endpointPairKey(left: CircuitWireEndpoint | undefined, right: CircuitWireEndpoint | undefined): string {
  const leftKey = endpointKey(left) ?? `${left?.x ?? ''},${left?.y ?? ''}`;
  const rightKey = endpointKey(right) ?? `${right?.x ?? ''},${right?.y ?? ''}`;
  return [leftKey, rightKey].sort().join('<->');
}
