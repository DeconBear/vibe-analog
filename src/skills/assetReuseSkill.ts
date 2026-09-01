import { skill, type HadamardSkillDefinition } from 'actoviq-agent-sdk';

export function createAssetReuseSkill(): HadamardSkillDefinition {
  return skill({
    name: 'asset-reuse-plan',
    description: 'Inspect bundled templates and helpers, choose the closest reusable template, and prepare the starting point.',
    whenToUse: 'Use before topology refinement and netlist design.',
    argumentHint: 'A stage packet with bundled asset paths, target files, and output paths.',
    prompt: [
      'You are executing /asset-reuse-plan.',
      'Survey the bundled reusable assets, pick the most suitable template, and prepare the starter files requested in the packet.',
      'Be explicit about which bundled capabilities are reused and why.',
      'Keep asset-reuse-plan.md concise: no tables, 6 short sections maximum, 80 lines maximum.',
      'Do not paste or rewrite a full template netlist with Write.',
      'Use copy_template_netlist for the starter template file.',
      '',
      'Stage packet:',
      '$ARGUMENTS',
    ].join('\n'),
    allowedTools: [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'describe_project_assets',
      'list_available_templates',
      'copy_template_netlist',
    ],
    source: 'custom',
    loadedFrom: 'custom',
  });
}
