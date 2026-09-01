import type { CSSProperties, ReactNode } from 'react';
import type { ComponentParamFormProps } from './types';
import { parseComponentValue } from './projectToValue';

function Field({
  label,
  children,
  style,
}: {
  label: string;
  children: ReactNode;
  style: CSSProperties;
}) {
  return (
    <label style={style}>
      {label}
      {children}
    </label>
  );
}

export function PcbParamForm({
  component,
  busy,
  fieldLabelStyle,
  inputStyle,
  hintStyle,
  onPatch,
  symbolDefinition,
  packageOptions = [],
  onUnitChange,
  onPackageChange,
}: ComponentParamFormProps) {
  const eda = component.eda || {};
  const patchEda = (key: string, value: string) => {
    const next = { ...eda };
    const trimmed = value.trim();
    if (!trimmed) delete next[key];
    else next[key] = trimmed;
    onPatch({ eda: next });
  };

  return (
    <>
      {eda.symbol ? (
        <>
          <Field label="KiCad symbol" style={fieldLabelStyle}>
            <input style={inputStyle} value={String(eda.symbol)} readOnly data-testid="schematic-param-symbol" />
          </Field>
          <Field label="Symbol unit" style={fieldLabelStyle}>
            <select
              style={inputStyle}
              value={String(eda.unit ?? 1)}
              disabled={busy || !symbolDefinition || symbolDefinition.unit_count <= 1}
              onChange={(event) => onUnitChange?.(Number(event.target.value))}
              data-testid="schematic-param-symbol-unit"
            >
              {Array.from({ length: symbolDefinition?.unit_count ?? 1 }, (_, index) => index + 1).map((unit) => (
                <option key={unit} value={unit}>{unit}</option>
              ))}
            </select>
          </Field>
          <Field label="Physical package" style={fieldLabelStyle}>
            <select
              style={inputStyle}
              value={String(eda.package_id ?? '')}
              disabled={busy || packageOptions.length === 0}
              onChange={(event) => onPackageChange?.(event.target.value)}
              data-testid="schematic-param-package"
            >
              {!eda.package_id ? <option value="">Not grouped</option> : null}
              {packageOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </Field>
        </>
      ) : null}
      <Field label="Value (BOM display)" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={component.value}
          disabled={busy}
          data-testid="schematic-editor-component-value"
          onChange={(event) => {
            const value = event.target.value;
            onPatch({
              value,
              parameters: {
                ...(component.parameters || {}),
                ...parseComponentValue(component.type, value),
              },
            });
          }}
        />
      </Field>
      <p style={hintStyle || { fontSize: 11, color: '#7a818b', margin: '0 0 10px' }}>
        PCB flow focuses on BOM and footprint metadata.
      </p>
      <Field label="Footprint hint" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={String(eda.footprint_hint ?? '')}
          disabled={busy}
          placeholder="e.g. R_0603"
          data-testid="schematic-param-footprint"
          onChange={(event) => patchEda('footprint_hint', event.target.value)}
        />
      </Field>
      <Field label="KiCad footprint" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={String(eda.footprint ?? '')}
          disabled={busy}
          placeholder="Library:Footprint"
          data-testid="schematic-param-kicad-footprint"
          onChange={(event) => patchEda('footprint', event.target.value)}
        />
      </Field>
      <Field label="LCSC ID" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={String(eda.lcsc_id ?? '')}
          disabled={busy}
          data-testid="schematic-param-lcsc"
          onChange={(event) => patchEda('lcsc_id', event.target.value)}
        />
      </Field>
      <Field label="Manufacturer" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={String(eda.manufacturer ?? '')}
          disabled={busy}
          data-testid="schematic-param-manufacturer"
          onChange={(event) => patchEda('manufacturer', event.target.value)}
        />
      </Field>
      <Field label="MPN" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={String(eda.mpn ?? '')}
          disabled={busy}
          data-testid="schematic-param-mpn"
          onChange={(event) => patchEda('mpn', event.target.value)}
        />
      </Field>
      <Field label="Refdes override" style={fieldLabelStyle}>
        <input
          style={inputStyle}
          value={String(eda.refdes ?? '')}
          disabled={busy}
          data-testid="schematic-param-refdes"
          onChange={(event) => patchEda('refdes', event.target.value)}
        />
      </Field>
    </>
  );
}
