import { skill, type HadamardSkillDefinition } from 'actoviq-agent-sdk';

export function createRenderNetlistsvgSkill(): HadamardSkillDefinition {
  return skill({
    name: 'render-schematic-netlistsvg',
    description: 'Generate the design JSON and render the schematic SVG through netlistsvg.',
    whenToUse: 'Use when the final netlist should be converted to SVG with the existing netlistsvg pipeline.',
    argumentHint: 'A stage packet with netlist/spec inputs and output paths.',
    prompt: [
      'You are executing /render-schematic-netlistsvg.',
      'Prepare any missing intermediate JSON, render the SVG through netlistsvg, and write a short rendering note.',
      'Call netlist_to_json with view set to schematic so bench-only sources stay out of the user-facing diagram while required control and bias nodes remain connected terminals.',
      'When module-manifest.json is listed in the stage packet and exists, pass it to netlist_to_json as module_manifest_path so module sheets and block order come from the design-stage manifest.',
      'For large partitioned circuits, the final SVG must be a single partitioned sheet: every partition embeds direct netlistsvg output, and partitions connect by matching net labels only with no cross-partition signal or rail wires.',
      'Prefer improving the netlistsvg input partitioning over hand-drawn SVG post-processing.',
      'Partition by circuit function, not by individual primitives: use blocks such as input bias, gain core, feedback network, RC filter, threshold reference, comparator core, and output driver.',
      'Do not split a circuit into one-resistor/one-transistor subcircuits except for an explicit debug artifact; normal user-facing schematics must remain functional subgraphs.',
      'Do not write temporary scripts, manual partition netlists, or hand-authored SVG. The render_netlistsvg backend owns all large-circuit partition fallback behavior.',
      'After render_netlistsvg returns, stop. If notes are missing, workflow fallback will create them.',
      '',
      'Stage packet:',
      '$ARGUMENTS',
    ].join('\n'),
    allowedTools: ['Read', 'netlist_to_json', 'render_netlistsvg'],
    source: 'custom',
    loadedFrom: 'custom',
  });
}
