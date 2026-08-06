/**
 * M3-07 visual and functional regression for branch/net selection and
 * crossing/junction/dangling/no-connect states.
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createHarness } from './lib/schematic-editor-harness.mjs';

const h = await createHarness({ tag: 'connectivity-selection' });
const {
  e2eRunRoot,
  outputRoot,
  createJunctionInteractionProject,
  removePrefixedProjects,
  startEnvironment,
  waitForWorkbenchProject,
  openModuleCard,
  waitForEditorIdle,
  wireScreenPointAwayFromComponents,
  root,
} = h;

await removePrefixedProjects();
const fixture = await createJunctionInteractionProject();
const { electronApp, page, pageErrors, viteProcess } = await startEnvironment();

async function openEditor() {
  await page.getByTestId(`sidebar-project-${fixture.projectId}`).click();
  await waitForWorkbenchProject(page, fixture.projectId);
  await page.getByTestId('circuit-workbench').getByText(fixture.projectName, { exact: true }).waitFor();
  if (await page.getByTestId('back-to-board').count()) {
    await page.getByTestId('back-to-board').click();
  }
  await openModuleCard(page, 'junctions');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="schematic-editor"]')?.getAttribute('data-module-id') === 'junctions'
  ));
  await waitForEditorIdle(page);
}

async function openWireMenu(wireId) {
  const point = await wireScreenPointAwayFromComponents(page, wireId);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.getByTestId('schematic-context-menu').waitFor();
  return point;
}

try {
  page.setDefaultTimeout(30_000);
  await openEditor();

  // Different-net crossings render as plain crossings: no hop/bridge marker, no junction dot.
  assert.equal(await page.getByTestId('schematic-unconnected-crossing').count(), 0);
  assert.ok(await page.getByTestId('schematic-junction').count() >= 1);
  assert.ok(await page.getByTestId('schematic-dangling-wire-end').count() >= 1);
  assert.equal(
    await page.locator('[data-testid="schematic-dangling-pin"][data-component-id="spare_block"][data-pin-id="nc"]').count(),
    1,
  );

  await openWireMenu('trunk_right');
  await page.getByTestId('schematic-context-menu-select-branch').click();
  assert.equal(await page.getByTestId('schematic-editor').getAttribute('data-selected-wire-scope'), 'branch');
  assert.equal(await page.getByTestId('schematic-editor').getAttribute('data-selected-wire-count'), '2');
  const branchScreenshot = path.resolve(outputRoot, 'branch-selection.png');
  await page.screenshot({ path: branchScreenshot, fullPage: true });

  await openWireMenu('trunk_left');
  await page.getByTestId('schematic-context-menu-select-net').click();
  assert.equal(await page.getByTestId('schematic-editor').getAttribute('data-selected-wire-scope'), 'net');
  assert.equal(await page.getByTestId('schematic-editor').getAttribute('data-selected-wire-count'), '4');
  const netScreenshot = path.resolve(outputRoot, 'net-selection.png');
  await page.screenshot({ path: netScreenshot, fullPage: true });

  const trunkPoint = await wireScreenPointAwayFromComponents(page, 'trunk_right');
  await page.mouse.dblclick(trunkPoint.x, trunkPoint.y);
  assert.equal(await page.getByTestId('schematic-editor').getAttribute('data-selected-wire-scope'), 'branch');
  await page.keyboard.down('Control');
  await page.mouse.dblclick(trunkPoint.x, trunkPoint.y);
  await page.keyboard.up('Control');
  assert.equal(await page.getByTestId('schematic-editor').getAttribute('data-selected-wire-scope'), 'net');

  const sparePin = page.locator(
    '[data-endpoint-kind="pin"][data-component-id="spare_block"][data-pin-id="nc"]',
  );
  const sparePinBox = await sparePin.boundingBox();
  assert.ok(sparePinBox);
  await page.mouse.click(
    sparePinBox.x + sparePinBox.width / 2,
    sparePinBox.y + sparePinBox.height / 2,
    { button: 'right' },
  );
  await page.getByTestId('schematic-context-menu-no-connect').click();
  assert.equal(
    await page.locator('[data-testid="schematic-no-connect-marker"][data-component-id="spare_block"][data-pin-id="nc"]').count(),
    1,
  );
  assert.equal(
    await page.locator('[data-testid="schematic-dangling-pin"][data-component-id="spare_block"][data-pin-id="nc"]').count(),
    0,
  );

  await page.getByTestId('schematic-editor-save').click();
  await page.waitForFunction(() => {
    const editor = document.querySelector('[data-testid="schematic-editor"]');
    return editor?.getAttribute('data-save-error')
      || (
        editor?.getAttribute('data-dirty') === 'false'
        && editor?.getAttribute('data-busy') === 'false'
      );
  });
  assert.equal(await page.getByTestId('schematic-editor').getAttribute('data-save-error'), '');
  await page.getByTestId('back-to-board').click();
  await openEditor();
  assert.equal(
    await page.locator('[data-testid="schematic-no-connect-marker"][data-component-id="spare_block"][data-pin-id="nc"]').count(),
    1,
  );

  const connectivityScreenshot = path.resolve(outputRoot, 'connectivity-states.png');
  await page.screenshot({ path: connectivityScreenshot, fullPage: true });
  assert.deepEqual(
    pageErrors.filter((entry) => (
      !entry.startsWith('electron-window')
      && !entry.startsWith('domcontentloaded')
      && !entry.startsWith('load:')
    )),
    [],
  );
  console.log(JSON.stringify({
    ok: true,
    suite: 'schematic-connectivity-selection',
    branchSelection: true,
    netSelection: true,
    crossingVisual: true,
    junctionVisual: true,
    danglingVisual: true,
    noConnectPersisted: true,
    artifacts: [
      path.relative(root, branchScreenshot),
      path.relative(root, netScreenshot),
      path.relative(root, connectivityScreenshot),
    ],
  }, null, 2));
} catch (error) {
  await page.screenshot({
    path: path.resolve(outputRoot, 'connectivity-selection-failure.png'),
    fullPage: true,
  }).catch(() => undefined);
  throw error;
} finally {
  await electronApp.close();
  await rm(e2eRunRoot, { recursive: true, force: true });
  if (viteProcess) viteProcess.kill();
}
