import { skill, type HadamardSkillDefinition } from 'actoviq-agent-sdk';

export function createJobSlugSkill(): HadamardSkillDefinition {
  return skill({
    name: 'generate-safe-job-slug',
    description: 'Generate a short English kebab-case slug for a workflow job or custom artifact name.',
    whenToUse: 'Use before creating workspace folders or custom named artifacts derived from user requirements.',
    argumentHint: 'A naming packet containing the original user requirement and optional explicit job label.',
    prompt: [
      'You are executing /generate-safe-job-slug.',
      'Return JSON only in this exact schema: {"slug":"kebab-case-name","title":"Short English Title"}.',
      'Rules:',
      '- slug must be ASCII lowercase letters, digits, and hyphens only.',
      '- slug must be 3 to 32 characters.',
      '- slug must not include timestamps, extensions, or path separators.',
      '- title must be concise English, 3 to 8 words, and safe for logs.',
      '- If the user request is in Chinese, translate and summarize it into a short English engineering name.',
      '- Prefer meaningful names like comparator-threshold-switch, not generic names like circuit-job unless the request is too vague.',
      '',
      'Naming packet:',
      '$ARGUMENTS',
    ].join('\n'),
    allowedTools: [],
    source: 'custom',
    loadedFrom: 'custom',
  });
}
