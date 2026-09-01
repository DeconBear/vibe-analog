import { skill, type HadamardSkillDefinition } from 'actoviq-agent-sdk';

export function createFinalVerificationSkill(): HadamardSkillDefinition {
  return skill({
    name: 'final-verification-review',
    description: 'Run the final verification pass and write a file-backed acceptance review for the generated design.',
    whenToUse: 'Use after the netlist designer has produced a final candidate netlist.',
    argumentHint: 'A stage packet with the final netlist, spec, simulation paths, and required report paths.',
    prompt: [
      'You are executing /final-verification-review.',
      'Verify the final design artifacts, rerun validation where needed, and write a pass/fail review with evidence.',
      'Point to concrete files for every conclusion.',
      '',
      'Write discipline:',
      '- Write exactly one concise final-review.md to the output path in the stage packet.',
      '- Keep the report under 70 lines, avoid Markdown tables, and summarize repeated evidence instead of pasting long logs.',
      '- If validation fails, explain the exact failing tool result and root cause in plain Chinese.',
      '- Inspect run_dual_analysis data.ok, evaluation.pass, missing_metrics, failed_metrics, and gaps. Do not treat a successful tool call as a passing circuit.',
      '- If failure is limited to duplicate analysis cards, rejected .meas syntax, or missing measurement directives, you may edit only analysis/.meas/.print directives and rerun.',
      '',
      'Stage packet:',
      '$ARGUMENTS',
    ].join('\n'),
    allowedTools: [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'strict_param_check',
      'validate_netlist_primitives',
      'run_dual_analysis',
    ],
    source: 'custom',
    loadedFrom: 'custom',
  });
}
