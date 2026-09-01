import { memo, type MouseEventHandler, type PointerEventHandler, type Ref } from 'react';
import type { CircuitComponent, CircuitPosition, CircuitWire } from '../types';
import {
  blockBodySize,
  blockPinBodyWorld,
  blockPinSide,
  componentBounds,
  componentLabelPositions,
  COMPONENT_NAME_FONT_SIZE,
  COMPONENT_VALUE_FONT_SIZE,
  displayComponentValue,
  displayComponentReference,
  crystalPinBodyWorld,
  isCrystalComponent,
  isPmosComponent,
  isMosBodyPin,
  isGroundPort,
  isSchematicPortVisible,
  NET_LABEL_FONT_SIZE,
  netLabelBounds,
  netLabelTextAnchor,
  pinWorld,
  PORT_LABEL_FONT_SIZE,
  portInteractionBounds,
  portNamePosition,
  portRenderSide,
  routePoints,
  SCHEMATIC_GRID,
  SIGNAL_LABEL_STUB,
  type EndpointHit,
  type SchematicDocument,
  type SchematicBounds,
  type SchematicNetLabel,
  type SchematicPortSide,
  type SchematicSelection,
  type SchematicTextAnchor,
  type SchematicTextPlacement,
} from './schematicDocument';
import {
  wireSelectionScope,
  type WireSelectionScope,
} from '../schematic-core/selection/netSelection';
import type { LiveErcDiagnostic } from '../schematic-core/diagnostics/liveErc';
import {
  resolveSymbolDefinition,
  resolveSymbolVariant,
  type SymbolIrGraphic,
} from './symbolIr';

const WIRE_COLOR = '#17851f';
const SYMBOL_COLOR = '#a00012';
const LABEL_COLOR = '#0000cc';
const MUTED_LABEL_COLOR = '#334155';
const LABEL_HALO_COLOR = '#ffffff';
const LABEL_FONT = 'Arial, Helvetica, sans-serif';
const MONO_FONT = 'Consolas, monospace';
const WIRE_STROKE = 3;
const SYMBOL_STROKE = 2.4;
const WIRE_SELECTION_COLOR = '#0ea5e9';
const COMPONENT_SELECTION_COLOR = '#f59e0b';

export interface RenderedJunction {
  point: CircuitPosition;
  net: string;
}

export interface RenderedUnconnectedCrossing {
  point: CircuitPosition;
  nets: [string, string];
}

export interface RenderedDanglingWireEnd {
  wireId: string;
  side: 'from' | 'to';
  point: CircuitPosition;
}

export interface RenderedPinConnectionState {
  componentId: string;
  pinId: string;
  point: CircuitPosition;
  state: 'dangling' | 'no-connect';
}

type WireDirection = 'left' | 'right' | 'up' | 'down';

interface JunctionAccumulator {
  point: CircuitPosition;
  net: string;
  directions: Set<WireDirection>;
}

interface JunctionSegment {
  wireId: string;
  net: string;
  netKey: string;
  start: CircuitPosition;
  end: CircuitPosition;
  horizontal: boolean;
  vertical: boolean;
}

interface Props {
  document: SchematicDocument;
  selection?: SchematicSelection;
  hoverSelection?: SchematicSelection;
  wireStart?: EndpointHit | null;
  wirePreview?: EndpointHit | null;
  hoverEndpoint?: EndpointHit | null;
  marqueeBounds?: SchematicBounds | null;
  showGrid?: boolean;
  cursor?: CSSCursor;
  viewBoxOverride?: SchematicBounds;
  rubberBandWireIds?: Set<string>;
  detachedWireIds?: Set<string>;
  diagnostics?: LiveErcDiagnostic[];
  placeGhost?: CircuitComponent | null;
  testId?: string;
  onPointerDown?: PointerEventHandler<SVGSVGElement>;
  onPointerMove?: PointerEventHandler<SVGSVGElement>;
  onPointerUp?: PointerEventHandler<SVGSVGElement>;
  onPointerCancel?: PointerEventHandler<SVGSVGElement>;
  onPointerLeave?: PointerEventHandler<SVGSVGElement>;
  onContextMenu?: MouseEventHandler<SVGSVGElement>;
  onDoubleClick?: MouseEventHandler<SVGSVGElement>;
  svgRef?: Ref<SVGSVGElement>;
}

export function SchematicDocumentSvg({
  document,
  selection = null,
  hoverSelection = null,
  wireStart = null,
  wirePreview = null,
  hoverEndpoint = null,
  marqueeBounds = null,
  showGrid = false,
  cursor = 'default',
  viewBoxOverride,
  rubberBandWireIds,
  detachedWireIds,
  diagnostics = [],
  placeGhost = null,
  testId = 'schematic-document-svg',
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onContextMenu,
  onDoubleClick,
  svgRef,
}: Props) {
  const viewBox = viewBoxOverride ?? document.viewBox;
  const width = Math.max(1, viewBox.maxX - viewBox.minX);
  const height = Math.max(1, viewBox.maxY - viewBox.minY);
  const gridId = `grid-${document.moduleId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const majorGridId = `major-grid-${document.moduleId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const previewPoints = wireStart && wirePreview ? routePoints(wireStart, wirePreview) : [];
  const selectedWireIds = selection?.kind === 'wire'
    ? [selection.id]
    : selection?.kind === 'wires'
      ? selection.ids
      : [];
  const selectedWireScope = wireSelectionScope(document.wires, selectedWireIds);
  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      className="schematic-document-svg"
      viewBox={`${viewBox.minX} ${viewBox.minY} ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', height: '100%', display: 'block', background: '#ffffff', touchAction: 'none', userSelect: 'none', cursor }}
      data-testid={testId}
      data-schematic-source="document"
      data-module-id={document.moduleId}
      data-cursor-mode={cursor}
      data-inline-diagnostic-count={diagnostics.length}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
    >
      <defs>
        <style>{`
          .schematic-document-svg line,
          .schematic-document-svg path,
          .schematic-document-svg rect,
          .schematic-document-svg polygon,
          .schematic-document-svg polyline,
          .schematic-document-svg circle {
            vector-effect: non-scaling-stroke;
          }
        `}</style>
        <pattern id={gridId} width={SCHEMATIC_GRID} height={SCHEMATIC_GRID} patternUnits="userSpaceOnUse">
          <path
            d={`M ${SCHEMATIC_GRID / 2} 0 L ${SCHEMATIC_GRID / 2} ${SCHEMATIC_GRID} M 0 ${SCHEMATIC_GRID / 2} L ${SCHEMATIC_GRID} ${SCHEMATIC_GRID / 2}`}
            fill="none"
            stroke="#f3f6fa"
            strokeWidth="1"
          />
          <path d={`M ${SCHEMATIC_GRID} 0 L 0 0 0 ${SCHEMATIC_GRID}`} fill="none" stroke="#e8eef5" strokeWidth="1" />
        </pattern>
        <pattern id={majorGridId} width={SCHEMATIC_GRID * 5} height={SCHEMATIC_GRID * 5} patternUnits="userSpaceOnUse">
          <path d={`M ${SCHEMATIC_GRID * 5} 0 L 0 0 0 ${SCHEMATIC_GRID * 5}`} fill="none" stroke="#d9e3ee" strokeWidth="1.25" />
        </pattern>
      </defs>
      {showGrid ? (
        <>
          <rect
            x={viewBox.minX}
            y={viewBox.minY}
            width={width}
            height={height}
            fill={`url(#${gridId})`}
            data-testid="schematic-grid-background"
          />
          <rect
            x={viewBox.minX}
            y={viewBox.minY}
            width={width}
            height={height}
            fill={`url(#${majorGridId})`}
            pointerEvents="none"
            data-testid="schematic-major-grid-background"
          />
        </>
      ) : null}
      <g data-layer="wires">
        {document.wires.map((wire) => {
          const selected = (selection?.kind === 'wire' && selection.id === wire.id) ||
            (selection?.kind === 'wires' && selection.ids.includes(wire.id));
          // Attached-wire highlight marks group membership only for a MULTI
          // component selection; a single selected component must not make its
          // wires look selected too.
          const selectedComponentIds = selection?.kind === 'components' ? selection.ids : [];
          const attachedSelected = selectedComponentIds.some((componentId) => (
            wire.from?.component_id === componentId || wire.to?.component_id === componentId
          ));
          const hovered = hoverSelection?.kind === 'wire' && hoverSelection.id === wire.id && !selected;
          return (
            <WirePath
              key={wire.id}
              wire={wire}
              selected={selected}
              attachedSelected={attachedSelected}
              hovered={hovered}
              rubberBand={rubberBandWireIds?.has(wire.id) ?? false}
              detached={detachedWireIds?.has(wire.id) ?? false}
              selectionScope={selectedWireScope}
            />
          );
        })}
        {previewPoints.length >= 2 ? (
          <polyline
            points={pointsAttribute(previewPoints)}
            fill="none"
            stroke="#2563eb"
            strokeWidth="4"
            strokeDasharray="9 7"
            strokeLinecap="round"
            strokeLinejoin="round"
            pointerEvents="none"
            data-testid="schematic-wire-preview"
          />
        ) : null}
      </g>

      <g data-layer="net-labels">
        {document.netLabels.map((label) => (
          // Rail labels (GND / power) are first-class selectable entities with
          // their own selection chrome; signal labels keep selecting the parent.
          <NetLabelSymbol
            key={label.id}
            label={label}
            placements={document.labelPlacements}
            selected={selection?.kind === 'netlabel' && selection.id === label.id}
            hovered={hoverSelection?.kind === 'netlabel' && hoverSelection.id === label.id && !(selection?.kind === 'netlabel' && selection.id === label.id)}
          />
        ))}
      </g>
      <g data-layer="ports">
        {document.module.ports.map((port) => {
          const position = document.portPositions.get(port.id);
          if (!position) return null;
          const connected = document.connectedPortIds.has(port.id);
          if (!isSchematicPortVisible(document, port)) return null;
          const portSide = portRenderSide(document, port, position);
          const labelPosition = document.labelPlacements.get(`port:${port.id}`) ?? portNamePosition(position, portSide);
          const interactionBounds = portInteractionBounds(position, portSide);
          const selected = selection?.kind === 'port' && selection.id === port.id;
          const hovered = hoverSelection?.kind === 'port' && hoverSelection.id === port.id && !selected;
          return (
            <g
              key={port.id}
              data-port-id={port.id}
              data-net={port.net}
              data-connected={connected ? 'true' : 'false'}
              data-port-side={portSide}
              data-selected={selected ? 'true' : 'false'}
              opacity={connected ? 1 : 0.38}
            >
              <rect
                x={interactionBounds.minX}
                y={interactionBounds.minY}
                width={interactionBounds.maxX - interactionBounds.minX}
                height={interactionBounds.maxY - interactionBounds.minY}
                fill="transparent"
                pointerEvents="all"
                data-testid="schematic-port-hit-target"
                data-port-id={port.id}
              />
              {selected || hovered ? (
                <rect
                  x={interactionBounds.minX}
                  y={interactionBounds.minY}
                  width={interactionBounds.maxX - interactionBounds.minX}
                  height={interactionBounds.maxY - interactionBounds.minY}
                  rx="4"
                  fill={selected ? '#f59e0b' : '#d97706'}
                  fillOpacity={selected ? 0.07 : 0.045}
                  stroke={selected ? COMPONENT_SELECTION_COLOR : '#d97706'}
                  strokeWidth={selected ? 1.8 : 1.5}
                  strokeDasharray={selected ? '8 6' : undefined}
                  pointerEvents="none"
                  data-testid={selected ? 'schematic-selected-port-frame' : 'schematic-hover-port-frame'}
                  data-selection-kind="port"
                  data-port-id={port.id}
                />
              ) : null}
              {isGroundPort(port) ? (
                <GroundSymbol position={position} />
              ) : port.signal_type === 'power' ? (
                <PowerFlagSymbol position={position} />
              ) : (
                <PortSymbol position={position} side={portSide === 'right' ? 'right' : 'left'} />
              )}
              <EndpointCircle
                point={position}
                kind="port"
                id={port.id}
                label={port.name}
                net={port.net}
              />
              <text
                x={labelPosition.x}
                y={labelPosition.y}
                textAnchor={labelPosition.anchor}
                fontSize={PORT_LABEL_FONT_SIZE}
                fontFamily={LABEL_FONT}
                fontWeight="700"
                fill={LABEL_COLOR}
                stroke={LABEL_HALO_COLOR}
                strokeWidth="3"
                paintOrder="stroke"
              >
                {port.name}
              </text>
            </g>
          );
        })}
      </g>
      <g data-layer="components">
        {document.module.components.map((component) => (
          <ComponentSymbol
            key={component.id}
            component={component}
            placements={document.labelPlacements}
            selected={selectionHasComponent(selection, component.id)}
            hovered={selectionHasComponent(hoverSelection, component.id) && !selectionHasComponent(selection, component.id)}
          />
        ))}
      </g>
      {placeGhost ? <PlaceGhostSymbol component={placeGhost} /> : null}
      <TopologyEndpointMarkers document={document} />
      <InlineDiagnosticLayer diagnostics={diagnostics} />
      <g data-layer="junctions" pointerEvents="none">
        {junctions(document).map(({ point, net }) => (
          <circle
            key={`${net}:${point.x},${point.y}`}
            cx={point.x}
            cy={point.y}
            r="4.6"
            fill="#cc0000"
            stroke="#ffffff"
            strokeWidth="1.2"
            data-testid="schematic-junction"
            data-net={net}
          />
        ))}
      </g>
      {wireStart ? (
        <circle
          cx={wireStart.x}
          cy={wireStart.y}
          r="7"
          fill="none"
          stroke="#2563eb"
          strokeWidth="2.5"
          strokeDasharray="6 5"
          pointerEvents="none"
        />
      ) : null}
      {marqueeBounds ? <MarqueeRect bounds={marqueeBounds} /> : null}
      {hoverEndpoint ? <EndpointHover endpoint={hoverEndpoint} /> : null}
    </svg>
  );
}

function selectionHasComponent(selection: SchematicSelection, componentId: string): boolean {
  if (selection?.kind === 'component') return selection.id === componentId;
  if (selection?.kind === 'components') return selection.ids.includes(componentId);
  return false;
}

function MarqueeRect({ bounds }: { bounds: SchematicBounds }) {
  return (
    <rect
      x={bounds.minX}
      y={bounds.minY}
      width={Math.max(1, bounds.maxX - bounds.minX)}
      height={Math.max(1, bounds.maxY - bounds.minY)}
      fill="rgba(37, 99, 235, 0.08)"
      stroke="#2563eb"
      strokeWidth="1.8"
      strokeDasharray="8 5"
      pointerEvents="none"
      data-testid="schematic-selection-marquee"
    />
  );
}

function railLabelChromeBounds(label: SchematicNetLabel): SchematicBounds {
  const { position } = label;
  // The selection chrome hugs the rail symbol artwork only — neither the label
  // text nor the connecting stub is framed, so a selected label never looks
  // like a selected wire.
  if (label.kind === 'ground') {
    return { minX: position.x - 26, minY: position.y - 4, maxX: position.x + 26, maxY: position.y + 44 };
  }
  return { minX: position.x - 26, minY: position.y - 18, maxX: position.x + 26, maxY: position.y + 6 };
}

function railStubPoints(endpoint: CircuitPosition, position: CircuitPosition): CircuitPosition[] {
  // Rail stubs always route orthogonally (drop first, then jog sideways);
  // arbitrary drag offsets must never produce a diagonal wire.
  if (endpoint.x === position.x || endpoint.y === position.y) return [endpoint, position];
  return [endpoint, { x: endpoint.x, y: position.y }, position];
}

function NetLabelSymbol({ label, placements, selected = false, hovered = false }: {
  label: SchematicNetLabel;
  placements: Map<string, SchematicTextPlacement>;
  selected?: boolean;
  hovered?: boolean;
}) {
  const { position, endpoint } = label;
  const text = placements.get(`netlabel:${label.id}`) ?? netLabelTextAnchor(label);
  const hit = netLabelBounds(label);
  const chrome = railLabelChromeBounds(label);
  if (label.kind === 'signal') {
    return <SignalNetLabelSymbol label={label} text={text} />;
  }
  const hasStub = Math.abs(endpoint.x - position.x) > 0.5 || Math.abs(endpoint.y - position.y) > 0.5;
  return (
    <g
      data-testid="schematic-net-label"
      data-net-label-id={label.id}
      data-net={label.net}
      data-kind={label.kind}
      data-component-id={label.endpoint.component_id || undefined}
      data-pin-id={label.endpoint.pin_id || undefined}
    >
      <rect
        x={hit.minX}
        y={hit.minY}
        width={Math.max(1, hit.maxX - hit.minX)}
        height={Math.max(1, hit.maxY - hit.minY)}
        fill="transparent"
        pointerEvents="all"
        data-testid="schematic-net-label-hit-target"
        data-net-label-id={label.id}
        data-component-id={label.endpoint.component_id || undefined}
      />
      {selected || hovered ? (
        <rect
          x={chrome.minX}
          y={chrome.minY}
          width={Math.max(1, chrome.maxX - chrome.minX)}
          height={Math.max(1, chrome.maxY - chrome.minY)}
          rx="4"
          fill={COMPONENT_SELECTION_COLOR}
          fillOpacity={selected ? 0.07 : 0.045}
          stroke={COMPONENT_SELECTION_COLOR}
          strokeWidth={selected ? 1.8 : 1.5}
          strokeDasharray={selected ? '8 6' : undefined}
          pointerEvents="none"
          data-testid={selected ? 'schematic-selected-net-label-frame' : 'schematic-hover-net-label-frame'}
          data-selection-kind="netlabel"
          data-net-label-id={label.id}
        />
      ) : null}
      {hasStub ? (
        <polyline
          points={pointsAttribute(railStubPoints(endpoint, position))}
          fill="none"
          stroke={WIRE_COLOR}
          strokeWidth={WIRE_STROKE}
          pointerEvents="none"
          data-testid="schematic-rail-label-stub"
        />
      ) : null}
      {label.kind === 'ground'
        ? <GroundSymbol position={position} />
        : <PowerFlagSymbol position={position} includeLead={false} />}
      <text
        x={text.x}
        y={text.y}
        textAnchor={text.anchor}
        fontSize={NET_LABEL_FONT_SIZE}
        fontFamily={LABEL_FONT}
        fontWeight="700"
        fill={LABEL_COLOR}
        stroke={LABEL_HALO_COLOR}
        strokeWidth="3"
        paintOrder="stroke"
        pointerEvents="none"
        data-testid="schematic-net-label-text"
      >
        {label.name}
      </text>
    </g>
  );
}

function SignalNetLabelSymbol({ label, text }: { label: SchematicNetLabel; text: SchematicTextPlacement }) {
  const { position } = label;
  const side = label.side ?? 'right';
  const stubLength = SIGNAL_LABEL_STUB;
  const end = {
    x: position.x + (side === 'left' ? -stubLength : side === 'right' ? stubLength : 0),
    y: position.y + (side === 'top' ? -stubLength : side === 'bottom' ? stubLength : 0),
  };
  const hit = netLabelBounds(label);
  return (
    <g
      data-testid="schematic-net-label"
      data-net-label-id={label.id}
      data-net={label.net}
      data-kind={label.kind}
      data-component-id={label.endpoint.component_id || undefined}
      data-pin-id={label.endpoint.pin_id || undefined}
    >
      <rect
        x={hit.minX}
        y={hit.minY}
        width={Math.max(1, hit.maxX - hit.minX)}
        height={Math.max(1, hit.maxY - hit.minY)}
        fill="transparent"
        pointerEvents="all"
        data-testid="schematic-net-label-hit-target"
        data-net-label-id={label.id}
        data-component-id={label.endpoint.component_id || undefined}
      />
      <line
        x1={position.x}
        y1={position.y}
        x2={end.x}
        y2={end.y}
        stroke={WIRE_COLOR}
        strokeWidth={WIRE_STROKE}
        pointerEvents="none"
      />
      <circle cx={position.x} cy={position.y} r="3.8" fill="#9aa3ad" stroke="#ffffff" strokeWidth="1" pointerEvents="none" />
      <text
        x={text.x}
        y={text.y}
        textAnchor={text.anchor}
        fontSize={NET_LABEL_FONT_SIZE}
        fontFamily={LABEL_FONT}
        fontWeight="700"
        fill={LABEL_COLOR}
        stroke={LABEL_HALO_COLOR}
        strokeWidth="3"
        paintOrder="stroke"
        pointerEvents="none"
        data-testid="schematic-net-label-text"
      >
        {label.name}
      </text>
    </g>
  );
}

type CSSCursor = 'default' | 'crosshair' | 'grab' | 'grabbing' | 'copy' | 'move';

const WirePath = memo(function WirePath({
  wire,
  selected,
  attachedSelected,
  hovered,
  rubberBand,
  detached,
  selectionScope,
}: {
  wire: CircuitWire;
  selected: boolean;
  attachedSelected?: boolean;
  hovered: boolean;
  rubberBand: boolean;
  detached: boolean;
  selectionScope: WireSelectionScope;
}) {
  const points = pointsAttribute(wire.points ?? []);
  if (!points) return null;
  return (
    <g
      data-wire-id={wire.id}
      data-wire-source={wire.source ?? ''}
      data-net={wire.net ?? ''}
      data-rubber-band={rubberBand ? 'true' : 'false'}
      data-detached-preview={detached ? 'true' : 'false'}
      data-hovered={hovered ? 'true' : undefined}
      data-selection-scope={selected ? selectionScope : undefined}
    >
      <polyline
        points={points}
        fill="none"
        stroke="transparent"
        strokeWidth="10"
        strokeLinecap="round"
        strokeLinejoin="round"
        data-wire-hitbox="true"
      />
      {rubberBand ? (
        <polyline
          points={points}
          fill="none"
          stroke="#22c55e"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="10 8"
          opacity="0.35"
          pointerEvents="none"
          data-testid="schematic-rubber-band-wire"
        />
      ) : null}
      {detached ? (
        <polyline
          points={points}
          fill="none"
          stroke="#dc2626"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="5 6"
          opacity="0.7"
          pointerEvents="none"
          data-testid="schematic-detached-wire-preview"
        />
      ) : null}
      <polyline
        points={points}
        fill="none"
        stroke={hovered ? '#2563eb' : 'transparent'}
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={hovered ? 0.28 : 0}
        pointerEvents="none"
        data-testid={hovered ? 'schematic-hover-wire-highlight' : undefined}
        data-hover-kind={hovered ? 'wire' : undefined}
        data-hover-shape={hovered ? 'route' : undefined}
      />
      {attachedSelected && !selected ? (
        <polyline
          points={points}
          fill="none"
          stroke={COMPONENT_SELECTION_COLOR}
          strokeWidth="9"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.4"
          pointerEvents="none"
          data-testid="schematic-attached-wire-highlight"
          data-selection-kind="attached-component"
          data-selection-shape="route"
        />
      ) : null}
      <polyline
        points={points}
        fill="none"
        stroke={selected ? (
          selectionScope === 'net'
            ? '#8b5cf6'
            : selectionScope === 'branch'
              ? '#0891b2'
              : WIRE_SELECTION_COLOR
        ) : 'transparent'}
        strokeWidth="11"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={selected ? 0.42 : 0}
        pointerEvents="none"
        data-testid={selected ? 'schematic-selected-wire-highlight' : undefined}
        data-selection-kind={selected ? 'wire' : undefined}
        data-selection-scope={selected ? selectionScope : undefined}
        data-selection-shape={selected ? 'route' : undefined}
      />
      <polyline
        points={points}
        fill="none"
        stroke={WIRE_COLOR}
        strokeWidth={WIRE_STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        pointerEvents="none"
      />
      {selected ? <WirePointHandles wire={wire} /> : null}
    </g>
  );
});

function InlineDiagnosticLayer({ diagnostics }: { diagnostics: LiveErcDiagnostic[] }) {
  return (
    <g data-layer="inline-diagnostics" pointerEvents="none">
      {diagnostics.filter((diagnostic) => diagnostic.point).map((diagnostic) => {
        const point = diagnostic.point!;
        const x = point.x + 10;
        const y = point.y - 10;
        const error = diagnostic.severity === 'error';
        return (
          <g
            key={diagnostic.id}
            transform={`translate(${x} ${y})`}
            data-testid="schematic-inline-diagnostic"
            data-diagnostic-id={diagnostic.id}
            data-code={diagnostic.code}
            data-severity={diagnostic.severity}
          >
            <title>{diagnostic.message}</title>
            <circle
              cx="0"
              cy="0"
              r="7"
              fill={error ? '#dc2626' : '#f59e0b'}
              stroke="#ffffff"
              strokeWidth="1.5"
            />
            <text
              x="0"
              y="3.8"
              textAnchor="middle"
              fontFamily={LABEL_FONT}
              fontSize="11"
              fontWeight="800"
              fill="#ffffff"
            >
              {error ? '×' : '!'}
            </text>
          </g>
        );
      })}
    </g>
  );
}


function TopologyEndpointMarkers({ document }: { document: SchematicDocument }) {
  const pins = pinConnectionVisuals(document);
  return (
    <g data-layer="connection-state-markers" pointerEvents="none">
      {danglingWireEnds(document).map((endpoint) => (
        <rect
          key={`${endpoint.wireId}:${endpoint.side}`}
          x={endpoint.point.x - 4.5}
          y={endpoint.point.y - 4.5}
          width="9"
          height="9"
          rx="1.5"
          fill="#ffffff"
          stroke="#f97316"
          strokeWidth="2"
          data-testid="schematic-dangling-wire-end"
          data-wire-id={endpoint.wireId}
          data-endpoint-side={endpoint.side}
        />
      ))}
      {pins.filter((pin) => pin.state === 'dangling').map((pin) => (
        <rect
          key={`${pin.componentId}:${pin.pinId}`}
          x={pin.point.x - 4.5}
          y={pin.point.y - 4.5}
          width="9"
          height="9"
          transform={`rotate(45 ${pin.point.x} ${pin.point.y})`}
          fill="#ffffff"
          stroke="#f97316"
          strokeWidth="2"
          data-testid="schematic-dangling-pin"
          data-component-id={pin.componentId}
          data-pin-id={pin.pinId}
        />
      ))}
      {pins.filter((pin) => pin.state === 'no-connect').map((pin) => (
        <g
          key={`${pin.componentId}:${pin.pinId}`}
          data-testid="schematic-no-connect-marker"
          data-component-id={pin.componentId}
          data-pin-id={pin.pinId}
          stroke="#7c3aed"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <line x1={pin.point.x - 6} y1={pin.point.y - 6} x2={pin.point.x + 6} y2={pin.point.y + 6} />
          <line x1={pin.point.x + 6} y1={pin.point.y - 6} x2={pin.point.x - 6} y2={pin.point.y + 6} />
        </g>
      ))}
    </g>
  );
}

function WirePointHandles({ wire }: { wire: CircuitWire }) {
  const points = wire.points ?? [];
  return (
    <g data-testid="schematic-wire-point-handles" pointerEvents="none">
      {points.map((point, index) => {
        const endpoint = index === 0 || index === points.length - 1;
        return (
          <circle
            key={`${wire.id}-${index}-${point.x},${point.y}`}
            cx={point.x}
            cy={point.y}
            r={endpoint ? 5.2 : 4.8}
            fill={endpoint ? '#ffffff' : WIRE_SELECTION_COLOR}
            stroke={WIRE_SELECTION_COLOR}
            strokeWidth="1.8"
            data-testid="schematic-wire-point-handle"
            data-wire-id={wire.id}
            data-point-index={index}
            data-selection-kind="wire"
            data-selection-handle-shape="circle"
          />
        );
      })}
    </g>
  );
}

const ComponentSymbol = memo(function ComponentSymbol({ component, placements, selected, hovered }: {
  component: CircuitComponent;
  placements?: Map<string, SchematicTextPlacement>;
  selected: boolean;
  hovered: boolean;
}) {
  const bounds = componentBounds(component);
  const pins = component.pins.map((pin, index) => ({ pin, point: pinWorld(component, pin, index) }));
  const labels = componentLabelPositions(component);
  const nameLabel = placements?.get(`component:${component.id}:name`) ?? labels.name;
  const valueLabel = placements?.get(`component:${component.id}:value`) ?? labels.value;
  return (
    <g data-component-id={component.id} data-component-type={component.type} data-hovered={hovered ? 'true' : undefined}>
      {hovered ? <ComponentHoverFrame bounds={bounds} /> : null}
      {selected ? <ComponentSelectionHandles bounds={bounds} /> : null}
      <LeadLines component={component} />
      <SymbolBody component={component} />
      {pins.map(({ pin, point }) => (
        <EndpointCircle
          key={pin.id}
          point={point}
          kind="pin"
          id={`${component.id}:${pin.id}`}
          label={`${component.name}.${pin.name}`}
          net={pin.net}
          componentId={component.id}
          pinId={pin.id}
          visible={selected}
        />
      ))}
      {component.type !== 'GND' ? (
        <text
          x={nameLabel.x}
          y={nameLabel.y}
          textAnchor={nameLabel.anchor}
          fontSize={COMPONENT_NAME_FONT_SIZE}
          fontFamily={LABEL_FONT}
          fontWeight="700"
          fill={LABEL_COLOR}
          stroke={LABEL_HALO_COLOR}
          strokeWidth="3"
          paintOrder="stroke"
          pointerEvents="none"
          data-testid="schematic-component-name-label"
        >
          {displayComponentReference(component)}
        </text>
      ) : null}
      {(component.type !== 'BLOCK' && component.type !== 'MODULE' && component.type !== 'GND') || isCrystalComponent(component) || Boolean(resolveSymbolVariant(component)) ? (
        <text
          x={valueLabel.x}
          y={valueLabel.y}
          textAnchor={valueLabel.anchor}
          fontSize={COMPONENT_VALUE_FONT_SIZE}
          fontFamily={LABEL_FONT}
          fill={LABEL_COLOR}
          stroke={LABEL_HALO_COLOR}
          strokeWidth="3"
          paintOrder="stroke"
          pointerEvents="none"
          data-testid="schematic-component-value-label"
          data-full-value={component.value}
        >
          {displayComponentValue(component.value)}
        </text>
      ) : null}
    </g>
  );
});

function PlaceGhostSymbol({ component }: { component: CircuitComponent }) {
  const labels = componentLabelPositions(component);
  return (
    <g opacity={0.45} pointerEvents="none" data-testid="schematic-place-ghost" data-ghost-type={component.type}>
      <LeadLines component={component} />
      <SymbolBody component={component} />
      {component.pins.map((pin, index) => {
        const point = pinWorld(component, pin, index);
        return (
          <circle
            key={`ghost-pin-${pin.id}`}
            cx={point.x}
            cy={point.y}
            r="3.2"
            fill="#cc0000"
            opacity="0.9"
          />
        );
      })}
      {component.type !== 'GND' ? (
        <text
          x={labels.name.x}
          y={labels.name.y}
          textAnchor={labels.name.anchor}
          fontSize={COMPONENT_NAME_FONT_SIZE}
          fontFamily={LABEL_FONT}
          fontWeight="700"
          fill={LABEL_COLOR}
          stroke={LABEL_HALO_COLOR}
          strokeWidth="3"
          paintOrder="stroke"
        >
          {displayComponentReference(component)}
        </text>
      ) : null}
      {(component.type !== 'BLOCK' && component.type !== 'MODULE' && component.type !== 'GND') || Boolean(resolveSymbolVariant(component)) ? (
        <text
          x={labels.value.x}
          y={labels.value.y}
          textAnchor={labels.value.anchor}
          fontSize={COMPONENT_VALUE_FONT_SIZE}
          fontFamily={LABEL_FONT}
          fill={LABEL_COLOR}
          stroke={LABEL_HALO_COLOR}
          strokeWidth="3"
          paintOrder="stroke"
        >
          {displayComponentValue(component.value)}
        </text>
      ) : null}
    </g>
  );
}

function ComponentHoverFrame({ bounds }: { bounds: ReturnType<typeof componentBounds> }) {
  const inset = 4;
  return (
    <rect
      x={bounds.minX - inset}
      y={bounds.minY - inset}
      width={bounds.maxX - bounds.minX + inset * 2}
      height={bounds.maxY - bounds.minY + inset * 2}
      fill="#d97706"
      fillOpacity="0.045"
      stroke="#d97706"
      strokeWidth="1.5"
      pointerEvents="none"
      data-testid="schematic-hover-component-frame"
      data-hover-kind="component"
      data-hover-shape="frame"
    />
  );
}

function ComponentSelectionHandles({ bounds }: { bounds: ReturnType<typeof componentBounds> }) {
  const inset = 6;
  const size = 8;
  const corners = [
    { x: bounds.minX - inset, y: bounds.minY - inset },
    { x: bounds.maxX + inset, y: bounds.minY - inset },
    { x: bounds.maxX + inset, y: bounds.maxY + inset },
    { x: bounds.minX - inset, y: bounds.maxY + inset },
  ];
  return (
    <g data-testid="schematic-selected-component-handles">
      <rect
        x={bounds.minX - inset}
        y={bounds.minY - inset}
        width={bounds.maxX - bounds.minX + inset * 2}
        height={bounds.maxY - bounds.minY + inset * 2}
        fill="#f59e0b"
        fillOpacity="0.07"
        stroke={COMPONENT_SELECTION_COLOR}
        strokeWidth="1.8"
        strokeDasharray="8 6"
        pointerEvents="all"
        data-testid="schematic-selected-component-frame"
        data-selection-kind="component"
        data-selection-shape="frame"
      />
      {corners.map((corner) => (
        <rect
          key={`${corner.x},${corner.y}`}
          x={corner.x - size / 2}
          y={corner.y - size / 2}
          width={size}
          height={size}
          rx="1.5"
          fill="#ffffff"
          stroke={COMPONENT_SELECTION_COLOR}
          strokeWidth="1.6"
          pointerEvents="all"
          data-testid="schematic-selected-component-corner"
          data-selection-kind="component"
          data-selection-handle-shape="square"
        />
      ))}
    </g>
  );
}

function LeadLines({ component }: { component: CircuitComponent }) {
  if (resolveSymbolVariant(component)) return null;
  if (isCrystalComponent(component)) {
    return (
      <g stroke={SYMBOL_COLOR} strokeWidth="2.2" pointerEvents="none">
        {component.pins.map((pin, index) => {
          const endpoint = pinWorld(component, pin, index);
          const body = crystalPinBodyWorld(component, pin, index);
          return <line key={`crystal-lead-${pin.id}`} x1={endpoint.x} y1={endpoint.y} x2={body.x} y2={body.y} />;
        })}
      </g>
    );
  }
  if ((component.type === 'BLOCK' || component.type === 'MODULE')) {
    return (
      <g stroke={SYMBOL_COLOR} strokeWidth="2.2" pointerEvents="none" data-testid="schematic-block-leads">
        {component.pins.map((pin, index) => {
          const endpoint = pinWorld(component, pin, index);
          const body = blockPinBodyWorld(component, pin, index);
          return <line key={`block-lead-${pin.id}`} x1={endpoint.x} y1={endpoint.y} x2={body.x} y2={body.y} />;
        })}
      </g>
    );
  }
  if (component.pins.length !== 2) return null;
  const bodyOffsets = bodyTerminalOffsets(component);
  return (
    <g stroke={SYMBOL_COLOR} strokeWidth="2" pointerEvents="none">
      {component.pins.map((pin, index) => {
        const point = pinWorld(component, pin, index);
        const offset = bodyOffsets[index];
        if (!offset) return null;
        return (
          <line
            key={`lead-${pin.id}`}
            x1={point.x}
            y1={point.y}
            x2={component.position.x + offset.x}
            y2={component.position.y + offset.y}
          />
        );
      })}
    </g>
  );
}

function SymbolBody({ component }: { component: CircuitComponent }) {
  const { x, y } = component.position;
  const rotation = component.rotation ?? 0;
  if (isCrystalComponent(component)) {
    const groundedCase = component.pins.length > 2;
    return (
      <g
        transform={`rotate(${rotation} ${x} ${y})`}
        fill="none"
        stroke={SYMBOL_COLOR}
        strokeWidth="2.4"
        pointerEvents="none"
        data-testid="schematic-symbol-body"
        data-symbol-kind="crystal"
      >
        {groundedCase ? <rect x={x - 25} y={y - 30} width="50" height="60" rx="3" fill="#fff" /> : null}
        <line x1={x - 12} y1={y - 24} x2={x - 12} y2={y + 24} />
        <line x1={x + 12} y1={y - 24} x2={x + 12} y2={y + 24} />
        <rect x={x - 5} y={y - 18} width="10" height="36" fill="#fff" />
      </g>
    );
  }
  const symbol = resolveSymbolVariant(component);
  const definition = resolveSymbolDefinition(component);
  if (symbol && definition) {
    return <GenericIrSymbol component={component} graphics={symbol.graphics} />;
  }
  if (component.type === 'R') {
    return (
      <g transform={`rotate(${rotation} ${x} ${y})`} pointerEvents="none" data-testid="schematic-symbol-body" data-symbol-kind="resistor">
        <rect x={x - 29} y={y - 10} width="58" height="20" rx="2" fill="#fff" stroke={SYMBOL_COLOR} strokeWidth="2.4" />
      </g>
    );
  }
  if (component.type === 'C') {
    return (
      <g transform={`rotate(${rotation} ${x} ${y})`} pointerEvents="none" data-testid="schematic-symbol-body" data-symbol-kind="capacitor">
        <line x1={x - 8} y1={y - 30} x2={x - 8} y2={y + 30} stroke={SYMBOL_COLOR} strokeWidth="2.4" />
        <line x1={x + 8} y1={y - 30} x2={x + 8} y2={y + 30} stroke={SYMBOL_COLOR} strokeWidth="2.4" />
      </g>
    );
  }
  if (component.type === 'L') {
    return (
      <g transform={`rotate(${rotation} ${x} ${y})`} fill="none" stroke={SYMBOL_COLOR} strokeWidth="2.4" pointerEvents="none" data-testid="schematic-symbol-body" data-symbol-kind="inductor">
        <path d={`M ${x - 32} ${y} A 8 8 0 0 1 ${x - 16} ${y} A 8 8 0 0 1 ${x} ${y} A 8 8 0 0 1 ${x + 16} ${y} A 8 8 0 0 1 ${x + 32} ${y}`} />
      </g>
    );
  }
  if (component.type === 'D') {
    return (
      <g transform={`rotate(${rotation} ${x} ${y})`} fill="none" stroke={SYMBOL_COLOR} strokeWidth="2.4" pointerEvents="none" data-testid="schematic-symbol-body" data-symbol-kind="diode">
        <path d={`M ${x - 22} ${y - 24} L ${x - 22} ${y + 24} L ${x + 20} ${y} Z`} />
        <line x1={x + 22} y1={y - 25} x2={x + 22} y2={y + 25} />
      </g>
    );
  }
  if ((component.type === 'BLOCK' || component.type === 'MODULE')) {
    const { width, height } = blockBodySize(component);
    return (
      <g pointerEvents="none" data-testid="schematic-symbol-body" data-symbol-kind="block">
        <g transform={`rotate(${rotation} ${x} ${y})`}>
          <rect
            x={x - width / 2}
            y={y - height / 2}
            width={width}
            height={height}
            rx="2"
            fill="#fff"
            stroke={SYMBOL_COLOR}
            strokeWidth={SYMBOL_STROKE}
          />
          <text
            x={x}
            y={y + 6}
            textAnchor="middle"
            fontSize="18"
            fontFamily={LABEL_FONT}
            fontWeight="700"
            fill={LABEL_COLOR}
            stroke={LABEL_HALO_COLOR}
            strokeWidth="3"
            paintOrder="stroke"
            data-testid="schematic-block-label"
          >
            {component.value}
          </text>
        </g>
        {component.pins.map((pin, index) => {
          const body = blockPinBodyWorld(component, pin, index);
          const side = blockPinSide(component, pin, index);
          const dx = body.x - x;
          const dy = body.y - y;
          const horizontalEdge = Math.abs(dx) >= Math.abs(dy);
          const labelX = horizontalEdge ? body.x + (dx < 0 ? 8 : -8) : body.x;
          const labelY = horizontalEdge ? body.y + 5 : body.y + (dy < 0 ? 16 : -8);
          const anchor: SchematicTextAnchor = horizontalEdge ? (dx < 0 ? 'start' : 'end') : 'middle';
          return (
            <text
              key={`block-pin-label-${pin.id}`}
              x={labelX}
              y={labelY}
              textAnchor={anchor}
              fontSize="13"
              fontFamily={LABEL_FONT}
              fill={LABEL_COLOR}
              stroke={LABEL_HALO_COLOR}
              strokeWidth="2.5"
              paintOrder="stroke"
              data-testid="schematic-block-pin-label"
              data-pin-id={pin.id}
              data-pin-side={side}
            >
              {pin.name}
            </text>
          );
        })}
      </g>
    );
  }
  if (component.type === 'M') {
    const pmos = isPmosComponent(component);
    const gateX = x - 20;
    const channelX = x + 4;
    const terminalX = x + 22;
    return (
      <g
        transform={`rotate(${rotation} ${x} ${y})`}
        fill="none"
        stroke={SYMBOL_COLOR}
        strokeWidth={SYMBOL_STROKE}
        strokeLinecap="square"
        strokeLinejoin="miter"
        pointerEvents="none"
        data-testid="schematic-symbol-body"
        data-symbol-kind="mosfet"
        data-symbol-polarity={pmos ? 'pmos' : 'nmos'}
        data-mos-arrow={pmos ? 'out' : 'in'}
        data-mos-body="separate"
      >
        <circle cx={x + 2} cy={y} r="44" fill="#fff" data-testid="schematic-mos-outline" />
        <line x1={gateX} y1={y - 34} x2={gateX} y2={y + 34} />
        <line x1={channelX} y1={y - 36} x2={channelX} y2={y - 14} />
        <line x1={channelX} y1={y - 7} x2={channelX} y2={y + 7} />
        <line x1={channelX} y1={y + 14} x2={channelX} y2={y + 36} />
        <line x1={x - 58} y1={y} x2={gateX} y2={y} />
        <path d={`M ${channelX} ${y - 30} H ${terminalX} V ${y - 52}`} />
        <path d={`M ${channelX} ${y + 30} H ${terminalX} V ${y + 52}`} />
        <line x1={channelX} y1={y} x2={x + 58} y2={y} />
        <circle cx={terminalX} cy={y - 30} r="2.8" fill={SYMBOL_COLOR} stroke="none" />
        <circle cx={terminalX} cy={y + 30} r="2.8" fill={SYMBOL_COLOR} stroke="none" />
        <path
          d={pmos
            ? `M ${x + 20} ${y} L ${x + 10} ${y - 6} L ${x + 10} ${y + 6} Z`
            : `M ${x + 8} ${y} L ${x + 18} ${y - 6} L ${x + 18} ${y + 6} Z`}
          fill={SYMBOL_COLOR}
          stroke="none"
          data-testid="schematic-mos-arrow"
        />
      </g>
    );
  }
  if (component.type === 'Q') {
    const pnp = isPnpComponent(component);
    return (
      <g
        transform={`rotate(${rotation} ${x} ${y})`}
        fill="none"
        stroke={SYMBOL_COLOR}
        strokeWidth={SYMBOL_STROKE}
        strokeLinecap="square"
        strokeLinejoin="miter"
        pointerEvents="none"
        data-testid="schematic-symbol-body"
        data-symbol-kind="bjt"
        data-symbol-polarity={pnp ? 'pnp' : 'npn'}
      >
        <line x1={x - 18} y1={y - 34} x2={x - 18} y2={y + 34} />
        <line x1={x - 58} y1={y} x2={x - 18} y2={y} />
        <line x1={x - 18} y1={y - 20} x2={x + 30} y2={y - 52} />
        <line x1={x - 18} y1={y + 20} x2={x + 30} y2={y + 52} />
        <path
          d={pnp
            ? `M ${x + 4} ${y + 34} L ${x + 20} ${y + 39} L ${x + 9} ${y + 51} Z`
            : `M ${x + 31} ${y + 52} L ${x + 14} ${y + 48} L ${x + 24} ${y + 36} Z`}
          fill={SYMBOL_COLOR}
          stroke="none"
        />
      </g>
    );
  }
  if (component.type === 'E') {
    return (
      <g
        transform={`rotate(${rotation} ${x} ${y})`}
        fill="none"
        stroke={SYMBOL_COLOR}
        strokeWidth={SYMBOL_STROKE}
        strokeLinecap="square"
        strokeLinejoin="miter"
        pointerEvents="none"
        data-testid="schematic-symbol-body"
        data-symbol-kind="opamp"
      >
        <path d={`M ${x - 42} ${y - 52} L ${x - 42} ${y + 52} L ${x + 52} ${y} Z`} fill="#fff" />
        <line x1={x - 58} y1={y - 24} x2={x - 42} y2={y - 24} />
        <line x1={x - 58} y1={y + 24} x2={x - 42} y2={y + 24} />
        <line x1={x + 52} y1={y} x2={x + 64} y2={y} />
        <line x1={x} y1={y + 42} x2={x} y2={y + 58} />
        <text x={x - 31} y={y - 16} fontSize="15" fontFamily={LABEL_FONT} fontWeight="700" fill={SYMBOL_COLOR} stroke="none">-</text>
        <text x={x - 33} y={y + 31} fontSize="15" fontFamily={LABEL_FONT} fontWeight="700" fill={SYMBOL_COLOR} stroke="none">+</text>
      </g>
    );
  }
  if (component.type === 'GND') {
    // The component position is the anchor pin; the ground symbol hangs below
    // it and rotates around the pin like every other symbol (qucs parity).
    return (
      <g transform={`rotate(${rotation} ${x} ${y})`} pointerEvents="none" data-testid="schematic-symbol-body" data-symbol-kind="ground">
        <GroundSymbol position={{ x, y }} />
      </g>
    );
  }
  return (
    <g pointerEvents="none" data-testid="schematic-symbol-body" data-symbol-kind={component.type === 'V' ? 'voltage-source' : component.type === 'I' ? 'current-source' : 'generic'}>
      <circle cx={x} cy={y} r="28" fill="#fff" stroke={SYMBOL_COLOR} strokeWidth="2.4" />
      {component.type === 'V' ? (
        <>
          <text x={x} y={y + 6} textAnchor="middle" fontSize="20" fontFamily={LABEL_FONT} fontWeight="700" fill="#0f172a">V</text>
          <text x={x - 18} y={y - 16} textAnchor="middle" fontSize="13" fontFamily={LABEL_FONT} fontWeight="700" fill={SYMBOL_COLOR}>+</text>
          <text x={x - 18} y={y + 24} textAnchor="middle" fontSize="15" fontFamily={LABEL_FONT} fontWeight="700" fill={SYMBOL_COLOR}>-</text>
        </>
      ) : component.type === 'I' ? (
        <>
          <line x1={x} y1={y + 16} x2={x} y2={y - 13} stroke={SYMBOL_COLOR} strokeWidth="2.2" />
          <path d={`M ${x - 7} ${y - 6} L ${x} ${y - 17} L ${x + 7} ${y - 6}`} fill="none" stroke={SYMBOL_COLOR} strokeWidth="2.2" />
        </>
      ) : (
        <text x={x} y={y + 4} textAnchor="middle" fontSize="15" fontFamily={LABEL_FONT} fontWeight="700">
          {component.type}
        </text>
      )}
    </g>
  );
}

function irStrokeWidth(graphic: Exclude<SymbolIrGraphic, { kind: 'text' }>): number {
  return graphic.stroke.width > 0 ? Math.max(1.2, graphic.stroke.width) : SYMBOL_STROKE;
}

function irFill(graphic: Exclude<SymbolIrGraphic, { kind: 'text' }>): string {
  if (graphic.fill === 'background') return '#ffffff';
  if (graphic.fill === 'outline') return SYMBOL_COLOR;
  return 'none';
}

function irArcPath(graphic: Extract<SymbolIrGraphic, { kind: 'arc' }>): string {
  const { start, mid, end } = graphic;
  const determinant = 2 * (
    start.x * (mid.y - end.y)
    + mid.x * (end.y - start.y)
    + end.x * (start.y - mid.y)
  );
  if (Math.abs(determinant) < 1e-6) return `M ${start.x} ${start.y} L ${mid.x} ${mid.y} L ${end.x} ${end.y}`;
  const startSquare = start.x * start.x + start.y * start.y;
  const midSquare = mid.x * mid.x + mid.y * mid.y;
  const endSquare = end.x * end.x + end.y * end.y;
  const cx = (
    startSquare * (mid.y - end.y)
    + midSquare * (end.y - start.y)
    + endSquare * (start.y - mid.y)
  ) / determinant;
  const cy = (
    startSquare * (end.x - mid.x)
    + midSquare * (start.x - end.x)
    + endSquare * (mid.x - start.x)
  ) / determinant;
  const radius = Math.hypot(start.x - cx, start.y - cy);
  const turn = (from: CircuitPosition, to: CircuitPosition) => {
    const value = Math.atan2(to.y - cy, to.x - cx) - Math.atan2(from.y - cy, from.x - cx);
    return (value + Math.PI * 2) % (Math.PI * 2);
  };
  const clockwiseToMid = turn(start, mid);
  const clockwiseToEnd = turn(start, end);
  const sweep = clockwiseToMid <= clockwiseToEnd ? 1 : 0;
  const span = sweep ? clockwiseToEnd : (Math.PI * 2 - clockwiseToEnd) % (Math.PI * 2);
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${span > Math.PI ? 1 : 0} ${sweep} ${end.x} ${end.y}`;
}

function GenericIrSymbol({ component, graphics }: {
  component: CircuitComponent;
  graphics: SymbolIrGraphic[];
}) {
  const symbol = resolveSymbolVariant(component);
  const definition = resolveSymbolDefinition(component);
  if (!symbol || !definition) return null;
  const rotation = component.rotation ?? 0;
  return (
    <g
      transform={`translate(${component.position.x} ${component.position.y}) rotate(${rotation})`}
      pointerEvents="none"
      data-testid="schematic-symbol-body"
      data-symbol-kind="kicad-ir"
      data-symbol-id={definition.id}
      data-symbol-unit={symbol.unit}
    >
      {graphics.map((graphic, index) => {
        if (graphic.kind === 'polyline') return (
          <polyline key={index} points={graphic.points.map((point) => `${point.x},${point.y}`).join(' ')} fill={irFill(graphic)} stroke={SYMBOL_COLOR} strokeWidth={irStrokeWidth(graphic)} />
        );
        if (graphic.kind === 'rectangle') return (
          <rect key={index} x={Math.min(graphic.start.x, graphic.end.x)} y={Math.min(graphic.start.y, graphic.end.y)} width={Math.abs(graphic.end.x - graphic.start.x)} height={Math.abs(graphic.end.y - graphic.start.y)} fill={irFill(graphic)} stroke={SYMBOL_COLOR} strokeWidth={irStrokeWidth(graphic)} />
        );
        if (graphic.kind === 'circle') return (
          <circle key={index} cx={graphic.center.x} cy={graphic.center.y} r={graphic.radius} fill={irFill(graphic)} stroke={SYMBOL_COLOR} strokeWidth={irStrokeWidth(graphic)} />
        );
        if (graphic.kind === 'arc') return (
          <path key={index} d={irArcPath(graphic)} fill={irFill(graphic)} stroke={SYMBOL_COLOR} strokeWidth={irStrokeWidth(graphic)} />
        );
        return graphic.effects.visible ? (
          <text key={index} x={graphic.at.x} y={graphic.at.y} transform={`rotate(${graphic.angle} ${graphic.at.x} ${graphic.at.y})`} fontSize={graphic.effects.font_size} fontFamily={LABEL_FONT} fontWeight={graphic.effects.bold ? '700' : undefined} fontStyle={graphic.effects.italic ? 'italic' : undefined} fill={LABEL_COLOR}>{graphic.text}</text>
        ) : null;
      })}
      {symbol.pins.map((pin) => {
        const radians = pin.angle * Math.PI / 180;
        const inner = {
          x: pin.at.x + Math.cos(radians) * pin.length,
          y: pin.at.y + Math.sin(radians) * pin.length,
        };
        const clock = pin.shape.includes('clock');
        const inverted = pin.shape.includes('inverted');
        const normalX = -Math.sin(radians) * 5;
        const normalY = Math.cos(radians) * 5;
        const nameOffset = definition.pin_names.offset || 6;
        const nameAt = {
          x: inner.x + Math.cos(radians) * nameOffset,
          y: inner.y + Math.sin(radians) * nameOffset + pin.name_effects.font_size * 0.35,
        };
        return (
          <g key={`ir-pin-${pin.number}`} data-pin-number={pin.number} data-pin-shape={pin.shape}>
            <line x1={pin.at.x} y1={pin.at.y} x2={inner.x} y2={inner.y} stroke={SYMBOL_COLOR} strokeWidth={SYMBOL_STROKE} />
            {clock ? <path d={`M ${inner.x} ${inner.y} L ${inner.x - Math.cos(radians) * 9 + normalX} ${inner.y - Math.sin(radians) * 9 + normalY} L ${inner.x - Math.cos(radians) * 9 - normalX} ${inner.y - Math.sin(radians) * 9 - normalY} Z`} fill="none" stroke={SYMBOL_COLOR} strokeWidth={SYMBOL_STROKE} /> : null}
            {inverted ? <circle cx={inner.x} cy={inner.y} r="4" fill="#fff" stroke={SYMBOL_COLOR} strokeWidth={SYMBOL_STROKE} /> : null}
            {definition.pin_names.visible && pin.name_effects.visible && pin.name && pin.name !== '~' ? <text x={nameAt.x} y={nameAt.y} textAnchor={Math.cos(radians) < -0.1 ? 'end' : Math.cos(radians) > 0.1 ? 'start' : 'middle'} fontSize={pin.name_effects.font_size} fontFamily={LABEL_FONT} fill={LABEL_COLOR}>{pin.name}</text> : null}
            {definition.pin_numbers.visible && pin.number_effects.visible ? <text x={(pin.at.x + inner.x) / 2} y={(pin.at.y + inner.y) / 2 - 4} textAnchor="middle" fontSize={pin.number_effects.font_size} fontFamily={LABEL_FONT} fill={LABEL_COLOR}>{pin.number}</text> : null}
          </g>
        );
      })}
    </g>
  );
}

function isPnpComponent(component: CircuitComponent): boolean {
  return /\bpnp\b|p-bipolar|p bipolar/i.test(`${component.id} ${component.name} ${component.value}`);
}

function bodyTerminalOffsets(component: CircuitComponent): [CircuitPosition, CircuitPosition] {
  let span = 28;
  if (component.type === 'C') span = 8;
  if (component.type === 'D') span = 22;
  if (component.type === 'L') span = 36;
  if (component.type === 'V' || component.type === 'I') span = 28;
  return [
    rotateOffset({ x: -span, y: 0 }, component.rotation ?? 0),
    rotateOffset({ x: span, y: 0 }, component.rotation ?? 0),
  ];
}

function rotateOffset(offset: CircuitPosition, rotation: number): CircuitPosition {
  const normalized = ((rotation % 360) + 360) % 360;
  if (normalized === 90) return { x: -offset.y, y: offset.x };
  if (normalized === 180) return { x: -offset.x, y: -offset.y };
  if (normalized === 270) return { x: offset.y, y: -offset.x };
  return offset;
}

function EndpointHover({ endpoint }: { endpoint: EndpointHit }) {
  return (
    <g pointerEvents="none" data-testid="schematic-hover-endpoint" data-label={endpoint.label} data-net={endpoint.net ?? ''}>
      <circle cx={endpoint.x} cy={endpoint.y} r="10" fill="rgba(37, 99, 235, 0.10)" stroke="#2563eb" strokeWidth="2" />
      <circle cx={endpoint.x} cy={endpoint.y} r="4" fill="#2563eb" />
      <text
        x={endpoint.x + 12}
        y={endpoint.y - 12}
        fontSize="11"
        fontFamily={LABEL_FONT}
        fontWeight="700"
        fill={LABEL_COLOR}
        stroke={LABEL_HALO_COLOR}
        strokeWidth="3"
        paintOrder="stroke"
        data-testid="schematic-hover-endpoint-label"
      >
        {endpoint.label}
      </text>
      {endpoint.net ? (
        <text
          x={endpoint.x + 12}
          y={endpoint.y + 3}
          fontSize="9"
          fontFamily={MONO_FONT}
          fill={MUTED_LABEL_COLOR}
          stroke={LABEL_HALO_COLOR}
          strokeWidth="2.5"
          paintOrder="stroke"
          data-testid="schematic-hover-endpoint-net"
        >
          {endpoint.net}
        </text>
      ) : null}
    </g>
  );
}

function EndpointCircle({
  point,
  kind,
  id,
  label,
  net,
  componentId,
  pinId,
  visible,
}: {
  point: CircuitPosition;
  kind: 'pin' | 'port';
  id: string;
  label: string;
  net: string;
  componentId?: string;
  pinId?: string;
  visible?: boolean;
}) {
  const pin = kind === 'pin';
  const show = !pin || visible;
  return (
    <circle
      cx={point.x}
      cy={point.y}
      r={pin ? (show ? 3.2 : 5.5) : 3.6}
      fill={pin ? (show ? '#cc0000' : 'transparent') : '#7b8490'}
      stroke={show ? '#ffffff' : 'none'}
      strokeWidth={show ? '1.2' : '0'}
      opacity={show ? (pin ? 0.9 : 0.82) : 0}
      data-endpoint-kind={kind}
      data-endpoint-id={id}
      data-component-id={componentId}
      data-pin-id={pinId}
      data-label={label}
      data-net={net}
      data-visible={show ? 'true' : 'false'}
    />
  );
}

function PortSymbol({ position, side }: { position: CircuitPosition; side: 'left' | 'right' }) {
  const points = side === 'left'
    ? [
        `${position.x} ${position.y}`,
        `${position.x - 24} ${position.y - 18}`,
        `${position.x - 42} ${position.y - 18}`,
        `${position.x - 42} ${position.y + 18}`,
        `${position.x - 24} ${position.y + 18}`,
      ]
    : [
        `${position.x} ${position.y - 18}`,
        `${position.x + 24} ${position.y - 18}`,
        `${position.x + 42} ${position.y}`,
        `${position.x + 24} ${position.y + 18}`,
        `${position.x} ${position.y + 18}`,
      ];
  return <polygon points={points.join(' ')} fill="#fff" stroke={SYMBOL_COLOR} strokeWidth="2" pointerEvents="none" />;
}

function PowerFlagSymbol({
  position,
  includeLead = true,
}: {
  position: CircuitPosition;
  /** When false, the pin→flag stub is drawn separately (rail net labels). */
  includeLead?: boolean;
}) {
  const barY = includeLead ? position.y - 34 : position.y;
  return (
    <g fill="none" pointerEvents="none">
      {includeLead ? (
        <line x1={position.x} y1={position.y} x2={position.x} y2={barY} stroke={WIRE_COLOR} strokeWidth="2.4" />
      ) : null}
      <line x1={position.x - 18} y1={barY} x2={position.x + 18} y2={barY} stroke={SYMBOL_COLOR} strokeWidth="2.4" />
      <line x1={position.x} y1={barY} x2={position.x} y2={barY - 12} stroke={SYMBOL_COLOR} strokeWidth="2.4" />
    </g>
  );
}

function GroundSymbol({ position }: { position: CircuitPosition }) {
  return (
    <g stroke={SYMBOL_COLOR} strokeWidth="2" fill="none" pointerEvents="none">
      <line x1={position.x} y1={position.y} x2={position.x} y2={position.y + 22} />
      <line x1={position.x - 20} y1={position.y + 22} x2={position.x + 20} y2={position.y + 22} />
      <line x1={position.x - 13} y1={position.y + 30} x2={position.x + 13} y2={position.y + 30} />
      <line x1={position.x - 6} y1={position.y + 38} x2={position.x + 6} y2={position.y + 38} />
    </g>
  );
}

function pointsAttribute(points: CircuitPosition[]): string {
  return points.map((point) => `${round(point.x)},${round(point.y)}`).join(' ');
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function junctions(document: SchematicDocument): RenderedJunction[] {
  const junctionMap = new Map<string, JunctionAccumulator>();
  const segments: JunctionSegment[] = [];
  for (const wire of document.wires) {
    const net = wire.net ?? '';
    const netKey = wire.net_id ?? net;
    if (!netKey) continue;
    const points = wire.points ?? [];
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      if (!start || !end || samePoint(start, end)) continue;
      const segment: JunctionSegment = {
        wireId: wire.id,
        net,
        netKey,
        start,
        end,
        horizontal: round(start.y) === round(end.y),
        vertical: round(start.x) === round(end.x),
      };
      segments.push(segment);
      addSegmentDirectionsAtPoint(junctionMap, segment, start);
      addSegmentDirectionsAtPoint(junctionMap, segment, end);
    }
  }
  for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
    const left = segments[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
      const right = segments[rightIndex];
      if (!right || left.netKey !== right.netKey) continue;
      for (const point of [left.start, left.end]) {
        if (!pointOnSegment(point, right)) continue;
        addSegmentDirectionsAtPoint(junctionMap, left, point);
        addSegmentDirectionsAtPoint(junctionMap, right, point);
      }
      for (const point of [right.start, right.end]) {
        if (!pointOnSegment(point, left)) continue;
        addSegmentDirectionsAtPoint(junctionMap, left, point);
        addSegmentDirectionsAtPoint(junctionMap, right, point);
      }
      // Same-net wires that cross are one electrical node: mark the
      // connection (T or X) with a junction dot. Different-net crossings
      // never reach this loop and render as plain crossings.
      const crossing = orthogonalSegmentIntersection(left, right);
      if (crossing) {
        addSegmentDirectionsAtPoint(junctionMap, left, crossing);
        addSegmentDirectionsAtPoint(junctionMap, right, crossing);
      }
    }
  }
  for (const component of document.module?.components ?? []) {
    component.pins.forEach((pin, index) => {
      if (component.type === 'M' && /body|bulk|\bb\b/i.test(`${pin.id} ${pin.name}`)) return;
      const net = pin.net ?? '';
      const netKey = pin.net_id ?? net;
      if (!netKey) return;
      const point = pinWorld(component, pin, index);
      if (samePoint(point, component.position)) return;
      addJunctionDirection(junctionMap, netKey, net, point, directionBetween(point, component.position));
    });
  }
  return [...junctionMap.values()]
    .filter((entry) => entry.directions.size > 2)
    .map(({ point, net }) => ({ point, net }));
}

export function unconnectedCrossings(
  document: SchematicDocument,
): RenderedUnconnectedCrossing[] {
  const segments: JunctionSegment[] = [];
  for (const wire of document.wires) {
    const net = wire.net ?? '';
    const netKey = wire.net_id ?? net;
    for (let index = 1; index < wire.points.length; index += 1) {
      const start = wire.points[index - 1];
      const end = wire.points[index];
      if (!start || !end || samePoint(start, end)) continue;
      segments.push({
        wireId: wire.id,
        net,
        netKey,
        start,
        end,
        horizontal: round(start.y) === round(end.y),
        vertical: round(start.x) === round(end.x),
      });
    }
  }
  const crossings = new Map<string, RenderedUnconnectedCrossing>();
  for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
    const left = segments[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
      const right = segments[rightIndex]!;
      if (left.wireId === right.wireId || left.netKey === right.netKey) continue;
      const point = orthogonalSegmentIntersection(left, right);
      if (
        !point
        || samePoint(point, left.start)
        || samePoint(point, left.end)
        || samePoint(point, right.start)
        || samePoint(point, right.end)
      ) {
        continue;
      }
      const nets = [left.net, right.net].sort((a, b) => a.localeCompare(b)) as [string, string];
      crossings.set(`${point.x},${point.y}:${nets.join(':')}`, { point, nets });
    }
  }
  return [...crossings.values()];
}

function visualEndpointKey(endpoint: CircuitWire['from']): string {
  if (!endpoint) return '';
  if (endpoint.component_id && endpoint.pin_id) return `pin:${endpoint.component_id}.${endpoint.pin_id}`;
  if (endpoint.port_id) return `port:${endpoint.port_id}`;
  if (endpoint.junction_id) return `junction:${endpoint.junction_id}`;
  return '';
}

export function danglingWireEnds(document: SchematicDocument): RenderedDanglingWireEnd[] {
  const references = new Map<string, number>();
  for (const wire of document.wires) {
    for (const endpoint of [wire.from, wire.to]) {
      const key = visualEndpointKey(endpoint);
      if (key) references.set(key, (references.get(key) ?? 0) + 1);
    }
  }
  const dangling: RenderedDanglingWireEnd[] = [];
  for (const wire of document.wires) {
    for (const [side, endpoint] of [['from', wire.from], ['to', wire.to]] as const) {
      if (!endpoint || endpoint.component_id || endpoint.port_id) continue;
      const key = visualEndpointKey(endpoint);
      if (!key || (references.get(key) ?? 0) <= 1) {
        dangling.push({ wireId: wire.id, side, point: { x: endpoint.x, y: endpoint.y } });
      }
    }
  }
  return dangling;
}

export function pinConnectionVisuals(
  document: SchematicDocument,
): RenderedPinConnectionState[] {
  const connectedPins = new Set(
    document.wires.flatMap((wire) => [wire.from, wire.to])
      .filter((endpoint) => endpoint?.component_id && endpoint.pin_id)
      .map((endpoint) => `${endpoint!.component_id}.${endpoint!.pin_id}`),
  );
  for (const label of document.netLabels) {
    if (label.endpoint.component_id && label.endpoint.pin_id) {
      connectedPins.add(`${label.endpoint.component_id}.${label.endpoint.pin_id}`);
    }
  }
  return document.module.components.flatMap((component) => (
    component.pins.flatMap((pin, index) => {
      if (isMosBodyPin(component, pin)) return [];
      const state = pin.no_connect
        ? 'no-connect'
        : connectedPins.has(`${component.id}.${pin.id}`)
          ? null
          : 'dangling';
      return state
        ? [{
            componentId: component.id,
            pinId: pin.id,
            point: pinWorld(component, pin, index),
            state,
          }]
        : [];
    })
  ));
}

function addSegmentDirectionsAtPoint(
  junctionMap: Map<string, JunctionAccumulator>,
  segment: JunctionSegment,
  point: CircuitPosition,
) {
  if (!pointOnSegment(point, segment)) return;
  if (!samePoint(point, segment.start)) {
    addJunctionDirection(
      junctionMap,
      segment.netKey,
      segment.net,
      point,
      directionBetween(point, segment.start),
    );
  }
  if (!samePoint(point, segment.end)) {
    addJunctionDirection(
      junctionMap,
      segment.netKey,
      segment.net,
      point,
      directionBetween(point, segment.end),
    );
  }
}

function addJunctionDirection(
  junctionMap: Map<string, JunctionAccumulator>,
  netKey: string,
  net: string,
  point: CircuitPosition,
  direction: WireDirection,
) {
  const roundedPoint = { x: round(point.x), y: round(point.y) };
  const key = `${netKey}:${roundedPoint.x},${roundedPoint.y}`;
  const current = junctionMap.get(key) ?? { point: roundedPoint, net, directions: new Set<WireDirection>() };
  current.directions.add(direction);
  junctionMap.set(key, current);
}

function directionBetween(from: CircuitPosition, to: CircuitPosition): WireDirection {
  const dx = round(to.x) - round(from.x);
  const dy = round(to.y) - round(from.y);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

function orthogonalSegmentIntersection(left: JunctionSegment, right: JunctionSegment): CircuitPosition | null {
  if (left.horizontal && right.vertical) {
    return pointWithinSegments({ x: right.start.x, y: left.start.y }, left, right);
  }
  if (left.vertical && right.horizontal) {
    return pointWithinSegments({ x: left.start.x, y: right.start.y }, left, right);
  }
  return null;
}

function pointWithinSegments(
  point: CircuitPosition,
  left: JunctionSegment,
  right: JunctionSegment,
): CircuitPosition | null {
  return pointOnSegment(point, left) && pointOnSegment(point, right)
    ? { x: round(point.x), y: round(point.y) }
    : null;
}

function pointOnSegment(point: CircuitPosition, segment: JunctionSegment): boolean {
  const px = round(point.x);
  const py = round(point.y);
  const minX = Math.min(round(segment.start.x), round(segment.end.x));
  const maxX = Math.max(round(segment.start.x), round(segment.end.x));
  const minY = Math.min(round(segment.start.y), round(segment.end.y));
  const maxY = Math.max(round(segment.start.y), round(segment.end.y));
  if (segment.horizontal && py !== round(segment.start.y)) return false;
  if (segment.vertical && px !== round(segment.start.x)) return false;
  return px >= minX && px <= maxX && py >= minY && py <= maxY;
}

function samePoint(left: CircuitPosition, right: CircuitPosition): boolean {
  return round(left.x) === round(right.x) && round(left.y) === round(right.y);
}
