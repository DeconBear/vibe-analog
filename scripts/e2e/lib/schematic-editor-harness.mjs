import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { _electron: electron } = await import('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export async function createHarness({ tag = '' } = {}) {
  const outputRoot = tag
    ? path.resolve(root, 'output', 'playwright', 'scenes', tag)
    : path.resolve(root, 'output', 'playwright');
  const runId = Date.now().toString(36);
  const e2eRunRoot = path.resolve(outputRoot, '.workspace', `schematic-${process.pid}-${runId}${tag ? '-' + tag : ''}`);
  const workspaceRoot = path.resolve(e2eRunRoot, 'workspaces', 'default');
  const projectsRoot = path.resolve(workspaceRoot, 'projects');
  const projectPrefix = 'playwright-schematic-editor-';
  const legacyLdoPrefix = `${projectPrefix}legacy-ldo-`;
  const legacyBjtResetPrefix = `${projectPrefix}legacy-bjt-reset-`;
  const legacyVoltageDividerPrefix = `${projectPrefix}legacy-divider-`;
  const legacyMosAmplifierPrefix = `${projectPrefix}legacy-mos-amp-`;
  const legacyCmosInverterPrefix = `${projectPrefix}legacy-cmos-inverter-`;
  const legacyCmosRingPrefix = `${projectPrefix}legacy-cmos-ring-`;
  const legacyDifferentialPairPrefix = `${projectPrefix}legacy-diff-pair-`;
  const legacyCurrentMirrorPrefix = `${projectPrefix}legacy-current-mirror-`;
  const legacyOpampFeedbackPrefix = `${projectPrefix}legacy-opamp-feedback-`;
  const legacyCascodePrefix = `${projectPrefix}legacy-cascode-`;
  const legacyBuckConverterPrefix = `${projectPrefix}legacy-buck-`;
  const junctionInteractionPrefix = `${projectPrefix}junction-interaction-`;
  const pcbParamPrefix = `${projectPrefix}pcb-param-`;
  const analogIcParamPrefix = `${projectPrefix}analog-ic-param-`;
  const vitePort = Number(process.env.ACTOVIQ_E2E_VITE_PORT ?? (await allocatePort()));
  const viteUrl = `http://127.0.0.1:${vitePort}`;
  const viteBin = path.resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const skillScript = path.resolve(root, 'skills', 'circuit-design-ngspice', 'scripts', 'circuit_project.py');
  const schematicGrid = 20;
  const componentToolLabels = {
    R: 'Place resistor (R)',
    C: 'Place capacitor (C)',
    L: 'Place inductor (L)',
    D: 'Place diode (D)',
    M: 'Place MOSFET (M)',
    Q: 'Place BJT (Q)',
    V: 'Place voltage source (V)',
    I: 'Place current source (I)',
  };

  function runSkill(args) {
    return JSON.parse(execFileSync('python', [skillScript, ...args], {
      cwd: root,
      encoding: 'utf8',
    }));
  }

  function legacyProjectId(kind) {
    return `${projectPrefix}${kind}-${runId}`;
  }

  async function allocatePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 5173;
        server.close(() => resolve(port));
      });
    });
  }

  async function canFetch(url) {
    try {
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }

  async function warmUpVite() {
    await fetch(`${viteUrl}/src/main.tsx`).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  async function startViteIfNeeded() {
    let exited = null;
    const child = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
      cwd: root,
      env: { ...process.env, BROWSER: 'none' },
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('exit', (code, signal) => {
      exited = { code, signal };
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`Vite exited early: ${JSON.stringify(exited)}`);
      if (await canFetch(viteUrl)) {
        await warmUpVite();
        return child;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    child.kill();
    throw new Error(`Timed out waiting for Vite at ${viteUrl}`);
  }

  async function removePrefixedProjects() {
    const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(projectPrefix)) continue;
      const target = path.resolve(projectsRoot, entry.name);
      assert.equal(path.dirname(target), projectsRoot);
      await rm(target, { recursive: true, force: true });
    }
  }

  async function createPcbParamProject() {
    const expectedProjectId = legacyProjectId('pcb');
    const created = runSkill([
      'create',
      '--projects-root', projectsRoot,
      '--name', `${pcbParamPrefix}${Date.now()}`,
      '--project-id', expectedProjectId,
      '--project-kind', 'pcb_schematic',
    ]);
    assert.equal(created.project.project_id, expectedProjectId);
    const projectRoot = created.project_root;
    const project = created.project;
    const moduleId = project.modules[0]?.id || 'main';
    const moduleRoot = path.resolve(projectRoot, 'modules', moduleId);
    await mkdir(moduleRoot, { recursive: true });
    const module = {
      schema: 'actoviq.module.v2',
      module_id: moduleId,
      name: 'PCB main',
      revision: 0,
      ports: [
        { id: 'in', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
        { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
      ],
      components: [{
        id: 'y1',
        type: 'BLOCK',
        name: 'Y1',
        value: '8 MHz',
        position: { x: 720, y: 360 },
        rotation: 0,
        pins: [
          { id: '1', name: '1', net: 'xin', side: 'left', order: 0 },
          { id: '2', name: '2', net: 'xout', side: 'right', order: 0 },
        ],
        block: { width: 160, height: 120 },
        eda: {
          symbol: 'Device:Crystal',
          footprint: 'Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm',
          refdes: 'Y1',
        },
      }, {
        id: 'sw1', type: 'BLOCK', name: 'SW1', value: 'SW_Push',
        position: { x: 940, y: 220 }, rotation: 0,
        pins: ['1', '2'].map((id) => ({ id, name: id, net: `nc_sw1_${id}`, no_connect: true })),
        eda: { symbol: 'Switch:SW_Push', unit: 1, symbol_variant: 1, package_id: 'pkg_sw1', refdes: 'SW1' },
      }, {
        id: 'j1', type: 'BLOCK', name: 'J1', value: 'Conn_01x04_Pin',
        position: { x: 940, y: 420 }, rotation: 90,
        pins: ['1', '2', '3', '4'].map((id) => ({ id, name: id, net: `nc_j1_${id}`, no_connect: true })),
        eda: { symbol: 'Connector:Conn_01x04_Pin', unit: 1, symbol_variant: 1, package_id: 'pkg_j1', refdes: 'J1' },
      }, {
        id: 'u1', type: 'BLOCK', name: 'U1', value: 'STM32F103C8Tx',
        position: { x: 1240, y: 420 }, rotation: 0,
        pins: Array.from({ length: 48 }, (_, index) => ({ id: String(index + 1), name: String(index + 1), net: `nc_u1_${index + 1}`, no_connect: true })),
        eda: { symbol: 'MCU_ST_STM32F1:STM32F103C8Tx', unit: 1, symbol_variant: 1, package_id: 'pkg_u1', refdes: 'U1' },
      }, {
        id: 'd1a', type: 'BLOCK', name: 'D1', value: 'Dual diode',
        position: { x: 760, y: 600 }, rotation: 0,
        pins: ['1', '2'].map((id) => ({ id, name: id, net: `nc_d1a_${id}`, no_connect: true })),
        eda: { symbol: 'Device:D_Dual_CommonAnode_AKK_Split', unit: 1, symbol_variant: 1, package_id: 'pkg_d1', refdes: 'D1' },
      }, {
        id: 'd1b', type: 'BLOCK', name: 'D1', value: 'Dual diode',
        position: { x: 940, y: 600 }, rotation: 180,
        pins: ['1', '3'].map((id) => ({ id, name: id, net: `nc_d1b_${id}`, no_connect: true })),
        eda: { symbol: 'Device:D_Dual_CommonAnode_AKK_Split', unit: 2, symbol_variant: 1, package_id: 'pkg_d1', refdes: 'D1' },
      }, {
        id: 'd2a', type: 'BLOCK', name: 'D2', value: 'Dual diode',
        position: { x: 1120, y: 600 }, rotation: 0,
        pins: ['1', '2'].map((id) => ({ id, name: id, net: `nc_d2a_${id}`, no_connect: true })),
        eda: { symbol: 'Device:D_Dual_CommonAnode_AKK_Split', unit: 1, symbol_variant: 1, package_id: 'pkg_d2', refdes: 'D2' },
      }],
      wires: [],
      annotations: [],
    };
    project.modules = [{
      id: moduleId,
      name: module.name,
      kind: 'leaf',
      function: 'PCB schematic',
      position: { x: 120, y: 120 },
      size: { width: 280, height: 180 },
      ports: module.ports,
    }];
    project.updated_at = new Date().toISOString();
    await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
    return {
      projectId: project.project_id,
      projectName: project.name,
      projectRoot,
      moduleId,
    };
  }

  async function createAnalogIcParamProject() {
    const expectedProjectId = legacyProjectId('icp');
    const created = runSkill([
      'create',
      '--projects-root', projectsRoot,
      '--name', `${analogIcParamPrefix}${Date.now()}`,
      '--project-id', expectedProjectId,
      '--project-kind', 'analog_ic',
    ]);
    assert.equal(created.project.project_id, expectedProjectId);
    const projectRoot = created.project_root;
    const project = created.project;
    const moduleId = 'core';
    const moduleRoot = path.resolve(projectRoot, 'modules', moduleId);
    await mkdir(moduleRoot, { recursive: true });
    const module = {
      schema: 'actoviq.module.v2',
      module_id: moduleId,
      name: 'Analog IC core',
      revision: 0,
      ports: [
        { id: 'in', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
        { id: 'out', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
        { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
      ],
      components: [{
        id: 'm1',
        type: 'M',
        name: 'M1',
        value: 'NMOS W=1u L=180n',
        position: { x: 240, y: 200 },
        rotation: 0,
        pins: [
          { id: 'd', name: 'D', net: 'out' },
          { id: 'g', name: 'G', net: 'in' },
          { id: 's', name: 'S', net: '0' },
          { id: 'b', name: 'B', net: '0' },
        ],
        parameters: { model: 'NMOS', w: '1u', l: '180n', m: '1', nf: '1', device_id: 'nmos' },
      }],
      wires: [],
      annotations: [],
    };
    project.modules = [{
      id: moduleId,
      name: module.name,
      kind: 'leaf',
      function: 'Analog IC MOS param fixture',
      position: { x: 120, y: 120 },
      size: { width: 280, height: 180 },
      ports: module.ports,
    }];
    project.updated_at = new Date().toISOString();
    await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
    return {
      projectId: project.project_id,
      projectName: project.name,
      projectRoot,
      moduleId,
    };
  }

  async function createLegacyLdoProject() {
    const expectedProjectId = legacyProjectId('ldo');
    const created = runSkill([
      'create',
      '--projects-root', projectsRoot,
      '--name', `${legacyLdoPrefix}${Date.now()}`,
      '--project-id', expectedProjectId,
    ]);
    const projectRoot = created.project_root;
    const project = created.project;
    assert.equal(project.project_id, expectedProjectId, 'legacy LDO fixture project id should not be truncated or reused');
    const modulePorts = [
      { id: 'vin', name: 'VIN', direction: 'input', signal_type: 'power', net: 'vin' },
      { id: 'vout', name: 'VOUT', direction: 'output', signal_type: 'analog', net: 'vout' },
      { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
    ];
    const moduleRef = {
      id: 'ldo',
      name: 'PMOS-pass LDO',
      kind: 'regulator',
      function: 'Legacy notebook-only LDO used to verify SPICE-to-editable hydration.',
      parameters: { Vin: '5.0 V', Vout: '3.3 V' },
      notes: '',
      preview_enabled: true,
      source: 'modules/ldo/module.circuit.json',
      position: { x: 120, y: 120 },
      size: { width: 360, height: 260 },
      ports: modulePorts,
    };
    const module = {
      schema: 'actoviq.module.v1',
      module_id: 'ldo',
      name: 'PMOS-pass LDO',
      revision: 0,
      ports: modulePorts,
      components: [],
      wires: [],
      annotations: [],
    };
    project.modules = [moduleRef];
    project.updated_at = new Date().toISOString();
    const moduleRoot = path.resolve(projectRoot, 'modules', 'ldo');
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
      '# PMOS-pass LDO',
      '',
      '```spice',
      '* Legacy notebook-only LDO fixture',
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
      '```',
      '',
    ].join('\n'), 'utf8');
    return { projectId: project.project_id, projectName: project.name };
  }

  async function createLegacyBjtResetProject() {
    const expectedProjectId = legacyProjectId('bjt-reset');
    const created = runSkill([
      'create',
      '--projects-root', projectsRoot,
      '--name', `${legacyBjtResetPrefix}${Date.now()}`,
      '--project-id', expectedProjectId,
    ]);
    const projectRoot = created.project_root;
    const project = created.project;
    assert.equal(project.project_id, expectedProjectId, 'legacy BJT reset fixture project id should not be truncated or reused');
    const modulePorts = [
      { id: 'vdd', name: '+3.3V', direction: 'input', signal_type: 'power', net: 'vdd' },
      { id: 'rst', name: 'RST', direction: 'input', signal_type: 'digital', net: 'rst' },
      { id: 'dtr', name: 'DTR', direction: 'input', signal_type: 'digital', net: 'dtr' },
      { id: 'rts', name: 'RTS', direction: 'output', signal_type: 'digital', net: 'rts' },
      { id: 'boot0', name: 'BOOT0', direction: 'output', signal_type: 'digital', net: 'boot0' },
      { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
    ];
    const moduleRef = {
      id: 'reset',
      name: 'BJT reset handshake',
      kind: 'interface',
      function: 'Two-transistor reset/boot control network used to verify KiCad-like discrete schematic layout.',
      parameters: { Vdd: '3.3 V' },
      notes: '',
      preview_enabled: true,
      source: 'modules/reset/module.circuit.json',
      position: { x: 120, y: 120 },
      size: { width: 420, height: 280 },
      ports: modulePorts,
    };
    const module = {
      schema: 'actoviq.module.v1',
      module_id: 'reset',
      name: 'BJT reset handshake',
      revision: 0,
      ports: modulePorts,
      components: [],
      wires: [],
      annotations: [],
    };
    project.modules = [moduleRef];
    project.updated_at = new Date().toISOString();
    const moduleRoot = path.resolve(projectRoot, 'modules', 'reset');
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
      '# BJT reset handshake',
      '',
      '```spice',
      '* Legacy notebook-only BJT reset/boot fixture',
      '.model S8050 NPN (IS=1e-14 BF=160)',
      '.model D4148 D (IS=2.52n RS=0.568 N=1.906)',
      'Q_BOOT vdd rts_drive boot_node S8050',
      'Q_RST rst_pull dtr_drive rts S8050',
      'D1 rst rst_pull D4148',
      'R50 vdd rst_pull 10k',
      'R51 dtr_drive dtr 1k',
      'R49 rts_drive rts 1k',
      'R52 boot_node boot0 1k',
      '.end',
      '```',
      '',
    ].join('\n'), 'utf8');
    return { projectId: project.project_id, projectName: project.name };
  }

  async function createLegacyVoltageDividerProject() {
    const expectedProjectId = legacyProjectId('divider');
    const created = runSkill([
      'create',
      '--projects-root', projectsRoot,
      '--name', `${legacyVoltageDividerPrefix}${Date.now()}`,
      '--project-id', expectedProjectId,
    ]);
    const projectRoot = created.project_root;
    const project = created.project;
    assert.equal(project.project_id, expectedProjectId, 'legacy divider fixture project id should not be truncated or reused');
    const modulePorts = [
      { id: 'vdd', name: '+5V', direction: 'input', signal_type: 'power', net: 'vdd' },
      { id: 'output', name: 'VOUT', direction: 'output', signal_type: 'analog', net: 'vout' },
      { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
    ];
    const moduleRef = {
      id: 'divider',
      name: 'Power-input voltage divider',
      kind: 'bias',
      function: 'Legacy notebook-only voltage divider used to verify power-fed passive schematic layout.',
      parameters: { Vin: '5.0 V', Ratio: '2:1' },
      notes: '',
      preview_enabled: true,
      source: 'modules/divider/module.circuit.json',
      position: { x: 120, y: 120 },
      size: { width: 360, height: 260 },
      ports: modulePorts,
    };
    const module = {
      schema: 'actoviq.module.v1',
      module_id: 'divider',
      name: 'Power-input voltage divider',
      revision: 0,
      ports: modulePorts,
      components: [],
      wires: [],
      annotations: [],
    };
    project.modules = [moduleRef];
    project.updated_at = new Date().toISOString();
    const moduleRoot = path.resolve(projectRoot, 'modules', 'divider');
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
      '# Power-input voltage divider',
      '',
      '```spice',
      '* Legacy notebook-only voltage divider fixture',
      'Rtop vdd vout 10k',
      'Rbot vout 0 20k',
      'Cflt vout 0 100n',
      '.end',
      '```',
      '',
    ].join('\n'), 'utf8');
    return { projectId: project.project_id, projectName: project.name };
  }

  async function createLegacyMosAmplifierProject() {
    const expectedProjectId = legacyProjectId('mos-amp');
    const created = runSkill([
      'create',
      '--projects-root', projectsRoot,
      '--name', `${legacyMosAmplifierPrefix}${Date.now()}`,
      '--project-id', expectedProjectId,
    ]);
    const projectRoot = created.project_root;
    const project = created.project;
    assert.equal(project.project_id, expectedProjectId, 'legacy MOS amplifier fixture project id should not be truncated or reused');
    const modulePorts = [
      { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
      { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
      { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
      { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
    ];
    const moduleRef = {
      id: 'mosamp',
      name: 'MOS common-source amplifier',
      kind: 'amplifier',
      function: 'Legacy notebook-only common-source stage used to verify MOS gate/body layout hydration.',
      parameters: { Gain: 'midband', Bias: 'resistive divider' },
      notes: '',
      preview_enabled: true,
      source: 'modules/mosamp/module.circuit.json',
      position: { x: 120, y: 120 },
      size: { width: 420, height: 280 },
      ports: modulePorts,
    };
    const module = {
      schema: 'actoviq.module.v1',
      module_id: 'mosamp',
      name: 'MOS common-source amplifier',
      revision: 0,
      ports: modulePorts,
      components: [],
      wires: [],
      annotations: [],
    };
    project.modules = [moduleRef];
    project.updated_at = new Date().toISOString();
    const moduleRoot = path.resolve(projectRoot, 'modules', 'mosamp');
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
      '# MOS common-source amplifier',
      '',
      '```spice',
      '* Legacy notebook-only MOS common-source amplifier fixture',
      '.model NMOS1 NMOS (LEVEL=1 VTO=1 KP=120u)',
      'Cin in gate 100n',
      'Rg1 vdd gate 1Meg',
      'Rg2 gate 0 220k',
      'M1 drain gate source 0 NMOS1 W=20u L=1u',
      'Rd vdd drain 10k',
      'Rs source 0 1k',
      'Cs source 0 10u',
      'Cout drain out 1u',
      'Rload out 0 100k',
      '.end',
      '```',
      '',
    ].join('\n'), 'utf8');
    return { projectId: project.project_id, projectName: project.name };
  }

  async function createLegacyCmosInverterProject() {
    const expectedProjectId = legacyProjectId('cmos-inv');
    const created = runSkill([
      'create',
      '--projects-root', projectsRoot,
      '--name', `${legacyCmosInverterPrefix}${Date.now()}`,
      '--project-id', expectedProjectId,
    ]);
    const projectRoot = created.project_root;
    const project = created.project;
    assert.equal(project.project_id, expectedProjectId, 'legacy CMOS inverter fixture project id should not be truncated or reused');
    const modulePorts = [
      { id: 'input', name: 'IN', direction: 'input', signal_type: 'digital', net: 'in' },
      { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
      { id: 'output', name: 'OUT', direction: 'output', signal_type: 'digital', net: 'out' },
      { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
    ];
    const moduleRef = {
      id: 'inverter',
      name: 'CMOS inverter',
      kind: 'logic',
      function: 'Legacy notebook-only CMOS inverter used to verify complementary MOS layout hydration.',
      parameters: { Vdd: '3.3 V', Load: '10 pF' },
      notes: '',
      preview_enabled: true,
      source: 'modules/inverter/module.circuit.json',
      position: { x: 120, y: 120 },
      size: { width: 420, height: 280 },
      ports: modulePorts,
    };
    const module = {
      schema: 'actoviq.module.v1',
      module_id: 'inverter',
      name: 'CMOS inverter',
      revision: 0,
      ports: modulePorts,
      components: [],
      wires: [],
      annotations: [],
    };
    project.modules = [moduleRef];
    project.updated_at = new Date().toISOString();
    const moduleRoot = path.resolve(projectRoot, 'modules', 'inverter');
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
      '# CMOS inverter',
      '',
      '```spice',
      '* Legacy notebook-only CMOS inverter fixture',
      '.model NMOS1 NMOS (LEVEL=1 VTO=0.7 KP=120u)',
      '.model PMOS1 PMOS (LEVEL=1 VTO=-0.7 KP=40u)',
      'MP1 out in vdd vdd PMOS1 W=40u L=1u',
      'MN1 out in 0 0 NMOS1 W=20u L=1u',
      'Cload out 0 10p',
      '.end',
      '```',
      '',
    ].join('\n'), 'utf8');
    return { projectId: project.project_id, projectName: project.name };
  }

  async function createLegacyCmosRingProject() {
    const expectedProjectId = legacyProjectId('cmos-ring');
    const created = runSkill([
      'create',
      '--projects-root', projectsRoot,
      '--name', `${legacyCmosRingPrefix}${Date.now()}`,
      '--project-id', expectedProjectId,
    ]);
    const projectRoot = created.project_root;
    const project = created.project;
    assert.equal(project.project_id, expectedProjectId, 'legacy CMOS ring fixture project id should not be truncated or reused');
    const modulePorts = [
      { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
      { id: 'output', name: 'OUT', direction: 'output', signal_type: 'digital', net: 'n3' },
      { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
    ];
    const moduleRef = {
      id: 'ring',
      name: 'CMOS ring oscillator',
      kind: 'oscillator',
      function: 'Three-stage CMOS ring oscillator used to verify closed-loop editable routing.',
      parameters: { Vdd: '5 V', Load: '120 fF per stage' },
      notes: '',
      preview_enabled: true,
      source: 'modules/ring/module.circuit.json',
      position: { x: 120, y: 120 },
      size: { width: 520, height: 320 },
      ports: modulePorts,
    };
    const module = {
      schema: 'actoviq.module.v1',
      module_id: 'ring',
      name: 'CMOS ring oscillator',
      revision: 0,
      ports: modulePorts,
      components: [],
      wires: [],
      annotations: [],
    };
    project.modules = [moduleRef];
    project.updated_at = new Date().toISOString();
    const moduleRoot = path.resolve(projectRoot, 'modules', 'ring');
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
      '# CMOS ring oscillator',
      '',
      '```spice',
      '* Three-stage CMOS ring oscillator fixture',
      '.model NMOS1 NMOS (LEVEL=1 VTO=0.9 KP=220u)',
      '.model PMOS1 PMOS (LEVEL=1 VTO=-0.9 KP=110u)',
      'M1 n1 n3 0 0 NMOS1 W=60u L=1u',
      'M2 n1 n3 vdd vdd PMOS1 W=120u L=1u',
      'M3 n2 n1 0 0 NMOS1 W=60u L=1u',
      'M4 n2 n1 vdd vdd PMOS1 W=120u L=1u',
      'M5 n3 n2 0 0 NMOS1 W=60u L=1u',
      'M6 n3 n2 vdd vdd PMOS1 W=120u L=1u',
      'C1 n1 0 120f',
      'C2 n2 0 120f',
      'C3 n3 0 120f',
      'RLEAK1 n1 0 5Meg',
      'RLEAK2 n2 0 5Meg',
      'RLEAK3 n3 0 5Meg',
      '.end',
      '```',
      '',
    ].join('\n'), 'utf8');
    return { projectId: project.project_id, projectName: project.name };
  }

  async function createLegacyDifferentialPairProject() {
    const expectedProjectId = legacyProjectId('diff-pair');
    const created = runSkill([
      'create',
      '--projects-root', projectsRoot,
      '--name', `${legacyDifferentialPairPrefix}${Date.now()}`,
      '--project-id', expectedProjectId,
    ]);
    const projectRoot = created.project_root;
    const project = created.project;
    assert.equal(project.project_id, expectedProjectId, 'legacy differential pair fixture project id should not be truncated or reused');
    const modulePorts = [
      { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
      { id: 'inp', name: 'IN+', direction: 'input', signal_type: 'analog', net: 'inp' },
      { id: 'inn', name: 'IN-', direction: 'input', signal_type: 'analog', net: 'inn' },
      { id: 'outp', name: 'OUT+', direction: 'output', signal_type: 'analog', net: 'outp' },
      { id: 'outn', name: 'OUT-', direction: 'output', signal_type: 'analog', net: 'outn' },
      { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
    ];
    const moduleRef = {
      id: 'diffpair',
      name: 'MOS differential pair',
      kind: 'amplifier',
      function: 'Legacy notebook-only NMOS differential pair used to verify analog pair layout hydration.',
      parameters: { Tail: '100 uA', Load: '10 kohm' },
      notes: '',
      preview_enabled: true,
      source: 'modules/diffpair/module.circuit.json',
      position: { x: 120, y: 120 },
      size: { width: 460, height: 300 },
      ports: modulePorts,
    };
    const module = {
      schema: 'actoviq.module.v1',
      module_id: 'diffpair',
      name: 'MOS differential pair',
      revision: 0,
      ports: modulePorts,
      components: [],
      wires: [],
      annotations: [],
    };
    project.modules = [moduleRef];
    project.updated_at = new Date().toISOString();
    const moduleRoot = path.resolve(projectRoot, 'modules', 'diffpair');
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
      '# MOS differential pair',
      '',
      '```spice',
      '* Legacy notebook-only MOS differential pair fixture',
      '.model NMOS1 NMOS (LEVEL=1 VTO=0.7 KP=120u)',
      'M_INP outp inp tail 0 NMOS1 W=20u L=1u',
      'M_INN outn inn tail 0 NMOS1 W=20u L=1u',
      'RDP vdd outp 10k',
      'RDN vdd outn 10k',
      'Itail tail 0 DC 100u',
      '.end',
      '```',
      '',
    ].join('\n'), 'utf8');
    return { projectId: project.project_id, projectName: project.name };
  }

  async function createLegacyCurrentMirrorProject() {
    const expectedProjectId = legacyProjectId('mirror');
    const created = runSkill([
      'create',
      '--projects-root', projectsRoot,
      '--name', `${legacyCurrentMirrorPrefix}${Date.now()}`,
      '--project-id', expectedProjectId,
    ]);
    const projectRoot = created.project_root;
    const project = created.project;
    assert.equal(project.project_id, expectedProjectId, 'legacy current mirror fixture project id should not be truncated or reused');
    const modulePorts = [
      { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
      { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
      { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
    ];
    const moduleRef = {
      id: 'mirror',
      name: 'NMOS current mirror',
      kind: 'bias',
      function: 'Legacy notebook-only NMOS current mirror used to verify diode-connected mirror layout hydration.',
      parameters: { Iref: '100 uA', Load: '10 kohm' },
      notes: '',
      preview_enabled: true,
      source: 'modules/mirror/module.circuit.json',
      position: { x: 120, y: 120 },
      size: { width: 420, height: 280 },
      ports: modulePorts,
    };
    const module = {
      schema: 'actoviq.module.v1',
      module_id: 'mirror',
      name: 'NMOS current mirror',
      revision: 0,
      ports: modulePorts,
      components: [],
      wires: [],
      annotations: [],
    };
    project.modules = [moduleRef];
    project.updated_at = new Date().toISOString();
    const moduleRoot = path.resolve(projectRoot, 'modules', 'mirror');
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
      '# NMOS current mirror',
      '',
      '```spice',
      '* Legacy notebook-only current mirror fixture',
      '.model NMOS1 NMOS (LEVEL=1 VTO=0.7 KP=120u)',
      'IREF vdd bias DC 100u',
      'MREF bias bias 0 0 NMOS1 W=20u L=1u',
      'MOUT out bias 0 0 NMOS1 W=20u L=1u',
      'RLOAD vdd out 10k',
      '.end',
      '```',
      '',
    ].join('\n'), 'utf8');
    return { projectId: project.project_id, projectName: project.name };
  }

  async function createLegacyOpampFeedbackProject() {
    const expectedProjectId = legacyProjectId('opamp');
    const created = runSkill([
      'create',
      '--projects-root', projectsRoot,
      '--name', `${legacyOpampFeedbackPrefix}${Date.now()}`,
      '--project-id', expectedProjectId,
      '--project-kind', 'analog_ic',
    ]);
    const projectRoot = created.project_root;
    const project = created.project;
    assert.equal(project.project_id, expectedProjectId, 'legacy opamp feedback fixture project id should not be truncated or reused');
    const modulePorts = [
      { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
      { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
      { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'vout' },
      { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
    ];
    const moduleRef = {
      id: 'opamp',
      name: 'Opamp feedback amplifier',
      kind: 'amplifier',
      function: 'Legacy notebook-only VCVS opamp feedback stage used to verify editable opamp hydration.',
      parameters: { Gain: '10x', Load: '10 kohm' },
      notes: '',
      preview_enabled: true,
      source: 'modules/opamp/module.circuit.json',
      position: { x: 120, y: 120 },
      size: { width: 460, height: 300 },
      ports: modulePorts,
    };
    const module = {
      schema: 'actoviq.module.v1',
      module_id: 'opamp',
      name: 'Opamp feedback amplifier',
      revision: 0,
      ports: modulePorts,
      components: [],
      wires: [],
      annotations: [],
    };
    project.modules = [moduleRef];
    project.updated_at = new Date().toISOString();
    const moduleRoot = path.resolve(projectRoot, 'modules', 'opamp');
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
      '# Opamp feedback amplifier',
      '',
      '```spice',
      '* Legacy notebook-only VCVS opamp feedback fixture',
      'Vsupply vdd 0 DC 5',
      'Vin in 0 DC 1 AC 1',
      'EOPAMP vout 0 in fb 100k',
      'R2F vout fb 90k',
      'R1F fb 0 10k',
      'Cload vout 0 10p',
      'Rload vout 0 10k',
      '.end',
      '```',
      '',
    ].join('\n'), 'utf8');
    return { projectId: project.project_id, projectName: project.name, projectRoot };
  }

  async function createLegacyCascodeProject() {
    const expectedProjectId = legacyProjectId('cascode');
    const created = runSkill([
      'create',
      '--projects-root', projectsRoot,
      '--name', `${legacyCascodePrefix}${Date.now()}`,
      '--project-id', expectedProjectId,
    ]);
    const projectRoot = created.project_root;
    const project = created.project;
    assert.equal(project.project_id, expectedProjectId, 'legacy cascode fixture project id should not be truncated or reused');
    const modulePorts = [
      { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
      { id: 'vdd', name: 'VDD', direction: 'input', signal_type: 'power', net: 'vdd' },
      { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
      { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
    ];
    const moduleRef = {
      id: 'cascode',
      name: 'MOS cascode amplifier',
      kind: 'amplifier',
      function: 'Legacy notebook-only MOS cascode amplifier used to verify stacked MOS layout hydration.',
      parameters: { Bias: '350 uA', Load: '25 kohm' },
      notes: '',
      preview_enabled: true,
      source: 'modules/cascode/module.circuit.json',
      position: { x: 120, y: 120 },
      size: { width: 500, height: 320 },
      ports: modulePorts,
    };
    const module = {
      schema: 'actoviq.module.v1',
      module_id: 'cascode',
      name: 'MOS cascode amplifier',
      revision: 0,
      ports: modulePorts,
      components: [],
      wires: [],
      annotations: [],
    };
    project.modules = [moduleRef];
    project.updated_at = new Date().toISOString();
    const moduleRoot = path.resolve(projectRoot, 'modules', 'cascode');
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
      '# MOS cascode amplifier',
      '',
      '```spice',
      '* Legacy notebook-only MOS cascode amplifier fixture',
      '.model NMOS NMOS(LEVEL=1 VTO=0.8 KP=250u LAMBDA=0.03)',
      'VDD vdd 0 DC 5',
      'VIN in 0 AC 1',
      'VBIAS vb 0 DC 1.85',
      'I1 vdd ns DC 350u',
      'RS ns 0 1.2k',
      'M1 nd in ns 0 NMOS W=800u L=1u',
      'M2 no vb nd 0 NMOS W=500u L=1u',
      'RL vdd no 25k',
      'CINT no 0 1.5p',
      'CCOMP no in 0.8p',
      'ROUT no out 8ohm',
      'CLOAD out 0 12p',
      'RPROBE out 0 1Meg',
      '.end',
      '```',
      '',
    ].join('\n'), 'utf8');
    return { projectId: project.project_id, projectName: project.name };
  }

  async function createLegacyBuckConverterProject() {
    const expectedProjectId = legacyProjectId('buck');
    const created = runSkill([
      'create',
      '--projects-root', projectsRoot,
      '--name', `${legacyBuckConverterPrefix}${Date.now()}`,
      '--project-id', expectedProjectId,
    ]);
    const projectRoot = created.project_root;
    const project = created.project;
    assert.equal(project.project_id, expectedProjectId, 'legacy buck fixture project id should not be truncated or reused');
    const modulePorts = [
      { id: 'vin', name: 'VIN', direction: 'input', signal_type: 'power', net: 'vin' },
      { id: 'vout', name: 'VOUT', direction: 'output', signal_type: 'analog', net: 'vout' },
      { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
    ];
    const moduleRef = {
      id: 'buck',
      name: 'PMOS buck converter',
      kind: 'regulator',
      function: 'Legacy notebook-only buck converter used to verify power-stage schematic hydration.',
      parameters: { Vin: '12 V', Vout: 'switched' },
      notes: '',
      preview_enabled: true,
      source: 'modules/buck/module.circuit.json',
      position: { x: 120, y: 120 },
      size: { width: 480, height: 300 },
      ports: modulePorts,
    };
    const module = {
      schema: 'actoviq.module.v1',
      module_id: 'buck',
      name: 'PMOS buck converter',
      revision: 0,
      ports: modulePorts,
      components: [],
      wires: [],
      annotations: [],
    };
    project.modules = [moduleRef];
    project.updated_at = new Date().toISOString();
    const moduleRoot = path.resolve(projectRoot, 'modules', 'buck');
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'netlist-notebook.md'), [
      '# PMOS buck converter',
      '',
      '```spice',
      '* Legacy notebook-only buck converter fixture',
      '.model PMOS1 PMOS (LEVEL=1 VTO=-0.8 KP=60u)',
      '.model DFAST D(IS=1n RS=0.1 TT=10n)',
      'Vin vin 0 DC 12',
      'Vgate gate 0 PULSE(12 0 0 20n 20n 5u 10u)',
      'Msw sw gate vin vin PMOS1 W=200u L=1u',
      'Dfree 0 sw DFAST',
      'L1 sw vout 22u',
      'Cout vout 0 47u',
      'Rload vout 0 10',
      '.end',
      '```',
      '',
    ].join('\n'), 'utf8');
    return { projectId: project.project_id, projectName: project.name };
  }

  async function createJunctionInteractionProject() {
    const expectedProjectId = legacyProjectId('junction');
    const created = runSkill([
      'create',
      '--projects-root', projectsRoot,
      '--name', `${junctionInteractionPrefix}${Date.now()}`,
      '--project-id', expectedProjectId,
    ]);
    const projectRoot = created.project_root;
    const project = created.project;
    assert.equal(project.project_id, expectedProjectId, 'junction interaction fixture project id should be stable');
    const ports = [
      {
        id: 'out',
        name: 'OUT',
        direction: 'output',
        signal_type: 'analog',
        net: 'OUT',
        net_id: 'net_out',
        position: { x: 800, y: 300 },
      },
    ];
    const moduleRef = {
      id: 'junctions',
      name: 'Junction interaction fixture',
      kind: 'test',
      function: 'Known wire geometry for KiCad-like crossing and junction interactions.',
      parameters: {},
      notes: '',
      preview_enabled: true,
      source: 'modules/junctions/module.circuit.json',
      position: { x: 120, y: 120 },
      size: { width: 500, height: 320 },
      ports,
    };
    const module = {
      schema: 'actoviq.module.v2',
      module_id: 'junctions',
      name: 'Junction interaction fixture',
      revision: 0,
      ports,
      nets: [
        { id: 'net_h', name: 'HNET', kind: 'signal', aliases: [] },
        { id: 'net_v', name: 'VNET', kind: 'signal', aliases: [] },
        { id: 'net_trunk', name: 'TRUNK', kind: 'signal', aliases: [] },
        { id: 'net_out', name: 'OUT', kind: 'signal', aliases: [] },
        { id: 'net_spare', name: 'SPARE', kind: 'signal', aliases: [] },
      ],
      components: [
        {
          id: 'r_branch',
          type: 'R',
          name: 'RBRANCH',
          value: '1k',
          position: { x: 620, y: 300 },
          rotation: 0,
          pins: [
            { id: 'p1', name: '1', net: 'TRUNK', net_id: 'net_trunk' },
            { id: 'p2', name: '2', net: 'OUT', net_id: 'net_out' },
          ],
        },
        {
          id: 'spare_block',
          type: 'BLOCK',
          name: 'SPARE',
          value: 'unused',
          position: { x: 640, y: 100 },
          rotation: 0,
          block: { width: 180, height: 84 },
          pins: [
            {
              id: 'nc',
              name: 'NC',
              net: 'SPARE',
              net_id: 'net_spare',
              side: 'left',
              order: 0,
            },
          ],
        },
      ],
      wires: [
        {
          id: 'cross_h',
          net: 'HNET',
          net_id: 'net_h',
          source: 'stored',
          from: { x: 160, y: 120, junction_id: 'j_cross_h_left' },
          to: { x: 480, y: 120, junction_id: 'j_cross_h_right' },
          points: [{ x: 160, y: 120 }, { x: 480, y: 120 }],
        },
        {
          id: 'cross_v',
          net: 'VNET',
          net_id: 'net_v',
          source: 'stored',
          from: { x: 320, y: 40, junction_id: 'j_cross_v_top' },
          to: { x: 320, y: 200, junction_id: 'j_cross_v_bottom' },
          points: [{ x: 320, y: 40 }, { x: 320, y: 200 }],
        },
        {
          id: 'trunk_left',
          net: 'TRUNK',
          net_id: 'net_trunk',
          source: 'stored',
          from: { x: 160, y: 300, junction_id: 'j_trunk_left' },
          to: { x: 320, y: 300, junction_id: 'j_trunk_center' },
          points: [{ x: 160, y: 300 }, { x: 320, y: 300 }],
        },
        {
          id: 'trunk_right',
          net: 'TRUNK',
          net_id: 'net_trunk',
          source: 'stored',
          from: { x: 320, y: 300, junction_id: 'j_trunk_center' },
          to: { x: 480, y: 300, junction_id: 'j_trunk_right' },
          points: [{ x: 320, y: 300 }, { x: 480, y: 300 }],
        },
        {
          id: 'trunk_branch',
          net: 'TRUNK',
          net_id: 'net_trunk',
          source: 'stored',
          from: { x: 320, y: 300, junction_id: 'j_trunk_center' },
          to: { x: 320, y: 420, junction_id: 'j_trunk_bottom' },
          points: [{ x: 320, y: 300 }, { x: 320, y: 420 }],
        },
        {
          id: 'branch_to_resistor',
          net: 'TRUNK',
          net_id: 'net_trunk',
          source: 'stored',
          from: { x: 480, y: 300, junction_id: 'j_trunk_right' },
          to: { x: 568, y: 300, component_id: 'r_branch', pin_id: 'p1' },
          points: [{ x: 480, y: 300 }, { x: 568, y: 300 }],
        },
        {
          id: 'resistor_to_out',
          net: 'OUT',
          net_id: 'net_out',
          source: 'stored',
          from: { x: 672, y: 300, component_id: 'r_branch', pin_id: 'p2' },
          to: { x: 800, y: 300, port_id: 'out' },
          points: [{ x: 672, y: 300 }, { x: 800, y: 300 }],
        },
      ],
      annotations: [],
    };
    project.modules = [moduleRef];
    project.updated_at = new Date().toISOString();
    const moduleRoot = path.resolve(projectRoot, 'modules', 'junctions');
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
    return { projectId: project.project_id, projectName: project.name, projectRoot };
  }

  async function createUnconnectedPortProject() {
    const expectedProjectId = legacyProjectId('ports');
    const created = runSkill([
      'create',
      '--projects-root', projectsRoot,
      '--name', `${projectPrefix}ports-${Date.now()}`,
      '--project-id', expectedProjectId,
    ]);
    const projectRoot = created.project_root;
    const project = created.project;
    assert.equal(project.project_id, expectedProjectId, 'unconnected-port fixture project id should be stable');
    const nets = [
      { id: 'net_in', name: 'in_net', kind: 'signal', aliases: [] },
      { id: 'net_tail', name: 'tail_net', kind: 'signal', aliases: [] },
      { id: 'net_spare', name: 'spare_net', kind: 'signal', aliases: [] },
    ];
    const ports = [
      { id: 'inp', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in_net', net_id: 'net_in', position: { x: 100, y: 200 } },
      { id: 'spare', name: 'SPARE', direction: 'output', signal_type: 'analog', net: 'spare_net', net_id: 'net_spare', position: { x: 520, y: 200 } },
    ];
    const moduleRef = {
      id: 'ports',
      name: 'Unconnected port fixture',
      kind: 'test',
      function: 'One wired port and one dangling port to verify dimmed rendering and wire snapping.',
      parameters: {},
      notes: '',
      preview_enabled: true,
      source: 'modules/ports/module.circuit.json',
      position: { x: 120, y: 120 },
      size: { width: 420, height: 260 },
      ports,
    };
    const module = {
      schema: 'actoviq.module.v2',
      module_id: 'ports',
      name: 'Unconnected port fixture',
      revision: 0,
      ports,
      nets,
      components: [
        {
          id: 'r1',
          type: 'R',
          name: 'R1',
          value: '1k',
          position: { x: 300, y: 200 },
          rotation: 0,
          pins: [
            { id: 'a', name: '1', net: 'in_net', net_id: 'net_in' },
            { id: 'b', name: '2', net: 'tail_net', net_id: 'net_tail' },
          ],
        },
      ],
      wires: [
        {
          id: 'w_in',
          net: 'in_net',
          net_id: 'net_in',
          source: 'stored',
          from: { x: 100, y: 200, port_id: 'inp' },
          to: { x: 248, y: 200, component_id: 'r1', pin_id: 'a' },
          points: [{ x: 100, y: 200 }, { x: 248, y: 200 }],
        },
      ],
      annotations: [],
    };
    project.modules = [moduleRef];
    project.updated_at = new Date().toISOString();
    const moduleRoot = path.resolve(projectRoot, 'modules', 'ports');
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.resolve(projectRoot, 'project.circuit.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(moduleRoot, 'module.circuit.json'), `${JSON.stringify(module, null, 2)}\n`, 'utf8');
    return { projectId: project.project_id, projectName: project.name, projectRoot };
  }

  async function componentPositions(page) {
    const raw = await page.getByTestId('schematic-editor').getAttribute('data-component-positions');
    return JSON.parse(raw || '{}');
  }

  async function portPositions(page) {
    const raw = await page.getByTestId('schematic-editor').getAttribute('data-port-positions');
    return JSON.parse(raw || '{}');
  }

  async function componentRotations(page) {
    const raw = await page.getByTestId('schematic-editor').getAttribute('data-component-rotations');
    return JSON.parse(raw || '{}');
  }

  async function componentPinNets(page, componentId) {
    return page.getByTestId('schematic-editor-svg').locator(
      `g[data-component-id="${componentId}"] circle[data-endpoint-kind="pin"]`,
    ).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-net') ?? ''));
  }

  async function editorViewBox(page) {
    const raw = await page.getByTestId('schematic-editor-svg').getAttribute('viewBox');
    const [minX, minY, width, height] = String(raw || '0 0 1 1').trim().split(/\s+/).map(Number);
    return { minX, minY, width, height };
  }

  async function editorZoom(page) {
    return Number(await page.getByTestId('schematic-editor').getAttribute('data-zoom'));
  }

  async function editorViewport(page) {
    const raw = await page.getByTestId('schematic-editor').getAttribute('data-viewport');
    return JSON.parse(raw || '{}');
  }

  async function editorWires(page) {
    const raw = await page.getByTestId('schematic-editor').getAttribute('data-wires');
    return JSON.parse(raw || '[]');
  }

  async function renderedJunctions(page) {
    return page.getByTestId('schematic-editor-svg').getByTestId('schematic-junction').evaluateAll((nodes) => (
      nodes.map((node) => ({
        x: Number(node.getAttribute('cx')),
        y: Number(node.getAttribute('cy')),
        net: node.getAttribute('data-net') ?? '',
      }))
    ));
  }

  function hasRenderedJunction(junctions, point, net) {
    return junctions.some((junction) => (
      junction.x === point.x && junction.y === point.y && (!net || junction.net === net)
    ));
  }

  async function waitForEditorIdle(page) {
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return node?.getAttribute('data-busy') === 'false' &&
        node?.getAttribute('data-preview-busy') === 'false';
    });
  }

  /** Open a hub module card without stalling on hub SVG rebuild actionability. */
  async function openModuleCard(page, moduleId) {
    const card = page.getByTestId(`module-card-${moduleId}`);
    await card.waitFor({ state: 'visible' });
    // Module cards open via React onClick(detail===2). Hub netlistsvg rebuilds make
    // Playwright dblclick hang mid-action on large modules, so fire the event directly.
    await card.evaluate((node) => {
      node.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        detail: 2,
        view: window,
      }));
    });
  }

  async function focusEditorByClickingCanvas(page) {
    const box = await page.getByTestId('schematic-editor-svg').boundingBox();
    assert.ok(box, 'schematic editor canvas has no bounding box');
    await page.mouse.click(box.x + 12, box.y + 12);
    await page.getByTestId('schematic-editor').focus();
  }

  async function componentPinWorldPoints(page, componentId) {
    return page.getByTestId('schematic-editor-svg').locator(
      `circle[data-endpoint-kind="pin"][data-component-id="${componentId}"]`,
    ).evaluateAll((nodes) => Object.fromEntries(nodes.map((node) => [
      node.getAttribute('data-pin-id') ?? '',
      {
        x: Number(node.getAttribute('cx')),
        y: Number(node.getAttribute('cy')),
      },
    ]).filter(([pinId]) => pinId)));
  }

  async function assertWireEndpointsMatchComponentPins(page, componentId, label) {
    const [pins, wires] = await Promise.all([
      componentPinWorldPoints(page, componentId),
      editorWires(page),
    ]);
    const endpoints = [];
    for (const wire of wires) {
      const first = wire.points?.[0];
      const last = wire.points?.[wire.points.length - 1];
      if (wire.from?.component_id === componentId && first) {
        endpoints.push({ endpoint: wire.from, point: first, wireId: wire.id, side: 'from' });
      }
      if (wire.to?.component_id === componentId && last) {
        endpoints.push({ endpoint: wire.to, point: last, wireId: wire.id, side: 'to' });
      }
    }
    assert.ok(endpoints.length > 0, `${label}: no connected wire endpoints for ${componentId}`);
    for (const { endpoint, point, wireId, side } of endpoints) {
      const pin = pins[endpoint.pin_id];
      assert.ok(pin, `${label}: missing pin ${endpoint.pin_id} for ${componentId}.${side} on ${wireId}`);
      assert.equal(Number(point.x), Number(pin.x), `${label}: ${wireId}.${side} x is not on ${componentId}.${endpoint.pin_id}`);
      assert.equal(Number(point.y), Number(pin.y), `${label}: ${wireId}.${side} y is not on ${componentId}.${endpoint.pin_id}`);
    }
  }

  async function assertAttachedWiresAvoidComponentInterior(page, componentId, label) {
    const bad = await page.evaluate((id) => {
      const editor = document.querySelector('[data-testid="schematic-editor"]');
      const wires = JSON.parse(editor?.getAttribute('data-wires') ?? '[]');
      const components = JSON.parse(editor?.getAttribute('data-components') ?? '[]');
      const positions = JSON.parse(editor?.getAttribute('data-component-positions') ?? '{}');
      const component = components.find((entry) => entry.id === id);
      const position = positions[id];
      if (!component || !position) return [{ reason: 'missing-component' }];
      // Approximate body interior from the live selection frame when present; otherwise
      // use a tight box around the component center (enough to catch through-body routes).
      const frame = document.querySelector(
        `[data-testid="schematic-editor-svg"] g[data-component-id="${id}"] [data-testid="schematic-selected-component-frame"]`,
      );
      let interior;
      if (frame instanceof SVGGraphicsElement) {
        const box = frame.getBBox();
        const inset = 10;
        interior = {
          minX: box.x + inset,
          minY: box.y + inset,
          maxX: box.x + box.width - inset,
          maxY: box.y + box.height - inset,
        };
      } else {
        interior = {
          minX: Number(position.x) - 18,
          minY: Number(position.y) - 18,
          maxX: Number(position.x) + 18,
          maxY: Number(position.y) + 18,
        };
      }
      const attached = wires.filter((wire) => (
        wire.from?.component_id === id || wire.to?.component_id === id
      ));
      const hits = [];
      for (const wire of attached) {
        const points = wire.points ?? [];
        for (let index = 1; index < points.length; index += 1) {
          const start = points[index - 1];
          const end = points[index];
          if (!start || !end) continue;
          const crosses = start.x === end.x
            ? start.x > interior.minX && start.x < interior.maxX &&
              Math.min(start.y, end.y) < interior.maxY && Math.max(start.y, end.y) > interior.minY
            : start.y === end.y
              ? start.y > interior.minY && start.y < interior.maxY &&
                Math.min(start.x, end.x) < interior.maxX && Math.max(start.x, end.x) > interior.minX
              : false;
          if (crosses) hits.push({ wireId: wire.id, index, start, end, interior });
        }
      }
      return hits;
    }, componentId);
    assert.deepEqual(bad, [], `${label}: attached wires cross ${componentId} interior during drag`);
  }

  function longestEditableGeneratedWireSegment(wires) {
    let best = null;
    for (const wire of wires.filter((entry) => entry.source === 'net')) {
      const points = wire.points ?? [];
      for (let index = 1; index < points.length; index += 1) {
        const start = points[index - 1];
        const end = points[index];
        if (!start || !end) continue;
        const length = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
        if (length < 60) continue;
        if (!best || length > best.length) {
          best = { wire, segmentIndex: index, start, end, length };
        }
      }
    }
    return best;
  }

  function worldToScreen(point, viewBox, svgBox) {
    const scale = Math.min(svgBox.width / viewBox.width, svgBox.height / viewBox.height);
    const xOffset = (svgBox.width - viewBox.width * scale) / 2;
    const yOffset = (svgBox.height - viewBox.height * scale) / 2;
    return {
      x: svgBox.x + xOffset + (point.x - viewBox.minX) * scale,
      y: svgBox.y + yOffset + (point.y - viewBox.minY) * scale,
    };
  }

  async function componentScreenCenter(page, componentId) {
    return componentScreenPoint(page, componentId, { x: 0, y: 0 });
  }

  async function componentScreenPoint(page, componentId, offset = { x: 0, y: 0 }) {
    const positions = await componentPositions(page);
    const position = positions[componentId];
    if (!position) throw new Error(`Component ${componentId} position is not exposed`);
    const viewBox = await editorViewBox(page);
    const svgBox = await page.getByTestId('schematic-editor-svg').boundingBox();
    assert.ok(svgBox);
    return worldToScreen({ x: position.x + offset.x, y: position.y + offset.y }, viewBox, svgBox);
  }

  async function portScreenPoint(page, portId) {
    const box = await page.getByTestId('schematic-editor-svg').locator(
      `g[data-port-id="${portId}"] [data-testid="schematic-port-hit-target"]`,
    ).boundingBox();
    assert.ok(box, `Port ${portId} has no visible SVG hit target`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  async function selectedComponentFrameScreenPoint(page, componentId, offset = { x: 0, y: 0 }) {
    return page.getByTestId('schematic-editor-svg').locator(
      `g[data-component-id="${componentId}"] [data-testid="schematic-selected-component-frame"]`,
    ).evaluate((node, pointOffset) => {
      if (!(node instanceof SVGGraphicsElement)) {
        throw new Error('selected component frame is not an SVG graphics element');
      }
      const svg = node.ownerSVGElement;
      const matrix = svg?.getScreenCTM();
      if (!svg || !matrix) throw new Error('selected component frame has no SVG screen matrix');
      const box = node.getBBox();
      const point = svg.createSVGPoint();
      point.x = box.x + box.width / 2 + Number(pointOffset.x);
      point.y = box.y + box.height / 2 + Number(pointOffset.y);
      const screenPoint = point.matrixTransform(matrix);
      return { x: screenPoint.x, y: screenPoint.y };
    }, offset);
  }

  async function selectedComponentFrameEdgeScreenPoint(page, componentId) {
    return page.getByTestId('schematic-editor-svg').locator(
      `g[data-component-id="${componentId}"] [data-testid="schematic-selected-component-frame"]`,
    ).evaluate((node) => {
      if (!(node instanceof SVGGraphicsElement)) {
        throw new Error('selected component frame is not an SVG graphics element');
      }
      const svg = node.ownerSVGElement;
      const matrix = svg?.getScreenCTM();
      if (!svg || !matrix) throw new Error('selected component frame has no SVG screen matrix');
      const box = node.getBBox();
      const point = svg.createSVGPoint();
      point.x = box.x + box.width / 2;
      point.y = box.y;
      const screenPoint = point.matrixTransform(matrix);
      return { x: screenPoint.x, y: screenPoint.y };
    });
  }

  async function selectedComponentCornerScreenPoint(page, componentId, cornerIndex = 0) {
    return page.getByTestId('schematic-editor-svg').locator(
      `g[data-component-id="${componentId}"] [data-testid="schematic-selected-component-corner"]`,
    ).nth(cornerIndex).evaluate((node) => {
      if (!(node instanceof SVGGraphicsElement)) {
        throw new Error('selected component corner is not an SVG graphics element');
      }
      const svg = node.ownerSVGElement;
      const matrix = svg?.getScreenCTM();
      if (!svg || !matrix) throw new Error('selected component corner has no SVG screen matrix');
      const box = node.getBBox();
      const point = svg.createSVGPoint();
      point.x = box.x + box.width / 2;
      point.y = box.y + box.height / 2;
      const screenPoint = point.matrixTransform(matrix);
      return { x: screenPoint.x, y: screenPoint.y };
    });
  }

  async function selectComponentForDrag(page, componentId, offsets = [{ x: 0, y: 0 }]) {
    await page.getByTestId('schematic-editor-select').click();
    // Clear multi-selection first so a body click selects only the target component.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === ''
    )).catch(() => undefined);
    for (const offset of offsets) {
      const point = await componentScreenPoint(page, componentId, offset);
      await page.mouse.move(point.x, point.y);
      await page.mouse.click(point.x, point.y);
      const selected = await page.waitForFunction((id) => (
        document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === `component:${id}`
      ), componentId, { timeout: 1200 }).then(() => true).catch(() => false);
      if (selected) return point;
    }
    throw new Error(`Component ${componentId} could not be selected for drag`);
  }

  function assertPositionEqual(actual, expected, label) {
    assert.deepEqual(
      { x: Number(actual?.x), y: Number(actual?.y) },
      { x: Number(expected?.x), y: Number(expected?.y) },
      label,
    );
  }

  function assertPositionChanged(actual, expected, label) {
    assert.notDeepEqual(
      { x: Number(actual?.x), y: Number(actual?.y) },
      { x: Number(expected?.x), y: Number(expected?.y) },
      label,
    );
  }

  function assertWireOrthogonal(wire, label) {
    assert.ok(wire, `${label}: wire is missing`);
    assert.ok(Array.isArray(wire.points) && wire.points.length >= 2, `${label}: wire has too few points`);
    for (let index = 1; index < wire.points.length; index += 1) {
      const start = wire.points[index - 1];
      const end = wire.points[index];
      assert.ok(start && end, `${label}: segment ${index} is missing endpoints`);
      assert.ok(
        Number(start.x) === Number(end.x) || Number(start.y) === Number(end.y),
        `${label}: segment ${index} is not orthogonal`,
      );
    }
  }

  function assertWiresOrthogonal(wires, label) {
    for (const wire of wires) {
      assertWireOrthogonal(wire, `${label}.${wire.id}`);
    }
  }

  function assertPortWireEndpoints(wires, portId, position, label) {
    const connected = wires.filter((wire) => wire.from?.port_id === portId || wire.to?.port_id === portId);
    assert.ok(connected.length > 0, `${label}: no wire is connected to port ${portId}`);
    for (const wire of connected) {
      if (wire.from?.port_id === portId) {
        assertPositionEqual(wire.points?.[0], position, `${label}: ${wire.id}.from does not follow port ${portId}`);
      }
      if (wire.to?.port_id === portId) {
        assertPositionEqual(wire.points?.[wire.points.length - 1], position, `${label}: ${wire.id}.to does not follow port ${portId}`);
      }
    }
  }

  function assertUnrelatedWireRoutesStable(beforeWires, duringWires, draggedComponentIds, label) {
    const draggedIds = new Set(draggedComponentIds);
    const duringById = new Map(duringWires.map((wire) => [wire.id, wire]));
    const changed = [];
    for (const wire of beforeWires) {
      if (wire.from?.component_id && draggedIds.has(wire.from.component_id)) continue;
      if (wire.to?.component_id && draggedIds.has(wire.to.component_id)) continue;
      const during = duringById.get(wire.id);
      if (!during || JSON.stringify(during.points) !== JSON.stringify(wire.points)) {
        changed.push({ id: wire.id, before: wire.points, during: during?.points ?? null });
      }
    }
    assert.deepEqual(changed, [], `${label}: unrelated wire routes changed during component drag preview`);
  }

  async function assertRenderedWirePolylinesOrthogonal(page, label) {
    const badSegments = await page.getByTestId('schematic-editor-svg').locator('g[data-wire-id] polyline').evaluateAll((nodes) => (
      nodes.flatMap((node) => {
        if (!(node instanceof SVGPolylineElement)) return [];
        if (node.getAttribute('stroke') === 'transparent') return [];
        const wireId = node.closest('g[data-wire-id]')?.getAttribute('data-wire-id') ?? 'unknown';
        const points = (node.getAttribute('points') ?? '').trim().split(/\s+/).filter(Boolean).map((pair) => {
          const [x, y] = pair.split(',').map(Number);
          return { x, y };
        });
        const bad = [];
        for (let index = 1; index < points.length; index += 1) {
          const start = points[index - 1];
          const end = points[index];
          if (!start || !end) continue;
          if (Number(start.x) !== Number(end.x) && Number(start.y) !== Number(end.y)) {
            bad.push({ wireId, index, start, end });
          }
        }
        return bad;
      })
    ));
    assert.deepEqual(badSegments, [], `${label}: rendered schematic wire polylines contain diagonal segments`);
  }

  async function wireScreenPointAwayFromComponents(page, wireId) {
    return page.getByTestId('schematic-editor-svg').evaluate((svg, id) => {
      if (!(svg instanceof SVGSVGElement)) throw new Error('schematic editor svg is not an SVG element');
      const editor = document.querySelector('[data-testid="schematic-editor"]');
      const wires = JSON.parse(editor?.getAttribute('data-wires') ?? '[]');
      const wire = wires.find((entry) => entry.id === id);
      if (!wire || !Array.isArray(wire.points) || wire.points.length < 2) {
        throw new Error(`wire ${id} points not found`);
      }
      const componentPositions = Object.values(JSON.parse(editor?.getAttribute('data-component-positions') ?? '{}'));
      const portPositions = Object.values(JSON.parse(editor?.getAttribute('data-port-positions') ?? '{}'));
      const interactionPositions = [...componentPositions, ...portPositions];
      let best = null;
      for (let index = 1; index < wire.points.length; index += 1) {
        const start = wire.points[index - 1];
        const end = wire.points[index];
        if (!start || !end) continue;
        for (let step = 2; step <= 8; step += 1) {
          const ratio = step / 10;
          const point = {
            x: start.x + (end.x - start.x) * ratio,
            y: start.y + (end.y - start.y) * ratio,
          };
          const nearestInteractionTarget = interactionPositions.reduce((nearest, position) => {
            const dx = point.x - Number(position.x);
            const dy = point.y - Number(position.y);
            return Math.min(nearest, Math.hypot(dx, dy));
          }, Number.POSITIVE_INFINITY);
          if (!best || nearestInteractionTarget > best.nearestInteractionTarget) {
            best = { point, nearestInteractionTarget };
          }
        }
      }
      if (!best) throw new Error(`wire ${id} has no selectable candidate point`);
      const matrix = svg.getScreenCTM();
      if (!matrix) throw new Error('schematic editor svg has no screen matrix');
      const svgPoint = svg.createSVGPoint();
      svgPoint.x = best.point.x;
      svgPoint.y = best.point.y;
      const screenPoint = svgPoint.matrixTransform(matrix);
      return { x: screenPoint.x, y: screenPoint.y };
    }, wireId);
  }

  async function wireHandleScreenPoint(page, wireId, pointIndex) {
    return page.getByTestId('schematic-editor-svg').locator(
      `[data-testid="schematic-wire-point-handle"][data-wire-id="${wireId}"][data-point-index="${pointIndex}"]`,
    ).evaluate((node) => {
      if (!(node instanceof SVGCircleElement)) {
        throw new Error('wire handle is not an SVG circle');
      }
      const svg = node.ownerSVGElement;
      const matrix = svg?.getScreenCTM();
      if (!svg || !matrix) throw new Error('wire handle has no SVG screen matrix');
      const point = svg.createSVGPoint();
      point.x = Number(node.getAttribute('cx'));
      point.y = Number(node.getAttribute('cy'));
      const screenPoint = point.matrixTransform(matrix);
      return { x: screenPoint.x, y: screenPoint.y };
    });
  }

  async function countVisibleSchematicWires(page) {
    return page.getByTestId('schematic-editor-svg').locator('g[data-wire-id] polyline:not([stroke="transparent"])').evaluateAll((nodes) => (
      nodes.filter((node) => {
        if (!(node instanceof SVGGraphicsElement)) return false;
        const box = node.getBBox();
        return box.width > 0 || box.height > 0;
      }).length
    ));
  }

  async function isWireVisible(page, wireId) {
    return page.getByTestId('schematic-editor-svg').locator(`g[data-wire-id="${wireId}"] polyline:not([stroke="transparent"])`).evaluateAll((nodes) => (
      nodes.some((node) => {
        if (!(node instanceof SVGGraphicsElement)) return false;
        const box = node.getBBox();
        return box.width > 0 || box.height > 0;
      })
    ));
  }

  async function countVisibleSchematicComponents(page) {
    return page.getByTestId('schematic-editor-svg').locator('g[data-component-id]').evaluateAll((nodes) => (
      nodes.filter((node) => {
        if (!(node instanceof SVGGraphicsElement)) return false;
        const box = node.getBBox();
        return box.width > 0 && box.height > 0;
      }).length
    ));
  }

  async function renderedComponentCenters(page, componentIds) {
    return page.getByTestId('schematic-editor-svg').locator('g[data-component-id]').evaluateAll((nodes, ids) => {
      const wanted = new Set(ids);
      const centers = {};
      for (const node of nodes) {
        if (!(node instanceof SVGGraphicsElement)) continue;
        const id = node.getAttribute('data-component-id') ?? '';
        if (!wanted.has(id)) continue;
        const svg = node.ownerSVGElement;
        const matrix = node.getScreenCTM();
        if (!svg || !matrix) continue;
        const box = node.getBBox();
        const corners = [
          [box.x, box.y],
          [box.x + box.width, box.y],
          [box.x, box.y + box.height],
          [box.x + box.width, box.y + box.height],
        ].map(([x, y]) => {
          const point = svg.createSVGPoint();
          point.x = x;
          point.y = y;
          return point.matrixTransform(matrix);
        });
        const xs = corners.map((point) => point.x);
        const ys = corners.map((point) => point.y);
        centers[id] = {
          x: (Math.min(...xs) + Math.max(...xs)) / 2,
          y: (Math.min(...ys) + Math.max(...ys)) / 2,
        };
      }
      return centers;
    }, componentIds);
  }

  await mkdir(outputRoot, { recursive: true });

async function startEnvironment() {
  const viteProcess = await startViteIfNeeded();
  const pageErrors = [];
  const e2eUserDataDir = path.resolve(e2eRunRoot, 'electron-user-data');
  const e2eHomeDir = path.resolve(e2eRunRoot, 'home');
  const electronDistDir = path.resolve(root, 'node_modules', 'electron', 'dist');
  await mkdir(e2eUserDataDir, { recursive: true });
  await mkdir(e2eHomeDir, { recursive: true });
  const electronApp = await electron.launch({
    args: [`--user-data-dir=${e2eUserDataDir}`, '--no-sandbox', '--disable-gpu-sandbox', '.'],
    cwd: root,
    env: {
      ...process.env,
      ACTOVIQ_E2E: '1',
      ACTOVIQ_E2E_WORKSPACE_ROOT: workspaceRoot,
      ACTOVIQ_RENDERER_URL: viteUrl,
      HOME: e2eHomeDir,
      USERPROFILE: e2eHomeDir,
      PATH: `${electronDistDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    slowMo: 50,
  });
  electronApp.process()?.on('exit', (code, signal) => {
    pageErrors.push(`electron-exit: code=${code} signal=${signal ?? ''}`);
  });
  const observedWindows = new WeakSet();
  function observeWindow(windowPage) {
    if (observedWindows.has(windowPage)) return;
    observedWindows.add(windowPage);
    pageErrors.push(`electron-window: ${windowPage.url()}`);
    windowPage.on('domcontentloaded', () => pageErrors.push(`domcontentloaded: ${windowPage.url()}`));
    windowPage.on('load', () => pageErrors.push(`load: ${windowPage.url()}`));
    windowPage.on('crash', () => pageErrors.push(`page-crash: ${windowPage.url()}`));
    windowPage.on('framenavigated', (frame) => {
      if (frame === windowPage.mainFrame()) pageErrors.push(`framenavigated: ${frame.url()}`);
    });
    windowPage.on('close', () => pageErrors.push(`page-close: ${windowPage.url()}`));
    windowPage.on('requestfailed', (request) => {
      pageErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`);
    });
  }
  electronApp.on('window', observeWindow);
  const page = electronApp.windows()[0] ?? await electronApp.firstWindow({ timeout: 20_000 });
  observeWindow(page);
  return { electronApp, page, pageErrors, viteProcess };
}
  function isIgnorablePageError(entry) {
    return entry.startsWith('console: WebSocket connection to ') &&
      entry.includes(`ws://127.0.0.1:${vitePort}/`) &&
      entry.includes('ERR_CONNECTION_FAILED');
  }

  async function waitForWorkbenchProject(page, targetProjectId) {
    await page.waitForFunction((projectId) => {
      const node = document.querySelector('[data-testid="circuit-workbench"]');
      return node?.getAttribute('data-project-id') === projectId &&
        node?.getAttribute('data-action-project-id') === projectId;
    }, targetProjectId);
  }
  return {
  analogIcParamPrefix,
  assertAttachedWiresAvoidComponentInterior,
  assertPortWireEndpoints,
  assertPositionChanged,
  assertPositionEqual,
  assertRenderedWirePolylinesOrthogonal,
  assertUnrelatedWireRoutesStable,
  assertWireEndpointsMatchComponentPins,
  assertWireOrthogonal,
  assertWiresOrthogonal,
  componentPinNets,
  componentPinWorldPoints,
  componentPositions,
  componentRotations,
  componentScreenCenter,
  componentScreenPoint,
  componentToolLabels,
  countVisibleSchematicComponents,
  countVisibleSchematicWires,
  createAnalogIcParamProject,
  createJunctionInteractionProject,
  createLegacyBjtResetProject,
  createLegacyBuckConverterProject,
  createLegacyCascodeProject,
  createLegacyCmosInverterProject,
  createLegacyCmosRingProject,
  createLegacyCurrentMirrorProject,
  createLegacyDifferentialPairProject,
  createLegacyLdoProject,
  createLegacyMosAmplifierProject,
  createLegacyOpampFeedbackProject,
  createLegacyVoltageDividerProject,
  createPcbParamProject,
  createUnconnectedPortProject,
  e2eRunRoot,
  editorViewBox,
  editorViewport,
  editorWires,
  editorZoom,
  focusEditorByClickingCanvas,
  hasRenderedJunction,
  isIgnorablePageError,
  isWireVisible,
  junctionInteractionPrefix,
  legacyBjtResetPrefix,
  legacyBuckConverterPrefix,
  legacyCascodePrefix,
  legacyCmosInverterPrefix,
  legacyCmosRingPrefix,
  legacyCurrentMirrorPrefix,
  legacyDifferentialPairPrefix,
  legacyLdoPrefix,
  legacyMosAmplifierPrefix,
  legacyOpampFeedbackPrefix,
  legacyProjectId,
  legacyVoltageDividerPrefix,
  longestEditableGeneratedWireSegment,
  openModuleCard,
  outputRoot,
  pcbParamPrefix,
  portPositions,
  portScreenPoint,
  projectPrefix,
  projectsRoot,
  removePrefixedProjects,
  renderedComponentCenters,
  renderedJunctions,
  root,
  runId,
  runSkill,
  schematicGrid,
  selectComponentForDrag,
  selectedComponentCornerScreenPoint,
  selectedComponentFrameEdgeScreenPoint,
  selectedComponentFrameScreenPoint,
  skillScript,
  startEnvironment,
  viteBin,
  vitePort,
  viteUrl,
  waitForEditorIdle,
  waitForWorkbenchProject,
  wireHandleScreenPoint,
  wireScreenPointAwayFromComponents,
  workspaceRoot,
  worldToScreen,
  };
}
