import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import type {
  ModelApi,
  ModelRequest,
  ModelStreamHandle,
  ToolExecutionContext,
} from 'actoviq-agent-sdk';

import { parseCliOptions } from '../app.js';
import { createWorkspaceFileTools } from '../tools/fileTools.js';
import { createSchematicVisionImageTool } from '../tools/renderTools.js';
import { registerCircuitTools } from '../tools/registerCircuitTools.js';
import { getWorkflowSkills } from '../skills/index.js';
import { createOpenAiVisionModelApi } from '../vision/openAiVisionModelApi.js';
import { createVisionLayoutReviewHost } from '../vision/visionLayoutReviewHost.js';
import { LayoutPatchProtocolError, parseLayoutPatchSetText } from '../vision/layoutPatchProtocol.js';
import { parseTuiCommand } from '../tui/commandParser.js';
import { TuiStateStore } from '../tui/TuiState.js';
import { classifyError } from '../utils/errors.js';
import {
  listSavedDesignFlows,
  listSavedDesignTemplates,
  resolveSavedTemplateNetlist,
} from '../utils/designMemory.js';
import {
  composeFinalNetlistFromModules,
  formatCompactScalar,
  parseMeasurementLines,
  parseSpiceScalar,
  repairSignalChainComparatorNetlist,
} from '../utils/workflowFixups.js';
import {
  buildJobId,
  buildUniqueJobId,
  type JobPaths,
} from '../workflow/circuitDesignWorkflow.js';
import { createWorkflowStages } from '../workflow/stagePromptRegistry.js';

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const tests: TestCase[] = [];

function test(name: string, run: TestCase['run']): void {
  tests.push({ name, run });
}

function createToolContext(cwd: string): ToolExecutionContext {
  return {
    runId: 'unit-test',
    cwd,
    metadata: {},
    prompt: 'unit test',
    iteration: 1,
  };
}

function createTestJobPaths(jobRoot: string): JobPaths {
  const inputsDir = path.resolve(jobRoot, 'inputs');
  const planningDir = path.resolve(jobRoot, 'planning');
  const designDir = path.resolve(jobRoot, 'design');
  const verificationDir = path.resolve(jobRoot, 'verification');
  const simulationDir = path.resolve(jobRoot, 'simulation');
  const finalSimulationDir = path.resolve(simulationDir, 'final');
  const renderDir = path.resolve(jobRoot, 'render');
  const reportsDir = path.resolve(jobRoot, 'reports');
  const logsDir = path.resolve(jobRoot, 'logs');
  return {
    jobId: path.basename(jobRoot),
    jobRoot,
    inputsDir,
    planningDir,
    designDir,
    verificationDir,
    simulationDir,
    finalSimulationDir,
    renderDir,
    reportsDir,
    logsDir,
    userRequirementPath: path.resolve(inputsDir, 'user-requirements.md'),
    requirementBriefPath: path.resolve(planningDir, 'requirements-brief.md'),
    specRawPath: path.resolve(planningDir, 'spec.raw.json'),
    specNormalizedPath: path.resolve(planningDir, 'spec.normalized.json'),
    technicalSolutionPath: path.resolve(planningDir, 'technical-solution.md'),
    executionChecklistPath: path.resolve(planningDir, 'execution-checklist.md'),
    assetReusePlanPath: path.resolve(planningDir, 'asset-reuse-plan.md'),
    architecturePath: path.resolve(planningDir, 'architecture.md'),
    verificationPlanPath: path.resolve(planningDir, 'verification-plan.md'),
    modulePlanPath: path.resolve(planningDir, 'module-plan.json'),
    templateNetlistPath: path.resolve(designDir, 'template.cir'),
    modulesDir: path.resolve(designDir, 'modules'),
    moduleManifestPath: path.resolve(designDir, 'module-manifest.json'),
    designFinalPath: path.resolve(designDir, 'design.final.cir'),
    designNotesPath: path.resolve(designDir, 'design-notes.md'),
    detailedDesignReportPath: path.resolve(designDir, 'detailed-design-report.md'),
    patchPlanPath: path.resolve(designDir, 'patch-plan.json'),
    strictCheckPath: path.resolve(verificationDir, 'strict-param-check.json'),
    primitiveCheckPath: path.resolve(verificationDir, 'primitive-check.json'),
    finalReviewPath: path.resolve(verificationDir, 'final-review.md'),
    designJsonPath: path.resolve(renderDir, 'design.json'),
    netlistsvgPath: path.resolve(renderDir, 'netlistsvg.svg'),
    netlistsvgGeometryPath: path.resolve(renderDir, 'netlistsvg.geometry.json'),
    netlistsvgLayoutReportPath: path.resolve(renderDir, 'netlistsvg.layout-report.json'),
    netlistsvgNotesPath: path.resolve(renderDir, 'netlistsvg-notes.md'),
    schemdrawPath: path.resolve(renderDir, 'schemdraw.svg'),
    schemdrawNotesPath: path.resolve(renderDir, 'schemdraw-notes.md'),
    sceneHintsPath: path.resolve(renderDir, 'scene-hints.json'),
    agentSvgPath: path.resolve(renderDir, 'agent-layout.svg'),
    agentSvgNotesPath: path.resolve(renderDir, 'agent-layout-notes.md'),
    finalSummaryPath: path.resolve(reportsDir, 'final-summary.md'),
    manifestPath: path.resolve(reportsDir, 'manifest.json'),
    workflowStatePath: path.resolve(reportsDir, 'workflow-state.json'),
  };
}

test('vision layout tool is isolated from text runs and returns a PNG image block for explicit vision runs', async () => {
  const root = path.resolve(process.cwd(), '.tmp-unit-tests', `vision-layout-${Date.now()}`);
  const svgPath = path.resolve(root, 'schematic.svg');
  await mkdir(root, { recursive: true });
  await writeFile(svgPath, [
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">',
    '<rect width="320" height="180" fill="white"/>',
    '<rect x="100" y="60" width="120" height="60" fill="white" stroke="#a00020" stroke-width="3"/>',
    '<path d="M20 90H100M220 90H300" fill="none" stroke="#188038" stroke-width="4"/>',
    '<text x="134" y="96" font-size="18">R1 47k</text>',
    '</svg>',
  ].join(''), 'utf8');
  try {
    const visionTool = createSchematicVisionImageTool();
    assert.match(visionTool.description, /VISION-MODEL ONLY/);
    assert.equal(
      registerCircuitTools(root).some((entry) => entry.name === 'view_schematic_for_layout'),
      false,
      'the default/text workflow tool catalog must not expose the vision-only tool',
    );
    const unspecified = await visionTool.validateInput?.(
      { svg_path: svgPath },
      createToolContext(root),
    );
    assert.deepEqual(unspecified, {
      result: false,
      message: 'view_schematic_for_layout requires an explicitly vision-capable run; text-only or unspecified models cannot call it.',
    });
    const denied = await visionTool.validateInput?.(
      { svg_path: svgPath },
      { ...createToolContext(root), metadata: { vision_capable: false } },
    );
    assert.deepEqual(denied, {
      result: false,
      message: 'view_schematic_for_layout requires an explicitly vision-capable run; text-only or unspecified models cannot call it.',
    });
    await assert.rejects(
      async () => visionTool.execute({ svg_path: svgPath }, createToolContext(root)),
      /requires an explicitly vision-capable run/,
    );
    await assert.rejects(
      async () => visionTool.execute(
        { svg_path: svgPath },
        { ...createToolContext(root), metadata: { vision_capable: false } },
      ),
      /requires an explicitly vision-capable run/,
    );
    const output = await visionTool.execute(
      { svg_path: svgPath },
      { ...createToolContext(root), metadata: { model_capabilities: ['vision'] } },
    );
    assert.equal(output.schema, 'actoviq.vision-layout-image.v1');
    assert.equal(output.mediaType, 'image/png');
    assert.ok(Number(output.width) > 0 && Number(output.height) > 0);
    const png = Buffer.from(String(output.imageBase64), 'base64');
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const content = visionTool.serialize?.(output) as Array<Record<string, unknown>>;
    assert.equal(content[0]?.type, 'text');
    assert.equal(content[1]?.type, 'image');
    assert.equal((content[1]?.source as Record<string, unknown>).media_type, 'image/png');
    const preRenderedPath = path.resolve(root, 'trusted-preview.png');
    await writeFile(preRenderedPath, png);
    const requiredImageContext = {
      ...createToolContext(root),
      metadata: { model_capabilities: ['vision'], required_layout_image_path: preRenderedPath },
    };
    assert.deepEqual(
      await visionTool.validateInput?.({ svg_path: svgPath }, requiredImageContext),
      { result: false, message: 'This layout review must use the trusted pre-rendered image_path from its stage packet.' },
    );
    const preRendered = await visionTool.execute(
      { image_path: preRenderedPath },
      requiredImageContext,
    );
    assert.equal(preRendered.sourceKind, 'png');
    assert.equal(preRendered.rasterizer, 'pre-rendered');
    assert.equal(preRendered.sha256, output.sha256);
    assert.equal(preRendered.width, output.width);
    assert.equal(preRendered.height, output.height);

    const visionSkill = getWorkflowSkills().find((entry) => entry.name === 'review-schematic-layout-vision');
    assert.ok(visionSkill);
    assert.equal(visionSkill.metadata?.required_modality, 'vision');
    assert.equal(visionSkill.disableModelInvocation, true);
    assert.equal(visionSkill.inheritDefaultTools, false);
    assert.deepEqual(visionSkill.allowedTools, ['view_schematic_for_layout']);
    assert.equal(visionSkill.tools?.some((entry) => entry.name === 'view_schematic_for_layout'), true);
    assert.match(visionSkill.prompt ?? '', /text-only model, do NOT call view_schematic_for_layout/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('OpenAI vision ModelApi promotes tool-result images for create and stream requests', async () => {
  const pngBase64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
  const request: ModelRequest = {
    model: 'vision-test',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'vision-call',
        content: [{ type: 'text', text: '{"ok":true}' }, {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: pngBase64 },
        }],
      }],
    }],
  };
  const captured: ModelRequest[] = [];
  const finalMessage = {
    id: 'vision-final',
    type: 'message' as const,
    role: 'assistant' as const,
    model: 'vision-test',
    content: [{ type: 'text', text: 'done' }],
    stop_reason: 'end_turn',
  };
  const streamHandle: ModelStreamHandle = {
    finalMessage: async () => finalMessage,
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_stop' as const };
    },
  };
  const baseModelApi: ModelApi = {
    createMessage: async (next) => {
      captured.push(next);
      return finalMessage;
    },
    streamMessage: (next) => {
      captured.push(next);
      return streamHandle;
    },
  };
  const wrapped = createOpenAiVisionModelApi(baseModelApi);
  await wrapped.createMessage(request);
  wrapped.streamMessage(request);

  assert.equal(captured.length, 2);
  for (const promoted of captured) {
    assert.equal(promoted.messages.length, 2);
    const toolResult = promoted.messages[0]?.content;
    assert.ok(Array.isArray(toolResult));
    assert.equal(toolResult[0]?.type, 'tool_result');
    assert.equal(
      Array.isArray(toolResult[0]?.content)
        && toolResult[0].content.some((entry) => entry.type === 'image'),
      false,
    );
    const imageMessage = promoted.messages[1];
    assert.equal(imageMessage?.role, 'user');
    assert.ok(Array.isArray(imageMessage?.content));
    assert.equal(imageMessage.content[0]?.type, 'image');
    assert.equal(
      (imageMessage.content[0] as Record<string, any>).source.data,
      pngBase64,
    );
  }
});

test('trusted vision host runs the isolated skill through SDK and forwards the rendered PNG', async () => {
  const root = path.resolve(process.cwd(), '.tmp-unit-tests', `vision-host-${Date.now()}`);
  const svgPath = path.resolve(root, 'schematic.svg');
  const imagePath = path.resolve(root, 'schematic.png');
  const qualityPath = path.resolve(root, 'layout-quality.json');
  await mkdir(root, { recursive: true });
  await writeFile(svgPath, [
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100" viewBox="0 0 160 100">',
    '<rect width="160" height="100" fill="white"/>',
    '<path d="M10 50H150" stroke="#188038" stroke-width="4"/>',
    '</svg>',
  ].join(''), 'utf8');
  await writeFile(imagePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ));
  await writeFile(qualityPath, JSON.stringify({
    schema: 'actoviq.layout-quality.v1',
    readability_score: 82,
  }), 'utf8');

  const requests: ModelRequest[] = [];
  const fakeModelApi: ModelApi = {
    createMessage: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          id: 'vision-tool-request',
          type: 'message',
          role: 'assistant',
          model: 'vision-test',
          content: [{
            type: 'tool_use',
            id: 'vision-call',
            name: 'view_schematic_for_layout',
            input: { image_path: imagePath },
          }],
          stop_reason: 'tool_use',
        };
      }
      return {
        id: 'vision-complete',
        type: 'message',
        role: 'assistant',
        model: 'vision-test',
        content: [{
          type: 'text',
          text: JSON.stringify({
            schema: 'actoviq.layout-patch-set.v1',
            source_revision: 7,
            connectivity_hash: 'a'.repeat(64),
            candidates: [],
          }),
        }],
        stop_reason: 'end_turn',
      };
    },
    streamMessage: () => {
      throw new Error('The non-streaming host test must not call streamMessage.');
    },
  };

  let host: Awaited<ReturnType<typeof createVisionLayoutReviewHost>> | undefined;
  try {
    await assert.rejects(
      () => createVisionLayoutReviewHost({
        provider: 'openai',
        model: 'text-test',
        modelCapabilities: ['text'],
        workDir: root,
        homeDir: path.resolve(root, '.actoviq-text'),
        modelApi: fakeModelApi,
      }),
      /trusted vision-capable model configuration is required/,
    );
    assert.equal(requests.length, 0);

    const bypassHost = await createVisionLayoutReviewHost({
      provider: 'openai',
      model: 'vision-bypass-test',
      modelCapabilities: ['vision'],
      workDir: root,
      homeDir: path.resolve(root, '.actoviq-bypass'),
      modelApi: {
        createMessage: async () => ({
          id: 'vision-bypass',
          type: 'message',
          role: 'assistant',
          model: 'vision-bypass-test',
          content: [{
            type: 'text',
            text: JSON.stringify({
              schema: 'actoviq.layout-patch-set.v1',
              source_revision: 7,
              connectivity_hash: 'a'.repeat(64),
              candidates: [],
            }),
          }],
          stop_reason: 'end_turn',
        }),
        streamMessage: () => {
          throw new Error('The bypass test must not call streamMessage.');
        },
      },
    });
    try {
      await assert.rejects(
        () => bypassHost.review({
          svgPath,
          imagePath,
          layoutQualityReportPath: qualityPath,
          moduleId: 'filter',
          sourceRevision: 7,
          connectivityHash: 'a'.repeat(64),
        }),
        /must call view_schematic_for_layout exactly once/,
      );
    } finally {
      await bypassHost.close();
    }

    host = await createVisionLayoutReviewHost({
      provider: 'openai',
      model: 'vision-test',
      modelCapabilities: ['vision'],
      workDir: root,
      homeDir: path.resolve(root, '.actoviq'),
      modelApi: fakeModelApi,
    });
    const result = await host.review({
      svgPath,
      imagePath,
      layoutQualityReportPath: qualityPath,
      moduleId: 'filter',
      sourceRevision: 7,
      connectivityHash: 'a'.repeat(64),
    });

    assert.equal(result.rawResult.toolCalls.length, 1);
    assert.equal(result.rawResult.toolCalls[0]?.publicName, 'view_schematic_for_layout');
    assert.deepEqual(result.rawResult.toolCalls[0]?.input, { image_path: imagePath });
    assert.equal(result.patchSet.schema, 'actoviq.layout-patch-set.v1');
    assert.equal(result.patchSet.source_revision, 7);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0]?.tools?.map((entry) => entry.name), ['view_schematic_for_layout']);
    const firstRequestContent = requests[0]?.messages[0]?.content;
    assert.ok(Array.isArray(firstRequestContent));
    const stagePrompt = String(firstRequestContent.find((entry) => entry.type === 'text')?.text ?? '');
    assert.match(
      stagePrompt,
      /"layout_quality_report":\{"schema":"actoviq\.layout-quality\.v1","readability_score":82\}/,
    );
    assert.match(stagePrompt, /"image_path":/);
    const secondMessages = requests[1]?.messages ?? [];
    const resultIndex = secondMessages.findIndex((message) => (
      Array.isArray(message.content)
      && message.content.some((entry) => entry.type === 'tool_result')
    ));
    assert.ok(resultIndex >= 0);
    const imageMessage = secondMessages[resultIndex + 1];
    assert.equal(imageMessage?.role, 'user');
    assert.ok(Array.isArray(imageMessage?.content));
    const image = imageMessage.content.find((entry) => entry.type === 'image') as Record<string, any> | undefined;
    assert.ok(image);
    assert.equal(image.source.media_type, 'image/png');
    const png = Buffer.from(String(image.source.data), 'base64');
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  } finally {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('vision layout patch-set parser rejects prose, stale sources, unknown fields, and unsafe operations', () => {
  const expected = { sourceRevision: 9, connectivityHash: 'b'.repeat(64) };
  const valid = {
    schema: 'actoviq.layout-patch-set.v1',
    source_revision: 9,
    connectivity_hash: 'b'.repeat(64),
    candidates: [{
      schema: 'actoviq.layout-patch.v1',
      operations: [
        { op: 'move_component', component_id: 'r1', dx_grid: 2, dy_grid: -1 },
        { op: 'rotate_component', component_id: 'r1', rotation: 90 },
        { op: 'move_port', port_id: 'out', dx_grid: 1, dy_grid: 0 },
        { op: 'set_block_pin_side', component_id: 'u1', pin_id: 'out', side: 'right' },
        { op: 'set_layout_lane', component_id: 'r1', rank: 2, lane: -1 },
      ],
    }],
  };
  assert.deepEqual(parseLayoutPatchSetText(JSON.stringify(valid), expected), valid);

  const reject = (payload: unknown, code: LayoutPatchProtocolError['code']) => {
    assert.throws(
      () => parseLayoutPatchSetText(typeof payload === 'string' ? payload : JSON.stringify(payload), expected),
      (error: unknown) => error instanceof LayoutPatchProtocolError && error.code === code,
    );
  };
  reject(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``, 'INVALID_JSON');
  reject({ ...valid, source_revision: 8 }, 'SOURCE_REVISION_MISMATCH');
  reject({ ...valid, connectivity_hash: 'c'.repeat(64) }, 'CONNECTIVITY_HASH_MISMATCH');
  reject({ ...valid, explanation: 'looks better' }, 'INVALID_SCHEMA');
  reject({
    ...valid,
    candidates: [{ schema: 'actoviq.layout-patch.v1', operations: [
      { op: 'move_component', component_id: 'r1', dx_grid: 7, dy_grid: 0 },
    ] }],
  }, 'INVALID_SCHEMA');
  reject({
    ...valid,
    candidates: [{ schema: 'actoviq.layout-patch.v1', operations: [
      { op: 'set_layout_lane', component_id: 'r1', rank: 17, lane: 0 },
    ] }],
  }, 'INVALID_SCHEMA');
  reject({
    ...valid,
    candidates: [{ schema: 'actoviq.layout-patch.v1', operations: [
      { op: 'move_component', component_id: 'r1', dx_grid: 4, dy_grid: 0 },
      { op: 'move_component', component_id: 'r1', dx_grid: 3, dy_grid: 0 },
    ] }],
  }, 'INVALID_SCHEMA');
  reject({
    ...valid,
    candidates: [{ schema: 'actoviq.layout-patch.v1', operations: [
      { op: 'rotate_component', component_id: 'r1', rotation: 90 },
      { op: 'rotate_component', component_id: 'r1', rotation: 180 },
    ] }],
  }, 'INVALID_SCHEMA');
  reject({
    ...valid,
    candidates: [{ schema: 'actoviq.layout-patch.v1', operations: [
      { op: 'delete_component', component_id: 'r1' },
    ] }],
  }, 'INVALID_SCHEMA');
});

async function prepareJobDirs(paths: JobPaths): Promise<void> {
  await Promise.all([
    paths.inputsDir,
    paths.planningDir,
    paths.designDir,
    paths.modulesDir,
    paths.verificationDir,
    paths.simulationDir,
    paths.finalSimulationDir,
    paths.renderDir,
    paths.reportsDir,
    paths.logsDir,
  ].map((directory) => mkdir(directory, { recursive: true })));
}

test('parseCliOptions parses value flags and approval policy', () => {
  const options = parseCliOptions([
    '--requirement',
    'Design an RC filter',
    '--approval-policy',
    'execution',
    '--job-name',
    'rc-demo',
    '--revision-base-job',
    'base-job',
    '--job-parent-dir',
    'custom-revisions',
    '--rerun-from-stage',
    'simulation-verifier',
    '--legacy-cli',
  ]);
  assert.equal(options.requirement, 'Design an RC filter');
  assert.equal(options.approvalPolicy, 'execution');
  assert.equal(options.jobName, 'rc-demo');
  assert.equal(options.revisionBaseJob, 'base-job');
  assert.equal(options.jobParentDir, 'custom-revisions');
  assert.equal(options.rerunFromStage, 'simulation-verifier');
  assert.equal(options.legacyCli, true);
  assert.equal(options.error, undefined);
});

test('parseCliOptions reports missing values and invalid policies', () => {
  assert.equal(parseCliOptions(['--requirement']).error, 'missing value for --requirement');
  assert.equal(
    parseCliOptions(['--approval-policy', 'sometimes']).error,
    '--approval-policy must be manual, execution, or all',
  );
  assert.equal(parseCliOptions(['--rerun-from-stage']).error, 'missing value for --rerun-from-stage');
});

test('parseCliOptions parses chat mode and rejects workflow flags', () => {
  const chat = parseCliOptions(['chat', '--settings', 'agent.settings.json', '--approval-policy', 'all']);
  assert.equal(chat.chatMode, true);
  assert.equal(chat.settingsPath, 'agent.settings.json');
  assert.equal(chat.approvalPolicy, 'all');
  assert.equal(chat.error, undefined);

  const plain = parseCliOptions([]);
  assert.equal(plain.chatMode, false);

  assert.equal(
    parseCliOptions(['chat', '--resume-job', 'some-job']).error,
    '--resume-job is not available in chat mode',
  );
  assert.equal(
    parseCliOptions(['chat', '--auto-approve']).error,
    '--auto-approve is not available in chat mode',
  );
  assert.equal(parseCliOptions(['--resume-job', 'some-job']).chatMode, false);
});

test('parseTuiCommand distinguishes chat text from slash commands', () => {
  assert.equal(parseTuiCommand('设计一个 LDO'), null);
  assert.deepEqual(parseTuiCommand('/allow all'), {
    name: 'allow',
    args: 'all',
    raw: '/allow all',
  });
  assert.deepEqual(parseTuiCommand('/unknown value'), {
    name: 'unknown',
    args: 'value',
    raw: '/unknown value',
  });
});

test('classifyError uses structured categories', () => {
  assert.deepEqual(classifyError(new Error('stage timed out after 1000 ms')), {
    kind: 'timeout',
    retryable: true,
    message: 'stage timed out after 1000 ms',
  });
  assert.equal(classifyError(new Error('No Vibe Analog credential was found')).kind, 'credential');
  assert.equal(classifyError(new Error('Missing required Write field: file_path')).kind, 'file_tool');
});

test('SPICE scalar parsing and formatting handle common suffixes', () => {
  assert.equal(parseSpiceScalar('10k'), 10_000);
  assert.equal(parseSpiceScalar('1.5meg'), 1_500_000);
  assert.ok(Math.abs((parseSpiceScalar('2.2pF') ?? 0) - 2.2e-12) < 1e-24);
  assert.equal(formatCompactScalar(10_000), '10k');
  assert.equal(formatCompactScalar(2.2e-9), '2.2n');
});

test('ngspice measurement parser handles next-line values', () => {
  const metrics = parseMeasurementLines(['gain = 12.5', 'delay =', '  3.4e-6', 'bad = n/a'].join('\n'));
  assert.equal(metrics.gain, 12.5);
  assert.equal(metrics.delay, 3.4e-6);
  assert.equal(metrics.bad, undefined);
});

test('Write tool exposes canonical schema but tolerates raw wrapper input', async () => {
  const root = path.resolve(process.cwd(), '.tmp-unit-tests', `write-${Date.now()}`);
  await mkdir(root, { recursive: true });
  try {
    const tools = createWorkspaceFileTools({ cwd: root, allowedRoots: [root] });
    const write = tools.find((tool) => tool.name === 'Write');
    assert.ok(write);
    const context = createToolContext(root);
    const outputPath = path.resolve(root, 'raw-object.txt');
    await write.execute({ raw: { file_path: outputPath, content: 'object ok' } }, context);
    assert.equal(await readFile(outputPath, 'utf8'), 'object ok');

    const nestedOutputPath = path.resolve(root, 'nested-raw.cir');
    const nestedRaw = JSON.stringify({
      raw: JSON.stringify({
        raw: JSON.stringify({
          file_path: nestedOutputPath,
          content: '* nested raw write\nR1 in 0 1k\n.end\n',
        }),
      }),
    });
    await write.execute({ raw: nestedRaw }, context);
    assert.equal(await readFile(nestedOutputPath, 'utf8'), '* nested raw write\nR1 in 0 1k\n.end\n');

    await assert.rejects(
      () => write.execute({ raw: 'not json' }, context),
      /Missing required Write field: file_path/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stage registry exposes the expected workflow order and prompt constraints', () => {
  const root = path.resolve(process.cwd(), '.tmp-unit-tests', 'stage-registry');
  const paths = createTestJobPaths(root);
  const stages = createWorkflowStages(paths, '设计一个运放 RC 比较器链路');
  assert.deepEqual(stages.map((stage) => stage.key), [
    'solution-analyst',
    'doc-writer',
    'librarian',
    'architect',
    'netlist-designer',
    'simulation-verifier',
    'netlistsvg-renderer',
    'workflow-lead',
  ]);
  assert.equal(new Set(stages.map((stage) => stage.key)).size, stages.length);
  assert.equal(stages.find((stage) => stage.key === 'simulation-verifier')?.requiresConfirmation, false);

  const netlistPrompt = stages.find((stage) => stage.key === 'netlist-designer')?.buildPrompt(paths) ?? '';
  assert.match(netlistPrompt, /Primitive-only hard gate/);
  assert.match(netlistPrompt, /Forbidden instance prefixes: X, E, F, G, H, B, A, U/);

  const librarianPrompt = stages.find((stage) => stage.key === 'librarian')?.buildPrompt(paths) ?? '';
  assert.match(librarianPrompt, /bundled starter netlist|bundled assets/i);
  assert.doesNotMatch(librarianPrompt, /本地三个仓库|三个仓库/);
});

test('buildUniqueJobId avoids same-second collisions deterministically', async () => {
  const parent = path.resolve(process.cwd(), '.tmp-unit-tests', `job-id-${Date.now()}`);
  await mkdir(parent, { recursive: true });
  try {
    const fixed = new Date('2026-01-02T03:04:05');
    const base = buildJobId('collision-demo', fixed);
    await mkdir(path.resolve(parent, base), { recursive: true });
    assert.equal(await buildUniqueJobId('collision-demo', parent, fixed), `${base}-2`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('TuiStateStore persists allow mode, active job, and transcript transitions', async () => {
  const sessionId = `unit-${Date.now()}`;
  const sessionRoot = path.resolve(process.cwd(), 'sessions', sessionId);
  await rm(sessionRoot, { recursive: true, force: true });
  try {
    const store = await TuiStateStore.load(sessionId);
    await store.setConversationSessionId('conversation-1');
    await store.setAllowMode('all');
    assert.equal(store.snapshot().allowMode, 'all');
    assert.equal(store.snapshot().conversationSessionId, undefined);

    await store.setActiveJob({
      jobId: 'job-1',
      jobRoot: 'workspace/job-1',
      finalSummaryPath: 'workspace/job-1/reports/final-summary.md',
      manifestPath: 'workspace/job-1/reports/manifest.json',
      workflowStatePath: 'workspace/job-1/reports/workflow-state.json',
    });
    assert.equal(store.snapshot().activeJobId, 'job-1');
    await store.clearActiveJob();
    assert.equal(store.snapshot().activeJobId, undefined);

    await store.appendTranscript({ role: 'user', content: 'hello' });
    await store.appendTranscript({ role: 'agent', content: 'hi' });
    assert.deepEqual((await store.recentTranscript(1)).map((entry) => entry.content), ['hi']);
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
  }
});

test('deterministic comparator fallback stays primitive-only', async () => {
  const root = path.resolve(process.cwd(), '.tmp-unit-tests', `comparator-${Date.now()}`);
  const paths = createTestJobPaths(root);
  await prepareJobDirs(paths);
  try {
    await writeFile(paths.specNormalizedPath, `${JSON.stringify({
      input_node: 'in',
      output_node: 'alarm_n',
      constraints: {
        topology: 'opamp + rc + comparator',
        output_logic: 'active_low',
        supply_v: 5,
      },
      targets: {
        closed_loop_gain: { min: 7, max: 9 },
        rc_cutoff_hz: { min: 1000, max: 2000 },
        comparator_threshold_v: { min: 2.4, max: 2.6 },
      },
    }, null, 2)}\n`, 'utf8');

    const result = await repairSignalChainComparatorNetlist(paths);
    assert.equal(result.applied, true);
    const netlist = await readFile(paths.designFinalPath, 'utf8');
    assert.doesNotMatch(netlist, /^\s*[EBFGHXAU][A-Za-z0-9_.$-]*\b/im);
    assert.match(netlist, /^Mcmp\b/m);
    assert.match(netlist, /^Rpull\b/m);

    const primitiveReport = JSON.parse(await readFile(paths.primitiveCheckPath, 'utf8')) as { ok?: boolean };
    assert.equal(primitiveReport.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('design memory helpers list and resolve saved templates and flows', async () => {
  const root = path.resolve(process.cwd(), 'output', 'tests', 'design-memory');
  const templateRoot = path.resolve(root, 'templates');
  const flowRoot = path.resolve(root, 'flows');
  await rm(root, { recursive: true, force: true });
  const templateDir = path.resolve(templateRoot, 'rc-filter-template');
  const flowDir = path.resolve(flowRoot, 'rc-filter-flow');
  await mkdir(templateDir, { recursive: true });
  await mkdir(flowDir, { recursive: true });
  await writeFile(
    path.resolve(templateDir, 'template.json'),
    `${JSON.stringify({
      schema: 'actoviq.design-template.v1',
      id: 'rc-filter-template',
      name: 'RC Filter Template',
      source_project_id: 'rc-filter',
      source_revision: 4,
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(path.resolve(templateDir, 'template.cir'), 'R1 in out 1k\nC1 out 0 1u\n', 'utf8');
  await writeFile(path.resolve(templateDir, 'agent-guide.md'), '# Agent Guide\n', 'utf8');
  await writeFile(
    path.resolve(flowDir, 'flow.json'),
    `${JSON.stringify({
      schema: 'actoviq.design-flow.v1',
      id: 'rc-filter-flow',
      name: 'RC Filter Flow',
      source_project_id: 'rc-filter',
      source_revision: 4,
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(path.resolve(flowDir, 'design-flow.md'), '# Flow\n', 'utf8');

  const templates = await listSavedDesignTemplates(templateRoot);
  assert.equal(templates.length, 1);
  assert.equal(templates[0]?.id, 'rc-filter-template');
  assert.equal(templates[0]?.sourceRevision, 4);
  const resolvedById = await resolveSavedTemplateNetlist('rc-filter-template', templateRoot);
  assert.equal(resolvedById?.templateNetlistPath, path.resolve(templateDir, 'template.cir'));
  const resolvedByRelativePath = await resolveSavedTemplateNetlist('rc-filter-template/template.cir', templateRoot);
  assert.equal(resolvedByRelativePath?.id, 'rc-filter-template');
  const flows = await listSavedDesignFlows(flowRoot);
  assert.equal(flows.length, 1);
  assert.equal(flows[0]?.flowPath, path.resolve(flowDir, 'design-flow.md'));
  await rm(root, { recursive: true, force: true });
});

test('module composition builds a flat primitive final netlist and manifest', async () => {
  const root = path.resolve(process.cwd(), '.tmp-unit-tests', `module-compose-${Date.now()}`);
  const paths = createTestJobPaths(root);
  await prepareJobDirs(paths);
  try {
    await writeFile(paths.specNormalizedPath, `${JSON.stringify({
      input_node: 'in',
      output_node: 'alarm_n',
      constraints: { topology: 'partitioned primitive chain' },
    }, null, 2)}\n`, 'utf8');
    await writeFile(paths.modulePlanPath, `${JSON.stringify({
      strategy: 'partitioned',
      shared_nets: ['vdd', '0'],
      modules: [
        {
          name: 'input_filter',
          file: 'design/modules/01_input_filter.cir',
          input_nets: ['in'],
          output_nets: ['mid'],
          component_names: ['Rin'],
        },
        {
          name: 'output_pull',
          file: 'design/modules/02_output_pull.cir',
          input_nets: ['mid'],
          output_nets: ['alarm_n'],
          component_names: ['Rload'],
        },
      ],
    }, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(paths.modulesDir, '01_input_filter.cir'), [
      '* MODULE 1: input_filter',
      'Rin in mid 1k',
      '.model DMOD D(IS=1e-15)',
      '.end',
      '',
    ].join('\n'), 'utf8');
    await writeFile(path.resolve(paths.modulesDir, '02_output_pull.cir'), [
      '* MODULE 2: output_pull',
      'Rload mid alarm_n 2k',
      'Cout alarm_n 0 1n',
      '.model DMOD D(IS=2e-15)',
      '.end',
      '',
    ].join('\n'), 'utf8');

    const result = await composeFinalNetlistFromModules(paths);
    assert.equal(result.applied, true);
    const netlist = await readFile(paths.designFinalPath, 'utf8');
    assert.match(netlist, /Rin in mid 1k/);
    assert.match(netlist, /Rload mid alarm_n 2k/);
    assert.equal((netlist.match(/^\.model DMOD\b/gim) ?? []).length, 1);

    const manifest = JSON.parse(await readFile(paths.moduleManifestPath, 'utf8')) as { modules?: unknown[] };
    assert.equal(manifest.modules?.length, 2);
    const primitiveReport = JSON.parse(await readFile(paths.primitiveCheckPath, 'utf8')) as { ok?: boolean };
    assert.equal(primitiveReport.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('netlistsvg renderer keeps the partitioned timeout fallback path wired', async () => {
  const scriptPath = path.resolve(process.cwd(), 'embedded', 'circuit-design', 'scripts', 'render_netlistsvg.py');
  const script = await readFile(scriptPath, 'utf8');
  assert.match(script, /def render_partitioned_fallback_after_timeout/);
  assert.match(script, /except subprocess\.TimeoutExpired:[\s\S]*render_partitioned_fallback_after_timeout/);
  assert.match(script, /write_netlistsvg_reports\(/);
  assert.match(script, /check_geometry/);
});

test('netlistsvg analog planner defaults LDO renders to schematic view without hard geometry errors', async () => {
  const root = path.resolve(process.cwd(), '.tmp-unit-tests', `netlistsvg-planner-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const netlistPath = path.resolve(root, 'ldo.cir');
  const jsonPath = path.resolve(root, 'ldo.design.json');
  const fullJsonPath = path.resolve(root, 'ldo.full.json');
  const svgPath = path.resolve(root, 'ldo.svg');
  const netlistToJsonPath = path.resolve(
    process.cwd(),
    'embedded',
    'circuit-design',
    'scripts',
    'netlist_to_json.py',
  );
  const renderPath = path.resolve(
    process.cwd(),
    'embedded',
    'circuit-design',
    'scripts',
    'render_netlistsvg.py',
  );
  const netlistsvgBin = path.resolve(
    process.cwd(),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'netlistsvg.cmd' : 'netlistsvg',
  );
  try {
    await writeFile(netlistPath, [
      '* MOSFET LDO fixture',
      '.model NMOS1 NMOS (LEVEL=1 VTO=0.7 KP=120u)',
      '.model PMOS1 PMOS (LEVEL=1 VTO=-0.7 KP=40u)',
      'Vin vin 0 DC 5',
      'Vref vref 0 DC 1.2',
      'Itail tail 0 DC 20u',
      'M1 n1 fb tail 0 NMOS1 W=20u L=1u',
      'M2 eaout vref tail 0 NMOS1 W=20u L=1u',
      'M3 n1 n1 vin vin PMOS1 W=40u L=1u',
      'M4 eaout n1 vin vin PMOS1 W=40u L=1u',
      'MP vout eaout vin vin PMOS1 W=2000u L=0.5u',
      'Rtop fb vout 210k',
      'Rbot fb 0 120k',
      'Rload vout 0 330',
      'Cout vout 0 1u',
      '.end',
      '',
    ].join('\n'), 'utf8');
    const converted = spawnSync('python', [
      netlistToJsonPath,
      '--netlist-path', netlistPath,
      '--json-path', jsonPath,
      '--input-node', 'vin',
      '--output-node', 'vout',
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(converted.status, 0, converted.stderr || converted.stdout);
    const schematicDesign = JSON.parse(await readFile(jsonPath, 'utf8')) as {
      view?: string;
      components?: Array<{ name?: string }>;
    };
    assert.equal(schematicDesign.view, 'schematic');
    const schematicComponentNames = new Set((schematicDesign.components ?? []).map((component) => component.name));
    for (const hiddenSource of ['Vin', 'Vref', 'Itail']) {
      assert.equal(schematicComponentNames.has(hiddenSource), false);
    }

    const fullConverted = spawnSync('python', [
      netlistToJsonPath,
      '--netlist-path', netlistPath,
      '--json-path', fullJsonPath,
      '--view', 'full',
      '--input-node', 'vin',
      '--output-node', 'vout',
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(fullConverted.status, 0, fullConverted.stderr || fullConverted.stdout);
    const fullDesign = JSON.parse(await readFile(fullJsonPath, 'utf8')) as {
      view?: string;
      components?: Array<{ name?: string }>;
    };
    assert.equal(fullDesign.view, 'full');
    const fullComponentNames = new Set((fullDesign.components ?? []).map((component) => component.name));
    for (const visibleSource of ['Vin', 'Vref', 'Itail']) {
      assert.equal(fullComponentNames.has(visibleSource), true);
    }

    const rendered = spawnSync('python', [
      renderPath,
      '--json-path', jsonPath,
      '--svg-path', svgPath,
      '--netlistsvg-bin', netlistsvgBin,
      '--skin-profile', 'analog',
      '--timeout-sec', '45',
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
    const payload = JSON.parse(rendered.stdout.trim()) as Record<string, any>;
    assert.equal(payload.ok, true);
    assert.equal(payload.planner.profile, 'ldo_regulator');
    assert.equal(payload.geometry_check.ok, true);
    assert.equal(payload.geometry_check.summary.missing_pin_connections, 0);
    assert.equal(payload.geometry_check.summary.wire_crossings, 0);
    assert.equal(payload.geometry_check.summary.component_overlaps, 0);
    assert.equal(payload.geometry_check.summary.wire_body_intrusions, 0);
    assert.ok(payload.layout_report.readability_score >= 85);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('grid renderer keeps BJT, diode, inductor, and supply rails visible', async () => {
  const root = path.resolve(process.cwd(), '.tmp-unit-tests', `grid-renderer-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const netlistPath = path.resolve(root, 'mixed-active.cir');
  const svgPath = path.resolve(root, 'mixed-active.svg');
  const scriptPath = path.resolve(
    process.cwd(),
    'skills',
    'circuit-design-ngspice',
    'scripts',
    'render_grid.py',
  );
  try {
    await writeFile(netlistPath, [
      '* mixed primitive schematic',
      '.model QNPN NPN(IS=1e-15 BF=120)',
      '.model DCL D(IS=1e-15)',
      'VCC vcc 0 DC 12',
      'VIN src 0 AC 1',
      'RSRC src in 50',
      'CIN in b 68p',
      'RB1 vcc b 22k',
      'RB2 b 0 4.7k',
      'Q1 c b e QNPN',
      'RE e 0 39',
      'CE e 0 4.7n',
      'RC vcc c 680',
      'DCLAMP b 0 DCL',
      'LLOAD c out 1u',
      'RLOAD out 0 50',
      '.end',
      '',
    ].join('\n'), 'utf8');
    const result = spawnSync('python', [scriptPath, '--netlist', netlistPath, '--svg-path', svgPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, any>;
    assert.equal(payload.ok, true);
    assert.equal(payload.renderer, 'grid');
    assert.equal(payload.metrics.hard_errors, 0);
    assert.equal(payload.devices, 12);
    assert.match(String(payload.geometry_path), /mixed-active\.geometry\.json$/);
    const svg = await readFile(svgPath, 'utf8');
    assert.match(svg, /Q1/);
    assert.match(svg, /DCLAMP/);
    assert.match(svg, /LLOAD/);
    assert.match(svg, /VCC/);
    const fixtures = [
      'ldo_mos_series_bench.cir',
      'opamp_mos_cascode_eval.cir',
      'lna_common_emitter_rf_bench.cir',
    ];
    for (const fixture of fixtures) {
      const fixtureSvgPath = path.resolve(root, `${fixture}.svg`);
      const fixtureResult = spawnSync('python', [
        scriptPath,
        '--netlist',
        path.resolve(process.cwd(), 'embedded', 'circuit-design', 'assets', 'templates', fixture),
        '--svg-path',
        fixtureSvgPath,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      assert.equal(fixtureResult.status, 0, fixtureResult.stderr || fixtureResult.stdout);
      const fixturePayload = JSON.parse(fixtureResult.stdout.trim()) as Record<string, any>;
      assert.equal(fixturePayload.ok, true, fixture);
      assert.equal(fixturePayload.metrics.hard_errors, 0, fixture);
      assert.equal(fixturePayload.metrics.device_overlaps, 0, fixture);
      assert.equal(fixturePayload.metrics.wire_body_intrusions, 0, fixture);
      const geometry = JSON.parse(await readFile(String(fixturePayload.geometry_path), 'utf8')) as Record<string, any>;
      assert.equal(geometry.ok, true, fixture);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('grid MOS renderer preserves drain/source anchors when mirrored', () => {
  const scriptPath = path.resolve(
    process.cwd(),
    'skills',
    'circuit-design-ngspice',
    'scripts',
    'render_grid.py',
  );
  const code = [
    'import importlib.util, json, schemdraw, sys',
    'spec = importlib.util.spec_from_file_location("render_grid", sys.argv[1])',
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    'cases = {',
    '  "nmos_left": {"kind": "nmos", "ref": "MN1", "value": "", "pins": {"D": "d", "G": "g", "S": "s"}, "cell": [0, 0]},',
    '  "nmos_right": {"kind": "nmos", "ref": "MN2", "value": "", "pins": {"D": "d", "G": "g", "S": "s"}, "cell": [0, 0], "flip": True},',
    '  "pmos_left": {"kind": "pmos", "ref": "MP1", "value": "", "pins": {"D": "d", "G": "g", "S": "s"}, "cell": [0, 0]},',
    '  "pmos_right": {"kind": "pmos", "ref": "MP2", "value": "", "pins": {"D": "d", "G": "g", "S": "s"}, "cell": [0, 0], "flip": True},',
    '}',
    'out = {}',
    'for name, dev in cases.items():',
    '  drawing = schemdraw.Drawing(show=False)',
    '  out[name] = mod.place_device(drawing, dev)',
    'print(json.dumps(out))',
  ].join('\n');
  const result = spawnSync('python', ['-c', code, scriptPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const anchors = JSON.parse(result.stdout.trim()) as Record<string, Record<string, [number, number]>>;
  const nmosLeft = anchors.nmos_left!;
  const nmosRight = anchors.nmos_right!;
  const pmosLeft = anchors.pmos_left!;
  const pmosRight = anchors.pmos_right!;
  assert.ok(nmosLeft.D![1] > nmosLeft.S![1]);
  assert.ok(nmosRight.D![1] > nmosRight.S![1]);
  assert.ok(pmosLeft.S![1] > pmosLeft.D![1]);
  assert.ok(pmosRight.S![1] > pmosRight.D![1]);
  assert.ok(nmosLeft.G![0] < 0);
  assert.ok(pmosLeft.G![0] < 0);
  assert.ok(nmosRight.G![0] > 0);
  assert.ok(pmosRight.G![0] > 0);
});

test('markdown fallback artifacts remain explicit placeholders, not silent success', async () => {
  const workflowPath = path.resolve(process.cwd(), 'src', 'workflow', 'circuitDesignWorkflow.ts');
  const workflowSource = await readFile(workflowPath, 'utf8');
  assert.match(workflowSource, /fallback-placeholder/);
  assert.match(workflowSource, /Semantic review is required/);
  assert.doesNotMatch(workflowSource, /This file was generated by workflow fallback because the stage agent did not persist/);
});

test('canvas project tool creates, revises, and compiles a modular project', async () => {
  const projectsRoot = path.resolve(process.cwd(), '.tmp-unit-tests', `canvas-project-${Date.now()}`);
  await mkdir(projectsRoot, { recursive: true });
  const script = path.resolve(
    process.cwd(),
    'skills',
    'circuit-design-ngspice',
    'scripts',
    'circuit_project.py',
  );
  const runTool = (args: string[]) => {
    const result = spawnSync('python', [script, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim()) as Record<string, any>;
  };
  try {
    const created = runTool([
      'create-demo',
      '--projects-root', projectsRoot,
      '--name', 'Canvas Test',
    ]);
    const projectRoot = String(created.project_root);
    assert.equal(created.project.revision, 0);
    assert.equal(created.project.modules.length, 3);

    const command = {
      schema: 'actoviq.command.v1',
      command_id: 'test-value-change',
      actor: 'unit-test',
      project_id: created.project.project_id,
      base_revision: 0,
      message: 'Tune filter',
      operations: [{
        op: 'set_component_value',
        module_id: 'filter',
        component_id: 'c_filter',
        value: '22n',
      }, {
        op: 'set_module_note',
        module_id: 'filter',
        notes: 'Agent should reduce the cutoff frequency.',
      }, {
        op: 'set_module_preview',
        module_id: 'filter',
        enabled: false,
      }, {
        op: 'set_module_metadata',
        module_id: 'filter',
        function: 'Updated low-pass filter stage.',
        parameters: {
          Resistance: '10 kohm',
          Capacitance: '22 nF',
        },
      }, {
        op: 'resize_module',
        module_id: 'filter',
        width: 420,
        height: 310,
      }, {
        op: 'set_connection_network',
        connection_id: 'amplifier-to-filter',
        network: 'DAC#1',
      }],
    };
    const applied = runTool([
      'apply',
      '--project-root', projectRoot,
      '--command-json', JSON.stringify(command),
    ]);
    assert.equal(applied.revision, 1);
    assert.deepEqual(applied.changed_modules, ['filter']);
    const summary = runTool(['summary', '--project-root', projectRoot]);
    const filterRef = summary.project.modules.find((entry: { id: string }) => entry.id === 'filter');
    assert.equal(filterRef.notes, 'Agent should reduce the cutoff frequency.');
    assert.equal(filterRef.preview_enabled, false);
    assert.equal(filterRef.function, 'Updated low-pass filter stage.');
    assert.equal(filterRef.parameters.Capacitance, '22 nF');
    assert.deepEqual(filterRef.size, { width: 420, height: 310 });
    assert.equal(
      summary.project.connections.find(
        (connection: { id: string }) => connection.id === 'amplifier-to-filter',
      ).network,
      'DAC#1',
    );

    const sensorPorts = [
      { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
      { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
      { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
    ];
    const addModuleCommand = {
      schema: 'actoviq.command.v1',
      command_id: 'test-upsert-module',
      actor: 'unit-test',
      project_id: created.project.project_id,
      base_revision: 1,
      message: 'Add sensor module',
      operations: [{
        op: 'upsert_module',
        module_ref: {
          id: 'sensor',
          name: 'Sensor interface',
          kind: 'input',
          source: 'modules/sensor/module.circuit.json',
          position: { x: 20, y: 360 },
          size: { width: 180, height: 120 },
          ports: sensorPorts,
        },
        module: {
          schema: 'actoviq.module.v1',
          module_id: 'sensor',
          name: 'Sensor interface',
          revision: 0,
          ports: sensorPorts,
          components: [{
            id: 'r_sensor',
            type: 'R',
            name: 'Rsensor',
            value: '2k',
            position: { x: 80, y: 120 },
            rotation: 0,
            pins: [
              { id: 'a', name: '1', net: 'in' },
              { id: 'b', name: '2', net: 'out' },
            ],
          }],
          wires: [],
          annotations: [],
        },
      }],
    };
    const moduleApplied = runTool([
      'apply',
      '--project-root', projectRoot,
      '--command-json', JSON.stringify(addModuleCommand),
    ]);
    assert.equal(moduleApplied.revision, 2);
    assert.deepEqual(moduleApplied.changed_modules, ['sensor']);

    const compiled = runTool(['compile', '--project-root', projectRoot]);
    assert.equal(compiled.ok, true);
    const netlist = await readFile(String(compiled.netlist_path), 'utf8');
    assert.match(netlist, /Ramplifier_Rseries SIGNAL DAC_1 1k/);
    assert.match(netlist, /Rfilter_Rfilter DAC_1 out 10k/);
    assert.match(netlist, /Cfilter_Cfilter out 0 22n/);
    assert.match(netlist, /Rsensor_Rsensor sensor_input out_\d+ 2k/);
    const moduleCompiled = runTool([
      'compile-module',
      '--project-root', projectRoot,
      '--module-id', 'filter',
    ]);
    assert.equal(moduleCompiled.ok, true);
    assert.match(await readFile(String(moduleCompiled.netlist_path), 'utf8'), /Vtest_input in 0 DC 0 AC 1/);
    assert.equal(moduleCompiled.render.ok, true);
    const moduleSvg = await readFile(String(moduleCompiled.schematic_path), 'utf8');
    assert.match(moduleSvg, /<svg\b/);
    assert.doesNotMatch(moduleSvg, /Rload_/);
    const schematicMove = runTool([
      'apply',
      '--project-root', projectRoot,
      '--command-json', JSON.stringify({
        schema: 'actoviq.command.v1',
        command_id: 'test-schematic-move',
        actor: 'unit-test',
        project_id: created.project.project_id,
        base_revision: 2,
        message: 'Move rendered capacitor symbol',
        operations: [{
          op: 'move_schematic_item',
          module_id: 'filter',
          item_id: 'Cfilter_Cfilter',
          x: 260,
          y: 180,
        }],
      }),
    ]);
    assert.equal(schematicMove.revision, 3);
    assert.deepEqual(schematicMove.changed_modules, ['filter']);
    const overrides = JSON.parse(
      await readFile(path.resolve(projectRoot, 'modules', 'filter', 'schematic.overrides.json'), 'utf8'),
    );
    assert.equal(overrides.schema, 'actoviq.schematic-overrides.v1');
    assert.deepEqual(overrides.items.Cfilter_Cfilter, { x: 260, y: 180, locked: true });
    const movedModuleCompiled = runTool([
      'compile-module',
      '--project-root', projectRoot,
      '--module-id', 'filter',
    ]);
    assert.equal(movedModuleCompiled.render.ok, true);
    const movedModuleSvg = await readFile(String(movedModuleCompiled.schematic_path), 'utf8');
    assert.match(movedModuleSvg, /id="cell_Cfilter_Cfilter"/);
    assert.match(movedModuleSvg, /transform="translate\(260,180\)" id="cell_Cfilter_Cfilter"/);
    const filterModuleForManualEdit = JSON.parse(
      await readFile(path.resolve(projectRoot, 'modules', 'filter', 'module.circuit.json'), 'utf8'),
    );
    const manualComponents = [
      ...filterModuleForManualEdit.components,
      {
        id: 'r_manual',
        type: 'R',
        name: 'Rmanual',
        value: '2k',
        position: { x: 340, y: 120 },
        rotation: 0,
        pins: [
          { id: 'a', name: '1', net: 'out' },
          { id: 'b', name: '2', net: 'n_manual' },
        ],
      },
    ];
    const manualSchematicApplied = runTool([
      'apply',
      '--project-root', projectRoot,
      '--command-json', JSON.stringify({
        schema: 'actoviq.command.v1',
        command_id: 'test-set-module-schematic',
        actor: 'unit-test',
        project_id: created.project.project_id,
        base_revision: 3,
        message: 'Save structured manual schematic edit',
        operations: [{
          op: 'set_module_schematic',
          module_id: 'filter',
          components: manualComponents,
          ports: filterModuleForManualEdit.ports,
          wires: [{
            id: 'w_manual',
            points: [{ x: 260, y: 120 }, { x: 292, y: 120 }],
            from: { x: 260, y: 120, component_id: 'c_filter', pin_id: 'a' },
            to: { x: 292, y: 120, component_id: 'r_manual', pin_id: 'a' },
            net: 'out',
          }],
          annotations: filterModuleForManualEdit.annotations,
        }],
      }),
    ]);
    assert.equal(manualSchematicApplied.revision, 4);
    assert.deepEqual(manualSchematicApplied.changed_modules, ['filter']);
    const manuallyEditedFilter = JSON.parse(
      await readFile(path.resolve(projectRoot, 'modules', 'filter', 'module.circuit.json'), 'utf8'),
    );
    assert.equal(manuallyEditedFilter.components.length, 3);
    assert.equal(manuallyEditedFilter.wires.length, 1);
    const manuallyCompiled = runTool([
      'compile-module',
      '--project-root', projectRoot,
      '--module-id', 'filter',
    ]);
    assert.equal(manuallyCompiled.render.ok, true);
    assert.match(await readFile(String(manuallyCompiled.netlist_path), 'utf8'), /Rfilter_Rmanual out n_manual 2k/);
    const agentBlockApplied = runTool([
      'apply',
      '--project-root', projectRoot,
      '--command-json', JSON.stringify({
        schema: 'actoviq.command.v1',
        command_id: 'test-agent-add-block',
        actor: 'agent',
        project_id: created.project.project_id,
        base_revision: 4,
        message: 'Agent adds an arbitrary-pin functional block',
        operations: [{
          op: 'add_component',
          module_id: 'filter',
          component: {
            id: 'agent_adc',
            type: 'BLOCK',
            name: 'UAI',
            value: 'AI ADC block',
            position: { x: 520, y: 180 },
            rotation: 0,
            pins: [
              { id: 'ain', name: 'AIN', net: 'out', side: 'left', order: 0 },
              { id: 'clk', name: 'CLK', net: 'sample_clk', side: 'left', order: 1 },
              { id: 'data', name: 'DATA', net: 'sample_data', side: 'right', order: 0 },
              { id: 'vdd', name: 'VDD', net: 'vdd', side: 'top', order: 0 },
              { id: 'gnd', name: 'GND', net: '0', side: 'bottom', order: 0 },
            ],
            block: { width: 180, height: 140 },
          },
        }],
      }),
    ]);
    assert.equal(agentBlockApplied.revision, 5);
    const blockCompiled = runTool([
      'compile-module',
      '--project-root', projectRoot,
      '--module-id', 'filter',
    ]);
    const blockNetlist = await readFile(String(blockCompiled.netlist_path), 'utf8');
    assert.match(blockNetlist, /\* BLOCK filter_UAI: AI ADC block/);
    assert.doesNotMatch(blockNetlist, /^BLOCKfilter_UAI\s/m);
    const notebookPath = path.resolve(projectRoot, 'modules', 'filter', 'netlist-notebook.md');
    const notebookNetlist = blockNetlist;
    const updatedFilterNotebook = [
        '# Filter notebook',
        '',
        'Editable explanation outside the circuit code block.',
        '',
        '```spice',
        '.param FILTER_SCALE=1',
        '.model TESTD D(IS=1e-14)',
        notebookNetlist.replace('Cfilter_Cfilter out 0 22n', 'Cfilter_Cfilter out 0 33n').trim(),
        '```',
        '',
        'Persistent review note.',
        '',
      ].join('\n');
    const notebookApplied = runTool([
      'apply',
      '--project-root', projectRoot,
      '--command-json', JSON.stringify({
        schema: 'actoviq.command.v1',
        command_id: 'test-set-module-netlist',
        actor: 'unit-test',
        project_id: created.project.project_id,
        base_revision: 5,
        message: 'Save complete module netlist transaction',
        operations: [{
          op: 'set_module_netlist',
          module_id: 'filter',
          netlist_notebook: updatedFilterNotebook,
        }],
      }),
    ]);
    assert.equal(notebookApplied.revision, 6);
    const notebookCompiled = runTool([
      'compile-module',
      '--project-root', projectRoot,
      '--module-id', 'filter',
    ]);
    assert.equal(notebookCompiled.render.ok, true);
    assert.match(await readFile(String(notebookCompiled.netlist_path), 'utf8'), /Cfilter_Cfilter out 0 33n/);
    const notebookSyncedModule = JSON.parse(
      await readFile(path.resolve(projectRoot, 'modules', 'filter', 'module.circuit.json'), 'utf8'),
    );
    assert.equal(notebookSyncedModule.components.find((component: { id: string }) => component.id === 'agent_adc')?.type, 'BLOCK');
    assert.equal(notebookSyncedModule.schema, 'actoviq.module.v2');
    assert.ok(notebookSyncedModule.nets.every((net: { id?: string }) => Boolean(net.id)));
    assert.match(notebookSyncedModule.spice.models.join('\n'), /\.model TESTD/);
    assert.match(
      await readFile(path.resolve(projectRoot, 'revisions', '000006', 'result', 'modules', 'filter', 'netlist-notebook.md'), 'utf8'),
      /Persistent review note/,
    );
    const blockSummary = runTool(['summary', '--project-root', projectRoot]);
    assert.equal(
      blockSummary.modules.filter.components.find((component: { id: string }) => component.id === 'agent_adc')?.type,
      'BLOCK',
    );
    assert.equal(
      await readFile(path.resolve(projectRoot, 'revisions', '000001', 'metadata.json'), 'utf8')
        .then((value) => JSON.parse(value).base_revision),
      0,
    );
    const sensorNotebookPath = path.resolve(projectRoot, 'modules', 'sensor', 'netlist-notebook.md');
    const sensorNotebook = [
        '# Active sensor notebook',
        '',
        '```spice',
        '.model NMTEST NMOS(LEVEL=1 VTO=0.8 KP=120u)',
        'VDD vdd 0 DC 5',
        'M1 out in 0 0 NMTEST W=10u L=1u',
        'RLOAD out 0 1k',
        '.op',
        '.tran 1u 20u',
        '.meas tran sensor_peak max v(out)',
        '.end',
        '```',
        '',
      ].join('\n');
    const activeApplied = runTool([
      'apply',
      '--project-root', projectRoot,
      '--command-json', JSON.stringify({
        schema: 'actoviq.command.v1',
        command_id: 'test-active-module-netlist',
        actor: 'agent',
        project_id: created.project.project_id,
        base_revision: 6,
        message: 'Agent saves active device model and analyses',
        operations: [{ op: 'set_module_netlist', module_id: 'sensor', netlist_notebook: sensorNotebook }],
      }),
    ]);
    assert.equal(activeApplied.revision, 7);
    const activeCompiled = runTool([
      'compile-module',
      '--project-root', projectRoot,
      '--module-id', 'sensor',
    ]);
    assert.equal(activeCompiled.render.ok, true);
    assert.equal(activeCompiled.render.renderer, 'netlistsvg');
    const activeSystemCompiled = runTool(['compile', '--project-root', projectRoot]);
    const activeSystemNetlist = await readFile(String(activeSystemCompiled.netlist_path), 'utf8');
    assert.match(activeSystemNetlist, /\.model NMTEST/);
    assert.match(activeSystemNetlist, /\.tran 1u 20u/);
    assert.match(activeSystemNetlist, /\.meas tran sensor_peak/);
    const buildManifest = JSON.parse(await readFile(path.resolve(projectRoot, 'build', 'build-manifest.json'), 'utf8'));
    assert.equal(buildManifest.source_revision, 7);
    assert.match(buildManifest.document_hash, /^[a-f0-9]{64}$/);
    assert.equal(buildManifest.modules.sensor.renderer, 'netlistsvg');
    const restored = runTool([
      'apply',
      '--project-root', projectRoot,
      '--command-json', JSON.stringify({
        schema: 'actoviq.command.v1',
        command_id: 'test-restore-revision',
        actor: 'unit-test',
        project_id: created.project.project_id,
        base_revision: 7,
        message: 'Restore passive sensor revision',
        operations: [{ op: 'restore_revision', revision: 6 }],
      }),
    ]);
    assert.equal(restored.revision, 8);
    assert.ok(restored.changed_modules.includes('sensor'));
    const restoredSummary = runTool(['summary', '--project-root', projectRoot]);
    assert.equal(restoredSummary.project.revision, 8);
    assert.ok(restoredSummary.modules.sensor.components.some((component: { id: string }) => component.id === 'r_sensor'));
    assert.equal(restoredSummary.modules.sensor.components.some((component: { name: string }) => component.name === 'M1'), false);
    await assert.rejects(readFile(sensorNotebookPath, 'utf8'));
    assert.match(
      await readFile(path.resolve(projectRoot, 'revisions', '000008', 'metadata.json'), 'utf8'),
      /Restore passive sensor revision/,
    );
  } finally {
    await rm(projectsRoot, { recursive: true, force: true });
  }
});

test('agent project protocol imports editable netlists and exposes revisioned ERC context', async () => {
  const projectsRoot = path.resolve(process.cwd(), '.tmp-unit-tests', `agent-project-${Date.now()}`);
  await mkdir(projectsRoot, { recursive: true });
  const script = path.resolve(
    process.cwd(),
    'skills',
    'circuit-design-ngspice',
    'scripts',
    'circuit_project.py',
  );
  const runTool = (args: string[], expectedStatus = 0) => {
    const result = spawnSync('python', [script, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim()) as Record<string, any>;
  };
  try {
    const created = runTool([
      'create',
      '--projects-root', projectsRoot,
      '--name', 'Agent Project Protocol',
    ]);
    const projectRoot = String(created.project_root);
    const notebook = [
      '# Agent-generated RC filter',
      '',
      '```spice',
      '* Editable RC filter',
      'V1 in 0 DC 0 AC 1',
      'R1 in out 1k',
      'C1 out 0 100n',
      '.ac dec 20 10 1meg',
      '.end',
      '```',
      '',
    ].join('\n');
    const command = {
      schema: 'actoviq.command.v1',
      command_id: 'agent-upsert-netlist',
      actor: 'agent',
      project_id: created.project.project_id,
      base_revision: 0,
      message: 'Create an editable RC module from the generated netlist',
      operations: [{
        op: 'upsert_module_netlist',
        module_id: 'filter',
        name: 'RC low-pass filter',
        kind: 'filter',
        function: 'First-order low-pass response.',
        netlist_notebook: notebook,
      }],
    };
    const applied = runTool([
      'apply',
      '--project-root', projectRoot,
      '--command-json', JSON.stringify(command),
    ]);
    assert.equal(applied.revision, 1);
    assert.equal(applied.erc.source_revision, 1);
    assert.match(applied.erc.document_hash, /^[a-f0-9]{64}$/);
    assert.equal(applied.erc.summary.errors, 0);

    const summary = runTool(['summary', '--project-root', projectRoot]);
    assert.equal(summary.project.modules.length, 1);
    assert.equal(summary.modules.filter.schema, 'actoviq.module.v2');
    assert.equal(summary.modules.filter.components.length, 3);
    assert.match(summary.modules.filter.spice.source, /\.ac dec 20 10 1meg/);
    assert.ok(summary.modules.filter.nets.every((net: { id?: string }) => Boolean(net.id)));

    const beforeBuild = runTool(['agent-context', '--project-root', projectRoot]);
    assert.equal(beforeBuild.protocol_version, 'actoviq.project-agent.v2');
    assert.equal(beforeBuild.base_revision, 1);
    assert.equal(beforeBuild.build.state, 'missing');
    assert.equal(beforeBuild.next_action, 'compile');
    assert.ok(beforeBuild.transaction.allowed_operations.includes('upsert_module_netlist'));

    const compiled = runTool(['compile', '--project-root', projectRoot]);
    assert.equal(compiled.erc.source_revision, 1);
    const afterBuild = runTool(['agent-context', '--project-root', projectRoot]);
    assert.equal(afterBuild.build.state, 'current');
    assert.equal(afterBuild.next_action, 'simulate');

    const stale = runTool([
      'apply',
      '--project-root', projectRoot,
      '--command-json', JSON.stringify({
        ...command,
        command_id: 'stale-agent-command',
        operations: [{
          op: 'set_component_value',
          module_id: 'filter',
          component_id: 'r1',
          value: '2k',
        }],
      }),
    ], 1);
    assert.equal(stale.ok, false);
    assert.match(stale.error, /stale revision: expected 1, got 0/);
  } finally {
    await rm(projectsRoot, { recursive: true, force: true });
  }
});

let failed = 0;
for (const testCase of tests) {
  try {
    await testCase.run();
    console.log(`ok - ${testCase.name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${testCase.name}`);
    console.error(error);
  }
}

if (failed > 0) {
  process.exitCode = 1;
}
