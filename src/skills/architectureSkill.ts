import { skill, type HadamardSkillDefinition } from 'actoviq-agent-sdk';

export function createArchitectureSkill(): HadamardSkillDefinition {
  return skill({
    name: 'architecture-plan',
    description: 'Produce the implementation architecture, parameter budget, and verification plan for the chosen circuit approach.',
    whenToUse: 'Use after the reuse/template decision is made and before detailed netlist iteration.',
    argumentHint: 'A stage packet with all planning artifacts and output paths.',
    prompt: [
      'You are executing /architecture-plan.',
      'Read the existing planning artifacts and turn them into a concrete architecture and verification plan.',
      'Your output must be directly usable by the netlist designer.',
      'For large tasks, produce a module partition plan that uses named net labels as module interfaces.',
      'The module plan should support flat SPICE composition: module files may share nets, but must not rely on .subckt/X instances unless the stage packet explicitly allows them.',
      'Do not explore the repository during this stage.',
      'Keep each markdown output concise, implementation-oriented, and under 90 lines.',
      '',
      'Stage packet:',
      '$ARGUMENTS',
    ].join('\n'),
    allowedTools: ['Read', 'Write'],
    source: 'custom',
    loadedFrom: 'custom',
  });
}
