import { useEffect, useState } from 'react';

import type { CircuitModule } from '../../types';
import { useKicadSymbolDefinitions } from '../../schematic/useKicadSymbolDefinitions';
import {
  sharedProjectionWorker,
  type ProjectionWorkerResult,
} from './projectionWorkerClient';

export function useSchematicProjection(
  module: CircuitModule | undefined,
  enabled = true,
): ProjectionWorkerResult | null {
  const [result, setResult] = useState<ProjectionWorkerResult | null>(null);
  const symbolDefinitions = useKicadSymbolDefinitions(module);

  useEffect(() => {
    if (!module || !enabled) {
      setResult(null);
      return undefined;
    }
    const controller = new AbortController();
    sharedProjectionWorker().project(module, { symbolDefinitions }, controller.signal).then(
      (next) => setResult(next),
      (error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('Schematic projection worker failed:', error);
        setResult(null);
      },
    );
    return () => controller.abort();
  }, [enabled, module, symbolDefinitions]);

  return result;
}
