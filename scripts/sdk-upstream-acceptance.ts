import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/**
 * Executable acceptance probes for the upstream SDK defects documented in
 * ACTOVIQ_AGENT_SDK_ISSUES.md. Run this after EVERY actoviq-agent-sdk upgrade:
 *
 *  - exit 0: every known defect still behaves as documented, so the project-side
 *    workarounds remain valid.
 *  - exit 1: at least one probe deviated. Re-validate the matching workaround in
 *    this repo (and update ACTOVIQ_AGENT_SDK_ISSUES.md) before shipping.
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, '..', 'node_modules', 'actoviq-agent-sdk');
const sdkDist = path.join(packageRoot, 'dist', 'src');
const sdkVersion = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')).version;
const results = [];
let failures = 0;

function record(issue, expectation, observed) {
  const changed = observed.status !== expectation;
  if (changed) failures += 1;
  results.push({ issue, expectation, ...observed, changed });
}

// Issue 1: validateInput exists on the tool type but is never invoked by the
// local tool adapter execution chain (createLocalToolAdapter.execute only runs
// schema parse -> execute -> output parse).
{
  const { createLocalToolAdapter } = await import(
    pathToFileURL(path.join(sdkDist, 'runtime', 'tools.js')).href
  );
  let validateInputRan = false;
  const adapter = createLocalToolAdapter({
    name: 'validate_input_probe',
    description: 'probe',
    inputSchema: z.object({ value: z.string() }),
    validateInput: () => {
      validateInputRan = true;
      throw new Error('VALIDATE_INPUT_RAN');
    },
    execute: async () => ({ ok: true }),
  });
  try {
    await adapter.execute({ value: 'x' }, {});
  } catch {
    // execute() throwing (schema or runtime error) is fine; we only care
    // whether validateInput was invoked first.
  }
  record(
    'Issue 1: validateInput not called by local tool adapter',
    'STILL_BROKEN',
    {
      status: validateInputRan ? 'FIXED_OR_CHANGED' : 'STILL_BROKEN',
      detail: validateInputRan
        ? 'validateInput ran during adapter.execute — remove the project-side double-validation workarounds.'
        : 'validateInput is still skipped in the real execution chain; keep project-side hard validation.',
    },
  );
}

// Issue 2: the OpenAI-compatible adapter flattens Anthropic-style tool_result
// content arrays to text only, dropping image blocks, so vision round-trips
// break on OpenAI/DeepSeek-compatible providers.
{
  const source = await readFile(path.join(sdkDist, 'provider', 'openai-model-api.js'), 'utf8');
  const brokenPattern = /Array\.isArray\(tr\.content\)\s*\?\s*tr\.content\.map\(\(c\)\s*=>\s*\(typeof c === 'object' && c !== null && 'text' in c \? c\.text : ''\)\)\.join\(''\)/;
  const imageInToolResultPattern = /tool_result[\s\S]{0,600}image_url/i;
  const stillBroken = brokenPattern.test(source) && !imageInToolResultPattern.test(source);
  record(
    'Issue 2: OpenAI adapter drops images in tool_result content arrays',
    'STILL_BROKEN',
    {
      status: stillBroken ? 'STILL_BROKEN' : 'FIXED_OR_CHANGED',
      detail: stillBroken
        ? 'tool_result content arrays are still flattened to text; keep the openAiVisionModelApi wrapper.'
        : 'tool_result image handling changed upstream — re-validate vision round-trips and the wrapper.',
    },
  );
}

// Issue 6: SDK persists raw provider error bodies (which may echo Authorization
// headers / api keys) into <sessionDirectory>/agent-executions without redaction.
{
  const source = await readFile(path.join(sdkDist, 'storage', 'agentExecutionStore.js'), 'utf8');
  const hasRedaction = /redact/i.test(source);
  record(
    'Issue 6: provider error text persisted unredacted to agent-executions store',
    'STILL_BROKEN',
    {
      status: hasRedaction ? 'FIXED_OR_CHANGED' : 'STILL_BROKEN',
      detail: hasRedaction
        ? 'agentExecutionStore mentions redaction — re-validate whether sanitizedModelApi can be retired.'
        : 'No redaction in the audit store path; keep sanitizedModelApi at the ModelApi boundary.',
    },
  );
}

// Issue 7: CodeCell declares isDestructive, so under permissionMode 'default'
// without an approver the embedded CodeAct loop is denied on its first action.
// The desktop workaround whitelists all tools via permission rules.
{
  const { decideHadamardToolPermission } = await import(
    pathToFileURL(path.join(sdkDist, 'runtime', 'hadamardPermissions.js')).href
  );
  const baseInput = {
    toolName: 'CodeCell',
    publicName: 'CodeCell',
    toolInput: { code: '1 + 1' },
    mode: 'default',
    rules: [],
    // CodeCell declares isDestructive on its tool adapter (codeCellTool.js).
    adapter: { isDestructive: () => true },
    workDir: process.cwd(),
  };
  const denied = await decideHadamardToolPermission(baseInput);
  const allowedWithRule = await decideHadamardToolPermission({
    ...baseInput,
    rules: [{ toolName: '*', behavior: 'allow' }],
  });
  const stillBroken = denied.behavior === 'deny' && allowedWithRule.behavior === 'allow';
  record(
    "Issue 7: CodeCell denied under permissionMode 'default' without approver",
    'STILL_BROKEN',
    {
      status: stillBroken ? 'STILL_BROKEN' : 'FIXED_OR_CHANGED',
      detail: stillBroken
        ? "default+' deny / '*'+'allow' workaround remains required for the embedded CodeAct loop."
        : `CodeCell permission behavior changed (deny=${denied.behavior}, ruleAllow=${allowedWithRule.behavior}) — re-validate createAgentSdk permissions.`,
    },
  );
}

console.log(`SDK upstream acceptance probes (actoviq-agent-sdk ${sdkVersion}):`);
for (const result of results) {
  const marker = result.changed ? 'CHANGED' : 'OK    ';
  console.log(`  [${marker}] ${result.issue}`);
  console.log(`           expected=${result.expectation} observed=${result.status}`);
  console.log(`           ${result.detail}`);
}

if (failures > 0) {
  console.error(
    `\n${failures} probe(s) deviated from the documented behavior. ` +
      'Re-validate the affected workarounds and update ACTOVIQ_AGENT_SDK_ISSUES.md before shipping.',
  );
  process.exit(1);
}
console.log('\nAll documented workarounds remain valid for this SDK version.');
