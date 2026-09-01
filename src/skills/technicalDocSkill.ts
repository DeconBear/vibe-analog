import { skill, type HadamardSkillDefinition } from 'actoviq-agent-sdk';

export function createTechnicalDocSkill(): HadamardSkillDefinition {
  return skill({
    name: 'technical-doc-package',
    description: 'Write the technical solution document and execution checklist for the requested circuit job.',
    whenToUse: 'Use after the requirement brief and normalized spec have been created.',
    argumentHint: 'A stage packet with absolute paths for the source artifacts and output docs.',
    prompt: [
      'You are executing /technical-doc-package.',
      'Produce implementation-oriented technical documentation based on the supplied artifacts.',
      'Keep the writing concrete, engineering-focused, and easy to execute.',
      'Do not explore the repository during this stage.',
      'Read only the two provided input files, then write the two requested output files.',
      'Use the exact absolute output paths from the stage packet.',
      'Keep each markdown file under 70 lines and avoid large tables.',
      '',
      'Stage packet:',
      '$ARGUMENTS',
    ].join('\n'),
    allowedTools: ['Read', 'Write'],
    source: 'custom',
    loadedFrom: 'custom',
  });
}
