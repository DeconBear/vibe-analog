import { useEffect, useMemo, useState } from 'react';
import type { CircuitModule } from '../types';
import { symbolIdsForModule, type SymbolIrDefinition } from './symbolIr';

const definitionCache = new Map<string, SymbolIrDefinition>();

function cachedDefinitions(symbolIds: string[]): Record<string, SymbolIrDefinition> {
  return Object.fromEntries(symbolIds.flatMap((symbolId) => {
    const definition = definitionCache.get(symbolId);
    return definition ? [[symbolId, definition]] : [];
  }));
}

export function useKicadSymbolDefinitions(module: CircuitModule | undefined): Record<string, SymbolIrDefinition> {
  const symbolIds = useMemo(() => module ? symbolIdsForModule(module) : [], [module]);
  const cacheKey = symbolIds.join('\u0000');
  const [definitions, setDefinitions] = useState<Record<string, SymbolIrDefinition>>(
    () => cachedDefinitions(symbolIds),
  );

  useEffect(() => {
    let cancelled = false;
    const cached = cachedDefinitions(symbolIds);
    setDefinitions(cached);
    const missing = symbolIds.filter((symbolId) => !cached[symbolId]);
    if (missing.length === 0 || !window.electronAPI?.resolveKicadSymbolIr) return () => { cancelled = true; };
    void window.electronAPI.resolveKicadSymbolIr(missing).then((bundle) => {
      for (const [symbolId, definition] of Object.entries(bundle.definitions ?? {})) {
        definitionCache.set(symbolId, definition);
      }
      if (!cancelled) setDefinitions(cachedDefinitions(symbolIds));
    }).catch(() => {
      if (!cancelled) setDefinitions(cached);
    });
    return () => { cancelled = true; };
  }, [cacheKey]); // symbolIds are represented by the stable, sorted cache key.

  return definitions;
}
