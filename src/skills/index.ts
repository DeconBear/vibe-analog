import type { HadamardSkillDefinition } from 'actoviq-agent-sdk';

import { createArchitectureSkill } from './architectureSkill.js';
import { createAssetReuseSkill } from './assetReuseSkill.js';
import { createClosedLoopNetlistDesignSkill } from './closedLoopNetlistDesignSkill.js';
import { createErrorExplanationSkill } from './errorExplanationSkill.js';
import { createFinalVerificationSkill } from './finalVerificationSkill.js';
import { createHandoffSummarySkill } from './handoffSummarySkill.js';
import { createJobSlugSkill } from './jobSlugSkill.js';
import { createRenderAgentSvgSkill } from './renderAgentSvgSkill.js';
import { createRenderNetlistsvgSkill } from './renderNetlistsvgSkill.js';
import { createRenderSchemdrawSkill } from './renderSchemdrawSkill.js';
import { createRequirementsToSpecSkill } from './requirementsToSpecSkill.js';
import { createTechnicalDocSkill } from './technicalDocSkill.js';
import { createVisionLayoutReviewSkill } from './visionLayoutReviewSkill.js';

export function getWorkflowSkills(): HadamardSkillDefinition[] {
  return [
    createJobSlugSkill(),
    createRequirementsToSpecSkill(),
    createTechnicalDocSkill(),
    createAssetReuseSkill(),
    createArchitectureSkill(),
    createClosedLoopNetlistDesignSkill(),
    createErrorExplanationSkill(),
    createFinalVerificationSkill(),
    createRenderNetlistsvgSkill(),
    createRenderSchemdrawSkill(),
    createRenderAgentSvgSkill(),
    createVisionLayoutReviewSkill(),
    createHandoffSummarySkill(),
  ];
}
