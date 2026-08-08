/**
 * Projection facade for the schematic core.
 *
 * This is the single entry point for turning an `actoviq.module.v2` into a
 * `SchematicDocument` (the `actoviq.schematic-document.v1` projection). The
 * facade delegates to the pure schematic-document implementation
 * in `renderer/src/schematic/schematicDocumentImpl.ts` so the observable output
 * for the 20 fixtures does not change (M1-04 requirement).
 *
 * Why a facade: ADR-0002 makes the projection a versioned public surface.
 * New code should depend on `projectSchematicDocument` from this module, not
 * on the implementation module directly. Interactive and netlistsvg adapters
 * consume this facade and therefore share one projection implementation.
 *
 * The historical `schematicDocument.ts` entry point delegates back to this
 * facade, so legacy imports and new core consumers share this boundary.
 */

import type { CircuitModule } from '../../types';
import {
  AUTO_LAYOUT_COMPONENT_LIMIT,
  createSchematicDocumentImplementation,
  deserializeSchematicDocument,
  resolveSchematicLabelPlacements,
  serializeSchematicDocument,
  type SchematicDocument,
  type SchematicDocumentOptions,
  type SerializableSchematicDocument,
} from '../../schematic/schematicDocumentImpl';

export {
  serializeSchematicDocument,
  type SchematicDocument,
  type SchematicDocumentOptions,
  type SerializableSchematicDocument,
};

export interface SchematicEntityMap {
  schema: 'actoviq.schematic-entity-map.v1';
  module_id: string;
  module_revision: number;
  components: Array<{ entity_id: string; type: string }>;
  pins: Array<{
    entity_id: string;
    component_id: string;
    pin_id: string;
    net: string;
    net_id?: string;
  }>;
  ports: Array<{ entity_id: string; net: string; net_id?: string }>;
  nets: Array<{ entity_id: string; name: string }>;
  wires: Array<{ entity_id: string; net: string; net_id?: string }>;
  junctions: Array<{ entity_id: string }>;
}

export type SchematicProjectionMode = 'full' | 'incremental';

export interface SchematicProjectionSnapshot {
  sourceModule: CircuitModule;
  document: SchematicDocument;
}

export interface SchematicProjectionComputation {
  document: SchematicDocument;
  mode: SchematicProjectionMode;
  affectedEntities: string[];
  reused: {
    geometry: boolean;
    routing: boolean;
    bounds: boolean;
  };
  snapshot: SchematicProjectionSnapshot;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function componentGeometryIdentity(component: CircuitModule['components'][number]) {
  // Pin world geometry for MOS depends on polarity parsed from name/value.
  if (component.type === 'M') {
    return {
      name: component.name,
      value: component.value,
    };
  }
  return null;
}

function componentProjectionShape(component: CircuitModule['components'][number]) {
  return {
    id: component.id,
    type: component.type,
    geometryIdentity: componentGeometryIdentity(component),
    position: component.position,
    rotation: component.rotation,
    pins: component.pins,
    block: component.block,
    module_ref: component.module_ref,
  };
}

function moduleProjectionShape(module: CircuitModule) {
  return {
    schema: module.schema,
    module_id: module.module_id,
    // Name feeds net-label heuristics (e.g. LDO internal nets).
    name: module.name,
    ports: module.ports,
    nets: module.nets ?? [],
    wires: module.wires ?? [],
    annotations: module.annotations ?? [],
    components: module.components.map(componentProjectionShape),
  };
}

function autoLayoutWouldRun(module: CircuitModule, options: SchematicDocumentOptions): boolean {
  return (
    options.autoLayout !== false
    && (module.wires ?? []).length === 0
    && module.components.length <= AUTO_LAYOUT_COMPONENT_LIMIT
  );
}

function changedEntityIds(previous: CircuitModule, next: CircuitModule): string[] {
  const previousById = new Map(previous.components.map((component) => [component.id, component]));
  const affected = next.components
    .filter((component) => !sameValue(previousById.get(component.id), component))
    .map((component) => component.id);
  const previousTopLevel = {
    ...previous,
    components: undefined,
  };
  const nextTopLevel = {
    ...next,
    components: undefined,
  };
  if (!sameValue(previousTopLevel, nextTopLevel)) affected.push(`module:${next.module_id}`);
  return [...new Set(affected)].sort();
}

function reuseProjectedDocument(
  previous: SchematicDocument,
  nextSource: CircuitModule,
): SchematicDocument {
  const projectedById = new Map(previous.module.components.map((component) => [component.id, component]));
  const module = {
    ...clone(nextSource),
    // These collections may have canonical net ids, normalized ports, snapped
    // geometry, and auto-generated routing in the prior projection.
    ports: clone(previous.module.ports),
    nets: previous.module.nets ? clone(previous.module.nets) : undefined,
    wires: clone(previous.module.wires),
    components: nextSource.components.map((component) => {
      const projected = projectedById.get(component.id)!;
      return {
        ...clone(component),
        position: clone(projected.position),
        rotation: projected.rotation,
        pins: clone(projected.pins),
      };
    }),
  };
  const document: SchematicDocument = {
    schema: 'actoviq.schematic-document.v1',
    moduleId: nextSource.module_id,
    moduleName: nextSource.name,
    module,
    portPositions: new Map(
      [...previous.portPositions].map(([id, position]) => [id, clone(position)]),
    ),
    connectedPortIds: new Set(previous.connectedPortIds),
    netLabels: clone(previous.netLabels),
    wires: clone(previous.wires),
    bounds: clone(previous.bounds),
    viewBox: clone(previous.viewBox),
    labelPlacements: new Map(),
  };
  // Recompute rather than reuse: placements depend on label/port text, which is
  // not part of the geometry identity that allowed this reuse path.
  document.labelPlacements = resolveSchematicLabelPlacements(document);
  return document;
}

/**
 * Project a module into a SchematicDocument (interactive projection).
 * Pure: does not mutate the input module. See ADR-0002.
 */
export function projectSchematicDocument(
  module: CircuitModule,
  options: SchematicDocumentOptions = {},
): SchematicDocument {
  return createSchematicDocumentImplementation(module, options);
}

/**
 * Reuse derived geometry when a transaction only changes non-geometric entity
 * properties. Connectivity, routing, positions, ports, and annotations are
 * compared structurally; any uncertainty falls back to the canonical full
 * projector. Auto-layout inputs also use the full path because names/values
 * may influence a layout profile.
 */
export function projectSchematicDocumentIncremental(
  module: CircuitModule,
  options: SchematicDocumentOptions = {},
  previous?: SchematicProjectionSnapshot | null,
): SchematicProjectionComputation {
  const canReuse = Boolean(
    previous
    && previous.sourceModule.module_id === module.module_id
    && previous.document.moduleId === module.module_id
    && !autoLayoutWouldRun(module, options)
    && sameValue(moduleProjectionShape(previous.sourceModule), moduleProjectionShape(module)),
  );
  if (!canReuse || !previous) {
    const document = projectSchematicDocument(module, options);
    return {
      document,
      mode: 'full',
      affectedEntities: module.components.map((component) => component.id),
      reused: { geometry: false, routing: false, bounds: false },
      snapshot: { sourceModule: clone(module), document },
    };
  }
  const document = reuseProjectedDocument(previous.document, module);
  return {
    document,
    mode: 'incremental',
    affectedEntities: changedEntityIds(previous.sourceModule, module),
    reused: { geometry: true, routing: true, bounds: true },
    snapshot: { sourceModule: clone(module), document },
  };
}

/** Produce the formal serializable artifact consumed by build and export. */
export function projectSchematicArtifact(
  module: CircuitModule,
  options: SchematicDocumentOptions = {},
): SerializableSchematicDocument {
  return serializeSchematicDocument(projectSchematicDocument(module, options));
}

export function projectSchematicArtifactIncremental(
  module: CircuitModule,
  options: SchematicDocumentOptions = {},
  previous?: {
    sourceModule: CircuitModule;
    artifact: SerializableSchematicDocument;
  } | null,
): {
  artifact: SerializableSchematicDocument;
  mode: SchematicProjectionMode;
  affectedEntities: string[];
  reused: SchematicProjectionComputation['reused'];
} {
  const computation = projectSchematicDocumentIncremental(
    module,
    options,
    previous
      ? {
          sourceModule: previous.sourceModule,
          document: deserializeSchematicDocument(previous.artifact),
        }
      : null,
  );
  return {
    artifact: serializeSchematicDocument(computation.document),
    mode: computation.mode,
    affectedEntities: computation.affectedEntities,
    reused: computation.reused,
  };
}

/**
 * Stable semantic map shared with compile/netlistsvg. Renderer-created SVG
 * paths and auto-routed display wires are deliberately excluded from identity.
 */
export function schematicEntityMap(document: SchematicDocument): SchematicEntityMap {
  const module = document.module;
  const junctionIds = new Set<string>();
  for (const wire of module.wires ?? []) {
    for (const endpoint of [wire.from, wire.to]) {
      if (endpoint?.junction_id) junctionIds.add(endpoint.junction_id);
    }
  }
  return {
    schema: 'actoviq.schematic-entity-map.v1',
    module_id: module.module_id,
    module_revision: module.revision,
    components: module.components
      .map((component) => ({ entity_id: component.id, type: component.type }))
      .sort((left, right) => left.entity_id.localeCompare(right.entity_id)),
    pins: module.components
      .flatMap((component) => component.pins.map((pin) => ({
        entity_id: `${component.id}.${pin.id}`,
        component_id: component.id,
        pin_id: pin.id,
        net: pin.net,
        ...(pin.net_id ? { net_id: pin.net_id } : {}),
      })))
      .sort((left, right) => left.entity_id.localeCompare(right.entity_id)),
    ports: module.ports
      .map((port) => ({
        entity_id: port.id,
        net: port.net,
        ...(port.net_id ? { net_id: port.net_id } : {}),
      }))
      .sort((left, right) => left.entity_id.localeCompare(right.entity_id)),
    nets: (module.nets ?? [])
      .map((net) => ({ entity_id: net.id, name: net.name }))
      .sort((left, right) => left.entity_id.localeCompare(right.entity_id)),
    wires: (module.wires ?? [])
      .map((wire) => ({
        entity_id: wire.id,
        net: wire.net ?? '',
        ...(wire.net_id ? { net_id: wire.net_id } : {}),
      }))
      .sort((left, right) => left.entity_id.localeCompare(right.entity_id)),
    junctions: [...junctionIds]
      .sort((left, right) => left.localeCompare(right))
      .map((entity_id) => ({ entity_id })),
  };
}

export function orderedConnectivitySnapshot(module: CircuitModule): string[][] {
  return [
    ...module.ports.map((port) => ['port', port.id, port.net_id ?? port.net]),
    ...module.components.flatMap((component) => component.pins.map((pin) => [
      'pin',
      component.stable_id ?? component.id,
      pin.id,
      pin.net_id ?? pin.net,
    ])),
  ];
}
