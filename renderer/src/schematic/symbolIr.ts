import type { CircuitComponent, CircuitModule, CircuitPosition } from '../types';

export interface SymbolIrTextEffects {
  font_size: number;
  justify: string[];
  bold: boolean;
  italic: boolean;
  visible: boolean;
}

export interface SymbolIrStroke {
  width: number;
  style: string;
}

export type SymbolIrFill = 'none' | 'background' | 'outline';

export type SymbolIrGraphic =
  | { kind: 'polyline'; points: CircuitPosition[]; stroke: SymbolIrStroke; fill: SymbolIrFill }
  | { kind: 'rectangle'; start: CircuitPosition; end: CircuitPosition; stroke: SymbolIrStroke; fill: SymbolIrFill }
  | { kind: 'circle'; center: CircuitPosition; radius: number; stroke: SymbolIrStroke; fill: SymbolIrFill }
  | { kind: 'arc'; start: CircuitPosition; mid: CircuitPosition; end: CircuitPosition; stroke: SymbolIrStroke; fill: SymbolIrFill }
  | { kind: 'text'; text: string; at: CircuitPosition; angle: number; effects: SymbolIrTextEffects };

export interface SymbolIrPin {
  number: string;
  name: string;
  electrical_type: string;
  shape: string;
  at: CircuitPosition;
  angle: number;
  length: number;
  name_effects: SymbolIrTextEffects;
  number_effects: SymbolIrTextEffects;
}

export interface SymbolIrVariant {
  unit: number;
  variant: number;
  renderable: boolean;
  graphics: SymbolIrGraphic[];
  pins: SymbolIrPin[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface SymbolIrDefinition {
  schema: 'actoviq.symbol-ir.v1';
  id: string;
  source: {
    format: 'kicad';
    library: string;
    symbol: string;
    version: string;
    content_hash: string;
  };
  unit_count: number;
  pin_names: { visible: boolean; offset: number };
  pin_numbers: { visible: boolean };
  properties: Record<'reference' | 'value', {
    at: CircuitPosition;
    angle: number;
    effects: SymbolIrTextEffects;
  }>;
  variants: SymbolIrVariant[];
  diagnostics: SymbolIrDiagnostic[];
}

export interface SymbolIrDiagnostic {
  code: string;
  message: string;
  symbol_id?: string;
  component_id?: string;
}

export interface SymbolIrBundle {
  schema: 'actoviq.symbol-ir-bundle.v1';
  definitions: Record<string, SymbolIrDefinition>;
  diagnostics: SymbolIrDiagnostic[];
}

export interface SymbolIrInstance {
  component_id: string;
  symbol_id: string;
  definition_hash?: string;
  unit: number;
  variant: number;
  status: 'resolved' | 'missing' | 'unsupported' | 'unit_missing' | 'pin_mismatch';
}

const componentVariants = new WeakMap<CircuitComponent, SymbolIrVariant>();
const componentDefinitions = new WeakMap<CircuitComponent, SymbolIrDefinition>();

export function usesNativeSymbol(component: CircuitComponent): boolean {
  if (component.type !== 'BLOCK' && component.type !== 'U' && component.type !== 'X') return true;
  const symbol = component.eda?.symbol?.toLowerCase() ?? '';
  return symbol.includes(':crystal') || symbol.includes(':resonator');
}

export function symbolIdsForModule(module: CircuitModule): string[] {
  return [...new Set(module.components
    .filter((component) => !usesNativeSymbol(component))
    .map((component) => component.eda?.symbol?.trim() ?? '')
    .filter(Boolean))].sort();
}

export function resolveSymbolVariant(component: CircuitComponent): SymbolIrVariant | undefined {
  return componentVariants.get(component);
}

export function resolveSymbolDefinition(component: CircuitComponent): SymbolIrDefinition | undefined {
  return componentDefinitions.get(component);
}

export function hydrateSymbolGeometry(
  module: CircuitModule,
  definitions: Record<string, SymbolIrDefinition>,
): { instances: SymbolIrInstance[]; diagnostics: SymbolIrDiagnostic[] } {
  const instances: SymbolIrInstance[] = [];
  const diagnostics: SymbolIrDiagnostic[] = [];
  for (const component of module.components) {
    const symbolId = component.eda?.symbol?.trim();
    if (!symbolId || usesNativeSymbol(component)) continue;
    const unit = component.eda?.unit ?? 1;
    const variant = component.eda?.symbol_variant ?? 1;
    const definition = definitions[symbolId];
    let status: SymbolIrInstance['status'] = 'resolved';
    let resolved: SymbolIrVariant | undefined;
    if (!definition) {
      status = 'missing';
    } else {
      resolved = definition.variants.find((item) => item.unit === unit && item.variant === variant);
      if (!resolved) status = 'unit_missing';
      else if (!resolved.renderable) status = 'unsupported';
      else {
        const componentPins = new Set(component.pins.map((pin) => pin.id));
        const definitionPins = new Set(resolved.pins.map((pin) => pin.number));
        if (componentPins.size !== definitionPins.size
          || [...definitionPins].some((pinNumber) => !componentPins.has(pinNumber))) {
          status = 'pin_mismatch';
        }
      }
    }
    if (definition) componentDefinitions.set(component, definition);
    if (resolved && status === 'resolved') componentVariants.set(component, resolved);
    const instance: SymbolIrInstance = {
      component_id: component.id,
      symbol_id: symbolId,
      definition_hash: definition?.source.content_hash,
      unit,
      variant,
      status,
    };
    instances.push(instance);
    if (status !== 'resolved') {
      const code = status === 'unsupported'
        ? 'symbol_ir_unsupported'
        : status === 'missing'
          ? 'symbol_ir_missing'
          : status === 'unit_missing'
            ? 'symbol_ir_unit_missing'
            : 'symbol_ir_pin_mismatch';
      diagnostics.push({
        code,
        symbol_id: symbolId,
        component_id: component.id,
        message: `Symbol ${symbolId} unit ${unit} variant ${variant} could not be rendered (${status}); using the editable block fallback.`,
      });
    }
  }
  return { instances, diagnostics };
}

export function rotateSymbolPoint(point: CircuitPosition, rotation: number): CircuitPosition {
  const normalized = ((rotation % 360) + 360) % 360;
  if (normalized === 90) return { x: -point.y, y: point.x };
  if (normalized === 180) return { x: -point.x, y: -point.y };
  if (normalized === 270) return { x: point.y, y: -point.x };
  const radians = normalized * Math.PI / 180;
  return {
    x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: point.x * Math.sin(radians) + point.y * Math.cos(radians),
  };
}
