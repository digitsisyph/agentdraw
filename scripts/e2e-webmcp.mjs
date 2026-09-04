#!/usr/bin/env node
/**
 * End-to-end check of the WebMCP contract through a real Chrome. The page is
 * opened with `?mock-webmcp=1`, which installs a minimal `document.modelContext`
 * so the eight tools register exactly as they would inside an agent browser;
 * we then call them the way an agent would and assert what the person sees.
 *
 *   pnpm build && pnpm preview   # in another terminal
 *   pnpm e2e                     # defaults to http://localhost:4173/
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const BASE = process.env.AGENTDRAW_URL ?? 'http://localhost:4173/';
const CHROME =
  process.env.AGENTDRAW_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = 'outputs/e2e';
const failures = [];
const notes = [];

function check(condition, message, detail) {
  if (condition) notes.push(`✔ ${message}`);
  else failures.push(`✖ ${message}${detail ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ''}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.url()}`);
  });

  const url = `${BASE}${BASE.includes('?') ? '&' : '?'}mock-webmcp=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__agentdrawMockTools?.apply_patch), null, { timeout: 30_000 });
  const tool = (name, input) =>
    page.evaluate(([toolName, toolInput]) => window.__agentdrawMockTools[toolName].execute(toolInput), [name, input]);

  // 1. Registration
  const toolNames = await page.evaluate(() => Object.keys(window.__agentdrawMockTools).sort());
  check(
    JSON.stringify(toolNames) ===
      JSON.stringify(['apply_patch', 'capture_canvas', 'export_canvas', 'focus_elements', 'get_capabilities', 'import_scene', 'inspect_canvas', 'revert_patch']),
    'eight tools registered',
    toolNames,
  );
  await page.waitForSelector('[data-testid="agent-pill"][data-status="available"]', { timeout: 10_000 });
  check(true, 'agent pill shows connected');
  const capabilities = await tool('get_capabilities', {});
  check(capabilities.ok && capabilities.elementTypes.includes('arrow'), 'capabilities list element types');

  // 2. Fresh scene
  let inspect = await tool('inspect_canvas', {});
  check(inspect.ok && inspect.elementCount === 0, 'fresh scene is empty', inspect);
  check(Boolean(inspect.suggestedOrigin), 'suggestedOrigin present');
  await page.waitForSelector('.excalidraw', { timeout: 10_000 });
  await page.screenshot({ path: `${OUT}/01-empty.png` });

  // 3. Agent draws a flow: frame, two labelled shapes, a bound arrow, a caption, an embed
  const patch = await tool('apply_patch', {
    epoch: inspect.epoch,
    baseRevision: inspect.revision,
    operations: [
      { op: 'create', id: 'flow', type: 'frame', x: 40, y: 40, width: 900, height: 420, name: 'Sign-in flow' },
      { op: 'create', id: 'login', type: 'rectangle', x: 100, y: 160, width: 220, height: 120, frameId: 'flow', label: { text: 'Login' }, backgroundColor: '#a5d8ff', fillStyle: 'solid', roundness: 'round' },
      { op: 'create', id: 'home', type: 'ellipse', x: 560, y: 150, width: 200, height: 140, frameId: 'flow', label: { text: 'Home' } },
      { op: 'create', id: 'go', type: 'arrow', x: 0, y: 0, start: { id: 'login' }, end: { id: 'home' } },
      { op: 'create', id: 'caption', type: 'text', x: 100, y: 320, text: 'Happy path', fontSize: 20, frameId: 'flow' },
      { op: 'create', id: 'preview', type: 'embeddable', x: 40, y: 520, width: 480, height: 300, link: `${BASE}favicon.svg` },
    ],
  });
  check(patch.ok, 'create patch ok', patch);
  check(patch.ok && patch.created.length === 6, 'six elements created', patch.ok && patch.created.map((c) => c.id));
  check(patch.ok && patch.created.every((c) => c.bounds && typeof c.bounds.width === 'number'), 'created bounds returned');
  check(patch.ok && patch.created.find((c) => c.id === 'login')?.boundTextId, 'created entry names its label');
  check(patch.ok && patch.updatedIds.length === 0 && patch.touchedIds.length === 0, 'create-only patch reports no updated or touched ids', patch.ok && { updated: patch.updatedIds, touched: patch.touchedIds });

  const labelledArrow = await tool('apply_patch', {
    epoch: patch.epoch,
    baseRevision: patch.revision,
    operations: [{ op: 'create', id: 'yes-arrow', type: 'arrow', x: 0, y: 0, start: { id: 'login' }, end: { id: 'home' }, label: { text: 'yes' } }],
  });
  check(labelledArrow.ok && Boolean(labelledArrow.created[0]?.boundTextId), 'bound arrow created with a label', labelledArrow);
  const dropArrow = await tool('apply_patch', {
    epoch: labelledArrow.epoch,
    baseRevision: labelledArrow.revision,
    operations: [{ op: 'delete', id: 'yes-arrow' }],
  });
  check(dropArrow.ok && dropArrow.removedIds.length === 2, 'deleting a labelled arrow removes its label too', dropArrow);
  const badEpoch = await tool('apply_patch', {
    epoch: 'canvas-from-another-life',
    baseRevision: patch.revision,
    operations: [{ op: 'delete', id: 'home' }],
  });
  check(!badEpoch.ok && badEpoch.error.code === 'epoch_mismatch', 'foreign epoch rejected with its own code', badEpoch);

  inspect = await tool('inspect_canvas', {});
  const byId = Object.fromEntries((inspect.elements ?? []).map((element) => [element.id, element]));
  check(byId.login && byId.login.text === 'Login' && byId.login.boundTextId, 'label measured and bound to rectangle', byId.login);
  check(byId.go && byId.go.startBindingId === 'login' && byId.go.endBindingId === 'home', 'arrow bound to both shapes', byId.go);
  check(byId.flow && byId.flow.name === 'Sign-in flow' && byId.login.frameId === 'flow', 'frame and membership round-trip', byId.flow);
  check(byId.preview && byId.preview.link === `${BASE}favicon.svg`, 'embed link round-trip', byId.preview);
  check(inspect.userEditsSinceLastInspect === 0, 'no user edits yet');
  await page.waitForTimeout(500);
  check((await page.locator('.excalidraw__embeddable-container').count()) === 1, 'embed rendered by Excalidraw');
  await page.screenshot({ path: `${OUT}/02-agent-drew.png` });

  // 4. Stale patch rejected
  const stale = await tool('apply_patch', {
    epoch: inspect.epoch,
    baseRevision: Math.max(0, inspect.revision - 1),
    operations: [{ op: 'update', id: 'home', x: 10 }],
  });
  check(!stale.ok && stale.error.code === 'revision_conflict', 'stale baseRevision rejected', stale);

  // 5. Person draws with the freehand tool
  const canvas = page.locator('canvas.excalidraw__canvas.interactive').first();
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + 1100, box.y + 820);
  await page.keyboard.press('7');
  // A squiggle just right of the embed, within nearIds padding of it.
  await page.mouse.move(box.x + 640, box.y + 620);
  await page.mouse.down();
  for (let step = 1; step <= 14; step += 1) {
    const angle = (step / 14) * Math.PI * 2;
    await page.mouse.move(box.x + 600 + 40 * Math.cos(angle), box.y + 640 + 40 * Math.sin(angle));
  }
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  inspect = await tool('inspect_canvas', { sinceRevision: patch.revision });
  const stroke = (inspect.elements ?? []).find((element) => element.type === 'freedraw');
  check(Boolean(stroke), 'freehand stroke visible to agent', inspect.elements?.map((e) => e.type));
  check(stroke && stroke.points && stroke.points.length >= 2, 'stroke points reported', stroke && stroke.points?.length);
  check(inspect.userEditsSinceLastInspect >= 1, 'user edit counted', inspect.userEditsSinceLastInspect);
  check(Array.isArray(inspect.delta.changes) && inspect.delta.changes.some((c) => c.origin === 'user'), 'delta lists the user change', inspect.delta);
  check(inspect.delta.changes.filter((c) => c.origin === 'user').length <= 2, 'one stroke is at most two journal entries', inspect.delta.changes.length);
  check(inspect.elements.every((element) => inspect.delta.changedIds.includes(element.id)), 'sinceRevision returns only changed elements', inspect.elements.map((e) => e.id));
  check(stroke && Array.isArray(stroke.nearIds) && stroke.nearIds.includes('preview'), 'stroke reports the shape it was drawn near', stroke && stroke.nearIds);
  await page.screenshot({ path: `${OUT}/03-user-drew.png` });

  // 6. Agent updates, focuses, captures, deletes
  const move = await tool('apply_patch', {
    epoch: inspect.epoch,
    baseRevision: inspect.revision,
    operations: [
      { op: 'update', id: 'home', x: 700, backgroundColor: '#b2f2bb', fillStyle: 'solid' },
      { op: 'update', id: 'caption', text: 'Happy path (edited)' },
    ],
  });
  check(move.ok, 'update patch ok', move);
  inspect = await tool('inspect_canvas', {});
  const moved = inspect.elements.find((element) => element.id === 'home');
  const caption = inspect.elements.find((element) => element.id === 'caption');
  check(moved && moved.x === 700 && moved.backgroundColor === '#b2f2bb', 'update applied', moved);
  check(caption && caption.text === 'Happy path (edited)', 'text update applied', caption);
  const arrowAfterMove = inspect.elements.find((element) => element.id === 'go');
  check(arrowAfterMove?.endBindingId === 'home', 'arrow still bound after move');
  const arrowEnd = arrowAfterMove?.points?.at(-1);
  check(arrowEnd && arrowEnd.x >= 690 && arrowEnd.x <= 702, 'arrow re-routed to the moved shape’s edge', arrowEnd);
  check(move.ok && move.touchedIds.includes('go'), 'rerouted arrow reported as touched', move.ok && move.touchedIds);

  const frameMove = await tool('apply_patch', {
    epoch: inspect.epoch,
    baseRevision: inspect.revision,
    operations: [{ op: 'update', id: 'flow', x: 140 }],
  });
  check(frameMove.ok, 'frame move ok', frameMove);
  inspect = await tool('inspect_canvas', {});
  const movedLogin = inspect.elements.find((element) => element.id === 'login');
  const movedLabel = inspect.elements.find((element) => element.id === movedLogin?.boundTextId);
  check(movedLogin && movedLogin.x === 200, 'frame move carried its children', movedLogin && movedLogin.x);
  check(movedLabel && Math.abs(movedLabel.x + movedLabel.width / 2 - (movedLogin.x + movedLogin.width / 2)) < 2, 'frame move carried child labels', movedLabel && { label: movedLabel.x, shape: movedLogin.x });

  const focus = await tool('focus_elements', { ids: ['login'] });
  check(focus.ok, 'focus_elements ok', focus);
  await page.waitForTimeout(400);
  inspect = await tool('inspect_canvas', {});
  check(inspect.selectionIds.includes('login'), 'focus selected the element', inspect.selectionIds);

  const capture = await tool('capture_canvas', {});
  check(capture.ok && typeof capture.dataUrl === 'string' && capture.dataUrl.startsWith('data:image/png') && capture.dataUrl.length > 2000, 'capture returns a PNG', capture.ok ? capture.dataUrl?.length : capture);

  const del = await tool('apply_patch', {
    epoch: inspect.epoch,
    baseRevision: inspect.revision,
    operations: [{ op: 'delete', id: 'login' }],
  });
  check(del.ok && del.removedIds.includes('login') && del.removedIds.length === 2, 'delete removes shape and its label', del);
  inspect = await tool('inspect_canvas', {});
  check(!inspect.elements.some((element) => element.id === 'login'), 'deleted shape gone');
  check(inspect.elements.find((element) => element.id === 'go')?.startBindingId === undefined, 'arrow unbound from deleted shape');
  const countBeforeReload = inspect.elementCount;
  const epochBeforeReload = inspect.epoch;
  await page.screenshot({ path: `${OUT}/04-after-edits.png` });
  await page.waitForTimeout(700);

  // 7. Reload: everything persists locally
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__agentdrawMockTools?.inspect_canvas), null, { timeout: 30_000 });
  await page.waitForTimeout(800);
  inspect = await tool('inspect_canvas', {});
  check(inspect.elementCount === countBeforeReload, 'scene persists across reload', { before: countBeforeReload, after: inspect.elementCount });
  await page.screenshot({ path: `${OUT}/05-after-reload.png` });
  const afterReload = await tool('inspect_canvas', { sinceRevision: 0 });
  check(
    afterReload.userEditsSinceLastInspect === 0 && afterReload.delta.changes.every((change) => change.origin === 'system'),
    'restored document is not reported as user edits',
    { userEdits: afterReload.userEditsSinceLastInspect, origins: afterReload.delta.changes.map((change) => change.origin) },
  );
  const missingRevision = await tool('apply_patch', { epoch: inspect.epoch, operations: [{ op: 'create', type: 'text', x: 0, y: 0, text: 'nope' }] });
  check(!missingRevision.ok && missingRevision.error.code === 'invalid_input' && /baseRevision is required/.test(missingRevision.error.message), 'missing baseRevision is an input error, not a conflict', missingRevision);
  const staleEpoch = await tool('apply_patch', {
    epoch: inspect.epoch === epochBeforeReload ? 'canvas-stale' : epochBeforeReload,
    baseRevision: 0,
    operations: [{ op: 'create', type: 'text', x: 0, y: 0, text: 'nope' }],
  });
  check(
    !staleEpoch.ok && staleEpoch.error.code === 'epoch_mismatch' && staleEpoch.error.details?.currentEpoch === inspect.epoch,
    'epoch_mismatch names the current epoch',
    staleEpoch,
  );

  // 7b. An agent write survives a reload that follows immediately
  const quick = await tool('apply_patch', {
    epoch: afterReload.epoch,
    baseRevision: afterReload.revision,
    operations: [{ op: 'create', id: 'quick', type: 'rectangle', x: 2000, y: 0, width: 40, height: 40 }],
  });
  check(quick.ok, 'quick patch applied', quick);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__agentdrawMockTools?.inspect_canvas), null, { timeout: 30_000 });
  await page.waitForTimeout(800);
  inspect = await tool('inspect_canvas', {});
  check(inspect.elements.some((element) => element.id === 'quick'), 'agent write persists across an immediate reload', { count: inspect.elementCount });

  // 9. Labels: rename through update, re-layout on resize, labels on bound arrows
  let s9 = await tool('inspect_canvas', {});
  const lab = await tool('apply_patch', {
    epoch: s9.epoch,
    baseRevision: s9.revision,
    operations: [
      { op: 'create', id: 'lbl-a', type: 'rectangle', x: 3000, y: 0, width: 200, height: 100, label: { text: 'Old name' } },
      { op: 'create', id: 'lbl-b', type: 'ellipse', x: 3400, y: 0, width: 160, height: 100, label: { text: 'Target' } },
      { op: 'create', id: 'lbl-arrow', type: 'arrow', x: 0, y: 0, start: { id: 'lbl-a' }, end: { id: 'lbl-b' }, label: { text: 'yes' } },
    ],
  });
  check(lab.ok, 'labelled shapes and a labelled bound arrow created', lab);
  const arrowCreated = lab.ok ? lab.created.find((entry) => entry.id === 'lbl-arrow') : null;
  check(Boolean(arrowCreated?.boundTextId), 'bound arrow carries a label', arrowCreated);
  const labelIdBefore = lab.ok ? lab.created.find((entry) => entry.id === 'lbl-a').boundTextId : null;
  const ren = await tool('apply_patch', {
    epoch: lab.epoch,
    baseRevision: lab.revision,
    operations: [{ op: 'update', id: 'lbl-a', label: { text: 'New name' }, width: 320, height: 160 }],
  });
  check(ren.ok, 'label replaced together with a resize', ren);
  s9 = await tool('inspect_canvas', { ids: ['lbl-a', 'lbl-arrow'] });
  const renamed = s9.elements.find((element) => element.id === 'lbl-a');
  const renamedLabel = s9.elements.find((element) => element.id === labelIdBefore);
  check(renamed?.text === 'New name' && renamed?.boundTextId === labelIdBefore, 'label text replaced and its id kept', renamed);
  const centred = (inner, outer) =>
    inner && outer && Math.abs(inner.x + inner.width / 2 - (outer.x + outer.width / 2)) < 2 && Math.abs(inner.y + inner.height / 2 - (outer.y + outer.height / 2)) < 2;
  check(centred(renamedLabel, renamed), 'label re-centred in the resized container', { renamedLabel, renamed });
  const arrowAfter = s9.elements.find((element) => element.id === 'lbl-arrow');
  const arrowLabel = s9.elements.find((element) => element.id === arrowCreated?.boundTextId);
  check(
    arrowAfter?.text === 'yes' && arrowLabel && Math.abs(arrowLabel.x + arrowLabel.width / 2 - (arrowAfter.x + arrowAfter.width / 2)) < 40,
    'arrow label stays centred after the arrow was re-routed',
    { arrowAfter, arrowLabel },
  );
  const unlabel = await tool('apply_patch', {
    epoch: s9.epoch,
    baseRevision: s9.revision,
    operations: [{ op: 'update', id: 'lbl-b', label: null }],
  });
  s9 = await tool('inspect_canvas', { ids: ['lbl-b'] });
  check(unlabel.ok && s9.elements.find((element) => element.id === 'lbl-b')?.boundTextId === undefined && s9.matchedCount === 1, 'label: null removes the label', s9.elements);

  // 9b. Forward references inside one patch
  s9 = await tool('inspect_canvas', {});
  const forward = await tool('apply_patch', {
    epoch: s9.epoch,
    baseRevision: s9.revision,
    operations: [
      { op: 'create', id: 'fw-edge', type: 'arrow', x: 0, y: 0, start: { id: 'fw-a' }, end: { id: 'fw-b' }, label: { text: 'go' } },
      { op: 'create', id: 'fw-a', type: 'rectangle', x: 5000, y: 0, width: 120, height: 80, frameId: 'fw-frame' },
      { op: 'create', id: 'fw-b', type: 'ellipse', x: 5300, y: 0, width: 120, height: 80, frameId: 'fw-frame' },
      { op: 'create', id: 'fw-frame', type: 'frame', x: 4960, y: -40, width: 520, height: 160 },
    ],
  });
  s9 = await tool('inspect_canvas', { ids: ['fw-edge', 'fw-a'] });
  const fwEdge = s9.elements.find((element) => element.id === 'fw-edge');
  const fwA = s9.elements.find((element) => element.id === 'fw-a');
  check(forward.ok && fwEdge?.startBindingId === 'fw-a' && fwEdge?.endBindingId === 'fw-b' && fwA?.frameId === 'fw-frame', 'a patch may reference shapes and frames created later in it', { forward, fwEdge, fwA });
  check(fwEdge?.frameId === 'fw-frame', 'an arrow between two frame children joins the frame', fwEdge);

  // 10. Outline mode and pagination
  const full = await tool('inspect_canvas', {});
  const outline = await tool('inspect_canvas', { detail: 'outline', limit: 2 });
  check(
    outline.ok && outline.detail === 'outline' && outline.returnedCount === 2 && /^c2\.\d+$/.test(outline.nextCursor) && outline.matchedCount === full.elementCount &&
      outline.elements.every((element) => element.strokeColor === undefined && element.points === undefined && element.width !== undefined),
    'outline mode pages and drops styles and points',
    outline,
  );
  const page2 = await tool('inspect_canvas', { detail: 'outline', limit: 2, cursor: outline.nextCursor });
  check(page2.ok && page2.elements[0]?.id !== outline.elements[0]?.id && page2.elements[0]?.id === full.elements[2]?.id, 'cursor continues the listing', page2);
  const badCursor = await tool('inspect_canvas', { cursor: 'nope' });
  check(!badCursor.ok && badCursor.error.code === 'invalid_input', 'malformed cursor rejected', badCursor);
  await page.evaluate(() => {
    // The person edits between two pages.
    const api = window.__agentdrawWebMcp.bridge.api;
    api.updateScene({
      elements: api.getSceneElements().map((element, index) =>
        index === 0 ? { ...element, x: element.x + 1, version: element.version + 1, versionNonce: Math.floor(Math.random() * 1e9), updated: Date.now() } : element,
      ),
    });
  });
  await page.waitForTimeout(250);
  const expired = await tool('inspect_canvas', { detail: 'outline', limit: 2, cursor: outline.nextCursor });
  check(!expired.ok && expired.error.code === 'cursor_expired' && typeof expired.error.details?.currentRevision === 'number', 'cursor expires when the board changes between pages', expired);
  const wholeOutline = await tool('inspect_canvas', { detail: 'outline' });
  notes.push(`inspect size for ${full.elementCount} elements: full ${JSON.stringify(full.elements).length} bytes, outline ${JSON.stringify(wholeOutline.elements).length} bytes`);

  // 11. Every invalid operation reported at once
  s9 = await tool('inspect_canvas', {});
  const multi = await tool('apply_patch', {
    epoch: s9.epoch,
    baseRevision: s9.revision,
    operations: [
      { op: 'create', type: 'rectangle', x: 0, y: 0, strokeColor: '#12345' },
      { op: 'update', id: 'ghost-1', x: 1 },
      { op: 'create', type: 'ellipse', x: 0, y: 0 },
    ],
  });
  check(
    !multi.ok && multi.error.details?.errors?.length === 2 && multi.error.details.errors[1].index === 1 && multi.error.details.errors[1].code === 'shape_not_found',
    'all invalid operations are listed in details.errors',
    multi.error,
  );

  // 12. revert_patch
  s9 = await tool('inspect_canvas', {});
  const rv = await tool('apply_patch', {
    epoch: s9.epoch,
    baseRevision: s9.revision,
    operations: [
      { op: 'create', id: 'rv-new', type: 'rectangle', x: 4000, y: 0, width: 50, height: 50 },
      { op: 'update', id: 'lbl-b', x: 3500 },
      { op: 'delete', id: 'lbl-a' },
    ],
  });
  check(rv.ok && typeof rv.patchId === 'string', 'apply_patch returns a patchId', rv);
  const undo = await tool('revert_patch', { epoch: rv.epoch, baseRevision: rv.revision, patchId: rv.patchId });
  check(
    undo.ok && undo.removedIds.includes('rv-new') && undo.restoredIds.includes('lbl-a') && undo.restoredIds.includes('lbl-b') && undo.restoredIds.includes(labelIdBefore),
    'revert removes what the patch created and restores what it changed or deleted',
    undo,
  );
  s9 = await tool('inspect_canvas', { detail: 'outline' });
  const aBack = s9.elements.find((element) => element.id === 'lbl-a');
  const bBack = s9.elements.find((element) => element.id === 'lbl-b');
  check(aBack?.text === 'New name' && bBack?.x === 3400 && !s9.elements.some((element) => element.id === 'rv-new'), 'board matches the pre-patch state', { aBack, bBack });
  const rv2 = await tool('apply_patch', {
    epoch: s9.epoch,
    baseRevision: s9.revision,
    operations: [{ op: 'update', id: 'lbl-b', strokeColor: '#ff0000' }],
  });
  await page.evaluate(() => {
    // The person nudges the same shape afterwards.
    const api = window.__agentdrawWebMcp.bridge.api;
    api.updateScene({
      elements: api.getSceneElements().map((element) =>
        element.id === 'lbl-b'
          ? { ...element, x: element.x + 5, version: element.version + 1, versionNonce: Math.floor(Math.random() * 1e9), updated: Date.now() }
          : element,
      ),
    });
  });
  await page.waitForTimeout(250);
  s9 = await tool('inspect_canvas', {});
  const conflict = await tool('revert_patch', { epoch: s9.epoch, baseRevision: s9.revision, patchId: rv2.patchId });
  check(!conflict.ok && conflict.error.code === 'revert_conflict' && conflict.error.details.changedIds.includes('lbl-b'), 'revert refused after the person edited the element', conflict);
  const unknownPatch = await tool('revert_patch', { epoch: s9.epoch, baseRevision: s9.revision, patchId: 'patch-nope' });
  check(!unknownPatch.ok && unknownPatch.error.code === 'patch_not_found', 'unknown patchId rejected', unknownPatch);

  // 13. export_canvas
  const svgExport = await tool('export_canvas', { format: 'svg', ids: ['lbl-a', 'lbl-b'] });
  check(
    svgExport.ok && svgExport.mimeType === 'image/svg+xml' && svgExport.text.startsWith('<svg') && svgExport.text.includes('New name') && svgExport.chars === svgExport.text.length && svgExport.suggestedFileName === 'agentdraw.svg',
    'svg export of a subset carries its labels',
    svgExport.ok ? { chars: svgExport.chars, head: svgExport.text.slice(0, 80) } : svgExport,
  );
  const jsonExport = await tool('export_canvas', { format: 'excalidraw' });
  let parsedExport = null;
  try {
    parsedExport = JSON.parse(jsonExport.text);
  } catch {
    parsedExport = null;
  }
  const boardNow = await tool('inspect_canvas', {});
  check(
    jsonExport.ok && parsedExport?.type === 'excalidraw' && Array.isArray(parsedExport.elements) && parsedExport.elements.length === boardNow.elementCount && jsonExport.elementCount === boardNow.elementCount,
    'excalidraw export is valid and complete',
    jsonExport.ok ? { chars: jsonExport.chars, elements: parsedExport?.elements?.length, board: boardNow.elementCount } : jsonExport,
  );
  const badExport = await tool('export_canvas', { format: 'pdf' });
  check(!badExport.ok && badExport.error.code === 'invalid_input', 'unknown export format rejected', badExport);
  const ghostExport = await tool('export_canvas', { format: 'svg', ids: ['ghost-9'] });
  check(!ghostExport.ok && ghostExport.error.code === 'shape_not_found', 'export of unknown ids rejected', ghostExport);
  if (svgExport.ok) {
    const { writeFile: writeExport } = await import('node:fs/promises');
    await writeExport(`${OUT}/export-subset.svg`, svgExport.text);
    notes.push(`svg export: ${svgExport.chars} chars for ${svgExport.elementCount} elements; excalidraw export: ${jsonExport.chars} chars`);
  }

  // 14. Relative placement, move, duplicate, style, images, graph view, frame subsets, import
  let s14 = await tool('inspect_canvas', {});
  const rel = await tool('apply_patch', {
    epoch: s14.epoch,
    baseRevision: s14.revision,
    operations: [
      { op: 'create', id: 'rp-frame', type: 'frame', x: 6000, y: 0, width: 700, height: 300, name: 'Screen' },
      { op: 'create', id: 'rp-a', type: 'rectangle', x: 6040, y: 40, width: 160, height: 80, frameId: 'rp-frame', label: { text: 'Login' } },
      { op: 'create', id: 'rp-b', type: 'rectangle', at: { relativeTo: 'rp-a', side: 'right' }, width: 160, height: 80, label: { text: 'Home' } },
      { op: 'create', id: 'rp-edge', type: 'arrow', x: 0, y: 0, start: { id: 'rp-a' }, end: { id: 'rp-b' }, label: { text: 'ok' } },
    ],
  });
  s14 = await tool('inspect_canvas', { ids: ['rp-a', 'rp-b'] });
  const rpA = s14.elements.find((element) => element.id === 'rp-a');
  const rpB = s14.elements.find((element) => element.id === 'rp-b');
  check(
    rel.ok && rpA && rpB && Math.abs(rpB.x - (rpA.x + rpA.width + 40)) < 1 && Math.abs(rpB.y + rpB.height / 2 - (rpA.y + rpA.height / 2)) < 1 && rpB.frameId === 'rp-frame' && rpB.by === 'agent',
    'at places a shape beside its anchor, centred, inside the same frame, marked as the agent’s',
    { rel, rpA, rpB },
  );
  const noXY = await tool('apply_patch', { epoch: s14.epoch, baseRevision: s14.revision, operations: [{ op: 'create', type: 'rectangle', width: 10, height: 10 }] });
  check(!noXY.ok && /x is required/.test(noXY.error.message), 'x and y are required without at', noXY.error);
  const mv = await tool('apply_patch', { epoch: s14.epoch, baseRevision: s14.revision, operations: [{ op: 'move', ids: ['rp-frame'], dx: 0, dy: 500 }] });
  s14 = await tool('inspect_canvas', { frameId: 'rp-frame' });
  const movedA = s14.elements.find((element) => element.id === 'rp-a');
  check(mv.ok && movedA?.y === rpA.y + 500 && mv.updatedIds.includes('rp-frame') && mv.touchedIds.includes('rp-a'), 'move carries a frame’s children and labels', { mv, movedA });
  const dup = await tool('apply_patch', { epoch: mv.epoch, baseRevision: mv.revision, operations: [{ op: 'duplicate', ids: ['rp-a', 'rp-b', 'rp-edge'], dx: 0, dy: 400 }] });
  const dupA = dup.ok ? dup.created.find((entry) => entry.sourceId === 'rp-a') : null;
  const dupEdge = dup.ok ? dup.created.find((entry) => entry.sourceId === 'rp-edge') : null;
  s14 = dupA && dupEdge ? await tool('inspect_canvas', { ids: [dupA.id, dupEdge.id] }) : { elements: [] };
  const edgeCopy = s14.elements.find((element) => element.id === dupEdge?.id);
  const aCopy = s14.elements.find((element) => element.id === dupA?.id);
  check(
    dup.ok && dupA?.boundTextId && edgeCopy?.startBindingId === dupA.id && edgeCopy?.text === 'ok' && aCopy?.text === 'Login' && aCopy.y === movedA.y + 400,
    'duplicate copies labels and keeps arrows bound inside the copy',
    { dup, edgeCopy, aCopy },
  );
  const st = await tool('apply_patch', {
    epoch: dup.epoch,
    baseRevision: dup.revision,
    operations: [{ op: 'style', ids: ['rp-a', 'rp-b'], backgroundColor: '#a5d8ff', fillStyle: 'solid', strokeColor: '#1971c2' }],
  });
  s14 = await tool('inspect_canvas', { ids: ['rp-a'] });
  const styledA = s14.elements.find((element) => element.id === 'rp-a');
  const styledLabel = s14.elements.find((element) => element.containerId === 'rp-a');
  check(st.ok && styledA?.backgroundColor === '#a5d8ff' && styledA.strokeColor === '#1971c2' && styledLabel?.strokeColor === '#1971c2', 'style restyles shapes and their labels', { st, styledA, styledLabel });
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 120;
    const context2d = canvas.getContext('2d');
    context2d.fillStyle = '#ff8800';
    context2d.fillRect(0, 0, 240, 120);
    return canvas.toDataURL('image/png');
  });
  const img = await tool('apply_patch', {
    epoch: s14.epoch,
    baseRevision: s14.revision,
    operations: [{ op: 'create', id: 'rp-img', type: 'image', dataUrl: png, at: { relativeTo: 'rp-b', side: 'below' }, width: 120 }],
  });
  s14 = await tool('inspect_canvas', { ids: ['rp-img'] });
  const imgEl = s14.elements[0];
  check(img.ok && imgEl?.type === 'image' && imgEl.width === 120 && imgEl.height === 60 && imgEl.by === 'agent', 'image created from a data URL keeps its aspect ratio', { img, imgEl });
  const badImg = await tool('apply_patch', { epoch: s14.epoch, baseRevision: s14.revision, operations: [{ op: 'create', type: 'image', x: 0, y: 0, dataUrl: 'data:text/html;base64,AAAA' }] });
  check(!badImg.ok && badImg.error.code === 'invalid_input', 'non-image data URL rejected', badImg.error);
  const graphView = await tool('inspect_canvas', { detail: 'graph', frameId: 'rp-frame' });
  check(
    graphView.ok && graphView.graph && graphView.graph.frames.some((frame) => frame.id === 'rp-frame' && frame.children.includes('rp-a')) &&
      graphView.graph.edges.some((edge) => edge.id === 'rp-edge' && edge.from === 'rp-a' && edge.to === 'rp-b' && edge.text === 'ok') &&
      graphView.elements.every((element) => element.type !== 'arrow' && element.type !== 'frame' && !element.containerId) &&
      graphView.elements.some((element) => element.id === 'rp-a' && element.text === 'Login'),
    'graph detail returns nodes, edges, and frames',
    graphView.ok ? { nodes: graphView.elements.map((element) => element.id), graph: graphView.graph } : graphView,
  );
  const frameCap = await tool('capture_canvas', { frameId: 'rp-frame' });
  const frameSvg = await tool('export_canvas', { format: 'svg', frameId: 'rp-frame' });
  check(frameCap.ok && frameCap.elementCount >= 6 && frameSvg.ok && frameSvg.text.includes('Login') && frameSvg.elementCount === frameCap.elementCount, 'capture and export accept a frameId', { cap: frameCap.elementCount, svg: frameSvg.elementCount });
  const doc = await tool('export_canvas', { format: 'excalidraw', frameId: 'rp-frame' });
  s14 = await tool('inspect_canvas', {});
  const imp = await tool('import_scene', { epoch: s14.epoch, baseRevision: s14.revision, scene: doc.text, at: { x: 8000, y: 0 } });
  s14 = await tool('inspect_canvas', { detail: 'graph' });
  check(
    imp.ok && imp.importedCount === doc.elementCount && s14.graph.frames.filter((frame) => frame.name === 'Screen').length === 2 && imp.bounds.x === 8000,
    'import_scene appends a copy with fresh ids at the given point',
    { imp, screens: s14.graph?.frames?.length },
  );
  const beforeReplace = s14.elementCount;
  const replaced = await tool('import_scene', { epoch: s14.epoch, baseRevision: s14.revision, scene: JSON.parse(doc.text), mode: 'replace' });
  s14 = await tool('inspect_canvas', { detail: 'outline' });
  check(replaced.ok && replaced.removedCount === beforeReplace && s14.elementCount === doc.elementCount, 'import_scene replace clears the board first', { replaced, count: s14.elementCount });
  const undoImport = await tool('revert_patch', { epoch: s14.epoch, baseRevision: s14.revision, patchId: replaced.patchId });
  s14 = await tool('inspect_canvas', { detail: 'outline' });
  check(undoImport.ok && s14.elementCount === beforeReplace, 'reverting a replace import restores the board', { undoImport, count: s14.elementCount, beforeReplace });
  const badScene = await tool('import_scene', { epoch: s14.epoch, baseRevision: s14.revision, scene: '{"type":"nope"}' });
  check(!badScene.ok && badScene.error.code === 'invalid_input', 'non-excalidraw scene rejected', badScene.error);

  // 15. HTML embeds
  let s15 = await tool('inspect_canvas', {});
  const pageHtml = '<!doctype html><html><body style="font-family:system-ui;margin:0;padding:16px;background:#fff"><h1 id="t">Sign in</h1><button onclick="document.getElementById(\'t\').textContent=\'Clicked\'">Continue</button></body></html>';
  const embed = await tool('apply_patch', {
    epoch: s15.epoch,
    baseRevision: s15.revision,
    operations: [{ op: 'create', id: 'html-1', type: 'embeddable', x: 9000, y: 0, width: 360, height: 220, html: pageHtml }],
  });
  s15 = await tool('inspect_canvas', { ids: ['html-1'] });
  const htmlEl = s15.elements[0];
  check(embed.ok && htmlEl?.type === 'embeddable' && htmlEl.link === undefined && htmlEl.html?.chars === pageHtml.length && htmlEl.html.excerpt.startsWith('<!doctype html>') && htmlEl.html.text === undefined, 'html embed is created and inspect reports an excerpt, not the source', { embed, htmlEl });
  const withSource = await tool('inspect_canvas', { ids: ['html-1'], includeHtml: true });
  check(withSource.ok && withSource.elements[0]?.html?.text === pageHtml, 'includeHtml returns the full source for given ids', withSource.elements[0]?.html?.chars);
  const noIds = await tool('inspect_canvas', { includeHtml: true });
  check(!noIds.ok && noIds.error.code === 'invalid_input', 'includeHtml without ids is refused', noIds.error);
  await tool('focus_elements', { ids: ['html-1'] });
  await page.waitForTimeout(600);
  const iframeDoc = await page.evaluate(() => [...document.querySelectorAll('iframe.ad-html-embed')].map((frame) => frame.getAttribute('srcdoc') || '')[0] ?? null);
  check(typeof iframeDoc === 'string' && iframeDoc.includes('Sign in'), 'the html embed renders in a sandboxed srcdoc iframe', iframeDoc?.slice(0, 60));
  await page.screenshot({ path: `${OUT}/06-html-embed.png` });
  const rehtml = await tool('apply_patch', { epoch: withSource.epoch, baseRevision: withSource.revision, operations: [{ op: 'update', id: 'html-1', html: '<h1>Version two</h1>' }] });
  s15 = await tool('inspect_canvas', { ids: ['html-1'], includeHtml: true });
  check(rehtml.ok && s15.elements[0]?.html?.text === '<h1>Version two</h1>', 'update replaces the html', s15.elements[0]?.html);
  const both = await tool('apply_patch', { epoch: s15.epoch, baseRevision: s15.revision, operations: [{ op: 'create', type: 'embeddable', x: 0, y: 0, html: '<p>x</p>', link: 'https://example.com' }] });
  check(!both.ok && both.error.code === 'invalid_input', 'link and html together are refused', both.error);

  // 16. Fonts
  let s16 = await tool('inspect_canvas', {});
  const fonts = await tool('apply_patch', {
    epoch: s16.epoch,
    baseRevision: s16.revision,
    operations: [
      { op: 'create', id: 'font-t', type: 'text', x: 10000, y: 0, text: 'Headline', fontFamily: 'display', fontSize: 36 },
      { op: 'create', id: 'font-r', type: 'rectangle', x: 10000, y: 100, width: 220, height: 80, label: { text: 'const x = 1', fontFamily: 'code' } },
    ],
  });
  s16 = await tool('inspect_canvas', { ids: ['font-t', 'font-r'] });
  const fontT = s16.elements.find((element) => element.id === 'font-t');
  const fontLabel = s16.elements.find((element) => element.containerId === 'font-r');
  check(fonts.ok && fontT?.fontFamily === 'display' && fontT.fontSize === 36 && fontLabel?.fontFamily === 'code', 'fonts are applied on create and reported by name', { fontT, fontLabel });
  const refont = await tool('apply_patch', {
    epoch: s16.epoch,
    baseRevision: s16.revision,
    operations: [
      { op: 'update', id: 'font-t', fontFamily: 'normal', fontSize: 20, textAlign: 'right' },
      { op: 'update', id: 'font-r', label: { text: 'const x = 1', fontFamily: 'normal', fontSize: 14 } },
    ],
  });
  s16 = await tool('inspect_canvas', { ids: ['font-t', 'font-r'] });
  const fontT2 = s16.elements.find((element) => element.id === 'font-t');
  const fontLabel2 = s16.elements.find((element) => element.containerId === 'font-r');
  check(refont.ok && fontT2?.fontFamily === 'normal' && fontT2.fontSize === 20 && fontT2.text === 'Headline' && fontLabel2?.fontFamily === 'normal' && fontLabel2.fontSize === 14 && fontLabel2.id === fontLabel.id, 'fonts change on update without recreating, text and label ids kept', { fontT2, fontLabel2 });
  const badFont = await tool('apply_patch', { epoch: s16.epoch, baseRevision: s16.revision, operations: [{ op: 'update', id: 'font-r', fontSize: 30 }] });
  check(!badFont.ok && /label/.test(badFont.error.message), 'font props on a shape point the agent to label', badFont.error);

  // 8. Console hygiene
  check(consoleErrors.length === 0, 'no console errors', consoleErrors);

  await browser.close();
  for (const note of notes) console.log(note);
  for (const failure of failures) console.log(failure);
  console.log(`\n${notes.length} passed, ${failures.length} failed. Screenshots in ${OUT}/`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
