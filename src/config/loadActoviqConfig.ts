import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { loadDefaultHadamardSettings, loadJsonConfigFile } from 'actoviq-agent-sdk';

import { PROJECT_ROOT, RUNTIME_CWD, WORKSPACE_ROOT } from './projectPaths.js';

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export interface LoadedActoviqConfigSource {
  source: string;
}

export async function loadActoviqConfig(): Promise<LoadedActoviqConfigSource> {
  const envPath = process.env.ACTOVIQ_AGENT_CONFIG_PATH?.trim();
  const cwdConfig = path.resolve(RUNTIME_CWD, 'agent.settings.local.json');
  const cwdActoviqConfig = path.resolve(RUNTIME_CWD, 'actoviq.settings.json');
  const packageConfig = path.resolve(PROJECT_ROOT, 'agent.settings.local.json');
  const candidates = [
    ...new Set([envPath, cwdConfig, cwdActoviqConfig, packageConfig].filter((value): value is string => Boolean(value))),
  ];

  for (const candidate of candidates) {
    if (!(await exists(candidate))) {
      continue;
    }
    await loadJsonConfigFile(candidate);
    return { source: candidate };
  }

  await loadDefaultHadamardSettings();
  return { source: '~/.actoviq/settings.json' };
}
