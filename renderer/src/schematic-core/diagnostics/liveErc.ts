import type { CircuitWireEndpoint } from '../../types';
import {
  isMosBodyPin,
  pinWorld,
  type SchematicDocument,
} from '../../schematic/schematicDocument';
import { checkTopologyInvariants } from './topologyInvariants';

export type LiveErcSeverity = 'error' | 'warning' | 'info';

export interface LiveErcDiagnostic {
  id: string;
  code: string;
  severity: LiveErcSeverity;
  message: string;
  point?: { x: number; y: number };
  wire_ids: string[];
  component_id?: string;
  pin_id?: string;
  port_id?: string;
}

export interface LiveErcComputation {
  diagnostics: LiveErcDiagnostic[];
  mode: 'full' | 'incremental';
  affectedEntities: string[];
}

function endpointKey(endpoint: CircuitWireEndpoint | undefined): string {
  if (!endpoint) return '';
  if (endpoint.component_id && endpoint.pin_id) {
    return `pin:${endpoint.component_id}.${endpoint.pin_id}`;
  }
  if (endpoint.port_id) return `port:${endpoint.port_id}`;
  if (endpoint.junction_id) return `junction:${endpoint.junction_id}`;
  return '';
}

function diagnosticId(
  code: string,
  identity: string,
  point?: { x: number; y: number },
): string {
  return `${code}:${identity}:${point ? `${point.x},${point.y}` : ''}`;
}

export function deriveLiveErc(document: SchematicDocument): LiveErcDiagnostic[] {
  const diagnostics: LiveErcDiagnostic[] = checkTopologyInvariants(document.module).diagnostics.map(
    (diagnostic) => ({
      id: diagnosticId(diagnostic.code, diagnostic.wire_ids.join(','), diagnostic.point),
      code: diagnostic.code,
      severity: 'error',
      message: diagnostic.message,
      point: diagnostic.point,
      wire_ids: diagnostic.wire_ids,
      component_id: diagnostic.entity_ids?.[0],
      pin_id: diagnostic.entity_ids?.[1],
    }),
  );
  for (const diagnostic of document.symbolDiagnostics ?? []) {
    const component = diagnostic.component_id
      ? document.module.components.find((entry) => entry.id === diagnostic.component_id)
      : undefined;
    diagnostics.push({
      id: diagnosticId(diagnostic.code, diagnostic.component_id ?? diagnostic.symbol_id ?? diagnostic.message, component?.position),
      code: diagnostic.code,
      severity: 'warning',
      message: diagnostic.message,
      point: component?.position,
      wire_ids: [],
      component_id: diagnostic.component_id,
    });
  }

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
  for (const component of document.module.components) {
    component.pins.forEach((pin, index) => {
      if (isMosBodyPin(component, pin)) return;
      const key = `${component.id}.${pin.id}`;
      const point = pinWorld(component, pin, index);
      if (pin.no_connect && connectedPins.has(key)) {
        diagnostics.push({
          id: diagnosticId('connected_no_connect', key, point),
          code: 'connected_no_connect',
          severity: 'error',
          message: `${component.name}.${pin.name} is marked no-connect but has a wire.`,
          point,
          wire_ids: document.wires
            .filter((wire) => [wire.from, wire.to].some((endpoint) => (
              endpoint?.component_id === component.id && endpoint.pin_id === pin.id
            )))
            .map((wire) => wire.id),
          component_id: component.id,
          pin_id: pin.id,
        });
      } else if (!pin.no_connect && !connectedPins.has(key)) {
        diagnostics.push({
          id: diagnosticId('unconnected_pin', key, point),
          code: 'unconnected_pin',
          severity: 'warning',
          message: `${component.name}.${pin.name} is not connected.`,
          point,
          wire_ids: [],
          component_id: component.id,
          pin_id: pin.id,
        });
      }
    });
  }

  const endpointReferences = new Map<string, number>();
  for (const wire of document.wires) {
    for (const endpoint of [wire.from, wire.to]) {
      const key = endpointKey(endpoint);
      if (key) endpointReferences.set(key, (endpointReferences.get(key) ?? 0) + 1);
    }
  }
  for (const wire of document.wires) {
    for (const [side, endpoint] of [['from', wire.from], ['to', wire.to]] as const) {
      if (!endpoint || endpoint.component_id || endpoint.port_id) continue;
      const key = endpointKey(endpoint);
      if (key && (endpointReferences.get(key) ?? 0) > 1) continue;
      diagnostics.push({
        id: diagnosticId('dangling_wire_endpoint', `${wire.id}.${side}`, endpoint),
        code: 'dangling_wire_endpoint',
        severity: 'warning',
        message: `${wire.id} has a dangling ${side} endpoint.`,
        point: { x: endpoint.x, y: endpoint.y },
        wire_ids: [wire.id],
      });
    }
  }

  const severityOrder: Record<LiveErcSeverity, number> = { error: 0, warning: 1, info: 2 };
  return [...new Map(diagnostics.map((diagnostic) => [diagnostic.id, diagnostic])).values()]
    .sort((left, right) => (
      severityOrder[left.severity] - severityOrder[right.severity]
      || left.code.localeCompare(right.code)
      || left.id.localeCompare(right.id)
    ));
}

/**
 * A property-only projection preserves connectivity and geometry. Reuse its
 * diagnostics and refresh the human-readable component/pin labels for the
 * affected entities. Topology/geometry changes arrive with mode=full and use
 * the canonical complete ERC path.
 */
export function deriveLiveErcIncremental(
  document: SchematicDocument,
  projection: { mode: 'full' | 'incremental'; affectedEntities: string[] },
  previous?: LiveErcDiagnostic[] | null,
): LiveErcComputation {
  if (projection.mode !== 'incremental' || !previous) {
    return {
      diagnostics: deriveLiveErc(document),
      mode: 'full',
      affectedEntities: projection.affectedEntities,
    };
  }
  const affected = new Set(projection.affectedEntities);
  const components = new Map(document.module.components.map((component) => [component.id, component]));
  const diagnostics = previous.map((diagnostic) => {
    if (!diagnostic.component_id || !affected.has(diagnostic.component_id)) return diagnostic;
    const component = components.get(diagnostic.component_id);
    const pin = component?.pins.find((entry) => entry.id === diagnostic.pin_id);
    if (!component || !pin) return diagnostic;
    if (diagnostic.code === 'unconnected_pin') {
      return { ...diagnostic, message: `${component.name}.${pin.name} is not connected.` };
    }
    if (diagnostic.code === 'connected_no_connect') {
      return { ...diagnostic, message: `${component.name}.${pin.name} is marked no-connect but has a wire.` };
    }
    return diagnostic;
  });
  return {
    diagnostics,
    mode: 'incremental',
    affectedEntities: projection.affectedEntities,
  };
}

export function summarizeLiveErc(diagnostics: LiveErcDiagnostic[]) {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;
  const infos = diagnostics.filter((diagnostic) => diagnostic.severity === 'info').length;
  return {
    errors,
    warnings,
    infos,
    status: errors > 0 ? 'error' as const : warnings > 0 ? 'warning' as const : 'clean' as const,
  };
}
