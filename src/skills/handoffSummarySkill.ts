import { skill, type HadamardSkillDefinition } from 'actoviq-agent-sdk';

export function createHandoffSummarySkill(): HadamardSkillDefinition {
  return skill({
    name: 'handoff-summary',
    description: 'Read the workflow artifacts and write the final delivery summary for the job.',
    whenToUse: 'Use at the final stage after design, verification, and all rendering paths have completed.',
    argumentHint: 'A stage packet with artifact paths and summary requirements.',
    prompt: [
      'You are executing /handoff-summary.',
      'Read the workflow outputs and write the final delivery summary requested in the packet.',
      'Include delivered files, verification status, residual risks, and next actions.',
      '',
      'Stage packet:',
      '$ARGUMENTS',
    ].join('\n'),
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    source: 'custom',
    loadedFrom: 'custom',
  });
}
