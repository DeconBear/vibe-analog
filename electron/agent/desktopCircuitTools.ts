import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { tool, type AgentToolDefinition } from 'actoviq-agent-sdk';
import { z } from 'zod';

import { getActiveWorkspace } from '../workspaceState.js';
import { runProjectTool, summarizeToolResult } from './circuitProjectCli.js';

export interface DesktopCircuitToolsOptions {
  approvalPolicy?: 'manual' | 'execution' | 'all';
  /** Optional callback for AI technical reports (avoids circular imports). */
  generateTechnicalReport?: (input: {
    projectId: string;
    sourceRevision: number;
  }) => Promise<Record<string, unknown>>;
}

async function resolveProjectRoot(projectIdOrRoot: string): Promise<string> {
  const trimmed = projectIdOrRoot.trim();
  if (!trimmed) throw new Error('project_id or project_root is required');
  if (path.isAbsolute(trimmed) || /[\\/]/.test(trimmed)) {
    return path.resolve(trimmed);
  }
  const workspace = await getActiveWorkspace();
  return path.resolve(workspace.projectsDir, trimmed);
}

function textResult(payload: Record<string, unknown>): string {
  return summarizeToolResult(payload);
}

const NESTED_OPERATION_NAMES = new Set([
  'restore_revision',
  'upsert_module',
  'remove_module',
  'add_component',
  'place_library_component',
  'remove_component',
  'add_port',
  'move_module',
  'resize_module',
  'set_module_note',
  'set_module_preview',
  'set_module_metadata',
  'set_analog_ic_profile',
  'set_component_value',
  'move_component',
  'upsert_module_netlist',
  'set_module_schematic',
  'set_module_netlist',
  'bind_lcsc_part',
  'move_schematic_item',
  'reset_schematic_item',
  'connect_ports',
  'set_connection_network',
  'connect_pins',
]);

/** Flatten LLM nestings like {upsert_module:{...}} into {op, ...}. */
export function normalizeDesktopOperation(operation: Record<string, unknown>): Record<string, unknown> {
  const op = operation.op;
  if (typeof op === 'string' && op.trim()) return operation;
  const alt = operation.operation;
  if (typeof alt === 'string' && alt.trim()) {
    const { operation: _drop, ...rest } = operation;
    return { op: alt.trim(), ...rest };
  }
  const nestedKeys = Object.keys(operation).filter(
    (key) => NESTED_OPERATION_NAMES.has(key) && operation[key] && typeof operation[key] === 'object' && !Array.isArray(operation[key]),
  );
  if (nestedKeys.length === 1) {
    const key = nestedKeys[0]!;
    return { op: key, ...(operation[key] as Record<string, unknown>) };
  }
  if (nestedKeys.length > 1) {
    throw new Error(
      `operation nests multiple ops ${nestedKeys.join(', ')}; use one flat {op, ...} object per array entry`,
    );
  }
  return operation;
}

async function run(args: string[], timeoutMs?: number): Promise<string> {
  const result = await runProjectTool(args, timeoutMs ? { timeoutMs } : undefined);
  return textResult(result);
}

/**
 * Desktop chat tools that wrap the same circuit_project.py CLI Skill agents use.
 */
export function createDesktopCircuitTools(options: DesktopCircuitToolsOptions = {}): AgentToolDefinition[] {
  const tools: AgentToolDefinition[] = [
    tool(
      {
        name: 'workspace_list',
        description: 'List Vibe Analog workspaces available to the desktop app.',
        inputSchema: z.object({}),
        serialize: (output) => String(output),
      },
      async () => run(['workspace-list']),
    ),
    tool(
      {
        name: 'workspace_active',
        description: 'Show the active workspace (projectsDir used by the GUI).',
        inputSchema: z.object({}),
        serialize: (output) => String(output),
      },
      async () => run(['workspace-active']),
    ),
    tool(
      {
        name: 'workspace_use',
        description: 'Switch the active workspace by id so create/list use that projectsDir.',
        inputSchema: z.object({
          workspace_id: z.string().min(1),
        }),
        serialize: (output) => String(output),
      },
      async ({ workspace_id }) => run(['workspace-use', '--workspace-id', workspace_id]),
    ),
    tool(
      {
        name: 'create_circuit_project',
        description: [
          'Create a new circuit project in the active workspace.',
          'project_kind must be simulation | pcb_schematic | analog_ic | mixed_signal_ic.',
        ].join(' '),
        inputSchema: z.object({
          name: z.string().min(1),
          project_kind: z.enum(['simulation', 'pcb_schematic', 'analog_ic', 'mixed_signal_ic']).default('simulation'),
          demo: z.boolean().optional(),
        }),
        serialize: (output) => String(output),
      },
      async ({ name, project_kind, demo }) => {
        const command = demo ? 'create-demo' : 'create';
        return run([command, '--name', name, '--project-kind', project_kind]);
      },
    ),
    tool(
      {
        name: 'agent_context',
        description: [
          'Read the revisioned agent context for a project (protocol, modules, ERC, transaction ops).',
          'Always call this before apply_circuit_command and use the exact base_revision returned.',
        ].join(' '),
        inputSchema: z.object({
          project_id: z.string().min(1).describe('Project id or absolute project root'),
        }),
        serialize: (output) => String(output),
      },
      async ({ project_id }) => {
        const root = await resolveProjectRoot(project_id);
        return run(['agent-context', '--project-root', root]);
      },
    ),
    tool(
      {
        name: 'project_summary',
        description: 'Return a compact project summary bundle for the GUI project.',
        inputSchema: z.object({
          project_id: z.string().min(1),
        }),
        serialize: (output) => String(output),
      },
      async ({ project_id }) => {
        const root = await resolveProjectRoot(project_id);
        return run(['summary', '--project-root', root]);
      },
    ),
    tool(
      {
        name: 'apply_circuit_command',
        description: [
          'Apply one actoviq.command.v1 transaction to a project.',
          'Provide either command (full object) or operations + base_revision + message.',
          'Each operation MUST be flat: {"op":"upsert_module_netlist","module_id":"...","netlist_notebook":"..."}',
          'Do not nest as {"upsert_module":{...}}. Prefer upsert_module_netlist with a string notebook.',
          'Never invent base_revision — read it from agent_context first.',
        ].join(' '),
        inputSchema: z.object({
          project_id: z.string().min(1),
          command: z.record(z.string(), z.unknown()).optional(),
          operations: z.array(z.record(z.string(), z.unknown())).optional(),
          base_revision: z.number().int().nonnegative().optional(),
          message: z.string().optional(),
          command_id: z.string().optional(),
        }),
        serialize: (output) => String(output),
      },
      async (input) => {
        const root = await resolveProjectRoot(input.project_id);
        let command = input.command;
        if (!command) {
          if (!input.operations?.length) {
            throw new Error('apply_circuit_command requires command or operations[]');
          }
          if (input.base_revision === undefined) {
            throw new Error('operations apply requires base_revision from agent_context');
          }
          command = {
            schema: 'actoviq.command.v1',
            command_id: input.command_id || `agent-${Date.now()}`,
            actor: 'agent',
            project_id: path.basename(root),
            base_revision: input.base_revision,
            message: input.message || 'Desktop agent transaction',
            operations: input.operations,
          };
        }
        // Defense in depth: flatten LLM nested ops before writing the command file.
        if (Array.isArray(command.operations)) {
          command = {
            ...command,
            operations: (command.operations as Record<string, unknown>[]).map(normalizeDesktopOperation),
          };
        }
        const dir = path.join(tmpdir(), 'actoviq-desktop-commands');
        await mkdir(dir, { recursive: true });
        const file = path.join(dir, `${randomUUID()}.json`);
        await writeFile(file, `${JSON.stringify(command, null, 2)}\n`, 'utf8');
        return run([
          options.approvalPolicy === 'manual' ? 'pending-stage' : 'apply',
          '--project-root', root,
          '--command-file', file,
        ]);
      },
    ),
    tool(
      {
        name: 'run_erc',
        description: 'Run electrical rule checks for a project.',
        inputSchema: z.object({
          project_id: z.string().min(1),
        }),
        serialize: (output) => String(output),
      },
      async ({ project_id }) => {
        const root = await resolveProjectRoot(project_id);
        return run(['erc', '--project-root', root]);
      },
    ),
    tool(
      {
        name: 'compile_circuit_project',
        description: 'Compile the whole project (netlist + schematic SVG pipeline).',
        inputSchema: z.object({
          project_id: z.string().min(1),
        }),
        serialize: (output) => String(output),
      },
      async ({ project_id }) => {
        const root = await resolveProjectRoot(project_id);
        return run(['compile', '--project-root', root], 180_000);
      },
    ),
    tool(
      {
        name: 'compile_circuit_module',
        description: 'Compile a single module in a project.',
        inputSchema: z.object({
          project_id: z.string().min(1),
          module_id: z.string().min(1),
          renderer: z.enum(['netlistsvg', 'grid-experimental']).optional(),
        }),
        serialize: (output) => String(output),
      },
      async ({ project_id, module_id, renderer }) => {
        const root = await resolveProjectRoot(project_id);
        const args = ['compile-module', '--project-root', root, '--module-id', module_id];
        if (renderer) args.push('--renderer', renderer);
        return run(args, 180_000);
      },
    ),
    tool(
      {
        name: 'simulate_circuit_project',
        description: 'Run ngspice simulation for the project build.',
        inputSchema: z.object({
          project_id: z.string().min(1),
        }),
        serialize: (output) => String(output),
      },
      async ({ project_id }) => {
        const root = await resolveProjectRoot(project_id);
        return run(['simulate', '--project-root', root], 180_000);
      },
    ),
    tool(
      {
        name: 'simulate_circuit_module',
        description: 'Run ngspice simulation for one module.',
        inputSchema: z.object({
          project_id: z.string().min(1),
          module_id: z.string().min(1),
        }),
        serialize: (output) => String(output),
      },
      async ({ project_id, module_id }) => {
        const root = await resolveProjectRoot(project_id);
        return run(['simulate-module', '--project-root', root, '--module-id', module_id], 180_000);
      },
    ),
    tool(
      {
        name: 'analog_ic_audit',
        description: 'Validate PDK binding and MOS W/L/M/NF sizing for analog_ic projects.',
        inputSchema: z.object({
          project_id: z.string().min(1),
        }),
        serialize: (output) => String(output),
      },
      async ({ project_id }) => {
        const root = await resolveProjectRoot(project_id);
        return run(['analog-ic-audit', '--project-root', root]);
      },
    ),
    tool(
      {
        name: 'export_eda',
        description: 'Export editable schematic packages (kicad/altium/orcad/virtuoso).',
        inputSchema: z.object({
          project_id: z.string().min(1),
          source_revision: z.number().int().nonnegative(),
          targets: z.array(z.enum(['kicad', 'altium', 'orcad', 'virtuoso'])).min(1),
          scope: z.enum(['project', 'module']).default('project'),
          module_id: z.string().optional(),
          view: z.enum(['design', 'simulation']).default('design'),
        }),
        serialize: (output) => String(output),
      },
      async (input) => {
        const root = await resolveProjectRoot(input.project_id);
        const args = [
          'export-eda',
          '--project-root', root,
          '--scope', input.scope,
          '--view', input.view,
          '--source-revision', String(input.source_revision),
          '--targets', input.targets.join(','),
        ];
        if (input.module_id) args.push('--module-id', input.module_id);
        return run(args, 180_000);
      },
    ),
    tool(
      {
        name: 'prepare_layout_review',
        description: 'Prepare a deterministic routed layout candidate for vision review (does not modify the project).',
        inputSchema: z.object({
          project_id: z.string().min(1),
          module_id: z.string().min(1),
          source_revision: z.number().int().nonnegative(),
          view: z.enum(['design', 'simulation']).default('design'),
          output_dir: z.string().optional(),
        }),
        serialize: (output) => String(output),
      },
      async ({ project_id, module_id, source_revision, view, output_dir }) => {
        const root = await resolveProjectRoot(project_id);
        const out = output_dir || path.join(tmpdir(), 'actoviq-layout', randomUUID());
        await mkdir(out, { recursive: true });
        return run([
          'prepare-layout-review',
          '--project-root', root,
          '--module-id', module_id,
          '--source-revision', String(source_revision),
          '--view', view,
          '--output-dir', out,
        ], 180_000);
      },
    ),
    tool(
      {
        name: 'prepare_layout_from_reference',
        description: 'Check whether a layout/idiom/visual reference can be applied to a module.',
        inputSchema: z.object({
          project_id: z.string().min(1),
          module_id: z.string().min(1),
          asset_id: z.string().min(1),
        }),
        serialize: (output) => String(output),
      },
      async ({ project_id, module_id, asset_id }) => {
        const root = await resolveProjectRoot(project_id);
        return run([
          'prepare-layout-from-reference',
          '--project-root', root,
          '--module-id', module_id,
          '--asset-id', asset_id,
        ]);
      },
    ),
    tool(
      {
        name: 'bridge_list',
        description: 'List linked EDA bridges for a project.',
        inputSchema: z.object({ project_id: z.string().min(1) }),
        serialize: (output) => String(output),
      },
      async ({ project_id }) => {
        const root = await resolveProjectRoot(project_id);
        return run(['bridge-list', '--project-root', root]);
      },
    ),
    tool(
      {
        name: 'bridge_status',
        description: 'Show EDA bridge status for a peer kind.',
        inputSchema: z.object({
          project_id: z.string().min(1),
          peer_kind: z.enum(['kicad', 'jlceda']).optional(),
        }),
        serialize: (output) => String(output),
      },
      async ({ project_id, peer_kind }) => {
        const root = await resolveProjectRoot(project_id);
        const args = ['bridge-status', '--project-root', root];
        if (peer_kind) args.push('--peer-kind', peer_kind);
        return run(args);
      },
    ),
    tool(
      {
        name: 'bridge_link',
        description: 'Link a KiCad or JLCEDA peer folder to the project.',
        inputSchema: z.object({
          project_id: z.string().min(1),
          peer_kind: z.enum(['kicad', 'jlceda']),
          peer_root: z.string().min(1),
          policy: z.enum(['layout_wins', 'connectivity_wins', 'manual_review']).optional(),
        }),
        serialize: (output) => String(output),
      },
      async ({ project_id, peer_kind, peer_root, policy }) => {
        const root = await resolveProjectRoot(project_id);
        const args = [
          'bridge-link',
          '--project-root', root,
          '--peer-kind', peer_kind,
          '--peer-root', peer_root,
        ];
        if (policy) args.push('--policy', policy);
        return run(args);
      },
    ),
    tool(
      {
        name: 'bridge_push',
        description: 'Push Vibe Analog schematic to a linked EDA peer.',
        inputSchema: z.object({
          project_id: z.string().min(1),
          peer_kind: z.enum(['kicad', 'jlceda']),
        }),
        serialize: (output) => String(output),
      },
      async ({ project_id, peer_kind }) => {
        const root = await resolveProjectRoot(project_id);
        return run(['bridge-push', '--project-root', root, '--peer-kind', peer_kind], 180_000);
      },
    ),
    tool(
      {
        name: 'bridge_pull',
        description: 'Pull peer edits into Vibe Analog by stable_id.',
        inputSchema: z.object({
          project_id: z.string().min(1),
          peer_kind: z.enum(['kicad', 'jlceda']),
          policy: z.enum(['layout_wins', 'connectivity_wins', 'manual_review']).optional(),
        }),
        serialize: (output) => String(output),
      },
      async ({ project_id, peer_kind, policy }) => {
        const root = await resolveProjectRoot(project_id);
        const args = ['bridge-pull', '--project-root', root, '--peer-kind', peer_kind];
        if (policy) args.push('--policy', policy);
        return run(args, 180_000);
      },
    ),
    tool(
      {
        name: 'lcsc_search',
        description: 'Search LCSC / 立创商城 parts.',
        inputSchema: z.object({
          query: z.string().min(1),
          use_fallback: z.boolean().optional(),
        }),
        serialize: (output) => String(output),
      },
      async ({ query, use_fallback }) => {
        const args = ['lcsc-search', '--query', query];
        if (use_fallback) args.push('--use-fallback');
        return run(args);
      },
    ),
    tool(
      {
        name: 'lcsc_get',
        description: 'Fetch one LCSC part by C-number.',
        inputSchema: z.object({
          lcsc_id: z.string().min(1),
          use_fallback: z.boolean().optional(),
        }),
        serialize: (output) => String(output),
      },
      async ({ lcsc_id, use_fallback }) => {
        const args = ['lcsc-get', '--lcsc-id', lcsc_id];
        if (use_fallback) args.push('--use-fallback');
        return run(args);
      },
    ),
    tool(
      {
        name: 'lcsc_bind',
        description: 'Bind an LCSC part onto a module component.',
        inputSchema: z.object({
          project_id: z.string().min(1),
          module_id: z.string().min(1),
          component_id: z.string().min(1),
          lcsc_id: z.string().min(1),
          use_fallback: z.boolean().optional(),
        }),
        serialize: (output) => String(output),
      },
      async (input) => {
        const root = await resolveProjectRoot(input.project_id);
        const args = [
          'lcsc-bind',
          '--project-root', root,
          '--module-id', input.module_id,
          '--component-id', input.component_id,
          '--lcsc-id', input.lcsc_id,
        ];
        if (input.use_fallback) args.push('--use-fallback');
        return run(args);
      },
    ),
    tool(
      {
        name: 'reference_catalog_list',
        description: 'List workspace reference catalog assets.',
        inputSchema: z.object({}),
        serialize: (output) => String(output),
      },
      async () => run(['reference-catalog-list']),
    ),
    tool(
      {
        name: 'reference_insert_module',
        description: 'Insert a reference catalog circuit_module into the active project.',
        inputSchema: z.object({
          project_id: z.string().min(1),
          asset_id: z.string().min(1),
          module_id: z.string().optional(),
        }),
        serialize: (output) => String(output),
      },
      async ({ project_id, asset_id, module_id }) => {
        const root = await resolveProjectRoot(project_id);
        const args = [
          'reference-insert-module',
          '--project-root', root,
          '--asset-id', asset_id,
        ];
        if (module_id) args.push('--module-id', module_id);
        return run(args);
      },
    ),
    tool(
      {
        name: 'apply_layout_from_reference',
        description: 'Apply a schematic_layout reference when connectivity_hash matches.',
        inputSchema: z.object({
          project_id: z.string().min(1),
          module_id: z.string().min(1),
          asset_id: z.string().min(1),
        }),
        serialize: (output) => String(output),
      },
      async ({ project_id, module_id, asset_id }) => {
        const root = await resolveProjectRoot(project_id);
        return run([
          'apply-layout-from-reference',
          '--project-root', root,
          '--module-id', module_id,
          '--asset-id', asset_id,
        ]);
      },
    ),
  ];

  if (options.generateTechnicalReport) {
    const generateTechnicalReport = options.generateTechnicalReport;
    tools.push(tool(
      {
        name: 'generate_technical_report',
        description: 'Write a revision-bound AI technical report from verified build/simulation evidence.',
        inputSchema: z.object({
          project_id: z.string().min(1),
          source_revision: z.number().int().nonnegative(),
        }),
        serialize: (output) => String(output),
      },
      async ({ project_id, source_revision }) => {
        const result = await generateTechnicalReport({ projectId: project_id, sourceRevision: source_revision });
        return textResult(result);
      },
    ));
  }

  return tools;
}

export function desktopCircuitToolNames(options?: DesktopCircuitToolsOptions): string[] {
  return createDesktopCircuitTools(options).map((entry) => entry.name);
}
