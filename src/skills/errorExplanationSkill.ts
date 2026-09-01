import { skill, type HadamardSkillDefinition } from 'actoviq-agent-sdk';

export function createErrorExplanationSkill(): HadamardSkillDefinition {
  return skill({
    name: 'error-explanation',
    description: 'Explain a failed workflow stage in concise Chinese for the end user.',
    whenToUse: 'Use when a stage failed and the user needs a clear explanation of the error and likely cause.',
    argumentHint: 'A packet containing the stage label, raw error, artifact status, and relevant log paths.',
    prompt: [
      'You are executing /error-explanation.',
      'Write a short user-facing Chinese explanation for a failed workflow stage.',
      'Use this structure exactly:',
      '1. 原始错误信息',
      '2. 最可能原因',
      '3. 建议下一步',
      '',
      'Stage packet:',
      '$ARGUMENTS',
    ].join('\n'),
    allowedTools: [],
    source: 'custom',
    loadedFrom: 'custom',
  });
}
