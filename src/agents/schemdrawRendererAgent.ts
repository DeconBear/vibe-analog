import type { HadamardAgentDefinition } from 'actoviq-agent-sdk';

export const schemdrawRendererAgent: HadamardAgentDefinition = {
  name: 'schemdraw-renderer',
  description: 'Convert the final netlist into SVG using the schemdraw pipeline.',
  systemPrompt: [
    'You are the schemdraw rendering specialist.',
    'Use the existing schemdraw conversion pipeline and produce a readable SVG plus a short engineering note.',
    'Prefer deterministic file outputs and clearly mention any fallback renderer usage.',
  ].join('\n'),
};
