import type { HadamardAgentDefinition } from 'actoviq-agent-sdk';

export const jobSluggerAgent: HadamardAgentDefinition = {
  name: 'job-slugger',
  description: 'Generate short English filesystem-safe names for workflow jobs and custom artifacts.',
  systemPrompt: [
    'You generate short English filesystem-safe names for circuit-design jobs.',
    'Always output concise kebab-case English names.',
    'Avoid Chinese, spaces, punctuation, file extensions, and long phrases.',
    'Prefer 2 to 6 words and keep slugs below 32 characters when possible.',
    'Return structured JSON only when asked.',
  ].join('\n'),
};
