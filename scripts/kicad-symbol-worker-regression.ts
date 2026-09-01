import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  prewarmKicadSymbolWorker,
  resolveKicadSymbolIr,
  stopActiveProjectTools,
} from '../electron/agent/circuitProjectCli.ts';

const symbolId = 'MCU_ST_STM32F1:STM32F103C8Tx';

try {
  const startedAt = performance.now();
  await prewarmKicadSymbolWorker();
  const startupMs = performance.now() - startedAt;

  const first = await resolveKicadSymbolIr([symbolId]);
  const firstDefinitions = first.definitions as Record<string, { id?: string }>;
  assert.equal(first.ok, true);
  assert.equal(first.schema, 'actoviq.symbol-ir-bundle.v1');
  assert.equal(firstDefinitions[symbolId]?.id, symbolId);

  const durations: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const requestStartedAt = performance.now();
    const result = await resolveKicadSymbolIr([symbolId, symbolId]);
    durations.push(performance.now() - requestStartedAt);
    assert.equal((result.definitions as Record<string, { id?: string }>)[symbolId]?.id, symbolId);
  }
  durations.sort((left, right) => left - right);
  const medianMs = durations[Math.floor(durations.length / 2)] ?? Number.POSITIVE_INFINITY;
  assert.ok(medianMs < 500, `warmed KiCad worker median too slow: ${medianMs.toFixed(1)}ms`);

  const [device, regulator] = await Promise.all([
    resolveKicadSymbolIr(['Device:R']),
    resolveKicadSymbolIr(['Regulator_Linear:AMS1117-3.3']),
  ]);
  assert.ok((device.definitions as Record<string, unknown>)['Device:R']);
  assert.ok((regulator.definitions as Record<string, unknown>)['Regulator_Linear:AMS1117-3.3']);

  console.log(`kicad-symbol-worker regression ok (startup ${startupMs.toFixed(1)}ms, warm median ${medianMs.toFixed(1)}ms)`);
} finally {
  await stopActiveProjectTools();
}
