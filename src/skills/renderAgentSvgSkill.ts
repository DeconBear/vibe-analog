import { skill, type HadamardSkillDefinition } from 'actoviq-agent-sdk';

export function createRenderAgentSvgSkill(): HadamardSkillDefinition {
  return skill({
    name: 'render-schematic-agent-svg',
    description: 'Create scene hints, then render a custom SVG with agent-authored layout plus A* wiring.',
    whenToUse: 'Use when the final netlist should be converted to a custom SVG layout.',
    argumentHint: 'A stage packet with netlist/spec inputs and output paths.',
    prompt: [
      'You are executing /render-schematic-agent-svg.',
      'Build the requested scene-hints JSON, render the SVG with the custom pipeline, and document the layout choices.',
      'When module-manifest.json is listed in the stage packet and exists, pass it to netlist_to_json as module_manifest_path so scene hints augment, rather than replace, the design-time module partition.',
      '',
      'Write discipline:',
      '- Keep scene-hints.json compact: title plus at most 12 explicit placements.',
      '- Do not enumerate every component. Let render_agent_svg auto-place unlisted components.',
      '- If a detailed scene-hints Write fails, immediately write a minimal fallback: {"title":"Agent layout","placements":[]}.',
      '- Keep agent-layout-notes.md under 50 lines and avoid tables.',
      '',
      'Stage packet:',
      '$ARGUMENTS',
    ].join('\n'),
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'netlist_to_json', 'render_agent_svg'],
    source: 'custom',
    loadedFrom: 'custom',
  });
}
