import { app, BrowserWindow, dialog, nativeImage, type IpcMain, shell } from 'electron';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { access, copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { layoutVisionModelFingerprint, loadSettings, loadSettingsWithSecrets, resolveNgspiceExecutable } from './settings.js';
import { getActiveWorkspace } from '../workspaceState.js';
import { generateDesktopTechnicalReport } from '../agent/desktopAgentService.js';
import { runProjectTool } from '../agent/circuitProjectCli.js';
import { resolveExecutionProfile } from '../eda/executionProfileRegistry.js';

interface LicensedProviderRuntime {
  prepare(job: Record<string, unknown>): Promise<Record<string, unknown>>;
  run(job: Record<string, unknown>): Promise<Record<string, unknown>>;
  parse(job: Record<string, unknown>, execution: Record<string, unknown>): Promise<Record<string, unknown>>;
}

async function createLicensedProvider(profile: Record<string, unknown>): Promise<LicensedProviderRuntime> {
  const runtimeUrl = new URL('../../dist/eda/licensedEdaProviders.js', import.meta.url).href;
  const runtime = await import(runtimeUrl) as {
    LicensedEdaProvider: new (value: Record<string, unknown>) => LicensedProviderRuntime;
  };
  return new runtime.LicensedEdaProvider(profile);
}

interface ProjectSummary {
  projectId: string;
  name: string;
  revision: number;
  updatedAt: string;
  projectRoot: string;
  moduleCount: number;
}

interface TrashProjectSummary extends ProjectSummary {
  trashId: string;
  deletedAt: string;
  originalPath: string;
  trashPath: string;
}

interface ProjectHistoryEntry {
  revision: number;
  baseRevision: number;
  actor: string;
  message: string;
  createdAt: string;
  documentHash?: string;
  restorable: boolean;
  buildStatus?: string;
  netlistDiff: { added: string[]; removed: string[] };
}

interface SavedDesignMemorySummary {
  ok: true;
  id: string;
  kind: 'template' | 'flow';
  name: string;
  rootPath: string;
  relativePath: string;
  guidePath?: string;
  templatePath?: string;
  flowPath?: string;
  hasLayoutReference?: boolean;
  layoutPack?: Record<string, unknown> | null;
}

interface EdaExportRequest {
  scope: 'project' | 'module';
  moduleId?: string;
  targets: Array<'kicad' | 'altium' | 'orcad' | 'virtuoso'>;
  view: 'design' | 'simulation';
  mappingFile?: string;
  nativeConvert: 'auto' | 'never' | 'required';
  strictLayout: boolean;
  sourceRevision: number;
  /** Optional parent directory. Export is written to <outputDir>/<export_id>/. */
  outputDir?: string;
}

interface LayoutOptimizationRequest {
  moduleId: string;
  sourceRevision: number;
}

interface LayoutVisionReviewRequest {
  provider: 'anthropic' | 'openai';
  model: string;
  base_url?: string;
  work_dir: string;
  session_directory?: string;
  svg_path: string;
  image_path?: string;
  layout_quality_report_path: string;
  module_id: string;
  source_revision: number;
  connectivity_hash: string;
}

interface DesignMemoryItem {
  id: string;
  kind: 'template' | 'flow';
  name: string;
  rootPath: string;
  relativePath: string;
  sourceProjectId?: string;
  sourceRevision?: number;
  sourceDocumentHash?: string;
  createdAt?: string;
  circuitFamilies?: string[];
  validationStatus?: string;
  preferredForAgentReuse?: boolean;
  simulationCoverage?: string[];
  guidePath?: string;
  templatePath?: string;
  flowPath?: string;
}

let activeWatcher: FSWatcher | null = null;
let watchedProjectId = '';
let watchTimer: NodeJS.Timeout | null = null;
let watchPollTimer: NodeJS.Timeout | null = null;
let watchedProjectRevision: number | null = null;
let watchPauseDepth = 0;
const legacyArchivePromises = new Map<string, Promise<void>>();

let projectsDirWatcher: FSWatcher | null = null;
let projectsDirWatchRoot = '';
let projectsDirWatchTimer: NodeJS.Timeout | null = null;
let projectsDirPollTimer: NodeJS.Timeout | null = null;
let projectsDirSnapshot = '';

function notifyProjectListChanged(): void {
  if (projectsDirWatchTimer) clearTimeout(projectsDirWatchTimer);
  projectsDirWatchTimer = setTimeout(() => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('project:list-changed', { timestamp: Date.now() });
    }
  }, 150);
}

async function snapshotProjectsDirectory(root: string): Promise<string> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .join('\n');
  } catch {
    return '';
  }
}

export async function ensureProjectsDirectoryWatcher(): Promise<void> {
  const root = await projectsRoot();
  if (projectsDirWatcher && projectsDirWatchRoot === root) return;
  try {
    projectsDirWatcher?.close();
  } catch {
    // ignore
  }
  projectsDirWatcher = null;
  if (projectsDirPollTimer) {
    clearInterval(projectsDirPollTimer);
    projectsDirPollTimer = null;
  }
  projectsDirWatchRoot = root;
  projectsDirSnapshot = await snapshotProjectsDirectory(root);
  try {
    projectsDirWatcher = watch(root, (_eventType, filename) => {
      const relative = String(filename ?? '').replace(/\\/g, '/');
      // Only react to top-level project folder create/rename/remove events.
      if (relative.includes('/')) return;
      void (async () => {
        const next = await snapshotProjectsDirectory(root);
        if (next === projectsDirSnapshot) return;
        projectsDirSnapshot = next;
        notifyProjectListChanged();
      })();
    });
    projectsDirWatcher.on('error', (error) => {
      console.warn('projects directory watcher error:', error);
    });
  } catch (error) {
    console.warn('projects directory watcher failed to start:', error);
  }
  // Baidu sync / network drives sometimes miss create events; poll as backup.
  projectsDirPollTimer = setInterval(() => {
    void (async () => {
      if (projectsDirWatchRoot !== root) return;
      const next = await snapshotProjectsDirectory(root);
      if (next === projectsDirSnapshot) return;
      projectsDirSnapshot = next;
      notifyProjectListChanged();
    })();
  }, 2_000);
}

function pauseProjectWatcher(): void {
  watchPauseDepth += 1;
  if (watchPauseDepth === 1) {
    try {
      activeWatcher?.close();
    } catch {
      // ignore
    }
    activeWatcher = null;
  }
}

async function resumeProjectWatcher(): Promise<void> {
  watchPauseDepth = Math.max(0, watchPauseDepth - 1);
  if (watchPauseDepth > 0 || !watchedProjectId) return;
  await watchProject(watchedProjectId);
}

async function withProjectWatchPaused<T>(work: () => Promise<T>): Promise<T> {
  pauseProjectWatcher();
  try {
    return await work();
  } finally {
    await resumeProjectWatcher().catch((error) => {
      console.warn('project watcher resume failed:', error);
    });
  }
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function assertModuleId(moduleId: string): string {
  if (typeof moduleId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(moduleId)) {
    throw new Error(`Invalid module id: ${moduleId}`);
  }
  return moduleId;
}

async function projectsRoot(): Promise<string> {
  const workspace = await getActiveWorkspace();
  const root = path.resolve(workspace.root, 'projects');
  await mkdir(root, { recursive: true });
  return root;
}

/** User-configurable one-click PDK root; blank falls back to app userData/pdks. */
async function resolveConfiguredPdkInstallRoot(): Promise<string> {
  const settings = await loadSettingsWithSecrets();
  const configured = typeof settings.pdkInstallRoot === 'string' ? settings.pdkInstallRoot.trim() : '';
  const root = configured
    ? path.resolve(configured)
    : path.join(app.getPath('userData'), 'pdks');
  await mkdir(root, { recursive: true });
  return root;
}

async function resolveProjectRoot(projectId: string): Promise<string> {
  const root = await projectsRoot();
  const candidate = path.resolve(root, String(projectId ?? '').trim());
  const relative = path.relative(root, candidate);
  if (!projectId || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Invalid project id: ${projectId}`);
  }
  if (!(await exists(path.resolve(candidate, 'project.circuit.json')))) {
    throw new Error(`Circuit project not found: ${projectId}`);
  }
  return candidate;
}

async function trashProjectsRoot(): Promise<string> {
  const workspace = await getActiveWorkspace();
  const root = path.resolve(workspace.root, '.trash', 'projects');
  await mkdir(root, { recursive: true });
  return root;
}

function assertDirectChild(root: string, candidate: string, id: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!id || !relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error(`Invalid project entry id: ${id}`);
  }
}

function stopProjectWatcher(projectId: string): void {
  if (watchedProjectId !== projectId) return;
  activeWatcher?.close();
  activeWatcher = null;
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = null;
  if (watchPollTimer) clearInterval(watchPollTimer);
  watchPollTimer = null;
  watchedProjectId = '';
  watchedProjectRevision = null;
}

function timestampForId(date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'circuit-design';
}

function relativeReferencePath(referencesDir: string, targetPath: string): string {
  return path.relative(referencesDir, targetPath).replace(/\\/g, '/');
}

async function uniqueProjectRoot(projectsRootPath: string, name: string): Promise<{ projectId: string; projectRoot: string }> {
  const baseId = slugify(name);
  let projectId = baseId;
  let suffix = 2;
  while (await exists(path.resolve(projectsRootPath, projectId))) {
    projectId = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return {
    projectId,
    projectRoot: path.resolve(projectsRootPath, projectId),
  };
}

async function copyFileIfExists(source: string, target: string): Promise<boolean> {
  if (!(await exists(source))) return false;
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  return true;
}

async function copyDirectoryIfExists(source: string, target: string): Promise<boolean> {
  if (!(await exists(source))) return false;
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  return true;
}

async function readJsonFile<T>(targetPath: string): Promise<T> {
  return JSON.parse(await readFile(targetPath, 'utf8')) as T;
}

async function writeSchematicDocumentArtifact(
  projectRoot: string,
  moduleId: string,
  artifact: unknown,
): Promise<string> {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error('Schematic document artifact must be an object');
  }
  const document = artifact as {
    schema?: unknown;
    moduleId?: unknown;
    module?: {
      module_id?: unknown;
      revision?: unknown;
      components?: Array<{ id?: unknown; pins?: Array<{ id?: unknown }> }>;
      wires?: Array<{ id?: unknown }>;
    };
  };
  if (document.schema !== 'actoviq.schematic-document.v1') {
    throw new Error('Schematic document artifact schema must be actoviq.schematic-document.v1');
  }
  if (document.moduleId !== moduleId || document.module?.module_id !== moduleId) {
    throw new Error(`Schematic document artifact module mismatch: ${moduleId}`);
  }
  const source = await readJsonFile<{
    module_id: string;
    revision: number;
    components: Array<{ id: string; pins: Array<{ id: string }> }>;
    wires?: Array<{ id: string }>;
  }>(
    path.resolve(projectRoot, 'modules', moduleId, 'module.circuit.json'),
  );
  const artifactRevision = Number(document.module.revision);
  // Allow source.revision - 1: save applies command.v2 first (disk revision
  // bumps), then compile receives the editor projection still stamped with the
  // pre-apply revision. Entity/wire id checks below are the real staleness
  // guard; we rewrite artifact.revision to the disk value on write.
  if (
    source.module_id !== moduleId
    || !Number.isInteger(artifactRevision)
    || (artifactRevision !== source.revision && artifactRevision !== source.revision - 1)
  ) {
    throw new Error(`Schematic document artifact is stale for ${moduleId}`);
  }
  const sourceEntityIds = [
    ...source.components.map((component) => `component:${component.id}`),
    ...source.components.flatMap((component) => component.pins.map((pin) => `pin:${component.id}.${pin.id}`)),
  ].sort();
  const artifactEntityIds = [
    ...(document.module.components ?? []).map((component) => `component:${String(component.id ?? '')}`),
    ...(document.module.components ?? []).flatMap((component) => (
      component.pins ?? []
    ).map((pin) => `pin:${String(component.id ?? '')}.${String(pin.id ?? '')}`)),
  ].sort();
  const artifactEntityIdSet = new Set(artifactEntityIds);
  if (sourceEntityIds.some((entityId) => !artifactEntityIdSet.has(entityId))) {
    throw new Error(`Schematic document artifact entities are stale for ${moduleId}`);
  }
  const artifactWireIds = new Set((document.module.wires ?? []).map((wire) => String(wire.id ?? '')));
  if ((source.wires ?? []).some((wire) => !artifactWireIds.has(wire.id))) {
    throw new Error(`Schematic document artifact wires are stale for ${moduleId}`);
  }
  const normalizedArtifact = structuredClone(artifact) as typeof document;
  if (normalizedArtifact.module) normalizedArtifact.module.revision = source.revision;
  const target = path.resolve(projectRoot, 'build', 'modules', moduleId, 'schematic-document.json');
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(normalizedArtifact, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
  return target;
}

const HDL_SOURCE_EXTENSIONS = new Set(['.v', '.vh', '.sv', '.svh', '.json', '.sdc', '.tcl']);

function resolveHdlProjectFile(projectRoot: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`Invalid HDL project path: ${relativePath}`);
  }
  const hdlRoot = path.resolve(projectRoot, 'hdl');
  const target = path.resolve(hdlRoot, normalized);
  const relative = path.relative(hdlRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`HDL path escapes the project: ${relativePath}`);
  }
  if (!HDL_SOURCE_EXTENSIONS.has(path.extname(target).toLowerCase())) {
    throw new Error(`Unsupported HDL file type: ${relativePath}`);
  }
  return target;
}

async function listHdlSourceFiles(root: string, prefix = ''): Promise<string[]> {
  if (!(await exists(root))) return [];
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listHdlSourceFiles(absolute, relative));
    } else if (entry.isFile() && HDL_SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(relative);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function initializeHdlWorkspace(projectRoot: string): Promise<{ files: string[] }> {
  const hdlRoot = path.resolve(projectRoot, 'hdl');
  await mkdir(hdlRoot, { recursive: true });
  const sourcePath = path.resolve(hdlRoot, 'digital_top.v');
  const manifestPath = path.resolve(hdlRoot, 'manifest.json');
  if (!(await exists(sourcePath))) {
    await writeFile(
      sourcePath,
      [
        'module digital_top(',
        '  input wire clk,',
        '  input wire reset_n,',
        '  output reg ready',
        ');',
        '  always @(posedge clk or negedge reset_n) begin',
        '    if (!reset_n) ready <= 1\'b0;',
        '    else ready <= 1\'b1;',
        '  end',
        'endmodule',
        '',
      ].join('\n'),
      'utf8',
    );
  }
  if (!(await exists(manifestPath))) {
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schema: 'actoviq.hdl-manifest.v1',
        language: 'verilog-2005',
        active_source_set: 'rtl',
        source_sets: [{
          id: 'rtl',
          top: 'digital_top',
          sources: ['hdl/digital_top.v'],
          include_paths: ['hdl'],
          defines: {},
        }],
      }, null, 2)}\n`,
      'utf8',
    );
  }
  const project = JSON.parse(await readFile(path.resolve(projectRoot, 'project.circuit.json'), 'utf8')) as {
    project_kind?: string;
  };
  const mixedContractPath = path.resolve(hdlRoot, 'mixed-signal.json');
  if (project.project_kind === 'mixed_signal_ic' && !(await exists(mixedContractPath))) {
    await writeFile(
      mixedContractPath,
      `${JSON.stringify({
        schema: 'actoviq.mixed-signal-contract.v1',
        boundaries: [{
          id: 'boundary_1',
          analog_net: 'analog_net',
          digital_signal: 'digital_signal',
          direction: 'analog_to_digital',
          supply_domain: { vss: 0, vdd: 1.8 },
          threshold: { low_max: 0.5, high_min: 1.3 },
          sampling: { mode: 'edge', edge: 'rising' },
          conversion_model: 'connectrules/boundary.vams',
          vectors: [],
        }],
      }, null, 2)}\n`,
      'utf8',
    );
  }
  return { files: await listHdlSourceFiles(hdlRoot) };
}

async function latestPassedHdlRun(root: string): Promise<string | null> {
  if (!(await exists(root))) return null;
  const candidates: Array<{ path: string; modified: number }> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile() && entry.name === 'run.json') {
        try {
          const value = JSON.parse(await readFile(target, 'utf8')) as { kind?: string; status?: string };
          if (value.status === 'passed' && value.kind?.startsWith('hdl_')) {
            candidates.push({ path: target, modified: (await stat(target)).mtimeMs });
          }
        } catch {
          // Ignore incomplete run records while another provider is writing.
        }
      }
    }
  }
  await visit(root);
  return candidates.sort((left, right) => right.modified - left.modified)[0]?.path ?? null;
}

async function runHdlAction(
  projectRoot: string,
  action: 'simulate' | 'synthesize' | 'gate-regression' | 'openroad' | 'mixed-contract',
): Promise<Record<string, unknown>> {
  const runId = `${timestampForId()}-${Math.random().toString(36).slice(2, 8)}`;
  const runsRoot = path.resolve(projectRoot, 'build', 'hdl', 'runs');
  await mkdir(runsRoot, { recursive: true });
  if (action === 'mixed-contract') {
    const contract = path.resolve(projectRoot, 'hdl', 'mixed-signal.json');
    if (!(await exists(contract))) throw new Error('Initialize or create hdl/mixed-signal.json first.');
    const analogRun = path.resolve(projectRoot, 'build', 'system', 'simulation', 'result.json');
    const digitalRun = await latestPassedHdlRun(runsRoot);
    const args = [
      'mixed-signal-check',
      '--contract', contract,
      '--run-root', path.resolve(runsRoot, `${runId}-mixed-contract`),
    ];
    if (await exists(analogRun)) args.push('--analog-run', analogRun);
    if (digitalRun) args.push('--digital-run', digitalRun);
    return runProjectTool(args);
  }
  if (action === 'openroad') {
    const manifest = JSON.parse(await readFile(path.resolve(projectRoot, 'hdl', 'manifest.json'), 'utf8')) as {
      active_source_set?: string;
      source_sets?: Array<{ id?: string; openroad_script?: string }>;
    };
    const sourceSet = manifest.source_sets?.find((entry) => entry.id === manifest.active_source_set)
      ?? manifest.source_sets?.[0];
    const script = sourceSet?.openroad_script?.trim();
    if (!script) throw new Error('Active HDL source set does not declare openroad_script.');
    return runProjectTool([
      'hdl-openroad',
      '--project-root', projectRoot,
      '--script', script,
      '--run-root', path.resolve(runsRoot, `${runId}-openroad`),
    ], { timeoutMs: 1_200_000 });
  }
  if (action === 'simulate') {
    return runProjectTool([
      'hdl-simulate',
      '--project-root', projectRoot,
      '--run-root', path.resolve(runsRoot, `${runId}-simulation`),
    ]) as Promise<Record<string, unknown>>;
  }
  const synthesisRoot = path.resolve(runsRoot, `${runId}-synthesis`);
  const synthesis = await runProjectTool([
    'hdl-synthesize',
    '--project-root', projectRoot,
    '--run-root', synthesisRoot,
  ]) as Record<string, unknown>;
  if (action === 'synthesize' || synthesis.status !== 'passed') return synthesis;
  return runProjectTool([
    'hdl-gate-regression',
    '--project-root', projectRoot,
    '--synthesis-run', path.resolve(synthesisRoot, 'run.json'),
    '--run-root', path.resolve(runsRoot, `${runId}-gate-regression`),
  ]) as Promise<Record<string, unknown>>;
}

async function designMemoryTargetRoot(
  kind: 'templates' | 'flows',
  project: { name: string; revision: number },
): Promise<{ workspaceReferencesDir: string; targetRoot: string; memoryId: string }> {
  const workspace = await getActiveWorkspace();
  const memoryId = `${slugify(project.name)}-r${project.revision}-${timestampForId()}`;
  const targetRoot = path.resolve(workspace.referencesDir, 'design-memory', kind, memoryId);
  await mkdir(path.dirname(targetRoot), { recursive: true });
  await mkdir(targetRoot, { recursive: false });
  return { workspaceReferencesDir: workspace.referencesDir, targetRoot, memoryId };
}

function renderModuleSummary(project: {
  modules?: Array<{
    id: string;
    name: string;
    kind: string;
    function?: string;
    parameters?: Record<string, string>;
    ports?: Array<{ name: string; direction: string; signal_type: string; net: string; network?: string }>;
  }>;
}): string {
  return (project.modules ?? []).map((module) => {
    const ports = (module.ports ?? [])
      .map((port) => `${port.direction} ${port.name}=${port.network ?? port.net} (${port.signal_type})`)
      .join('; ');
    const parameters = Object.entries(module.parameters ?? {})
      .map(([key, value]) => `${key}: ${value}`)
      .join('; ');
    return [
      `- ${module.id} (${module.kind}): ${module.name}`,
      module.function ? `  Function: ${module.function}` : '',
      parameters ? `  Parameters: ${parameters}` : '',
      ports ? `  Ports: ${ports}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n');
}

function buildTemplateGuide(input: {
  memoryId: string;
  project: {
    project_id: string;
    name: string;
    revision: number;
    modules?: unknown[];
    connections?: unknown[];
  };
  hasSystemNetlist: boolean;
  hasReport: boolean;
}): string {
  return [
    `# Saved Design Template: ${input.project.name}`,
    '',
    `Template id: ${input.memoryId}`,
    `Source project: ${input.project.project_id}`,
    `Source revision: ${input.project.revision}`,
    '',
    '## How To Reuse',
    '',
    '- Prefer this template when the requested circuit matches the topology, module partitioning, or sizing strategy below.',
    '- Start from `template.cir` when present; otherwise inspect `project.circuit.json` and `modules/`.',
    '- Preserve the module boundary and port naming pattern unless the new requirement clearly needs a different architecture.',
    '- Treat `modules/<id>/schematic.overrides.json` as layout memory only; do not infer electrical connectivity from it.',
    '',
    '## Files',
    '',
    '- `template.json`: structured metadata for agents.',
    '- `template.cir`: reusable flat SPICE starter netlist when the source project had a compiled system netlist.',
    '- `project.circuit.json`: saved module canvas and system connectivity.',
    '- `modules/`: module JSON, notebooks, and schematic layout overrides.',
    input.hasReport ? '- `source-report.md`: generated report from the source project.' : '',
    '',
    '## Module Summary',
    '',
    renderModuleSummary(input.project as Parameters<typeof renderModuleSummary>[0]) || '- No modules recorded.',
    '',
    '## Reuse Notes',
    '',
    `- Module count: ${input.project.modules?.length ?? 0}`,
    `- Connection count: ${input.project.connections?.length ?? 0}`,
    `- System netlist saved: ${input.hasSystemNetlist ? 'yes' : 'no'}`,
    `- Source report saved: ${input.hasReport ? 'yes' : 'no'}`,
    '',
  ].filter((line) => line !== '').join('\n');
}

async function readAppliedCommands(projectRoot: string): Promise<Array<{
  file: string;
  command_id?: string;
  message?: string;
  operations?: Array<{ op?: string; module_id?: string }>;
}>> {
  const commandsRoot = path.resolve(projectRoot, 'commands', 'applied');
  if (!(await exists(commandsRoot))) return [];
  const entries = (await readdir(commandsRoot)).filter((entry) => entry.endsWith('.json')).sort();
  const commands = [];
  for (const entry of entries) {
    try {
      const command = await readJsonFile<{
        command_id?: string;
        message?: string;
        operations?: Array<{ op?: string; module_id?: string }>;
      }>(path.resolve(commandsRoot, entry));
      commands.push({ file: entry, ...command });
    } catch {
      // Ignore partially written command records.
    }
  }
  return commands;
}

function buildFlowMarkdown(input: {
  memoryId: string;
  project: {
    project_id: string;
    name: string;
    revision: number;
    modules?: unknown[];
    connections?: unknown[];
  };
  commands: Awaited<ReturnType<typeof readAppliedCommands>>;
}): string {
  const commandLines = input.commands.length > 0
    ? input.commands.map((command, index) => {
        const ops = (command.operations ?? [])
          .map((operation) => operation.module_id ? `${operation.op}:${operation.module_id}` : operation.op)
          .filter(Boolean)
          .join(', ');
        return [
          `${index + 1}. ${command.command_id ?? command.file}`,
          command.message ? `   Intent: ${command.message}` : '',
          ops ? `   Operations: ${ops}` : '',
        ].filter(Boolean).join('\n');
      }).join('\n')
    : '1. No applied GUI command log was recorded for this project.';
  return [
    `# Saved Design Flow: ${input.project.name}`,
    '',
    `Flow id: ${input.memoryId}`,
    `Source project: ${input.project.project_id}`,
    `Source revision: ${input.project.revision}`,
    '',
    '## When To Reuse',
    '',
    '- Use this flow as a process reference for similar circuit families, module partitioning, naming conventions, and verification order.',
    '- Re-run validation and simulation for new requirements; this flow is guidance, not a proof of correctness for a new design.',
    '',
    '## Source Architecture',
    '',
    renderModuleSummary(input.project as Parameters<typeof renderModuleSummary>[0]) || '- No modules recorded.',
    '',
    '## Applied Command Flow',
    '',
    commandLines,
    '',
    '## Agent Checklist',
    '',
    '- Start from the closest saved template or bundled starter netlist.',
    '- Preserve useful module and net naming from this flow when it improves readability.',
    '- Compile modules after netlist changes, then inspect schematic geometry before accepting the design.',
    '- Save any new reusable topology back into design memory after verification.',
    '',
  ].join('\n');
}

async function saveDesignTemplate(projectId: string): Promise<SavedDesignMemorySummary> {
  const projectRoot = await resolveProjectRoot(projectId);
  const project = await readJsonFile<{
    project_id: string;
    name: string;
    revision: number;
    modules?: unknown[];
    connections?: unknown[];
  }>(path.resolve(projectRoot, 'project.circuit.json'));
  const { workspaceReferencesDir, targetRoot, memoryId } = await designMemoryTargetRoot('templates', project);
  const agentContext = await runProjectTool(['agent-context', '--project-root', projectRoot]);
  const erc = agentContext.erc as {
    status?: string;
    summary?: { errors?: number; warnings?: number };
    document_hash?: string;
  } | undefined;
  const simulation = agentContext.simulation as {
    state?: string;
    run?: {
      ok?: boolean;
      specification_status?: string;
      analyses?: Array<{ type?: string; status?: string }>;
    } | null;
  } | undefined;
  const circuitFamilies = [...new Set((project.modules as Array<{ kind?: string }> | undefined ?? [])
    .map((module) => module.kind)
    .filter((kind): kind is string => Boolean(kind)))];
  const simulationCoverage = [...new Set((simulation?.run?.analyses ?? [])
    .filter((analysis) => analysis.status === 'completed')
    .map((analysis) => analysis.type)
    .filter((type): type is string => Boolean(type)))];
  const specificationPassed = ['pass', 'passed'].includes(simulation?.run?.specification_status ?? '');
  const simulationPassed = simulation?.state === 'current' && simulation.run?.ok === true;
  const ercClean = (erc?.summary?.errors ?? 0) === 0;
  const validationStatus = specificationPassed && simulationPassed && ercClean
    ? 'verified'
    : simulationPassed && ercClean ? 'simulated' : ercClean ? 'erc_clean' : 'unverified';

  await copyFile(path.resolve(projectRoot, 'project.circuit.json'), path.resolve(targetRoot, 'project.circuit.json'));
  await copyDirectoryIfExists(path.resolve(projectRoot, 'modules'), path.resolve(targetRoot, 'modules'));
  await copyFileIfExists(path.resolve(projectRoot, 'build', 'build-manifest.json'), path.resolve(targetRoot, 'build-manifest.json'));
  await copyFileIfExists(path.resolve(projectRoot, 'build', 'erc.json'), path.resolve(targetRoot, 'erc.json'));
  await copyFileIfExists(
    path.resolve(projectRoot, 'build', 'system', 'simulation', 'result.json'),
    path.resolve(targetRoot, 'simulation-result.json'),
  );
  const hasSystemNetlist = await copyFileIfExists(
    path.resolve(projectRoot, 'build', 'system', 'design.final.cir'),
    path.resolve(targetRoot, 'template.cir'),
  );
  const hasReport = await copyFileIfExists(
    path.resolve(projectRoot, 'build', 'system', 'report.md'),
    path.resolve(targetRoot, 'source-report.md'),
  );

  const manifest = {
    schema: 'actoviq.design-template.v2',
    id: memoryId,
    name: project.name,
    source_project_id: project.project_id,
    source_revision: project.revision,
    source_document_hash: agentContext.document_hash,
    created_at: new Date().toISOString(),
    applicability: {
      circuit_families: circuitFamilies,
      parameter_summary: (project.modules as Array<{ id?: string; parameters?: Record<string, string> }> | undefined ?? [])
        .map((module) => ({ module_id: module.id, parameters: module.parameters ?? {} })),
    },
    validation: {
      status: validationStatus,
      preferred_for_agent_reuse: validationStatus === 'verified',
      erc_status: erc?.status ?? 'unknown',
      erc_summary: erc?.summary ?? null,
      simulation_state: simulation?.state ?? 'missing',
      simulation_coverage: simulationCoverage,
      specification_status: simulation?.run?.specification_status ?? 'not_evaluated',
    },
    files: {
      agent_guide: 'agent-guide.md',
      template_netlist: hasSystemNetlist ? 'template.cir' : null,
      project: 'project.circuit.json',
      modules: 'modules/',
      source_report: hasReport ? 'source-report.md' : null,
    },
  };
  await writeFile(path.resolve(targetRoot, 'template.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(
    path.resolve(targetRoot, 'agent-guide.md'),
    buildTemplateGuide({ memoryId, project, hasSystemNetlist, hasReport }),
    'utf8',
  );

  const relativePath = relativeReferencePath(workspaceReferencesDir, targetRoot);
  let layoutPack: Record<string, unknown> | null = null;
  try {
    layoutPack = await runProjectTool([
      'reference-pack-from-project',
      '--project-root', projectRoot,
      '--template-root', targetRoot,
      '--memory-id', memoryId,
      '--template-relative', relativePath.replace(/\\/g, '/'),
      '--trust', validationStatus,
    ]);
  } catch (error) {
    layoutPack = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    ok: true,
    id: memoryId,
    kind: 'template',
    name: project.name,
    rootPath: targetRoot,
    relativePath,
    guidePath: path.resolve(targetRoot, 'agent-guide.md'),
    templatePath: hasSystemNetlist ? path.resolve(targetRoot, 'template.cir') : undefined,
    hasLayoutReference: layoutPack?.ok === true,
    layoutPack,
  };
}

async function saveDesignFlow(projectId: string): Promise<SavedDesignMemorySummary> {
  const projectRoot = await resolveProjectRoot(projectId);
  const project = await readJsonFile<{
    project_id: string;
    name: string;
    revision: number;
    modules?: unknown[];
    connections?: unknown[];
  }>(path.resolve(projectRoot, 'project.circuit.json'));
  const commands = await readAppliedCommands(projectRoot);
  const { workspaceReferencesDir, targetRoot, memoryId } = await designMemoryTargetRoot('flows', project);
  const agentContext = await runProjectTool(['agent-context', '--project-root', projectRoot]);
  const erc = agentContext.erc as { status?: string; summary?: { errors?: number; warnings?: number } } | undefined;
  const simulation = agentContext.simulation as {
    state?: string;
    run?: { ok?: boolean; specification_status?: string; analyses?: Array<{ type?: string; status?: string }> } | null;
  } | undefined;
  const simulationCoverage = [...new Set((simulation?.run?.analyses ?? [])
    .filter((analysis) => analysis.status === 'completed')
    .map((analysis) => analysis.type)
    .filter((type): type is string => Boolean(type)))];
  const specificationPassed = ['pass', 'passed'].includes(simulation?.run?.specification_status ?? '');
  const simulationPassed = simulation?.state === 'current' && simulation.run?.ok === true;
  const ercClean = (erc?.summary?.errors ?? 0) === 0;
  const validationStatus = specificationPassed && simulationPassed && ercClean
    ? 'verified'
    : simulationPassed && ercClean ? 'simulated' : ercClean ? 'erc_clean' : 'unverified';

  await copyDirectoryIfExists(path.resolve(projectRoot, 'commands', 'applied'), path.resolve(targetRoot, 'commands', 'applied'));
  await copyFileIfExists(path.resolve(projectRoot, 'build', 'build-manifest.json'), path.resolve(targetRoot, 'build-manifest.json'));
  await copyFileIfExists(path.resolve(projectRoot, 'build', 'erc.json'), path.resolve(targetRoot, 'erc.json'));
  await copyFileIfExists(
    path.resolve(projectRoot, 'build', 'system', 'simulation', 'result.json'),
    path.resolve(targetRoot, 'simulation-result.json'),
  );
  const flowPath = path.resolve(targetRoot, 'design-flow.md');
  const manifest = {
    schema: 'actoviq.design-flow.v2',
    id: memoryId,
    name: project.name,
    source_project_id: project.project_id,
    source_revision: project.revision,
    source_document_hash: agentContext.document_hash,
    created_at: new Date().toISOString(),
    command_count: commands.length,
    applicability: {
      circuit_families: [...new Set((project.modules as Array<{ kind?: string }> | undefined ?? [])
        .map((module) => module.kind)
        .filter((kind): kind is string => Boolean(kind)))],
    },
    validation: {
      status: validationStatus,
      preferred_for_agent_reuse: validationStatus === 'verified',
      erc_status: erc?.status ?? 'unknown',
      erc_summary: erc?.summary ?? null,
      simulation_state: simulation?.state ?? 'missing',
      simulation_coverage: simulationCoverage,
      specification_status: simulation?.run?.specification_status ?? 'not_evaluated',
    },
    files: {
      design_flow: 'design-flow.md',
      applied_commands: 'commands/applied/',
    },
  };
  await writeFile(path.resolve(targetRoot, 'flow.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(flowPath, buildFlowMarkdown({ memoryId, project, commands }), 'utf8');

  return {
    ok: true,
    id: memoryId,
    kind: 'flow',
    name: project.name,
    rootPath: targetRoot,
    relativePath: relativeReferencePath(workspaceReferencesDir, targetRoot),
    flowPath,
  };
}

async function listDesignMemoryKind(
  referencesDir: string,
  directoryName: 'templates' | 'flows',
  kind: 'template' | 'flow',
): Promise<DesignMemoryItem[]> {
  const root = path.resolve(referencesDir, 'design-memory', directoryName);
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const items: DesignMemoryItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const targetRoot = path.resolve(root, entry.name);
    const relative = path.relative(root, targetRoot);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const manifestPath = path.resolve(targetRoot, kind === 'template' ? 'template.json' : 'flow.json');
    try {
      const manifest = await readJsonFile<{
        id?: string;
        name?: string;
        source_project_id?: string;
        source_revision?: number;
        source_document_hash?: string;
        created_at?: string;
        files?: Record<string, string | null>;
        applicability?: { circuit_families?: string[] };
        validation?: {
          status?: string;
          preferred_for_agent_reuse?: boolean;
          simulation_coverage?: string[];
        };
      }>(manifestPath);
      const fallbackStat = await stat(targetRoot);
      const files = manifest.files ?? {};
      const agentGuide = files.agent_guide;
      const templateNetlist = files.template_netlist;
      const designFlow = files.design_flow;
      items.push({
        id: manifest.id || entry.name,
        kind,
        name: manifest.name || entry.name,
        rootPath: targetRoot,
        relativePath: relativeReferencePath(referencesDir, targetRoot),
        sourceProjectId: manifest.source_project_id,
        sourceRevision: manifest.source_revision,
        sourceDocumentHash: manifest.source_document_hash,
        createdAt: manifest.created_at || fallbackStat.mtime.toISOString(),
        circuitFamilies: manifest.applicability?.circuit_families ?? [],
        validationStatus: manifest.validation?.status ?? 'legacy_unverified',
        preferredForAgentReuse: manifest.validation?.preferred_for_agent_reuse ?? false,
        simulationCoverage: manifest.validation?.simulation_coverage ?? [],
        guidePath: typeof agentGuide === 'string' ? path.resolve(targetRoot, agentGuide) : undefined,
        templatePath: typeof templateNetlist === 'string' ? path.resolve(targetRoot, templateNetlist) : undefined,
        flowPath: typeof designFlow === 'string' ? path.resolve(targetRoot, designFlow) : undefined,
      });
    } catch {
      // Ignore incomplete or hand-edited design memory folders.
    }
  }
  return items.sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')));
}

async function listDesignMemory(): Promise<{ templates: DesignMemoryItem[]; flows: DesignMemoryItem[] }> {
  const workspace = await getActiveWorkspace();
  const [templates, flows] = await Promise.all([
    listDesignMemoryKind(workspace.referencesDir, 'templates', 'template'),
    listDesignMemoryKind(workspace.referencesDir, 'flows', 'flow'),
  ]);
  return { templates, flows };
}

async function findDesignMemoryItem(kind: 'template' | 'flow', id: string): Promise<DesignMemoryItem> {
  const memory = await listDesignMemory();
  const items = kind === 'template' ? memory.templates : memory.flows;
  const item = items.find((entry) => entry.id === id);
  if (!item) {
    throw new Error(`Saved ${kind} not found: ${id}`);
  }
  return item;
}

async function createProjectFromTemplate(input: {
  templateId: string;
  name?: string;
}): Promise<Record<string, unknown>> {
  const template = await findDesignMemoryItem('template', String(input.templateId ?? '').trim());
  const sourceProjectPath = path.resolve(template.rootPath, 'project.circuit.json');
  if (!(await exists(sourceProjectPath))) {
    throw new Error(`Saved template has no project.circuit.json: ${template.id}`);
  }

  const sourceProject = await readJsonFile<{
    schema: string;
    project_id: string;
    name: string;
    revision: number;
    modules?: Array<{ id?: string; source?: string }>;
    connections?: unknown[];
    analyses?: unknown;
  }>(sourceProjectPath);
  const name = input.name?.trim() || `${sourceProject.name || template.name} copy`;
  const root = await projectsRoot();
  const { projectId, projectRoot } = await uniqueProjectRoot(root, name);
  await mkdir(projectRoot, { recursive: false });
  await mkdir(path.resolve(projectRoot, 'modules'), { recursive: true });
  await Promise.all(
    ['commands/pending', 'commands/applied', 'commands/rejected', 'revisions', 'build', 'logs']
      .map((directory) => mkdir(path.resolve(projectRoot, directory), { recursive: true })),
  );
  await copyDirectoryIfExists(path.resolve(template.rootPath, 'modules'), path.resolve(projectRoot, 'modules'));

  const now = new Date().toISOString();
  const project = {
    ...sourceProject,
    project_id: projectId,
    name,
    revision: 0,
    created_at: now,
    updated_at: now,
  };
  await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(projectRoot, 'project.settings.json'), `${JSON.stringify({
    schema: 'actoviq.project-settings.v1',
    imported_from_template: template.id,
    imported_at: now,
  }, null, 2)}\n`, 'utf8');

  for (const moduleRef of project.modules ?? []) {
    const moduleId = moduleRef.id;
    if (!moduleId) continue;
    const moduleRoot = path.resolve(projectRoot, 'modules', moduleId);
    const modulePath = path.resolve(moduleRoot, 'module.circuit.json');
    if (await exists(modulePath)) {
      try {
        const module = await readJsonFile<Record<string, unknown>>(modulePath);
        module.revision = 0;
        await writeFile(modulePath, `${JSON.stringify(module, null, 2)}\n`, 'utf8');
      } catch {
        // The project summary step below will surface invalid module files.
      }
    }
    const overridesPath = path.resolve(moduleRoot, 'schematic.overrides.json');
    if (await exists(overridesPath)) {
      try {
        const overrides = await readJsonFile<Record<string, unknown>>(overridesPath);
        overrides.project_id = projectId;
        overrides.module_id = moduleId;
        overrides.updated_at = now;
        await writeFile(overridesPath, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
      } catch {
        // Invalid overrides are non-fatal; rendering can regenerate them later.
      }
    }
  }

  const bundle = await runProjectTool(['summary', '--project-root', projectRoot]);
  return enrichProjectBundle(projectRoot, bundle);
}

const EDA_BRIDGE_PEER_KINDS = new Set(['kicad', 'jlceda']);
const PROJECT_KINDS = new Set(['simulation', 'pcb_schematic', 'analog_ic', 'mixed_signal_ic']);

async function appendLcscCliArgs(args: string[]): Promise<string[]> {
  const settings = await loadSettingsWithSecrets();
  const next = [...args];
  if (settings.lcscUseFallback) next.push('--use-fallback');
  return next;
}

function assertEdaBridgePeerKind(peerKind: string): 'kicad' | 'jlceda' {
  if (!EDA_BRIDGE_PEER_KINDS.has(peerKind)) {
    throw new Error(`Unsupported EDA bridge peer kind: ${peerKind}`);
  }
  return peerKind as 'kicad' | 'jlceda';
}

function assertProjectKind(projectKind: string | undefined): string | undefined {
  const normalized = typeof projectKind === 'string' ? projectKind.trim() : '';
  if (!normalized) return undefined;
  if (!PROJECT_KINDS.has(normalized)) {
    throw new Error(`Unsupported project kind: ${normalized}`);
  }
  return normalized;
}

function layoutReviewCliArgs(): string[] {
  const appRoot = app.getAppPath();
  const compiled = path.resolve(appRoot, 'dist', 'cli', 'reviewSchematicLayout.js');
  if (existsSync(compiled)) return [compiled];

  const tsxCli = path.resolve(appRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const source = path.resolve(appRoot, 'src', 'cli', 'reviewSchematicLayout.ts');
  if (existsSync(tsxCli) && existsSync(source)) return [tsxCli, source];
  throw new Error('The isolated vision layout reviewer is missing from the application bundle.');
}

function runLayoutVisionReview(
  request: LayoutVisionReviewRequest,
  apiKey: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, layoutReviewCliArgs(), {
      cwd: app.getAppPath(),
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ACTOVIQ_API_KEY: apiKey,
        ACTOVIQ_AUTH_TOKEN: apiKey,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      const raw = error instanceof Error ? error.message : String(error);
      reject(new Error(apiKey ? raw.split(apiKey).join('[redacted]') : raw));
    };
    const timeout = setTimeout(() => {
      child.kill();
      finishReject(new Error('Vision layout review timed out.'));
    }, 300_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      finishReject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(stdout.trim()) as Record<string, unknown>;
      } catch {
        finishReject(new Error(stderr.trim() || stdout.trim() || `Vision layout reviewer exited with ${code}`));
        return;
      }
      if (code !== 0 || result.schema !== 'actoviq.layout-patch-set.v1') {
        finishReject(new Error(String(result.error ?? stderr.trim() ?? `Vision layout reviewer exited with ${code}`)));
        return;
      }
      settled = true;
      resolve(result);
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function requiredResultString(result: Record<string, unknown>, key: string): string {
  const value = result[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Layout optimizer returned an invalid ${key}.`);
  }
  return value;
}

function layoutQualitySummary(result: Record<string, unknown>): {
  readability_score: number;
  lexicographic_cost: number[];
} {
  const nested = result.layout_quality;
  const quality = nested && typeof nested === 'object'
    ? nested as Record<string, unknown>
    : result;
  const readability = Number(quality.readability_score ?? result.readability_score);
  const cost = quality.lexicographic_cost ?? result.lexicographic_cost;
  if (!Number.isFinite(readability) || !Array.isArray(cost) || cost.some((value) => !Number.isFinite(Number(value)))) {
    throw new Error('Layout optimizer returned an invalid quality report.');
  }
  return {
    readability_score: readability,
    lexicographic_cost: cost.map((value) => Number(value)),
  };
}

function sourceLayoutQualitySummary(result: Record<string, unknown>): {
  readability_score: number;
  lexicographic_cost: number[];
} {
  const readability = Number(result.before_readability_score);
  const cost = result.before_lexicographic_cost;
  if (Number.isFinite(readability)
    && Array.isArray(cost)
    && cost.every((value) => Number.isFinite(Number(value)))) {
    return {
      readability_score: readability,
      lexicographic_cost: cost.map((value) => Number(value)),
    };
  }
  return layoutQualitySummary(result);
}

function requiresVisionLayoutReview(quality: {
  readability_score: number;
  lexicographic_cost: number[];
}): boolean {
  const issueDimensions = [0, 1, 2, 3, 4, 6];
  return quality.readability_score < 90
    || issueDimensions.some((index) => Number(quality.lexicographic_cost[index] ?? 0) > 0);
}

function layoutModuleOperation(moduleId: string, result: Record<string, unknown>): Record<string, unknown> {
  const schematic = result.module_schematic;
  if (!schematic || typeof schematic !== 'object') {
    throw new Error('Layout optimizer did not return a module_schematic winner.');
  }
  const value = schematic as Record<string, unknown>;
  for (const key of ['components', 'ports', 'wires', 'nets'] as const) {
    if (!Array.isArray(value[key])) throw new Error(`Layout optimizer returned invalid module_schematic.${key}.`);
  }
  if (value.annotations !== undefined && !Array.isArray(value.annotations)) {
    throw new Error('Layout optimizer returned invalid module_schematic.annotations.');
  }
  return {
    op: 'set_module_schematic',
    module_id: moduleId,
    expected_connectivity_hash: requiredResultString(result, 'connectivity_hash'),
    connectivity_view: 'design',
    components: value.components,
    ports: value.ports,
    wires: value.wires,
    nets: value.nets,
    annotations: value.annotations ?? [],
  };
}

async function rasterizeLayoutPreview(svgPath: string, pngPath: string): Promise<void> {
  const direct = nativeImage.createFromPath(svgPath);
  if (!direct.isEmpty()) {
    await writeFile(pngPath, direct.toPNG());
    return;
  }
  const svg = await readFile(svgPath, 'utf8');
  if (!/<svg\b/i.test(svg)) throw new Error('Layout preview does not contain an SVG document.');
  const window = new BrowserWindow({
    show: false,
    width: 2400,
    height: 1800,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });
  try {
    await window.loadURL(`data:text/html;base64,${Buffer.from(
      `<style>html,body{margin:0;background:#fff}svg{display:block;max-width:2400px;max-height:1800px}</style>${svg}`,
    ).toString('base64')}`);
    const bounds = await window.webContents.executeJavaScript(`(() => {
      const svg = document.querySelector('svg');
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
    })()` ) as { width?: number; height?: number } | null;
    const width = Math.min(2400, Math.max(1, Number(bounds?.width ?? 0)));
    const height = Math.min(1800, Math.max(1, Number(bounds?.height ?? 0)));
    if (!bounds?.width || !bounds.height) throw new Error('Layout preview has no visible SVG bounds.');
    window.setContentSize(width, height);
    const image = await window.webContents.capturePage({ x: 0, y: 0, width, height });
    await writeFile(pngPath, image.toPNG());
  } finally {
    window.destroy();
  }
}

async function optimizeModuleLayout(
  projectId: string,
  input: LayoutOptimizationRequest,
): Promise<Record<string, unknown>> {
  assertModuleId(input.moduleId);
  if (!Number.isInteger(input.sourceRevision) || input.sourceRevision < 0) {
    throw new Error(`Invalid source revision: ${input.sourceRevision}`);
  }
  const projectRoot = await resolveProjectRoot(projectId);
  const project = await readJsonFile<Record<string, unknown>>(path.resolve(projectRoot, 'project.circuit.json'));
  const currentRevision = Number(project.revision);
  if (currentRevision !== input.sourceRevision) {
    throw new Error(`Stale layout request: expected project revision ${currentRevision}, received ${input.sourceRevision}.`);
  }

  const runId = `${input.moduleId}-r${input.sourceRevision}-${Date.now().toString(36)}`;
  const outputRoot = path.resolve(projectRoot, 'build', 'layout-reviews', runId);
  const sessionDirectory = path.resolve(app.getPath('userData'), 'layout-vision-sessions');
  await Promise.all([mkdir(outputRoot, { recursive: true }), mkdir(sessionDirectory, { recursive: true })]);

  let current = await runProjectTool([
    'prepare-layout-review',
    '--project-root', projectRoot,
    '--module-id', input.moduleId,
    '--source-revision', String(input.sourceRevision),
    '--view', 'design',
    '--output-dir', outputRoot,
  ]);
  const initialQuality = sourceLayoutQualitySummary(current);
  const connectivityHash = requiredResultString(current, 'connectivity_hash');
  const rounds: Array<Record<string, unknown>> = [];
  let llmInvoked = false;
  let visionSettings: Awaited<ReturnType<typeof loadSettingsWithSecrets>> | null = null;
  let changed = current.changed === true;
  let stoppedReason: 'score_threshold' | 'no_improvement' | 'round_limit' | 'deterministic_only' = 'deterministic_only';

  while (requiresVisionLayoutReview(layoutQualitySummary(current)) && rounds.length < 3) {
    if (!visionSettings) {
      visionSettings = await loadSettingsWithSecrets();
      const expectedFingerprint = layoutVisionModelFingerprint(
        visionSettings.actoviqProvider,
        visionSettings.actoviqBaseUrl,
        visionSettings.layoutVisionModel,
      );
      if (!visionSettings.layoutVisionModel.trim()
        || visionSettings.layoutVisionVerification.status !== 'verified'
        || visionSettings.layoutVisionVerification.fingerprint !== expectedFingerprint) {
        throw new Error('Deterministic layout still has unresolved quality issues. Configure and verify a multimodal layout model in Settings to continue.');
      }
      if (!visionSettings.actoviqAuthToken) {
        throw new Error('The verified layout model API key is unavailable. Re-enter it in Settings.');
      }
    }
    llmInvoked = true;
    const before = layoutQualitySummary(current);
    const svgPath = requiredResultString(current, 'svg_path');
    const imagePath = path.resolve(outputRoot, `vision-round-${rounds.length + 1}.png`);
    await rasterizeLayoutPreview(svgPath, imagePath);
    const patchSet = await runLayoutVisionReview({
      provider: visionSettings.actoviqProvider,
      model: visionSettings.layoutVisionModel,
      base_url: visionSettings.actoviqBaseUrl,
      work_dir: projectRoot,
      session_directory: sessionDirectory,
      svg_path: svgPath,
      image_path: imagePath,
      layout_quality_report_path: requiredResultString(current, 'layout_quality_report_path'),
      module_id: input.moduleId,
      source_revision: input.sourceRevision,
      connectivity_hash: connectivityHash,
    }, visionSettings.actoviqAuthToken);
    const evaluated = await runProjectTool([
      'evaluate-layout-patches',
      '--project-root', projectRoot,
      '--module-id', input.moduleId,
      '--source-revision', String(input.sourceRevision),
      '--state-path', requiredResultString(current, 'state_path'),
      '--patch-set-json', JSON.stringify(patchSet),
      '--output-dir', outputRoot,
      '--view', 'design',
    ]);
    if (requiredResultString(evaluated, 'connectivity_hash') !== connectivityHash) {
      throw new Error('Layout optimizer changed the authoritative connectivity hash.');
    }
    const after = layoutQualitySummary(evaluated);
    const improved = evaluated.improved === true;
    rounds.push({
      round: rounds.length + 1,
      improved,
      before_score: before.readability_score,
      after_score: after.readability_score,
      preview_path: evaluated.svg_path,
      report_path: evaluated.layout_quality_report_path,
    });
    if (!improved) {
      stoppedReason = 'no_improvement';
      break;
    }
    changed = true;
    current = evaluated;
    if (!requiresVisionLayoutReview(after)) {
      stoppedReason = 'score_threshold';
      break;
    }
    stoppedReason = rounds.length >= 3 ? 'round_limit' : 'no_improvement';
  }

  let revision = input.sourceRevision;
  let compileWarning = '';
  if (changed) {
    const operation = layoutModuleOperation(input.moduleId, current);
    const command = {
      schema: 'actoviq.command.v1',
      command_id: `layout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      actor: 'agent',
      project_id: String(project.project_id ?? projectId),
      base_revision: input.sourceRevision,
      message: llmInvoked
        ? `Optimize ${input.moduleId} schematic with verified multimodal layout review`
        : `Optimize ${input.moduleId} schematic with deterministic layout scoring`,
      operations: [operation],
    };
    const applied = await runProjectTool([
      'apply',
      '--project-root', projectRoot,
      '--command-json', JSON.stringify(command),
    ]);
    revision = Number(applied.revision);
    if (!Number.isInteger(revision)) throw new Error('Layout transaction returned an invalid revision.');
    try {
      await runProjectTool(['compile-module', '--project-root', projectRoot, '--module-id', input.moduleId]);
    } catch (error) {
      compileWarning = error instanceof Error ? error.message : String(error);
    }
  }

  const finalQuality = layoutQualitySummary(current);
  const visibleQualityValue = current.visible_layout_quality;
  const visibleQuality = visibleQualityValue && typeof visibleQualityValue === 'object'
    ? layoutQualitySummary({ layout_quality: visibleQualityValue })
    : finalQuality;
  const visibleConnectivityHash = typeof current.visible_connectivity_hash === 'string'
    ? current.visible_connectivity_hash
    : connectivityHash;
  return {
    ok: true,
    module_id: input.moduleId,
    source_revision: input.sourceRevision,
    revision,
    changed,
    model: llmInvoked && visionSettings ? visionSettings.layoutVisionModel : 'deterministic',
    llm_invoked: llmInvoked,
    connectivity_hash: connectivityHash,
    initial_quality: initialQuality,
    final_quality: finalQuality,
    visible_quality: visibleQuality,
    visible_quality_unresolved: requiresVisionLayoutReview(visibleQuality),
    visible_connectivity_hash: visibleConnectivityHash,
    rounds,
    stopped_reason: stoppedReason,
    preview_path: current.svg_path,
    report_path: current.layout_quality_report_path,
    ...(compileWarning ? { compile_warning: compileWarning } : {}),
  };
}

async function readOptionalJson(targetPath: string): Promise<Record<string, unknown> | null> {
  if (!(await exists(targetPath))) return null;
  try {
    return JSON.parse(await readFile(targetPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readOptionalText(targetPath: string): Promise<string> {
  return await exists(targetPath) ? readFile(targetPath, 'utf8') : '';
}

export async function generateProjectTechnicalReport(projectId: string, sourceRevision: number): Promise<{
  ok: true;
  report: string;
  metadata: Record<string, unknown>;
}> {
  const projectRoot = await resolveProjectRoot(projectId);
  const project = await readJsonFile<Record<string, unknown>>(path.resolve(projectRoot, 'project.circuit.json'));
  const currentRevision = Number(project.revision);
  if (!Number.isInteger(sourceRevision) || sourceRevision < 0 || currentRevision !== sourceRevision) {
    throw new Error(`Stale report request: expected project revision ${currentRevision}, received ${sourceRevision}.`);
  }

  const buildRoot = path.resolve(projectRoot, 'build');
  const manifest = await readOptionalJson(path.resolve(buildRoot, 'build-manifest.json'));
  if (!manifest) throw new Error('Compile the project before generating a technical report.');
  const buildRevision = Number(manifest.source_revision ?? manifest.revision);
  if (buildRevision !== currentRevision) {
    throw new Error(`Build is stale: project revision ${currentRevision}, build revision ${buildRevision}.`);
  }

  const [agentContext, erc, simulation, sourceMap, netlist, baselineReport] = await Promise.all([
    runProjectTool(['agent-context', '--project-root', projectRoot]),
    readOptionalJson(path.resolve(buildRoot, 'erc.json')),
    readOptionalJson(path.resolve(buildRoot, 'system', 'simulation', 'result.json')),
    readOptionalJson(path.resolve(buildRoot, 'system', 'source-map.json')),
    readOptionalText(path.resolve(buildRoot, 'system', 'design.final.cir')),
    readOptionalText(path.resolve(buildRoot, 'system', 'report.md')),
  ]);
  const documentHash = typeof agentContext.document_hash === 'string'
    ? agentContext.document_hash
    : typeof manifest.document_hash === 'string' ? manifest.document_hash : undefined;
  const settings = await loadSettingsWithSecrets();
  if (!settings.actoviqAuthToken) {
    throw new Error('Configure an API key before generating an AI technical report.');
  }

  const generated = await generateDesktopTechnicalReport({
    provider: settings.actoviqProvider,
    apiKey: settings.actoviqAuthToken,
    baseURL: settings.actoviqBaseUrl,
    model: settings.reasoningModel || settings.chatModel,
    workDir: projectRoot,
  }, {
    projectId,
    sourceRevision,
    documentHash,
    evidence: {
      project,
      build_manifest: manifest,
      agent_context: agentContext,
      erc,
      simulation,
      source_map: sourceMap,
      compiled_netlist: netlist,
      deterministic_report: baselineReport,
    },
  });
  const reportPath = path.resolve(buildRoot, 'system', 'technical-report.md');
  const metadataPath = path.resolve(buildRoot, 'system', 'technical-report.json');
  const metadata = {
    schema: 'actoviq.technical-report.v1',
    project_id: projectId,
    source_revision: sourceRevision,
    document_hash: documentHash,
    generated_at: new Date().toISOString(),
    generator: 'actoviq-agent-sdk',
    model: generated.model,
    run_id: generated.runId,
    report_sha256: createHash('sha256').update(generated.report).digest('hex'),
    usage: generated.usage,
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${generated.report.trim()}\n`, 'utf8');
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return { ok: true, report: generated.report, metadata };
}

async function readProjectSummary(projectRoot: string): Promise<ProjectSummary> {
  const project = JSON.parse(
    await readFile(path.resolve(projectRoot, 'project.circuit.json'), 'utf8'),
  ) as {
    project_id: string;
    name: string;
    revision: number;
    updated_at?: string;
    modules?: unknown[];
  };
  return {
    projectId: project.project_id,
    name: project.name,
    revision: project.revision,
    updatedAt: project.updated_at ?? '',
    projectRoot,
    moduleCount: project.modules?.length ?? 0,
  };
}

async function uniqueTrashTarget(root: string, projectId: string): Promise<{ trashId: string; trashPath: string }> {
  const base = `${timestampForId()}-${projectId}`;
  let trashId = base;
  let suffix = 2;
  while (await exists(path.resolve(root, trashId))) {
    trashId = `${base}-${suffix}`;
    suffix += 1;
  }
  const trashPath = path.resolve(root, trashId);
  assertDirectChild(root, trashPath, trashId);
  return { trashId, trashPath };
}

async function moveProjectToTrash(projectId: string): Promise<TrashProjectSummary> {
  const projectRoot = await resolveProjectRoot(projectId);
  const summary = await readProjectSummary(projectRoot);
  const root = await trashProjectsRoot();
  const { trashId, trashPath } = await uniqueTrashTarget(root, projectId);
  const deletedAt = new Date().toISOString();
  stopProjectWatcher(projectId);
  await rename(projectRoot, trashPath);
  const item: TrashProjectSummary = {
    ...summary,
    projectRoot: trashPath,
    trashId,
    deletedAt,
    originalPath: projectRoot,
    trashPath,
  };
  try {
    await writeFile(path.resolve(trashPath, 'trash.json'), `${JSON.stringify(item, null, 2)}\n`, 'utf8');
  } catch (error) {
    await rename(trashPath, projectRoot).catch(() => undefined);
    throw error;
  }
  return item;
}

async function archiveLegacyPlaywrightProjects(): Promise<void> {
  const root = await projectsRoot();
  const existing = legacyArchivePromises.get(root);
  if (existing) return existing;
  const migration = (async () => {
    const trashRoot = await trashProjectsRoot();
    const markerPath = path.resolve(trashRoot, '..', 'legacy-playwright-projects-v1.json');
    if (await exists(markerPath)) return;
    const archived: string[] = [];
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectRoot = path.resolve(root, entry.name);
      try {
        const summary = await readProjectSummary(projectRoot);
        if (!/^Playwright Keyboard Project \d+$/.test(summary.name)) continue;
        await moveProjectToTrash(summary.projectId);
        archived.push(summary.projectId);
      } catch {
        // Ignore invalid projects and continue migrating exact test fixtures.
      }
    }
    await writeFile(markerPath, `${JSON.stringify({ migratedAt: new Date().toISOString(), archived }, null, 2)}\n`, 'utf8');
  })();
  legacyArchivePromises.set(root, migration);
  return migration;
}

async function listTrashProjects(): Promise<TrashProjectSummary[]> {
  const root = await trashProjectsRoot();
  const entries = await readdir(root, { withFileTypes: true });
  const items: TrashProjectSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const trashPath = path.resolve(root, entry.name);
    try {
      const metadataPath = path.resolve(trashPath, 'trash.json');
      const metadata = await exists(metadataPath)
        ? await readJsonFile<TrashProjectSummary>(metadataPath)
        : null;
      const summary = await readProjectSummary(trashPath);
      items.push({
        ...summary,
        trashId: entry.name,
        deletedAt: metadata?.deletedAt ?? summary.updatedAt,
        originalPath: metadata?.originalPath ?? path.resolve(await projectsRoot(), summary.projectId),
        trashPath,
      });
    } catch {
      // Ignore incomplete trash entries instead of exposing unsafe restore actions.
    }
  }
  return items.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
}

async function resolveTrashProject(trashId: string): Promise<string> {
  const root = await trashProjectsRoot();
  const candidate = path.resolve(root, String(trashId ?? '').trim());
  assertDirectChild(root, candidate, trashId);
  if (!(await exists(path.resolve(candidate, 'project.circuit.json')))) {
    throw new Error(`Trashed project not found: ${trashId}`);
  }
  return candidate;
}

async function restoreTrashProjects(trashIds: string[]): Promise<ProjectSummary[]> {
  const root = await projectsRoot();
  const restored: ProjectSummary[] = [];
  for (const trashId of [...new Set(trashIds)]) {
    const trashPath = await resolveTrashProject(trashId);
    const summary = await readProjectSummary(trashPath);
    const target = path.resolve(root, summary.projectId);
    assertDirectChild(root, target, summary.projectId);
    if (await exists(target)) {
      throw new Error(`Cannot restore ${summary.name}: project id ${summary.projectId} already exists.`);
    }
    await rename(trashPath, target);
    await rm(path.resolve(target, 'trash.json'), { force: true });
    restored.push(await readProjectSummary(target));
  }
  return restored;
}

async function purgeTrashProjects(trashIds: string[]): Promise<void> {
  for (const trashId of [...new Set(trashIds)]) {
    const trashPath = await resolveTrashProject(trashId);
    await rm(trashPath, { recursive: true, force: true });
  }
}

function spiceLines(markdown: string): string[] {
  const matches = [...markdown.matchAll(/```(?:spice|cir|netlist)\s*\r?\n([\s\S]*?)```/gi)];
  const source = matches.length > 0 ? matches.map((match) => match[1]).join('\n') : markdown;
  return source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function snapshotNetlistLines(snapshotRoot: string): Promise<string[]> {
  const projectPath = path.resolve(snapshotRoot, 'project.circuit.json');
  if (!(await exists(projectPath))) return [];
  const project = await readJsonFile<{ modules?: Array<{ id?: string }> }>(projectPath);
  const lines: string[] = [];
  for (const module of project.modules ?? []) {
    if (!module.id) continue;
    const notebookPath = path.resolve(snapshotRoot, 'modules', module.id, 'netlist-notebook.md');
    if (await exists(notebookPath)) lines.push(...spiceLines(await readFile(notebookPath, 'utf8')));
  }
  return lines;
}

function netlistDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const beforeCounts = new Map<string, number>();
  const afterCounts = new Map<string, number>();
  for (const line of before) beforeCounts.set(line, (beforeCounts.get(line) ?? 0) + 1);
  for (const line of after) afterCounts.set(line, (afterCounts.get(line) ?? 0) + 1);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [line, count] of afterCounts) {
    for (let index = beforeCounts.get(line) ?? 0; index < count && added.length < 40; index += 1) added.push(line);
  }
  for (const [line, count] of beforeCounts) {
    for (let index = afterCounts.get(line) ?? 0; index < count && removed.length < 40; index += 1) removed.push(line);
  }
  return { added, removed };
}

async function listProjectHistory(projectId: string): Promise<ProjectHistoryEntry[]> {
  const projectRoot = await resolveProjectRoot(projectId);
  const revisionsRoot = path.resolve(projectRoot, 'revisions');
  const entries = await readdir(revisionsRoot, { withFileTypes: true }).catch(() => []);
  let buildRevision: number | undefined;
  let buildStatus: string | undefined;
  try {
    const manifest = await readJsonFile<{ source_revision?: number; revision?: number; status?: string }>(
      path.resolve(projectRoot, 'build', 'build-manifest.json'),
    );
    buildRevision = manifest.source_revision ?? manifest.revision;
    buildStatus = manifest.status;
  } catch {
    // History remains available before the first build.
  }
  const history: ProjectHistoryEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{6}$/.test(entry.name)) continue;
    const revisionRoot = path.resolve(revisionsRoot, entry.name);
    try {
      const metadata = await readJsonFile<{
        revision: number;
        base_revision?: number;
        actor?: string;
        message?: string;
        created_at?: string;
        document_hash?: string;
      }>(path.resolve(revisionRoot, 'metadata.json'));
      const resultRoot = path.resolve(revisionRoot, 'result');
      const [before, after] = await Promise.all([
        snapshotNetlistLines(path.resolve(revisionRoot, 'snapshot')),
        snapshotNetlistLines(resultRoot),
      ]);
      history.push({
        revision: metadata.revision,
        baseRevision: metadata.base_revision ?? Math.max(0, metadata.revision - 1),
        actor: metadata.actor ?? 'unknown',
        message: metadata.message ?? '',
        createdAt: metadata.created_at ?? '',
        documentHash: metadata.document_hash,
        restorable: await exists(path.resolve(resultRoot, 'project.circuit.json')),
        buildStatus: buildRevision === metadata.revision ? buildStatus : undefined,
        netlistDiff: netlistDiff(before, after),
      });
    } catch {
      // Ignore incomplete revision folders while an external transaction is being written.
    }
  }
  return history.sort((left, right) => right.revision - left.revision);
}

async function readSimulationDataset(
  projectId: string,
  input: {
    runId: string;
    analysisId: string;
    moduleId?: string;
    maxPoints?: number;
    xMin?: number;
    xMax?: number;
  },
): Promise<Record<string, unknown>> {
  const projectRoot = await resolveProjectRoot(projectId);
  if (!/^[A-Za-z0-9_.:-]+$/.test(input.runId) || !/^[A-Za-z0-9_.:-]+$/.test(input.analysisId)) {
    throw new Error('Invalid simulation dataset identifier.');
  }
  const simulationRoot = input.moduleId
    ? path.resolve(projectRoot, 'build', 'modules', assertModuleId(input.moduleId), 'simulation')
    : path.resolve(projectRoot, 'build', 'system', 'simulation');
  const result = await readJsonFile<{
    run_id?: string;
    analyses?: Array<{ id?: string; dataset?: { path?: string } | null }>;
  }>(path.resolve(simulationRoot, 'result.json'));
  if (result.run_id !== input.runId) throw new Error(`Simulation run is stale or unavailable: ${input.runId}`);
  const analysis = result.analyses?.find((entry) => entry.id === input.analysisId);
  const relativeDatasetPath = analysis?.dataset?.path;
  if (!relativeDatasetPath) throw new Error(`Simulation analysis has no dataset: ${input.analysisId}`);
  const datasetPath = path.resolve(simulationRoot, relativeDatasetPath);
  const relative = path.relative(simulationRoot, datasetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Simulation dataset path escapes its run.');
  const dataset = await readJsonFile<{
    x?: { values?: number[] };
    traces?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  }>(datasetPath);
  const xValues = dataset.x?.values ?? [];
  let indices = xValues.map((_value, index) => index).filter((index) => (
    (input.xMin === undefined || xValues[index]! >= input.xMin) &&
    (input.xMax === undefined || xValues[index]! <= input.xMax)
  ));
  const maxPoints = Math.max(50, Math.min(5000, Math.floor(input.maxPoints ?? 1200)));
  if (indices.length > maxPoints) {
    const source = indices;
    indices = Array.from({ length: maxPoints }, (_value, index) => (
      source[Math.round(index * (source.length - 1) / (maxPoints - 1))]!
    ));
  }
  const selectValues = (value: unknown): unknown => (
    Array.isArray(value) && value.length === xValues.length
      ? indices.map((index) => value[index])
      : value
  );
  return {
    ...dataset,
    point_count: indices.length,
    total_point_count: xValues.length,
    x: dataset.x ? { ...dataset.x, values: indices.map((index) => xValues[index]) } : dataset.x,
    traces: (dataset.traces ?? []).map((trace) => Object.fromEntries(
      Object.entries(trace).map(([key, value]) => [key, selectValues(value)]),
    )),
  };
}

async function listProjects(): Promise<ProjectSummary[]> {
  await ensureProjectsDirectoryWatcher();
  await archiveLegacyPlaywrightProjects();
  const root = await projectsRoot();
  const entries = await readdir(root, { withFileTypes: true });
  const projects: ProjectSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectRoot = path.resolve(root, entry.name);
    try {
      projects.push(await readProjectSummary(projectRoot));
    } catch {
      // Ignore invalid or partially written project directories.
    }
  }
  return projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function enrichProjectBundle(
  projectRoot: string,
  bundle: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const project = bundle.project as {
    modules?: Array<{ id?: string; name?: string; function?: string }>;
  } | undefined;
  const manifestPath = path.resolve(projectRoot, 'build', 'build-manifest.json');
  let manifestModules: Record<string, { revision?: number }> = {};
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      modules?: Record<string, { revision?: number }>;
    };
    manifestModules = manifest.modules ?? {};
  } catch {
    manifestModules = {};
  }
  const previews: Record<string, {
    svg: string;
    svgPath: string;
    netlistPath: string;
    netlist: string;
    notebook: string;
    notebookPath: string;
    builtRevision?: number;
    schematicOverrides?: Record<string, unknown>;
  }> = {};
  for (const moduleRef of project?.modules ?? []) {
    const moduleId = moduleRef.id;
    if (!moduleId) continue;
    const moduleBuildRoot = path.resolve(projectRoot, 'build', 'modules', moduleId);
    const svgPath = path.resolve(moduleBuildRoot, 'schematic.svg');
    const netlistPath = path.resolve(moduleBuildRoot, 'design.cir');
    if (!(await exists(svgPath)) && !(await exists(netlistPath))) continue;
    const netlist = await exists(netlistPath) ? await readFile(netlistPath, 'utf8') : '';
    const notebookPath = path.resolve(projectRoot, 'modules', moduleId, 'netlist-notebook.md');
    const overridesPath = path.resolve(projectRoot, 'modules', moduleId, 'schematic.overrides.json');
    const notebook = await exists(notebookPath)
      ? await readFile(notebookPath, 'utf8')
      : [
          `# ${moduleRef.name ?? moduleId}`,
          '',
          moduleRef.function ?? 'Describe this circuit module here.',
          '',
          '## SPICE netlist',
          '',
          '```spice',
          netlist.trim(),
          '```',
          '',
          '## Notes',
          '',
          'Add implementation notes, assumptions, review comments, or Agent instructions here.',
          '',
        ].join('\n');
    previews[moduleId] = {
      svg: await exists(svgPath) ? await readFile(svgPath, 'utf8') : '',
      svgPath,
      netlistPath,
      netlist,
      notebook,
      notebookPath,
      builtRevision: manifestModules[moduleId]?.revision,
      schematicOverrides: await readOptionalJson(overridesPath) ?? undefined,
    };
  }
  return { ...bundle, module_previews: previews };
}

function notifyProjectChanged(projectId: string): void {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('project:changed', { projectId, timestamp: Date.now() });
    }
  }, 120);
}

function normalizeAtomicSourcePath(relativePath: string): string {
  return relativePath.replace(
    /(^|\/)\.(project\.circuit\.json|module\.circuit\.json|netlist-notebook\.md|schematic\.overrides\.json)\.[^/]+\.tmp$/,
    '$1$2',
  );
}

async function watchProject(projectId: string): Promise<void> {
  if (watchPauseDepth > 0) {
    watchedProjectId = projectId;
    return;
  }
  if (activeWatcher && watchedProjectId === projectId) return;
  activeWatcher?.close();
  activeWatcher = null;
  if (watchPollTimer) clearInterval(watchPollTimer);
  watchPollTimer = null;
  watchedProjectId = projectId;
  const root = await resolveProjectRoot(projectId);
  try {
    const initial = JSON.parse(await readFile(path.join(root, 'project.circuit.json'), 'utf8')) as { revision?: number };
    watchedProjectRevision = typeof initial.revision === 'number' ? initial.revision : null;
  } catch {
    watchedProjectRevision = null;
  }
  activeWatcher = watch(root, { recursive: true }, (_eventType, filename) => {
    try {
      const relative = normalizeAtomicSourcePath(String(filename ?? '').replace(/\\/g, '/'));
      if (!relative || relative.startsWith('build/') || relative.startsWith('commands/') ||
          relative.startsWith('revisions/') || relative.startsWith('logs/')) return;
      if (relative !== 'project.circuit.json' &&
          !/modules\/[^/]+\/(?:module\.circuit\.json|netlist-notebook\.md|schematic\.overrides\.json)$/.test(relative)) return;
      notifyProjectChanged(projectId);
    } catch (error) {
      // Keep the desktop alive if a watcher callback fails mid-compile/reload.
      console.warn(`project watch callback failed for ${projectId}:`, error);
    }
  });
  // Windows recursive watchers can emit 'error' when compile writes many build/
  // artifacts quickly (buffer overflow / EPERM on synced disks). Unhandled
  // EventEmitter errors would otherwise terminate the Electron main process.
  activeWatcher.on('error', (error) => {
    console.warn(`project watcher error for ${projectId}:`, error);
    if (watchedProjectId !== projectId) return;
    try {
      activeWatcher?.close();
    } catch {
      // ignore close failures while recovering
    }
    activeWatcher = null;
    // Best-effort resubscribe after the burst of filesystem activity settles.
    setTimeout(() => {
      if (watchedProjectId !== projectId || activeWatcher || watchPauseDepth > 0) return;
      void watchProject(projectId).catch((restartError) => {
        console.warn(`project watcher restart failed for ${projectId}:`, restartError);
      });
    }, 1_000);
  });
  watchPollTimer = setInterval(() => {
    void (async () => {
      if (watchedProjectId !== projectId) return;
      try {
        const current = JSON.parse(await readFile(path.join(root, 'project.circuit.json'), 'utf8')) as { revision?: number };
        if (typeof current.revision !== 'number' || current.revision === watchedProjectRevision) return;
        watchedProjectRevision = current.revision;
        notifyProjectChanged(projectId);
      } catch {
        // The watcher will retry on its next interval while an atomic replace is in flight.
      }
    })();
  }, 500);
}

export function registerProjectHandlers(ipcMain: IpcMain): void {
  void ensureProjectsDirectoryWatcher().catch((error) => {
    console.warn('projects directory watcher bootstrap failed:', error);
  });

  ipcMain.handle('project:list', async () => listProjects());

  ipcMain.handle('project:trash', async (_event, projectIds: string[]) => {
    if (!Array.isArray(projectIds) || projectIds.length === 0) {
      throw new Error('Select at least one project to move to trash.');
    }
    const trashed: TrashProjectSummary[] = [];
    for (const projectId of [...new Set(projectIds)]) {
      trashed.push(await moveProjectToTrash(projectId));
    }
    return trashed;
  });

  ipcMain.handle('project:list-trash', async () => {
    await archiveLegacyPlaywrightProjects();
    return listTrashProjects();
  });

  ipcMain.handle('project:restore-trash', async (_event, trashIds: string[]) => {
    if (!Array.isArray(trashIds) || trashIds.length === 0) {
      throw new Error('Select at least one trashed project to restore.');
    }
    return restoreTrashProjects(trashIds);
  });

  ipcMain.handle('project:purge-trash', async (_event, trashIds: string[]) => {
    if (!Array.isArray(trashIds) || trashIds.length === 0) {
      throw new Error('Select at least one trashed project to purge.');
    }
    await purgeTrashProjects(trashIds);
  });

  ipcMain.handle('project:list-history', async (_event, projectId: string) => {
    return listProjectHistory(projectId);
  });

  ipcMain.handle(
    'project:restore-revision',
    async (_event, projectId: string, revision: number, baseRevision: number) => {
      if (!Number.isInteger(revision) || revision < 1) throw new Error(`Invalid revision: ${revision}`);
      const root = await resolveProjectRoot(projectId);
      const result = await runProjectTool([
        'apply',
        '--project-root', root,
        '--command-json', JSON.stringify({
          schema: 'actoviq.command.v1',
          command_id: `restore-${revision}-${Date.now()}`,
          actor: 'user',
          project_id: projectId,
          base_revision: baseRevision,
          message: `Restore revision ${revision}`,
          operations: [{ op: 'restore_revision', revision }],
        }),
      ]);
      const build = await withProjectWatchPaused(async () => (
        runProjectTool(['compile', '--project-root', root])
      ));
      return { ...result, build };
    },
  );

  ipcMain.handle('project:create', async (_event, input: { name: string; demo?: boolean; projectKind?: string }) => {
    const root = await projectsRoot();
    const args = [
      input.demo ? 'create-demo' : 'create',
      '--projects-root', root,
      '--name', input.name,
    ];
    const projectKind = typeof input.projectKind === 'string' ? input.projectKind.trim() : '';
    if (projectKind) args.push('--project-kind', projectKind);
    return runProjectTool(args);
  });

  ipcMain.handle(
    'project:create-from-template',
    async (_event, input: { templateId: string; name?: string }) => createProjectFromTemplate(input),
  );

  ipcMain.handle('project:get', async (_event, projectId: string) => {
    const root = await resolveProjectRoot(projectId);
    const bundle = await runProjectTool(['summary', '--project-root', root]);
    return enrichProjectBundle(root, bundle);
  });

  ipcMain.handle('library:resolve-kicad-symbol-ir', async (_event, symbolIds: string[]) => {
    if (!Array.isArray(symbolIds) || symbolIds.length > 256) {
      throw new Error('symbolIds must be an array containing at most 256 symbols.');
    }
    const uniqueIds = [...new Set(symbolIds.map((value) => String(value).trim()).filter(Boolean))];
    if (uniqueIds.length === 0) {
      return { schema: 'actoviq.symbol-ir-bundle.v1', definitions: {}, diagnostics: [] };
    }
    return runProjectTool([
      'kicad-symbol-ir',
      ...uniqueIds.flatMap((symbolId) => ['--symbol', symbolId]),
    ]);
  });

  ipcMain.handle('project:apply-command', async (_event, projectId: string, command: unknown) => {
    return runProjectTool([
      'apply',
      '--project-root', await resolveProjectRoot(projectId),
      '--command-json', JSON.stringify(command),
    ]);
  });

  ipcMain.handle('project:stage-command', async (_event, projectId: string, command: unknown) => {
    return runProjectTool([
      'pending-stage',
      '--project-root', await resolveProjectRoot(projectId),
      '--command-json', JSON.stringify(command),
    ]);
  });

  ipcMain.handle('project:list-pending-commands', async (_event, projectId: string) => {
    return runProjectTool([
      'pending-list',
      '--project-root', await resolveProjectRoot(projectId),
    ]);
  });

  ipcMain.handle('project:accept-pending-command', async (_event, projectId: string, commandId: string) => {
    return withProjectWatchPaused(async () => runProjectTool([
      'pending-accept',
      '--project-root', await resolveProjectRoot(projectId),
      '--command-id', commandId,
    ]));
  });

  ipcMain.handle(
    'project:reject-pending-command',
    async (_event, projectId: string, commandId: string, reason?: string) => {
      const args = [
        'pending-reject',
        '--project-root', await resolveProjectRoot(projectId),
        '--command-id', commandId,
      ];
      if (reason?.trim()) args.push('--reason', reason.trim());
      return runProjectTool(args);
    },
  );

  ipcMain.handle('project:run-erc', async (_event, projectId: string) => {
    return runProjectTool(['erc', '--project-root', await resolveProjectRoot(projectId)]);
  });

  ipcMain.handle('project:agent-context', async (_event, projectId: string) => {
    return runProjectTool(['agent-context', '--project-root', await resolveProjectRoot(projectId)]);
  });

  ipcMain.handle('project:compile', async (_event, projectId: string) => {
    return withProjectWatchPaused(async () => (
      runProjectTool(['compile', '--project-root', await resolveProjectRoot(projectId)])
    ));
  });

  ipcMain.handle('project:optimize-layout', async (
    _event,
    projectId: string,
    input: LayoutOptimizationRequest,
  ) => withProjectWatchPaused(() => optimizeModuleLayout(projectId, input)));

  ipcMain.handle('project:export-eda', async (_event, projectId: string, input: EdaExportRequest) => {
    const root = await resolveProjectRoot(projectId);
    if (input.scope === 'module') assertModuleId(input.moduleId ?? '');
    const allowedTargets = new Set(['kicad', 'altium', 'orcad', 'virtuoso']);
    if (!Array.isArray(input.targets) || input.targets.length === 0 || input.targets.some((target) => !allowedTargets.has(target))) {
      throw new Error('Select at least one supported EDA target.');
    }
    if (!Number.isInteger(input.sourceRevision) || input.sourceRevision < 0) {
      throw new Error(`Invalid source revision: ${input.sourceRevision}`);
    }
    const args = [
      'export-eda', '--project-root', root,
      '--scope', input.scope,
      '--targets', [...new Set(input.targets)].join(','),
      '--view', input.view,
      '--native-convert', input.nativeConvert,
      '--source-revision', String(input.sourceRevision),
    ];
    if (input.scope === 'module') args.push('--module-id', input.moduleId ?? '');
    if (input.mappingFile?.trim()) args.push('--mapping-file', path.resolve(input.mappingFile.trim()));
    if (input.outputDir?.trim()) args.push('--output-dir', path.resolve(input.outputDir.trim()));
    if (input.strictLayout) args.push('--strict-layout');
    return runProjectTool(args);
  });

  ipcMain.handle(
    'project:schematic-export',
    async (
      _event,
      projectId: string,
      input: { format: string; outputPath: string; moduleId?: string; sourceRevision: number },
    ) => {
      const root = await resolveProjectRoot(projectId);
      const format = String(input?.format || '').trim();
      const outputPath = String(input?.outputPath || '').trim();
      if (!format) throw new Error('Export format is required.');
      if (!outputPath) throw new Error('Export output path is required.');
      if (!Number.isInteger(input.sourceRevision) || input.sourceRevision < 0) {
        throw new Error(`Invalid source revision: ${input.sourceRevision}`);
      }
      const args = [
        'schematic-export',
        '--project-root', root,
        '--format', format,
        '--output-path', path.resolve(outputPath),
        '--source-revision', String(input.sourceRevision),
      ];
      if (input.moduleId?.trim()) {
        assertModuleId(input.moduleId);
        args.push('--module-id', input.moduleId.trim());
      }
      return withProjectWatchPaused(async () => runProjectTool(args));
    },
  );

  ipcMain.handle(
    'project:schematic-import',
    async (
      _event,
      projectId: string,
      input: { format: string; sourcePath: string; moduleId: string },
    ) => {
      const root = await resolveProjectRoot(projectId);
      const format = String(input?.format || '').trim();
      const sourcePath = String(input?.sourcePath || '').trim();
      const moduleId = String(input?.moduleId || '').trim();
      if (!format) throw new Error('Import format is required.');
      if (!sourcePath) throw new Error('Import source path is required.');
      assertModuleId(moduleId);
      return withProjectWatchPaused(async () => runProjectTool([
        'schematic-import',
        '--project-root', root,
        '--format', format,
        '--source-path', path.resolve(sourcePath),
        '--module-id', moduleId,
      ]));
    },
  );

  ipcMain.handle(
    'project:choose-schematic-import-source',
    async (_event, format: string) => {
      const fmt = String(format || '').trim().toLowerCase();
      if (fmt === 'kicad' || fmt === 'jlceda') {
        const result = await dialog.showOpenDialog({
          title: fmt === 'kicad' ? 'Select KiCad schematic or project folder' : 'Select 鍢夌珛鍒?JSON or folder',
          properties: ['openFile', 'openDirectory'],
          filters: fmt === 'kicad'
            ? [{ name: 'KiCad schematic', extensions: ['kicad_sch'] }]
            : [{ name: '鍢夌珛鍒?JSON', extensions: ['json'] }],
        });
        return result.canceled ? null : result.filePaths[0] ?? null;
      }
      if (fmt === 'xschem') {
        const result = await dialog.showOpenDialog({
          title: 'Select Xschem schematic',
          properties: ['openFile'],
          filters: [{ name: 'Xschem schematic', extensions: ['sch'] }],
        });
        return result.canceled ? null : result.filePaths[0] ?? null;
      }
      if (fmt === 'virtuoso') {
        const result = await dialog.showOpenDialog({
          title: 'Select Virtuoso SPICE/CDL netlist',
          properties: ['openFile'],
          filters: [{ name: 'SPICE/CDL', extensions: ['cir', 'sp', 'spice', 'cdl', 'scs'] }],
        });
        return result.canceled ? null : result.filePaths[0] ?? null;
      }
      const result = await dialog.showOpenDialog({
        title: 'Select schematic file',
        properties: ['openFile'],
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  );

  ipcMain.handle(
    'project:choose-schematic-export-path',
    async (_event, format: string) => {
      const fmt = String(format || '').trim().toLowerCase();
      if (fmt === 'xschem') {
        const result = await dialog.showSaveDialog({
          title: 'Export Xschem schematic',
          filters: [{ name: 'Xschem schematic', extensions: ['sch'] }],
        });
        return result.canceled ? null : result.filePath ?? null;
      }
      const result = await dialog.showOpenDialog({
        title: 'Select export folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  );

  ipcMain.handle('project:choose-eda-mapping', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select Vibe Analog EDA symbol mapping',
      properties: ['openFile'],
      filters: [{ name: 'JSON mapping', extensions: ['json'] }],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('project:choose-eda-output-dir', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select EDA export folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('project:list-hdl-files', async (_event, projectId: string) => {
    const root = await resolveProjectRoot(projectId);
    return listHdlSourceFiles(path.resolve(root, 'hdl'));
  });

  ipcMain.handle('project:initialize-hdl', async (_event, projectId: string) => {
    const root = await resolveProjectRoot(projectId);
    return initializeHdlWorkspace(root);
  });

  ipcMain.handle('project:create-hdl-file', async (_event, projectId: string, relativePath: string) => {
    const root = await resolveProjectRoot(projectId);
    const target = resolveHdlProjectFile(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    const template = path.extname(target).toLowerCase() === '.json' ? '{}\n' : '';
    await writeFile(target, template, { encoding: 'utf8', flag: 'wx' });
    return { ok: true, path: relativePath };
  });

  ipcMain.handle(
    'project:run-hdl',
    async (_event, projectId: string, action: 'simulate' | 'synthesize' | 'gate-regression' | 'openroad' | 'mixed-contract') => {
      if (!['simulate', 'synthesize', 'gate-regression', 'openroad', 'mixed-contract'].includes(action)) {
        throw new Error(`Unsupported HDL action: ${String(action)}`);
      }
      const root = await resolveProjectRoot(projectId);
      return runHdlAction(root, action);
    },
  );

  ipcMain.handle('project:read-hdl-file', async (_event, projectId: string, relativePath: string) => {
    const root = await resolveProjectRoot(projectId);
    return readFile(resolveHdlProjectFile(root, relativePath), 'utf8');
  });

  ipcMain.handle(
    'project:write-hdl-file',
    async (_event, projectId: string, relativePath: string, content: string) => {
      if (typeof content !== 'string') throw new Error('HDL file content must be text');
      const root = await resolveProjectRoot(projectId);
      const target = resolveHdlProjectFile(root, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
      return { ok: true, path: relativePath, hash: createHash('sha256').update(content).digest('hex') };
    },
  );

  ipcMain.handle('pdk:choose-root', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select local PDK root',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('pdk:choose-install-destination', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select an empty folder for the open PDK source',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('pdk:choose-mapping-pack', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select commercial PDK mapping pack',
      properties: ['openFile'],
      filters: [{ name: 'Vibe Analog PDK mapping pack', extensions: ['json'] }],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('project:choose-physical-file', async (_event, label: string) => {
    const result = await dialog.showOpenDialog({
      title: `Select ${label}`,
      properties: ['openFile'],
      filters: [{ name: 'IC design files', extensions: ['gds', 'gdsii', 'oas', 'oasis', 'mag', 'drc', 'lvs', 'lydrc', 'lylvs', 'cir', 'sp', 'spi', 'spice', 'cdl', 'tcl', 'tech'] }],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('project:open-physical-artifact', async (_event, projectId: string, artifactPath: string) => {
    if (!projectId || typeof artifactPath !== 'string' || !artifactPath.trim()) {
      throw new Error('projectId and artifactPath are required');
    }
    const root = await resolveProjectRoot(projectId);
    const target = path.resolve(artifactPath);
    await access(target);
    const info = await stat(target);
    if (!info.isFile()) throw new Error('Artifact path must be a file');
    const ext = path.extname(target).toLowerCase();
    const blocked = new Set([
      '.exe', '.bat', '.cmd', '.com', '.msi', '.ps1', '.scr',
      '.js', '.jse', '.vbs', '.vbe', '.wsf', '.wsh', '.msc',
    ]);
    if (blocked.has(ext)) {
      throw new Error('Refusing to open executable or script artifact');
    }
    const relative = path.relative(root, target);
    const underProject = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    const safeOutside = new Set([
      '.gds', '.gdsii', '.oas', '.oasis', '.mag', '.lyrdb', '.json',
      '.cir', '.sp', '.spi', '.spice', '.cdl', '.txt', '.log', '.tcl',
      '.drc', '.lvs', '.lydrc', '.lylvs',
    ]);
    if (!underProject && !safeOutside.has(ext)) {
      throw new Error('Artifacts outside the project must use a known IC design or report extension');
    }
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return target;
  });

  ipcMain.handle('project:choose-licensed-eda-input', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select commercial simulator input deck or AMS file list',
      properties: ['openFile'],
      filters: [{ name: 'EDA inputs', extensions: ['scs', 'cir', 'sp', 'spi', 'spice', 'hsp', 'f', 'fl', 'tcl', 'do'] }],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  const pdkArgs = (command: 'pdk-scan' | 'pdk-register', input: {
    root: string;
    adapter: string;
    version?: string;
    revision?: string;
    mappingFile?: string;
    licenseAccepted?: boolean;
  }): string[] => {
    const args = [command, '--root', input.root, '--adapter', input.adapter];
    if (input.version) args.push('--version', input.version);
    if (input.revision) args.push('--revision', input.revision);
    if (input.mappingFile) args.push('--mapping-file', input.mappingFile);
    if (command === 'pdk-register' && input.licenseAccepted) args.push('--license-accepted');
    return args;
  };

  ipcMain.handle('pdk:list', async () => runProjectTool(['pdk-list']));
  ipcMain.handle('pdk:open-catalog', async () => runProjectTool(['pdk-open-catalog']));
  ipcMain.handle('pdk:local-status', async () => {
    const root = await resolveConfiguredPdkInstallRoot();
    const listed = await runProjectTool(['pdk-list']).catch(() => ({ installations: [] })) as {
      installations?: Array<Record<string, unknown>>;
    };
    const installations = Array.isArray(listed.installations) ? listed.installations : [];
    const adapters = ['ihp-sg13g2', 'sky130', 'gf180mcu'] as const;
    const items = await Promise.all(adapters.map(async (adapterId) => {
      const destination = path.join(root, adapterId);
      let present = false;
      try {
        const entries = await readdir(destination);
        present = entries.length > 0;
      } catch {
        present = false;
      }
      const registered = installations.filter((entry) => String(entry.logical_id ?? '') === adapterId);
      const registeredRoot = registered.length > 0
        ? String(registered[0]?.root ?? '')
        : '';
      return {
        adapter_id: adapterId,
        present,
        registered: registered.length > 0,
        destination: present ? destination : '',
        root: registeredRoot || (present ? destination : ''),
        installation_ids: registered.map((entry) => String(entry.installation_id ?? '')).filter(Boolean),
      };
    }));
    return { ok: true, defaultRoot: root, items };
  });
  ipcMain.handle('pdk:default-root', async () => resolveConfiguredPdkInstallRoot());
  ipcMain.handle('pdk:choose-install-root', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select PDK install root',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('pdk:open-external', async (_event, url: string) => {
    const trimmed = String(url || '').trim();
    const allowed = new Set([
      'https://github.com/IHP-GmbH/IHP-Open-PDK',
      'https://github.com/IHP-GmbH/IHP-Open-PDK.git',
      'https://github.com/google/skywater-pdk',
      'https://github.com/google/skywater-pdk.git',
      'https://github.com/google/gf180mcu-pdk',
      'https://github.com/google/gf180mcu-pdk.git',
    ]);
    if (!allowed.has(trimmed)) {
      throw new Error('Refusing to open an unlisted PDK URL.');
    }
    await shell.openExternal(trimmed);
    return { ok: true, url: trimmed };
  });
  ipcMain.handle('pdk:install-open', async (_event, input) => {
    if (!input?.licenseAccepted) throw new Error('Open PDK installation requires license acceptance.');
    if (input.adapter === 'commercial') throw new Error('Commercial PDKs must be imported in place.');
    const args = [
      'pdk-install-open',
      '--adapter', String(input.adapter),
      '--destination', String(input.destination),
      '--license-accepted',
    ];
    if (input.revision) args.push('--revision', String(input.revision));
    return runProjectTool(args, { timeoutMs: 3_700_000 });
  });
  ipcMain.handle('pdk:install-open-default', async (_event, input) => {
    if (!input?.licenseAccepted) throw new Error('Open PDK installation requires license acceptance.');
    const adapter = String(input.adapter || '').trim();
    if (!['ihp-sg13g2', 'sky130', 'gf180mcu'].includes(adapter)) {
      throw new Error(`Unsupported open PDK adapter: ${adapter}`);
    }
    const root = await resolveConfiguredPdkInstallRoot();
    const destination = path.join(root, adapter);
    const alreadyPresent = await access(destination).then(() => true).catch(() => false);
    let receipt: Record<string, unknown> | null = null;
    if (alreadyPresent) {
      const entries = await readdir(destination).catch(() => []);
      if (entries.length > 0) {
        // Reuse an existing clone under the Vibe Analog app data directory.
        receipt = {
          destination,
          reused: true,
          adapter_id: adapter,
        };
      }
    }
    if (!receipt) {
      await mkdir(path.dirname(destination), { recursive: true });
      const installed = await runProjectTool([
        'pdk-install-open',
        '--adapter', adapter,
        '--destination', destination,
        '--license-accepted',
      ], { timeoutMs: 3_700_000 }) as { receipt?: Record<string, unknown> };
      receipt = installed.receipt ?? { destination, adapter_id: adapter };
    }
    const revision = String(receipt.resolved_revision ?? '');
    const scanned = await runProjectTool(pdkArgs('pdk-scan', {
      root: destination,
      adapter,
      revision: revision || undefined,
    }));
    let registered: Record<string, unknown> | null = null;
    if (input.register) {
      registered = await runProjectTool(pdkArgs('pdk-register', {
        root: destination,
        adapter,
        revision: revision || undefined,
        licenseAccepted: true,
      })) as Record<string, unknown>;
    }
    return {
      ok: true,
      destination,
      defaultRoot: root,
      receipt,
      scan: scanned,
      registration: registered,
    };
  });
  ipcMain.handle('pdk:scan', async (_event, input) => runProjectTool(pdkArgs('pdk-scan', input)));
  ipcMain.handle('pdk:register', async (_event, input) => {
    if (!input?.licenseAccepted) throw new Error('PDK registration requires license acceptance.');
    return runProjectTool(pdkArgs('pdk-register', input));
  });

  ipcMain.handle('project:choose-xschem-peer', async (_event, mode: 'bridge' | 'external') => {
    if (mode === 'external') {
      const opened = await dialog.showOpenDialog({
        title: 'Select Xschem schematic',
        properties: ['openFile'],
        filters: [{ name: 'Xschem schematic', extensions: ['sch'] }],
      });
      return opened.canceled ? null : opened.filePaths[0] ?? null;
    }
    const saved = await dialog.showSaveDialog({
      title: 'Create Xschem peer schematic',
      filters: [{ name: 'Xschem schematic', extensions: ['sch'] }],
    });
    return saved.canceled ? null : saved.filePath ?? null;
  });

  ipcMain.handle('project:xschem-link', async (_event, projectId: string, input) => {
    const args = [
      'xschem-link',
      '--project-root', await resolveProjectRoot(projectId),
      '--module-id', String(input.moduleId),
      '--mode', String(input.mode),
    ];
    if (input.peerFile) args.push('--peer-file', String(input.peerFile));
    return withProjectWatchPaused(async () => runProjectTool(args));
  });
  for (const command of ['push', 'pull', 'take-ownership'] as const) {
    ipcMain.handle(`project:xschem-${command}`, async (_event, projectId: string, moduleId: string) => (
      withProjectWatchPaused(async () => runProjectTool([
        `xschem-${command}`,
        '--project-root', await resolveProjectRoot(projectId),
        '--module-id', moduleId,
      ]))
    ));
  }
  ipcMain.handle(
    'project:xschem-validate',
    async (_event, projectId: string, moduleId: string, peerFile: string) => {
      assertModuleId(moduleId);
      const root = await resolveProjectRoot(projectId);
      const runRoot = path.resolve(root, 'build', 'xschem-validation', moduleId, String(Date.now()));
      return runProjectTool([
        'xschem-validate',
        '--schematic-file', peerFile,
        '--run-root', runRoot,
        '--project-root', root,
        '--module-id', moduleId,
      ]);
    },
  );

  ipcMain.handle('project:choose-bridge-peer-root', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select KiCad / 鍢夌珛鍒?EDA project folder',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('project:bridge-list', async (_event, projectId: string) => {
    const root = await resolveProjectRoot(projectId);
    return runProjectTool(['bridge-list', '--project-root', root]);
  });

  ipcMain.handle('project:bridge-status', async (_event, projectId: string, peerKind?: string) => {
    const root = await resolveProjectRoot(projectId);
    const args = ['bridge-status', '--project-root', root];
    if (peerKind?.trim()) args.push('--peer-kind', assertEdaBridgePeerKind(peerKind.trim()));
    return runProjectTool(args);
  });

  ipcMain.handle(
    'project:bridge-link',
    async (_event, projectId: string, input: { peerKind: string; peerRoot: string; policy?: string }) => {
      const root = await resolveProjectRoot(projectId);
      const peerKind = assertEdaBridgePeerKind(input.peerKind);
      const peerRoot = input.peerRoot?.trim();
      if (!peerRoot) throw new Error('EDA bridge peer root is required.');
      const args = ['bridge-link', '--project-root', root, '--peer-kind', peerKind, '--peer-root', path.resolve(peerRoot)];
      if (input.policy?.trim()) args.push('--policy', input.policy.trim());
      return runProjectTool(args);
    },
  );

  ipcMain.handle('project:bridge-unlink', async (_event, projectId: string, peerKind: string) => {
    const root = await resolveProjectRoot(projectId);
    return runProjectTool([
      'bridge-unlink',
      '--project-root', root,
      '--peer-kind', assertEdaBridgePeerKind(peerKind),
    ]);
  });

  ipcMain.handle('project:bridge-push', async (_event, projectId: string, peerKind: string) => {
    const root = await resolveProjectRoot(projectId);
    const summary = await runProjectTool(['summary', '--project-root', root]);
    const project = summary.project as { revision?: number } | undefined;
    const sourceRevision = project?.revision;
    if (!Number.isInteger(sourceRevision) || (sourceRevision ?? -1) < 0) {
      throw new Error(`Invalid source revision: ${sourceRevision}`);
    }
    const args = [
      'bridge-push',
      '--project-root', root,
      '--peer-kind', assertEdaBridgePeerKind(peerKind),
      '--source-revision', String(sourceRevision),
    ];
    return runProjectTool(args);
  });

  ipcMain.handle(
    'project:bridge-pull',
    async (_event, projectId: string, peerKind: string, policy?: string) => {
      const root = await resolveProjectRoot(projectId);
      const args = [
        'bridge-pull',
        '--project-root', root,
        '--peer-kind', assertEdaBridgePeerKind(peerKind),
      ];
      if (policy?.trim()) args.push('--policy', policy.trim());
      return withProjectWatchPaused(async () => runProjectTool(args));
    },
  );

  ipcMain.handle(
    'project:bridge-import-cold',
    async (_event, input: { peerKind: string; peerRoot: string; name?: string; projectKind?: string }) => {
      const peerKind = assertEdaBridgePeerKind(input.peerKind);
      const peerRoot = input.peerRoot?.trim();
      if (!peerRoot) throw new Error('EDA bridge peer root is required.');
      const projectsRootPath = await projectsRoot();
      const args = [
        'bridge-import-cold',
        '--peer-kind', peerKind,
        '--peer-root', path.resolve(peerRoot),
        '--projects-root', projectsRootPath,
      ];
      const name = input.name?.trim();
      if (name) args.push('--name', name);
      const projectKind = assertProjectKind(input.projectKind);
      if (projectKind) args.push('--project-kind', projectKind);
      return runProjectTool(args);
    },
  );

  ipcMain.handle(
    'project:lcsc-search',
    async (_event, query: string, opts?: { limit?: number; useFallback?: boolean }) => {
      const trimmed = query?.trim();
      if (!trimmed) throw new Error('LCSC search query is required.');
      const args = ['lcsc-search', '--query', trimmed];
      if (opts?.limit != null) args.push('--limit', String(opts.limit));
      if (opts?.useFallback) args.push('--use-fallback');
      return runProjectTool(await appendLcscCliArgs(args));
    },
  );

  ipcMain.handle(
    'project:lcsc-get',
    async (_event, lcscId: string, opts?: { useFallback?: boolean }) => {
      const trimmed = lcscId?.trim();
      if (!trimmed) throw new Error('LCSC part id is required.');
      const args = ['lcsc-get', '--lcsc-id', trimmed];
      if (opts?.useFallback) args.push('--use-fallback');
      return runProjectTool(await appendLcscCliArgs(args));
    },
  );

  ipcMain.handle(
    'project:lcsc-bind',
    async (
      _event,
      projectId: string,
      moduleId: string,
      componentId: string,
      lcscId: string,
      opts?: { useFallback?: boolean },
    ) => {
      assertModuleId(moduleId);
      const trimmedComponentId = componentId?.trim();
      const trimmedLcscId = lcscId?.trim();
      if (!trimmedComponentId) throw new Error('Component id is required.');
      if (!trimmedLcscId) throw new Error('LCSC part id is required.');
      const root = await resolveProjectRoot(projectId);
      const args = [
        'lcsc-bind',
        '--project-root', root,
        '--module-id', moduleId,
        '--component-id', trimmedComponentId,
        '--lcsc-id', trimmedLcscId,
      ];
      if (opts?.useFallback) args.push('--use-fallback');
      return withProjectWatchPaused(async () => runProjectTool(await appendLcscCliArgs(args)));
    },
  );

  ipcMain.handle('project:simulate', async (_event, projectId: string) => {
    const settings = await loadSettings();
    return withProjectWatchPaused(async () => (
      runProjectTool([
        'simulate',
        '--project-root', await resolveProjectRoot(projectId),
        '--ngspice-bin', resolveNgspiceExecutable(settings.ngspiceBin),
      ])
    ));
  });

  ipcMain.handle(
    'project:generate-technical-report',
    async (_event, projectId: string, sourceRevision: number) => (
      generateProjectTechnicalReport(projectId, sourceRevision)
    ),
  );

  ipcMain.handle('project:compile-module', async (
    _event,
    projectId: string,
    moduleId: string,
    schematicDocument?: unknown,
  ) => {
    assertModuleId(moduleId);
    return withProjectWatchPaused(async () => {
      const projectRoot = await resolveProjectRoot(projectId);
      if (schematicDocument) {
        await writeSchematicDocumentArtifact(projectRoot, moduleId, schematicDocument);
      }
      return runProjectTool([
        'compile-module',
        '--project-root', projectRoot,
        '--module-id', moduleId,
      ]);
    });
  });

  ipcMain.handle(
    'project:save-module-notebook',
    async (_event, projectId: string, moduleId: string, markdown: string, baseRevision?: number) => {
      if (!/^[A-Za-z0-9_-]+$/.test(moduleId)) {
        throw new Error(`Invalid module id: ${moduleId}`);
      }
      if (!/```(?:spice|cir|netlist)\s*\r?\n[\s\S]+?```/i.test(markdown)) {
        throw new Error('The notebook needs a fenced spice, cir, or netlist code block.');
      }
      const root = await resolveProjectRoot(projectId);
      const project = await readJsonFile<{ revision: number }>(path.resolve(root, 'project.circuit.json'));
      await runProjectTool([
        'apply',
        '--project-root', root,
        '--command-json', JSON.stringify({
          schema: 'actoviq.command.v1',
          command_id: `netlist-${Date.now()}`,
          actor: 'user',
          project_id: projectId,
          base_revision: baseRevision ?? project.revision,
          message: `Edit module netlist ${moduleId}`,
          operations: [{ op: 'set_module_netlist', module_id: moduleId, netlist_notebook: markdown }],
        }),
      ]);
      return withProjectWatchPaused(async () => (
        runProjectTool([
          'compile-module',
          '--project-root', root,
          '--module-id', moduleId,
        ])
      ));
    },
  );

  ipcMain.handle('project:simulate-module', async (_event, projectId: string, moduleId: string) => {
    assertModuleId(moduleId);
    const settings = await loadSettings();
    return withProjectWatchPaused(async () => (
      runProjectTool([
        'simulate-module',
        '--project-root', await resolveProjectRoot(projectId),
        '--module-id', moduleId,
        '--ngspice-bin', resolveNgspiceExecutable(settings.ngspiceBin),
      ])
    ));
  });

  ipcMain.handle('project:simulate-dual', async (_event, projectId: string, input) => {
    const settings = await loadSettings();
    return runProjectTool([
      'simulate-dual',
      '--project-root', await resolveProjectRoot(projectId),
      '--left-profile', String(input.leftProfileId),
      '--right-profile', String(input.rightProfileId),
      '--relative-tolerance', String(input.relativeTolerance),
      '--absolute-tolerance', String(input.absoluteTolerance),
      '--ngspice-bin', resolveNgspiceExecutable(settings.ngspiceBin),
    ], { timeoutMs: 600_000 });
  });

  ipcMain.handle('project:run-physical-verification', async (_event, projectId: string, input) => {
    const root = await resolveProjectRoot(projectId);
    const operation = String(input.operation);
    const runRoot = path.resolve(root, 'build', 'physical', operation, String(Date.now()));
    const common = ['--run-root', runRoot];
    if (operation === 'klayout_drc') {
      return runProjectTool([
        'verify-klayout-drc',
        '--layout', String(input.layout),
        '--rule-deck', String(input.ruleDeck),
        ...common,
      ], { timeoutMs: 600_000 });
    }
    if (operation === 'klayout_lvs') {
      return runProjectTool([
        'verify-klayout-lvs',
        '--layout', String(input.layout),
        '--schematic', String(input.schematic),
        '--rule-deck', String(input.ruleDeck),
        ...common,
      ], { timeoutMs: 600_000 });
    }
    if (operation === 'magic_extract' || operation === 'magic_pex') {
      return runProjectTool([
        'extract-magic',
        '--layout', String(input.layout),
        '--tech-file', String(input.techFile),
        '--top-cell', String(input.topCell),
        ...(operation === 'magic_pex' ? ['--pex'] : []),
        ...common,
      ], { timeoutMs: 600_000 });
    }
    if (operation === 'netgen_lvs') {
      return runProjectTool([
        'verify-netgen-lvs',
        '--extracted', String(input.extracted),
        '--schematic', String(input.schematic),
        '--setup-file', String(input.setupFile),
        '--extracted-cell', String(input.extractedCell),
        '--schematic-cell', String(input.schematicCell),
        ...common,
      ], { timeoutMs: 600_000 });
    }
    if (operation === 'post_layout_simulation') {
      const settings = await loadSettings();
      return runProjectTool([
        'simulate-post-layout',
        '--project-root', root,
        '--deck', String(input.deck),
        '--layout', String(input.layout),
        '--schematic', String(input.schematic),
        '--lvs-run', String(input.lvsRun),
        '--ngspice-bin', resolveNgspiceExecutable(settings.ngspiceBin),
      ], { timeoutMs: 600_000 });
    }
    throw new Error(`Unsupported physical verification operation: ${operation}`);
  });

  ipcMain.handle('project:run-licensed-eda', async (_event, projectId: string, input) => {
    const root = await resolveProjectRoot(projectId);
    const resolved = await resolveExecutionProfile(String(input.profileId));
    if (resolved.providerId === 'ngspice' || resolved.providerId === 'xyce') {
      throw new Error('Select a licensed analog or AMS execution profile.');
    }
    const profile = { ...resolved };
    const projectInsideAllowlist = profile.allowedRoots.some((rootPath) => {
      const relativeRoot = path.relative(rootPath, root);
      return relativeRoot === '' || (!relativeRoot.startsWith('..') && !path.isAbsolute(relativeRoot));
    });
    if (!projectInsideAllowlist) {
      throw new Error('The active project must be inside the execution profile allowedRoots.');
    }
    const runId = `${timestampForId()}-${Math.random().toString(36).slice(2, 8)}`;
    const outputDirectory = path.resolve(root, 'build', 'licensed-eda', runId);
    await mkdir(outputDirectory, { recursive: true });
    const project = JSON.parse(await readFile(path.resolve(root, 'project.circuit.json'), 'utf8')) as {
      revision?: number;
    };
    const provider = await createLicensedProvider(profile);
    const job = {
      id: runId,
      kind: String(input.kind || 'licensed_simulation'),
      cwd: root,
      inputPath: String(input.inputPath),
      outputDirectory,
      top: String(input.top || ''),
      measurementCsv: input.measurementCsv ? String(input.measurementCsv) : undefined,
      sourceRevision: project.revision,
    };
    const prepared = await provider.prepare(job);
    const execution = await provider.run(prepared);
    const parsed = await provider.parse(job, execution);
    const normalized = {
      schema: 'actoviq.verification-run.v1',
      run_id: parsed.runId,
      kind: parsed.kind,
      provider_id: parsed.providerId,
      executed: parsed.executed,
      status: parsed.status,
      diagnostics: parsed.diagnostics,
      artifacts: parsed.artifacts,
      metadata: {
        qualification: parsed.qualification,
        measured: parsed.measured,
        measurements: parsed.measurements,
        ams_verified: parsed.amsVerified === true,
        target: profile.target,
        tool_profile_id: profile.id,
        source_revision: project.revision,
        output_directory: outputDirectory,
      },
    };
    await writeFile(path.resolve(outputDirectory, 'run.json'), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return normalized;
  });

  ipcMain.handle('project:read-build', async (_event, projectId: string) => {
    const root = await resolveProjectRoot(projectId);
    const manifestPath = path.resolve(root, 'build', 'build-manifest.json');
    if (!(await exists(manifestPath))) return null;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    const simulationPath = path.resolve(root, 'build', 'system', 'simulation', 'result.json');
    const ercPath = path.resolve(root, 'build', 'erc.json');
    const sourceMapPath = path.resolve(root, 'build', 'system', 'source-map.json');
    const reportPath = path.resolve(root, 'build', 'system', 'report.md');
    const technicalReportPath = path.resolve(root, 'build', 'system', 'technical-report.md');
    const technicalReportMetadataPath = path.resolve(root, 'build', 'system', 'technical-report.json');
    const technicalReportMetadata = await readOptionalJson(technicalReportMetadataPath);
    const manifestRevision = Number(manifest.source_revision ?? manifest.revision);
    const technicalReportCurrent = technicalReportMetadata?.source_revision === manifestRevision
      && (!manifest.document_hash || technicalReportMetadata.document_hash === manifest.document_hash);
    return {
      manifest,
      erc: await exists(ercPath)
        ? JSON.parse(await readFile(ercPath, 'utf8')) as Record<string, unknown>
        : null,
      simulation: await exists(simulationPath)
        ? JSON.parse(await readFile(simulationPath, 'utf8')) as Record<string, unknown>
        : null,
      sourceMap: await exists(sourceMapPath)
        ? JSON.parse(await readFile(sourceMapPath, 'utf8')) as Record<string, unknown>
        : null,
      report: technicalReportCurrent && await exists(technicalReportPath)
        ? await readFile(technicalReportPath, 'utf8')
        : await exists(reportPath) ? await readFile(reportPath, 'utf8') : '',
      technicalReport: technicalReportCurrent ? technicalReportMetadata : null,
    };
  });

  ipcMain.handle(
    'project:read-simulation-dataset',
    async (_event, projectId: string, input: Parameters<typeof readSimulationDataset>[1]) => (
      readSimulationDataset(projectId, input)
    ),
  );

  ipcMain.handle('project:save-design-template', async (_event, projectId: string) => {
    return saveDesignTemplate(projectId);
  });

  ipcMain.handle('project:save-design-flow', async (_event, projectId: string) => {
    return saveDesignFlow(projectId);
  });

  ipcMain.handle('reference:list-catalog', async () => runProjectTool(['reference-catalog-list']));

  ipcMain.handle('reference:import-circuit', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Import circuit reference',
      properties: ['openFile'],
      filters: [{ name: 'SPICE', extensions: ['cir', 'sp', 'spice', 'net'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) {
      return { ok: false, cancelled: true };
    }
    return runProjectTool([
      'reference-import-circuit',
      '--file', picked.filePaths[0],
      '--as', 'circuit_module',
    ]);
  });

  ipcMain.handle('reference:import-visual', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Import layout visual reference',
      properties: ['openFile'],
      filters: [{ name: 'Images / PDF', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) {
      return { ok: false, cancelled: true };
    }
    return runProjectTool([
      'reference-import-visual',
      '--file', picked.filePaths[0],
    ]);
  });

  ipcMain.handle(
    'reference:create-project-from',
    async (_event, input: { assetId: string; name?: string; projectKind?: string }) => (
      runProjectTool([
        'reference-create-project',
        '--asset-id', input.assetId,
        ...(input.name ? ['--name', input.name] : []),
        ...(input.projectKind ? ['--project-kind', input.projectKind] : []),
      ])
    ),
  );

  ipcMain.handle(
    'reference:insert-module',
    async (_event, input: { projectId: string; assetId: string; moduleId?: string }) => (
      runProjectTool([
        'reference-insert-module',
        '--project-root', await resolveProjectRoot(input.projectId),
        '--asset-id', input.assetId,
        ...(input.moduleId ? ['--module-id', input.moduleId] : []),
      ])
    ),
  );

  ipcMain.handle(
    'reference:apply-layout',
    async (_event, input: { projectId: string; moduleId: string; assetId: string }) => (
      runProjectTool([
        'apply-layout-from-reference',
        '--project-root', await resolveProjectRoot(input.projectId),
        '--module-id', input.moduleId,
        '--asset-id', input.assetId,
      ])
    ),
  );

  ipcMain.handle(
    'reference:prepare-layout',
    async (_event, input: { projectId: string; moduleId: string; assetId: string }) => (
      runProjectTool([
        'prepare-layout-from-reference',
        '--project-root', await resolveProjectRoot(input.projectId),
        '--module-id', input.moduleId,
        '--asset-id', input.assetId,
      ])
    ),
  );

  ipcMain.handle(
    'reference:promote-visual-from-module',
    async (_event, input: { projectId: string; moduleId: string; assetId: string; name?: string }) => (
      runProjectTool([
        'reference-promote-from-module',
        '--project-root', await resolveProjectRoot(input.projectId),
        '--module-id', input.moduleId,
        '--asset-id', input.assetId,
        ...(input.name ? ['--name', input.name] : []),
      ])
    ),
  );

  ipcMain.handle('reference:attach-to-chat', async (_event, input: { assetId: string }) => {
    const catalog = await runProjectTool(['reference-catalog-list']) as {
      assets?: Array<Record<string, unknown>>;
    };
    const asset = (catalog.assets ?? []).find((entry) => entry.id === input.assetId);
    if (!asset) throw new Error(`Unknown reference asset: ${input.assetId}`);
    return {
      ok: true,
      attachment: {
        kind: 'reference_asset',
        id: asset.id,
        name: asset.name,
        assetKind: asset.kind,
        trust: asset.trust,
        useAs: asset.use_as,
        summary: `${asset.kind} 路 ${asset.name} (${asset.id})`,
      },
    };
  });

  ipcMain.handle('project:list-design-memory', async () => {
    return listDesignMemory();
  });

  ipcMain.handle('project:open-design-memory', async (_event, input: { kind: 'template' | 'flow'; id: string }) => {
    const item = await findDesignMemoryItem(input.kind, input.id);
    return shell.openPath(item.rootPath);
  });

  ipcMain.handle('project:watch', async (_event, projectId: string) => {
    await watchProject(projectId);
  });

  ipcMain.handle('project:open-folder', async (_event, projectId: string) => {
    const projectRoot = await resolveProjectRoot(projectId);
    if (process.env.ACTOVIQ_E2E !== '1') {
      const error = await shell.openPath(projectRoot);
      if (error) throw new Error(error);
    }
    return projectRoot;
  });

  ipcMain.handle('project:open-export-folder', async (
    _event,
    projectId: string,
    exportId: string,
    exportRoot?: string,
  ) => {
    if (!/^[A-Za-z0-9_-]+$/.test(exportId)) throw new Error(`Invalid export id: ${exportId}`);
    const projectRoot = await resolveProjectRoot(projectId);
    const defaultRoot = path.resolve(projectRoot, 'build', 'exports', exportId);
    const candidate = typeof exportRoot === 'string' && exportRoot.trim()
      ? path.resolve(exportRoot.trim())
      : defaultRoot;
    if (path.basename(candidate) !== exportId) {
      throw new Error(`EDA export path does not match export id: ${exportId}`);
    }
    if (!(await exists(candidate))) {
      throw new Error(`EDA export not found: ${exportId}`);
    }
    const manifestPath = path.join(candidate, 'manifest.json');
    if (!(await exists(manifestPath))) {
      throw new Error(`EDA export manifest missing: ${exportId}`);
    }
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { export_id?: unknown };
      if (manifest.export_id !== exportId) {
        throw new Error(`EDA export manifest id mismatch: ${exportId}`);
      }
    } catch (error) {
      if (error instanceof Error && /manifest id mismatch|manifest missing/.test(error.message)) {
        throw error;
      }
      throw new Error(`EDA export manifest is invalid: ${exportId}`);
    }
    if (process.env.ACTOVIQ_E2E !== '1') {
      const error = await shell.openPath(candidate);
      if (error) throw new Error(error);
    }
    return candidate;
  });
}
