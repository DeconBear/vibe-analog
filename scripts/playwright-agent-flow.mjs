import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(root, 'output', 'playwright');
const runRoot = path.resolve(outputRoot, '.workspace', `agent-flow-${process.pid}-${Date.now()}`);
const workspaceRoot = path.resolve(runRoot, 'workspace');
const projectsRoot = path.resolve(workspaceRoot, 'projects');
const userDataDir = path.resolve(runRoot, 'electron-user-data');
const homeDir = path.resolve(runRoot, 'home');
const vitePort = await allocatePort();
const viteUrl = `http://127.0.0.1:${vitePort}`;
const fakeApiKey = `sk-mock-agent-flow-${Date.now().toString(36)}`;
const designMarker = 'ACTOVIQ_AGENT_FLOW_DESIGN_REQUEST';
const reportMarker = 'ACTOVIQ_AGENT_FLOW_TECHNICAL_REPORT';
const projectName = `Agent Flow RC ${Date.now()}`;
const projectId = projectName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
const layoutLoopProjectId = `agent-flow-layout-loop-${process.pid}-${Date.now()}`;
const layoutLoopProjectName = `Agent Flow Visual Layout ${Date.now()}`;
const layoutLoopModuleId = 'layout';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address === 'object');
      server.close(() => resolve(address.port));
    });
  });
}

async function canFetch(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function startVite() {
  const viteBin = path.resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [
    viteBin,
    '--host', '127.0.0.1',
    '--port', String(vitePort),
    '--strictPort',
  ], {
    cwd: root,
    env: { ...process.env, BROWSER: 'none' },
    stdio: 'ignore',
    windowsHide: true,
  });
  let exit = null;
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exit) throw new Error(`Vite exited before startup: ${JSON.stringify(exit)}`);
    if (await canFetch(viteUrl)) {
      await fetch(`${viteUrl}/src/main.tsx`).catch(() => null);
      await delay(750);
      return child;
    }
    await delay(200);
  }
  child.kill();
  throw new Error(`Timed out waiting for ${viteUrl}`);
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function openAiChunk(id, model, content, finishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: content ? { content } : {},
      finish_reason: finishReason,
    }],
  };
}

function sendStreamingText(response, content) {
  const id = `chatcmpl-agent-flow-${Date.now()}`;
  const model = 'mock-deepseek';
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  response.write(`data: ${JSON.stringify({
    ...openAiChunk(id, model, ''),
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  })}\n\n`);
  for (let offset = 0; offset < content.length; offset += 11) {
    response.write(`data: ${JSON.stringify(openAiChunk(id, model, content.slice(offset, offset + 11)))}\n\n`);
  }
  response.write(`data: ${JSON.stringify({
    ...openAiChunk(id, model, '', 'stop'),
    usage: { prompt_tokens: 71, completion_tokens: 53, total_tokens: 124 },
  })}\n\n`);
  response.write('data: [DONE]\n\n');
  response.end();
}

function sendCompletionText(response, content) {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({
    id: `chatcmpl-agent-flow-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-deepseek',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 71, completion_tokens: 53, total_tokens: 124 },
  }));
}

function sendProviderText(response, body, content) {
  if (body.stream === true) sendStreamingText(response, content);
  else sendCompletionText(response, content);
}

function sendToolCall(response, body, name, input) {
  const id = `chatcmpl-agent-flow-${Date.now()}`;
  const model = String(body.model ?? 'mock-layout-vision');
  const toolCall = {
    index: 0,
    id: `tool-call-${name}-${Date.now()}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(input),
    },
  };
  if (body.stream === true) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify({
      ...openAiChunk(id, model, ''),
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      ...openAiChunk(id, model, ''),
      choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      ...openAiChunk(id, model, '', 'tool_calls'),
      usage: { prompt_tokens: 83, completion_tokens: 19, total_tokens: 102 },
    })}\n\n`);
    response.write('data: [DONE]\n\n');
    response.end();
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ ...toolCall, index: undefined }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 83, completion_tokens: 19, total_tokens: 102 },
  }));
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  for (const nested of Object.values(value)) collectStrings(nested, output);
  return output;
}

function parseEmbeddedJsonObject(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.lastIndexOf('{', markerIndex);
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function findLayoutReviewStage(messages) {
  const marker = '"schema":"actoviq.vision-layout-review-request.v1"';
  for (const text of collectStrings(messages)) {
    const parsed = parseEmbeddedJsonObject(text, marker);
    if (parsed?.schema === 'actoviq.vision-layout-review-request.v1') return parsed;
  }
  return null;
}

function requestToolNames(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => String(tool?.function?.name ?? tool?.name ?? '')).filter(Boolean);
}

function hasToolResult(messages) {
  return Array.isArray(messages) && messages.some((message) => (
    message?.role === 'tool'
    || collectStrings(message).some((text) => text.includes('"schema":"actoviq.vision-layout-image.v1"'))
  ));
}

function layoutPatchSet(stage) {
  return {
    schema: 'actoviq.layout-patch-set.v1',
    source_revision: stage.source_revision,
    connectivity_hash: stage.connectivity_hash,
    candidates: [{
      schema: 'actoviq.layout-patch.v1',
      operations: [
        { op: 'move_component', component_id: 'r1', dx_grid: 0, dy_grid: -6 },
        { op: 'move_port', port_id: 'in', dx_grid: -6, dy_grid: 0 },
        { op: 'move_port', port_id: 'out', dx_grid: 6, dy_grid: 6 },
      ],
    }],
  };
}

function extractPngBase64(value) {
  if (typeof value === 'string') {
    const match = value.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
    return match?.[1] ?? null;
  }
  if (!value || typeof value !== 'object') return null;
  if (value.media_type === 'image/png' && typeof value.data === 'string') return value.data;
  for (const nested of Object.values(value)) {
    const found = extractPngBase64(nested);
    if (found) return found;
  }
  return null;
}

function readVisionChallengeAnswer(pngBase64) {
  const png = Buffer.from(pngBase64, 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'vision challenge should be a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[9], 2, 'vision challenge should use RGB pixels');
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  assert.equal(width, 820);
  assert.equal(height, 180);
  const pixels = inflateSync(Buffer.concat(idat));
  const stride = 1 + width * 3;
  const names = new Map([
    ['232,40,40', 'RED'],
    ['38,94,224', 'BLUE'],
    ['245,206,40', 'YELLOW'],
    ['211,48,190', 'MAGENTA'],
    ['31,190,204', 'CYAN'],
  ]);
  const colors = [90, 250, 410, 570, 730].map((x) => {
    const row = 90 * stride;
    assert.equal(pixels[row], 0, 'vision challenge scanline should use the expected no-filter encoding');
    const pixel = row + 1 + x * 3;
    const rgb = `${pixels[pixel]},${pixels[pixel + 1]},${pixels[pixel + 2]}`;
    const name = names.get(rgb);
    assert.ok(name, `unexpected vision challenge color ${rgb}`);
    return name;
  });
  assert.equal(new Set(colors).size, 5, 'vision challenge should contain every color exactly once');
  return `ACTOVIQ_VISION:${colors.join(',')}`;
}

async function startMockProvider() {
  const requests = [];
  let circuitDesignStep = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      const body = await readRequestJson(request);
      const messages = JSON.stringify(body.messages ?? []);
      const visionPngBase64 = extractPngBase64(body.messages ?? []);
      const layoutStage = findLayoutReviewStage(body.messages ?? []);
      const toolNames = requestToolNames(body.tools);
      const layoutToolResult = hasToolResult(body.messages ?? []);
      const authorized = request.headers.authorization === `Bearer ${fakeApiKey}`;
      const scenario = layoutStage
        ? layoutToolResult && visionPngBase64
          ? 'layout-vision-final'
          : 'layout-vision-tool-request'
        : visionPngBase64 && messages.includes('ACTOVIQ_VISION')
        ? 'layout-vision-probe'
        : messages.includes('Reply with exactly: OK')
        ? 'provider-check'
        : messages.includes('Verified evidence JSON:')
          ? 'technical-report'
          : messages.includes(designMarker)
            ? 'circuit-design'
            : 'unknown';
      requests.push({
        scenario,
        authorized,
        model: body.model,
        stream: body.stream,
        tools: Array.isArray(body.tools) ? body.tools.length : 0,
        toolNames,
        hasImage: Boolean(visionPngBase64),
        sourceRevision: layoutStage?.source_revision,
        connectivityHash: layoutStage?.connectivity_hash,
      });

      if (!authorized) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'mock authorization rejected' } }));
        return;
      }
      if (scenario === 'layout-vision-probe') {
        sendProviderText(response, body, readVisionChallengeAnswer(visionPngBase64));
        return;
      }
      if (scenario === 'provider-check') {
        sendProviderText(response, body, 'OK');
        return;
      }
      if (scenario === 'layout-vision-tool-request') {
        assert(layoutStage, 'layout review tool request must contain a stage packet');
        assert.equal(layoutStage.module_id, layoutLoopModuleId);
        assert.equal(layoutStage.source_revision, 1);
        assert.match(String(layoutStage.connectivity_hash ?? ''), /^[0-9a-f]{64}$/);
        assert.equal(
          typeof layoutStage.image_path,
          'string',
          `layout stage keys: ${Object.keys(layoutStage).join(', ')}`,
        );
        await access(layoutStage.image_path);
        assert(toolNames.includes('view_schematic_for_layout'));
        sendToolCall(response, body, 'view_schematic_for_layout', {
          image_path: layoutStage.image_path,
        });
        return;
      }
      if (scenario === 'layout-vision-final') {
        assert(layoutStage, 'layout review final response must contain a stage packet');
        assert(toolNames.includes('view_schematic_for_layout'));
        const image = Buffer.from(visionPngBase64, 'base64');
        assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        sendProviderText(response, body, JSON.stringify(layoutPatchSet(layoutStage)));
        return;
      }
      if (scenario === 'circuit-design') {
        const notebook = [
          '# Agent-generated RC low-pass filter',
          '',
          '```spice',
          '* First-order low-pass filter with AC verification',
          'V1 in 0 DC 0 AC 1',
          'R1 in out 1k',
          'C1 out 0 100n',
          '.ac dec 30 10 1meg',
          '.meas ac output_1khz_db FIND vdb(out) AT=1k',
          '.end',
          '```',
        ].join('\n');
        const steps = [
          [
            `created = hadamard.create_circuit_project(name=${JSON.stringify(projectName)}, project_kind="simulation")`,
            'print(created)',
          ].join('\n'),
          [
            `ctx = hadamard.agent_context(project_id=${JSON.stringify(projectId)})`,
            'print(ctx)',
          ].join('\n'),
          [
            `result = hadamard.apply_circuit_command(`,
            `    project_id=${JSON.stringify(projectId)},`,
            '    base_revision=0,',
            '    message="Create and verify a first-order RC low-pass filter.",',
            '    operations=[{',
            '        "op": "upsert_module_netlist",',
            '        "module_id": "filter",',
            '        "name": "RC low-pass filter",',
            '        "kind": "filter",',
            '        "function": "First-order low-pass response with a nominal 1.59 kHz cutoff.",',
            `        "netlist_notebook": ${JSON.stringify(notebook)},`,
            '    }],',
            ')',
            'print(result)',
          ].join('\n'),
          [
            `erc = hadamard.run_erc(project_id=${JSON.stringify(projectId)})`,
            'print(erc)',
          ].join('\n'),
          [
            `build = hadamard.compile_circuit_project(project_id=${JSON.stringify(projectId)})`,
            'print(build)',
          ].join('\n'),
          [
            `sim = hadamard.simulate_circuit_project(project_id=${JSON.stringify(projectId)})`,
            'print(sim)',
          ].join('\n'),
          [
            `report = hadamard.generate_technical_report(project_id=${JSON.stringify(projectId)}, source_revision=1)`,
            'print(report)',
          ].join('\n'),
        ];
        const step = steps[circuitDesignStep];
        circuitDesignStep += 1;
        if (step) {
          assert(toolNames.includes('CodeCell'), 'desktop CodeAct request is missing CodeCell');
          sendToolCall(response, body, 'CodeCell', { language: 'python', code: step });
          return;
        }
        sendProviderText(
          response,
          body,
          'Applied 1 project operation at revision 1. Technical report generated for revision 1.',
        );
        return;
      }
      if (scenario === 'technical-report') {
        sendProviderText(response, body, [
          '# RC Low-Pass Filter Technical Report',
          '',
          `Verification marker: ${reportMarker}`,
          '',
          '## Executive summary',
          'The immutable project evidence describes a first-order RC low-pass filter. This report records only the supplied revision, ERC, build, and simulation evidence.',
          '',
          '## Requirements and assumptions',
          'The requested design uses a 1 kΩ series resistor, a 100 nF shunt capacitor, and an AC source with unit small-signal magnitude.',
          '',
          '## Circuit architecture and signal flow',
          'V1 drives net `in`; R1 connects `in` to `out`; C1 connects `out` to ground. The topology is a passive single-pole low-pass network.',
          '',
          '## Component and parameter rationale',
          'The nominal pole is determined by 1/(2πRC). Component IDs and values are quoted from the generated netlist rather than inferred.',
          '',
          '## ERC and connectivity status',
          'The report relies on the persisted ERC artifact. No connectivity result is invented beyond that evidence.',
          '',
          '## Simulation setup',
          'The netlist requests an AC decade sweep from 10 Hz to 1 MHz and measures `output_1khz_db` at 1 kHz.',
          '',
          '## Results and specification assessment',
          'Execution, measurement, and specification status are reported independently by the simulation artifact.',
          '',
          '## Limitations and risks',
          'Ideal component models omit tolerance, parasitics, source impedance, and load variation.',
          '',
          '## Reproduction steps',
          'Open the generated project revision, compile the system netlist, and run the recorded AC analysis with ngspice.',
        ].join('\n'));
        return;
      }

      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'unknown mock request' } }));
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      if (!response.writableEnded) {
        response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

async function findNgspiceBinary() {
  const configuredPaths = [];
  if (process.env.NGSPICE_BIN?.trim()) configuredPaths.push(process.env.NGSPICE_BIN.trim());
  for (const configPath of [
    path.resolve(root, 'skills', 'circuit-design-ngspice', 'tool_paths.json'),
    path.resolve(root, 'embedded', 'circuit-design', 'tool_paths.json'),
  ]) {
    try {
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      if (typeof config.ngspice_bin === 'string' && config.ngspice_bin.trim()) {
        configuredPaths.push(config.ngspice_bin.trim());
      }
    } catch {
      // An optional local tool-path file may be absent.
    }
  }
  for (const candidate of configuredPaths) {
    try {
      await access(candidate);
      return path.resolve(candidate);
    } catch {
      // Try the next configured path.
    }
  }
  throw new Error('A real ngspice binary is required for the agent-flow E2E test. Set NGSPICE_BIN or configure skills/circuit-design-ngspice/tool_paths.json.');
}

function settingsField(dialog, label) {
  return dialog.getByText(label, { exact: true }).locator('..').locator('input');
}

async function findProjectByName(name) {
  const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectRoot = path.resolve(projectsRoot, entry.name);
    try {
      const project = JSON.parse(await readFile(path.resolve(projectRoot, 'project.circuit.json'), 'utf8'));
      if (project.name === name) return { projectRoot, project };
    } catch {
      // Ignore non-project folders.
    }
  }
  throw new Error(`Project not found: ${name}`);
}

function electricalProjection(module) {
  const sorted = (items) => [...items].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return {
    components: sorted(module.components ?? []).map((component) => ({
      id: component.id,
      type: component.type,
      name: component.name,
      value: component.value,
      pins: sorted(component.pins ?? []).map((pin) => ({
        id: pin.id,
        name: pin.name,
        net: pin.net,
        net_id: pin.net_id,
      })),
    })),
    ports: sorted(module.ports ?? []).map((port) => ({
      id: port.id,
      name: port.name,
      direction: port.direction,
      signal_type: port.signal_type,
      net: port.net,
      net_id: port.net_id,
    })),
    nets: sorted(module.nets ?? []).map((net) => ({
      id: net.id,
      name: net.name,
      kind: net.kind,
      aliases: [...(net.aliases ?? [])].sort(),
    })),
    spice: module.spice,
  };
}

async function createLayoutLoopFixture() {
  const timestamp = new Date().toISOString();
  const ports = [
    { id: 'in', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in', net_id: 'net_in', position: { x: 100, y: 0 } },
    { id: 'out', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out', net_id: 'net_out', position: { x: -100, y: 0 } },
  ];
  const module = {
    schema: 'actoviq.module.v2',
    module_id: layoutLoopModuleId,
    name: 'Visual layout loop fixture',
    revision: 1,
    ports,
    nets: [
      { id: 'net_in', name: 'in', kind: 'analog', aliases: [] },
      { id: 'net_out', name: 'out', kind: 'analog', aliases: [] },
    ],
    components: [{
      id: 'r1',
      type: 'R',
      name: 'R1',
      value: '1k',
      position: { x: 0, y: 0 },
      rotation: 0,
      pins: [
        { id: 'a', name: '1', net: 'in', net_id: 'net_in' },
        { id: 'b', name: '2', net: 'out', net_id: 'net_out' },
      ],
    }],
    wires: [],
    annotations: [],
    spice: {
      source: 'R1 in out 1k\n.end',
      models: [],
      directives: [],
      opaque: [],
      generated_testbench: false,
    },
  };
  const project = {
    schema: 'actoviq.project.v2',
    project_id: layoutLoopProjectId,
    name: layoutLoopProjectName,
    project_kind: 'simulation',
    revision: 1,
    created_at: timestamp,
    updated_at: timestamp,
    modules: [{
      id: layoutLoopModuleId,
      name: module.name,
      kind: 'test',
      function: 'Deliberately low-scoring connectivity fixture; the omitted ground keeps project ERC visibly independent from layout quality.',
      parameters: {},
      notes: '',
      preview_enabled: true,
      source: `modules/${layoutLoopModuleId}/module.circuit.json`,
      position: { x: 120, y: 120 },
      size: { width: 900, height: 600 },
      ports: JSON.parse(JSON.stringify(ports)),
    }],
    connections: [],
    analyses: {},
  };
  const projectRoot = path.resolve(projectsRoot, layoutLoopProjectId);
  const moduleRoot = path.resolve(projectRoot, 'modules', layoutLoopModuleId);
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
  await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
    '# Visual layout loop fixture',
    '',
    '```spice',
    'R1 in out 1k',
    '.end',
    '```',
    '',
  ].join('\n'), 'utf8');
  return {
    projectRoot,
    initialElectricalProjection: electricalProjection(module),
  };
}

function filteredPageErrors(errors) {
  return errors.filter((entry) => !(
    entry.includes('ERR_NETWORK_ACCESS_DENIED')
    || entry.includes('ERR_CONNECTION_CLOSED')
    || entry.includes('Monaco initialization')
    || entry === 'pageerror: Event'
  ));
}

await mkdir(outputRoot, { recursive: true });
await mkdir(workspaceRoot, { recursive: true });
await mkdir(userDataDir, { recursive: true });
await mkdir(homeDir, { recursive: true });

const ngspiceBinary = await findNgspiceBinary();
const mock = await startMockProvider();
const viteProcess = await startVite();
const electronDistDir = path.resolve(root, 'node_modules', 'electron', 'dist');
const electronApp = await electron.launch({
  args: [
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
    '--allow-file-access-from-files',
    '.',
  ],
  cwd: root,
  env: {
    ...process.env,
    ACTOVIQ_E2E: '1',
    ACTOVIQ_E2E_WORKSPACE_ROOT: workspaceRoot,
    ACTOVIQ_RENDERER_URL: viteUrl,
    HOME: homeDir,
    USERPROFILE: homeDir,
    PATH: `${electronDistDir}${path.delimiter}${process.env.PATH ?? ''}`,
  },
  slowMo: 25,
});

let page;
const pageErrors = [];
try {
  page = await electronApp.firstWindow();
  page.setDefaultTimeout(45_000);
  page.setDefaultNavigationTimeout(45_000);
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
  });
  await page.getByTestId('circuit-empty-state').waitFor({ timeout: 30_000 });

  await page.getByTestId('topbar-settings').click();
  const settings = page.getByTestId('settings-dialog');
  await settings.waitFor();
  await settings.getByTestId('settings-provider-preset').selectOption('deepseek');
  const baseUrlField = settingsField(settings, 'Base URL');
  const layoutModelField = settings.getByTestId('settings-layout-vision-model');
  const layoutModelStatus = settings.getByTestId('settings-layout-model-status');
  const layoutModelName = 'mock-layout-vision';
  await baseUrlField.fill(mock.baseUrl);
  await settingsField(settings, 'API key').fill(fakeApiKey);
  await settingsField(settings, 'Medium model').fill('mock-deepseek-chat');
  await settingsField(settings, 'Professional model').fill('mock-deepseek-reasoner');
  await settingsField(settings, 'ngspice binary').fill(ngspiceBinary);
  await layoutModelField.fill(layoutModelName);
  await layoutModelStatus.getByText(/^Unverified\./).waitFor();
  await settings.getByTestId('settings-test-layout-model').click();
  await layoutModelStatus.getByText(new RegExp(`^Verified image input for ${layoutModelName}`)).waitFor({ timeout: 30_000 });

  await layoutModelField.fill(`${layoutModelName}-changed`);
  await layoutModelStatus.getByText(/^Unverified\./).waitFor();
  await layoutModelField.fill(layoutModelName);
  await settings.getByTestId('settings-test-layout-model').click();
  await layoutModelStatus.getByText(new RegExp(`^Verified image input for ${layoutModelName}`)).waitFor({ timeout: 30_000 });

  await baseUrlField.fill(`${mock.baseUrl}/changed`);
  await layoutModelStatus.getByText(/^Unverified\./).waitFor();
  await baseUrlField.fill(mock.baseUrl);
  await settings.getByTestId('settings-test-layout-model').click();
  await layoutModelStatus.getByText(new RegExp(`^Verified image input for ${layoutModelName}`)).waitFor({ timeout: 30_000 });

  await settings.getByTestId('settings-provider-preset').selectOption('anthropic');
  await layoutModelStatus.getByText(/^Unverified\./).waitFor();
  await settings.getByTestId('settings-provider-preset').selectOption('deepseek');
  await baseUrlField.fill(mock.baseUrl);
  await settingsField(settings, 'Medium model').fill('mock-deepseek-chat');
  await settingsField(settings, 'Professional model').fill('mock-deepseek-reasoner');
  await settings.getByTestId('settings-test-layout-model').click();
  await layoutModelStatus.getByText(new RegExp(`^Verified image input for ${layoutModelName}`)).waitFor({ timeout: 30_000 });

  await settings.getByTestId('settings-test-provider').click();
  await settings.getByTestId('settings-provider-test-result').getByText(/Connected to mock-deepseek-chat/).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.resolve(outputRoot, 'agent-flow-settings.png') });
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await settings.getByRole('button', { name: /Saved/ }).waitFor();
  await settings.getByTestId('settings-dialog-close').click();
  await settings.waitFor({ state: 'detached' });
  await page.getByTestId('topbar-settings').click();
  await settings.waitFor();
  assert.equal(await settings.getByTestId('settings-layout-vision-model').inputValue(), layoutModelName);
  await settings.getByTestId('settings-layout-model-status')
    .getByText(new RegExp(`^Verified image input for ${layoutModelName}`))
    .waitFor();
  await settings.getByTestId('settings-dialog-close').click();
  await settings.waitFor({ state: 'detached' });

  await page.getByTestId('topbar-chat').click();
  await page.getByTestId('chat-composer').fill(`${designMarker}: design, compile, simulate, and document a 1.6 kHz RC low-pass filter.`);
  await page.getByTestId('chat-send').click();
  await page.getByTestId('chat-streaming-message').waitFor({ timeout: 30_000 });
  await page.getByText(/Technical report generated for revision 1/).waitFor({ timeout: 120_000 });
  await page.getByText(/Applied 1 project operation at revision 1/).waitFor({ timeout: 30_000 });
  await page.getByTestId('chat-streaming-message').waitFor({ state: 'detached', timeout: 30_000 });
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="chat-composer"]')?.getAttribute('placeholder') === 'Ask Vibe Analog…'
  ));
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="module-card-filter"]')?.getAttribute('data-projection-ready') === 'true'
  ));
  await page.screenshot({ path: path.resolve(outputRoot, 'agent-flow-chat.png') });

  const { projectRoot, project } = await findProjectByName(projectName);
  assert.equal(project.revision, 1);
  assert.equal(project.project_kind, 'simulation');
  assert.equal(project.modules.length, 1);
  const module = JSON.parse(await readFile(path.resolve(projectRoot, 'modules', 'filter', 'module.circuit.json'), 'utf8'));
  assert.match(module.spice.source, /\.ac dec 30 10 1meg/i);
  assert(module.components.some((component) => component.type === 'R'));
  assert(module.components.some((component) => component.type === 'C'));

  const erc = JSON.parse(await readFile(path.resolve(projectRoot, 'build', 'erc.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.resolve(projectRoot, 'build', 'build-manifest.json'), 'utf8'));
  const simulation = JSON.parse(await readFile(path.resolve(projectRoot, 'build', 'system', 'simulation', 'result.json'), 'utf8'));
  const technicalReport = await readFile(path.resolve(projectRoot, 'build', 'system', 'technical-report.md'), 'utf8');
  const technicalReportMetadata = JSON.parse(await readFile(path.resolve(projectRoot, 'build', 'system', 'technical-report.json'), 'utf8'));
  assert.equal(erc.blocking, false);
  assert.equal(erc.summary.errors, 0);
  assert.equal(manifest.status, 'simulated');
  assert.equal(Number(manifest.source_revision), 1);
  assert.equal(simulation.ok, true);
  assert.equal(simulation.execution_status, 'success');
  assert.equal(Number(simulation.source_revision), 1);
  assert.match(technicalReport, new RegExp(reportMarker));
  assert.equal(technicalReportMetadata.schema, 'actoviq.technical-report.v1');
  assert.equal(technicalReportMetadata.source_revision, 1);
  assert.equal(technicalReportMetadata.model, 'mock-deepseek-reasoner');

  await page.getByTestId('topbar-tab-simulation').click();
  await page.getByTestId('project-simulation').waitFor({ timeout: 30_000 });
  await page.getByRole('cell', { name: 'output_1khz_db', exact: true }).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.resolve(outputRoot, 'agent-flow-simulation.png') });

  await page.getByTestId('topbar-tab-report').click();
  const report = page.getByTestId('project-report');
  await report.waitFor();
  await report.getByText(reportMarker, { exact: false }).waitFor();
  await page.screenshot({ path: path.resolve(outputRoot, 'agent-flow-report.png') });

  const layoutFixture = await createLayoutLoopFixture();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('circuit-workbench').waitFor({ timeout: 30_000 });
  await page.getByTestId(`sidebar-project-${layoutLoopProjectId}`).click();
  await page.getByTestId('topbar-tab-design').click();
  await page.getByTestId(`module-preview-${layoutLoopModuleId}`).waitFor({ timeout: 30_000 });
  await page.getByTestId(`module-card-${layoutLoopModuleId}`).dblclick();
  await page.getByTestId('schematic-editor').waitFor({ timeout: 30_000 });
  await page.getByTestId('optimize-schematic-layout').click();
  const layoutFeedback = page.getByTestId('layout-optimization-feedback');
  await layoutFeedback.getByText(/1 visual review round/).waitFor({ timeout: 180_000 });
  await layoutFeedback.getByText(/Visible full schematic 100.*clean/).waitFor();
  const layoutFeedbackText = await layoutFeedback.textContent();
  assert.match(layoutFeedbackText ?? '', /Layout quality 69.*100/s);
  assert.match(layoutFeedbackText ?? '', /Connectivity [0-9a-f]{12}.*preserved/s);
  const schematicEditor = page.getByTestId('schematic-editor');
  await page.waitForFunction(() => {
    const editor = document.querySelector('[data-testid="schematic-editor"]');
    if (!(editor instanceof HTMLElement)) return false;
    try {
      const positions = JSON.parse(editor.dataset.portPositions ?? '{}');
      return positions.in?.x === -20
        && positions.in?.y === 0
        && positions.out?.x === 20
        && positions.out?.y === 120;
    } catch {
      return false;
    }
  }, undefined, { timeout: 30_000 });
  assert.deepEqual(
    JSON.parse(await schematicEditor.getAttribute('data-port-positions') ?? '{}'),
    { in: { x: -20, y: 0 }, out: { x: 20, y: 120 } },
  );
  const layoutViewport = await page.evaluate(() => {
    const workbench = document.querySelector('[data-testid="circuit-workbench"]');
    const title = document.querySelector('[data-testid="project-title"]');
    const viewport = workbench?.parentElement;
    if (!(workbench instanceof HTMLElement) || !(title instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
      throw new Error('layout workbench viewport is unavailable');
    }
    const workbenchRect = workbench.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    return {
      viewportScrollLeft: viewport.scrollLeft,
      viewportLeft: viewportRect.left,
      workbenchLeft: workbenchRect.left,
      titleLeft: titleRect.left,
    };
  });
  assert.equal(layoutViewport.viewportScrollLeft, 0);
  assert(layoutViewport.workbenchLeft >= layoutViewport.viewportLeft);
  assert(layoutViewport.titleLeft >= layoutViewport.viewportLeft + 12);
  await page.screenshot({ path: path.resolve(outputRoot, 'agent-flow-layout-loop.png') });
  const layoutFixtureErc = await page.evaluate(
    async (projectId) => window.electronAPI.runCircuitErc(projectId),
    layoutLoopProjectId,
  );
  assert.equal(layoutFixtureErc.summary.errors, 1);
  assert.deepEqual(
    layoutFixtureErc.diagnostics
      .filter((diagnostic) => diagnostic.severity === 'error')
      .map((diagnostic) => diagnostic.code),
    ['missing_ground'],
  );

  const layoutProject = JSON.parse(await readFile(
    path.resolve(layoutFixture.projectRoot, 'project.circuit.json'),
    'utf8',
  ));
  const optimizedLayoutModule = JSON.parse(await readFile(
    path.resolve(layoutFixture.projectRoot, 'modules', layoutLoopModuleId, 'module.circuit.json'),
    'utf8',
  ));
  assert.equal(layoutProject.revision, 2);
  assert.equal(optimizedLayoutModule.revision, 2);
  assert.deepEqual(electricalProjection(optimizedLayoutModule), layoutFixture.initialElectricalProjection);
  assert.deepEqual(
    optimizedLayoutModule.components.find((component) => component.id === 'r1')?.position,
    { x: 0, y: -120 },
  );
  const optimizedPortPositions = Object.fromEntries(
    optimizedLayoutModule.ports.map((port) => [port.id, port.position]),
  );
  assert.deepEqual(optimizedPortPositions.in, { x: -20, y: 0 });
  assert.deepEqual(optimizedPortPositions.out, { x: 20, y: 120 });
  const layoutReviewRoot = path.resolve(layoutFixture.projectRoot, 'build', 'layout-reviews');
  const layoutReviewRuns = (await readdir(layoutReviewRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory());
  assert.equal(layoutReviewRuns.length, 1);
  const layoutReviewRunRoot = path.resolve(layoutReviewRoot, layoutReviewRuns[0].name);
  const initialLayoutQuality = JSON.parse(await readFile(
    path.resolve(layoutReviewRunRoot, 'layout-quality.json'),
    'utf8',
  ));
  const finalLayoutQuality = JSON.parse(await readFile(
    path.resolve(layoutReviewRunRoot, 'layout-quality-round-1.json'),
    'utf8',
  ));
  const finalLayoutState = JSON.parse(await readFile(
    path.resolve(layoutReviewRunRoot, 'layout-state-round-1.json'),
    'utf8',
  ));
  assert(initialLayoutQuality.readability_score < 90);
  assert.equal(initialLayoutQuality.metrics.port_overlaps, 1);
  assert.equal(initialLayoutQuality.metrics.flow_feedback_issues, 1);
  assert(finalLayoutQuality.readability_score >= 90);
  assert.equal(initialLayoutQuality.connectivity_hash, finalLayoutQuality.connectivity_hash);
  assert.equal(finalLayoutQuality.metrics.missing_connections, 0);
  assert.equal(finalLayoutQuality.metrics.component_overlaps, 0);
  assert.equal(finalLayoutQuality.metrics.wire_through_components, 0);
  assert.equal(finalLayoutQuality.metrics.port_overlaps, 0);
  assert.equal(finalLayoutQuality.metrics.wire_crossings, 0);
  assert.equal(finalLayoutQuality.metrics.label_overlaps, 0);
  assert.equal(finalLayoutQuality.metrics.flow_feedback_issues, 0);
  assert.equal(
    finalLayoutQuality.routed_connectivity.source_partition_hash,
    finalLayoutQuality.routed_connectivity.routed_partition_hash,
  );
  assert.equal(finalLayoutState.visible_layout_quality.readability_score, 99.7);
  assert.equal(finalLayoutState.visible_layout_quality.metrics.port_overlaps, 0);
  assert.equal(finalLayoutState.visible_layout_quality.metrics.wire_crossings, 0);
  assert.equal(
    finalLayoutState.visible_layout_quality.routed_connectivity.source_partition_hash,
    finalLayoutState.visible_layout_quality.routed_connectivity.routed_partition_hash,
  );
  assert.match(finalLayoutState.visible_connectivity_hash, /^[0-9a-f]{64}$/);

  assert.deepEqual(mock.requests.map((request) => request.scenario), [
    'layout-vision-probe',
    'layout-vision-probe',
    'layout-vision-probe',
    'layout-vision-probe',
    'provider-check',
    'circuit-design',
    'circuit-design',
    'circuit-design',
    'circuit-design',
    'circuit-design',
    'circuit-design',
    'circuit-design',
    'technical-report',
    'circuit-design',
    'layout-vision-tool-request',
    'layout-vision-final',
  ]);
  assert(mock.requests.every((request) => request.authorized));
  const visionRequests = mock.requests.filter((request) => request.scenario === 'layout-vision-probe');
  assert.equal(visionRequests.length, 4);
  assert(visionRequests.every((request) => request.hasImage));
  assert(visionRequests.every((request) => request.model === layoutModelName));
  const layoutReviewRequests = mock.requests.filter((request) => (
    request.scenario === 'layout-vision-tool-request' || request.scenario === 'layout-vision-final'
  ));
  assert.equal(layoutReviewRequests.length, 2);
  assert(layoutReviewRequests.every((request) => request.model === layoutModelName));
  assert(layoutReviewRequests.every((request) => request.tools === 1));
  assert(layoutReviewRequests.every((request) => (
    request.toolNames.length === 1 && request.toolNames[0] === 'view_schematic_for_layout'
  )));
  assert.equal(layoutReviewRequests[0]?.hasImage, false);
  assert.equal(layoutReviewRequests[1]?.hasImage, true);
  assert.equal(layoutReviewRequests[0]?.sourceRevision, 1);
  assert.equal(layoutReviewRequests[1]?.sourceRevision, 1);
  assert.equal(layoutReviewRequests[0]?.connectivityHash, layoutReviewRequests[1]?.connectivityHash);
  assert.match(String(layoutReviewRequests[0]?.connectivityHash ?? ''), /^[0-9a-f]{64}$/);
  assert(mock.requests.filter((request) => (
    request.scenario !== 'layout-vision-probe' && request.scenario !== 'layout-vision-final'
  )).every((request) => !request.hasImage));
  assert.equal(mock.requests[4]?.stream, false);
  const circuitRequests = mock.requests.filter((request) => request.scenario === 'circuit-design');
  assert.equal(circuitRequests.length, 8);
  assert(circuitRequests.every((request) => request.stream === true));
  assert(circuitRequests.every((request) => request.tools > 0));
  assert(circuitRequests.every((request) => (
    request.toolNames.length === 1 && request.toolNames[0] === 'CodeCell'
  )), 'the desktop agent must expose only the CodeCell tool in CodeAct mode');
  const technicalReportRequest = mock.requests.find((request) => request.scenario === 'technical-report');
  assert(technicalReportRequest);
  assert.equal(technicalReportRequest.stream, false);
  assert.equal(technicalReportRequest.tools, 0);
  assert.deepEqual(filteredPageErrors(pageErrors), []);

  const result = {
    ok: true,
    projectId: project.project_id,
    projectRevision: project.revision,
    ercErrors: erc.summary.errors,
    buildStatus: manifest.status,
    simulationExecutionStatus: simulation.execution_status,
    reportSchema: technicalReportMetadata.schema,
    layoutFixtureExpectedErc: 'missing_ground',
    layoutViewport,
    providerScenarios: mock.requests.map((request) => request.scenario),
    screenshots: [
      'output/playwright/agent-flow-settings.png',
      'output/playwright/agent-flow-chat.png',
      'output/playwright/agent-flow-simulation.png',
      'output/playwright/agent-flow-report.png',
      'output/playwright/agent-flow-layout-loop.png',
    ],
  };
  await writeFile(path.resolve(outputRoot, 'agent-flow-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.resolve(outputRoot, 'agent-flow-failure.png') }).catch(() => undefined);
    console.error(JSON.stringify({
      title: await page.title().catch(() => ''),
      text: (await page.locator('body').innerText().catch(() => '')).slice(0, 4000),
      pageErrors: filteredPageErrors(pageErrors),
    }, null, 2));
  }
  throw error;
} finally {
  await electronApp.close().catch(() => undefined);
  viteProcess.kill();
  await mock.close().catch(() => undefined);
  await rm(runRoot, { recursive: true, force: true });
}
