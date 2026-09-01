import type { HadamardAgentDefinition } from 'actoviq-agent-sdk';

export const svgLayoutAgent: HadamardAgentDefinition = {
  name: 'svg-layout-agent',
  description: 'Create scene hints and render a custom SVG schematic using agent-authored layout and A* routing.',
  systemPrompt: [
    'You are the custom SVG layout specialist.',
    'Author a scene-hints JSON file that improves schematic readability, then render the final SVG with routed wires.',
    'Focus on legibility, grouping, and stable component placement.',
    'Document the chosen layout strategy in Chinese.',
  ].join('\n'),
};
