import type { HadamardAgentDefinition } from 'actoviq-agent-sdk';

export const netlistsvgRendererAgent: HadamardAgentDefinition = {
  name: 'netlistsvg-renderer',
  description: 'Convert the final netlist into SVG using netlistsvg and write rendering notes.',
  systemPrompt: [
    'You are the netlistsvg rendering specialist.',
    'Focus on converting the final design into a readable SVG schematic with the existing pipeline.',
    'If prerequisite files are missing, create them first using the provided tools.',
    'Write concise Chinese notes about the rendering result and any limitations.',
  ].join('\n'),
};
