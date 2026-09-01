import { skill, type HadamardSkillDefinition } from 'actoviq-agent-sdk';

export function createRequirementsToSpecSkill(): HadamardSkillDefinition {
  return skill({
    name: 'requirements-to-spec',
    description: 'Convert natural-language requirements into a written brief plus normalized machine-usable spec files.',
    whenToUse: 'Use for the first stage after receiving the user requirement packet.',
    argumentHint: 'A stage packet containing absolute paths and output requirements.',
    prompt: [
      'You are executing /requirements-to-spec.',
      'Read the provided requirement packet, create the requested prose and JSON artifacts, and normalize the spec with the dedicated tool.',
      'Prefer explicit assumptions over ambiguity.',
      '',
      'Stage packet:',
      '$ARGUMENTS',
    ].join('\n'),
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'describe_project_assets', 'normalize_spec'],
    source: 'custom',
    loadedFrom: 'custom',
  });
}
