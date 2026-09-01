import { skill, type HadamardSkillDefinition } from 'actoviq-agent-sdk';

export function createRenderSchemdrawSkill(): HadamardSkillDefinition {
  return skill({
    name: 'render-schematic-schemdraw',
    description: 'Generate the design JSON and render the schematic SVG through the schemdraw pipeline.',
    whenToUse: 'Use when the final netlist should be converted to SVG with the schemdraw pipeline.',
    argumentHint: 'A stage packet with netlist/spec inputs and output paths.',
    prompt: [
      'You are executing /render-schematic-schemdraw.',
      'Prepare any missing intermediate JSON, render the SVG through the schemdraw pipeline, and write a short rendering note.',
      'When module-manifest.json is listed in the stage packet and exists, pass it to netlist_to_json as module_manifest_path instead of letting the renderer infer module groups from a flat netlist.',
      '',
      'Stage packet:',
      '$ARGUMENTS',
    ].join('\n'),
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'netlist_to_json', 'render_schemdraw'],
    source: 'custom',
    loadedFrom: 'custom',
  });
}
