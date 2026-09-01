import type { CSSProperties } from 'react';
import type { CircuitComponent, ProjectKind } from '../../../types';
import type { SymbolIrDefinition } from '../../../schematic/symbolIr';

export interface PdkDeviceCatalogDevice {
  device_id: string;
  kind?: string;
  pins?: string[];
  spice?: {
    model?: string;
    format?: string;
    pin_order?: string[];
    primitive?: string;
  };
  parameters?: Record<string, PdkParameterConstraint | unknown>;
  views?: Record<string, unknown>;
}

export interface PdkParameterConstraint {
  required?: boolean;
  default?: string | number;
  unit?: string;
  minimum?: string | number;
  maximum?: string | number;
  exclusive_minimum?: boolean;
  exclusive_maximum?: boolean;
  integer?: boolean;
  enum?: Array<string | number>;
}

export interface PdkDeviceCatalog {
  schema?: string;
  pdk_ref?: string;
  devices: PdkDeviceCatalogDevice[];
  binding?: {
    default_corner?: string;
    corner_sweep?: string[];
    model_library_available?: boolean;
    installation_version?: string;
    installation_fingerprint?: string;
  };
}

export interface ComponentParamFormContext {
  projectKind: ProjectKind;
  component: CircuitComponent;
  busy: boolean;
  pdkCatalog?: PdkDeviceCatalog | null;
}

export interface ComponentParamFormProps extends ComponentParamFormContext {
  fieldLabelStyle: CSSProperties;
  inputStyle: CSSProperties;
  hintStyle?: CSSProperties;
  onPatch: (patch: Partial<CircuitComponent>) => void;
  symbolDefinition?: SymbolIrDefinition;
  packageOptions?: Array<{ id: string; label: string }>;
  onUnitChange?: (unit: number) => void;
  onPackageChange?: (packageId: string) => void;
}
