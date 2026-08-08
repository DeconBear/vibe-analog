import assert from 'node:assert/strict';
import type { CircuitComponent, CircuitModule, CircuitPort } from '../renderer/src/types';
import {
  addWire,
  blockBodySize,
  collectSchematicTextItems,
  componentBounds,
  createSchematicDocument,
  endpointWorldPosition,
  hitEndpoint,
  isGroundPort,
  isPmosComponent,
  makePlacedComponent,
  normalizeConnectivity,
  normalizeSchematicPorts,
  pinWorld,
  pointEndpoint,
  portRenderSide,
  removeWireAndUpdateConnectivity,
  schematicTextBounds,
  SCHEMATIC_GRID,
  serializeSchematicDocument,
  validateWireTopology,
} from '../renderer/src/schematic/schematicDocument';
import type { SchematicTextItem } from '../renderer/src/schematic/schematicDocumentImpl';
import { junctions } from '../renderer/src/schematic/SchematicDocumentSvg';
import { fixtures, moduleFixture, component, ldoPorts } from './lib/schematic-fixtures';


assertJunctionNetIsolation();
assertBlockEdgePortFanout();
assertManualWireTopology();
assertGroundPseudoComponent();
assertPlacedComponentDefaults();
assertRouteEgressAvoidsOwnerBody();
assertLegacyPortNormalization();
assertWiredInferredPortPreserved();
assertLabelPlacementAvoidsCollisions();

function assertLabelPlacementAvoidsCollisions() {
  // Mirrors the STM32 mcu_core overlap report: a row of same-rail power labels
  // on adjacent block pins, two signal labels facing each other across the
  // short gap between adjacent passives, and a component Reference text that
  // lands on a signal label. Default anchors must collide here (otherwise the
  // fixture stops guarding anything); the resolved placement must not.
  const module = moduleFixture('label_collision_avoidance', [
    {
      id: 'u1',
      type: 'BLOCK',
      name: 'U1',
      value: 'MCU',
      position: { x: 240, y: 200 },
      rotation: 0,
      pins: [
        { id: 'v1', name: 'VDD1', net: 'vdd_3v3', side: 'top', order: 0 },
        { id: 'v2', name: 'VDD2', net: 'vdd_3v3', side: 'top', order: 1 },
        { id: 'v3', name: 'VDD3', net: 'vdd_3v3', side: 'top', order: 2 },
        { id: 'v4', name: 'VDDA', net: 'vdda', side: 'top', order: 3 },
      ],
      block: { width: 160, height: 120 },
    } as CircuitComponent,
    component('r1', 'R', '10k', 560, 300, [['a', '1', 'out'], ['b', '2', 'vdda']]),
    component('c6', 'C', '100n', 776, 300, [['a', '1', 'vdda'], ['b', '2', '0']]),
    {
      ...component('r4', 'R', '10k', 900, 420, [['a', '1', 'out'], ['b', '2', 'vdda']]),
      rotation: 90,
    },
    component('c9', 'C', '10n', 900, 554, [['a', '1', 'out'], ['b', '2', '0']]),
  ], [
    { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
    { id: 'vdd', name: 'VDD_3V3', direction: 'input', signal_type: 'power', net: 'vdd_3v3' },
    { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
    { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
  ]);
  const document = createSchematicDocument(module, { autoLayout: false });

  const collidingPairs = (usePlacements: boolean) => {
    const items = collectSchematicTextItems(document).map((item) => {
      const anchor = usePlacements ? item.placement : item.defaultPlacement;
      return { item, box: schematicTextBounds(item.text, item.fontSize, anchor.x, anchor.y, anchor.anchor) };
    });
    const pairs: Array<[SchematicTextItem, SchematicTextItem]> = [];
    for (let left = 0; left < items.length; left += 1) {
      for (let right = left + 1; right < items.length; right += 1) {
        const a = items[left]!;
        const b = items[right]!;
        const overlaps = a.box.minX < b.box.maxX && a.box.maxX > b.box.minX
          && a.box.minY < b.box.maxY && a.box.maxY > b.box.minY;
        if (overlaps) pairs.push([a.item, b.item]);
      }
    }
    return pairs;
  };

  const defaults = collidingPairs(false);
  assert.ok(
    defaults.some(([a, b]) => a.kind === 'netlabel' && b.kind === 'netlabel'),
    'fixture must keep a default netlabel-netlabel collision (e.g. the VDDA pair on adjacent passives)',
  );
  assert.ok(
    defaults.some(([a, b]) => (a.kind === 'netlabel' && b.kind.startsWith('component'))
      || (b.kind === 'netlabel' && a.kind.startsWith('component'))),
    'fixture must keep a default netlabel-component-text collision (Reference text over a net label)',
  );

  const resolved = collidingPairs(true);
  assert.deepEqual(
    resolved.map(([a, b]) => `${a.key} <-> ${b.key}`),
    [],
    'resolved label placement must be free of text-text collisions',
  );

  // Avoidance never teleports a label: overrides keep their text-anchor and
  // stay within a few grids of the default anchor, so wire/stub attachment
  // remains visually obvious.
  const itemsByKey = new Map(collectSchematicTextItems(document).map((item) => [item.key, item]));
  assert.ok(document.labelPlacements.size > 0, 'fixture must exercise non-trivial placement overrides');
  for (const [key, placement] of document.labelPlacements) {
    const item = itemsByKey.get(key);
    assert.ok(item, `placement override ${key} must correspond to a rendered text item`);
    const base = item.defaultPlacement;
    assert.equal(placement.anchor, base.anchor, `${key} override must keep its text-anchor`);
    assert.ok(
      Math.abs(placement.x - base.x) <= 3 * SCHEMATIC_GRID && Math.abs(placement.y - base.y) <= 3 * SCHEMATIC_GRID,
      `${key} override must stay within 3 grids of its default anchor (got ${JSON.stringify(placement)} vs ${JSON.stringify(base)})`,
    );
  }

  // Deterministic: the same module projects to byte-identical placements.
  const again = createSchematicDocument(module, { autoLayout: false });
  assert.deepEqual(
    serializeSchematicDocument(again).labelPlacements,
    serializeSchematicDocument(document).labelPlacements,
    'label placement must be deterministic for the same module input',
  );
}


function assertWiredInferredPortPreserved() {
  const port: CircuitPort = {
    id: 'input',
    name: 'IN',
    direction: 'input',
    signal_type: 'analog',
    net: 'detached_input',
    inferred: true,
  };
  assert.deepEqual(
    normalizeSchematicPorts([port], [], [{
      id: 'input_stub',
      points: [{ x: 0, y: 0 }, { x: 40, y: 0 }],
      from: { x: 0, y: 0, port_id: 'input' },
      to: { x: 40, y: 0, junction_id: 'j_input' },
      net: 'detached_input',
      net_id: 'net_detached_input',
      source: 'stored',
    }]),
    [port],
    'an inferred port referenced by a stored wire must remain part of the module interface',
  );
}

function assertLegacyPortNormalization() {
  const module = moduleFixture('legacy_duplicate_ports', [
    component('r1', 'R', '1k', 300, 200, [['a', '1', 'vin'], ['b', '2', 'vout']]),
  ], [
    { id: 'vin', name: 'VIN', direction: 'input', signal_type: 'power', net: 'VIN', inferred: true },
    { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'VOUT', inferred: true },
    { id: 'VIN', name: 'VIN', direction: 'input', signal_type: 'analog', net: 'vin' },
    { id: 'VOUT', name: 'VOUT', direction: 'output', signal_type: 'analog', net: 'vout' },
    { id: 'old_out', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'removed_net' },
    { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
  ]);
  const document = createSchematicDocument(module, { autoLayout: false });
  const vinPorts = document.module.ports.filter((port) => port.net.toLowerCase() === 'vin');
  const voutPorts = document.module.ports.filter((port) => port.net.toLowerCase() === 'vout');
  assert.deepEqual(
    vinPorts.map((port) => [port.id, port.signal_type]),
    [['VIN', 'analog']],
    'explicit analog VIN replaces the inferred top-facing power alias',
  );
  assert.deepEqual(
    voutPorts.map((port) => [port.id, port.name]),
    [['VOUT', 'VOUT']],
    'explicit VOUT replaces the inferred OUT alias',
  );
  assert.equal(document.module.ports.some((port) => port.id === 'old_out'), false, 'stale generic OUT is removed');
  assert.equal(document.module.ports.some((port) => port.id === 'vdd'), true, 'named explicit interfaces remain stable');

  const vin = vinPorts[0]!;
  const vout = voutPorts[0]!;
  assert.equal(portRenderSide(document, vin, document.portPositions.get(vin.id)!), 'left');
  assert.equal(portRenderSide(document, vout, document.portPositions.get(vout.id)!), 'right');

  const genericFirst = moduleFixture('legacy_generic_first', [
    component('r1', 'R', '1k', 300, 200, [['a', '1', 'vin'], ['b', '2', 'vout']]),
  ], [
    { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'vout' },
    { id: 'VOUT', name: 'VOUT', direction: 'output', signal_type: 'analog', net: 'vout' },
    { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'vin' },
    { id: 'VIN', name: 'VIN', direction: 'input', signal_type: 'analog', net: 'vin' },
  ]);
  const genericFirstDocument = createSchematicDocument(genericFirst, { autoLayout: false });
  assert.deepEqual(
    genericFirstDocument.module.ports
      .filter((port) => port.net.toLowerCase() === 'vin' || port.net.toLowerCase() === 'vout')
      .map((port) => port.id),
    ['VOUT', 'VIN'],
    'named explicit interfaces beat generic IN/OUT even when generic ports are listed first',
  );
}

function assertPlacedComponentDefaults() {
  const module = moduleFixture('placed_defaults', [], [
    { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
  ]);
  const resistor = makePlacedComponent(module, 'R', { x: 100, y: 100 });
  assert.equal(resistor.value, '1k');
  assert.equal(resistor.parameters?.magnitude, '1k');
  const mos = makePlacedComponent(module, 'M', { x: 160, y: 100 }, { projectKind: 'analog_ic' });
  assert.equal(mos.parameters?.device_id, 'nmos');
  assert.match(mos.value, /NMOS.*W=1u.*L=180n/);
  const pcbR = makePlacedComponent(module, 'R', { x: 220, y: 100 }, { projectKind: 'pcb_schematic' });
  assert.equal(pcbR.eda?.footprint_hint, 'R_0603');
}

function assertRouteEgressAvoidsOwnerBody() {
  // Vertical two-pin part with a ground below: a naive start→end Manhattan route
  // would thread the body. Egress-first routing (qucs-like) must keep the path outside.
  const module = moduleFixture('route_egress_body', [
    component('c1', 'C', '100n', 300, 200, [['a', '1', 'mid'], ['b', '2', '0']]),
  ], [
    { id: 'mid', name: 'MID', direction: 'input', signal_type: 'analog', net: 'mid' },
    { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
  ]);
  const cap = module.components[0]!;
  cap.rotation = 90;
  const gnd = makePlacedComponent(module, 'GND', { x: 300, y: 360 });
  module.components.push(gnd);
  const top = pinWorld(cap, cap.pins[0]!, 0);
  const bottom = pinWorld(cap, cap.pins[1]!, 1);
  const gndPin = pinWorld(gnd, gnd.pins[0]!, 0);
  addWire(
    module,
    { kind: 'pin', ...top, component_id: 'c1', pin_id: 'a', label: 'C1.1', net: 'mid' },
    { kind: 'point', ...{ x: top.x, y: top.y - 80 }, label: 'stub' },
  );
  addWire(
    module,
    { kind: 'pin', ...bottom, component_id: 'c1', pin_id: 'b', label: 'C1.2', net: '0' },
    { kind: 'pin', ...gndPin, component_id: gnd.id, pin_id: 'gnd', label: 'GND.GND', net: '0' },
  );
  // Simulate a drag preview: move the capacitor down over the previous ground route.
  cap.position = { x: 300, y: 280 };
  const movedBottom = pinWorld(cap, cap.pins[1]!, 1);
  const movedTop = pinWorld(cap, cap.pins[0]!, 0);
  const document = createSchematicDocument(module, { autoLayout: false });
  const grounded = document.wires.filter((wire) => (
    wire.from?.component_id === 'c1' && wire.from?.pin_id === 'b' ||
    wire.to?.component_id === 'c1' && wire.to?.pin_id === 'b'
  ));
  assert.ok(grounded.length > 0, 'vertical capacitor should keep a ground-side wire after the move');
  const body = componentBounds(cap);
  const inset = 8;
  const interior = {
    minX: body.minX + inset,
    minY: body.minY + inset,
    maxX: body.maxX - inset,
    maxY: body.maxY - inset,
  };
  for (const wire of grounded) {
    const points = wire.points ?? [];
    assert.ok(points.length >= 2, 'ground-side wire should have a route');
    const start = points[0]!;
    const end = points[points.length - 1]!;
    const touchesMovedPin = (
      Math.hypot(start.x - movedBottom.x, start.y - movedBottom.y) < 1 ||
      Math.hypot(end.x - movedBottom.x, end.y - movedBottom.y) < 1
    );
    assert.ok(touchesMovedPin, 'drag-style reroute must keep the wire endpoint on the moving pin');
    for (let index = 1; index < points.length; index += 1) {
      const left = points[index - 1]!;
      const right = points[index]!;
      const crossesInterior = left.x === right.x
        ? left.x > interior.minX && left.x < interior.maxX &&
          Math.min(left.y, right.y) < interior.maxY && Math.max(left.y, right.y) > interior.minY
        : left.y === right.y
          ? left.y > interior.minY && left.y < interior.maxY &&
            Math.min(left.x, right.x) < interior.maxX && Math.max(left.x, right.x) > interior.minX
          : false;
      assert.equal(
        crossesInterior,
        false,
        `ground-side wire must not thread the capacitor body (segment ${index}); top=${JSON.stringify(movedTop)} route=${JSON.stringify(points)}`,
      );
    }
  }
}

function assertGroundPseudoComponent() {
  const module = moduleFixture('ground_pseudo', [
    component('r1', 'R', '1k', 300, 200, [['a', '1', 'out'], ['b', '2', 'n_r1_2']]),
  ], []);
  const gnd = makePlacedComponent(module, 'GND', { x: 200, y: 320 });
  module.components.push(gnd);
  assert.equal(gnd.pins.length, 1, 'GND pseudo-component has exactly one pin');
  assert.equal(gnd.pins[0]?.net, '0', 'placed GND pin ties to net 0');

  // The ground symbol renders through its own art, not a duplicated rail label.
  const document = createSchematicDocument(module);
  assert.equal(
    document.netLabels.filter((label) => label.endpoint.component_id === gnd.id).length,
    0,
    'GND pseudo-component must not get a per-pin rail label',
  );

  // Wiring a net to the GND pin grounds the whole net.
  const r1Pin = pinWorld(module.components[0]!, module.components[0]!.pins[1]!, 1);
  const gndPin = pinWorld(gnd, gnd.pins[0]!, 0);
  const continued = addWire(
    module,
    { kind: 'pin', ...r1Pin, component_id: 'r1', pin_id: 'b', label: 'R1.2', net: 'n_r1_2' },
    { kind: 'pin', ...gndPin, component_id: gnd.id, pin_id: 'gnd', label: 'GND1.GND', net: '0' },
  );
  assert.ok(continued, 'wiring to a GND pin should be accepted');
  const normalized = normalizeConnectivity(module);
  const r1PinAfter = normalized.components.find((entry) => entry.id === 'r1')?.pins[1];
  assert.equal(r1PinAfter?.net, '0', 'wiring a net to GND grounds the whole net');
}

for (const fixture of fixtures) {
  const document = createSchematicDocument(fixture);
  assert.equal(document.schema, 'actoviq.schematic-document.v1');
  assert.equal(document.module.components.length, fixture.components.length);
  assert.ok(document.wires.length > 0, `${fixture.module_id} has no materialized wires`);

  for (const component of document.module.components) {
    for (let index = 0; index < component.pins.length; index += 1) {
      const pin = component.pins[index];
      assert.ok(pin);
      const point = pinWorld(component, pin, index);
      assert.equal(Number.isFinite(point.x), true, `${fixture.module_id}.${component.id}.${pin.id} x`);
      assert.equal(Number.isFinite(point.y), true, `${fixture.module_id}.${component.id}.${pin.id} y`);
    }
  }

  for (const wire of document.wires) {
    assert.ok((wire.points ?? []).length >= 2, `${fixture.module_id}.${wire.id} has too few points`);
    for (const point of wire.points) {
      assert.equal(Number.isFinite(point.x), true, `${fixture.module_id}.${wire.id} x`);
      assert.equal(Number.isFinite(point.y), true, `${fixture.module_id}.${wire.id} y`);
    }
    for (const endpoint of [wire.from, wire.to]) {
      const resolved = endpointWorldPosition(document.module, endpoint, document.portPositions);
      if (!resolved) continue;
      assert.equal(resolved.x, endpoint?.x, `${fixture.module_id}.${wire.id} endpoint x`);
      assert.equal(resolved.y, endpoint?.y, `${fixture.module_id}.${wire.id} endpoint y`);
    }
  }

  assertReadableLayout(document.module);
  assertReadablePortPlacement(document);
  assertRailLabels(document.module, document.netLabels, document.wires);
  assertNoMosBodyRailLabels(document.module, document.netLabels);
  assertLdoInternalLabels(document);
  assertPmosLdoBenchWiring(document);
  assertCustomBlock(document);
  assertCmosRingConnections(document);
  assertCurrentMirrorDiodeConnection(document);
  assertCascodePhysicalOutputNode(document);
  assertMultiEndpointSpine(document);
  assertGeneratedWireClearance(document);
  assertGeneratedWireSimplicity(document);
  assertGeneratedWireCrossings(document);
}

const positionedPortModule = moduleFixture('positioned_port', [
  component('r1', 'R', '1k', 260, 220, [['a', '1', 'in'], ['b', '2', 'out']]),
]);
positionedPortModule.ports.find((port) => port.id === 'input')!.position = { x: 80, y: 360 };
const positionedPortDocument = createSchematicDocument(positionedPortModule);
assert.deepEqual(positionedPortDocument.portPositions.get('input'), { x: 80, y: 360 }, 'stored port position should override auto placement');
assert.ok(
  positionedPortDocument.wires.some((wire) => (
    [wire.from, wire.to].some((endpoint) => endpoint?.port_id === 'input' && endpoint.x === 80 && endpoint.y === 360)
  )),
  'stored port position should be used by generated wiring',
);

const wiredPortModule = createSchematicDocument(moduleFixture('wired_port_position', [
  component('r1', 'R', '1k', 260, 220, [['a', '1', 'in'], ['b', '2', 'out']]),
])).module;
const wiredInput = wiredPortModule.ports.find((port) => port.id === 'input')!;
delete wiredInput.position;
wiredPortModule.wires = [{
  id: 'input_stub',
  points: [{ x: 100, y: 340 }, { x: 160, y: 340 }],
  from: { x: 100, y: 340, port_id: wiredInput.id },
  to: { x: 160, y: 340, junction_id: 'j_input_stub' },
  net: wiredInput.net,
  net_id: wiredInput.net_id,
  source: 'stored',
}];
assert.deepEqual(
  createSchematicDocument(wiredPortModule, { autoLayout: false }).portPositions.get(wiredInput.id),
  { x: 100, y: 340 },
  'a stored wire endpoint should keep its port position stable after a topology edit',
);

const mosWireModule = moduleFixture('mos_wire_merge', [
  component('m3', 'M', 'PMOS1 W=40u L=1u', 220, 220, [
    ['d', 'D', 'd3'], ['g', 'G', 'gate_left'], ['s', 'S', 'vin'], ['b', 'B', 'vin'],
  ]),
  component('m4', 'M', 'PMOS1 W=40u L=1u', 480, 220, [
    ['d', 'D', 'd4'], ['g', 'G', 'gate_right'], ['s', 'S', 'vin'], ['b', 'B', 'vin'],
  ]),
], ldoPorts);
const leftGate = mosWireModule.components[0]!.pins.find((pin) => pin.id === 'g')!;
const rightGate = mosWireModule.components[1]!.pins.find((pin) => pin.id === 'g')!;
const leftGatePoint = pinWorld(mosWireModule.components[0]!, leftGate, 1);
const rightGatePoint = pinWorld(mosWireModule.components[1]!, rightGate, 1);
addWire(
  mosWireModule,
  { kind: 'pin', ...leftGatePoint, component_id: 'm3', pin_id: 'g', label: 'M3.G', net: leftGate.net },
  { kind: 'pin', ...rightGatePoint, component_id: 'm4', pin_id: 'g', label: 'M4.G', net: rightGate.net },
);
const mergedLeftGate = mosWireModule.components[0]!.pins.find((pin) => pin.id === 'g')!;
const mergedRightGate = mosWireModule.components[1]!.pins.find((pin) => pin.id === 'g')!;
assert.equal(mergedLeftGate.net_id, mergedRightGate.net_id, 'connected MOS gates should share a stable net id');
assert.notEqual(mergedLeftGate.net, 'vin', 'connecting MOS gates must not inherit VIN from source/body pins');
assert.equal(
  mosWireModule.nets?.find((net) => net.id === mergedLeftGate.net_id)?.aliases?.includes('gate_right'),
  true,
  'merged named nets should retain aliases for ERC and history',
);
const mosWireDocument = createSchematicDocument(mosWireModule, { autoLayout: false });
assert.equal(
  mosWireDocument.netLabels.some((label) => label.net === 'vin' && label.endpoint.pin_id === 'g'),
  false,
  'VIN power labels must not materialize on MOS gate pins',
);

// Moving a component while leaving stale stored midpoints must rematerialize Manhattan
// routes (not rubber-band diagonals through other symbols).
{
  const dragModule = JSON.parse(JSON.stringify(mosWireModule)) as typeof mosWireModule;
  const moved = dragModule.components.find((entry) => entry.id === 'm3');
  assert.ok(moved, 'm3 should exist for stale-endpoint rematerialize coverage');
  moved.position = { x: moved.position.x - 120, y: moved.position.y + 160 };
  // Keep the original bent path coordinates so endpoints no longer match pins.
  const staleDoc = createSchematicDocument(dragModule, { autoLayout: false });
  for (const wire of staleDoc.wires) {
    const points = wire.points ?? [];
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      assert.ok(start && end, `${wire.id} segment ${index} missing endpoints after component move`);
      assert.ok(
        start.x === end.x || start.y === end.y,
        `${wire.id} segment ${index} stayed non-orthogonal after component move (${JSON.stringify(start)} -> ${JSON.stringify(end)})`,
      );
    }
  }
  const gateWire = staleDoc.wires.find((wire) => (
    (wire.from?.component_id === 'm3' && wire.to?.component_id === 'm4')
    || (wire.from?.component_id === 'm4' && wire.to?.component_id === 'm3')
  ));
  assert.ok(gateWire, 'gate interconnect should remain after moving m3');
  const m3 = mustComponent(staleDoc.module, 'm3');
  const m3GatePin = m3.pins.find((pin) => pin.id === 'g');
  assert.ok(m3GatePin, 'moved m3 should still expose a gate pin');
  const m3Gate = pinWorld(m3, m3GatePin, m3.pins.findIndex((pin) => pin.id === 'g'));
  const first = gateWire.points?.[0];
  const last = gateWire.points?.at(-1);
  assert.ok(
    (first && Math.abs(first.x - m3Gate.x) < 0.5 && Math.abs(first.y - m3Gate.y) < 0.5)
    || (last && Math.abs(last.x - m3Gate.x) < 0.5 && Math.abs(last.y - m3Gate.y) < 0.5),
    'rerouted gate wire must terminate on the moved m3 gate pin',
  );
}

// Spreading a compact named switch net (≤4 endpoints) must keep physical wires — not
// replace them with floating local signal labels after a single-device drag.
{
  const switchModule = moduleFixture('switch_spread', [
    component('m1', 'M', 'PMOS W=100u L=1u', 200, 200, [
      ['d', 'D', 'sw'], ['g', 'G', 'vg1'], ['s', 'S', 'vin'], ['b', 'B', 'vin'],
    ]),
    component('m2', 'M', 'NMOS W=100u L=1u', 320, 280, [
      ['d', 'D', 'sw'], ['g', 'G', 'vg2'], ['s', 'S', '0'], ['b', 'B', '0'],
    ]),
    component('l1', 'L', '10u', 420, 200, [['p', '1', 'sw'], ['n', '2', 'out']]),
  ], [
    { id: 'vin', name: 'VIN', direction: 'input', signal_type: 'power', net: 'vin' },
    { id: 'out', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
    { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
  ]);
  const before = createSchematicDocument(switchModule, { autoLayout: false });
  assert.ok(before.wires.some((wire) => wire.net === 'sw'), 'compact SW net should start as physical wires');
  assert.equal(
    before.netLabels.some((label) => label.kind === 'signal' && label.net === 'sw'),
    false,
    'compact SW net should not use local signal labels before drag',
  );
  const moved = switchModule.components.find((entry) => entry.id === 'm2');
  assert.ok(moved, 'm2 should exist for switch-spread coverage');
  moved.position = { x: moved.position.x + 280, y: moved.position.y + 220 };
  const after = createSchematicDocument(switchModule, { autoLayout: false });
  assert.ok(
    after.wires.some((wire) => wire.net === 'sw'),
    'dragging one MOSFET must keep SW as physical wires (not orphan label stubs)',
  );
  assert.equal(
    after.netLabels.some((label) => label.kind === 'signal' && label.net === 'sw'),
    false,
    'dragging one MOSFET must not replace SW with floating local signal labels',
  );
  const m2 = mustComponent(after.module, 'm2');
  const m2Drain = m2.pins.find((pin) => pin.id === 'd');
  assert.ok(m2Drain, 'm2 drain pin missing');
  const drainPoint = pinWorld(m2, m2Drain, m2.pins.findIndex((pin) => pin.id === 'd'));
  const touchesMovedDrain = after.wires.some((wire) => {
    const points = wire.points ?? [];
    if (wire.net !== 'sw' || points.length < 2) return false;
    const first = points[0];
    const last = points.at(-1);
    return Boolean(
      (first && Math.abs(first.x - drainPoint.x) < 0.5 && Math.abs(first.y - drainPoint.y) < 0.5)
      || (last && Math.abs(last.x - drainPoint.x) < 0.5 && Math.abs(last.y - drainPoint.y) < 0.5),
    );
  });
  assert.ok(touchesMovedDrain, 'SW wires must still terminate on the moved m2 drain');
  assert.equal(
    after.wires.some((wire) => wire.from?.pin_id === 'b' || wire.to?.pin_id === 'b'),
    false,
    'MOS body pins must not participate in generated net wires',
  );
}

console.log(JSON.stringify({
  ok: true,
  fixtureCount: fixtures.length,
  fixtures: fixtures.map((fixture) => fixture.module_id),
}, null, 2));

function assertCustomBlock(document: ReturnType<typeof createSchematicDocument>) {
  if (document.module.module_id !== 'custom_block') return;
  const block = document.module.components.find((component) => component.id === 'adc_block');
  assert.ok(block && block.type === 'BLOCK', 'custom block component is missing');
  assert.deepEqual(blockBodySize(block), { width: 180, height: 140 });
  const bounds = componentBounds(block);
  assert.ok(bounds.maxX - bounds.minX >= 180, 'custom block bounds should include its body width');
  assert.ok(bounds.maxY - bounds.minY >= 140, 'custom block bounds should include its body height');
  const pinPoints = Object.fromEntries(block.pins.map((pin, index) => [pin.id, pinWorld(block, pin, index)]));
  assert.ok(pinPoints.ain && pinPoints.ain.x < block.position.x, 'left block pin should stay left of the body');
  assert.ok(pinPoints.data && pinPoints.data.x > block.position.x, 'right block pin should stay right of the body');
  assert.ok(pinPoints.vdd && pinPoints.vdd.y < block.position.y, 'top block pin should stay above the body');
  assert.ok(pinPoints.gnd && pinPoints.gnd.y > block.position.y, 'bottom block pin should stay below the body');
  assert.equal(document.wires.some((wire) => wire.from?.component_id === block.id || wire.to?.component_id === block.id), true);
}

function assertJunctionNetIsolation() {
  const crossNetOnly = {
    wires: [
      { id: 'a1', net: 'a', source: 'net', points: [{ x: 0, y: 40 }, { x: 40, y: 40 }] },
      { id: 'a2', net: 'a', source: 'net', points: [{ x: 40, y: 40 }, { x: 80, y: 40 }] },
      { id: 'b1', net: 'b', source: 'net', points: [{ x: 40, y: 0 }, { x: 40, y: 40 }] },
    ],
  } as unknown as ReturnType<typeof createSchematicDocument>;
  assert.deepEqual(junctions(crossNetOnly), [], 'cross-net wire endpoints should not create a junction dot');

  const sameNetBranch = {
    wires: [
      { id: 'a1', net: 'a', source: 'net', points: [{ x: 0, y: 40 }, { x: 40, y: 40 }] },
      { id: 'a2', net: 'a', source: 'net', points: [{ x: 40, y: 40 }, { x: 80, y: 40 }] },
      { id: 'a3', net: 'a', source: 'net', points: [{ x: 40, y: 0 }, { x: 40, y: 40 }] },
    ],
  } as unknown as ReturnType<typeof createSchematicDocument>;
  assert.deepEqual(
    junctions(sameNetBranch).map((junction) => ({ net: junction.net, x: junction.point.x, y: junction.point.y })),
    [{ net: 'a', x: 40, y: 40 }],
    'same-net three-way branch should create one junction dot',
  );

  const aliasedSameNetBranch = {
    wires: [
      { id: 'a1', net: 'a_alias', net_id: 'net_a', source: 'net', points: [{ x: 0, y: 40 }, { x: 40, y: 40 }] },
      { id: 'a2', net: 'a', net_id: 'net_a', source: 'net', points: [{ x: 40, y: 40 }, { x: 80, y: 40 }] },
      { id: 'a3', net: 'a', net_id: 'net_a', source: 'net', points: [{ x: 40, y: 0 }, { x: 40, y: 40 }] },
    ],
  } as unknown as ReturnType<typeof createSchematicDocument>;
  assert.deepEqual(
    junctions(aliasedSameNetBranch).map((junction) => ({ net: junction.net, x: junction.point.x, y: junction.point.y })),
    [{ net: 'a_alias', x: 40, y: 40 }],
    'wire aliases with one stable net_id should still create a junction dot',
  );

  const collidingNamesDifferentNets = {
    wires: [
      { id: 'a1', net: 'shared', net_id: 'net_a', source: 'net', points: [{ x: 0, y: 40 }, { x: 40, y: 40 }] },
      { id: 'a2', net: 'shared', net_id: 'net_a', source: 'net', points: [{ x: 40, y: 40 }, { x: 80, y: 40 }] },
      { id: 'b1', net: 'shared', net_id: 'net_b', source: 'net', points: [{ x: 40, y: 0 }, { x: 40, y: 40 }] },
    ],
  } as unknown as ReturnType<typeof createSchematicDocument>;
  assert.deepEqual(
    junctions(collidingNamesDifferentNets),
    [],
    'identical display names with different stable net_ids must remain electrically isolated',
  );

  const simpleBend = {
    wires: [
      { id: 'a1', net: 'a', source: 'net', points: [{ x: 0, y: 40 }, { x: 40, y: 40 }, { x: 40, y: 80 }] },
    ],
  } as unknown as ReturnType<typeof createSchematicDocument>;
  assert.deepEqual(junctions(simpleBend), [], 'same-net wire bends should not create junction dots');

  const sameNetInteriorCrossing = {
    wires: [
      { id: 'a1', net: 'a', source: 'net', points: [{ x: 0, y: 40 }, { x: 80, y: 40 }] },
      { id: 'a2', net: 'a', source: 'net', points: [{ x: 40, y: 0 }, { x: 40, y: 80 }] },
    ],
  } as unknown as ReturnType<typeof createSchematicDocument>;
  assert.deepEqual(
    junctions(sameNetInteriorCrossing).map((junction) => ({ net: junction.net, x: junction.point.x, y: junction.point.y })),
    [{ net: 'a', x: 40, y: 40 }],
    'same-net interior crossings are one electrical node and must create a junction dot',
  );

  const crossNetInteriorCrossing = {
    wires: [
      { id: 'a1', net: 'a', source: 'net', points: [{ x: 0, y: 40 }, { x: 80, y: 40 }] },
      { id: 'b1', net: 'b', source: 'net', points: [{ x: 40, y: 0 }, { x: 40, y: 80 }] },
    ],
  } as unknown as ReturnType<typeof createSchematicDocument>;
  assert.deepEqual(
    junctions(crossNetInteriorCrossing),
    [],
    'different-net interior crossings render as plain crossings without a junction dot',
  );

  const passThroughBranch = {
    wires: [
      { id: 'a1', net: 'a', source: 'net', points: [{ x: 0, y: 40 }, { x: 40, y: 40 }, { x: 80, y: 40 }] },
      { id: 'a2', net: 'a', source: 'net', points: [{ x: 40, y: 40 }, { x: 40, y: 80 }] },
    ],
  } as unknown as ReturnType<typeof createSchematicDocument>;
  assert.deepEqual(
    junctions(passThroughBranch).map((junction) => ({ net: junction.net, x: junction.point.x, y: junction.point.y })),
    [{ net: 'a', x: 40, y: 40 }],
    'same-net pass-through plus branch should create one junction dot',
  );

  const singleWireToPin = {
    module: {
      components: [
        { id: 'r1', type: 'R', name: 'R1', value: '1k', position: { x: 92, y: 40 }, pins: [{ id: 'a', name: '1', net: 'a' }] },
      ],
    },
    wires: [
      { id: 'a1', net: 'a', source: 'net', points: [{ x: 0, y: 40 }, { x: 40, y: 40 }] },
    ],
  } as unknown as ReturnType<typeof createSchematicDocument>;
  assert.deepEqual(junctions(singleWireToPin), [], 'single wire into a component pin should not create a junction dot');

  const branchedComponentPin = {
    module: {
      components: [
        { id: 'r1', type: 'R', name: 'R1', value: '1k', position: { x: 92, y: 40 }, pins: [{ id: 'a', name: '1', net: 'a' }] },
      ],
    },
    wires: [
      { id: 'a1', net: 'a', source: 'net', points: [{ x: 0, y: 40 }, { x: 40, y: 40 }] },
      { id: 'a2', net: 'a', source: 'net', points: [{ x: 40, y: 0 }, { x: 40, y: 40 }] },
    ],
  } as unknown as ReturnType<typeof createSchematicDocument>;
  assert.deepEqual(
    junctions(branchedComponentPin).map((junction) => ({ net: junction.net, x: junction.point.x, y: junction.point.y })),
    [{ net: 'a', x: 40, y: 40 }],
    'branched same-net wires into a component pin should create one junction dot',
  );
}

function assertBlockEdgePortFanout() {
  const module = moduleFixture('block_edge_fanout', [{
    id: 'u1',
    type: 'BLOCK',
    name: 'U1',
    value: 'MCU',
    position: { x: 300, y: 300 },
    rotation: 0,
    pins: [
      { id: 'pa0', name: 'PA0', net: 'pa0', side: 'right', order: 0 },
      { id: 'pa1', name: 'PA1', net: 'pa1', side: 'right', order: 1 },
      { id: 'pa2', name: 'PA2', net: 'pa2', side: 'right', order: 2 },
      { id: 'pb0', name: 'PB0', net: 'pb0', side: 'left', order: 0 },
    ],
    block: { width: 200, height: 200 },
  }], [
    { id: 'pa0', name: 'PA0', direction: 'bidirectional', signal_type: 'digital', net: 'pa0' },
    { id: 'pa1', name: 'PA1', direction: 'bidirectional', signal_type: 'digital', net: 'pa1' },
    { id: 'pa2', name: 'PA2', direction: 'bidirectional', signal_type: 'digital', net: 'pa2' },
    { id: 'pb0', name: 'PB0', direction: 'bidirectional', signal_type: 'digital', net: 'pb0' },
  ]);
  const document = createSchematicDocument(module, { autoLayout: false });
  const block = document.module.components.find((entry) => entry.id === 'u1')!;
  const body = componentBounds(block);
  for (const portId of ['pa0', 'pa1', 'pa2']) {
    const position = document.portPositions.get(portId);
    assert.ok(position, `port ${portId} should be placed`);
    assert.ok(
      position!.x > body.maxX,
      `port ${portId} should sit beside the block's right edge that carries its pin, not behind the body`,
    );
  }
  const pb0 = document.portPositions.get('pb0');
  assert.ok(pb0 && pb0.x < body.minX, 'left-edge pin ports stay on the left of the block body');

  // The fan-out collapses to short stubs beside the body edge: no wire may
  // dive back across the block body, and different nets may not share a
  // coincident vertical track (deterministic channel spreading).
  const fanout = document.wires.filter((wire) => ['pa0', 'pa1', 'pa2'].includes(wire.net ?? ''));
  assert.equal(fanout.length, 3, 'each single-pin port net should materialize exactly one wire');
  for (const wire of fanout) {
    const points = wire.points ?? [];
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1]!;
      const end = points[index]!;
      const minX = Math.min(start.x, end.x);
      const maxX = Math.max(start.x, end.x);
      const minY = Math.min(start.y, end.y);
      const maxY = Math.max(start.y, end.y);
      const entersBody = maxX > body.minX && minX < body.maxX && maxY > body.minY && minY < body.maxY;
      assert.ok(!entersBody, `wire ${wire.id} (${wire.net}) must not cross the block body`);
    }
  }
  const verticals = fanout.flatMap((wire) => {
    const points = wire.points ?? [];
    const segments: Array<{ net: string; x: number; minY: number; maxY: number }> = [];
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1]!;
      const end = points[index]!;
      if (start.x === end.x && start.y !== end.y) {
        segments.push({ net: wire.net ?? '', x: start.x, minY: Math.min(start.y, end.y), maxY: Math.max(start.y, end.y) });
      }
    }
    return segments;
  });
  for (let left = 0; left < verticals.length; left += 1) {
    for (let right = left + 1; right < verticals.length; right += 1) {
      const a = verticals[left]!;
      const b = verticals[right]!;
      if (a.net === b.net || a.x !== b.x) continue;
      const overlap = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      assert.ok(overlap <= 0, `nets ${a.net} and ${b.net} must not overlap on vertical track x=${a.x}`);
    }
  }
}

function assertReadableLayout(module: CircuitModule) {
  if (module.module_id === 'rc_low_pass') {
    const resistor = mustComponent(module, 'r1');
    const capacitor = mustComponent(module, 'c1');
    assertPinLeftOf(resistor, 'in', 'out', module.module_id);
    assertPinAbove(capacitor, 'out', '0', module.module_id);
    assert.ok(resistor.position.y < capacitor.position.y, 'RC shunt capacitor should sit below the series resistor');
  }
  if (module.module_id === 'rlc_band_pass') {
    const resistor = mustComponent(module, 'r1');
    const inductor = mustComponent(module, 'l1');
    const capacitor = mustComponent(module, 'c1');
    assert.ok(resistor.position.x < inductor.position.x, 'RLC series resistor should precede inductor');
    assertPinLeftOf(resistor, 'in', 'n1', module.module_id);
    assertPinLeftOf(inductor, 'n1', 'out', module.module_id);
    assertPinAbove(capacitor, 'out', '0', module.module_id);
  }
  if (module.module_id === 'voltage_divider') {
    const top = mustComponent(module, 'rtop');
    const bottom = mustComponent(module, 'rbot');
    const filter = mustComponent(module, 'cflt');
    assertPinAbove(top, 'vdd', 'vout', module.module_id);
    assertPinAbove(bottom, 'vout', '0', module.module_id);
    assertPinAbove(filter, 'vout', '0', module.module_id);
    assert.ok(Math.abs(top.position.x - bottom.position.x) <= 1, 'voltage divider resistors should align vertically');
    assert.ok(top.position.y < bottom.position.y, 'voltage divider top resistor should sit above bottom resistor');
    assert.ok(filter.position.x > bottom.position.x, 'voltage divider shunt capacitor should sit beside the divider');
  }
  if (module.module_id === 'diode_rectifier') {
    const diode = mustComponent(module, 'd1');
    const capacitor = mustComponent(module, 'c1');
    assertPinLeftOf(diode, 'in', 'out', module.module_id);
    assertPinAbove(capacitor, 'out', '0', module.module_id);
  }
  if (module.module_id === 'bjt_common_emitter') {
    const transistor = mustComponent(module, 'q1');
    const inputCoupling = mustComponent(module, 'cin');
    const collectorLoad = mustComponent(module, 'rc');
    const emitterLoad = mustComponent(module, 're');
    const outputCoupling = mustComponent(module, 'cout');
    const outputLoad = mustComponent(module, 'rload');
    assertActivePins(transistor, module.module_id);
    assert.ok(inputCoupling.position.x < transistor.position.x, 'BJT input coupling should sit before the transistor base');
    assert.ok(outputCoupling.position.x > transistor.position.x, 'BJT output coupling should sit after the collector');
    assert.ok(outputLoad.position.x >= outputCoupling.position.x, 'BJT output load should sit on the output side');
    assert.ok(collectorLoad.position.y < transistor.position.y, 'BJT collector load should sit above the transistor');
    assert.ok(emitterLoad.position.y > transistor.position.y, 'BJT emitter load should sit below the transistor');
    assert.ok(outputLoad.position.y > outputCoupling.position.y, 'BJT output load should drop toward ground');
    assertPinLeftOf(inputCoupling, 'in', 'b', module.module_id);
    assertPinLeftOf(outputCoupling, 'out', 'load', module.module_id);
    assertPinAbove(collectorLoad, 'vdd', 'out', module.module_id);
    assertPinAbove(emitterLoad, 'e', '0', module.module_id);
    assertPinAbove(outputLoad, 'load', '0', module.module_id);
  }
  if (module.module_id === 'bjt_reset_network') {
    const boot = mustComponent(module, 'q_boot');
    const reset = mustComponent(module, 'q_rst');
    const diode = mustComponent(module, 'd_rst');
    const pullup = mustComponent(module, 'r50');
    const dtr = mustComponent(module, 'r51');
    const rts = mustComponent(module, 'r49');
    const boot0 = mustComponent(module, 'r52');
    assertActivePins(boot, module.module_id);
    assertActivePins(reset, module.module_id);
    assert.ok(boot.position.x < reset.position.x, 'BJT reset boot transistor should be left of reset transistor');
    assert.ok(diode.position.x < reset.position.x, 'BJT reset diode should feed the reset transistor from the left');
    assert.ok(pullup.position.y < reset.position.y, 'BJT reset pull-up should sit above reset transistor');
    assert.ok(dtr.position.x > reset.position.x, 'BJT reset DTR resistor should sit on the output side');
    assert.ok(rts.position.x > boot.position.x && rts.position.x < reset.position.x, 'BJT reset RTS resistor should bridge the two transistor stages');
    assert.ok(boot0.position.y > boot.position.y, 'BJT reset BOOT resistor should sit below boot transistor');
    assertPinLeftOf(diode, 'rst', 'rst_pull', module.module_id);
    assertPinAbove(pullup, 'vdd', 'rst_pull', module.module_id);
    assertPinLeftOf(dtr, 'dtr_drive', 'dtr', module.module_id);
    assertPinLeftOf(rts, 'rts_drive', 'rts', module.module_id);
    assertPinAbove(boot0, 'boot_node', 'boot0', module.module_id);
    assertNoComponentOverlap(module, ['q_boot', 'q_rst', 'd_rst', 'r50', 'r51', 'r49', 'r52']);
  }
  if (module.module_id === 'mos_common_source') {
    const transistor = mustComponent(module, 'm1');
    assertActivePins(transistor, module.module_id);
  }
  if (module.module_id === 'mos_common_source_full') {
    const transistor = mustComponent(module, 'm1');
    const inputCoupling = mustComponent(module, 'cin');
    const gatePullup = mustComponent(module, 'rg1');
    const gatePulldown = mustComponent(module, 'rg2');
    const drainLoad = mustComponent(module, 'rd');
    const sourceResistor = mustComponent(module, 'rs');
    const sourceBypass = mustComponent(module, 'cs');
    const outputCoupling = mustComponent(module, 'cout');
    const outputLoad = mustComponent(module, 'rload');
    assertActivePins(transistor, module.module_id);
    assert.ok(inputCoupling.position.x < transistor.position.x, 'MOS input coupling should sit before the gate');
    assert.ok(outputCoupling.position.x > transistor.position.x, 'MOS output coupling should sit after the drain');
    assert.ok(outputLoad.position.x >= outputCoupling.position.x, 'MOS output load should sit on the output side');
    assert.ok(gatePullup.position.y < transistor.position.y, 'MOS gate pull-up should sit above the gate');
    assert.ok(gatePulldown.position.y > transistor.position.y, 'MOS gate pull-down should sit below the gate');
    assert.ok(drainLoad.position.y < transistor.position.y, 'MOS drain load should sit above the transistor');
    assert.ok(sourceResistor.position.y > transistor.position.y, 'MOS source resistor should sit below the transistor');
    assert.ok(sourceBypass.position.y > transistor.position.y, 'MOS source bypass should sit below the transistor');
    assertPinLeftOf(inputCoupling, 'in', 'gate', module.module_id);
    assertPinLeftOf(outputCoupling, 'drain', 'out', module.module_id);
    assertPinAbove(gatePullup, 'vdd', 'gate', module.module_id);
    assertPinAbove(gatePulldown, 'gate', '0', module.module_id);
    assertPinAbove(drainLoad, 'vdd', 'drain', module.module_id);
    assertPinAbove(sourceResistor, 'source', '0', module.module_id);
    assertPinAbove(sourceBypass, 'source', '0', module.module_id);
    assertPinAbove(outputLoad, 'out', '0', module.module_id);
    assertNoComponentOverlap(module, ['cin', 'rg1', 'rg2', 'm1', 'rd', 'rs', 'cs', 'cout', 'rload']);
  }
  if (module.module_id === 'cmos_inverter') {
    const pmos = mustComponent(module, 'mp1');
    const nmos = mustComponent(module, 'mn1');
    const load = mustComponent(module, 'cload');
    assertActivePins(pmos, module.module_id);
    assertActivePins(nmos, module.module_id);
    assert.ok(pmos.position.y < nmos.position.y, 'CMOS inverter PMOS should sit above NMOS');
    assert.ok(Math.abs(pmos.position.x - nmos.position.x) <= 1, 'CMOS inverter devices should share the output column');
    assert.ok(load.position.x > nmos.position.x, 'CMOS inverter output load should sit on the right side');
    assertPinAbove(pmos, 'vdd', 'out', module.module_id);
    assertPinAbove(nmos, 'out', '0', module.module_id);
    assertPinAbove(load, 'out', '0', module.module_id);
    assertNoComponentOverlap(module, ['mp1', 'mn1', 'cload']);
  }
  if (module.module_id === 'cmos_ring_oscillator') {
    const stages = [
      [mustComponent(module, 'm2'), mustComponent(module, 'm1')],
      [mustComponent(module, 'm4'), mustComponent(module, 'm3')],
      [mustComponent(module, 'm6'), mustComponent(module, 'm5')],
    ];
    for (const [pmos, nmos] of stages) {
      assert.ok(pmos.position.y < nmos.position.y, `${pmos.id}/${nmos.id} PMOS should sit above NMOS`);
      assert.ok(Math.abs(pmos.position.x - nmos.position.x) <= 1, `${pmos.id}/${nmos.id} should share a stage column`);
    }
    assert.ok(stages[0]![0]!.position.x < stages[1]![0]!.position.x, 'ring oscillator stage 1 should precede stage 2');
    assert.ok(stages[1]![0]!.position.x < stages[2]![0]!.position.x, 'ring oscillator stage 2 should precede stage 3');
    for (const id of ['c1', 'c2', 'c3', 'rleak1', 'rleak2', 'rleak3']) {
      assert.ok(mustComponent(module, id).position.y > stages[0]![1]!.position.y, `${id} should sit below the CMOS stages`);
    }
    assertNoComponentOverlap(module, module.components.map((component) => component.id));
  }
  if (module.module_id === 'mos_differential_pair') {
    const left = mustComponent(module, 'm_inp');
    const right = mustComponent(module, 'm_inn');
    const leftLoad = mustComponent(module, 'rdp');
    const rightLoad = mustComponent(module, 'rdn');
    const tail = mustComponent(module, 'itail');
    assertActivePins(left, module.module_id);
    assertActivePins(right, module.module_id);
    assert.ok(left.position.x < right.position.x, 'differential pair positive input device should sit left of negative input device');
    assert.ok(Math.abs(left.position.y - right.position.y) <= 1, 'differential pair devices should align horizontally');
    assert.ok(leftLoad.position.y < left.position.y, 'differential pair left drain load should sit above the device');
    assert.ok(rightLoad.position.y < right.position.y, 'differential pair right drain load should sit above the device');
    assert.ok(tail.position.y > left.position.y && tail.position.y > right.position.y, 'differential pair tail source should sit below both devices');
    assertPinAbove(leftLoad, 'vdd', 'outp', module.module_id);
    assertPinAbove(rightLoad, 'vdd', 'outn', module.module_id);
    assertPinAbove(tail, 'tail', '0', module.module_id);
    assertNoComponentOverlap(module, ['m_inp', 'm_inn', 'rdp', 'rdn', 'itail']);
  }
  if (module.module_id === 'mos_ldo') {
    const leftInput = mustComponent(module, 'm1');
    const rightInput = mustComponent(module, 'm2');
    const leftLoad = mustComponent(module, 'm3');
    const rightLoad = mustComponent(module, 'm4');
    const pass = mustComponent(module, 'mp');
    const topDivider = mustComponent(module, 'rtop');
    const bottomDivider = mustComponent(module, 'rbot');
    const outputLoad = mustComponent(module, 'rload');
    const outputCap = mustComponent(module, 'cout');
    assertActivePins(leftInput, module.module_id);
    assertActivePins(rightInput, module.module_id);
    assertActivePins(leftLoad, module.module_id);
    assertActivePins(rightLoad, module.module_id);
    assertActivePins(pass, module.module_id);
    assert.ok(leftLoad.position.y < leftInput.position.y, 'LDO PMOS mirror load should sit above left input device');
    assert.ok(rightLoad.position.y < rightInput.position.y, 'LDO PMOS mirror load should sit above right input device');
    assert.ok(leftInput.position.x < rightInput.position.x, 'LDO error amplifier input devices should be separated left-to-right');
    assert.ok(leftLoad.position.x < rightLoad.position.x, 'LDO PMOS mirror devices should be separated left-to-right');
    assert.ok(pass.position.x > rightLoad.position.x && pass.position.x > rightInput.position.x, 'LDO pass MOSFET should sit to the right of the error amplifier');
    assert.ok(topDivider.position.x > pass.position.x, 'LDO feedback divider should sit on the output side');
    assert.ok(outputLoad.position.x > pass.position.x, 'LDO output load should sit on the output side');
    assert.ok(outputCap.position.x > pass.position.x, 'LDO output capacitor should sit on the output side');
    assert.ok(outputCap.position.x - mustComponent(module, 'vin').position.x <= 1180, 'LDO layout should remain compact enough for fit-view readability');
    assert.ok(pass.position.x - rightInput.position.x <= 280, 'LDO pass MOSFET should stay near the error amplifier output');
    assert.ok(outputCap.position.x - pass.position.x <= 520, 'LDO output network should stay near the pass MOSFET');
    assert.ok(Math.abs(topDivider.position.x - bottomDivider.position.x) <= 1, 'LDO feedback divider resistors should align vertically');
    assert.ok(topDivider.position.y < bottomDivider.position.y, 'LDO top feedback resistor should sit above bottom feedback resistor');
    assertPinAbove(topDivider, 'vout', 'fb', module.module_id);
    assertPinAbove(bottomDivider, 'fb', '0', module.module_id);
    assertPinAbove(outputLoad, 'vout', '0', module.module_id);
    assertPinAbove(outputCap, 'vout', '0', module.module_id);
    assertNoComponentOverlap(module, ['m1', 'm2', 'm3', 'm4', 'mp', 'vin', 'vref', 'itail', 'rtop', 'rbot', 'rload', 'cout']);
  }
  if (module.module_id === 'pmos_ldo_bench') {
    const errorAmplifier = mustComponent(module, 'qerr');
    const pass = mustComponent(module, 'mpass');
    const pullup = mustComponent(module, 'rpu');
    const topDivider = mustComponent(module, 'rfb1');
    const bottomDivider = mustComponent(module, 'rfb2');
    assert.ok(pass.position.x > errorAmplifier.position.x, 'PMOS LDO pass device should sit to the right of the error amplifier');
    assert.ok(pullup.position.y < pass.position.y, 'PMOS LDO gate pull-up should sit above the pass device');
    assert.ok(topDivider.position.x > pass.position.x, 'PMOS LDO feedback divider should sit on the output side');
    assert.ok(Math.abs(topDivider.position.x - bottomDivider.position.x) <= 1, 'PMOS LDO feedback divider should align vertically');
    assert.ok(topDivider.position.y < bottomDivider.position.y, 'PMOS LDO feedback divider should flow from output toward ground');
    assertNoComponentOverlap(module, module.components.map((component) => component.id));
  }
  if (module.module_id === 'current_mirror') {
    const reference = mustComponent(module, 'm_ref');
    const output = mustComponent(module, 'm_out');
    const referenceFeed = mustComponent(module, 'i_ref');
    const outputLoad = mustComponent(module, 'rload');
    assertActivePins(reference, module.module_id);
    assertActivePins(output, module.module_id);
    assert.ok(reference.position.x < output.position.x, 'current mirror reference device should be left of output device');
    assert.ok(referenceFeed.position.y < reference.position.y, 'current mirror reference current source should sit above the diode-connected device');
    assert.ok(outputLoad.position.y < output.position.y, 'current mirror output load should sit above the output device');
    assertPinAbove(referenceFeed, 'vdd', 'bias', module.module_id);
    assertPinAbove(outputLoad, 'vdd', 'out', module.module_id);
    assertNoComponentOverlap(module, ['m_ref', 'm_out', 'i_ref', 'rload']);
  }
  if (module.module_id === 'opamp_feedback') {
    const amplifier = mustComponent(module, 'eopamp');
    const feedback = mustComponent(module, 'r2f');
    const lowerFeedback = mustComponent(module, 'r1f');
    const loadCap = mustComponent(module, 'cload');
    const loadResistor = mustComponent(module, 'rload');
    assert.ok(feedback.position.y < amplifier.position.y, 'opamp feedback resistor should sit above the amplifier');
    assert.ok(lowerFeedback.position.x < amplifier.position.x, 'opamp lower feedback resistor should sit beside the inverting input');
    assert.ok(loadCap.position.x > amplifier.position.x, 'opamp output capacitor should sit on the output side');
    assert.ok(loadResistor.position.x > amplifier.position.x, 'opamp output load should sit on the output side');
    assertPinLeftOf(amplifier, 'fb', 'vout', module.module_id);
    assertPinAbove(lowerFeedback, 'fb', '0', module.module_id);
    assertPinAbove(loadCap, 'vout', '0', module.module_id);
    assertPinAbove(loadResistor, 'vout', '0', module.module_id);
    assertNoComponentOverlap(module, ['eopamp', 'r2f', 'r1f', 'cload', 'rload']);
  }
  if (module.module_id === 'mos_cascode_amplifier') {
    const lower = mustComponent(module, 'm1');
    const upper = mustComponent(module, 'm2');
    const drainLoad = mustComponent(module, 'rl');
    const sourceResistor = mustComponent(module, 'rs');
    const compensation = mustComponent(module, 'ccomp');
    const outputSeries = mustComponent(module, 'rout');
    const outputCap = mustComponent(module, 'cload');
    const outputProbe = mustComponent(module, 'rprobe');
    assertActivePins(lower, module.module_id);
    assertActivePins(upper, module.module_id);
    assert.ok(upper.position.y < lower.position.y, 'cascode upper MOSFET should sit above the input MOSFET');
    assert.ok(Math.abs(upper.position.x - lower.position.x) <= 1, 'cascode MOSFETs should share the stack column');
    assert.ok(drainLoad.position.y < upper.position.y, 'cascode drain load should sit above the upper MOSFET');
    assert.ok(sourceResistor.position.y > lower.position.y, 'cascode source degeneration resistor should sit below the lower MOSFET');
    assert.ok(
      compensation.position.y > upper.position.y && compensation.position.y < lower.position.y,
      'cascode compensation capacitor should sit between the cascode devices near the output node',
    );
    assert.ok(outputSeries.position.x > upper.position.x, 'cascode output resistor should sit to the right of the stack');
    assert.ok(outputCap.position.x > outputSeries.position.x, 'cascode output capacitor should sit beyond output resistor');
    assert.ok(outputProbe.position.x > outputSeries.position.x, 'cascode output probe should sit beyond output resistor');
    assertPinAbove(drainLoad, 'vdd', 'no', module.module_id);
    assertPinAbove(sourceResistor, 'ns', '0', module.module_id);
    assertPinLeftOf(outputSeries, 'no', 'out', module.module_id);
    assertPinAbove(outputCap, 'out', '0', module.module_id);
    assertPinAbove(outputProbe, 'out', '0', module.module_id);
    assertNoComponentOverlap(module, ['m1', 'm2', 'rl', 'rs', 'cint', 'ccomp', 'rout', 'cload', 'rprobe']);
  }
  if (module.module_id === 'baseband_conditioning') {
    assertNoComponentOverlap(module, ['rin', 'rbias1']);
  }
  if (module.module_id === 'buck_boost_power_stage') {
    const m1 = mustComponent(module, 'm1');
    const m2 = mustComponent(module, 'm2');
    const m3 = mustComponent(module, 'm3');
    const m4 = mustComponent(module, 'm4');
    const d1 = mustComponent(module, 'd1');
    const l1 = mustComponent(module, 'l1');
    const cin = mustComponent(module, 'cin');
    const cout = mustComponent(module, 'cout');
    const rload = mustComponent(module, 'rload');
    [m1, m2, m3, m4].forEach((device) => assertActivePins(device, module.module_id));
    // Half-bridge legs: high-side stacked over low-side on one column, buck leg
    // left of boost leg in signal-flow order.
    assert.ok(Math.abs(m1.position.x - m2.position.x) <= 1, 'buck leg devices should share a column');
    assert.ok(m1.position.y < m2.position.y, 'buck leg high-side should sit above low-side');
    assert.ok(Math.abs(m3.position.x - m4.position.x) <= 1, 'boost leg devices should share a column');
    assert.ok(m3.position.y < m4.position.y, 'boost leg high-side should sit above low-side');
    assert.ok(m2.position.x < m4.position.x, 'buck leg should precede the boost leg (signal flow)');
    // The inductor bridges the two switch nodes on the tap row between the legs.
    assert.ok(l1.position.x > m2.position.x && l1.position.x < m4.position.x, 'inductor should sit between the legs');
    assert.ok(l1.position.y > m1.position.y && l1.position.y < m2.position.y, 'inductor should sit on the switch tap row');
    // Freewheeling diodes outside their leg (first leg left, last leg right),
    // input cap between them, output shunts right of everything.
    const d3 = mustComponent(module, 'd3');
    assert.ok(d1.position.x < m1.position.x, 'D1 should sit left of the buck leg, outside the tap corridor');
    assert.ok(d1.position.y <= m1.position.y, 'D1 should sit on or above the high-side row');
    assert.ok(d3.position.x > m3.position.x, 'D3 should sit right of the boost leg, outside the tap corridor');
    assert.ok(d1.position.x < cin.position.x, 'D1/D2 column should sit left of the input capacitor');
    assert.ok(cin.position.x < m1.position.x, 'input capacitor should sit left of the first leg');
    assert.ok(cout.position.x > m3.position.x, 'output capacitor should sit right of the last leg');
    assert.ok(rload.position.x > cout.position.x, 'load should sit outside the output capacitor');
    assertPinAbove(cin, 'vin', '0', module.module_id);
    assertPinAbove(cout, 'vout', '0', module.module_id);
    assertPinAbove(rload, 'vout', '0', module.module_id);
    assertPinLeftOf(l1, 'sw1', 'sw2', module.module_id);
    assertNoComponentOverlap(module, module.components.map((entry) => entry.id));
    assertNoLabelCollisions(module);
  }
}

function assertReadablePortPlacement(document: ReturnType<typeof createSchematicDocument>) {
  const { module, portPositions } = document;
  if (module.module_id === 'mos_ldo') {
    const outputPort = mustPortPosition(portPositions, 'vout');
    assert.ok(document.viewBox.maxX - outputPort.x >= 110, 'LDO VOUT port should leave room for the right-side symbol and label');
  }
  if (module.module_id === 'mos_differential_pair') {
    const leftDevice = mustComponent(module, 'm_inp');
    const rightDevice = mustComponent(module, 'm_inn');
    const inpPort = mustPortPosition(portPositions, 'inp');
    const innPort = mustPortPosition(portPositions, 'inn');
    const outpPort = mustPortPosition(portPositions, 'outp');
    const outnPort = mustPortPosition(portPositions, 'outn');
    const inpGate = pinPointForNet(leftDevice, 'inp');
    const innGate = pinPointForNet(rightDevice, 'inn');
    const leftBounds = boundsForComponent(leftDevice);
    const rightEdge = boundsForComponent(rightDevice).maxX;

    assert.ok(inpPort.x < inpGate.x, 'differential pair IN+ should sit outside the left gate pin');
    assert.ok(innPort.x < innGate.x, 'differential pair IN- should sit outside the right gate pin, not across the MOS body');
    assert.ok(outpPort.x > leftBounds.maxX, 'differential pair OUT+ should sit outside the positive-input device');
    assert.ok(outpPort.x < rightDevice.position.x, 'differential pair OUT+ should stay local to the positive-output branch');
    assert.ok(outnPort.x > rightEdge, 'differential pair OUT- should sit outside the right edge');
    assert.ok(Math.abs(outpPort.y - outnPort.y) >= 60, 'differential pair output ports should be vertically separated');
    assert.ok(outpPort.y < innPort.y && outnPort.y < innPort.y, 'differential pair output ports should stay above the right-side input port');
    return;
  }
  if (module.module_id !== 'bjt_reset_network') return;

  const resetDiode = mustComponent(module, 'd_rst');
  const dtrResistor = mustComponent(module, 'r51');
  const boot0Resistor = mustComponent(module, 'r52');
  const rstPort = mustPortPosition(portPositions, 'rst');
  const dtrPort = mustPortPosition(portPositions, 'dtr');
  const rtsPort = mustPortPosition(portPositions, 'rts');
  const boot0Port = mustPortPosition(portPositions, 'boot0');

  assert.ok(rstPort.x < pinPointForNet(resetDiode, 'rst').x, 'BJT reset RST input should stay outside the left edge');
  assert.ok(dtrPort.x > pinPointForNet(dtrResistor, 'dtr').x, 'BJT reset DTR input should sit outside R51 on the right edge');
  assert.ok(rtsPort.x > pinPointForNet(mustComponent(module, 'q_rst'), 'rts').x, 'BJT reset RTS output should sit on the right edge');
  const boot0Pin = pinPointForNet(boot0Resistor, 'boot0');
  assert.ok(boot0Port.x > boot0Pin.x, 'BJT reset BOOT0 output should sit outside R52');
  assert.ok(boot0Port.x - boot0Pin.x <= 140, 'BJT reset BOOT0 output should stay near the local BOOT0 branch');
}

function assertRailLabels(module: CircuitModule, netLabels: ReturnType<typeof createSchematicDocument>['netLabels'], wires: ReturnType<typeof createSchematicDocument>['wires']) {
  const railNets = new Set(
    module.ports
      .filter((port) => port.signal_type === 'power' || isGroundPort(port))
      .map((port) => port.net),
  );
  const railPins = module.components.flatMap((component) => (
    component.pins
      .filter((pin) => railNets.has(pin.net))
      .map((pin) => ({ component, pin }))
  ));
  if (railPins.length === 0) return;

  assert.ok(netLabels.length > 0, `${module.module_id} should expose local rail labels`);
  for (const label of netLabels) {
    if (label.kind !== 'ground' && label.kind !== 'power') continue;
    const separated = Math.abs(label.position.x - label.endpoint.x) > 0.5
      || Math.abs(label.position.y - label.endpoint.y) > 0.5;
    assert.ok(separated, `${module.module_id}.${label.id} rail label should sit off the pin with a stub`);
    if (label.kind === 'ground') {
      assert.ok(label.position.y > label.endpoint.y, `${module.module_id}.${label.id} GND symbol should sit below its pin`);
    } else {
      assert.ok(label.position.y < label.endpoint.y, `${module.module_id}.${label.id} power symbol should sit above its pin`);
    }
  }
  for (const wire of wires) {
    assert.ok(!railNets.has(wire.net ?? ''), `${module.module_id}.${wire.id} should not render a generated rail bus for ${wire.net}`);
  }
}

function assertNoMosBodyRailLabels(module: CircuitModule, netLabels: ReturnType<typeof createSchematicDocument>['netLabels']) {
  const bodyPinKeys = new Set(
    module.components
      .filter((component) => component.type === 'M')
      .flatMap((component) => component.pins
        .filter((pin) => /body|bulk|\bb\b/i.test(`${pin.id} ${pin.name}`))
        .map((pin) => `${component.id}:${pin.id}`)),
  );
  for (const label of netLabels) {
    const componentId = label.endpoint.component_id;
    const pinId = label.endpoint.pin_id;
    if (!componentId || !pinId) continue;
    assert.equal(
      bodyPinKeys.has(`${componentId}:${pinId}`),
      false,
      `${module.module_id}.${componentId}.${pinId} should not render a MOS body rail label`,
    );
  }
}

function assertLdoInternalLabels(document: ReturnType<typeof createSchematicDocument>) {
  if (document.module.module_id !== 'mos_ldo') return;
  const localNets = new Set(['fb', 'vref']);
  const physicalNets = new Set(['tail', 'eaout']);
  const moduleNets = new Set(document.module.components.flatMap((component) => component.pins.map((pin) => pin.net)));
  const signalLabelNets = new Set(
    document.netLabels
      .filter((label) => label.kind === 'signal')
      .map((label) => label.net),
  );
  for (const net of localNets) {
    if (!moduleNets.has(net)) continue;
    assert.equal(signalLabelNets.has(net), true, `mos_ldo should render ${net} as local labels`);
    assert.equal(
      document.wires.some((wire) => wire.net === net),
      false,
      `mos_ldo should not render ${net} as a generated long wire`,
    );
  }
  for (const net of physicalNets) {
    if (!moduleNets.has(net)) continue;
    assert.equal(signalLabelNets.has(net), false, `mos_ldo should render nearby ${net} endpoints with physical wires`);
    assert.equal(
      document.wires.some((wire) => wire.net === net),
      true,
      `mos_ldo should visibly connect ${net} with generated wires`,
    );
  }
  const passGateWire = document.wires.find((wire) => (
    wire.net === 'eaout' &&
    (wire.from?.component_id === 'mp' || wire.to?.component_id === 'mp') &&
    (wire.from?.pin_id === 'g' || wire.to?.pin_id === 'g')
  ));
  assert.ok(passGateWire, 'mos_ldo pass MOSFET gate should have a visible EAOUT wire');
}

function assertCmosRingConnections(document: ReturnType<typeof createSchematicDocument>) {
  if (document.module.module_id !== 'cmos_ring_oscillator') return;
  const expectedComponents = new Map([
    ['n1', ['m1', 'm2', 'm3', 'm4', 'c1', 'rleak1']],
    ['n2', ['m3', 'm4', 'm5', 'm6', 'c2', 'rleak2']],
    ['n3', ['m5', 'm6', 'm1', 'm2', 'c3', 'rleak3']],
  ]);
  const signalLabelNets = new Set(
    document.netLabels.filter((label) => label.kind === 'signal').map((label) => label.net),
  );
  for (const [net, componentIds] of expectedComponents) {
    const wires = document.wires.filter((wire) => wire.net === net);
    assert.ok(wires.length >= componentIds.length - 1, `cmos_ring_oscillator.${net} should use physical editable wires`);
    assert.equal(signalLabelNets.has(net), false, `cmos_ring_oscillator.${net} should not be replaced by local labels`);
    for (const componentId of componentIds) {
      assert.ok(
        wires.some((wire) => wire.from?.component_id === componentId || wire.to?.component_id === componentId),
        `cmos_ring_oscillator.${net} should visibly reach ${componentId}`,
      );
    }
  }
}

function assertCurrentMirrorDiodeConnection(document: ReturnType<typeof createSchematicDocument>) {
  if (document.module.module_id !== 'current_mirror') return;
  const biasWires = document.wires.filter((wire) => wire.net === 'bias');
  assert.ok(biasWires.length >= 3, 'current mirror bias net should render physical gate/drain wires');
  assert.ok(
    biasWires.every((wire) => wire.from?.component_id === 'm_ref' && wire.from?.pin_id === 'd'),
    'current mirror bias net should use the diode-connected drain as its route anchor',
  );
  const reference = mustComponent(document.module, 'm_ref');
  const drain = pinPointByName(reference, /drain|\bd\b/);
  const gate = pinPointByName(reference, /gate|\bg\b/);
  const gateShort = biasWires.find((wire) => wire.to?.component_id === 'm_ref' && wire.to?.pin_id === 'g');
  assert.ok(gateShort, 'current mirror diode-connected device should visibly short drain to gate');
  assert.deepEqual(gateShort.points[0], drain, 'current mirror gate short should start at the reference drain');
  assert.deepEqual(gateShort.points.at(-1), gate, 'current mirror gate short should end at the reference gate');
}

function assertCascodePhysicalOutputNode(document: ReturnType<typeof createSchematicDocument>) {
  if (document.module.module_id !== 'mos_cascode_amplifier') return;
  const outputDrainWires = document.wires.filter((wire) => wire.net === 'no');
  assert.ok(outputDrainWires.length >= 3, 'cascode output drain net should render as physical wires, not only labels');
  assert.equal(
    document.netLabels.some((label) => label.net === 'no'),
    false,
    'cascode output drain net should stay compact enough to avoid local labels',
  );
  const upper = mustComponent(document.module, 'm2');
  const compensationWire = document.wires.find((wire) => (
    wire.net === 'in' &&
    [wire.from, wire.to].some((endpoint) => endpoint?.component_id === 'ccomp')
  ));
  assert.ok(compensationWire, 'cascode compensation input should be physically wired to the input net');
  assert.ok(
    Math.min(...compensationWire.points.map((point) => point.y)) >= upper.position.y,
    'cascode compensation input wire should not route through the top VDD/load region',
  );
}

function assertMultiEndpointSpine(document: ReturnType<typeof createSchematicDocument>) {
  if (document.module.module_id !== 'voltage_divider') return;
  const voutWires = document.wires.filter((wire) => wire.net === 'vout');
  const segmentCounts = new Map<string, number>();
  for (const wire of voutWires) {
    const points = wire.points ?? [];
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      if (!start || !end) continue;
      if (start.x !== end.x && start.y !== end.y) continue;
      const left = `${start.x},${start.y}`;
      const right = `${end.x},${end.y}`;
      const key = [left, right].sort().join('<->');
      segmentCounts.set(key, (segmentCounts.get(key) ?? 0) + 1);
    }
  }
  assert.ok(
    [...segmentCounts.values()].some((count) => count >= 2),
    'voltage_divider.vout should use a shared spine segment for the multi-endpoint node',
  );
}

function assertGeneratedWireClearance(document: ReturnType<typeof createSchematicDocument>) {
  const clearance = 20;
  for (const wire of document.wires) {
    if (wire.source === 'stored') continue;
    const endpointComponents = new Set([wire.from?.component_id, wire.to?.component_id].filter(Boolean));
    for (const component of document.module.components) {
      if (endpointComponents.has(component.id)) continue;
      const padding = component.pins.some((pin) => pin.net === wire.net) ? 0 : clearance;
      const bounds = padLocalBounds(boundsForComponent(component), padding);
      for (let index = 1; index < wire.points.length; index += 1) {
        const start = wire.points[index - 1];
        const end = wire.points[index];
        assert.ok(start && end, `${document.module.module_id}.${wire.id} segment ${index} missing endpoints`);
        assert.equal(
          segmentIntersectsLocalBounds(start, end, bounds),
          false,
          `${document.module.module_id}.${wire.id} routes too close to ${component.id}`,
        );
      }
    }
  }
}

function assertGeneratedWireSimplicity(document: ReturnType<typeof createSchematicDocument>) {
  for (const wire of document.wires) {
    if (wire.source === 'stored') continue;
    const points = wire.points ?? [];
    assert.ok(
      points.length <= 5,
      `${document.module.module_id}.${wire.id} should be routed as a direct, one-bend, single-detour, or compact double-detour path`,
    );
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      assert.ok(start && end, `${document.module.module_id}.${wire.id} segment ${index} missing endpoints`);
      assert.ok(
        start.x === end.x || start.y === end.y,
        `${document.module.module_id}.${wire.id} segment ${index} is not orthogonal`,
      );
    }
    for (let index = 1; index < points.length - 1; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const next = points[index + 1];
      assert.ok(previous && current && next, `${document.module.module_id}.${wire.id} point ${index} missing`);
      assert.equal(
        previous.x === current.x && current.x === next.x ||
          previous.y === current.y && current.y === next.y,
        false,
        `${document.module.module_id}.${wire.id} keeps a redundant collinear bend`,
      );
    }
  }
}

function assertGeneratedWireCrossings(document: ReturnType<typeof createSchematicDocument>) {
  const wires = document.wires.filter((wire) => wire.source !== 'stored');
  for (let leftIndex = 0; leftIndex < wires.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < wires.length; rightIndex += 1) {
      const left = wires[leftIndex];
      const right = wires[rightIndex];
      assert.ok(left && right);
      if (left.net && left.net === right.net) continue;
      for (let leftPointIndex = 1; leftPointIndex < left.points.length; leftPointIndex += 1) {
        const leftStart = left.points[leftPointIndex - 1];
        const leftEnd = left.points[leftPointIndex];
        assert.ok(leftStart && leftEnd);
        for (let rightPointIndex = 1; rightPointIndex < right.points.length; rightPointIndex += 1) {
          const rightStart = right.points[rightPointIndex - 1];
          const rightEnd = right.points[rightPointIndex];
          assert.ok(rightStart && rightEnd);
          const crossing = segmentConflictPoint(leftStart, leftEnd, rightStart, rightEnd);
          assert.equal(
            crossing,
            null,
            `${document.module.module_id}.${left.id} (${left.net ?? '-'}) crosses ${right.id} (${right.net ?? '-'}) at ${crossing?.x},${crossing?.y}`,
          );
        }
      }
    }
  }
}

function assertManualWireTopology() {
  const chain = moduleFixture('manual_chain', [
    component('rleft', 'R', '1k', 100, 200, [['a', '1', 'left_open'], ['b', '2', 'left']]),
    component('rright', 'R', '1k', 500, 200, [['a', '1', 'right'], ['b', '2', 'right_open']]),
  ], []);
  const leftPin = chain.components[0]!.pins[1]!;
  const rightPin = chain.components[1]!.pins[0]!;
  const leftPoint = pinWorld(chain.components[0]!, leftPin, 1);
  const rightPoint = pinWorld(chain.components[1]!, rightPin, 0);
  const bend = pointEndpoint({ x: 300, y: 300 });
  const continued = addWire(
    chain,
    { kind: 'pin', ...leftPoint, component_id: 'rleft', pin_id: 'b', label: 'RLEFT.2', net: leftPin.net },
    bend,
  );
  assert.ok(continued?.junction_id, 'a free wire endpoint should receive a stable junction id');
  addWire(
    chain,
    continued!,
    { kind: 'pin', ...rightPoint, component_id: 'rright', pin_id: 'a', label: 'RRIGHT.1', net: rightPin.net },
  );
  const normalizedChain = normalizeConnectivity(chain);
  const normalizedLeft = normalizedChain.components[0]!.pins[1]!;
  const normalizedRight = normalizedChain.components[1]!.pins[0]!;
  assert.equal(normalizedLeft.net_id, normalizedRight.net_id, 'pin -> free point -> pin must form one electrical net');
  assert.equal(new Set(normalizedChain.wires.map((wire) => wire.net_id)).size, 1, 'continuous wire segments must share one net id');
  assert.equal(
    normalizedChain.wires.filter((wire) => (
      wire.from?.junction_id === continued!.junction_id || wire.to?.junction_id === continued!.junction_id
    )).length,
    2,
    'the continued free point must be a shared semantic node',
  );

  // Two fresh free endpoints in one commit are distinct graph nodes: junction
  // ids must not collide (previously both ends of a free-to-free wire received
  // the same id and topology validation rejected the module on save/delete).
  const freePair = moduleFixture('manual_free_pair', [], []);
  const freeStart = pointEndpoint({ x: 100, y: 100 });
  const freeEnd = pointEndpoint({ x: 200, y: 100 });
  const freeChainEnd = addWire(freePair, freeStart, freeEnd);
  assert.ok(freeChainEnd?.junction_id, 'a free-to-free wire end should receive a junction id');
  const freeWire = freePair.wires.at(-1)!;
  assert.ok(freeWire.from?.junction_id, 'free-to-free wire start should receive a junction id');
  assert.notEqual(
    freeWire.from?.junction_id,
    freeWire.to?.junction_id,
    'the two endpoints of a free-to-free wire must not share a junction id',
  );
  const afterFreeWireRemoval = removeWireAndUpdateConnectivity(freePair, freeWire);
  assert.equal(afterFreeWireRemoval.wires.length, 0, 'removing a free-to-free wire should leave no wires');

  const branch = moduleFixture('manual_branch', [
    component('rleft', 'R', '1k', 100, 200, [['a', '1', 'left_open'], ['b', '2', 'trunk_left']]),
    component('rright', 'R', '1k', 500, 200, [['a', '1', 'trunk_right'], ['b', '2', 'right_open']]),
    component('rbranch', 'R', '1k', 300, 400, [['a', '1', 'branch'], ['b', '2', 'branch_open']]),
  ], []);
  branch.components[2]!.rotation = 90;
  const trunkLeftPin = branch.components[0]!.pins[1]!;
  const trunkRightPin = branch.components[1]!.pins[0]!;
  addWire(
    branch,
    { kind: 'pin', ...pinWorld(branch.components[0]!, trunkLeftPin, 1), component_id: 'rleft', pin_id: 'b', label: 'left', net: trunkLeftPin.net },
    { kind: 'pin', ...pinWorld(branch.components[1]!, trunkRightPin, 0), component_id: 'rright', pin_id: 'a', label: 'right', net: trunkRightPin.net },
  );
  const beforeBranch = createSchematicDocument(branch, { autoLayout: false });
  const trunkHit = hitEndpoint(beforeBranch, { x: 300, y: 200 });
  assert.equal(trunkHit?.wire_id, branch.wires[0]?.id, 'wire midpoint should be an attachable endpoint target');
  const branchPin = branch.components[2]!.pins[0]!;
  const branchEnd = addWire(
    branch,
    { kind: 'pin', ...pinWorld(branch.components[2]!, branchPin, 0), component_id: 'rbranch', pin_id: 'a', label: 'branch', net: branchPin.net },
    trunkHit!,
    beforeBranch.wires,
  );
  assert.ok(branchEnd?.junction_id, 'T connection should materialize an explicit junction');
  const junctionId = branchEnd!.junction_id;
  assert.equal(
    branch.wires.filter((wire) => wire.from?.junction_id === junctionId || wire.to?.junction_id === junctionId).length,
    3,
    'T connection should split the trunk into two edges and add one branch edge',
  );
  const branchedDocument = createSchematicDocument(branch, { autoLayout: false });
  assert.equal(
    junctions(branchedDocument).some((entry) => entry.point.x === 300 && entry.point.y === 200),
    true,
    'an explicit T connection should render a junction dot',
  );

  const bridge = moduleFixture('manual_bridge_delete', [
    component('rleft', 'R', '1k', 100, 200, [['a', '1', 'left_open'], ['b', '2', 'left']]),
    component('rright', 'R', '1k', 500, 200, [['a', '1', 'right'], ['b', '2', 'right_open']]),
  ], []);
  const bridgeLeft = bridge.components[0]!.pins[1]!;
  const bridgeRight = bridge.components[1]!.pins[0]!;
  addWire(
    bridge,
    { kind: 'pin', ...pinWorld(bridge.components[0]!, bridgeLeft, 1), component_id: 'rleft', pin_id: 'b', label: 'left', net: bridgeLeft.net },
    { kind: 'pin', ...pinWorld(bridge.components[1]!, bridgeRight, 0), component_id: 'rright', pin_id: 'a', label: 'right', net: bridgeRight.net },
  );
  const split = removeWireAndUpdateConnectivity(bridge, bridge.wires[0]!);
  const splitLeft = split.components[0]!.pins[1]!;
  const splitRight = split.components[1]!.pins[0]!;
  assert.notEqual(splitLeft.net_id, splitRight.net_id, 'deleting a bridge must split the stable net id');
  assert.equal(split.nets?.find((net) => net.id === splitLeft.net_id)?.name, splitLeft.net);
  assert.equal(split.nets?.find((net) => net.id === splitRight.net_id)?.name, splitRight.net);

  const crossing: CircuitModule = {
    schema: 'actoviq.module.v2',
    module_id: 'crossing_semantics',
    name: 'crossing_semantics',
    revision: 0,
    nets: [
      { id: 'net_a', name: 'a' },
      { id: 'net_b', name: 'b' },
    ],
    ports: [],
    components: [],
    wires: [
      {
        id: 'wa', net: 'a', net_id: 'net_a', source: 'stored',
        points: [{ x: 0, y: 40 }, { x: 80, y: 40 }],
        from: { x: 0, y: 40, junction_id: 'ja0' },
        to: { x: 80, y: 40, junction_id: 'ja1' },
      },
      {
        id: 'wb', net: 'b', net_id: 'net_b', source: 'stored',
        points: [{ x: 40, y: 0 }, { x: 40, y: 80 }],
        from: { x: 40, y: 0, junction_id: 'jb0' },
        to: { x: 40, y: 80, junction_id: 'jb1' },
      },
    ],
    annotations: [],
  };
  assert.deepEqual(validateWireTopology(crossing), [], 'a pure interior crossing must remain electrically isolated');
  crossing.wires[1]!.points[1] = { x: 40, y: 40 };
  crossing.wires[1]!.to = { x: 40, y: 40, junction_id: 'jb1' };
  assert.equal(
    validateWireTopology(crossing).some((issue) => issue.code === 'unintended_contact'),
    true,
    'a different-net endpoint landing on a segment must be a blocking contact',
  );
}

function assertPmosLdoBenchWiring(document: ReturnType<typeof createSchematicDocument>) {
  if (document.module.module_id !== 'pmos_ldo_bench') return;
  const pullup = mustComponent(document.module, 'rpu');
  const pinIndex = pullup.pins.findIndex((pin) => pin.id === 'a');
  const pin = pullup.pins[pinIndex];
  assert.ok(pin, 'pmos_ldo_bench.rpu.a missing');
  const wire = document.wires.find((entry) => (
    entry.net === 'vin' && [entry.from, entry.to].some((endpoint) => endpoint?.component_id === 'rpu' && endpoint.pin_id === 'a')
  ));
  assert.ok(wire, 'PMOS LDO pull-up VIN pin should have a generated wire');
  const fromPullup = wire.from?.component_id === 'rpu' && wire.from.pin_id === 'a';
  const endpointPoint = fromPullup ? wire.points[0] : wire.points.at(-1);
  const adjacentPoint = fromPullup ? wire.points[1] : wire.points.at(-2);
  assert.ok(endpointPoint && adjacentPoint, 'PMOS LDO pull-up VIN wire should have an endpoint segment');
  const pinPoint = pinWorld(pullup, pin, pinIndex);
  const outward = { x: pinPoint.x - pullup.position.x, y: pinPoint.y - pullup.position.y };
  const route = { x: adjacentPoint.x - endpointPoint.x, y: adjacentPoint.y - endpointPoint.y };
  assert.ok(outward.x * route.x + outward.y * route.y >= 0, 'PMOS LDO pull-up VIN wire must leave the pin away from the resistor body');
}

function mustComponent(module: CircuitModule, id: string): CircuitComponent {
  const component = module.components.find((entry) => entry.id === id);
  assert.ok(component, `${module.module_id}.${id} missing`);
  return component;
}

function mustPortPosition(portPositions: ReturnType<typeof createSchematicDocument>['portPositions'], id: string) {
  const position = portPositions.get(id);
  assert.ok(position, `port ${id} missing`);
  return position;
}

function assertPinLeftOf(component: CircuitComponent, leftNet: string, rightNet: string, label: string) {
  const left = pinPointForNet(component, leftNet);
  const right = pinPointForNet(component, rightNet);
  assert.ok(left.x < right.x, `${label}.${component.id} should route ${leftNet} left of ${rightNet}`);
}

function assertPinAbove(component: CircuitComponent, topNet: string, bottomNet: string, label: string) {
  const top = pinPointForNet(component, topNet);
  const bottom = pinPointForNet(component, bottomNet);
  assert.ok(top.y < bottom.y, `${label}.${component.id} should route ${topNet} above ${bottomNet}`);
}

function assertActivePins(component: CircuitComponent, label: string) {
  const gate = pinPointByName(component, /gate|base|\bg\b|\bb\b/);
  const drain = pinPointByName(component, /drain|collector|\bd\b|\bc\b/);
  const source = pinPointByName(component, /source|emitter|\bs\b|\be\b/);
  assert.ok(gate.x < drain.x, `${label}.${component.id} gate/base should be left of drain/collector`);
  assert.ok(gate.x < source.x, `${label}.${component.id} gate/base should be left of source/emitter`);
  if (component.type === 'M' && isPmosComponent(component)) {
    assert.ok(source.y < drain.y, `${label}.${component.id} PMOS source should be above drain`);
  } else {
    assert.ok(drain.y < source.y, `${label}.${component.id} drain/collector should be above source/emitter`);
  }
}

function assertNoComponentOverlap(module: CircuitModule, componentIds: string[]) {
  const components = componentIds.map((id) => mustComponent(module, id));
  for (let leftIndex = 0; leftIndex < components.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < components.length; rightIndex += 1) {
      const left = components[leftIndex];
      const right = components[rightIndex];
      assert.ok(left && right);
      const leftBounds = boundsForComponent(left);
      const rightBounds = boundsForComponent(right);
      assert.ok(
        leftBounds.maxX < rightBounds.minX ||
          rightBounds.maxX < leftBounds.minX ||
          leftBounds.maxY < rightBounds.minY ||
          rightBounds.maxY < leftBounds.minY,
        `${module.module_id}.${left.id} overlaps ${right.id}`,
      );
    }
  }
}

function boundsForComponent(component: CircuitComponent) {
  const points = component.pins.map((pin, index) => pinWorld(component, pin, index));
  // MOS/BJT art spans ±58 (gate lead + channel); two-pin art is compact — only
  // its pin leads reach the ±52 endpoints, so the art box stays tight.
  const rotation = ((component.rotation ?? 0) % 360 + 360) % 360;
  const twoPin = component.pins.length === 2;
  const verticalTwoPin = twoPin && (rotation === 90 || rotation === 270);
  const bodyX = twoPin ? (verticalTwoPin ? 14 : 30) : 58;
  const bodyY = twoPin ? (verticalTwoPin ? 30 : 14) : 58;
  const xs = [component.position.x - bodyX, component.position.x + bodyX, ...points.map((point) => point.x)];
  const ys = [component.position.y - bodyY, component.position.y + bodyY, ...points.map((point) => point.y)];
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function padLocalBounds(bounds: ReturnType<typeof boundsForComponent>, padding: number) {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  };
}

/**
 * Estimated name/value label boxes vs. symbol art boxes, mirroring
 * componentLabelPositions / displayComponentValue in SchematicDocumentSvg.
 * Guards auto-layout against text-on-text and text-on-body collisions.
 */
function assertNoLabelCollisions(module: CircuitModule) {
  interface Box { left: number; right: number; top: number; bottom: number; tag: string }
  const displayValue = (value: string | undefined): string => {
    const text = (value ?? '').trim();
    if (!text) return '';
    if (text.length <= 22) return text;
    if (/^PULSE\s*\(/i.test(text)) return 'PULSE(...)';
    if (/^PWL\s*\(/i.test(text)) return 'PWL(...)';
    if (/^SIN\s*\(/i.test(text)) return 'SIN(...)';
    if (/^EXP\s*\(/i.test(text)) return 'EXP(...)';
    return `${text.slice(0, 20)}…`;
  };
  const boxes: Box[] = [];
  const pushText = (component: CircuitComponent, px: number, py: number, anchor: string, text: string, charWidth: number, tag: string) => {
    if (!text) return;
    const width = text.length * charWidth;
    const left = anchor === 'end' ? px - width : anchor === 'middle' ? px - width / 2 : px;
    // SVG text y is the baseline; glyph ink spans roughly -12..+2 around it.
    boxes.push({ left, right: left + width, top: py - 12, bottom: py + 2, tag: `${component.name}.${tag}="${text}"` });
  };
  for (const component of module.components) {
    const { x, y } = component.position;
    const rotation = ((component.rotation ?? 0) % 360 + 360) % 360;
    const verticalTwoPin = component.pins.length === 2 && (rotation === 90 || rotation === 270);
    const value = displayValue(component.value);
    if (verticalTwoPin) {
      pushText(component, x - 46, y - 28, 'end', component.name, 9, 'name');
      pushText(component, x - 46, y - 6, 'end', value, 7.5, 'value');
      boxes.push({ left: x - 12, right: x + 12, top: y - 26, bottom: y + 26, tag: `${component.name}.body` });
      continue;
    }
    if (component.type === 'M' || component.type === 'Q') {
      if (component.type === 'M') {
        pushText(component, x, y - 66, 'middle', component.name, 9, 'name');
        pushText(component, x + 52, y + 8, 'start', value, 7.5, 'value');
      } else {
        pushText(component, x + 52, y - 52, 'start', component.name, 9, 'name');
        pushText(component, x + 52, y + 58, 'start', value, 7.5, 'value');
      }
      boxes.push({ left: x - 58, right: x + 58, top: y - 52, bottom: y + 52, tag: `${component.name}.body` });
      continue;
    }
    if (component.pins.length === 2) {
      pushText(component, x, y - 42, 'middle', component.name, 9, 'name');
      pushText(component, x, y + 44, 'middle', value, 7.5, 'value');
      boxes.push({ left: x - 26, right: x + 26, top: y - 12, bottom: y + 12, tag: `${component.name}.body` });
      continue;
    }
    boxes.push({ left: x - 30, right: x + 30, top: y - 30, bottom: y + 30, tag: `${component.name}.body` });
  }
  const intersects = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
      const left = boxes[leftIndex];
      const right = boxes[rightIndex];
      const leftOwner = left.tag.split('.')[0];
      const rightOwner = right.tag.split('.')[0];
      if (leftOwner === rightOwner) continue;
      if (left.tag.endsWith('.body') && right.tag.endsWith('.body')) continue;
      assert.ok(!intersects(left, right), `${module.module_id}: ${left.tag} collides with ${right.tag}`);
    }
  }
}

function segmentIntersectsLocalBounds(
  start: { x: number; y: number },
  end: { x: number; y: number },
  bounds: ReturnType<typeof boundsForComponent>,
): boolean {
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
  return segmentIntersectsLocalBounds(start, { x: end.x, y: start.y }, bounds) ||
    segmentIntersectsLocalBounds({ x: end.x, y: start.y }, end, bounds);
}

function segmentConflictPoint(
  leftStart: { x: number; y: number },
  leftEnd: { x: number; y: number },
  rightStart: { x: number; y: number },
  rightEnd: { x: number; y: number },
): { x: number; y: number } | null {
  const leftVertical = leftStart.x === leftEnd.x;
  const rightVertical = rightStart.x === rightEnd.x;
  const leftHorizontal = leftStart.y === leftEnd.y;
  const rightHorizontal = rightStart.y === rightEnd.y;

  if (leftVertical && rightVertical) {
    if (leftStart.x !== rightStart.x) return null;
    const minY = Math.max(Math.min(leftStart.y, leftEnd.y), Math.min(rightStart.y, rightEnd.y));
    const maxY = Math.min(Math.max(leftStart.y, leftEnd.y), Math.max(rightStart.y, rightEnd.y));
    return maxY > minY ? { x: leftStart.x, y: (minY + maxY) / 2 } : null;
  }
  if (leftHorizontal && rightHorizontal) {
    if (leftStart.y !== rightStart.y) return null;
    const minX = Math.max(Math.min(leftStart.x, leftEnd.x), Math.min(rightStart.x, rightEnd.x));
    const maxX = Math.min(Math.max(leftStart.x, leftEnd.x), Math.max(rightStart.x, rightEnd.x));
    return maxX > minX ? { x: (minX + maxX) / 2, y: leftStart.y } : null;
  }

  const verticalStart = leftVertical ? leftStart : rightStart;
  const verticalEnd = leftVertical ? leftEnd : rightEnd;
  const horizontalStart = leftHorizontal ? leftStart : rightStart;
  const horizontalEnd = leftHorizontal ? leftEnd : rightEnd;
  if (!verticalStart || !verticalEnd || !horizontalStart || !horizontalEnd) return null;
  const x = verticalStart.x;
  const y = horizontalStart.y;
  const withinVertical = betweenInclusive(y, verticalStart.y, verticalEnd.y);
  const withinHorizontal = betweenInclusive(x, horizontalStart.x, horizontalEnd.x);
  return withinVertical && withinHorizontal ? { x, y } : null;
}

function betweenInclusive(value: number, start: number, end: number): boolean {
  return value >= Math.min(start, end) && value <= Math.max(start, end);
}

function pinPointForNet(component: CircuitComponent, net: string) {
  const index = component.pins.findIndex((pin) => pin.net === net);
  assert.notEqual(index, -1, `${component.id}.${net} pin missing`);
  const pin = component.pins[index];
  assert.ok(pin);
  return pinWorld(component, pin, index);
}

function pinPointByName(component: CircuitComponent, pattern: RegExp) {
  const index = component.pins.findIndex((pin) => pattern.test(`${pin.id} ${pin.name}`.toLowerCase()));
  assert.notEqual(index, -1, `${component.id}.${pattern.source} pin missing`);
  const pin = component.pins[index];
  assert.ok(pin);
  return pinWorld(component, pin, index);
}
