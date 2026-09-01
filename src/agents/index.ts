import type { HadamardAgentDefinition } from 'actoviq-agent-sdk';

import { architectAgent } from './architectAgent.js';
import { docWriterAgent } from './docWriterAgent.js';
import { errorExplainerAgent } from './errorExplainerAgent.js';
import { jobSluggerAgent } from './jobSluggerAgent.js';
import { librarianAgent } from './librarianAgent.js';
import { netlistDesignerAgent } from './netlistDesignerAgent.js';
import { netlistsvgRendererAgent } from './netlistsvgRendererAgent.js';
import { schemdrawRendererAgent } from './schemdrawRendererAgent.js';
import { simulationVerifierAgent } from './simulationVerifierAgent.js';
import { solutionAnalystAgent } from './solutionAnalystAgent.js';
import { svgLayoutAgent } from './svgLayoutAgent.js';
import { workflowLeadAgent } from './workflowLeadAgent.js';

export function getWorkflowAgents(): HadamardAgentDefinition[] {
  return [
    jobSluggerAgent,
    errorExplainerAgent,
    solutionAnalystAgent,
    docWriterAgent,
    librarianAgent,
    architectAgent,
    netlistDesignerAgent,
    simulationVerifierAgent,
    netlistsvgRendererAgent,
    schemdrawRendererAgent,
    svgLayoutAgent,
    workflowLeadAgent,
  ];
}
