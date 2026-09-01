import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHarness } from './e2e/lib/schematic-editor-harness.mjs';

const {
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
} = await createHarness({ tag: process.env.ACTOVIQ_E2E_SCENE_TAG || '' });

await removePrefixedProjects();

const created = runSkill([
  'create-demo',
  '--projects-root', projectsRoot,
  '--name', `Playwright Schematic Editor ${Date.now()}`,
]);
const projectId = created.project.project_id;
const projectName = created.project.name;
const projectRoot = created.project_root;
for (const module of created.project.modules) {
  const compiled = runSkill(['compile-module', '--project-root', projectRoot, '--module-id', module.id]);
  assert.equal(compiled.render.ok, true);
}
const legacyLdoProject = await createLegacyLdoProject();
const legacyBjtResetProject = await createLegacyBjtResetProject();
const legacyVoltageDividerProject = await createLegacyVoltageDividerProject();
const legacyMosAmplifierProject = await createLegacyMosAmplifierProject();
const legacyCmosInverterProject = await createLegacyCmosInverterProject();
const legacyCmosRingProject = await createLegacyCmosRingProject();
const legacyDifferentialPairProject = await createLegacyDifferentialPairProject();
const legacyCurrentMirrorProject = await createLegacyCurrentMirrorProject();
const legacyOpampFeedbackProject = await createLegacyOpampFeedbackProject();
const legacyCascodeProject = await createLegacyCascodeProject();
const legacyBuckConverterProject = await createLegacyBuckConverterProject();
const junctionInteractionProject = await createJunctionInteractionProject();
const unconnectedPortProject = await createUnconnectedPortProject();
const pcbParamProject = await createPcbParamProject();
const analogIcParamProject = await createAnalogIcParamProject();

const { electronApp, page: envPage, pageErrors, viteProcess } = await startEnvironment();

const ACTOVIQ_E2E_SCENES = process.env.ACTOVIQ_E2E_SCENES
  ? process.env.ACTOVIQ_E2E_SCENES.split(',').map((s) => s.trim()).filter(Boolean)
  : null;
function shouldRun(name) {
  return ACTOVIQ_E2E_SCENES === null || ACTOVIQ_E2E_SCENES.includes(name);
}

let page = envPage;
let testSucceeded = false;
try {
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
  });
  await page.waitForTimeout(1000);
  await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 20_000 });
  const editor = page.getByTestId('schematic-editor');
  const canvas = page.getByTestId('schematic-editor-svg');
  let agentModuleData;
  if (shouldRun("filter-editor")) {
    console.log('[e2e] shell loaded');
    await page.getByTestId(`sidebar-project-${projectId}`).click();
    await waitForWorkbenchProject(page, projectId);
    await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();
    await page.getByTestId('module-preview-filter').waitFor({ timeout: 20_000 });
    console.log('[e2e] project selected');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="module-preview-filter"]')?.getAttribute('data-schematic-source') === 'document'
    ));
    assert.equal(await page.getByTestId('module-preview-filter').getAttribute('data-schematic-source'), 'document');
    assert.ok(
      await page.getByTestId('module-preview-document-svg-filter').locator('g[data-wire-id]').count() >= 3,
      'module card preview did not render document wires',
    );

    await openModuleCard(page, 'filter');
    await editor.waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return node?.getAttribute('data-component-count') === '2' &&
        Number(node?.getAttribute('data-wire-count') ?? '0') >= 3;
    });
    await page.getByTestId('schematic-editor-svg').waitFor({ timeout: 20_000 });
    assert.equal(await editor.getAttribute('data-schematic-source'), 'document');
    assert.equal(await page.getByTestId('schematic-editor-svg').getAttribute('data-schematic-source'), 'document');
    // Unconnected ports render as dimmed wire targets (qucs-style dangling pins);
    // connected ports stay fully opaque.
    const unconnectedPortGroups = page.getByTestId('schematic-editor-svg').locator('g[data-port-id][data-connected="false"]');
    const unconnectedPortCount = await unconnectedPortGroups.count();
    for (let index = 0; index < unconnectedPortCount; index += 1) {
      const opacity = Number(await unconnectedPortGroups.nth(index).getAttribute('opacity'));
      assert.ok(opacity < 1, 'unconnected module ports should render dimmed as wire targets');
    }
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="gnd"]').count(),
      0,
      'rail ports with local schematic labels should not render as duplicate floating ports',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('circle[data-endpoint-kind="pin"][data-visible="true"]').count(),
      0,
      'unselected component pins should not render as persistent red endpoint dots',
    );
    assert.ok(
      await page.getByTestId('schematic-editor-svg').locator('text[paint-order="stroke"]').count() >= 6,
      'schematic labels should render with a white halo for wire overlap readability',
    );
    const positionsBeforeSelectAll = await componentPositions(page);
    await focusEditorByClickingCanvas(page);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '2' &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'components:r_filter,c_filter'
    ));
    assert.equal(await page.getByTestId('schematic-selected-component-frame').count(), 2, 'select-all should show all component frames');
    assert.deepEqual(
      await componentPositions(page),
      positionsBeforeSelectAll,
      'select-all should not move schematic components',
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === ''
    ));
    const expectedToolbarLabels = {
      'schematic-editor-select': 'Select tool (S)',
      'schematic-editor-wire': 'Wire tool (W)',
      'schematic-editor-undo': 'Undo (Ctrl+Z)',
      'schematic-editor-redo': 'Redo (Ctrl+Y)',
      'schematic-editor-delete': 'Delete selected item (Delete/Backspace)',
      'schematic-editor-save': 'Apply schematic and rebuild SVG (Ctrl+S)',
      'schematic-editor-fit': 'Fit schematic view (F)',
      'schematic-editor-rebuild-svg': 'Build netlistsvg preview',
    };
    for (const [testId, label] of Object.entries(expectedToolbarLabels)) {
      const button = page.getByTestId(testId);
      assert.equal(await button.getAttribute('aria-label'), label, `${testId} should expose a stable aria-label`);
      assert.equal(await button.getAttribute('title'), label, `${testId} should expose a matching tooltip`);
    }
    for (const [type, label] of Object.entries(componentToolLabels)) {
      const button = page.getByTestId(`schematic-editor-place-${type}`);
      assert.equal(await button.getAttribute('aria-label'), label, `${type} placement tool should expose a stable aria-label`);
      assert.equal(await button.getAttribute('title'), label, `${type} placement tool should expose a matching tooltip`);
    }
    assert.equal(await page.getByTestId('schematic-editor-undo').isDisabled(), true, 'Undo should be disabled before the first edit');
    assert.equal(await page.getByTestId('schematic-editor-redo').isDisabled(), true, 'Redo should be disabled before the first edit');
    assert.equal(await page.getByTestId('schematic-editor-delete').isDisabled(), true, 'Delete should be disabled without a selection');
    assert.equal(await page.getByTestId('schematic-editor-save').isDisabled(), true, 'Apply should be disabled when there are no unsaved edits');
    const optimizeLayoutButton = page.getByTestId('optimize-schematic-layout');
    await optimizeLayoutButton.waitFor();
    assert.equal(await optimizeLayoutButton.isVisible(), true, 'module schematic header should expose the LLM layout action');
    assert.equal(await optimizeLayoutButton.isEnabled(), true, 'LLM layout action should be enabled for a clean, idle schematic');
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-document-backed.png') });
    console.log('[e2e] filter editor loaded');

    const box = await canvas.boundingBox();
    assert.ok(box);
    const rFilterHoverPoint = await componentScreenPoint(page, 'r_filter');
    await page.mouse.move(rFilterHoverPoint.x, rFilterHoverPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-hover-target') === 'component:r_filter'
    ));
    assert.equal(await page.getByTestId('schematic-hover-component-frame').count(), 1, 'component hover frame is missing');
    const componentHoverFrame = page.getByTestId('schematic-hover-component-frame').first();
    assert.equal(await componentHoverFrame.evaluate((node) => node.tagName.toLowerCase()), 'rect', 'component hover should use a frame rectangle');
    assert.equal(await componentHoverFrame.getAttribute('data-hover-kind'), 'component');
    assert.equal(await componentHoverFrame.getAttribute('data-hover-shape'), 'frame');
    assert.equal(await componentHoverFrame.getAttribute('stroke-dasharray'), null, 'component hover should not use the selected dashed frame style');
    const componentHoverStroke = await componentHoverFrame.getAttribute('stroke');
    const hoverWire = (await editorWires(page)).find((wire) => Array.isArray(wire.points) && wire.points.length >= 2);
    assert.ok(hoverWire, 'filter schematic did not expose a wire to hover');
    const hoverWirePoint = await wireScreenPointAwayFromComponents(page, hoverWire.id);
    await page.mouse.move(hoverWirePoint.x, hoverWirePoint.y);
    await page.waitForFunction((wireId) => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-hover-target') === `wire:${wireId}`
    ), hoverWire.id);
    assert.equal(await page.getByTestId('schematic-hover-wire-highlight').count(), 1, 'wire hover highlight is missing');
    const wireHoverHighlight = page.getByTestId('schematic-hover-wire-highlight').first();
    assert.equal(await wireHoverHighlight.evaluate((node) => node.tagName.toLowerCase()), 'polyline', 'wire hover should follow the route');
    assert.equal(await wireHoverHighlight.getAttribute('data-hover-kind'), 'wire');
    assert.equal(await wireHoverHighlight.getAttribute('data-hover-shape'), 'route');
    assert.equal(await wireHoverHighlight.getAttribute('stroke-width'), '8', 'wire hover should use a broad route highlight');
    assert.notEqual(
      await wireHoverHighlight.getAttribute('stroke'),
      componentHoverStroke,
      'wire hover and component hover should use visually different targets',
    );
    assert.equal(await page.getByTestId('schematic-hover-component-frame').count(), 0, 'wire hover should not show a component hover frame');
    await page.mouse.move(box.x + box.width + 24, box.y + 12);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-hover-target') === ''
    ));
    const zoomBefore = await editorZoom(page);
    const viewportBeforeZoom = await editorViewport(page);
    const pageScrollBeforeZoom = await page.evaluate(() => ({
      x: window.scrollX,
      y: window.scrollY,
      top: document.scrollingElement?.scrollTop ?? 0,
    }));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -500);
    await page.waitForFunction((previousZoom) => (
      Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') > previousZoom
    ), zoomBefore);
    assert.deepEqual(
      await page.evaluate(() => ({
        x: window.scrollX,
        y: window.scrollY,
        top: document.scrollingElement?.scrollTop ?? 0,
      })),
      pageScrollBeforeZoom,
      'mouse wheel zoom should not scroll the application page',
    );
    const viewportAfterZoom = await editorViewport(page);
    assert.ok(
      viewportAfterZoom.maxX - viewportAfterZoom.minX < viewportBeforeZoom.maxX - viewportBeforeZoom.minX,
      'mouse wheel zoom did not shrink the world viewport',
    );
    await page.keyboard.down('Alt');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await page.waitForFunction((before) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-viewport') ?? '{}';
      const viewport = JSON.parse(raw);
      return Number(viewport.minX) !== Number(before.minX) || Number(viewport.minY) !== Number(before.minY);
    }, viewportAfterZoom);
    await page.getByTestId('schematic-editor-fit').click();
    await page.waitForFunction(() => (
      Math.abs(Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') - 1) < 0.01
    ));
    const zoomBeforeKeyboard = await editorZoom(page);
    await editor.focus();
    await page.keyboard.press('Equal');
    await page.waitForFunction((previousZoom) => (
      Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') > previousZoom
    ), zoomBeforeKeyboard);
    const zoomAfterKeyboardIn = await editorZoom(page);
    await page.keyboard.press('Minus');
    await page.waitForFunction((previousZoom) => (
      Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') < previousZoom
    ), zoomAfterKeyboardIn);
    await page.keyboard.press('Home');
    await page.waitForFunction(() => (
      Math.abs(Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') - 1) < 0.01
    ));
    await page.keyboard.press('Equal');
    await page.waitForFunction(() => (
      Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') > 1
    ));
    await page.keyboard.press('KeyF');
    await page.waitForFunction(() => (
      Math.abs(Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') - 1) < 0.01
    ));
    const viewportBeforeSpacePan = await editorViewport(page);
    const positionsBeforeSpacePan = await componentPositions(page);
    await editor.focus();
    await page.keyboard.down('Space');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-space-pan') === 'true' &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grab'
    ));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
    ));
    await page.mouse.move(box.x + box.width / 2 - 90, box.y + box.height / 2 - 55, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up('Space');
    await page.waitForFunction((before) => {
      const editorNode = document.querySelector('[data-testid="schematic-editor"]');
      const viewport = JSON.parse(editorNode?.getAttribute('data-viewport') ?? '{}');
      return editorNode?.getAttribute('data-space-pan') === 'false' &&
        (Number(viewport.minX) !== Number(before.minX) || Number(viewport.minY) !== Number(before.minY));
    }, viewportBeforeSpacePan);
    assert.deepEqual(
      await componentPositions(page),
      positionsBeforeSpacePan,
      'space-pan should not move any schematic component',
    );
    const viewportAfterSpacePan = await editorViewport(page);
    const gridAfterSpacePan = await page.getByTestId('schematic-grid-background').evaluate((node) => ({
      x: Number(node.getAttribute('x')),
      y: Number(node.getAttribute('y')),
      width: Number(node.getAttribute('width')),
      height: Number(node.getAttribute('height')),
    }));
    assert.ok(
      viewportAfterSpacePan.minX < viewportBeforeSpacePan.minX || viewportAfterSpacePan.minY < viewportBeforeSpacePan.minY ||
        viewportAfterSpacePan.maxX > viewportBeforeSpacePan.maxX || viewportAfterSpacePan.maxY > viewportBeforeSpacePan.maxY,
      'space-pan did not move the schematic viewport beyond the fitted document bounds',
    );
    assert.equal(gridAfterSpacePan.x, viewportAfterSpacePan.minX, 'infinite grid background x should follow the panned viewport');
    assert.equal(gridAfterSpacePan.y, viewportAfterSpacePan.minY, 'infinite grid background y should follow the panned viewport');
    assert.equal(gridAfterSpacePan.width, viewportAfterSpacePan.maxX - viewportAfterSpacePan.minX, 'infinite grid background width should cover the panned viewport');
    assert.equal(gridAfterSpacePan.height, viewportAfterSpacePan.maxY - viewportAfterSpacePan.minY, 'infinite grid background height should cover the panned viewport');
    const viewportBeforeMiddlePan = await editorViewport(page);
    const positionsBeforeMiddlePan = await componentPositions(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: 'middle' });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
    ));
    await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 - 45, { steps: 8 });
    await page.mouse.up({ button: 'middle' });
    await page.waitForFunction((before) => {
      const viewport = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-viewport') ?? '{}');
      return Number(viewport.minX) !== Number(before.minX) || Number(viewport.minY) !== Number(before.minY);
    }, viewportBeforeMiddlePan);
    assert.deepEqual(
      await componentPositions(page),
      positionsBeforeMiddlePan,
      'middle-button pan should not move any schematic component',
    );
    await page.getByTestId('schematic-editor-fit').click();
    await page.waitForFunction(() => (
      Math.abs(Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') - 1) < 0.01
    ));
    console.log('[e2e] viewport zoom alt-pan space-pan middle-pan keyboard fit verified');
    const viewportBeforeAutoPanDrag = await editorViewport(page);
    const positionsBeforeAutoPanDrag = await componentPositions(page);
    const autoPanBox = await canvas.boundingBox();
    assert.ok(autoPanBox);
    const autoPanStart = await componentScreenPoint(page, 'c_filter');
    await page.mouse.move(autoPanStart.x, autoPanStart.y);
    await page.mouse.down();
    await page.mouse.move(autoPanBox.x + autoPanBox.width - 8, autoPanStart.y, { steps: 18 });
    await page.waitForFunction(({ before, positionsBefore }) => {
      const editorNode = document.querySelector('[data-testid="schematic-editor"]');
      const viewport = JSON.parse(editorNode?.getAttribute('data-viewport') ?? '{}');
      const positions = JSON.parse(editorNode?.getAttribute('data-component-positions') ?? '{}');
      return Number(viewport.maxX) > Number(before.maxX) &&
        Number(positions.r_filter?.x) === Number(positionsBefore.r_filter.x) &&
        Number(positions.r_filter?.y) === Number(positionsBefore.r_filter.y) &&
        (
          Number(positions.c_filter?.x) !== Number(positionsBefore.c_filter.x) ||
          Number(positions.c_filter?.y) !== Number(positionsBefore.c_filter.y)
        );
    }, { before: viewportBeforeAutoPanDrag, positionsBefore: positionsBeforeAutoPanDrag });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForFunction((positionsBefore) => {
      const editorNode = document.querySelector('[data-testid="schematic-editor"]');
      const positions = JSON.parse(editorNode?.getAttribute('data-component-positions') ?? '{}');
      return editorNode?.getAttribute('data-selected') === '' &&
        Object.entries(positionsBefore).every(([id, point]) => (
          Number(positions[id]?.x) === Number(point.x) &&
          Number(positions[id]?.y) === Number(point.y)
        ));
    }, positionsBeforeAutoPanDrag);
    assert.deepEqual(
      await componentPositions(page),
      positionsBeforeAutoPanDrag,
      'Escape-canceling an edge auto-pan component drag should restore schematic components',
    );
    await page.getByTestId('schematic-editor-fit').click();
    await page.waitForFunction(() => (
      Math.abs(Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-zoom') ?? '0') - 1) < 0.01
    ));
    console.log('[e2e] edge auto-pan drag verified');
    const initialWireCount = Number(await editor.getAttribute('data-wire-count'));
    const filterPositionsInitial = await componentPositions(page);
    const filterViewBoxInitial = await editorViewBox(page);
    const cFilterMarqueeStart = worldToScreen(
      { x: filterPositionsInitial.c_filter.x + 10, y: filterPositionsInitial.c_filter.y - 70 },
      filterViewBoxInitial,
      box,
    );
    const cFilterMarqueeEnd = worldToScreen(
      { x: filterPositionsInitial.c_filter.x + 70, y: filterPositionsInitial.c_filter.y + 70 },
      filterViewBoxInitial,
      box,
    );
    await page.getByTestId('schematic-editor-select').click();
    await page.mouse.move(cFilterMarqueeStart.x, cFilterMarqueeStart.y);
    await page.mouse.down();
    await page.mouse.move(cFilterMarqueeEnd.x, cFilterMarqueeEnd.y, { steps: 8 });
    await page.getByTestId('schematic-selection-marquee').waitFor();
    await page.mouse.up();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:c_filter'
    ));
    assert.equal(await page.getByTestId('schematic-selected-component-frame').count(), 1, 'marquee component selection frame is missing');
    assert.deepEqual(
      await componentPositions(page),
      filterPositionsInitial,
      'marquee selection should not move schematic components',
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === ''
    ));

    // GND / power rail labels are first-class selectable entities (qucs parity):
    // clicking one selects the label itself with its own selection chrome.
    const groundLabelCount = await page.locator('[data-testid="schematic-net-label"][data-kind="ground"]').count();
    if (groundLabelCount > 0) {
      const groundStubCount = await page.locator('[data-testid="schematic-net-label"][data-kind="ground"] [data-testid="schematic-rail-label-stub"]').count();
      assert.equal(
        groundStubCount,
        groundLabelCount,
        'each ground net-label should draw a stub wire from the pin to the GND symbol',
      );
      const groundHit = page.locator('[data-testid="schematic-net-label"][data-kind="ground"] [data-testid="schematic-net-label-hit-target"]').first();
      const groundBox = await groundHit.boundingBox();
      assert.ok(groundBox, 'ground net-label hit target should have a screen box');
      const groundLabelId = await groundHit.getAttribute('data-net-label-id');
      assert.ok(groundLabelId, 'ground net-label should expose a label id');
      const netLabelCountBefore = Number(await editor.getAttribute('data-net-label-count'));
      await page.mouse.click(groundBox.x + groundBox.width / 2, groundBox.y + groundBox.height / 2);
      await page.waitForFunction((labelId) => (
        document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === `netlabel:${labelId}`
      ), groundLabelId);
      assert.equal(
        await page.getByTestId('schematic-selected-net-label-frame').count(),
        1,
        'selecting a rail label should show its own selection frame',
      );
      assert.equal(
        await page.getByTestId('schematic-selected-component-frame').count(),
        0,
        'rail label selection must not frame the parent component',
      );
      assert.equal(
        (await page.getByTestId('schematic-editor-netlabel-net').textContent())?.trim(),
        '0',
        'rail label inspector should show the ground net',
      );
      // Right-click on a rail label keeps it selected and opens a Delete menu.
      await page.mouse.click(groundBox.x + groundBox.width / 2, groundBox.y + groundBox.height / 2, { button: 'right' });
      await page.getByTestId('schematic-context-menu').waitFor();
      assert.equal(
        await page.getByTestId('schematic-context-menu').getAttribute('data-menu-target'),
        `netlabel:${groundLabelId}`,
        'rail label context menu should target the netlabel',
      );
      assert.equal(
        await page.getByTestId('schematic-context-menu').getAttribute('data-menu-kind'),
        'netlabel',
        'rail label context menu should be netlabel-kind',
      );
      assert.equal(await page.getByTestId('schematic-context-menu-rotate').count(), 0, 'rail label menu should not expose Rotate');
      assert.equal(await page.getByTestId('schematic-context-menu-duplicate').count(), 0, 'rail label menu should not expose Duplicate');
      assert.equal(await page.getByTestId('schematic-context-menu-delete').count(), 1, 'rail label menu should expose Delete');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => (
        document.querySelector('[data-testid="schematic-context-menu"]') == null
      ));
      // When the parent is already selected, dragging its rail label moves the component group.
      const cFilterBodyPoint = await componentScreenPoint(page, 'c_filter');
      await page.mouse.click(cFilterBodyPoint.x, cFilterBodyPoint.y);
      await page.waitForFunction(() => (
        document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:c_filter'
      ));
      const positionsBeforeParentDrag = await componentPositions(page);
      const groundHitAfterParentSelect = page.locator('[data-testid="schematic-net-label"][data-kind="ground"] [data-testid="schematic-net-label-hit-target"]').first();
      const groundBoxAfterParentSelect = await groundHitAfterParentSelect.boundingBox();
      assert.ok(groundBoxAfterParentSelect, 'ground net-label hit target should remain after selecting parent');
      await page.mouse.move(
        groundBoxAfterParentSelect.x + groundBoxAfterParentSelect.width / 2,
        groundBoxAfterParentSelect.y + groundBoxAfterParentSelect.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        groundBoxAfterParentSelect.x + groundBoxAfterParentSelect.width / 2 + 60,
        groundBoxAfterParentSelect.y + groundBoxAfterParentSelect.height / 2,
        { steps: 8 },
      );
      await page.mouse.up();
      await page.waitForFunction((previousX) => {
        const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
        const positions = JSON.parse(raw);
        return Number(positions.c_filter?.x) !== Number(previousX);
      }, positionsBeforeParentDrag.c_filter.x);
      const positionsAfterParentDrag = await componentPositions(page);
      assert.notEqual(
        Number(positionsAfterParentDrag.c_filter.x),
        Number(positionsBeforeParentDrag.c_filter.x),
        'dragging a rail label on an already-selected parent should move the component',
      );
      assert.equal(
        Number(positionsAfterParentDrag.c_filter.x) % schematicGrid,
        0,
        'parent drag via rail label should stay grid-snapped',
      );
      assert.equal(
        await editor.getAttribute('data-selected'),
        'component:c_filter',
        'dragging a rail label on an already-selected parent should keep the component selection',
      );
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
      await page.waitForFunction((previous) => {
        const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
        const positions = JSON.parse(raw);
        return Number(positions.c_filter?.x) === Number(previous.x) && Number(positions.c_filter?.y) === Number(previous.y);
      }, positionsBeforeParentDrag.c_filter);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => (
        document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === ''
      ));
      // Re-select the rail label for the offset-drag / delete coverage below.
      const groundHitForDrag = page.locator('[data-testid="schematic-net-label"][data-kind="ground"] [data-testid="schematic-net-label-hit-target"]').first();
      const groundBoxForDrag = await groundHitForDrag.boundingBox();
      assert.ok(groundBoxForDrag, 'ground net-label hit target should have a screen box before label drag');
      await page.mouse.click(groundBoxForDrag.x + groundBoxForDrag.width / 2, groundBoxForDrag.y + groundBoxForDrag.height / 2);
      await page.waitForFunction((labelId) => (
        document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === `netlabel:${labelId}`
      ), groundLabelId);
      // The selection chrome hugs the rail symbol + text, not the connecting stub.
      const selectedLabelFrame = page.getByTestId('schematic-selected-net-label-frame').first();
      const frameBox = await selectedLabelFrame.boundingBox();
      assert.ok(frameBox, 'selected rail label frame should have a screen box');
      const filterPinPoint = await componentScreenPoint(page, 'c_filter', { x: 0, y: 52 });
      assert.ok(
        filterPinPoint.y < frameBox.y - 1,
        'selected rail label frame must not enclose the parent pin or stub',
      );
      // Rail labels are draggable: the anchor offset persists on the pin.
      const cFilterBeforeLabelDrag = (await page.getByTestId('schematic-editor').getAttribute('data-components')) ?? '';
      await page.mouse.move(groundBoxForDrag.x + groundBoxForDrag.width / 2, groundBoxForDrag.y + groundBoxForDrag.height / 2);
      await page.mouse.down();
      await page.mouse.move(groundBoxForDrag.x + groundBoxForDrag.width / 2 + 40, groundBoxForDrag.y + groundBoxForDrag.height / 2 + 20, { steps: 6 });
      await page.mouse.up();
      await page.waitForFunction((before) => (
        (document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-components') ?? '') !== before
      ), cFilterBeforeLabelDrag);
      const componentsAfterLabelDrag = JSON.parse(await editor.getAttribute('data-components') ?? '[]');
      const cFilterAfterLabelDrag = componentsAfterLabelDrag.find((component) => component.id === 'c_filter');
      const pinBAfterLabelDrag = cFilterAfterLabelDrag?.pins?.find((pin) => pin.id === 'b');
      assert.ok(pinBAfterLabelDrag?.label_offset, 'dragging a rail label should persist a label offset on the pin');
      assert.notDeepEqual(
        pinBAfterLabelDrag.label_offset,
        { x: 0, y: 40 },
        'rail label offset should change after dragging',
      );
      assert.equal(pinBAfterLabelDrag.label_offset.x % 20, 0, 'rail label offset stays grid-snapped');
      assert.equal(pinBAfterLabelDrag.label_offset.y % 20, 0, 'rail label offset stays grid-snapped');
      // The stub from the pin to a dragged label must stay orthogonal.
      const diagonalStubSegments = await page.locator(
        `g[data-net-label-id="${groundLabelId}"] [data-testid="schematic-rail-label-stub"]`,
      ).evaluateAll((nodes) => nodes.flatMap((node) => {
        if (!(node instanceof SVGPolylineElement)) return [];
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
            bad.push({ index, start, end });
          }
        }
        return bad;
      }));
      assert.deepEqual(diagonalStubSegments, [], 'dragged rail label stub must not contain diagonal segments');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
      await page.waitForFunction((before) => (
        (document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-components') ?? '') === before
      ), cFilterBeforeLabelDrag);
      // Undo restores the label; re-select it for the delete-to-wire step.
      await page.mouse.click(groundBoxForDrag.x + groundBoxForDrag.width / 2, groundBoxForDrag.y + groundBoxForDrag.height / 2);
      await page.waitForFunction((labelId) => (
        document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === `netlabel:${labelId}`
      ), groundLabelId);
      // Deleting the label converts the pin to a physical wire on the same net.
      await page.keyboard.press('Delete');
      await page.waitForFunction((count) => (
        Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-net-label-count') ?? '0') === count - 1
      ), netLabelCountBefore);
      const wiresAfterLabelDelete = await editorWires(page);
      const convertedWire = wiresAfterLabelDelete.find((wire) => (
        wire.source === 'stored' &&
        (wire.from?.component_id === 'c_filter' && wire.from?.pin_id === 'b' || wire.to?.component_id === 'c_filter' && wire.to?.pin_id === 'b')
      ));
      assert.ok(convertedWire, 'deleting a rail label should wire the pin to a same-net node');
      assert.equal(convertedWire.net, '0', 'converted rail-label wire should stay on the ground net');
      assert.equal(
        await page.locator('[data-testid="schematic-net-label"][data-kind="ground"]').count(),
        groundLabelCount - 1,
        'converted rail label should disappear once its pin is wired',
      );
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
      await page.waitForFunction((count) => (
        Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-net-label-count') ?? '0') === count
      ), netLabelCountBefore);
      assert.equal(
        await page.locator('[data-testid="schematic-net-label"][data-kind="ground"]').count(),
        groundLabelCount,
        'undo should restore the deleted rail label',
      );
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => (
        document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === ''
      ));
      console.log('[e2e] rail label selection and delete-to-wire verified');
    } else {
      console.log('[e2e] ground net-label selection skipped (no ground labels in fixture)');
    }

    const rFilterScreenPoint = await componentScreenPoint(page, 'r_filter');
    await page.mouse.click(rFilterScreenPoint.x, rFilterScreenPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r_filter'
    ));
    // Selecting a component changes the inspector height and therefore the SVG
    // client rect. Re-read the screen coordinate before the next pointer action.
    let cFilterScreenPoint = await componentScreenPoint(page, 'c_filter');
    await page.keyboard.down('Shift');
    await page.mouse.click(cFilterScreenPoint.x, cFilterScreenPoint.y);
    await page.keyboard.up('Shift');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'components:r_filter,c_filter' &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '2'
    ));
    assert.equal(await page.getByTestId('schematic-selected-component-frame').count(), 2, 'Shift-click multi-selection should show two component frames');
    cFilterScreenPoint = await componentScreenPoint(page, 'c_filter');
    await page.keyboard.down('Shift');
    await page.mouse.click(cFilterScreenPoint.x, cFilterScreenPoint.y);
    await page.keyboard.up('Shift');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r_filter' &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '1'
    ));
    cFilterScreenPoint = await componentScreenPoint(page, 'c_filter');
    await page.keyboard.down('Shift');
    await page.mouse.click(cFilterScreenPoint.x, cFilterScreenPoint.y);
    await page.keyboard.up('Shift');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'components:r_filter,c_filter'
    ));
    cFilterScreenPoint = await componentScreenPoint(page, 'c_filter');
    await page.mouse.move(cFilterScreenPoint.x, cFilterScreenPoint.y);
    await page.mouse.down();
    await page.mouse.move(cFilterScreenPoint.x + 90, cFilterScreenPoint.y + 30, { steps: 8 });
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'components:r_filter,c_filter' &&
        (Number(positions.r_filter?.x) !== Number(previous.r_filter.x) || Number(positions.r_filter?.y) !== Number(previous.r_filter.y)) &&
        (Number(positions.c_filter?.x) !== Number(previous.c_filter.x) || Number(positions.c_filter?.y) !== Number(previous.c_filter.y));
    }, filterPositionsInitial);
    assert.ok(
      await page.getByTestId('schematic-selected-component-frame').count() >= 2,
      'group drag should keep multi-selection frames visible',
    );
    await assertWireEndpointsMatchComponentPins(page, 'c_filter', 'group-dragging Cfilter should keep wire endpoints on moving pins');
    await assertWireEndpointsMatchComponentPins(page, 'r_filter', 'group-dragging Rfilter should keep wire endpoints on moving pins');
    await assertAttachedWiresAvoidComponentInterior(page, 'c_filter', 'group-drag preview must not thread wires through Cfilter');
    await assertAttachedWiresAvoidComponentInterior(page, 'r_filter', 'group-drag preview must not thread wires through Rfilter');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return Number(positions.r_filter?.x) === Number(previous.r_filter.x) &&
        Number(positions.r_filter?.y) === Number(previous.r_filter.y) &&
        Number(positions.c_filter?.x) === Number(previous.c_filter.x) &&
        Number(positions.c_filter?.y) === Number(previous.c_filter.y);
    }, filterPositionsInitial);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === ''
    ));
    assert.deepEqual(
      await componentPositions(page),
      filterPositionsInitial,
      'cancelled direct drag from a Shift-click multi-selection should restore schematic components',
    );
    assert.equal(
      await page.getByTestId('schematic-rubber-band-wire').count(),
      0,
      'rubber-band wire feedback should disappear after cancelling a drag',
    );
    const multiMarqueeRect = async () => {
      // Recompute per use: drags in between can auto-pan/zoom the viewport,
      // which would silently shift a cached screen rect off the components.
      const [rPoint, cPoint] = [
        await componentScreenPoint(page, 'r_filter'),
        await componentScreenPoint(page, 'c_filter'),
      ];
      return {
        start: {
          x: Math.min(rPoint.x, cPoint.x) - 90,
          y: Math.min(rPoint.y, cPoint.y) - 40,
        },
        end: {
          x: Math.max(rPoint.x, cPoint.x) + 120,
          y: Math.max(rPoint.y, cPoint.y) + 120,
        },
      };
    };
    let multiMarquee = await multiMarqueeRect();
    let multiMarqueeStart = multiMarquee.start;
    let multiMarqueeEnd = multiMarquee.end;
    await page.mouse.move(multiMarqueeStart.x, multiMarqueeStart.y);
    await page.mouse.down();
    await page.mouse.move(multiMarqueeEnd.x, multiMarqueeEnd.y, { steps: 10 });
    await page.getByTestId('schematic-selection-marquee').waitFor();
    await page.mouse.up();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected')?.startsWith('components:') &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '2'
    ));
    assert.equal(await page.getByTestId('schematic-selected-component-frame').count(), 2, 'marquee multi-selection should show two component frames');
    const cFilterFrameEdgePoint = await selectedComponentFrameEdgeScreenPoint(page, 'c_filter');
    await page.mouse.move(cFilterFrameEdgePoint.x, cFilterFrameEdgePoint.y);
    await page.mouse.down();
    await page.mouse.move(cFilterFrameEdgePoint.x + 70, cFilterFrameEdgePoint.y + 28, { steps: 8 });
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected')?.startsWith('components:') &&
        (Number(positions.r_filter?.x) !== Number(previous.r_filter.x) || Number(positions.r_filter?.y) !== Number(previous.r_filter.y)) &&
        (Number(positions.c_filter?.x) !== Number(previous.c_filter.x) || Number(positions.c_filter?.y) !== Number(previous.c_filter.y));
    }, filterPositionsInitial);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return Number(positions.r_filter?.x) === Number(previous.r_filter.x) &&
        Number(positions.r_filter?.y) === Number(previous.r_filter.y) &&
        Number(positions.c_filter?.x) === Number(previous.c_filter.x) &&
        Number(positions.c_filter?.y) === Number(previous.c_filter.y);
    }, filterPositionsInitial);
    assert.deepEqual(
      await componentPositions(page),
      filterPositionsInitial,
      'cancelled selection-frame-edge drag should restore schematic components',
    );
    multiMarquee = await multiMarqueeRect();
    multiMarqueeStart = multiMarquee.start;
    multiMarqueeEnd = multiMarquee.end;
    await page.mouse.move(multiMarqueeStart.x, multiMarqueeStart.y);
    await page.mouse.down();
    await page.mouse.move(multiMarqueeEnd.x, multiMarqueeEnd.y, { steps: 10 });
    await page.getByTestId('schematic-selection-marquee').waitFor();
    await page.mouse.up();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected')?.startsWith('components:') &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '2'
    ));
    const cFilterDirectDragPoint = await componentScreenPoint(page, 'c_filter');
    await page.mouse.move(cFilterDirectDragPoint.x, cFilterDirectDragPoint.y);
    await page.mouse.down();
    await page.mouse.move(cFilterDirectDragPoint.x + 90, cFilterDirectDragPoint.y + 30, { steps: 8 });
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected')?.startsWith('components:') &&
        (Number(positions.r_filter?.x) !== Number(previous.r_filter.x) || Number(positions.r_filter?.y) !== Number(previous.r_filter.y)) &&
        (Number(positions.c_filter?.x) !== Number(previous.c_filter.x) || Number(positions.c_filter?.y) !== Number(previous.c_filter.y));
    }, filterPositionsInitial);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return Number(positions.r_filter?.x) === Number(previous.r_filter.x) &&
        Number(positions.r_filter?.y) === Number(previous.r_filter.y) &&
        Number(positions.c_filter?.x) === Number(previous.c_filter.x) &&
        Number(positions.c_filter?.y) === Number(previous.c_filter.y);
    }, filterPositionsInitial);
    assert.deepEqual(
      await componentPositions(page),
      filterPositionsInitial,
      'cancelled direct drag from a multi-selection should restore schematic components',
    );
    multiMarquee = await multiMarqueeRect();
    multiMarqueeStart = multiMarquee.start;
    multiMarqueeEnd = multiMarquee.end;
    await page.mouse.move(multiMarqueeStart.x, multiMarqueeStart.y);
    await page.mouse.down();
    await page.mouse.move(multiMarqueeEnd.x, multiMarqueeEnd.y, { steps: 10 });
    await page.getByTestId('schematic-selection-marquee').waitFor();
    await page.mouse.up();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected')?.startsWith('components:') &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '2'
    ));
    const cFilterCommittedDragPoint = await componentScreenPoint(page, 'c_filter');
    await page.mouse.move(cFilterCommittedDragPoint.x, cFilterCommittedDragPoint.y);
    await page.mouse.down();
    await page.mouse.move(cFilterCommittedDragPoint.x + 90, cFilterCommittedDragPoint.y + 30, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected')?.startsWith('components:') &&
        (Number(positions.r_filter?.x) !== Number(previous.r_filter.x) || Number(positions.r_filter?.y) !== Number(previous.r_filter.y)) &&
        (Number(positions.c_filter?.x) !== Number(previous.c_filter.x) || Number(positions.c_filter?.y) !== Number(previous.c_filter.y));
    }, filterPositionsInitial);
    const filterPositionsAfterCommittedDirectDrag = await componentPositions(page);
    assertPositionChanged(
      filterPositionsAfterCommittedDirectDrag.r_filter,
      filterPositionsInitial.r_filter,
      'committed direct drag from a multi-selection did not move r_filter',
    );
    assertPositionChanged(
      filterPositionsAfterCommittedDirectDrag.c_filter,
      filterPositionsInitial.c_filter,
      'committed direct drag from a multi-selection did not move c_filter',
    );
    await assertWireEndpointsMatchComponentPins(page, 'c_filter', 'committed direct drag from a multi-selection should keep wire endpoints on moving pins');
    await assertWireEndpointsMatchComponentPins(page, 'r_filter', 'committed direct drag from a multi-selection should keep wire endpoints on r_filter pins');
    await editor.focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return Number(positions.r_filter?.x) === Number(previous.r_filter.x) &&
        Number(positions.r_filter?.y) === Number(previous.r_filter.y) &&
        Number(positions.c_filter?.x) === Number(previous.c_filter.x) &&
        Number(positions.c_filter?.y) === Number(previous.c_filter.y);
    }, filterPositionsInitial);
    assert.deepEqual(
      await componentPositions(page),
      filterPositionsInitial,
      'undoing committed direct drag from a multi-selection should restore schematic components',
    );
    await page.mouse.move(multiMarqueeStart.x, multiMarqueeStart.y);
    await page.mouse.down();
    await page.mouse.move(multiMarqueeEnd.x, multiMarqueeEnd.y, { steps: 10 });
    await page.getByTestId('schematic-selection-marquee').waitFor();
    await page.mouse.up();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected')?.startsWith('components:') &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '2'
    ));
    const cFilterGroupHandlePoint = await selectedComponentCornerScreenPoint(page, 'c_filter', 0);
    await page.mouse.move(cFilterGroupHandlePoint.x, cFilterGroupHandlePoint.y);
    await page.mouse.down();
    await page.mouse.move(cFilterGroupHandlePoint.x + 90, cFilterGroupHandlePoint.y + 30, { steps: 8 });
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected')?.startsWith('components:') &&
        (Number(positions.r_filter?.x) !== Number(previous.r_filter.x) || Number(positions.r_filter?.y) !== Number(previous.r_filter.y)) &&
        (Number(positions.c_filter?.x) !== Number(previous.c_filter.x) || Number(positions.c_filter?.y) !== Number(previous.c_filter.y));
    }, filterPositionsInitial);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return Number(positions.r_filter?.x) === Number(previous.r_filter.x) &&
        Number(positions.r_filter?.y) === Number(previous.r_filter.y) &&
        Number(positions.c_filter?.x) === Number(previous.c_filter.x) &&
        Number(positions.c_filter?.y) === Number(previous.c_filter.y);
    }, filterPositionsInitial);
    assert.deepEqual(
      await componentPositions(page),
      filterPositionsInitial,
      'cancelled selection-handle group drag should restore schematic components',
    );
    multiMarquee = await multiMarqueeRect();
    multiMarqueeStart = multiMarquee.start;
    multiMarqueeEnd = multiMarquee.end;
    await page.mouse.move(multiMarqueeStart.x, multiMarqueeStart.y);
    await page.mouse.down();
    await page.mouse.move(multiMarqueeEnd.x, multiMarqueeEnd.y, { steps: 10 });
    await page.getByTestId('schematic-selection-marquee').waitFor();
    await page.mouse.up();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected')?.startsWith('components:') &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '2'
    ));
    const filterRotationsBeforeMultiRotate = await componentRotations(page);
    await editor.focus();
    await page.keyboard.press('r');
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-rotations') ?? '{}';
      const rotations = JSON.parse(raw);
      return Number(rotations.r_filter) === (Number(previous.r_filter ?? 0) + 90) % 360 &&
        Number(rotations.c_filter) === (Number(previous.c_filter ?? 0) + 90) % 360;
    }, filterRotationsBeforeMultiRotate);
    assert.deepEqual(
      await componentPositions(page),
      filterPositionsInitial,
      'rotating multi-selection should not move schematic components',
    );
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-rotations') ?? '{}';
      const rotations = JSON.parse(raw);
      return Number(rotations.r_filter) === Number(previous.r_filter ?? 0) &&
        Number(rotations.c_filter) === Number(previous.c_filter ?? 0);
    }, filterRotationsBeforeMultiRotate);
    assert.deepEqual(
      await componentPositions(page),
      filterPositionsInitial,
      'undoing multi-selection rotation should restore schematic component positions',
    );
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === ''
    ));
    const generatedSegment = longestEditableGeneratedWireSegment(await editorWires(page));
    assert.ok(generatedSegment, 'initial generated net wire segment was not exposed to the editor');
    const dirtyBeforeGeneratedWire = await editor.getAttribute('data-dirty');
    const generatedSegmentBox = await canvas.boundingBox();
    assert.ok(generatedSegmentBox);
    const generatedSegmentViewBox = await editorViewBox(page);
    const generatedSegmentMidpoint = {
      x: (generatedSegment.start.x + generatedSegment.end.x) / 2,
      y: (generatedSegment.start.y + generatedSegment.end.y) / 2,
    };
    const generatedSegmentScreenPoint = worldToScreen(generatedSegmentMidpoint, generatedSegmentViewBox, generatedSegmentBox);
    await page.mouse.move(generatedSegmentScreenPoint.x, generatedSegmentScreenPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'move'
    ));
    const generatedHorizontal = Math.abs(generatedSegment.end.x - generatedSegment.start.x) >=
      Math.abs(generatedSegment.end.y - generatedSegment.start.y);
    await page.mouse.down();
    await page.mouse.move(
      generatedSegmentScreenPoint.x + (generatedHorizontal ? 0 : 70),
      generatedSegmentScreenPoint.y + (generatedHorizontal ? 70 : 0),
      { steps: 8 },
    );
    await page.waitForFunction((wireId) => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      const wires = JSON.parse(node?.getAttribute('data-wires') ?? '[]');
      return node?.getAttribute('data-dirty') === 'true' &&
        wires.some((wire) => wire.id === wireId && wire.source === 'stored');
    }, generatedSegment.wire.id);
    assert.deepEqual(
      await componentPositions(page),
      filterPositionsInitial,
      'dragging a generated net wire should not move schematic components',
    );
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForFunction((wireId) => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      const wires = JSON.parse(node?.getAttribute('data-wires') ?? '[]');
      return node?.getAttribute('data-selected') === '' &&
        !wires.some((wire) => wire.id === wireId && wire.source === 'stored');
    }, generatedSegment.wire.id);
    assert.equal(await editor.getAttribute('data-dirty'), dirtyBeforeGeneratedWire);
    const filterViewBoxAfterGeneratedWire = await editorViewBox(page);
    const filterBoxAfterGeneratedWire = await canvas.boundingBox();
    assert.ok(filterBoxAfterGeneratedWire);
    const storedWireCountBeforeGeneratedDelete = (await editorWires(page))
      .filter((wire) => wire.source === 'stored')
      .length;
    const generatedDeleteSegment = longestEditableGeneratedWireSegment(await editorWires(page));
    assert.ok(generatedDeleteSegment, 'generated net wire segment was not available for delete');
    const generatedDeletePoint = worldToScreen({
      x: (generatedDeleteSegment.start.x + generatedDeleteSegment.end.x) / 2,
      y: (generatedDeleteSegment.start.y + generatedDeleteSegment.end.y) / 2,
    }, filterViewBoxAfterGeneratedWire, filterBoxAfterGeneratedWire);
    await page.mouse.click(generatedDeletePoint.x, generatedDeletePoint.y);
    await page.waitForFunction((wireId) => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === `wire:${wireId}`
    ), generatedDeleteSegment.wire.id);
    await editor.focus();
    await page.keyboard.press('Delete');
    await page.waitForFunction((wireId) => {
      const wires = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]');
      return !wires.some((wire) => wire.id === wireId) &&
        wires.some((wire) => wire.source === 'stored');
    }, generatedDeleteSegment.wire.id);
    assert.deepEqual(
      await componentPositions(page),
      filterPositionsInitial,
      'deleting a generated net wire should not move schematic components',
    );
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForFunction(({ wireId, storedBefore }) => {
      const wires = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]');
      return wires.some((wire) => wire.id === wireId && wire.source === 'net') &&
        wires.filter((wire) => wire.source === 'stored').length === storedBefore;
    }, { wireId: generatedDeleteSegment.wire.id, storedBefore: storedWireCountBeforeGeneratedDelete });
    const filterViewBoxAfterGeneratedDelete = await editorViewBox(page);
    const filterBoxAfterGeneratedDelete = await canvas.boundingBox();
    assert.ok(filterBoxAfterGeneratedDelete);
    const filterWireSnapPoint = worldToScreen(
      { x: filterPositionsInitial.r_filter.x + 52, y: filterPositionsInitial.r_filter.y },
      filterViewBoxAfterGeneratedDelete,
      filterBoxAfterGeneratedDelete,
    );
    await page.getByTestId('schematic-editor-wire').click();
    await page.mouse.move(filterWireSnapPoint.x, filterWireSnapPoint.y);
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return Boolean(node?.getAttribute('data-hover-endpoint')?.includes('Rfilter'));
    });
    assert.equal(await page.getByTestId('schematic-hover-endpoint').count(), 1, 'wire tool did not show endpoint snap feedback');
    await page.getByTestId('schematic-hover-endpoint-label').getByText(/Rfilter/).waitFor();
    assert.match(
      (await page.getByTestId('schematic-hover-endpoint').getAttribute('data-net')) ?? '',
      /out|in/i,
      'wire endpoint snap feedback did not expose the endpoint net',
    );
    await page.mouse.click(filterWireSnapPoint.x, filterWireSnapPoint.y);
    await page.waitForFunction(() => (
      Boolean(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wire-start'))
    ));
    await page.mouse.click(filterWireSnapPoint.x + 80, filterWireSnapPoint.y, { button: 'right' });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return node?.getAttribute('data-wire-start') === '' &&
        node?.getAttribute('data-tool') === 'select';
    });
    assert.equal(await page.getByTestId('schematic-wire-preview').count(), 0, 'right-click should cancel the active wire preview');
    assert.equal(await page.getByTestId('schematic-context-menu').count(), 0, 'right-click canceling an active wire preview should not open a context menu');
    await page.getByTestId('schematic-editor-select').click();
    const placePoint = { x: box.x + Math.min(430, box.width * 0.62), y: box.y + Math.min(280, box.height * 0.48) };

    await editor.focus();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === ''
    ));
    await page.keyboard.press('w');
    assert.equal(await editor.getAttribute('data-tool'), 'wire', 'W hotkey did not activate wire tool');
    await page.keyboard.press('s');
    assert.equal(await editor.getAttribute('data-tool'), 'select', 'S hotkey did not return to select tool');
    await page.keyboard.press('w');
    assert.equal(await editor.getAttribute('data-tool'), 'wire', 'W hotkey did not reactivate wire tool after select');
    await page.keyboard.press('r');
    assert.equal(await editor.getAttribute('data-tool'), 'place', 'R hotkey did not activate placement tool');
    await page.mouse.click(placePoint.x, placePoint.y);
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return node?.getAttribute('data-component-count') === '3' &&
        node?.getAttribute('data-selected')?.startsWith('component:r');
    });
    assert.equal(
      await page.getByTestId('schematic-selected-component-handles').count(),
      1,
      'selected component should use lightweight selection handles',
    );
    assert.equal(
      await page.locator('g[data-component-id="r1"] circle[data-endpoint-kind="pin"][data-visible="true"]').count(),
      2,
      'selected resistor should reveal only its own pin snap points',
    );
    assert.equal(await page.getByTestId('schematic-editor-undo').isDisabled(), false, 'Undo should be enabled after placing a component');
    assert.equal(await page.getByTestId('schematic-editor-redo').isDisabled(), true, 'Redo should stay disabled until an undo is available');
    assert.equal(await page.getByTestId('schematic-editor-delete').isDisabled(), false, 'Delete should be enabled for the selected component');
    assert.equal(await page.getByTestId('schematic-editor-save').isDisabled(), false, 'Apply should be enabled after an unsaved component edit');
    await page.getByTestId('schematic-editor-component-name').fill('Rtrim');
    await page.getByTestId('schematic-param-magnitude').fill('2k');
    await page.getByTestId('schematic-editor-component-rotation').selectOption('90');
    await page.waitForFunction(() => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-rotations') ?? '{}';
      const rotations = JSON.parse(raw);
      return Number(rotations.r1) === 90 &&
        document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true';
    });
    await page.getByTestId('schematic-editor-component-rotation').selectOption('0');
    await page.waitForFunction(() => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-rotations') ?? '{}';
      const rotations = JSON.parse(raw);
      return Number(rotations.r1 ?? 0) === 0;
    });
    const toolbarPlacementBaseCount = Number(await editor.getAttribute('data-component-count'));
    const toolbarPlacementTools = ['C', 'L', 'D', 'M', 'Q', 'V', 'I'];
    for (let index = 0; index < toolbarPlacementTools.length; index += 1) {
      const type = toolbarPlacementTools[index];
      const typeCountBefore = await page.locator(`g[data-component-type="${type}"]`).count();
      const target = {
        x: placePoint.x + 30 + index * 18,
        y: placePoint.y + 80 + index * 10,
      };
      await page.getByTestId(`schematic-editor-place-${type}`).click();
      assert.equal(await editor.getAttribute('data-tool'), 'place', `${type} toolbar button did not activate place mode`);
      await page.mouse.click(target.x, target.y);
      await page.waitForFunction(({ expectedCount, prefix }) => {
        const node = document.querySelector('[data-testid="schematic-editor"]');
        return node?.getAttribute('data-component-count') === String(expectedCount) &&
          node?.getAttribute('data-selected')?.startsWith(`component:${prefix}`);
      }, { expectedCount: toolbarPlacementBaseCount + index + 1, prefix: type.toLowerCase() });
      assert.equal(
        await page.locator(`g[data-component-type="${type}"]`).count(),
        typeCountBefore + 1,
        `${type} toolbar placement did not render a component`,
      );
    }
    for (let index = toolbarPlacementTools.length - 1; index >= 0; index -= 1) {
      const expectedCount = toolbarPlacementBaseCount + index;
      await editor.focus();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
      await page.waitForFunction((count) => (
        document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === String(count)
      ), expectedCount);
    }
    await editor.focus();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === ''
    ));
    for (let index = 0; index < toolbarPlacementTools.length; index += 1) {
      const type = toolbarPlacementTools[index];
      const typeCountBefore = await page.locator(`g[data-component-type="${type}"]`).count();
      const target = {
        x: placePoint.x + 170 + index * 14,
        y: placePoint.y + 68 + index * 9,
      };
      await editor.focus();
      await page.keyboard.press(type.toLowerCase());
      assert.equal(await editor.getAttribute('data-tool'), 'place', `${type} hotkey did not activate place mode`);
      await page.mouse.click(target.x, target.y);
      await page.waitForFunction(({ expectedCount, prefix }) => {
        const node = document.querySelector('[data-testid="schematic-editor"]');
        return node?.getAttribute('data-component-count') === String(expectedCount) &&
          node?.getAttribute('data-selected')?.startsWith(`component:${prefix}`);
      }, { expectedCount: toolbarPlacementBaseCount + index + 1, prefix: type.toLowerCase() });
      assert.equal(
        await page.locator(`g[data-component-type="${type}"]`).count(),
        typeCountBefore + 1,
        `${type} hotkey placement did not render a component`,
      );
    }
    for (let index = toolbarPlacementTools.length - 1; index >= 0; index -= 1) {
      const expectedCount = toolbarPlacementBaseCount + index;
      await editor.focus();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
      await page.waitForFunction((count) => (
        document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === String(count)
      ), expectedCount);
    }

    // qucs-style placement UX: ghost preview, rotate-while-placing (R / right-click),
    // and persistent place mode until Escape.
    await page.getByTestId('schematic-editor-place-R').click();
    assert.equal(await editor.getAttribute('data-tool'), 'place', 'place tool did not reactivate for ghost checks');
    const ghostProbePoint = {
      x: box.x + Math.min(690, box.width * 0.8),
      y: box.y + Math.min(430, box.height * 0.72),
    };
    await page.mouse.move(ghostProbePoint.x, ghostProbePoint.y);
    await page.getByTestId('schematic-place-ghost').waitFor();
    await editor.focus();
    await page.keyboard.press('r');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-place-rotation') === '90'
    ));
    await page.mouse.click(ghostProbePoint.x, ghostProbePoint.y, { button: 'right' });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-place-rotation') === '180'
    ));
    assert.equal(await editor.getAttribute('data-tool'), 'place', 'right-click must rotate the pending symbol, not cancel place mode');
    const countBeforeRotatedPlacement = Number(await editor.getAttribute('data-component-count'));
    await page.mouse.click(ghostProbePoint.x, ghostProbePoint.y);
    await page.waitForFunction((count) => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === String(count)
    ), countBeforeRotatedPlacement + 1);
    assert.equal(await editor.getAttribute('data-tool'), 'place', 'place mode should persist after placing a component (qucs parity)');
    assert.equal(await editor.getAttribute('data-place-rotation'), '0', 'ghost rotation should reset for the next pending symbol');
    const rotationsAfterRotatedPlacement = await componentRotations(page);
    const rotatedPlacementId = Object.keys(rotationsAfterRotatedPlacement)
      .filter((id) => id.startsWith('r') && id !== 'r1' && id !== 'r_filter')
      .pop();
    assert.ok(rotatedPlacementId, 'rotated placement did not add a resistor');
    assert.equal(
      Number(rotationsAfterRotatedPlacement[rotatedPlacementId]) % 360,
      180,
      'placed component should inherit the ghost rotation',
    );
    await editor.focus();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-tool') === 'select'
    ));
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForFunction((count) => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === String(count)
    ), countBeforeRotatedPlacement);
    console.log('[e2e] qucs placement UX (ghost, rotate, persistence) verified');

    await page.getByTestId('schematic-editor-select').click();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-tool') === 'select'
    ));
    const rtrimPointAfterToolbarPlacement = await componentScreenPoint(page, 'r1');
    await page.mouse.click(rtrimPointAfterToolbarPlacement.x, rtrimPointAfterToolbarPlacement.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r1'
    ));
    const filterPositionsAfterPlace = await componentPositions(page);
    const r1NetsBeforeDuplicate = await componentPinNets(page, 'r1');
    await editor.focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+D' : 'Control+D');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '4' &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r2'
    ));
    const filterPositionsAfterDuplicate = await componentPositions(page);
    assert.deepEqual(
      filterPositionsAfterDuplicate.r2,
      {
        x: filterPositionsAfterPlace.r1.x + schematicGrid * 2,
        y: filterPositionsAfterPlace.r1.y + schematicGrid * 2,
      },
      'duplicate component should be offset by two grid steps',
    );
    assert.notDeepEqual(
      await componentPinNets(page, 'r2'),
      r1NetsBeforeDuplicate,
      'duplicated component should receive fresh pin nets instead of shorting to the original',
    );
    assert.equal(await page.getByTestId('schematic-editor-undo').isDisabled(), false, 'Undo toolbar button should be enabled after duplicate');
    await page.getByTestId('schematic-editor-undo').click();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '3' &&
      !document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions')?.includes('"r2"')
    ));
    assert.equal(await page.getByTestId('schematic-editor-redo').isDisabled(), false, 'Redo toolbar button should be enabled after toolbar undo');
    await page.getByTestId('schematic-editor-redo').click();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '4' &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions')?.includes('"r2"')
    ));
    await page.getByTestId('schematic-editor-undo').click();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '3' &&
      !document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions')?.includes('"r2"')
    ));
    const r1AfterDuplicateUndoForCopy = await componentScreenPoint(page, 'r1');
    await page.mouse.click(r1AfterDuplicateUndoForCopy.x, r1AfterDuplicateUndoForCopy.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r1'
    ));
    await editor.focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-clipboard-component-count') === '1'
    ));
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '4' &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r2'
    ));
    const filterPositionsAfterPaste = await componentPositions(page);
    assert.deepEqual(
      filterPositionsAfterPaste.r2,
      {
        x: filterPositionsAfterPlace.r1.x + schematicGrid * 2,
        y: filterPositionsAfterPlace.r1.y + schematicGrid * 2,
      },
      'pasted component should be offset by two grid steps',
    );
    assert.deepEqual(
      filterPositionsAfterPaste.r1,
      filterPositionsAfterPlace.r1,
      'pasting a copied component should not move the original component',
    );
    assert.notDeepEqual(
      await componentPinNets(page, 'r2'),
      r1NetsBeforeDuplicate,
      'pasted component should receive fresh pin nets instead of shorting to the original',
    );
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '3' &&
      !document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions')?.includes('"r2"')
    ));
    // Duplicating a wired selection preserves intra-selection wiring: the copied
    // pair shares one fresh net on the wired pins (no short to the original) and
    // the stored wire route is recreated with the duplicate offset.
    await page.getByTestId('schematic-editor-fit').click();
    const copyPairViewBox = await editorViewBox(page);
    const copyPairCanvasBox = await canvas.boundingBox();
    assert.ok(copyPairCanvasBox);
    const copyPairPointA = worldToScreen({ x: 340, y: 480 }, copyPairViewBox, copyPairCanvasBox);
    const copyPairPointB = worldToScreen({ x: 460, y: 480 }, copyPairViewBox, copyPairCanvasBox);
    await page.getByTestId('schematic-editor-place-R').click();
    await page.mouse.click(copyPairPointA.x, copyPairPointA.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '4' &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r2'
    ));
    await page.getByTestId('schematic-editor-place-C').click();
    await page.mouse.click(copyPairPointB.x, copyPairPointB.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '5' &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:c1'
    ));
    await page.getByTestId('schematic-editor-wire').click();
    const copyPairPinsR = await componentPinWorldPoints(page, 'r2');
    const copyPairPinsC = await componentPinWorldPoints(page, 'c1');
    assert.ok(copyPairPinsR?.b && copyPairPinsC?.a, 'expected r2.b and c1.a pin anchors before wiring the copy pair');
    // Refresh geometry after placement: Linux Electron can shift the SVG box
    // when the inspector updates, which breaks stale screen coordinates.
    const copyPairWireViewBox = await editorViewBox(page);
    const copyPairWireCanvasBox = await canvas.boundingBox();
    assert.ok(copyPairWireCanvasBox);
    const copyPairWireFrom = worldToScreen(copyPairPinsR.b, copyPairWireViewBox, copyPairWireCanvasBox);
    const copyPairWireTo = worldToScreen(copyPairPinsC.a, copyPairWireViewBox, copyPairWireCanvasBox);
    // Click-click wiring is the stable cross-platform path; drag-to-wire is also
    // supported, but pointermove coalescing on some Linux hosts is less reliable.
    await page.mouse.move(copyPairWireFrom.x, copyPairWireFrom.y);
    await page.waitForFunction(() => (
      (document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-hover-endpoint') ?? '')
        .toLowerCase()
        .includes('r2')
    ));
    await page.mouse.click(copyPairWireFrom.x, copyPairWireFrom.y);
    await page.waitForFunction(() => (
      Boolean(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wire-start'))
    ));
    await page.mouse.move(copyPairWireTo.x, copyPairWireTo.y);
    await page.waitForFunction(() => (
      (document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-hover-endpoint') ?? '')
        .toLowerCase()
        .includes('c1')
    ));
    await page.mouse.click(copyPairWireTo.x, copyPairWireTo.y);
    await page.waitForFunction(() => {
      const wires = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]');
      return wires.some((wire) => wire.from?.component_id === 'r2' && wire.to?.component_id === 'c1');
    });
    const r2NetsAfterWire = await componentPinNets(page, 'r2');
    const c1NetsAfterWire = await componentPinNets(page, 'c1');
    assert.equal(r2NetsAfterWire[1], c1NetsAfterWire[0], 'wired pins should share a net before duplicating');
    await page.keyboard.press('Escape');
    await page.getByTestId('schematic-editor-select').click();
    const r2BodyPoint = await componentScreenPoint(page, 'r2');
    await page.mouse.click(r2BodyPoint.x, r2BodyPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r2'
    ));
    // A single selected component must not make its wires look selected;
    // the attached highlight is a multi-selection group marker only.
    assert.equal(
      await page.getByTestId('schematic-attached-wire-highlight').count(),
      0,
      'single component selection must not highlight attached wires',
    );
    const c1BodyPoint = await componentScreenPoint(page, 'c1');
    await page.keyboard.down('Shift');
    await page.mouse.click(c1BodyPoint.x, c1BodyPoint.y);
    await page.keyboard.up('Shift');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '2'
    ));
    assert.ok(
      await page.getByTestId('schematic-attached-wire-highlight').count() >= 1,
      'multi-selected components should highlight their shared attached wires',
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === ''
    ));
    assert.equal(
      await page.getByTestId('schematic-attached-wire-highlight').count(),
      0,
      'attached-wire highlights should clear with the selection',
    );
    await page.mouse.click(r2BodyPoint.x, r2BodyPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r2'
    ));
    const c1BodyPointForDuplicate = await componentScreenPoint(page, 'c1');
    await page.keyboard.down('Shift');
    await page.mouse.click(c1BodyPointForDuplicate.x, c1BodyPointForDuplicate.y);
    await page.keyboard.up('Shift');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '2'
    ));
    const wiresBeforeDuplicate = await editorWires(page);
    const originalPairWireBefore = wiresBeforeDuplicate.find((wire) => (
      wire.source === 'stored'
      && wire.from?.component_id === 'r2'
      && wire.to?.component_id === 'c1'
    ));
    assert.ok(originalPairWireBefore, 'wired copy-pair should expose the original stored wire before duplicate');
    const expectedCopiedPoints = (originalPairWireBefore.points ?? []).map((point) => ({
      x: point.x + schematicGrid * 2,
      y: point.y + schematicGrid * 2,
    }));
    await editor.focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+D' : 'Control+D');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '7' &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'components:r3,c2'
    ));
    const r3Nets = await componentPinNets(page, 'r3');
    const c2Nets = await componentPinNets(page, 'c2');
    assert.equal(r3Nets[1], c2Nets[0], 'duplicated wired pair should keep a shared net on the wired pins');
    assert.notEqual(r3Nets[1], r2NetsAfterWire[1], 'duplicated shared net must not short to the original net');
    assert.notEqual(r3Nets[0], c2Nets[1], 'unwired pins of the duplicated pair should keep dangling nets');
    const copyPairWires = await editorWires(page);
    const copiedPairWire = copyPairWires.find((wire) => (
      wire.source === 'stored'
      && wire.from?.component_id === 'r3'
      && wire.to?.component_id === 'c2'
    ));
    assert.ok(copiedPairWire, 'duplicating a wired selection should recreate the stored wire between the copies');
    assert.equal(copiedPairWire.source, 'stored', 'copied wire should stay a stored wire');
    const copiedPoints = copiedPairWire.points ?? [];
    assert.ok(copiedPoints.length >= 2, 'copied wire should keep a routed polyline');
    assert.deepEqual(
      copiedPoints[0],
      expectedCopiedPoints[0],
      'copied wire start should follow the duplicate offset',
    );
    assert.deepEqual(
      copiedPoints[copiedPoints.length - 1],
      expectedCopiedPoints[expectedCopiedPoints.length - 1],
      'copied wire end should follow the duplicate offset',
    );
    assertWireOrthogonal(copiedPairWire, 'copied wire should stay orthogonal after duplicate');
    // Prefer an exact translated route when projection keeps midpoints; otherwise
    // endpoint-aligned orthogonality above still proves connectivity preservation.
    if (copiedPoints.length === expectedCopiedPoints.length) {
      assert.deepEqual(
        copiedPoints,
        expectedCopiedPoints,
        'copied wire should keep the original route translated by the duplicate offset',
      );
    }
    for (let undoCopyPair = 0; undoCopyPair < 4; undoCopyPair += 1) {
      await editor.focus();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    }
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '3'
    ));
    console.log('[e2e] duplicate preserves intra-selection wiring verified');
    const r1ForNudge = await componentScreenPoint(page, 'r1');
    await page.mouse.click(r1ForNudge.x, r1ForNudge.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r1'
    ));
    await editor.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(({ previousX, grid }) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return Number(positions.r1?.x) === Number(previousX) + Number(grid);
    }, { previousX: filterPositionsAfterPlace.r1.x, grid: schematicGrid });
    const filterPositionsAfterNudge = await componentPositions(page);
    assertPositionEqual(filterPositionsAfterNudge.r_filter, filterPositionsAfterPlace.r_filter, 'nudging added resistor moved r_filter');
    assertPositionEqual(filterPositionsAfterNudge.c_filter, filterPositionsAfterPlace.c_filter, 'nudging added resistor moved c_filter');
    assert.deepEqual(
      { x: Number(filterPositionsAfterNudge.r1.x), y: Number(filterPositionsAfterNudge.r1.y) },
      { x: Number(filterPositionsAfterPlace.r1.x) + schematicGrid, y: Number(filterPositionsAfterPlace.r1.y) },
      'ArrowRight did not nudge added resistor by one grid step',
    );
    const filterRotationsAfterNudge = await componentRotations(page);
    await editor.focus();
    await page.keyboard.press('r');
    await page.waitForFunction(({ componentId, previousRotation }) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-rotations') ?? '{}';
      const rotations = JSON.parse(raw);
      return Number(rotations[componentId]) === (Number(previousRotation) + 90) % 360;
    }, { componentId: 'r1', previousRotation: filterRotationsAfterNudge.r1 ?? 0 });
    const filterPositionsAfterRotate = await componentPositions(page);
    assertPositionEqual(filterPositionsAfterRotate.r_filter, filterPositionsAfterNudge.r_filter, 'rotating added resistor moved r_filter');
    assertPositionEqual(filterPositionsAfterRotate.c_filter, filterPositionsAfterNudge.c_filter, 'rotating added resistor moved c_filter');
    assertPositionEqual(filterPositionsAfterRotate.r1, filterPositionsAfterNudge.r1, 'rotating added resistor moved its origin');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForFunction(({ componentId, previousRotation }) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-rotations') ?? '{}';
      const rotations = JSON.parse(raw);
      return Number(rotations[componentId]) === Number(previousRotation);
    }, { componentId: 'r1', previousRotation: filterRotationsAfterNudge.r1 ?? 0 });
    assert.equal(
      await optimizeLayoutButton.isDisabled(),
      true,
      'LLM layout action should be disabled immediately while manual schematic edits are dirty',
    );
    console.log('[e2e] component placed');

    await page.getByTestId('schematic-editor-select').click();
    const r1PlaceViewBox = await editorViewBox(page);
    const r1PlaceBox = await canvas.boundingBox();
    assert.ok(r1PlaceBox);
    const r1PlacePoint = worldToScreen(filterPositionsAfterNudge.r1, r1PlaceViewBox, r1PlaceBox);
    await page.mouse.move(r1PlacePoint.x, r1PlacePoint.y);
    await page.mouse.down();
    await page.mouse.move(r1PlacePoint.x + 100, r1PlacePoint.y + 60, { steps: 8 });
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return Number(positions.r1?.x) !== Number(previous.x) || Number(positions.r1?.y) !== Number(previous.y);
    }, filterPositionsAfterNudge.r1);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return Number(positions.r1?.x) === Number(previous.x) && Number(positions.r1?.y) === Number(previous.y);
    }, filterPositionsAfterNudge.r1);
    const filterPositionsAfterCancelDrag = await componentPositions(page);
    assertPositionEqual(filterPositionsAfterCancelDrag.r_filter, filterPositionsAfterNudge.r_filter, 'cancelled drag moved r_filter');
    assertPositionEqual(filterPositionsAfterCancelDrag.c_filter, filterPositionsAfterNudge.c_filter, 'cancelled drag moved c_filter');
    assertPositionEqual(filterPositionsAfterCancelDrag.r1, filterPositionsAfterNudge.r1, 'Escape did not cancel the active drag');

    await page.mouse.click(r1PlacePoint.x, r1PlacePoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r1'
    ));
    // qucs parity: double-clicking a component focuses the inspector param editor.
    const r1BodyForEdit = await componentScreenPoint(page, 'r1');
    await page.mouse.dblclick(r1BodyForEdit.x, r1BodyForEdit.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r1' &&
      document.activeElement?.getAttribute('data-testid') === 'schematic-param-magnitude'
    ));
    await editor.focus();
    assert.equal(await page.getByTestId('schematic-selected-component-frame').count(), 1, 'component selection frame is missing');
    const componentSelectionFrame = page.getByTestId('schematic-selected-component-frame').first();
    assert.equal(await componentSelectionFrame.evaluate((node) => node.tagName.toLowerCase()), 'rect', 'component selection should use a frame rectangle');
    assert.equal(await componentSelectionFrame.getAttribute('data-selection-kind'), 'component');
    assert.equal(await componentSelectionFrame.getAttribute('data-selection-shape'), 'frame');
    assert.equal(await componentSelectionFrame.getAttribute('stroke-dasharray'), '8 6', 'component selection should use a dashed frame');
    const componentSelectionStroke = await componentSelectionFrame.getAttribute('stroke');
    assert.equal(await page.getByTestId('schematic-selected-component-corner').count(), 4, 'component selection should use square corner handles');
    assert.equal(
      await page.getByTestId('schematic-selected-component-corner').first().getAttribute('data-selection-handle-shape'),
      'square',
      'component selection handles should be square',
    );
    const filterRotationsBeforeContextMenu = await componentRotations(page);
    const componentCountBeforeContextMenu = Number(await editor.getAttribute('data-component-count'));
    await page.mouse.click(r1PlacePoint.x, r1PlacePoint.y, { button: 'right' });
    await page.getByTestId('schematic-context-menu').waitFor();
    assert.equal(await page.getByTestId('schematic-context-menu').getAttribute('data-menu-target'), 'component:r1');
    assert.equal(await page.getByTestId('schematic-context-menu').getAttribute('data-menu-kind'), 'component');
    assert.equal(await page.getByTestId('schematic-context-menu-rotate').count(), 1, 'component context menu should expose Rotate');
    assert.equal(await page.getByTestId('schematic-context-menu-duplicate').count(), 1, 'component context menu should expose Duplicate');
    await page.getByTestId('schematic-context-menu-rotate').click();
    await page.waitForFunction(({ componentId, previousRotation }) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-rotations') ?? '{}';
      const rotations = JSON.parse(raw);
      return Number(rotations[componentId]) === (Number(previousRotation) + 90) % 360;
    }, { componentId: 'r1', previousRotation: filterRotationsBeforeContextMenu.r1 ?? 0 });
    assert.equal(await page.getByTestId('schematic-context-menu').count(), 0, 'component context menu should close after Rotate');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForFunction(({ componentId, previousRotation }) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-rotations') ?? '{}';
      const rotations = JSON.parse(raw);
      return Number(rotations[componentId]) === Number(previousRotation);
    }, { componentId: 'r1', previousRotation: filterRotationsBeforeContextMenu.r1 ?? 0 });
    await page.mouse.click(r1PlacePoint.x, r1PlacePoint.y, { button: 'right' });
    await page.getByTestId('schematic-context-menu').waitFor();
    await page.getByTestId('schematic-context-menu-duplicate').click();
    await page.waitForFunction((previousCount) => (
      Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') ?? '0') === Number(previousCount) + 1
    ), componentCountBeforeContextMenu);
    const duplicatedSelection = await editor.getAttribute('data-selected');
    assert.match(duplicatedSelection ?? '', /^component:r/, 'component context Duplicate should select the duplicated resistor');
    assert.notEqual(duplicatedSelection, 'component:r1', 'component context Duplicate should not keep the original resistor selected');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForFunction((previousCount) => (
      Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') ?? '0') === Number(previousCount)
    ), componentCountBeforeContextMenu);
    await page.mouse.click(r1PlacePoint.x, r1PlacePoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r1'
    ));
    const r1FramePaddingPoint = await componentScreenPoint(page, 'r1', { x: 0, y: -75 });
    await page.mouse.move(r1FramePaddingPoint.x, r1FramePaddingPoint.y);
    await page.mouse.down();
    await page.mouse.move(r1FramePaddingPoint.x + 70, r1FramePaddingPoint.y + 35, { steps: 8 });
    await page.mouse.up();
    const filterPositionsAfterFramePaddingDrag = await componentPositions(page);
    assertPositionEqual(filterPositionsAfterFramePaddingDrag.r_filter, filterPositionsAfterNudge.r_filter, 'dragging selected-frame padding moved r_filter');
    assertPositionEqual(filterPositionsAfterFramePaddingDrag.c_filter, filterPositionsAfterNudge.c_filter, 'dragging selected-frame padding moved c_filter');
    assertPositionEqual(filterPositionsAfterFramePaddingDrag.r1, filterPositionsAfterNudge.r1, 'dragging selected-frame padding moved r1');
    // The padding-area marquee may legitimately graze the overlapping neighbours'
    // bounding boxes (r1 sits 40 units from c_filter); clear the selection before
    // re-selecting r1 for the frame-corner drag below.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === ''
    ));
    await page.mouse.click(r1PlacePoint.x, r1PlacePoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r1'
    ));
    const r1FrameDragPoint = await selectedComponentCornerScreenPoint(page, 'r1', 2);
    await page.mouse.move(r1FrameDragPoint.x, r1FrameDragPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grab'
    ));
    await page.mouse.down();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
    ));
    await page.mouse.move(r1FrameDragPoint.x + 80, r1FrameDragPoint.y + 40, { steps: 8 });
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return Number(positions.r1?.x) !== Number(previous.x) || Number(positions.r1?.y) !== Number(previous.y);
    }, filterPositionsAfterNudge.r1);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return Number(positions.r1?.x) === Number(previous.x) && Number(positions.r1?.y) === Number(previous.y);
    }, filterPositionsAfterNudge.r1);
    const filterPositionsAfterFrameDragCancel = await componentPositions(page);
    assertPositionEqual(filterPositionsAfterFrameDragCancel.r_filter, filterPositionsAfterNudge.r_filter, 'cancelled frame drag moved r_filter');
    assertPositionEqual(filterPositionsAfterFrameDragCancel.c_filter, filterPositionsAfterNudge.c_filter, 'cancelled frame drag moved c_filter');
    assertPositionEqual(filterPositionsAfterFrameDragCancel.r1, filterPositionsAfterNudge.r1, 'Escape did not cancel selected-frame drag');
    await page.mouse.click(r1PlacePoint.x, r1PlacePoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r1'
    ));
    await editor.focus();
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '2'
    ));
    const filterPositionsAfterDelete = await componentPositions(page);
    assert.equal(filterPositionsAfterDelete.r1, undefined, 'Delete did not remove the selected resistor');
    assertPositionEqual(filterPositionsAfterDelete.r_filter, filterPositionsAfterNudge.r_filter, 'deleting added resistor moved r_filter');
    assertPositionEqual(filterPositionsAfterDelete.c_filter, filterPositionsAfterNudge.c_filter, 'deleting added resistor moved c_filter');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '3' &&
        Number(positions.r1?.x) === Number(previous.x) &&
        Number(positions.r1?.y) === Number(previous.y);
    }, filterPositionsAfterNudge.r1);
    const filterPositionsAfterDeleteUndo = await componentPositions(page);
    assertPositionEqual(filterPositionsAfterDeleteUndo.r_filter, filterPositionsAfterNudge.r_filter, 'undo delete moved r_filter');
    assertPositionEqual(filterPositionsAfterDeleteUndo.c_filter, filterPositionsAfterNudge.c_filter, 'undo delete moved c_filter');
    assertPositionEqual(filterPositionsAfterDeleteUndo.r1, filterPositionsAfterNudge.r1, 'undo delete did not restore r1');
    await page.mouse.click(r1PlacePoint.x, r1PlacePoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r1'
    ));
    await editor.focus();
    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '2'
    ));
    const filterPositionsAfterBackspaceDelete = await componentPositions(page);
    assert.equal(filterPositionsAfterBackspaceDelete.r1, undefined, 'Backspace did not remove the selected resistor');
    assertPositionEqual(filterPositionsAfterBackspaceDelete.r_filter, filterPositionsAfterNudge.r_filter, 'Backspace deleting added resistor moved r_filter');
    assertPositionEqual(filterPositionsAfterBackspaceDelete.c_filter, filterPositionsAfterNudge.c_filter, 'Backspace deleting added resistor moved c_filter');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '3' &&
        Number(positions.r1?.x) === Number(previous.x) &&
        Number(positions.r1?.y) === Number(previous.y);
    }, filterPositionsAfterNudge.r1);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+Y');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '2'
    ));
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === '3' &&
        Number(positions.r1?.x) === Number(previous.x) &&
        Number(positions.r1?.y) === Number(previous.y);
    }, filterPositionsAfterNudge.r1);
    const filterPositionsAfterRedoUndo = await componentPositions(page);
    assertPositionEqual(filterPositionsAfterRedoUndo.r_filter, filterPositionsAfterNudge.r_filter, 'redo/undo delete moved r_filter');
    assertPositionEqual(filterPositionsAfterRedoUndo.c_filter, filterPositionsAfterNudge.c_filter, 'redo/undo delete moved c_filter');
    assertPositionEqual(filterPositionsAfterRedoUndo.r1, filterPositionsAfterNudge.r1, 'redo/undo delete did not restore r1');
    console.log('[e2e] delete undo redo isolated');

    await page.mouse.move(r1PlacePoint.x, r1PlacePoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grab'
    ));
    await page.mouse.down();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
    ));
    await page.mouse.move(r1PlacePoint.x + 60, r1PlacePoint.y + 30, { steps: 8 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-drag-preview') === 'true'
    ));
    await page.mouse.up();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') !== 'grabbing' &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-drag-preview') === 'false'
    ));
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
    ));
    const filterPositionsAfterDrag = await componentPositions(page);
    assertPositionEqual(filterPositionsAfterDrag.r_filter, filterPositionsAfterNudge.r_filter, 'dragging added resistor moved r_filter');
    assertPositionEqual(filterPositionsAfterDrag.c_filter, filterPositionsAfterNudge.c_filter, 'dragging added resistor moved c_filter');
    assertPositionChanged(filterPositionsAfterDrag.r1, filterPositionsAfterNudge.r1, 'added resistor did not move');
    console.log('[e2e] component drag isolated');

    const viewBoxAfterDrag = await editorViewBox(page);
    const canvasBoxAfterDrag = await canvas.boundingBox();
    assert.ok(canvasBoxAfterDrag);
    const wireStart = worldToScreen(
      { x: filterPositionsAfterDrag.r_filter.x + 52, y: filterPositionsAfterDrag.r_filter.y },
      viewBoxAfterDrag,
      canvasBoxAfterDrag,
    );
    const wireEnd = worldToScreen(
      { x: filterPositionsAfterDrag.r1.x - 52, y: filterPositionsAfterDrag.r1.y },
      viewBoxAfterDrag,
      canvasBoxAfterDrag,
    );
    await page.getByTestId('schematic-editor-wire').click();
    await page.mouse.move(wireStart.x, wireStart.y);
    await page.mouse.down();
    await page.mouse.move(wireEnd.x, wireEnd.y, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction((count) => (
      Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wire-count') ?? '0') > count
    ), initialWireCount);
    const wiresAfterDraw = await editorWires(page);
    const storedWiresAfterDraw = wiresAfterDraw.filter((wire) => wire.source === 'stored');
    const drawnWire = storedWiresAfterDraw.at(-1);
    assert.ok(drawnWire, 'drawn stored wire was not exposed to the editor');
    assert.ok(Array.isArray(drawnWire.points) && drawnWire.points.length >= 2, 'drawn wire points were not exposed to the editor');
    assertWireOrthogonal(drawnWire, 'drawn stored wire should be orthogonal');
    assert.ok(await isWireVisible(page, drawnWire.id), 'drawn wire is not visibly drawn');
    await assertRenderedWirePolylinesOrthogonal(page, 'after drawing a stored wire');
    assert.notEqual(
      await editor.getAttribute('data-wire-start'),
      '',
      'wire tool should keep the last endpoint active for KiCad-like continuous drawing',
    );
    const chainWireCount = Number(await editor.getAttribute('data-wire-count'));
    const chainViewBox = await editorViewBox(page);
    const chainCanvasBox = await canvas.boundingBox();
    assert.ok(chainCanvasBox);
    const chainEnd = worldToScreen(
      { x: filterPositionsAfterDrag.r1.x - 130, y: filterPositionsAfterDrag.r1.y + 120 },
      chainViewBox,
      chainCanvasBox,
    );
    await page.mouse.click(chainEnd.x, chainEnd.y);
    await page.waitForFunction((count) => (
      Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wire-count') ?? '0') > count
    ), chainWireCount);
    assert.match(
      await editor.getAttribute('data-wire-start') ?? '',
      /^point:/,
      'wire tool should continue from the chained free point',
    );
    const wiresAfterChain = await editorWires(page);
    const chainedWire = wiresAfterChain.filter((wire) => wire.source === 'stored').at(-1);
    assert.ok(chainedWire && chainedWire.id !== drawnWire.id, 'continuous wire drawing did not create a second stored wire');
    assertWireOrthogonal(chainedWire, 'continuous wire segment should be orthogonal');
    assert.ok(await isWireVisible(page, chainedWire.id), 'continuous wire segment is not visibly drawn');
    await assertRenderedWirePolylinesOrthogonal(page, 'after continuous wire drawing');
    // qucs/KiCad parity: double-click ends the in-progress wire chain.
    // The end point must be free (no wire/pin snap) AND inside the occupied
    // document region -- a wire expanding the document bounds would rescale the
    // viewport and change the world-space delta of the segment drags below.
    const dblEnd = await page.getByTestId('schematic-editor-svg').evaluate((svg) => {
      if (!(svg instanceof SVGSVGElement)) throw new Error('schematic editor svg missing');
      const editor = document.querySelector('[data-testid="schematic-editor"]');
      const wires = JSON.parse(editor?.getAttribute('data-wires') ?? '[]');
      const components = Object.values(JSON.parse(editor?.getAttribute('data-component-positions') ?? '{}'));
      const ports = Object.values(JSON.parse(editor?.getAttribute('data-port-positions') ?? '{}'));
      const extent = (values) => values.flatMap((wire) => (wire.points ?? []));
      const occupiedPoints = [...components, ...ports, ...extent(wires)];
      const box = {
        minX: Math.min(...occupiedPoints.map((p) => p.x)),
        maxX: Math.max(...occupiedPoints.map((p) => p.x)),
        minY: Math.min(...occupiedPoints.map((p) => p.y)),
        maxY: Math.max(...occupiedPoints.map((p) => p.y)),
      };
      const segmentDistance = (px, py, a, b) => {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSquared = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lengthSquared));
        return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
      };
      let best = null;
      for (let x = Math.ceil(box.minX / 20) * 20; x <= box.maxX; x += 20) {
        for (let y = Math.ceil(box.minY / 20) * 20; y <= box.maxY; y += 20) {
          let clearance = Math.min(
            ...components.map((p) => Math.hypot(x - p.x, y - p.y)),
            ...ports.map((p) => Math.hypot(x - p.x, y - p.y)),
          );
          if (clearance < 60) continue;
          for (const wire of wires) {
            const points = wire.points ?? [];
            for (let index = 1; index < points.length; index += 1) {
              clearance = Math.min(clearance, segmentDistance(x, y, points[index - 1], points[index]));
            }
          }
          if (clearance < 30) continue;
          if (!best || clearance > best.clearance) best = { x, y, clearance };
        }
      }
      if (!best) throw new Error('no free in-bounds point for the double-click wire end');
      const matrix = svg.getScreenCTM();
      if (!matrix) throw new Error('schematic editor svg has no screen matrix');
      const point = svg.createSVGPoint();
      point.x = best.x;
      point.y = best.y;
      const screen = point.matrixTransform(matrix);
      return { x: screen.x, y: screen.y };
    });
    const wireCountBeforeDblEnd = Number(await editor.getAttribute('data-wire-count'));
    await page.mouse.dblclick(dblEnd.x, dblEnd.y);
    await page.waitForFunction((count) => (
      Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wire-count') ?? '0') === count + 1
    ), wireCountBeforeDblEnd);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wire-start') === ''
    ));
    const positionsBeforeWireDrag = await componentPositions(page);
    const wirePointsBeforeDrag = drawnWire.points;
    const wireDragPoint = await wireScreenPointAwayFromComponents(page, drawnWire.id);
    await page.getByTestId('schematic-editor-select').click();
    await page.mouse.move(wireDragPoint.x, wireDragPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'move'
    ));
    await page.mouse.down();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
    ));
    await page.mouse.move(wireDragPoint.x + 70, wireDragPoint.y + 55, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(({ wireId, before }) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
      const wire = JSON.parse(raw).find((entry) => entry.id === wireId);
      return wire && JSON.stringify(wire.points) !== JSON.stringify(before);
    }, { wireId: drawnWire.id, before: wirePointsBeforeDrag });
    assert.deepEqual(
      await componentPositions(page),
      positionsBeforeWireDrag,
      'dragging a stored wire segment should not move schematic components',
    );
    assert.equal(await editor.getAttribute('data-selected'), `wire:${drawnWire.id}`, 'dragged wire should stay selected');
    assert.ok(await isWireVisible(page, drawnWire.id), 'dragged wire segment is not visibly drawn');
    console.log('[e2e] stored wire segment drag isolated');
    const wiresAfterSegmentDrag = await editorWires(page);
    const wireAfterSegmentDrag = wiresAfterSegmentDrag.find((wire) => wire.id === drawnWire.id);
    assert.ok(wireAfterSegmentDrag, 'dragged wire disappeared before cancel-drag regression');
    assertWireOrthogonal(wireAfterSegmentDrag, 'stored wire segment drag should keep wire orthogonal');
    await assertRenderedWirePolylinesOrthogonal(page, 'after stored wire segment drag');
    const wireCancelDragPoint = await wireScreenPointAwayFromComponents(page, drawnWire.id);
    await page.mouse.move(wireCancelDragPoint.x, wireCancelDragPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'move'
    ));
    await page.mouse.down();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
    ));
    await page.mouse.move(wireCancelDragPoint.x - 80, wireCancelDragPoint.y + 50, { steps: 8 });
    await page.waitForFunction(({ wireId, before }) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
      const wire = JSON.parse(raw).find((entry) => entry.id === wireId);
      return wire && JSON.stringify(wire.points) !== JSON.stringify(before);
    }, { wireId: drawnWire.id, before: wireAfterSegmentDrag.points });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForFunction(({ wireId, before }) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
      const wire = JSON.parse(raw).find((entry) => entry.id === wireId);
      return wire && JSON.stringify(wire.points) === JSON.stringify(before);
    }, { wireId: drawnWire.id, before: wireAfterSegmentDrag.points });
    assert.deepEqual(
      await componentPositions(page),
      positionsBeforeWireDrag,
      'Escape-canceling a stored wire segment drag moved schematic components',
    );
    await assertRenderedWirePolylinesOrthogonal(page, 'after canceling stored wire segment drag');
    console.log('[e2e] stored wire segment cancel isolated');
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-wire-visible.png') });
    console.log('[e2e] wire drawn');

    const wireSelectPoint = await wireScreenPointAwayFromComponents(page, drawnWire.id);
    await page.getByTestId('schematic-editor-select').click();
    await page.mouse.click(wireSelectPoint.x, wireSelectPoint.y);
    await page.waitForFunction(() => (
      Boolean(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected'))
    ));
    const selectedAfterWireClick = await editor.getAttribute('data-selected');
    if (selectedAfterWireClick !== `wire:${drawnWire.id}`) {
      console.log('[e2e] wire click selected unexpected item', JSON.stringify({
        drawnWireId: drawnWire.id,
        selectedAfterWireClick,
        wireSelectPoint,
        storedWireIds: storedWiresAfterDraw.map((wire) => wire.id),
      }));
    }
    assert.equal(selectedAfterWireClick, `wire:${drawnWire.id}`, 'clicking the drawn wire did not select that stored wire');
    assert.equal(await page.getByTestId('schematic-selected-wire-highlight').count(), 1, 'wire selection highlight is missing');
    const wireSelectionHighlight = page.getByTestId('schematic-selected-wire-highlight').first();
    assert.equal(await wireSelectionHighlight.evaluate((node) => node.tagName.toLowerCase()), 'polyline', 'wire selection should follow the selected route');
    assert.equal(await wireSelectionHighlight.getAttribute('data-selection-kind'), 'wire');
    assert.equal(await wireSelectionHighlight.getAttribute('data-selection-shape'), 'route');
    assert.equal(await wireSelectionHighlight.getAttribute('stroke-width'), '11', 'wire selection should use a broad route highlight');
    assert.equal(await wireSelectionHighlight.getAttribute('stroke-dasharray'), null, 'wire selection should not use the component dashed frame style');
    assert.notEqual(
      await wireSelectionHighlight.getAttribute('stroke'),
      componentSelectionStroke,
      'wire and component selections should use visibly different strokes',
    );
    assert.equal(await page.getByTestId('schematic-selected-component-frame').count(), 0, 'wire selection should not show component selection frame');
    assert.equal(await page.getByTestId('schematic-selected-component-corner').count(), 0, 'wire selection should not show component corner handles');
    await page.getByTestId('schematic-editor-wire-panel').waitFor();
    const selectedPanelWire = (await editorWires(page)).find((wire) => wire.id === drawnWire.id);
    assert.ok(selectedPanelWire, 'wire selection panel should describe the selected stored wire');
    assert.equal(
      (await page.getByTestId('schematic-editor-wire-net').textContent())?.trim(),
      selectedPanelWire.net ?? '-',
      'wire selection panel should show the selected wire net',
    );
    assert.equal(
      (await page.getByTestId('schematic-editor-wire-source').textContent())?.trim(),
      selectedPanelWire.source ?? 'net',
      'wire selection panel should show whether the wire is stored or generated',
    );
    assert.equal(
      Number((await page.getByTestId('schematic-editor-wire-point-count').textContent())?.trim()),
      selectedPanelWire.points.length,
      'wire selection panel should show the current route point count',
    );
    const visiblePointHandleCount = await page.getByTestId('schematic-wire-point-handle').count();
    assert.equal(
      visiblePointHandleCount,
      selectedPanelWire.points.length,
      `selected stored wire should expose one point handle per route point (got ${visiblePointHandleCount} handles for ${drawnWire.id} with ${JSON.stringify(selectedPanelWire.points)})`,
    );
    assert.equal(
      await page.getByTestId('schematic-wire-point-handle').first().getAttribute('data-selection-handle-shape'),
      'circle',
      'wire selection handles should be circular',
    );
    const wireCountBeforeContextDelete = Number(await editor.getAttribute('data-wire-count'));
    await page.mouse.click(wireSelectPoint.x, wireSelectPoint.y, { button: 'right' });
    await page.getByTestId('schematic-context-menu').waitFor();
    assert.equal(await page.getByTestId('schematic-context-menu').getAttribute('data-menu-target'), `wire:${drawnWire.id}`);
    assert.equal(await page.getByTestId('schematic-context-menu').getAttribute('data-menu-kind'), 'wire');
    assert.equal(await page.getByTestId('schematic-context-menu-rotate').count(), 0, 'wire context menu should not expose Rotate');
    assert.equal(await page.getByTestId('schematic-context-menu-duplicate').count(), 0, 'wire context menu should not expose Duplicate');
    await page.getByTestId('schematic-context-menu-delete').click();
    await page.waitForFunction((wireId) => {
      const wires = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]');
      return !wires.some((wire) => wire.id === wireId);
    }, drawnWire.id);
    assert.ok(
      Number(await editor.getAttribute('data-wire-count')) < wireCountBeforeContextDelete,
      'wire context Delete did not reduce the visible wire count',
    );
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForFunction((wireId) => {
      const wires = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]');
      return wires.some((wire) => wire.id === wireId);
    }, drawnWire.id);
    await page.mouse.click(wireSelectPoint.x, wireSelectPoint.y);
    await page.waitForFunction((wireId) => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === `wire:${wireId}`
    ), drawnWire.id);
    const positionsBeforeWirePointDrag = await componentPositions(page);
    const wiresBeforePointDrag = await editorWires(page);
    const wireBeforePointDrag = wiresBeforePointDrag.find((wire) => wire.id === drawnWire.id);
    assert.ok(wireBeforePointDrag?.points?.[1], 'dragged stored wire should have an interior point handle');
    const wirePointHandle = await wireHandleScreenPoint(page, drawnWire.id, 1);
    await page.mouse.move(wirePointHandle.x, wirePointHandle.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'move'
    ));
    await page.mouse.down();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
    ));
    await page.mouse.move(wirePointHandle.x + 45, wirePointHandle.y - 45, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(({ wireId, before }) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
      const wire = JSON.parse(raw).find((entry) => entry.id === wireId);
      return wire && JSON.stringify(wire.points) !== JSON.stringify(before);
    }, { wireId: drawnWire.id, before: wireBeforePointDrag.points });
    assert.deepEqual(
      await componentPositions(page),
      positionsBeforeWirePointDrag,
      'dragging a wire point handle should not move schematic components',
    );
    assert.equal(await editor.getAttribute('data-selected'), `wire:${drawnWire.id}`, 'wire point drag should keep the wire selected');
    console.log('[e2e] stored wire point handle drag isolated');
    const wiresAfterPointDrag = await editorWires(page);
    const wireAfterPointDrag = wiresAfterPointDrag.find((wire) => wire.id === drawnWire.id);
    assert.ok(wireAfterPointDrag?.points?.[1], 'wire point drag result is missing an interior point handle');
    assertWireOrthogonal(wireAfterPointDrag, 'stored wire point drag should keep wire orthogonal');
    const wirePointCancelHandle = await wireHandleScreenPoint(page, drawnWire.id, 1);
    await page.mouse.move(wirePointCancelHandle.x, wirePointCancelHandle.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'move'
    ));
    await page.mouse.down();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
    ));
    await page.mouse.move(wirePointCancelHandle.x - 55, wirePointCancelHandle.y - 35, { steps: 8 });
    await page.waitForFunction(({ wireId, before }) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
      const wire = JSON.parse(raw).find((entry) => entry.id === wireId);
      return wire && JSON.stringify(wire.points) !== JSON.stringify(before);
    }, { wireId: drawnWire.id, before: wireAfterPointDrag.points });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForFunction(({ wireId, before }) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
      const wire = JSON.parse(raw).find((entry) => entry.id === wireId);
      return wire && JSON.stringify(wire.points) === JSON.stringify(before);
    }, { wireId: drawnWire.id, before: wireAfterPointDrag.points });
    assert.deepEqual(
      await componentPositions(page),
      positionsBeforeWirePointDrag,
      'Escape-canceling a wire point handle drag moved schematic components',
    );
    console.log('[e2e] stored wire point cancel isolated');
    const wireDeletePoint = await wireScreenPointAwayFromComponents(page, drawnWire.id);
    await page.getByTestId('schematic-editor-select').click();
    await page.mouse.click(wireDeletePoint.x, wireDeletePoint.y);
    await page.waitForFunction((wireId) => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === `wire:${wireId}`
    ), drawnWire.id);
    await page.keyboard.press('Delete');
    await page.waitForFunction((wireId) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
      return !JSON.parse(raw).some((wire) => wire.id === wireId);
    }, drawnWire.id);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForFunction((wireId) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
      return JSON.parse(raw).some((wire) => wire.id === wireId);
    }, drawnWire.id);
    assert.ok(await isWireVisible(page, drawnWire.id), 'undo did not restore the deleted visible wire');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+Y');
    await page.waitForFunction((wireId) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
      return !JSON.parse(raw).some((wire) => wire.id === wireId);
    }, drawnWire.id);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForFunction((wireId) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
      return JSON.parse(raw).some((wire) => wire.id === wireId);
    }, drawnWire.id);
    await page.mouse.click(wireDeletePoint.x, wireDeletePoint.y);
    await page.waitForFunction((wireId) => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === `wire:${wireId}`
    ), drawnWire.id);
    await page.keyboard.press('Backspace');
    await page.waitForFunction((wireId) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
      return !JSON.parse(raw).some((wire) => wire.id === wireId);
    }, drawnWire.id);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForFunction((wireId) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]';
      return JSON.parse(raw).some((wire) => wire.id === wireId);
    }, drawnWire.id);
    assert.ok(await isWireVisible(page, drawnWire.id), 'undo did not restore the Backspace-deleted visible wire');
    console.log('[e2e] wire delete undo redo isolated');

    // Multi-wire selection: Shift+click toggles membership, marquee over a
    // component-free wiring region selects all intersecting wires, Delete removes
    // them together, and undo restores them.
    const chainedWirePoint = await wireScreenPointAwayFromComponents(page, chainedWire.id);
    await page.mouse.click(chainedWirePoint.x, chainedWirePoint.y);
    await page.waitForFunction((wireId) => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === `wire:${wireId}`
    ), chainedWire.id);
    const dblEndWire = (await editorWires(page)).filter((wire) => wire.source === 'stored').at(-1);
    assert.ok(dblEndWire && dblEndWire.id !== chainedWire.id, 'expected the double-click-ended wire to exist');
    const dblEndWirePoint = await wireScreenPointAwayFromComponents(page, dblEndWire.id);
    await page.keyboard.down('Shift');
    await page.mouse.click(dblEndWirePoint.x, dblEndWirePoint.y);
    await page.keyboard.up('Shift');
    await page.waitForFunction(({ firstId, secondId }) => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === `wires:${firstId},${secondId}` &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-wire-count') === '2'
    ), { firstId: chainedWire.id, secondId: dblEndWire.id });
    await page.keyboard.down('Shift');
    await page.mouse.click(dblEndWirePoint.x, dblEndWirePoint.y);
    await page.keyboard.up('Shift');
    await page.waitForFunction((wireId) => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === `wire:${wireId}`
    ), chainedWire.id);
    await page.keyboard.down('Shift');
    await page.mouse.click(dblEndWirePoint.x, dblEndWirePoint.y);
    await page.keyboard.up('Shift');
    await page.waitForFunction(({ firstId, secondId }) => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === `wires:${firstId},${secondId}`
    ), { firstId: chainedWire.id, secondId: dblEndWire.id });
    // Plural marquee selection on controlled geometry: two free-space wires are
    // drawn in the empty far-right region (derived from occupied extents), both
    // are enclosed by one marquee, deleted together, and restored.
    const freeWireArea = await page.getByTestId('schematic-editor-svg').evaluate((svg) => {
      if (!(svg instanceof SVGSVGElement)) throw new Error('schematic editor svg missing');
      const editor = document.querySelector('[data-testid="schematic-editor"]');
      const wires = JSON.parse(editor?.getAttribute('data-wires') ?? '[]');
      const components = Object.values(JSON.parse(editor?.getAttribute('data-component-positions') ?? '{}'));
      const ports = Object.values(JSON.parse(editor?.getAttribute('data-port-positions') ?? '{}'));
      const occupied = [...components, ...ports, ...wires.flatMap((wire) => wire.points ?? [])];
      const [minX, minY, width, height] = (svg.getAttribute('viewBox') ?? '0 0 1 1').split(/\s+/).map(Number);
      const snap20 = (value) => Math.round(value / 20) * 20;
      const contentMinX = Math.min(...occupied.map((point) => point.x));
      const contentMinY = Math.min(...occupied.map((point) => point.y));
      const contentMaxY = Math.max(...occupied.map((point) => point.y));
      // Left of all content: right-side space is blocked by the OUT port's
      // interaction bounds; the IN port zone only reaches y~=214, so mid-Y is safe.
      let x2 = snap20(contentMinX - 60);
      let x1 = snap20(contentMinX - 140);
      const minAllowedX = minX + 20;
      if (x1 < minAllowedX) {
        x1 = snap20(minAllowedX);
        x2 = x1 + 80;
      }
      if (x2 - x1 < 60) throw new Error('no free left-side region for the marquee test');
      const y1 = snap20((contentMinY + contentMaxY) / 2);
      const y2 = y1 + 60;
      const matrix = svg.getScreenCTM();
      if (!matrix) throw new Error('schematic editor svg has no screen matrix');
      const toScreen = (x, y) => {
        const point = svg.createSVGPoint();
        point.x = x;
        point.y = y;
        const screen = point.matrixTransform(matrix);
        return { x: screen.x, y: screen.y };
      };
      return {
        aFrom: toScreen(x1, y1),
        aTo: toScreen(x2, y1),
        bFrom: toScreen(x1, y2),
        bTo: toScreen(x2, y2),
        marqueeFrom: toScreen(x1 - 20, y1 - 20),
        marqueeTo: toScreen(x2 + 20, y2 + 20),
      };
    });
    const storedIdsBeforeFreeWires = new Set(
      (await editorWires(page)).filter((wire) => wire.source === 'stored').map((wire) => wire.id),
    );
    for (const endpoints of [
      { from: freeWireArea.aFrom, to: freeWireArea.aTo },
      { from: freeWireArea.bFrom, to: freeWireArea.bTo },
    ]) {
      await page.getByTestId('schematic-editor-wire').click();
      await page.mouse.move(endpoints.from.x, endpoints.from.y);
      await page.mouse.down();
      await page.mouse.move(endpoints.to.x, endpoints.to.y, { steps: 6 });
      await page.mouse.up();
      await page.mouse.click(endpoints.to.x, endpoints.to.y, { button: 'right' });
    }
    await page.waitForFunction((beforeCount) => {
      const wires = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]');
      return wires.filter((wire) => wire.source === 'stored').length === beforeCount + 2;
    }, storedIdsBeforeFreeWires.size);
    const freeWireIds = (await editorWires(page))
      .filter((wire) => wire.source === 'stored' && !storedIdsBeforeFreeWires.has(wire.id))
      .map((wire) => wire.id);
    assert.equal(freeWireIds.length, 2, 'expected two free-space wires for the marquee test');
    const marqueeOverFreeWires = async () => {
      await page.getByTestId('schematic-editor-select').click();
      await page.mouse.move(freeWireArea.marqueeFrom.x, freeWireArea.marqueeFrom.y);
      await page.mouse.down();
      await page.mouse.move(freeWireArea.marqueeTo.x, freeWireArea.marqueeTo.y, { steps: 8 });
      await page.mouse.up();
    };
    const waitForFreeWiresSelected = () => page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected')?.startsWith('wires:') &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-wire-count') === '2'
    ));
    const waitForFreeWiresGone = () => page.waitForFunction((ids) => {
      const wires = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]');
      return ids.every((id) => !wires.some((wire) => wire.id === id));
    }, freeWireIds);
    await marqueeOverFreeWires();
    await waitForFreeWiresSelected();
    const marqueeSelected = (await editor.getAttribute('data-selected')) ?? '';
    for (const wireId of freeWireIds) {
      assert.ok(marqueeSelected.includes(wireId), `marquee should include ${wireId}, got ${marqueeSelected}`);
    }
    await page.keyboard.press('Delete');
    await waitForFreeWiresGone();
    assert.ok(await isWireVisible(page, drawnWire.id), 'multi-wire delete removed an unselected wire');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForFunction((ids) => {
      const wires = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]');
      return ids.every((id) => wires.some((wire) => wire.id === id));
    }, freeWireIds);
    // Remove the scratch wires so later sections see the pre-test document.
    await marqueeOverFreeWires();
    await waitForFreeWiresSelected();
    await page.keyboard.press('Delete');
    await waitForFreeWiresGone();
    await page.keyboard.press('Escape');
    console.log('[e2e] multi-wire selection (shift-click, marquee, delete, undo) verified');

    const positionsBeforeBlockPlacement = await componentPositions(page);
    await page.getByTestId('schematic-editor-place-block').click();
    await page.getByTestId('schematic-block-dialog').waitFor();
    await page.getByTestId('schematic-block-name').fill('U_CTRL');
    await page.getByTestId('schematic-block-value').fill('ADC + DSP');
    await page.getByTestId('schematic-block-width').fill('200');
    await page.getByTestId('schematic-block-height').fill('160');
    await page.getByTestId('schematic-block-pin-count').fill('6');
    await page.getByTestId('schematic-block-draft-pin-6').waitFor();
    const manualBlockPins = [
      { label: 'AIN', net: 'out', side: 'left' },
      { label: 'CLK', net: 'sample_clk', side: 'left' },
      { label: 'DATA', net: 'sample_data', side: 'right' },
      { label: 'IRQ', net: 'irq', side: 'right' },
      { label: 'VDD', net: 'vdd', side: 'top' },
      { label: 'GND', net: '0', side: 'bottom' },
    ];
    for (let index = 0; index < manualBlockPins.length; index += 1) {
      const pin = manualBlockPins[index];
      const pinNumber = index + 1;
      await page.getByTestId(`schematic-block-draft-pin-label-${pinNumber}`).fill(pin.label);
      await page.getByTestId(`schematic-block-draft-pin-net-${pinNumber}`).fill(pin.net);
      await page.getByTestId(`schematic-block-draft-pin-side-${pinNumber}`).selectOption(pin.side);
    }
    await page.getByTestId('schematic-block-place').click();
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return node?.getAttribute('data-tool') === 'place-block' &&
        node?.getAttribute('data-block-placement-ready') === 'true' &&
        node?.getAttribute('data-block-dialog') === 'false';
    });
    const blockCanvasBox = await page.getByTestId('schematic-editor-svg').boundingBox();
    assert.ok(blockCanvasBox, 'custom block placement requires a visible schematic canvas');
    await page.mouse.click(
      blockCanvasBox.x + blockCanvasBox.width * 0.9,
      blockCanvasBox.y + blockCanvasBox.height * 0.85,
    );
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      const components = JSON.parse(node?.getAttribute('data-components') ?? '[]');
      return node?.getAttribute('data-component-count') === '4' &&
        node?.getAttribute('data-tool') === 'place-block' &&
        components.some((component) => component.type === 'BLOCK' && component.name === 'U_CTRL');
    });
    const componentsAfterBlockPlacement = JSON.parse(await editor.getAttribute('data-components') ?? '[]');
    const manualBlock = componentsAfterBlockPlacement.find((component) => component.type === 'BLOCK' && component.name === 'U_CTRL');
    assert.ok(manualBlock, 'custom block placement did not add a structured BLOCK component');
    assert.equal(manualBlock.pins.length, 6, 'custom block should preserve the requested pin count');
    const manualBlockSymbol = page.getByTestId('schematic-editor-svg').locator(
      `g[data-component-id="${manualBlock.id}"] [data-symbol-kind="block"]`,
    );
    await manualBlockSymbol.waitFor();
    assert.equal(
      await manualBlockSymbol.locator('[data-testid="schematic-block-pin-label"]').count(),
      6,
      'custom block should render every configured pin label',
    );
    await page.getByTestId('schematic-editor-block-pin-label-p1').fill('AIN0');
    await page.getByTestId('schematic-editor-block-pin-net-p1').fill('filtered');
    await page.getByTestId('schematic-editor-block-add-pin').click();
    await page.getByTestId('schematic-editor-block-pin-p7').waitFor();
    await page.getByTestId('schematic-editor-block-pin-remove-p7').click();
    await page.waitForFunction(() => (
      !document.querySelector('[data-testid="schematic-editor-block-pin-p7"]') &&
      JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-components') ?? '[]')
        .find((component) => component.type === 'BLOCK' && component.name === 'U_CTRL')?.pins.length === 6
    ));
    const positionsAfterBlockPlacement = await componentPositions(page);
    for (const [componentId, position] of Object.entries(positionsBeforeBlockPlacement)) {
      assertPositionEqual(
        positionsAfterBlockPlacement[componentId],
        position,
        `placing a custom block moved existing component ${componentId}`,
      );
    }
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-custom-block.png') });
    console.log('[e2e] custom block placement and pin editing isolated');

    // R while placing a block rotates the pending block and must not exit place mode.
    await editor.focus();
    await page.keyboard.press('r');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-place-rotation') === '90' &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-tool') === 'place-block'
    ));
    assert.equal(
      await editor.getAttribute('data-selected'),
      `component:${manualBlock.id}`,
      'R in place-block mode must not rotate the selected block',
    );
    assert.equal(
      Number((await componentRotations(page))[manualBlock.id] ?? 0),
      0,
      'R in place-block mode must not change the placed block rotation',
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-tool') === 'select'
    ));

    // Block placement mode persists (qucs parity); return to the select tool before port tests.
    await page.getByTestId('schematic-editor-select').click();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-tool') === 'select'
    ));
    // Re-enter the filter editor so port hit-targets are not covered by leftover
    // placement chrome / viewport drift after the long interaction sequence.
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, 'filter');
    await editor.waitFor({ timeout: 20_000 });
    await waitForEditorIdle(page);
    await page.getByTestId('schematic-editor-select').click();
    await page.getByTestId('schematic-editor-fit').click();
    await waitForEditorIdle(page);
    const componentPositionsBeforePortMoves = await componentPositions(page);
    const portPositionsBeforeMoves = await portPositions(page);
    const wiresBeforePortMoves = await editorWires(page);
    const unrelatedStoredWireBeforePortMoves = wiresBeforePortMoves.find((wire) => (
      wire.source === 'stored' &&
      !['input', 'output'].includes(wire.from?.port_id) &&
      !['input', 'output'].includes(wire.to?.port_id)
    ));
    assert.ok(portPositionsBeforeMoves.input, 'input port position is not exposed');
    assert.ok(portPositionsBeforeMoves.output, 'output port position is not exposed');
    assert.ok(unrelatedStoredWireBeforePortMoves, 'port move regression requires an unrelated stored wire');

    const inputPortPoint = await portScreenPoint(page, 'input');
    await page.locator('g[data-port-id="input"] [data-testid="schematic-port-hit-target"]').evaluate((node) => {
      const box = node.getBoundingClientRect();
      const clientX = box.left + box.width / 2;
      const clientY = box.top + box.height / 2;
      node.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        pointerId: 1,
        pointerType: 'mouse',
        clientX,
        clientY,
      }));
      node.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 0,
        pointerId: 1,
        pointerType: 'mouse',
        clientX,
        clientY,
      }));
    });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'port:input'
    ));
    await page.getByTestId('schematic-selected-port-frame').waitFor();
    const inputPortDragPoint = await portScreenPoint(page, 'input');
    assert.ok(inputPortPoint && inputPortDragPoint, 'input port screen point should resolve');
    // Prefer keyboard nudges for cross-platform port moves; mouse drag remains
    // covered by the product pointerup distance fallback above.
    await editor.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction((before) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-port-positions');
      const current = JSON.parse(raw ?? '{}').input;
      return current && (current.x !== before.x || current.y !== before.y);
    }, portPositionsBeforeMoves.input);

    const outputPortPoint = await portScreenPoint(page, 'output');
    await page.mouse.click(outputPortPoint.x, outputPortPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'port:output'
    ));
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction((before) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-port-positions');
      const current = JSON.parse(raw ?? '{}').output;
      return current && current.y === before.y + 20;
    }, portPositionsBeforeMoves.output);

    const savedPortPositions = await portPositions(page);
    assertPositionChanged(savedPortPositions.input, portPositionsBeforeMoves.input, 'dragging IN did not move its port position');
    assertPositionChanged(savedPortPositions.output, portPositionsBeforeMoves.output, 'nudging OUT did not move its port position');
    assert.equal(savedPortPositions.input.x % 20, 0, 'dragged IN port x should remain on the schematic grid');
    assert.equal(savedPortPositions.input.y % 20, 0, 'dragged IN port y should remain on the schematic grid');
    const wiresAfterPortMoves = await editorWires(page);
    assertPortWireEndpoints(wiresAfterPortMoves, 'input', savedPortPositions.input, 'after dragging IN');
    assertPortWireEndpoints(wiresAfterPortMoves, 'output', savedPortPositions.output, 'after nudging OUT');
    assert.deepEqual(
      wiresAfterPortMoves.find((wire) => wire.id === unrelatedStoredWireBeforePortMoves.id)?.points,
      unrelatedStoredWireBeforePortMoves.points,
      'moving ports changed an unrelated stored wire route',
    );
    const componentPositionsAfterPortMoves = await componentPositions(page);
    for (const [componentId, position] of Object.entries(componentPositionsBeforePortMoves)) {
      assertPositionEqual(
        componentPositionsAfterPortMoves[componentId],
        position,
        `moving a port moved component ${componentId}`,
      );
    }
    console.log('[e2e] IN and OUT ports selected and moved independently');

    assert.equal(await editor.getAttribute('data-dirty'), 'true', 'Ctrl/Cmd+S persistence check requires a dirty schematic');
    await editor.focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return node?.getAttribute('data-dirty') === 'false' &&
        node?.getAttribute('data-component-count') === '4' &&
        Number(node?.getAttribute('data-wire-count') ?? '0') >= 3;
    });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return node?.getAttribute('data-preview-busy') === 'true'
        || document.body.innerText.includes('Applied netlist and affected module SVG rebuilt');
    }, { timeout: 30_000 });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return node?.getAttribute('data-preview-busy') === 'false'
        && document.body.innerText.includes('Applied netlist and affected module SVG rebuilt');
    }, { timeout: 60_000 });
    assert.equal(
      await optimizeLayoutButton.isEnabled(),
      true,
      'LLM layout action should be re-enabled after manual schematic edits are saved',
    );

    const moduleData = JSON.parse(await readFile(path.resolve(projectRoot, 'modules', 'filter', 'module.circuit.json'), 'utf8'));
    assert.equal(moduleData.components.length, 4);
    assert.ok((moduleData.wires ?? []).length >= 3, 'saved schematic document did not persist visible wires');
    assertWiresOrthogonal(moduleData.wires ?? [], 'saved schematic document wires should remain orthogonal');
    assert.ok(moduleData.components.some((component) => component.id === 'r1' && component.type === 'R'));
    const savedR1 = moduleData.components.find((component) => component.id === 'r1');
    const savedManualBlock = moduleData.components.find((component) => component.id === manualBlock.id);
    assert.equal(savedR1?.name, 'Rtrim');
    assert.equal(savedR1?.value, '2k');
    assert.equal(savedManualBlock?.type, 'BLOCK');
    assert.equal(savedManualBlock?.value, 'ADC + DSP');
    assert.equal(savedManualBlock?.pins.length, 6);
    assertPositionEqual(
      moduleData.ports.find((port) => port.id === 'input')?.position,
      savedPortPositions.input,
      'saved module did not persist the moved IN port position',
    );
    assertPositionEqual(
      moduleData.ports.find((port) => port.id === 'output')?.position,
      savedPortPositions.output,
      'saved module did not persist the moved OUT port position',
    );
    assert.deepEqual(
      savedManualBlock?.pins.map((pin) => [pin.name, pin.net, pin.side]),
      [
        ['AIN0', 'filtered', 'left'],
        ['CLK', 'sample_clk', 'left'],
        ['DATA', 'sample_data', 'right'],
        ['IRQ', 'irq', 'right'],
        ['VDD', 'vdd', 'top'],
        ['GND', '0', 'bottom'],
      ],
    );
    assert.match(
      await readFile(path.resolve(projectRoot, 'build', 'modules', 'filter', 'design.cir'), 'utf8'),
      /Rfilter_Rtrim\s+out\s+\S+\s+2k/,
    );
    assert.match(
      await readFile(path.resolve(projectRoot, 'build', 'modules', 'filter', 'design.cir'), 'utf8'),
      /\* BLOCK U_CTRL: ADC \+ DSP/,
    );
    console.log('[e2e] apply persisted');

    await page.getByTestId('schematic-svg-tab').click();
    await page.getByTestId('module-netlistsvg').locator('svg').waitFor({ timeout: 20_000 });
    assert.equal(await page.getByTestId('module-netlistsvg').getAttribute('data-schematic-source'), 'document');
    assert.equal(await page.getByTestId('module-document-svg').getAttribute('data-schematic-source'), 'document');
    assert.equal(
      await page.getByTestId('module-document-svg').locator('g[data-component-id="r1"]').count(),
      1,
      'document SVG did not render the applied Rtrim component',
    );
    assert.equal(
      await page.getByTestId('module-document-svg').locator(`g[data-wire-id="${drawnWire.id}"]`).count(),
      1,
      'document SVG did not render the applied manually drawn wire',
    );
    assert.equal(
      await page.getByTestId('module-document-svg').locator(`g[data-component-id="${manualBlock.id}"] [data-symbol-kind="block"]`).count(),
      1,
      'document SVG did not render the applied custom block from the same schematic document',
    );

    const projectBeforeAgentBlock = JSON.parse(await readFile(path.resolve(projectRoot, 'project.circuit.json'), 'utf8'));
    const agentBlockResult = runSkill([
      'apply',
      '--project-root', projectRoot,
      '--command-json', JSON.stringify({
        schema: 'actoviq.command.v1',
        command_id: `playwright-agent-block-${Date.now()}`,
        actor: 'agent',
        project_id: projectId,
        base_revision: projectBeforeAgentBlock.revision,
        message: 'Agent adds a configurable control block',
        operations: [{
          op: 'add_component',
          module_id: 'filter',
          component: {
            id: 'agent_logic',
            type: 'BLOCK',
            name: 'U_AI',
            value: 'AI control block',
            position: { x: 720, y: 360 },
            rotation: 0,
            pins: [
              { id: 'sense', name: 'SENSE', net: 'out', side: 'left', order: 0 },
              { id: 'enable', name: 'EN', net: 'enable', side: 'left', order: 1 },
              { id: 'drive', name: 'DRIVE', net: 'drive', side: 'right', order: 0 },
              { id: 'vdd', name: 'VDD', net: 'vdd', side: 'top', order: 0 },
              { id: 'gnd', name: 'GND', net: '0', side: 'bottom', order: 0 },
            ],
            block: { width: 180, height: 140 },
          },
        }],
      }),
    ]);
    assert.equal(agentBlockResult.revision, projectBeforeAgentBlock.revision + 1);
    const agentBlockCompile = runSkill(['compile-module', '--project-root', projectRoot, '--module-id', 'filter']);
    assert.equal(agentBlockCompile.render.ok, true);
    await page.getByTestId('module-document-svg').locator(
      'g[data-component-id="agent_logic"] [data-symbol-kind="block"]',
    ).waitFor({ timeout: 30_000 });
    assert.equal(
      await page.getByTestId('module-document-svg').locator(
        'g[data-component-id="agent_logic"] [data-testid="schematic-block-pin-label"]',
      ).count(),
      5,
      'Agent-generated block did not render all requested pins',
    );
    agentModuleData = JSON.parse(await readFile(path.resolve(projectRoot, 'modules', 'filter', 'module.circuit.json'), 'utf8'));
    assert.equal(agentModuleData.components.find((component) => component.id === 'agent_logic')?.type, 'BLOCK');
    console.log('[e2e] svg tab verified');
    await page.getByTestId('back-to-board').click();
    await openModuleCard(page, 'filter');
    await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => (
      Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wire-count') ?? '0') >= 3 &&
      Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') ?? '0') >= 5
    ));
    assert.equal(await page.getByTestId('schematic-editor').getAttribute('data-schematic-source'), 'document');
    const reopenedFilterPositions = await componentPositions(page);
    const reopenedFilterPortPositions = await portPositions(page);
    const reopenedFilterWires = await editorWires(page);
    assertWiresOrthogonal(reopenedFilterWires, 'reopened editor wires should remain orthogonal');
    await assertRenderedWirePolylinesOrthogonal(page, 'after reopening editor');
    assertPositionEqual(
      reopenedFilterPositions.r1,
      savedR1?.position,
      'reopened editor did not preserve the applied Rtrim position',
    );
    assertPositionEqual(
      reopenedFilterPortPositions.input,
      savedPortPositions.input,
      'reopened editor did not preserve the moved IN port position',
    );
    assertPositionEqual(
      reopenedFilterPortPositions.output,
      savedPortPositions.output,
      'reopened editor did not preserve the moved OUT port position',
    );
    assert.ok(
      reopenedFilterWires.some((wire) => wire.id === drawnWire.id && wire.source === 'stored'),
      'reopened editor did not preserve the applied manually drawn wire as editable data',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator(
        `g[data-component-id="${manualBlock.id}"] [data-symbol-kind="block"], g[data-component-id="agent_logic"] [data-symbol-kind="block"]`,
      ).count(),
      2,
      'manual and Agent-generated blocks should both reopen as editable schematic components',
    );
    const reopenedRtrimPoint = await componentScreenPoint(page, 'r1');
    await page.mouse.click(reopenedRtrimPoint.x, reopenedRtrimPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:r1'
    ));
    assert.equal(await page.getByTestId('schematic-editor-component-name').inputValue(), 'Rtrim');
    assert.equal(await page.getByTestId('schematic-param-magnitude').inputValue(), '2k');
    await page.getByTestId('back-to-board').click();

  }
  if (shouldRun("legacy")) {
    await page.getByTestId(`sidebar-project-${legacyLdoProject.projectId}`).click();
    await waitForWorkbenchProject(page, legacyLdoProject.projectId);
    await page.getByTestId('circuit-workbench').getByText(legacyLdoProject.projectName, { exact: true }).waitFor();
    await openModuleCard(page, 'ldo');
    await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return Number(node?.getAttribute('data-component-count') ?? '0') >= 12 &&
        Number(node?.getAttribute('data-wire-count') ?? '0') >= 5 &&
        Number(node?.getAttribute('data-net-label-count') ?? '0') >= 10;
    });
    const ldoPositions = await componentPositions(page);
    assert.ok(ldoPositions.mp, 'hydrated LDO pass MOSFET is missing from editable schematic');
    assert.ok(await countVisibleSchematicComponents(page) >= 12, 'hydrated LDO components are not visibly drawn');
    assert.ok(await countVisibleSchematicWires(page) >= 5, 'hydrated LDO signal wires are not visibly drawn');
    assert.ok(
      Number(await page.getByTestId('schematic-editor').getAttribute('data-net-label-count')) >= 8,
      'hydrated LDO should render local power and ground labels',
    );
    assert.ok(
      await page.getByTestId('schematic-net-label').count() >= 8,
      'hydrated LDO local rail labels are not visibly drawn',
    );
    assert.ok(
      await page.locator('[data-testid="schematic-net-label"][data-kind="signal"]').count() >= 2,
      'hydrated LDO should render distant named internal nets as local signal labels',
    );
    const ldoWires = await editorWires(page);
    assertWiresOrthogonal(ldoWires, 'legacy LDO editor wires should remain orthogonal');
    assert.equal(ldoWires.some((wire) => wire.net === 'vin' || wire.net === '0'), false, 'LDO rail nets should not be rendered as long generated wires');
    assert.equal(
      ldoWires.some((wire) => ['fb', 'vref'].includes(wire.net)),
      false,
      'LDO distant named internal nets should be represented by local labels instead of long generated wires',
    );
    assert.ok(
      ldoWires.some((wire) => wire.net === 'tail'),
      'LDO nearby tail endpoints should be visibly connected by physical wires',
    );
    assert.ok(
      ldoWires.some((wire) => (
        wire.net === 'eaout' &&
        (wire.from?.component_id === 'mp' || wire.to?.component_id === 'mp') &&
        (wire.from?.pin_id === 'g' || wire.to?.pin_id === 'g')
      )),
      'LDO pass MOSFET gate should be visibly connected to EAOUT',
    );
    assert.ok(
      ldoPositions.mp.x > Math.max(ldoPositions.m1?.x ?? 0, ldoPositions.m2?.x ?? 0, ldoPositions.m3?.x ?? 0, ldoPositions.m4?.x ?? 0),
      'LDO pass MOSFET should be placed to the right of the error amplifier',
    );
    if (ldoPositions.rtop && ldoPositions.rbot) {
      assert.ok(Math.abs(ldoPositions.rtop.x - ldoPositions.rbot.x) <= 40, 'LDO feedback divider should be vertically aligned');
      assert.ok(ldoPositions.rtop.y < ldoPositions.rbot.y, 'LDO top feedback resistor should sit above bottom feedback resistor');
    }
    if (ldoPositions.cout && ldoPositions.rload) {
      assert.ok(ldoPositions.cout.x >= ldoPositions.mp.x, 'LDO output capacitor should be placed on the output side');
      assert.ok(ldoPositions.rload.x >= ldoPositions.mp.x, 'LDO load should be placed on the output side');
    }
    await waitForEditorIdle(page);
    await assertRenderedWirePolylinesOrthogonal(page, 'legacy LDO rendered wires');
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-ldo.png') });
    console.log('[e2e] legacy ldo loaded');
    await focusEditorByClickingCanvas(page);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.waitForFunction(() => (
      Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') ?? '0') >= 12
    ));
    const mpBodyPoint = await componentScreenPoint(page, 'mp');
    await page.mouse.move(mpBodyPoint.x, mpBodyPoint.y);
    await page.mouse.down();
    await page.mouse.move(mpBodyPoint.x - 90, mpBodyPoint.y - 45, { steps: 10 });
    await page.waitForFunction((previous) => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      const raw = node?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      const selectedCount = Number(node?.getAttribute('data-selected-component-count') ?? '0');
      if (selectedCount < 12) return false;
      if (!(Number(positions.mp?.x) !== Number(previous.mp.x) || Number(positions.mp?.y) !== Number(previous.mp.y))) {
        return false;
      }
      const dx = Number(positions.mp.x) - Number(previous.mp.x);
      const dy = Number(positions.mp.y) - Number(previous.mp.y);
      return Object.keys(previous).every((id) => (
        Math.abs(Number(positions[id]?.x) - (Number(previous[id]?.x) + dx)) < 0.5 &&
        Math.abs(Number(positions[id]?.y) - (Number(previous[id]?.y) + dy)) < 0.5
      ));
    }, ldoPositions);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForFunction((previous) => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      const raw = node?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return node?.getAttribute('data-selected') === '' &&
        Object.entries(previous).every(([id, point]) => (
          Number(positions[id]?.x) === Number(point.x) &&
          Number(positions[id]?.y) === Number(point.y)
        ));
    }, ldoPositions);
    assert.deepEqual(
      await componentPositions(page),
      ldoPositions,
      'cancelled direct body drag from a full LDO selection should restore schematic components',
    );
    console.log('[e2e] legacy ldo direct body drag isolated');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-busy') === 'false' &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-preview-busy') === 'false'
    ));
    await page.getByTestId('schematic-editor-rebuild-svg').click();
    await page.waitForFunction(() => {
      const editorNode = document.querySelector('[data-testid="schematic-editor"]');
      const text = document.body.textContent ?? '';
      return editorNode?.getAttribute('data-preview-busy') === 'true' || text.includes('Module SVG updated');
    });
    assert.equal(
      await page.getByTestId('schematic-editor').getAttribute('data-busy'),
      'false',
      'background netlistsvg build should not lock the editable schematic',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-select').isEnabled(),
      true,
      'select tool should remain available while background netlistsvg build runs',
    );
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-preview-busy') === 'false'
    ));
    const ldoWiresBeforeMpFrameDrag = await editorWires(page);
    await selectComponentForDrag(page, 'mp', [
      { x: 0, y: 0 },
      { x: -20, y: 0 },
      { x: 12, y: 0 },
      { x: 24, y: -24 },
    ]);
    const mpPoint = await selectedComponentFrameScreenPoint(page, 'mp');
    await page.mouse.move(mpPoint.x, mpPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grab'
    ));
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-busy') === 'false'
    ));
    await page.mouse.down();
    await page.mouse.move(mpPoint.x - 30, mpPoint.y - 20, { steps: 4 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
    ));
    await page.mouse.move(mpPoint.x - 130, mpPoint.y - 70, { steps: 14 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-drag-preview') === 'true'
    ));
    assertUnrelatedWireRoutesStable(
      ldoWiresBeforeMpFrameDrag,
      await editorWires(page),
      ['mp'],
      'frame dragging LDO MP',
    );
    await page.mouse.up();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
    ));
    const ldoPositionsAfterMpDrag = await componentPositions(page);
    assertPositionChanged(ldoPositionsAfterMpDrag.mp, ldoPositions.mp, 'dragging MP did not move MP');
    for (const id of ['m1', 'm2', 'm3', 'm4', 'rtop', 'rbot', 'rload', 'cout', 'vin', 'vref', 'itail']) {
      assertPositionEqual(ldoPositionsAfterMpDrag[id], ldoPositions[id], `dragging MP moved ${id}`);
    }
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-ldo-drag.png') });
    console.log('[e2e] legacy ldo drag isolated');

    await page.getByTestId(`sidebar-project-${legacyBjtResetProject.projectId}`).click();
    await waitForWorkbenchProject(page, legacyBjtResetProject.projectId);
    await page.getByTestId('circuit-workbench').getByText(legacyBjtResetProject.projectName, { exact: true }).waitFor();
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, 'reset');
    await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return node?.getAttribute('data-module-id') === 'reset' &&
        Number(node?.getAttribute('data-component-count') ?? '0') >= 7 &&
        Number(node?.getAttribute('data-wire-count') ?? '0') >= 4;
    });
    const bjtResetPorts = JSON.parse(
      await page.getByTestId('schematic-editor').getAttribute('data-ports') || '[]',
    );
    assert.ok(
      bjtResetPorts.some((port) => port.id === 'rst'),
      `hydrated BJT reset module lost RST port: ${JSON.stringify(bjtResetPorts)}`,
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="rst"]').getAttribute('data-port-side'),
      'left',
      'BJT reset RST input should render on the left edge',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="dtr"]').getAttribute('data-port-side'),
      'right',
      'BJT reset DTR input should render outside R51 on the right edge',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="rts"]').getAttribute('data-port-side'),
      'right',
      'BJT reset RTS output should render on the right edge',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="boot0"]').getAttribute('data-port-side'),
      'right',
      'BJT reset BOOT0 output should render outside R52',
    );
    const bjtResetPositions = await componentPositions(page);
    for (const id of ['q_boot', 'q_rst', 'd1', 'r50', 'r51', 'r49', 'r52']) {
      assert.ok(bjtResetPositions[id], `hydrated BJT reset component ${id} is missing from editable schematic`);
    }
    assert.ok(await countVisibleSchematicComponents(page) >= 7, 'hydrated BJT reset components are not visibly drawn');
    assert.ok(await countVisibleSchematicWires(page) >= 4, 'hydrated BJT reset signal wires are not visibly drawn');
    assertWiresOrthogonal(await editorWires(page), 'legacy BJT reset editor wires should remain orthogonal');
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-component-id="q_boot"] [data-symbol-kind="bjt"]').count(),
      1,
      'BJT reset transistor should use the refined BJT symbol body',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-component-id="d1"] [data-symbol-kind="diode"]').count(),
      1,
      'BJT reset diode should use the refined diode symbol body',
    );
    assert.equal(
      await page.getByTestId('schematic-component-name-label').first().getAttribute('font-size'),
      '17',
      'editable schematic component names should remain large enough to read after fit',
    );
    assert.equal(
      await page.getByTestId('schematic-component-value-label').first().getAttribute('font-size'),
      '15',
      'editable schematic component values should remain large enough to read after fit',
    );
    assert.equal(
      await page.getByTestId('schematic-net-label-text').first().getAttribute('font-size'),
      '16',
      'editable schematic net labels should remain prominent like an EDA editor',
    );
    const bjtEditorSvg = page.getByTestId('schematic-editor-svg');
    const bjtEditorComponentCount = await bjtEditorSvg.locator('g[data-component-id]').count();
    const bjtEditorWireCount = await bjtEditorSvg.locator('g[data-wire-id]').count();
    const bjtEditorNetLabelCount = await bjtEditorSvg.locator('[data-testid="schematic-net-label"]').count();
    assert.ok(bjtResetPositions.q_boot.x < bjtResetPositions.q_rst.x, 'BJT reset boot transistor should be left of reset transistor in GUI');
    assert.ok(bjtResetPositions.d1.x < bjtResetPositions.q_rst.x, 'BJT reset diode should feed reset transistor from the left in GUI');
    assert.ok(bjtResetPositions.r50.y < bjtResetPositions.q_rst.y, 'BJT reset pull-up should sit above reset transistor in GUI');
    assert.ok(bjtResetPositions.r51.x > bjtResetPositions.q_rst.x, 'BJT reset DTR resistor should sit on the output side in GUI');
    assert.ok(
      bjtResetPositions.r49.x > bjtResetPositions.q_boot.x && bjtResetPositions.r49.x < bjtResetPositions.q_rst.x,
      'BJT reset RTS resistor should bridge the two transistor stages in GUI',
    );
    assert.ok(bjtResetPositions.r52.y > bjtResetPositions.q_boot.y, 'BJT reset BOOT resistor should sit below boot transistor in GUI');
    await waitForEditorIdle(page);
    await assertRenderedWirePolylinesOrthogonal(page, 'legacy BJT reset rendered wires');
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-bjt-reset.png') });
    await page.getByTestId('schematic-svg-tab').click();
    await page.getByTestId('module-document-svg').waitFor({ timeout: 20_000 });
    assert.equal(await page.getByTestId('module-netlistsvg').getAttribute('data-schematic-source'), 'document');
    const bjtDocumentSvg = page.getByTestId('module-document-svg');
    assert.equal(
      await bjtDocumentSvg.locator('g[data-component-id]').count(),
      bjtEditorComponentCount,
      'BJT reset SVG preview should use the same component document as the editable schematic',
    );
    assert.equal(
      await bjtDocumentSvg.locator('g[data-wire-id]').count(),
      bjtEditorWireCount,
      'BJT reset SVG preview should use the same wire document as the editable schematic',
    );
    assert.equal(
      await bjtDocumentSvg.locator('[data-testid="schematic-net-label"]').count(),
      bjtEditorNetLabelCount,
      'BJT reset SVG preview should use the same net-label document as the editable schematic',
    );
    await page.getByTestId('schematic-editor-tab').click();
    await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
    console.log('[e2e] legacy bjt reset loaded');

    await page.getByTestId(`sidebar-project-${legacyVoltageDividerProject.projectId}`).click();
    await waitForWorkbenchProject(page, legacyVoltageDividerProject.projectId);
    await page.getByTestId('circuit-workbench').getByText(legacyVoltageDividerProject.projectName, { exact: true }).waitFor();
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, 'divider');
    await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return Number(node?.getAttribute('data-component-count') ?? '0') >= 3 &&
        Number(node?.getAttribute('data-wire-count') ?? '0') >= 3;
    });
    const dividerPositions = await componentPositions(page);
    for (const id of ['rtop', 'rbot', 'cflt']) {
      assert.ok(dividerPositions[id], `hydrated voltage divider component ${id} is missing from editable schematic`);
    }
    assert.ok(await countVisibleSchematicComponents(page) >= 3, 'hydrated voltage divider components are not visibly drawn');
    assert.ok(await countVisibleSchematicWires(page) >= 3, 'hydrated voltage divider wires are not visibly drawn');
    assertWiresOrthogonal(await editorWires(page), 'legacy voltage divider editor wires should remain orthogonal');
    assert.ok(
      Math.abs(dividerPositions.rtop.x - dividerPositions.rbot.x) <= schematicGrid,
      'voltage divider resistors should align vertically in GUI',
    );
    assert.ok(dividerPositions.rtop.y < dividerPositions.rbot.y, 'voltage divider top resistor should sit above bottom resistor in GUI');
    assert.ok(dividerPositions.cflt.x > dividerPositions.rbot.x, 'voltage divider shunt capacitor should sit beside the divider in GUI');
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="output"]').getAttribute('data-port-side'),
      'right',
      'voltage divider output should render on the right edge',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="gnd"]').count(),
      0,
      'voltage divider ground rail should render as a local label instead of a duplicate floating port',
    );
    await waitForEditorIdle(page);
    await assertRenderedWirePolylinesOrthogonal(page, 'legacy voltage divider rendered wires');
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-voltage-divider.png') });
    console.log('[e2e] legacy voltage divider loaded');

    await page.getByTestId(`sidebar-project-${legacyMosAmplifierProject.projectId}`).click();
    await waitForWorkbenchProject(page, legacyMosAmplifierProject.projectId);
    await page.getByTestId('circuit-workbench').getByText(legacyMosAmplifierProject.projectName, { exact: true }).waitFor();
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, 'mosamp');
    await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return Number(node?.getAttribute('data-component-count') ?? '0') >= 9 &&
        Number(node?.getAttribute('data-wire-count') ?? '0') >= 7;
    });
    const mosAmpPositions = await componentPositions(page);
    for (const id of ['cin', 'rg1', 'rg2', 'm1', 'rd', 'rs', 'cs', 'cout', 'rload']) {
      assert.ok(mosAmpPositions[id], `hydrated MOS amplifier component ${id} is missing from editable schematic`);
    }
    assert.ok(await countVisibleSchematicComponents(page) >= 9, 'hydrated MOS amplifier components are not visibly drawn');
    assert.ok(await countVisibleSchematicWires(page) >= 7, 'hydrated MOS amplifier wires are not visibly drawn');
    const mosAmpWires = await editorWires(page);
    assertWiresOrthogonal(mosAmpWires, 'legacy MOS amplifier editor wires should remain orthogonal');
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-component-id="m1"] [data-symbol-kind="mosfet"]').count(),
      1,
      'MOS amplifier transistor should use the refined MOSFET symbol body',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-component-id="m1"] [data-symbol-polarity="nmos"]').count(),
      1,
      'MOS amplifier transistor should expose NMOS polarity for symbol rendering',
    );
    const nmosSymbol = page.getByTestId('schematic-editor-svg').locator(
      'g[data-component-id="m1"] [data-symbol-kind="mosfet"]',
    );
    assert.equal(await nmosSymbol.getAttribute('data-mos-body'), 'separate');
    assert.equal(await nmosSymbol.getAttribute('data-mos-arrow'), 'in');
    assert.equal(await nmosSymbol.getByTestId('schematic-mos-outline').count(), 1);
    assert.equal(await nmosSymbol.getByTestId('schematic-mos-arrow').count(), 1);
    assert.equal(
      await nmosSymbol.locator('[data-testid="schematic-mos-gate-bubble"]').count(),
      0,
      'NMOS gate should not have a BJT-style polarity bubble',
    );
    assert.ok(mosAmpPositions.cin.x < mosAmpPositions.m1.x, 'MOS amplifier input capacitor should sit left of M1 in GUI');
    assert.ok(mosAmpPositions.rg1.y < mosAmpPositions.m1.y, 'MOS amplifier gate pull-up should sit above M1 in GUI');
    assert.ok(mosAmpPositions.rg2.y > mosAmpPositions.m1.y, 'MOS amplifier gate pull-down should sit below M1 in GUI');
    assert.ok(mosAmpPositions.rd.y < mosAmpPositions.m1.y, 'MOS amplifier drain load should sit above M1 in GUI');
    assert.ok(mosAmpPositions.rs.y > mosAmpPositions.m1.y, 'MOS amplifier source resistor should sit below M1 in GUI');
    assert.ok(mosAmpPositions.cs.y > mosAmpPositions.m1.y, 'MOS amplifier source bypass should sit below M1 in GUI');
    assert.ok(mosAmpPositions.cout.x > mosAmpPositions.m1.x, 'MOS amplifier output capacitor should sit right of M1 in GUI');
    assert.ok(mosAmpPositions.rload.x > mosAmpPositions.cout.x, 'MOS amplifier output load should sit beyond the output capacitor in GUI');
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="input"]').getAttribute('data-port-side'),
      'left',
      'MOS amplifier input should render on the left edge',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="output"]').getAttribute('data-port-side'),
      'right',
      'MOS amplifier output should render on the right edge',
    );
    await waitForEditorIdle(page);
    await assertRenderedWirePolylinesOrthogonal(page, 'legacy MOS amplifier rendered wires');
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-mos-amplifier.png') });
    console.log('[e2e] legacy mos amplifier loaded');
    await focusEditorByClickingCanvas(page);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.waitForFunction(() => (
      Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') ?? '0') >= 9
    ));
    await selectComponentForDrag(page, 'm1', [
      { x: 0, y: 0 },
      { x: -18, y: 0 },
      { x: 12, y: 18 },
      { x: 26, y: -18 },
    ]);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:m1' &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected-component-count') === '1'
    ));
    const mosAmpM1DragPoint = await selectedComponentFrameScreenPoint(page, 'm1');
    await page.mouse.move(mosAmpM1DragPoint.x, mosAmpM1DragPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grab'
    ));
    await page.mouse.down();
    await page.mouse.move(mosAmpM1DragPoint.x + 30, mosAmpM1DragPoint.y - 20, { steps: 4 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
    ));
    await page.mouse.move(mosAmpM1DragPoint.x + 110, mosAmpM1DragPoint.y - 40, { steps: 12 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-drag-preview') === 'true'
    ));
    assertUnrelatedWireRoutesStable(
      mosAmpWires,
      await editorWires(page),
      ['m1'],
      'dragging MOS amplifier M1',
    );
    await assertRenderedWirePolylinesOrthogonal(page, 'while dragging MOS amplifier M1');
    await assertWireEndpointsMatchComponentPins(page, 'm1', 'dragging MOS amplifier M1 should keep endpoints on moving pins');
    await page.mouse.up();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
    ));
    const mosAmpPositionsAfterM1Drag = await componentPositions(page);
    assertPositionChanged(mosAmpPositionsAfterM1Drag.m1, mosAmpPositions.m1, 'dragging MOS amplifier M1 did not move M1');
    for (const id of ['cin', 'rg1', 'rg2', 'rd', 'rs', 'cs', 'cout', 'rload']) {
      assertPositionEqual(mosAmpPositionsAfterM1Drag[id], mosAmpPositions[id], `dragging MOS amplifier M1 moved ${id}`);
    }
    assertWiresOrthogonal(await editorWires(page), 'committed MOS amplifier M1 drag should keep wires orthogonal');
    await assertRenderedWirePolylinesOrthogonal(page, 'after committing MOS amplifier M1 drag');
    await assertWireEndpointsMatchComponentPins(page, 'm1', 'committed MOS amplifier M1 drag should keep wire endpoints on moving pins');
    assert.equal(
      await page.evaluate(() => {
        const wires = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]');
        const nets = new Set(wires.map((wire) => wire.net).filter(Boolean));
        const labeled = [...document.querySelectorAll('[data-testid="schematic-net-label"][data-kind="signal"]')]
          .map((node) => node.getAttribute('data-net'))
          .filter(Boolean);
        return labeled.filter((net) => nets.has(net)).length;
      }),
      0,
      'committed MOS amplifier M1 drag must not replace still-wired nets with floating signal labels',
    );
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-mos-amplifier-drag.png') });
    console.log('[e2e] legacy mos amplifier drag isolated');

    await page.getByTestId(`sidebar-project-${legacyCmosInverterProject.projectId}`).click();
    await waitForWorkbenchProject(page, legacyCmosInverterProject.projectId);
    await page.getByTestId('circuit-workbench').getByText(legacyCmosInverterProject.projectName, { exact: true }).waitFor();
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, 'inverter');
    await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return Number(node?.getAttribute('data-component-count') ?? '0') >= 3 &&
        Number(node?.getAttribute('data-wire-count') ?? '0') >= 3;
    });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-preview-busy') === 'false'
    ));
    const cmosInverterPositions = await componentPositions(page);
    for (const id of ['mp1', 'mn1', 'cload']) {
      assert.ok(cmosInverterPositions[id], `hydrated CMOS inverter component ${id} is missing from editable schematic`);
    }
    assert.ok(await countVisibleSchematicComponents(page) >= 3, 'hydrated CMOS inverter components are not visibly drawn');
    assert.ok(await countVisibleSchematicWires(page) >= 3, 'hydrated CMOS inverter wires are not visibly drawn');
    const cmosInverterWires = await editorWires(page);
    assertWiresOrthogonal(cmosInverterWires, 'legacy CMOS inverter editor wires should remain orthogonal');
    assert.ok(cmosInverterPositions.mp1.y < cmosInverterPositions.mn1.y, 'CMOS inverter PMOS should sit above NMOS in GUI');
    assert.ok(
      Math.abs(cmosInverterPositions.mp1.x - cmosInverterPositions.mn1.x) <= schematicGrid,
      'CMOS inverter devices should share the output column in GUI',
    );
    assert.ok(cmosInverterPositions.cload.x > cmosInverterPositions.mn1.x, 'CMOS inverter load should sit on the output side in GUI');
    const pmosSymbol = page.getByTestId('schematic-editor-svg').locator(
      'g[data-component-id="mp1"] [data-symbol-kind="mosfet"]',
    );
    assert.equal(await pmosSymbol.getAttribute('data-symbol-polarity'), 'pmos');
    assert.equal(await pmosSymbol.getAttribute('data-mos-body'), 'separate');
    assert.equal(await pmosSymbol.getAttribute('data-mos-arrow'), 'out');
    assert.equal(await pmosSymbol.getByTestId('schematic-mos-outline').count(), 1);
    assert.equal(
      await pmosSymbol.locator('[data-testid="schematic-mos-gate-bubble"]').count(),
      0,
      'PMOS gate should use the IEEE/KiCad arrow convention instead of a gate bubble',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="input"]').getAttribute('data-port-side'),
      'left',
      'CMOS inverter input should render on the left edge',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="output"]').getAttribute('data-port-side'),
      'right',
      'CMOS inverter output should render on the right edge',
    );
    await waitForEditorIdle(page);
    await assertRenderedWirePolylinesOrthogonal(page, 'legacy CMOS inverter rendered wires');
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-cmos-inverter.png') });
    console.log('[e2e] legacy cmos inverter loaded');
    await selectComponentForDrag(page, 'mp1', [
      { x: 0, y: 0 },
      { x: -20, y: 0 },
      { x: 12, y: 18 },
      { x: 24, y: -18 },
    ]);
    const cmosMpDragPoint = await selectedComponentFrameScreenPoint(page, 'mp1');
    await page.mouse.move(cmosMpDragPoint.x, cmosMpDragPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grab'
    ));
    await page.mouse.down();
    await page.mouse.move(cmosMpDragPoint.x - 25, cmosMpDragPoint.y - 15, { steps: 4 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
    ));
    await page.mouse.move(cmosMpDragPoint.x - 90, cmosMpDragPoint.y - 60, { steps: 10 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-drag-preview') === 'true'
    ));
    assertUnrelatedWireRoutesStable(
      cmosInverterWires,
      await editorWires(page),
      ['mp1'],
      'dragging CMOS inverter MP1',
    );
    await page.mouse.up();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
    ));
    const cmosPositionsAfterMpDrag = await componentPositions(page);
    assertPositionChanged(cmosPositionsAfterMpDrag.mp1, cmosInverterPositions.mp1, 'dragging CMOS inverter MP1 did not move MP1');
    for (const id of ['mn1', 'cload']) {
      assertPositionEqual(cmosPositionsAfterMpDrag[id], cmosInverterPositions[id], `dragging CMOS inverter MP1 moved ${id}`);
    }
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-cmos-inverter-drag.png') });
    console.log('[e2e] legacy cmos inverter drag isolated');

    await page.getByTestId(`sidebar-project-${legacyCmosRingProject.projectId}`).click();
    await waitForWorkbenchProject(page, legacyCmosRingProject.projectId);
    await page.getByTestId('circuit-workbench').getByText(legacyCmosRingProject.projectName, { exact: true }).waitFor();
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, 'ring');
    await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return Number(node?.getAttribute('data-component-count') ?? '0') >= 12 &&
        Number(node?.getAttribute('data-wire-count') ?? '0') >= 15;
    });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-preview-busy') === 'false'
    ));
    const ringPositions = await componentPositions(page);
    const ringComponentIds = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'c1', 'c2', 'c3', 'rleak1', 'rleak2', 'rleak3'];
    for (const id of ringComponentIds) {
      assert.ok(ringPositions[id], `hydrated CMOS ring component ${id} is missing from editable schematic`);
    }
    assert.ok(await countVisibleSchematicComponents(page) >= 12, 'hydrated CMOS ring components are not visibly drawn');
    assert.ok(await countVisibleSchematicWires(page) >= 15, 'hydrated CMOS ring wires are not visibly drawn');
    const ringWires = await editorWires(page);
    assertWiresOrthogonal(ringWires, 'legacy CMOS ring editor wires should remain orthogonal');
    for (const [pmosId, nmosId] of [['m2', 'm1'], ['m4', 'm3'], ['m6', 'm5']]) {
      assert.ok(ringPositions[pmosId].y < ringPositions[nmosId].y, `${pmosId}/${nmosId} PMOS should sit above NMOS in GUI`);
      assert.ok(
        Math.abs(ringPositions[pmosId].x - ringPositions[nmosId].x) <= schematicGrid,
        `${pmosId}/${nmosId} should share a stage column in GUI`,
      );
    }
    assert.ok(ringPositions.m2.x < ringPositions.m4.x && ringPositions.m4.x < ringPositions.m6.x, 'CMOS ring stages should progress left to right');
    for (const id of ['c1', 'c2', 'c3', 'rleak1', 'rleak2', 'rleak3']) {
      assert.ok(ringPositions[id].y > ringPositions.m1.y, `${id} should sit below the CMOS ring stages in GUI`);
    }
    for (const net of ['n1', 'n2', 'n3']) {
      assert.ok(ringWires.filter((wire) => wire.net === net).length >= 5, `CMOS ring ${net} should use physical editable wires`);
      assert.equal(
        await page.locator(`[data-testid="schematic-net-label"][data-net="${net}"]`).count(),
        0,
        `CMOS ring ${net} should not be replaced by local labels`,
      );
    }
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="output"]').getAttribute('data-port-side'),
      'right',
      'CMOS ring output should render on the right edge',
    );
    await waitForEditorIdle(page);
    await assertRenderedWirePolylinesOrthogonal(page, 'legacy CMOS ring rendered wires');
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-cmos-ring.png') });
    console.log('[e2e] legacy cmos ring loaded');
    await selectComponentForDrag(page, 'm4', [
      { x: 0, y: 0 },
      { x: -20, y: 0 },
      { x: 12, y: 18 },
      { x: 24, y: -18 },
    ]);
    const ringM4DragPoint = await selectedComponentFrameScreenPoint(page, 'm4');
    await page.mouse.move(ringM4DragPoint.x, ringM4DragPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grab'
    ));
    await page.mouse.down();
    await page.mouse.move(ringM4DragPoint.x - 20, ringM4DragPoint.y - 15, { steps: 4 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
    ));
    await page.mouse.move(ringM4DragPoint.x - 90, ringM4DragPoint.y - 55, { steps: 10 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-drag-preview') === 'true'
    ));
    assertUnrelatedWireRoutesStable(
      ringWires,
      await editorWires(page),
      ['m4'],
      'dragging CMOS ring M4',
    );
    await page.mouse.up();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
    ));
    const ringPositionsAfterM4Drag = await componentPositions(page);
    assertPositionChanged(ringPositionsAfterM4Drag.m4, ringPositions.m4, 'dragging CMOS ring M4 did not move M4');
    for (const id of ringComponentIds.filter((componentId) => componentId !== 'm4')) {
      assertPositionEqual(ringPositionsAfterM4Drag[id], ringPositions[id], `dragging CMOS ring M4 moved ${id}`);
    }
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-cmos-ring-drag.png') });
    console.log('[e2e] legacy cmos ring drag isolated');

    await page.getByTestId(`sidebar-project-${legacyDifferentialPairProject.projectId}`).click();
    await waitForWorkbenchProject(page, legacyDifferentialPairProject.projectId);
    await page.getByTestId('circuit-workbench').getByText(legacyDifferentialPairProject.projectName, { exact: true }).waitFor();
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, 'diffpair');
    await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return Number(node?.getAttribute('data-component-count') ?? '0') >= 5 &&
        Number(node?.getAttribute('data-wire-count') ?? '0') >= 5;
    });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-preview-busy') === 'false'
    ));
    const diffPairPositions = await componentPositions(page);
    for (const id of ['m_inp', 'm_inn', 'rdp', 'rdn', 'itail']) {
      assert.ok(diffPairPositions[id], `hydrated differential pair component ${id} is missing from editable schematic`);
    }
    assert.ok(await countVisibleSchematicComponents(page) >= 5, 'hydrated differential pair components are not visibly drawn');
    assert.ok(await countVisibleSchematicWires(page) >= 5, 'hydrated differential pair wires are not visibly drawn');
    const diffPairWires = await editorWires(page);
    assertWiresOrthogonal(diffPairWires, 'legacy differential pair editor wires should remain orthogonal');
    assert.ok(diffPairPositions.m_inp.x < diffPairPositions.m_inn.x, 'differential pair IN+ device should sit left of IN- device in GUI');
    assert.ok(
      Math.abs(diffPairPositions.m_inp.y - diffPairPositions.m_inn.y) <= schematicGrid,
      'differential pair input devices should align horizontally in GUI',
    );
    assert.ok(diffPairPositions.rdp.y < diffPairPositions.m_inp.y, 'differential pair left load should sit above M_INP in GUI');
    assert.ok(diffPairPositions.rdn.y < diffPairPositions.m_inn.y, 'differential pair right load should sit above M_INN in GUI');
    assert.ok(diffPairPositions.itail.y > diffPairPositions.m_inp.y, 'differential pair tail current source should sit below the pair in GUI');
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="inp"]').getAttribute('data-port-side'),
      'left',
      'differential pair IN+ should render on the gate side of M_INP',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="inn"]').getAttribute('data-port-side'),
      'left',
      'differential pair IN- should render on the gate side of M_INN, not across the MOS body',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="outp"]').getAttribute('data-port-side'),
      'right',
      'differential pair OUT+ should render on the right side of its local branch',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="outn"]').getAttribute('data-port-side'),
      'right',
      'differential pair OUT- should render on the right edge',
    );
    const differentialOutputPorts = await page.getByTestId('schematic-editor-svg').evaluate(() => {
      const outp = document.querySelector('g[data-port-id="outp"]');
      const outn = document.querySelector('g[data-port-id="outn"]');
      const inp = document.querySelector('g[data-port-id="inp"]');
      const inn = document.querySelector('g[data-port-id="inn"]');
      if (
        !(outp instanceof SVGGraphicsElement) ||
        !(outn instanceof SVGGraphicsElement) ||
        !(inp instanceof SVGGraphicsElement) ||
        !(inn instanceof SVGGraphicsElement)
      ) {
        throw new Error('differential pair port SVG groups are missing');
      }
      const outpBox = outp.getBBox();
      const outnBox = outn.getBBox();
      const inpBox = inp.getBBox();
      const innBox = inn.getBBox();
      return {
        inpCenterX: inpBox.x + inpBox.width / 2,
        innCenterX: innBox.x + innBox.width / 2,
        outpCenterX: outpBox.x + outpBox.width / 2,
        outnCenterX: outnBox.x + outnBox.width / 2,
        centerGapY: Math.abs((outpBox.y + outpBox.height / 2) - (outnBox.y + outnBox.height / 2)),
        outputMaxY: Math.max(outpBox.y + outpBox.height / 2, outnBox.y + outnBox.height / 2),
        innCenterY: innBox.y + innBox.height / 2,
      };
    });
    assert.ok(
      differentialOutputPorts.inpCenterX < diffPairPositions.m_inp.x - 52,
      'differential pair IN+ should sit outside the left input gate in GUI',
    );
    assert.ok(
      differentialOutputPorts.innCenterX < diffPairPositions.m_inn.x - 52,
      'differential pair IN- should sit outside the right input gate in GUI',
    );
    assert.ok(
      differentialOutputPorts.outpCenterX > diffPairPositions.m_inp.x + 52 &&
        differentialOutputPorts.outpCenterX < diffPairPositions.m_inn.x - 52,
      'differential pair OUT+ should stay local to the positive-output branch instead of crossing the whole pair',
    );
    assert.ok(
      differentialOutputPorts.outnCenterX > diffPairPositions.m_inn.x + 52,
      'differential pair OUT- should render outside the right device',
    );
    assert.ok(
      differentialOutputPorts.centerGapY >= schematicGrid * 2,
      'differential pair output ports should be visibly separated on the output side',
    );
    assert.ok(
      differentialOutputPorts.outputMaxY < differentialOutputPorts.innCenterY,
      'differential pair output ports should stay above the right-side input port in GUI',
    );
    await waitForEditorIdle(page);
    await assertRenderedWirePolylinesOrthogonal(page, 'legacy differential pair rendered wires');
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-differential-pair.png') });
    console.log('[e2e] legacy differential pair loaded');
    await selectComponentForDrag(page, 'm_inp', [
      { x: 0, y: 0 },
      { x: -20, y: 0 },
      { x: 12, y: 18 },
      { x: 24, y: -18 },
    ]);
    const diffPairMInpDragPoint = await selectedComponentFrameScreenPoint(page, 'm_inp');
    await page.mouse.move(diffPairMInpDragPoint.x, diffPairMInpDragPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grab'
    ));
    await page.mouse.down();
    await page.mouse.move(diffPairMInpDragPoint.x - 20, diffPairMInpDragPoint.y + 15, { steps: 4 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
    ));
    await page.mouse.move(diffPairMInpDragPoint.x - 100, diffPairMInpDragPoint.y + 55, { steps: 10 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-drag-preview') === 'true'
    ));
    assertUnrelatedWireRoutesStable(
      diffPairWires,
      await editorWires(page),
      ['m_inp'],
      'dragging differential pair M_INP',
    );
    await page.mouse.up();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
    ));
    const diffPairPositionsAfterMInpDrag = await componentPositions(page);
    assertPositionChanged(diffPairPositionsAfterMInpDrag.m_inp, diffPairPositions.m_inp, 'dragging differential pair M_INP did not move M_INP');
    for (const id of ['m_inn', 'rdp', 'rdn', 'itail']) {
      assertPositionEqual(diffPairPositionsAfterMInpDrag[id], diffPairPositions[id], `dragging differential pair M_INP moved ${id}`);
    }
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-differential-pair-drag.png') });
    console.log('[e2e] legacy differential pair drag isolated');

    await page.getByTestId(`sidebar-project-${legacyCurrentMirrorProject.projectId}`).click();
    await waitForWorkbenchProject(page, legacyCurrentMirrorProject.projectId);
    await page.getByTestId('circuit-workbench').getByText(legacyCurrentMirrorProject.projectName, { exact: true }).waitFor();
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, 'mirror');
    await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return Number(node?.getAttribute('data-component-count') ?? '0') >= 4 &&
        Number(node?.getAttribute('data-wire-count') ?? '0') >= 3;
    });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-preview-busy') === 'false'
    ));
    const currentMirrorPositions = await componentPositions(page);
    for (const id of ['mref', 'mout', 'iref', 'rload']) {
      assert.ok(currentMirrorPositions[id], `hydrated current mirror component ${id} is missing from editable schematic`);
    }
    assert.ok(await countVisibleSchematicComponents(page) >= 4, 'hydrated current mirror components are not visibly drawn');
    assert.ok(await countVisibleSchematicWires(page) >= 3, 'hydrated current mirror wires are not visibly drawn');
    const currentMirrorWires = await editorWires(page);
    assertWiresOrthogonal(currentMirrorWires, 'legacy current mirror editor wires should remain orthogonal');
    const currentMirrorBiasWires = currentMirrorWires.filter((wire) => wire.net === 'bias');
    assert.ok(currentMirrorBiasWires.length >= 3, 'current mirror bias net should render physical editable wires');
    assert.ok(
      currentMirrorBiasWires.every((wire) => wire.from?.component_id === 'mref' && wire.from?.pin_id === 'd'),
      'current mirror bias wires should originate at the diode-connected MREF drain in GUI',
    );
    assert.ok(
      currentMirrorBiasWires.some((wire) => wire.to?.component_id === 'mref' && wire.to?.pin_id === 'g'),
      'current mirror should visibly short MREF drain to gate in GUI',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-component-id="mref"] [data-symbol-kind="mosfet"]').count(),
      1,
      'current mirror reference transistor should use the refined MOSFET symbol body',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-component-id="mout"] [data-symbol-polarity="nmos"]').count(),
      1,
      'current mirror output transistor should expose NMOS polarity for symbol rendering',
    );
    assert.ok(currentMirrorPositions.mref.x < currentMirrorPositions.mout.x, 'current mirror reference device should sit left of output device in GUI');
    assert.ok(currentMirrorPositions.iref.y < currentMirrorPositions.mref.y, 'current mirror reference source should sit above MREF in GUI');
    assert.ok(currentMirrorPositions.rload.y < currentMirrorPositions.mout.y, 'current mirror output load should sit above MOUT in GUI');
    assert.ok(
      Math.abs(currentMirrorPositions.iref.x - currentMirrorPositions.mref.x) <= schematicGrid * 2,
      'current mirror IREF should align with the reference drain in GUI',
    );
    assert.ok(
      Math.abs(currentMirrorPositions.rload.x - currentMirrorPositions.mout.x) <= schematicGrid * 2,
      'current mirror RLOAD should align with the output drain in GUI',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="output"]').getAttribute('data-port-side'),
      'right',
      'current mirror OUT should render on the right edge',
    );
    await waitForEditorIdle(page);
    await assertRenderedWirePolylinesOrthogonal(page, 'legacy current mirror rendered wires');
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-current-mirror.png') });
    console.log('[e2e] legacy current mirror loaded');
    await selectComponentForDrag(page, 'mref', [
      { x: 0, y: 0 },
      { x: -20, y: 0 },
      { x: 12, y: 18 },
      { x: 24, y: -18 },
    ]);
    const currentMirrorMrefDragPoint = await selectedComponentFrameScreenPoint(page, 'mref');
    await page.mouse.move(currentMirrorMrefDragPoint.x, currentMirrorMrefDragPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grab'
    ));
    await page.mouse.down();
    await page.mouse.move(currentMirrorMrefDragPoint.x - 20, currentMirrorMrefDragPoint.y + 15, { steps: 4 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
    ));
    await page.mouse.move(currentMirrorMrefDragPoint.x - 90, currentMirrorMrefDragPoint.y + 45, { steps: 10 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-drag-preview') === 'true'
    ));
    assertUnrelatedWireRoutesStable(
      currentMirrorWires,
      await editorWires(page),
      ['mref'],
      'dragging current mirror MREF',
    );
    await assertRenderedWirePolylinesOrthogonal(page, 'while dragging current mirror MREF');
    await page.mouse.up();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
    ));
    const currentMirrorPositionsAfterMrefDrag = await componentPositions(page);
    assertPositionChanged(currentMirrorPositionsAfterMrefDrag.mref, currentMirrorPositions.mref, 'dragging current mirror MREF did not move MREF');
    for (const id of ['mout', 'iref', 'rload']) {
      assertPositionEqual(currentMirrorPositionsAfterMrefDrag[id], currentMirrorPositions[id], `dragging current mirror MREF moved ${id}`);
    }
    assertWiresOrthogonal(await editorWires(page), 'committed current mirror MREF drag should keep wires orthogonal');
    await assertRenderedWirePolylinesOrthogonal(page, 'after committing current mirror MREF drag');
    await assertWireEndpointsMatchComponentPins(page, 'mref', 'committed current mirror MREF drag should keep endpoints on moving pins');
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-current-mirror-drag.png') });
    console.log('[e2e] legacy current mirror drag isolated');

    await page.getByTestId(`sidebar-project-${legacyOpampFeedbackProject.projectId}`).click();
    await waitForWorkbenchProject(page, legacyOpampFeedbackProject.projectId);
    await page.getByTestId('circuit-workbench').getByText(legacyOpampFeedbackProject.projectName, { exact: true }).waitFor();
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, 'opamp');
    await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return Number(node?.getAttribute('data-component-count') ?? '0') >= 7 &&
        Number(node?.getAttribute('data-wire-count') ?? '0') >= 4;
    });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-preview-busy') === 'false'
    ));
    const opampPositions = await componentPositions(page);
    for (const id of ['eopamp', 'vin', 'vsupply', 'r2f', 'r1f', 'cload', 'rload']) {
      assert.ok(opampPositions[id], `hydrated opamp feedback component ${id} is missing from editable schematic`);
    }
    assert.ok(await countVisibleSchematicComponents(page) >= 7, 'hydrated opamp feedback components are not visibly drawn');
    assert.ok(await countVisibleSchematicWires(page) >= 4, 'hydrated opamp feedback wires are not visibly drawn');
    const opampWires = await editorWires(page);
    assertWiresOrthogonal(opampWires, 'legacy opamp feedback editor wires should remain orthogonal');
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-component-id="eopamp"] [data-symbol-kind="opamp"]').count(),
      1,
      'opamp feedback amplifier should use the opamp triangle symbol body',
    );
    assert.ok(opampPositions.r2f.y < opampPositions.eopamp.y, 'opamp feedback resistor should sit above the amplifier in GUI');
    assert.ok(opampPositions.r1f.x < opampPositions.eopamp.x, 'opamp lower feedback resistor should sit beside the inverting input in GUI');
    assert.ok(opampPositions.cload.x > opampPositions.eopamp.x, 'opamp output capacitor should sit on the output side in GUI');
    assert.ok(opampPositions.rload.x > opampPositions.eopamp.x, 'opamp output load should sit on the output side in GUI');
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="input"]').getAttribute('data-port-side'),
      'left',
      'opamp feedback input should render on the left edge',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="output"]').getAttribute('data-port-side'),
      'right',
      'opamp feedback output should render on the right edge',
    );
    await waitForEditorIdle(page);
    await assertRenderedWirePolylinesOrthogonal(page, 'legacy opamp feedback rendered wires');
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-opamp-feedback.png') });
    console.log('[e2e] legacy opamp feedback loaded');
    await selectComponentForDrag(page, 'eopamp', [
      { x: 0, y: 0 },
      { x: -18, y: 0 },
      { x: 20, y: 0 },
    ]);
    const opampDragPoint = await selectedComponentFrameScreenPoint(page, 'eopamp');
    await page.mouse.move(opampDragPoint.x, opampDragPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grab'
    ));
    await page.mouse.down();
    await page.mouse.move(opampDragPoint.x + 25, opampDragPoint.y - 15, { steps: 4 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
    ));
    await page.mouse.move(opampDragPoint.x + 95, opampDragPoint.y - 45, { steps: 10 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-drag-preview') === 'true'
    ));
    assertUnrelatedWireRoutesStable(
      opampWires,
      await editorWires(page),
      ['eopamp'],
      'dragging opamp feedback EOPAMP',
    );
    await page.mouse.up();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
    ));
    const opampPositionsAfterDrag = await componentPositions(page);
    assertPositionChanged(opampPositionsAfterDrag.eopamp, opampPositions.eopamp, 'dragging opamp EOPAMP did not move EOPAMP');
    for (const id of ['vin', 'vsupply', 'r2f', 'r1f', 'cload', 'rload']) {
      assertPositionEqual(opampPositionsAfterDrag[id], opampPositions[id], `dragging opamp EOPAMP moved ${id}`);
    }
    await assertWireEndpointsMatchComponentPins(page, 'eopamp', 'committed opamp EOPAMP drag should keep endpoints on moving pins');
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-opamp-feedback-drag.png') });
    console.log('[e2e] legacy opamp feedback drag isolated');

    await page.getByTestId(`sidebar-project-${legacyCascodeProject.projectId}`).click();
    await waitForWorkbenchProject(page, legacyCascodeProject.projectId);
    await page.getByTestId('circuit-workbench').getByText(legacyCascodeProject.projectName, { exact: true }).waitFor();
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, 'cascode');
    await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return Number(node?.getAttribute('data-component-count') ?? '0') >= 13 &&
        Number(node?.getAttribute('data-wire-count') ?? '0') >= 8;
    });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-preview-busy') === 'false'
    ));
    const cascodePositions = await componentPositions(page);
    for (const id of ['m1', 'm2', 'rl', 'rs', 'cint', 'ccomp', 'rout', 'cload', 'rprobe']) {
      assert.ok(cascodePositions[id], `hydrated cascode component ${id} is missing from editable schematic`);
    }
    assert.ok(await countVisibleSchematicComponents(page) >= 13, 'hydrated cascode components are not visibly drawn');
    assert.ok(await countVisibleSchematicWires(page) >= 8, 'hydrated cascode wires are not visibly drawn');
    const cascodeWires = await editorWires(page);
    assertWiresOrthogonal(cascodeWires, 'legacy cascode editor wires should remain orthogonal');
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-component-id="m1"] [data-symbol-kind="mosfet"]').count(),
      1,
      'cascode lower transistor should use the refined MOSFET symbol body',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-component-id="m2"] [data-symbol-polarity="nmos"]').count(),
      1,
      'cascode upper transistor should expose NMOS polarity for symbol rendering',
    );
    assert.ok(cascodePositions.m2.y < cascodePositions.m1.y, 'cascode upper MOSFET should sit above lower MOSFET in GUI');
    assert.ok(
      Math.abs(cascodePositions.m2.x - cascodePositions.m1.x) <= schematicGrid,
      'cascode MOSFETs should share the stack column in GUI',
    );
    assert.ok(cascodePositions.rl.y < cascodePositions.m2.y, 'cascode drain load should sit above upper MOSFET in GUI');
    assert.ok(cascodePositions.rs.y > cascodePositions.m1.y, 'cascode source resistor should sit below lower MOSFET in GUI');
    assert.ok(
      cascodePositions.ccomp.y > cascodePositions.m2.y && cascodePositions.ccomp.y < cascodePositions.m1.y,
      'cascode compensation capacitor should sit between the cascode devices in GUI',
    );
    assert.ok(cascodePositions.rout.x > cascodePositions.m2.x, 'cascode output resistor should sit to the right of the stack in GUI');
    assert.ok(cascodePositions.cload.x > cascodePositions.rout.x, 'cascode output capacitor should sit beyond output resistor in GUI');
    assert.ok(cascodePositions.rprobe.x > cascodePositions.rout.x, 'cascode output probe should sit beyond output resistor in GUI');
    assert.ok(
      cascodeWires.filter((wire) => wire.net === 'no').length >= 3,
      'cascode output drain net should render as physical editable wires',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="input"]').getAttribute('data-port-side'),
      'left',
      'cascode input should render on the left edge',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="output"]').getAttribute('data-port-side'),
      'right',
      'cascode output should render on the right edge',
    );
    await waitForEditorIdle(page);
    await assertRenderedWirePolylinesOrthogonal(page, 'legacy cascode rendered wires');
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-cascode.png') });
    console.log('[e2e] legacy cascode loaded');
    await selectComponentForDrag(page, 'm1', [
      { x: 0, y: 0 },
      { x: -20, y: 0 },
      { x: 12, y: 18 },
      { x: 24, y: -18 },
    ]);
    const cascodeM1DragPoint = await selectedComponentFrameScreenPoint(page, 'm1');
    await page.mouse.move(cascodeM1DragPoint.x, cascodeM1DragPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grab'
    ));
    await page.mouse.down();
    await page.mouse.move(cascodeM1DragPoint.x + 25, cascodeM1DragPoint.y + 20, { steps: 4 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
    ));
    await page.mouse.move(cascodeM1DragPoint.x + 95, cascodeM1DragPoint.y + 55, { steps: 10 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-drag-preview') === 'true'
    ));
    assertUnrelatedWireRoutesStable(
      cascodeWires,
      await editorWires(page),
      ['m1'],
      'dragging cascode M1',
    );
    await page.mouse.up();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
    ));
    const cascodePositionsAfterM1Drag = await componentPositions(page);
    assertPositionChanged(cascodePositionsAfterM1Drag.m1, cascodePositions.m1, 'dragging cascode M1 did not move M1');
    for (const id of ['m2', 'rl', 'rs', 'cint', 'ccomp', 'rout', 'cload', 'rprobe']) {
      assertPositionEqual(cascodePositionsAfterM1Drag[id], cascodePositions[id], `dragging cascode M1 moved ${id}`);
    }
    await assertWireEndpointsMatchComponentPins(page, 'm1', 'committed cascode M1 drag should keep endpoints on moving pins');
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-cascode-drag.png') });
    console.log('[e2e] legacy cascode drag isolated');

    await page.getByTestId(`sidebar-project-${legacyBuckConverterProject.projectId}`).click();
    await waitForWorkbenchProject(page, legacyBuckConverterProject.projectId);
    await page.getByTestId('circuit-workbench').getByText(legacyBuckConverterProject.projectName, { exact: true }).waitFor();
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, 'buck');
    await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      return Number(node?.getAttribute('data-component-count') ?? '0') >= 7 &&
        Number(node?.getAttribute('data-wire-count') ?? '0') >= 4;
    });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-preview-busy') === 'false'
    ));
    const buckPositions = await componentPositions(page);
    for (const id of ['msw', 'dfree', 'l1', 'cout', 'rload']) {
      assert.ok(buckPositions[id], `hydrated buck converter component ${id} is missing from editable schematic`);
    }
    assert.ok(await countVisibleSchematicComponents(page) >= 7, 'hydrated buck converter components are not visibly drawn');
    assert.ok(await countVisibleSchematicWires(page) >= 4, 'hydrated buck converter wires are not visibly drawn');
    const buckWires = await editorWires(page);
    assertWiresOrthogonal(buckWires, 'legacy buck converter editor wires should remain orthogonal');
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-component-id="msw"] [data-symbol-kind="mosfet"]').count(),
      1,
      'buck switch should use the refined MOSFET symbol body',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-component-id="msw"] [data-symbol-polarity="pmos"]').count(),
      1,
      'buck switch should expose PMOS polarity for symbol rendering',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-component-id="dfree"] [data-symbol-kind="diode"]').count(),
      1,
      'buck freewheel diode should use the refined diode symbol body',
    );
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-component-id="l1"] [data-symbol-kind="inductor"]').count(),
      1,
      'buck output stage should render L1 as an inductor',
    );
    const buckRenderedCenters = await renderedComponentCenters(page, ['msw', 'dfree', 'l1', 'cout', 'rload']);
    for (const id of ['msw', 'dfree', 'l1', 'cout', 'rload']) {
      assert.ok(buckRenderedCenters[id], `hydrated buck converter component ${id} is not rendered in the SVG viewport`);
    }
    // Use schematic positions for topology -- rendered getBBox centers include side labels and
    // drift when label placement changes without the devices themselves moving.
    assert.ok(buckPositions.msw.x < buckPositions.l1.x, 'buck switch node should feed the inductor to the right in GUI');
    assert.ok(buckPositions.dfree.x >= buckPositions.msw.x - 40, 'buck freewheel diode should sit near the switch node, not before the switch');
    assert.ok(buckPositions.cout.x > buckPositions.l1.x, 'buck output capacitor should sit on the output side of the inductor');
    assert.ok(buckPositions.rload.x >= buckPositions.cout.x, 'buck load should sit at or beyond the output capacitor');
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="vout"]').getAttribute('data-port-side'),
      'right',
      'buck VOUT should render on the right edge',
    );
    await waitForEditorIdle(page);
    await assertRenderedWirePolylinesOrthogonal(page, 'legacy buck converter rendered wires');
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-buck-converter.png') });
    console.log('[e2e] legacy buck converter loaded');
    await selectComponentForDrag(page, 'msw', [
      { x: 0, y: 0 },
      { x: -20, y: 0 },
      { x: 12, y: 18 },
      { x: 24, y: -18 },
    ]);
    const buckMswDragPoint = await selectedComponentFrameScreenPoint(page, 'msw');
    await page.mouse.move(buckMswDragPoint.x, buckMswDragPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grab'
    ));
    await page.mouse.down();
    await page.mouse.move(buckMswDragPoint.x - 20, buckMswDragPoint.y + 15, { steps: 4 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-cursor-mode') === 'grabbing'
    ));
    await page.mouse.move(buckMswDragPoint.x - 95, buckMswDragPoint.y + 45, { steps: 10 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-drag-preview') === 'true'
    ));
    assertUnrelatedWireRoutesStable(
      buckWires,
      await editorWires(page),
      ['msw'],
      'dragging buck switch Msw',
    );
    await page.mouse.up();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
    ));
    const buckPositionsAfterMswDrag = await componentPositions(page);
    assertPositionChanged(buckPositionsAfterMswDrag.msw, buckPositions.msw, 'dragging buck Msw did not move Msw');
    for (const id of ['dfree', 'l1', 'cout', 'rload']) {
      assertPositionEqual(buckPositionsAfterMswDrag[id], buckPositions[id], `dragging buck Msw moved ${id}`);
    }
    assertWiresOrthogonal(await editorWires(page), 'committed buck Msw drag should keep wires orthogonal');
    await assertWireEndpointsMatchComponentPins(page, 'msw', 'committed buck Msw drag should keep wire endpoints on moving pins');
    assert.equal(
      await page.evaluate(() => {
        const wires = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]');
        const nets = new Set(wires.map((wire) => wire.net).filter(Boolean));
        const labeled = [...document.querySelectorAll('[data-testid="schematic-net-label"][data-kind="signal"]')]
          .map((node) => node.getAttribute('data-net'))
          .filter(Boolean);
        return labeled.filter((net) => nets.has(net)).length;
      }),
      0,
      'committed buck Msw drag must not replace still-wired nets with floating signal labels',
    );
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-legacy-buck-converter-drag.png') });
    console.log('[e2e] legacy buck converter drag isolated');

  }
  if (shouldRun("junction")) {
    await page.getByTestId(`sidebar-project-${junctionInteractionProject.projectId}`).click();
    await waitForWorkbenchProject(page, junctionInteractionProject.projectId);
    await page.getByTestId('circuit-workbench').getByText(junctionInteractionProject.projectName, { exact: true }).waitFor();
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, 'junctions');
    await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor-svg"]')?.getAttribute('data-module-id') === 'junctions'
    ));
    await waitForEditorIdle(page);
    const junctionEditor = page.getByTestId('schematic-editor');
    const junctionCanvas = page.getByTestId('schematic-editor-svg');
    const initialJunctions = await renderedJunctions(page);
    assert.ok(
      hasRenderedJunction(initialJunctions, { x: 320, y: 300 }, 'TRUNK'),
      'a real three-way TRUNK branch should render a junction dot',
    );
    assert.equal(
      hasRenderedJunction(initialJunctions, { x: 320, y: 120 }),
      false,
      'strict HNET/VNET interior crossing should remain unconnected and render no junction dot',
    );
    const junctionWiresBeforeBranch = await editorWires(page);
    const storedWireCountBeforeBranch = junctionWiresBeforeBranch.filter((wire) => wire.source === 'stored').length;
    const junctionCanvasBox = await junctionCanvas.boundingBox();
    assert.ok(junctionCanvasBox, 'junction interaction fixture requires a visible canvas');
    const junctionViewBox = await editorViewBox(page);
    const branchStartWorld = { x: 240, y: 120 };
    const branchEndWorld = { x: 240, y: 220 };
    const branchStart = worldToScreen(branchStartWorld, junctionViewBox, junctionCanvasBox);
    const branchEnd = worldToScreen(branchEndWorld, junctionViewBox, junctionCanvasBox);
    await page.getByTestId('schematic-editor-wire').click();
    await page.mouse.move(branchStart.x, branchStart.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-hover-endpoint') === 'Wire HNET'
    ));
    assert.equal(
      await page.getByTestId('schematic-hover-endpoint').getAttribute('data-net'),
      'HNET',
      'hovering a stored wire midpoint should expose its electrical net before snapping',
    );
    await page.mouse.click(branchStart.x, branchStart.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wire-start') === 'point:240,120'
    ));
    await page.mouse.click(branchEnd.x, branchEnd.y);
    await page.waitForFunction((storedBefore) => {
      const wires = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]');
      return wires.filter((wire) => wire.source === 'stored').length === storedBefore + 2;
    }, storedWireCountBeforeBranch);
    const junctionWiresAfterBranch = await editorWires(page);
    const hnetIncidentEndpoints = junctionWiresAfterBranch
      .filter((wire) => wire.net === 'HNET')
      .flatMap((wire) => [wire.from, wire.to])
      .filter((endpoint) => endpoint?.x === branchStartWorld.x && endpoint?.y === branchStartWorld.y);
    assert.equal(hnetIncidentEndpoints.length, 3, 'starting from a wire midpoint should split the trunk and create a three-edge node');
    assert.equal(
      new Set(hnetIncidentEndpoints.map((endpoint) => endpoint.junction_id)).size,
      1,
      'all three midpoint branch edges should share one stable junction identity',
    );
    assert.ok(
      hasRenderedJunction(await renderedJunctions(page), branchStartWorld, 'HNET'),
      'the newly created T branch should render a junction dot at the split point',
    );
    assert.equal(
      hasRenderedJunction(await renderedJunctions(page), { x: 320, y: 120 }),
      false,
      'adding a nearby branch must not turn an unrelated strict crossing into a connection',
    );
    assertWireOrthogonal(
      junctionWiresAfterBranch.find((wire) => (
        wire.net === 'HNET' && wire.from?.junction_id === hnetIncidentEndpoints[0]?.junction_id &&
        wire.to?.x === branchEndWorld.x && wire.to?.y === branchEndWorld.y
      )),
      'wire-midpoint branch should remain orthogonal',
    );
    await page.getByTestId('schematic-editor-select').click();

    const componentPositionBeforeJunctionDrag = (await componentPositions(page)).r_branch;
    const wiresBeforeJunctionDrag = await editorWires(page);
    await selectComponentForDrag(page, 'r_branch');
    const junctionResistorDragPoint = await selectedComponentFrameScreenPoint(page, 'r_branch');
    await page.mouse.move(junctionResistorDragPoint.x, junctionResistorDragPoint.y);
    await page.mouse.down();
    await page.mouse.move(junctionResistorDragPoint.x + 100, junctionResistorDragPoint.y + 60, { steps: 10 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-drag-preview') === 'true'
    ));
    assertUnrelatedWireRoutesStable(
      wiresBeforeJunctionDrag,
      await editorWires(page),
      ['r_branch'],
      'dragging a component attached to a semantic junction',
    );
    await page.mouse.up();
    await page.waitForFunction((previous) => {
      const positions = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}');
      return positions.r_branch?.x !== previous.x || positions.r_branch?.y !== previous.y;
    }, componentPositionBeforeJunctionDrag);
    const wiresAfterJunctionDrag = await editorWires(page);
    await assertWireEndpointsMatchComponentPins(
      page,
      'r_branch',
      'dragging a component attached to a semantic junction',
    );
    const feedAfterJunctionDrag = wiresAfterJunctionDrag.find((wire) => wire.id === 'branch_to_resistor');
    assert.ok(feedAfterJunctionDrag, 'component drag should preserve its stored feed wire');
    assert.equal(feedAfterJunctionDrag.from?.junction_id, 'j_trunk_right', 'component drag should preserve the feed junction identity');
    assertPositionEqual(feedAfterJunctionDrag.points?.[0], { x: 480, y: 300 }, 'component drag moved the fixed feed junction');
    for (const beforeWire of wiresBeforeJunctionDrag) {
      if (beforeWire.from?.component_id === 'r_branch' || beforeWire.to?.component_id === 'r_branch') continue;
      const afterWire = wiresAfterJunctionDrag.find((wire) => wire.id === beforeWire.id);
      assert.deepEqual(afterWire?.points, beforeWire.points, `dragging r_branch changed unrelated route ${beforeWire.id}`);
    }
    assert.ok(
      hasRenderedJunction(await renderedJunctions(page), { x: 320, y: 300 }, 'TRUNK'),
      'component dragging should not remove an existing three-way junction dot',
    );
    await page.getByTestId('schematic-editor-save').click();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'false'
    ));
    await waitForEditorIdle(page);
    const savedJunctionModule = JSON.parse(await readFile(
      path.resolve(junctionInteractionProject.projectRoot, 'modules', 'junctions', 'module.circuit.json'),
      'utf8',
    ));
    const savedFeed = savedJunctionModule.wires.find((wire) => wire.id === 'branch_to_resistor');
    assert.equal(savedFeed?.from?.junction_id, 'j_trunk_right', 'saving should preserve semantic junction identities');
    assert.ok(
      savedJunctionModule.wires.some((wire) => (
        wire.net === 'HNET' && (wire.from?.x === branchStartWorld.x && wire.from?.y === branchStartWorld.y ||
          wire.to?.x === branchStartWorld.x && wire.to?.y === branchStartWorld.y)
      )),
      'saving should preserve the midpoint split branch topology',
    );
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-junction-interactions.png') });
    console.log('[e2e] KiCad-like crossing, junction, midpoint branch, and connected component drag verified');

    await page.getByTestId(`sidebar-project-${projectId}`).click();
    await waitForWorkbenchProject(page, projectId);
    await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }

    await openModuleCard(page, 'power');
    await editor.waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor-svg"]')?.getAttribute('data-module-id') === 'power'
    ));
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-preview-busy') === 'false'
    ));
    await waitForEditorIdle(page);
    await page.getByTestId('schematic-editor-fit').click();
    await waitForEditorIdle(page);
    const powerCountBeforePlace = Number(await editor.getAttribute('data-component-count'));
    assert.ok(Number.isFinite(powerCountBeforePlace) && powerCountBeforePlace >= 2, 'power module should already contain supply components');
    const powerCanvas = page.getByTestId('schematic-editor-svg');
    const powerBox = await powerCanvas.boundingBox();
    assert.ok(powerBox);
    const powerPlacePoint = worldToScreen({ x: 520, y: 320 }, await editorViewBox(page), powerBox);
    await page.getByTestId('schematic-editor-place-R').click();
    assert.equal(await editor.getAttribute('data-tool'), 'place', 'power-module R toolbar button did not activate place mode');
    // Click relative to the SVG element so Electron window chrome cannot shift the hit.
    await powerCanvas.click({
      position: {
        x: Math.min(Math.max(powerPlacePoint.x - powerBox.x, 8), powerBox.width - 8),
        y: Math.min(Math.max(powerPlacePoint.y - powerBox.y, 8), powerBox.height - 8),
      },
    });
    await page.waitForFunction((expectedCount) => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === String(expectedCount)
    ), powerCountBeforePlace + 1);
    const powerPositionsAfterPlace = await componentPositions(page);
    const powerWiresBeforeR1Drag = await editorWires(page);
    await selectComponentForDrag(page, 'r1', [{ x: 0, y: -10 }, { x: 0, y: 0 }, { x: 10, y: 0 }]);
    const powerR1PlacePoint = await selectedComponentFrameScreenPoint(page, 'r1');
    await page.mouse.move(powerR1PlacePoint.x, powerR1PlacePoint.y);
    await page.mouse.down();
    await page.mouse.move(powerR1PlacePoint.x + 70, powerR1PlacePoint.y + 40, { steps: 10 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-drag-preview') === 'true'
    ));
    assertUnrelatedWireRoutesStable(
      powerWiresBeforeR1Drag,
      await editorWires(page),
      ['r1'],
      'dragging newly placed power-module resistor',
    );
    await page.mouse.up();
    await page.waitForFunction((previous) => {
      const raw = document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}';
      const positions = JSON.parse(raw);
      return Number(positions.r1?.x) !== Number(previous.r1.x) ||
        Number(positions.r1?.y) !== Number(previous.r1.y);
    }, powerPositionsAfterPlace);
    const powerPositionsAfterDrag = await componentPositions(page);
    assertPositionEqual(powerPositionsAfterDrag.v_signal, powerPositionsAfterPlace.v_signal, 'dragging resistor moved Vsignal');
    assertPositionEqual(powerPositionsAfterDrag.v_supply, powerPositionsAfterPlace.v_supply, 'dragging resistor moved VDD source');
    assertPositionChanged(powerPositionsAfterDrag.r1, powerPositionsAfterPlace.r1, 'power-module resistor did not move');
    console.log('[e2e] power module drag isolated');

    // Unconnected ports render dimmed as wire targets and accept connections.
  }
  if (shouldRun("unconnected")) {
    await page.getByTestId(`sidebar-project-${unconnectedPortProject.projectId}`).click();
    await waitForWorkbenchProject(page, unconnectedPortProject.projectId);
    await page.getByTestId('circuit-workbench').getByText(unconnectedPortProject.projectName, { exact: true }).waitFor();
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, 'ports');
    await editor.waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor-svg"]')?.getAttribute('data-module-id') === 'ports'
    ));
    await waitForEditorIdle(page);
    const sparePortGroup = page.getByTestId('schematic-editor-svg').locator('g[data-port-id="spare"]');
    await sparePortGroup.waitFor();
    assert.equal(await sparePortGroup.getAttribute('data-connected'), 'false', 'spare port should start unconnected');
    assert.ok(Number(await sparePortGroup.getAttribute('opacity')) < 1, 'unconnected spare port should render dimmed');
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-unconnected-port.png') });
    const sparePortWorld = (await portPositions(page)).spare;
    assert.ok(sparePortWorld, 'spare port position is not exposed');
    const spareCanvasBox = await canvas.boundingBox();
    assert.ok(spareCanvasBox);
    const sparePortAnchor = worldToScreen(sparePortWorld, await editorViewBox(page), spareCanvasBox);
    const r1TailPins = await componentPinWorldPoints(page, 'r1');
    const r1TailPinScreen = worldToScreen(r1TailPins.b, await editorViewBox(page), spareCanvasBox);
    await page.getByTestId('schematic-editor-wire').click();
    await page.mouse.move(r1TailPinScreen.x, r1TailPinScreen.y);
    await page.mouse.down();
    await page.mouse.move(sparePortAnchor.x, sparePortAnchor.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => {
      const wires = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-wires') ?? '[]');
      return wires.some((wire) => wire.from?.port_id === 'spare' || wire.to?.port_id === 'spare');
    });
    const wiresWithSpare = (await editorWires(page)).filter((wire) => wire.from?.port_id === 'spare' || wire.to?.port_id === 'spare');
    assert.equal(wiresWithSpare.length, 1, 'wiring to a dimmed unconnected port should create exactly one wire');
    assert.equal(wiresWithSpare[0].net, 'spare_net', 'wiring an unconnected port should pull the connected pin onto the port net');
    assert.equal(
      await page.getByTestId('schematic-editor-svg').locator('g[data-port-id="spare"]').getAttribute('data-connected'),
      'true',
      'spare port should become connected once wired',
    );
    assert.deepEqual(await componentPinNets(page, 'r1'), ['in_net', 'spare_net'], 'resistor tail pin should adopt the spare port net');
    await page.getByTestId('schematic-editor-save').click();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'false'
    ));
    const savedPortsModule = JSON.parse(await readFile(
      path.resolve(unconnectedPortProject.projectRoot, 'modules', 'ports', 'module.circuit.json'),
      'utf8',
    ));
    assert.ok(
      savedPortsModule.wires.some((wire) => wire.from?.port_id === 'spare' || wire.to?.port_id === 'spare'),
      'saving should persist the wire attached to the previously unconnected port',
    );
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-unconnected-port-wired.png') });
    console.log('[e2e] unconnected port renders dimmed, snaps, and persists after wiring');

  }
  if (shouldRun("gnd")) {
    // GND as a placeable, selectable, deletable pseudo-component (qucs parity).
    await page.getByTestId(`sidebar-project-${projectId}`).click();
    await waitForWorkbenchProject(page, projectId);
    await page.getByTestId('circuit-workbench').getByText(projectName, { exact: true }).waitFor();
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, 'filter');
    await editor.waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor-svg"]')?.getAttribute('data-module-id') === 'filter'
    ));
    await waitForEditorIdle(page);
    const gndCountBefore = Number(await editor.getAttribute('data-component-count'));
    await editor.focus();
    await page.keyboard.press('g');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-tool') === 'place'
    ));
    const gndProbeSpot = await page.getByTestId('schematic-editor-svg').evaluate((svg) => {
      if (!(svg instanceof SVGSVGElement)) throw new Error('schematic editor svg missing');
      const editor = document.querySelector('[data-testid="schematic-editor"]');
      const wires = JSON.parse(editor?.getAttribute('data-wires') ?? '[]');
      const components = Object.values(JSON.parse(editor?.getAttribute('data-component-positions') ?? '{}'));
      const ports = Object.values(JSON.parse(editor?.getAttribute('data-port-positions') ?? '{}'));
      const [minX, minY, width, height] = (svg.getAttribute('viewBox') ?? '0 0 1 1').split(/\s+/).map(Number);
      const snap20 = (value) => Math.round(value / 20) * 20;
      const segmentDistance = (px, py, a, b) => {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSquared = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lengthSquared));
        return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
      };
      let best = null;
      for (let x = snap20(minX + 60); x <= minX + width - 60; x += 20) {
        for (let y = snap20(minY + 60); y <= minY + height - 60; y += 20) {
          let clearance = Math.min(
            ...components.map((p) => Math.hypot(x - p.x, y - p.y)),
            ...ports.map((p) => Math.hypot(x - p.x, y - p.y)),
          );
          if (clearance < 70) continue;
          for (const wire of wires) {
            const points = wire.points ?? [];
            for (let index = 1; index < points.length; index += 1) {
              clearance = Math.min(clearance, segmentDistance(x, y, points[index - 1], points[index]));
            }
          }
          if (clearance < 40) continue;
          if (!best || clearance > best.clearance) best = { x, y, clearance };
        }
      }
      if (!best) throw new Error('no free spot for the GND placement test');
      const matrix = svg.getScreenCTM();
      if (!matrix) throw new Error('schematic editor svg has no screen matrix');
      const point = svg.createSVGPoint();
      point.x = best.x;
      point.y = best.y;
      const screen = point.matrixTransform(matrix);
      return { x: screen.x, y: screen.y };
    });
    await page.mouse.move(gndProbeSpot.x, gndProbeSpot.y);
    await page.getByTestId('schematic-place-ghost').waitFor();
    assert.equal(
      await page.getByTestId('schematic-place-ghost').locator('[data-symbol-kind="ground"]').count(),
      1,
      'G hotkey should arm a ground ghost preview',
    );
    assert.equal(
      await page.getByTestId('schematic-place-ghost').locator('text').count(),
      0,
      'ground ghost preview must not render name/value labels (qucs parity)',
    );
    await page.mouse.click(gndProbeSpot.x, gndProbeSpot.y);
    await page.waitForFunction((count) => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === String(count) &&
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:gnd1'
    ), gndCountBefore + 1);
    assert.equal(
      await page.locator('g[data-component-id="gnd1"] [data-symbol-kind="ground"]').count(),
      1,
      'placed GND should render the ground symbol art',
    );
    assert.equal(
      await page.locator('g[data-component-id="gnd1"] [data-testid="schematic-component-name-label"]').count(),
      0,
      'ground symbols render without name/value labels (qucs style)',
    );
    assert.deepEqual(await componentPinNets(page, 'gnd1'), ['0'], 'placed GND pin must tie to net 0');
    await page.keyboard.press('Escape');
    // Clicking the symbol itself selects the pseudo-component (not a parent).
    const gndScreenPoint = await componentScreenPoint(page, 'gnd1');
    await page.mouse.click(gndScreenPoint.x, gndScreenPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:gnd1'
    ));
    assert.equal(await page.getByTestId('schematic-selected-component-frame').count(), 1, 'GND selection should show one frame');
    // The whole symbol body is clickable, not just the anchor pin.
    const gndBodyPoint = await componentScreenPoint(page, 'gnd1', { x: 8, y: 30 });
    await page.keyboard.press('Escape');
    await page.mouse.click(gndBodyPoint.x, gndBodyPoint.y);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') === 'component:gnd1'
    ));
    // Drag the ground symbol; it moves like any component.
    const gndBeforeDrag = await componentPositions(page);
    await page.mouse.move(gndScreenPoint.x, gndScreenPoint.y);
    await page.mouse.down();
    await page.mouse.move(gndScreenPoint.x + 60, gndScreenPoint.y + 40, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction((previous) => {
      const positions = JSON.parse(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-positions') ?? '{}');
      return Number(positions.gnd1?.x) !== Number(previous.x) || Number(positions.gnd1?.y) !== Number(previous.y);
    }, gndBeforeDrag.gnd1);
    // Delete removes the placed symbol.
    await page.keyboard.press('Delete');
    await page.waitForFunction((count) => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === String(count)
    ), gndCountBefore);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForFunction((count) => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') === String(count)
    ), gndCountBefore + 1);
    // Save: the pseudo-component persists structurally but emits no SPICE card.
    await page.getByTestId('schematic-editor-save').click();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'false'
    ));
    const savedGndModule = JSON.parse(await readFile(
      path.resolve(projectRoot, 'modules', 'filter', 'module.circuit.json'),
      'utf8',
    ));
    const savedGnd = savedGndModule.components.find((component) => component.id === 'gnd1');
    assert.ok(savedGnd, 'saved module should keep the placed GND pseudo-component');
    assert.equal(savedGnd.type, 'GND', 'saved GND should keep its pseudo-component type');
    assert.equal(savedGnd.pins?.[0]?.net, '0', 'saved GND pin should stay on net 0');
    const savedDesignCir = await readFile(path.resolve(projectRoot, 'build', 'modules', 'filter', 'design.cir'), 'utf8').catch(() => '');
    assert.equal(
      savedDesignCir.split('\n').some((line) => line.startsWith('GND1 ') || line.startsWith('gnd1 ')),
      false,
      'GND pseudo-components must not emit SPICE cards',
    );
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-gnd.png') });
    console.log('[e2e] GND placeable/selectable/deletable with no SPICE card verified');
  }

  if (shouldRun("crystal")) {
    await page.getByTestId(`sidebar-project-${pcbParamProject.projectId}`).click();
    await waitForWorkbenchProject(page, pcbParamProject.projectId);
    await page.getByTestId('circuit-workbench').getByText(pcbParamProject.projectName, { exact: true }).waitFor();
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, pcbParamProject.moduleId);
    await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
    const resolvedIr = await page.evaluate((symbolIds) => window.electronAPI.resolveKicadSymbolIr(symbolIds), [
      'Switch:SW_Push',
      'Connector:Conn_01x04_Pin',
      'MCU_ST_STM32F1:STM32F103C8Tx',
      'Device:D_Dual_CommonAnode_AKK_Split',
    ]);
    assert.deepEqual(Object.keys(resolvedIr.definitions).sort(), [
      'Connector:Conn_01x04_Pin',
      'Device:D_Dual_CommonAnode_AKK_Split',
      'MCU_ST_STM32F1:STM32F103C8Tx',
      'Switch:SW_Push',
    ]);
    const crystal = page.locator('g[data-component-id="y1"]');
    await crystal.locator('[data-symbol-kind="crystal"]').waitFor();
    assert.equal(await crystal.locator('[data-symbol-kind="block"]').count(), 0, 'crystal must not render as a generic block');
    await crystal.getByTestId('schematic-component-name-label').filter({ hasText: 'Y1' }).waitFor();
    await crystal.getByTestId('schematic-component-value-label').filter({ hasText: '8 MHz' }).waitFor();
    for (const componentId of ['sw1', 'j1', 'u1', 'd1a', 'd1b', 'd2a']) {
      const generic = page.locator(`g[data-component-id="${componentId}"]`);
      await generic.locator('[data-symbol-kind="kicad-ir"]').waitFor({ timeout: 20_000 });
      assert.equal(await generic.locator('[data-symbol-kind="block"]').count(), 0, `${componentId} must use KiCad Symbol IR`);
    }
    assert.equal(await page.locator('g[data-component-id="d1a"] [data-symbol-unit="1"]').count(), 1);
    assert.equal(await page.locator('g[data-component-id="d1b"] [data-symbol-unit="2"]').count(), 1);
    await selectComponentForDrag(page, 'd2a');
    await page.getByTestId('schematic-param-symbol').waitFor();
    assert.equal(await page.getByTestId('schematic-param-symbol').inputValue(), 'Device:D_Dual_CommonAnode_AKK_Split');
    assert.equal(await page.getByTestId('schematic-param-package').inputValue(), 'pkg_d2');
    await page.getByTestId('schematic-param-symbol-unit').selectOption('2');
    await page.locator('g[data-component-id="d2a"] [data-symbol-unit="2"]').waitFor();
    const switchedComponents = JSON.parse(await page.getByTestId('schematic-editor').getAttribute('data-components'));
    const switched = switchedComponents.find((component) => component.id === 'd2a');
    assert.deepEqual(switched.pins.map((pin) => pin.id), ['1', '3']);
    assert.ok(switched.pins.every((pin) => pin.no_connect && pin.net.startsWith('nc_d2a_')));
    await page.getByTestId('schematic-editor-save').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'false');
    await page.getByTestId('back-to-board').click();
    await openModuleCard(page, pcbParamProject.moduleId);
    await page.locator('g[data-component-id="d2a"] [data-symbol-unit="2"]').waitFor({ timeout: 20_000 });
    await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-crystal.png') });
    console.log('[e2e] native crystal and generic KiCad Symbol IR devices render');
  }

  if (shouldRun("params")) {
    // Structured param inspector by project kind
    await page.getByTestId(`sidebar-project-${projectId}`).click();
    await waitForWorkbenchProject(page, projectId);
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, 'filter');
    await editor.waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor-svg"]')?.getAttribute('data-module-id') === 'filter'
    ));
    await waitForEditorIdle(page);
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="schematic-editor"]');
      const positions = JSON.parse(node?.getAttribute('data-component-positions') ?? '{}');
      return Number(node?.getAttribute('data-component-count') ?? '0') >= 3 && positions.r1 !== undefined;
    }, { timeout: 30_000 });
    // Module sessions intentionally restore their previous viewport; fit before
    // coordinate-based selection so this scene is independent of earlier pans.
    await page.getByTestId('schematic-editor-fit').click();
    await selectComponentForDrag(page, 'r1');
    const typeBadge = (await page.getByTestId('schematic-editor-component-type').innerText()).replace(/\s+/g, '').toLowerCase();
    assert.ok(typeBadge.includes('r'), 'selection should show component type');
    assert.ok(typeBadge.includes('simulation'), 'selection should show project kind');
    assert.equal(await page.getByTestId('schematic-param-magnitude').inputValue(), '2k');
    await page.getByTestId('schematic-param-magnitude').fill('4.7k');
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'true'
    ));
    await page.getByTestId('schematic-editor-save').click();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'false'
    ));
    const simSavedModule = JSON.parse(await readFile(
      path.resolve(projectRoot, 'modules', 'filter', 'module.circuit.json'),
      'utf8',
    ));
    const simR1 = simSavedModule.components.find((component) => component.id === 'r1');
    assert.equal(simR1?.value, '4.7k');
    assert.equal(simR1?.parameters?.magnitude, '4.7k');
    console.log('[e2e] Simulation R magnitude projection verified');

    await page.getByTestId(`sidebar-project-${pcbParamProject.projectId}`).click();
    await waitForWorkbenchProject(page, pcbParamProject.projectId);
    await page.getByTestId('circuit-workbench').getByText(pcbParamProject.projectName, { exact: true }).waitFor();
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, pcbParamProject.moduleId);
    await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
    const pcbCanvas = page.getByTestId('schematic-editor-svg');
    const pcbBox = await pcbCanvas.boundingBox();
    assert.ok(pcbBox, 'PCB schematic canvas bounding box missing');
    const pcbPlace = { x: pcbBox.x + Math.min(280, pcbBox.width * 0.45), y: pcbBox.y + Math.min(180, pcbBox.height * 0.4) };
    await page.getByTestId('schematic-editor-place-R').click();
    await page.mouse.click(pcbPlace.x, pcbPlace.y);
    await page.waitForFunction(() => (
      Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') ?? '0') >= 1
    ));
    const pcbRid = await page.locator('g[data-component-type="R"]').last().getAttribute('data-component-id');
    assert.ok(pcbRid, 'placed PCB resistor should expose id');
    await selectComponentForDrag(page, pcbRid);
    assert.ok(await page.getByTestId('schematic-editor-component-value').count(), 'PCB form should expose BOM value');
    await page.getByTestId('schematic-param-footprint').fill('R_0603');
    await page.getByTestId('schematic-param-lcsc').fill('C25804');
    await page.getByTestId('schematic-param-mpn').fill('RC0603FR-0710KL');
    await page.getByTestId('schematic-editor-save').click();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'false'
    ));
    const pcbSavedModule = JSON.parse(await readFile(
      path.resolve(pcbParamProject.projectRoot, 'modules', pcbParamProject.moduleId, 'module.circuit.json'),
      'utf8',
    ));
    const pcbR = pcbSavedModule.components.find((component) => component.id === pcbRid);
    assert.equal(pcbR?.eda?.footprint_hint, 'R_0603');
    assert.equal(pcbR?.eda?.lcsc_id, 'C25804');
    assert.equal(pcbR?.eda?.mpn, 'RC0603FR-0710KL');
    console.log('[e2e] PCB eda param fields persist');

    await page.getByTestId(`sidebar-project-${analogIcParamProject.projectId}`).click();
    await waitForWorkbenchProject(page, analogIcParamProject.projectId);
    await page.getByTestId('circuit-workbench').getByText(analogIcParamProject.projectName, { exact: true }).waitFor();
    if (await page.getByTestId('back-to-board').count()) {
      await page.getByTestId('back-to-board').click();
    }
    await openModuleCard(page, analogIcParamProject.moduleId);
    await page.getByTestId('schematic-editor').waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-selected') !== undefined &&
      Number(document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-component-count') ?? '0') >= 1
    ));
    assert.equal(await page.getByTestId('project-kind-select').inputValue(), 'analog_ic');
    await selectComponentForDrag(page, 'm1');
    assert.ok(await page.getByTestId('schematic-param-pdk-unbound').count(), 'Analog IC without PDK should show unbound hint');
    await page.getByTestId('schematic-param-model').selectOption('PMOS');
    await page.getByTestId('schematic-param-w').fill('10u');
    await page.getByTestId('schematic-param-l').fill('1u');
    await page.getByTestId('schematic-editor-save').click();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-dirty') === 'false'
    ));
    const icSavedModule = JSON.parse(await readFile(
      path.resolve(analogIcParamProject.projectRoot, 'modules', analogIcParamProject.moduleId, 'module.circuit.json'),
      'utf8',
    ));
    const savedMos = icSavedModule.components.find((component) => component.id === 'm1');
    assert.equal(savedMos?.parameters?.model, 'PMOS');
    assert.equal(savedMos?.parameters?.w, '10u');
    assert.equal(savedMos?.parameters?.l, '1u');
    assert.match(String(savedMos?.value || ''), /PMOS.*W=10u.*L=1u/);
    console.log('[e2e] Analog IC MOS param projection verified');
  }

  await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-smoke.png') });
  assert.deepEqual(
    pageErrors.filter((entry) => (
      /^(pageerror|console:|requestfailed|page-crash)/.test(entry) &&
      !isIgnorablePageError(entry)
    )),
    [],
  );
  console.log(JSON.stringify({
    ok: true,
    projectId,
    moduleComponentCount: agentModuleData?.components?.length ?? 0,
    moduleWireCount: agentModuleData?.wires?.length ?? 0,
    screenshot: 'output/playwright/schematic-editor-smoke.png',
    wireScreenshot: 'output/playwright/schematic-editor-wire-visible.png',
  }, null, 2));
  testSucceeded = true;
} catch (error) {
    if (page) {
      await page.screenshot({ path: path.resolve(outputRoot, 'schematic-editor-failure.png') }).catch(() => {});
      console.error(JSON.stringify({
        url: page.url(),
        title: await page.title().catch(() => ''),
        text: (await page.locator('body').innerText().catch(() => '')).slice(0, 2500),
        pageErrors,
      }, null, 2));
    }
    throw error;
  } finally {
    await electronApp.close();
    await rm(e2eRunRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (viteProcess) viteProcess.kill();
  }
