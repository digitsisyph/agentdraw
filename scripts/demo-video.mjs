#!/usr/bin/env node
/**
 * Records a deterministic AgentDraw product walkthrough (under three minutes).
 * It drives the real site and Excalidraw UI in headless Chrome while the site's
 * built-in mock WebMCP host executes the same eight tool handlers an agent gets.
 * This is a product demo, not a recording of ChatGPT or Codex.
 *
 *   pnpm build && pnpm preview     # in another terminal
 *   node scripts/demo-video.mjs    # writes outputs/demo/*
 */
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const BASE = process.env.AGENTDRAW_URL ?? 'http://localhost:4173/';
const CHROME =
  process.env.AGENTDRAW_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = 'outputs/demo';
const FRAMES = `${OUT}/frames`;
const EXPORTED_SVG = `${OUT}/signup-flow.svg`;
const SIZE = { width: 1440, height: 900 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireValue(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function requireOk(result, action) {
  if (!result?.ok) throw new Error(`${action} failed: ${JSON.stringify(result)}`);
  return result;
}

function mockHostUrl(base) {
  const url = new URL(base);
  url.searchParams.set('mock-webmcp', '1');
  return url.toString();
}

async function caption(page, message, { title = false } = {}) {
  await page.evaluate(
    ([text, isTitle]) => {
      let node = document.getElementById('demo-caption');
      if (!node) {
        node = document.createElement('div');
        node.id = 'demo-caption';
        Object.assign(node.style, {
          position: 'fixed',
          left: '50%',
          zIndex: '100000',
          maxWidth: '82vw',
          borderRadius: '16px',
          background: 'rgba(24, 24, 27, 0.92)',
          color: '#fff',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: '650',
          lineHeight: '1.35',
          letterSpacing: '-0.01em',
          textAlign: 'center',
          whiteSpace: 'pre-line',
          boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
          transition: 'opacity 240ms ease',
          pointerEvents: 'none',
        });
        document.body.append(node);
      }
      node.style.opacity = text ? '1' : '0';
      node.textContent = text;
      if (isTitle) {
        Object.assign(node.style, {
          bottom: 'auto',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          fontSize: '34px',
          padding: '26px 40px',
        });
      } else {
        Object.assign(node.style, {
          bottom: '76px',
          top: 'auto',
          transform: 'translateX(-50%)',
          fontSize: '21px',
          padding: '13px 21px',
        });
      }
    },
    [message, title],
  );
}

async function addDemoBadge(page) {
  await page.evaluate(() => {
    document.getElementById('demo-mode')?.remove();
    const badge = document.createElement('div');
    badge.id = 'demo-mode';
    badge.textContent = 'DETERMINISTIC DEMO · MOCK WEBMCP HOST';
    Object.assign(badge.style, {
      position: 'fixed',
      left: '68px',
      top: '16px',
      zIndex: '99999',
      border: '1px solid rgba(112,72,232,0.28)',
      borderRadius: '999px',
      background: 'rgba(255,255,255,0.94)',
      color: '#5f3dc4',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      fontSize: '11px',
      fontWeight: '750',
      letterSpacing: '0.055em',
      padding: '7px 10px',
      boxShadow: '0 4px 18px rgba(0,0,0,0.1)',
      pointerEvents: 'none',
    });
    document.body.append(badge);
  });
}

async function emphasizeAgentPill(page, enabled) {
  await page.evaluate((active) => {
    const pill = document.querySelector('[data-testid="agent-pill"]');
    if (!pill) return;
    pill.style.transition = 'transform 300ms ease, box-shadow 300ms ease';
    pill.style.transform = active ? 'scale(1.24)' : '';
    pill.style.boxShadow = active ? '0 0 0 6px rgba(47,163,107,0.22)' : '';
  }, enabled);
}

async function showCapture(page, dataUrl) {
  await page.evaluate((src) => {
    document.getElementById('demo-capture')?.remove();
    const wrapper = document.createElement('div');
    wrapper.id = 'demo-capture';
    Object.assign(wrapper.style, {
      position: 'fixed',
      right: '24px',
      bottom: '88px',
      zIndex: '100000',
      width: '390px',
      padding: '10px',
      borderRadius: '14px',
      background: '#fff',
      boxShadow: '0 12px 40px rgba(0,0,0,0.3)',
      border: '1px solid #e5e5e5',
      pointerEvents: 'none',
    });
    const label = document.createElement('div');
    label.textContent = 'capture_canvas → pixels returned to the agent';
    Object.assign(label.style, {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '13px',
      fontWeight: '650',
      marginBottom: '8px',
      color: '#333',
    });
    const image = document.createElement('img');
    image.src = src;
    Object.assign(image.style, {
      width: '100%',
      display: 'block',
      borderRadius: '8px',
      border: '1px solid #eee',
    });
    wrapper.append(label, image);
    document.body.append(wrapper);
  }, dataUrl);
}

async function hideCapture(page) {
  await page.evaluate(() => document.getElementById('demo-capture')?.remove());
}

async function showSvgPreview(page, svgText) {
  await page.evaluate((svg) => {
    document.getElementById('demo-export')?.remove();
    const wrapper = document.createElement('div');
    wrapper.id = 'demo-export';
    Object.assign(wrapper.style, {
      position: 'fixed',
      inset: '54px 110px 86px',
      zIndex: '100001',
      display: 'flex',
      flexDirection: 'column',
      borderRadius: '20px',
      background: '#fff',
      boxShadow: '0 20px 80px rgba(0,0,0,0.38)',
      border: '1px solid #ddd',
      overflow: 'hidden',
      pointerEvents: 'none',
    });
    const header = document.createElement('div');
    header.textContent = 'export_canvas → outputs/demo/signup-flow.svg';
    Object.assign(header.style, {
      flex: '0 0 auto',
      padding: '14px 18px',
      borderBottom: '1px solid #eee',
      color: '#343a40',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '14px',
      fontWeight: '650',
    });
    const stage = document.createElement('div');
    Object.assign(stage.style, {
      minHeight: '0',
      flex: '1 1 auto',
      display: 'grid',
      placeItems: 'center',
      padding: '20px',
      background: '#f8f9fa',
    });
    const image = document.createElement('img');
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    wrapper.dataset.objectUrl = url;
    image.src = url;
    image.alt = 'Exported signup flow SVG';
    Object.assign(image.style, {
      maxWidth: '100%',
      maxHeight: '100%',
      display: 'block',
      borderRadius: '10px',
      background: '#fff',
    });
    stage.append(image);
    wrapper.append(header, stage);
    document.body.append(wrapper);
  }, svgText);
  await page.waitForFunction(() => document.querySelector('#demo-export img')?.complete);
}

async function hideSvgPreview(page) {
  await page.evaluate(() => {
    const wrapper = document.getElementById('demo-export');
    if (!wrapper) return;
    if (wrapper.dataset.objectUrl) URL.revokeObjectURL(wrapper.dataset.objectUrl);
    wrapper.remove();
  });
}

async function startScreencast(context, page) {
  const cdp = await context.newCDPSession(page);
  const frames = [];
  let index = 0;
  let writing = Promise.resolve();
  // Wall-clock receipt time: Chrome's frame timestamps stall while nothing repaints.
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    const path = `${FRAMES}/f-${String(index++).padStart(6, '0')}.jpg`;
    frames.push({ path, ts: performance.now() / 1000 });
    writing = writing.then(() => writeFile(path, Buffer.from(data, 'base64')));
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 88,
    maxWidth: SIZE.width,
    maxHeight: SIZE.height,
    everyNthFrame: 1,
  });
  return {
    async stop() {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await writing;
      return frames;
    },
  };
}

async function assemble(frames) {
  if (frames.length < 2) throw new Error('Too few frames were captured.');
  const lines = [];
  for (let index = 0; index < frames.length; index += 1) {
    const next = frames[index + 1];
    const duration = next ? Math.max(0.02, next.ts - frames[index].ts) : 2.5;
    lines.push(
      `file '${frames[index].path.replace(`${OUT}/`, '')}'`,
      `duration ${duration.toFixed(4)}`,
    );
  }
  lines.push(`file '${frames[frames.length - 1].path.replace(`${OUT}/`, '')}'`);
  await writeFile(`${OUT}/frames.txt`, `${lines.join('\n')}\n`);
  const result = spawnSync(
    'ffmpeg',
    [
      '-y', '-v', 'error',
      '-f', 'concat', '-safe', '0', '-i', 'frames.txt',
      '-vf',
      `scale=${SIZE.width}:${SIZE.height}:force_original_aspect_ratio=decrease,pad=${SIZE.width}:${SIZE.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
      '-fps_mode', 'vfr',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart',
      'agentdraw-demo.mp4',
    ],
    { cwd: OUT, stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('ffmpeg failed to assemble the video.');
}

function prototypeHtml({ google = false } = {}) {
  const googleButton = google
    ? '<button id="google" type="button">Continue with Google</button><div class="or">or</div>'
    : '';
  const googleScript = google
    ? "document.getElementById('google').addEventListener('click',function(){document.getElementById('msg').textContent='Google sign-in selected';});"
    : '';
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8f7ff; color: #212529; font-family: Inter, system-ui, sans-serif; }
      main { width: min(320px, calc(100vw - 28px)); padding: 24px; border: 1px solid #ded8f7; border-radius: 18px; background: white; box-shadow: 0 14px 38px rgba(61,42,120,.12); }
      h1 { margin: 0 0 6px; font-size: 24px; }
      p { margin: 0 0 18px; color: #6c757d; font-size: 13px; }
      label { display: block; margin: 10px 0 5px; font-size: 12px; font-weight: 700; }
      input { width: 100%; height: 38px; border: 1px solid #ced4da; border-radius: 9px; padding: 0 10px; font: inherit; }
      button { width: 100%; height: 40px; margin-top: 14px; border: 0; border-radius: 9px; background: #7048e8; color: white; font: 700 14px system-ui; cursor: pointer; }
      #google { margin-top: 0; border: 1px solid #ced4da; background: white; color: #343a40; }
      .or { margin: 10px 0 -4px; color: #adb5bd; text-align: center; font-size: 11px; }
      #msg { min-height: 18px; margin-top: 12px; color: #2b8a3e; font-size: 12px; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <h1>Create account</h1>
      <p>Start your AgentDraw workspace.</p>
      ${googleButton}
      <form id="signup">
        <label for="name">Name</label><input id="name" value="Ada Lovelace">
        <label for="email">Email</label><input id="email" type="email" value="ada@example.com">
        <label for="password">Password</label><input id="password" type="password" value="agentdraw">
        <button id="create" type="submit">Create account</button>
      </form>
      <div id="msg" aria-live="polite"></div>
    </main>
    <script>
      document.getElementById('signup').addEventListener('submit', function(event) {
        event.preventDefault();
        document.getElementById('msg').textContent = 'Check your inbox';
      });
      ${googleScript}
    </script>
  </body>
</html>`;
}

async function drawEllipse(page, center, radiusX, radiusY) {
  await page.keyboard.press('7');
  await page.mouse.move(center.x + radiusX, center.y);
  await page.mouse.down();
  for (let step = 1; step <= 48; step += 1) {
    const angle = (step / 48) * Math.PI * 2;
    await page.mouse.move(
      center.x + radiusX * Math.cos(angle),
      center.y + radiusY * Math.sin(angle),
      { steps: 2 },
    );
  }
  await page.mouse.up();
  await page.keyboard.press('Escape');
}

async function drawPolyline(page, points) {
  await page.keyboard.press('7');
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (let index = 1; index < points.length; index += 1) {
    await page.mouse.move(points[index].x, points[index].y, { steps: 10 });
  }
  await page.mouse.up();
  await page.keyboard.press('Escape');
}

async function main() {
  await rm(FRAMES, { recursive: true, force: true });
  await mkdir(FRAMES, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1 });
  const origin = new URL(BASE).origin;
  await context
    .grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
    .catch(() => {});
  const page = await context.newPage();

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.excalidraw', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="agent-pill"][data-status="unavailable"]', {
    timeout: 15_000,
  });
  await sleep(700);

  const screencast = await startScreencast(context, page);

  await caption(
    page,
    'AgentDraw\nDeterministic product walkthrough\n(mock WebMCP host — not a ChatGPT recording)',
    { title: true },
  );
  await sleep(3200);
  await caption(page, '');
  await sleep(500);

  // Start exactly where a new person starts: disconnected, with one prompt to copy.
  await caption(page, 'Paste one prompt. Nothing to install.');
  const copyButton = page.locator('.ad-welcome__prompt-copy');
  await copyButton.click();
  await page.waitForFunction(
    () => document.querySelector('.ad-welcome__prompt-copy')?.textContent?.includes('Copied'),
    null,
    { timeout: 5000 },
  );
  await sleep(1800);

  // Reload with the deterministic host. This exercises the production tool handlers,
  // but the visible badge makes it impossible to mistake this for ChatGPT or Codex.
  await page.goto(mockHostUrl(BASE), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.excalidraw', { timeout: 15_000 });
  await page.waitForFunction(() => Boolean(window.__agentdrawMockTools?.export_canvas), null, {
    timeout: 30_000,
  });
  await page.waitForSelector('[data-testid="agent-pill"][data-status="available"]', {
    timeout: 15_000,
  });
  await addDemoBadge(page);
  await emphasizeAgentPill(page, true);
  await caption(page, 'Connected: the browser has registered all eight AgentDraw tools.');
  await sleep(2300);
  await caption(
    page,
    'get_capabilities · inspect_canvas · apply_patch · revert_patch\nimport_scene · focus_elements · capture_canvas · export_canvas',
  );
  await sleep(3000);
  await emphasizeAgentPill(page, false);

  const tool = (name, input) =>
    page.evaluate(
      ([toolName, toolInput]) => window.__agentdrawMockTools[toolName].execute(toolInput),
      [name, input],
    );
  const canvasBox = async () =>
    requireValue(
      await page.locator('canvas.excalidraw__canvas.interactive').first().boundingBox(),
      'Could not locate the interactive Excalidraw canvas.',
    );
  const screenPoint = (view, box, x, y) => ({
    x: box.x + (x - view.viewport.x) * view.viewport.zoom,
    y: box.y + (y - view.viewport.y) * view.viewport.zoom,
  });

  let state = requireOk(await tool('inspect_canvas', {}), 'initial inspect_canvas');
  const applyOperations = async (operations, action) => {
    const result = requireOk(
      await tool('apply_patch', {
        epoch: state.epoch,
        baseRevision: state.revision,
        operations,
      }),
      action,
    );
    state = result;
    return result;
  };

  // Build a framed signup flow, one atomic patch at a time.
  await caption(page, 'You: “Draw a four-step signup flow in a frame.”');
  await sleep(1900);
  await caption(page, 'Agent → inspect_canvas, then revision-guarded apply_patch');
  await applyOperations(
    [
      {
        op: 'create', id: 'flow', type: 'frame',
        x: 60, y: 140, width: 1320, height: 330, name: 'Signup flow',
      },
    ],
    'create flow frame',
  );
  const flowSteps = [
    { id: 'landing', x: 110, label: 'Landing', color: '#d0ebff' },
    { id: 'account', x: 450, label: 'Create account', color: '#e5dbff' },
    { id: 'verify', x: 790, label: 'Verify email', color: '#fff3bf' },
    { id: 'welcome', x: 1130, label: 'Welcome', color: '#d3f9d8' },
  ];
  for (const step of flowSteps) {
    await applyOperations(
      [{
        op: 'create', id: step.id, type: 'rectangle', x: step.x, y: 240,
        width: 200, height: 90, label: { text: step.label },
        backgroundColor: step.color, fillStyle: 'solid', roundness: 'round', frameId: 'flow',
      }],
      `create ${step.id}`,
    );
    await sleep(420);
  }
  const connections = [
    ['next-1', 'landing', 'account'],
    ['next-2', 'account', 'verify'],
    ['next-3', 'verify', 'welcome'],
  ];
  for (const [id, from, to] of connections) {
    await applyOperations(
      [{
        op: 'create', id, type: 'arrow', x: 0, y: 0,
        start: { id: from }, end: { id: to }, label: { text: 'Next' }, frameId: 'flow',
      }],
      `connect ${from} to ${to}`,
    );
    await sleep(420);
  }
  requireOk(await tool('focus_elements', { ids: ['flow'] }), 'focus signup flow');
  await page.keyboard.press('Escape');
  await sleep(2600);

  // A person circles a node with the real pencil. The target is chosen from the
  // newest human mark's nearIds, not from a hard-coded visual coordinate alone.
  await caption(page, 'You circle the third step: “Rename this Confirm email and highlight it.”');
  await sleep(1600);
  const beforeCircle = requireOk(await tool('inspect_canvas', {}), 'inspect before circle');
  const verifyElement = requireValue(
    beforeCircle.elements.find((element) => element.id === 'verify'),
    'Verify-email step is missing.',
  );
  const box = await canvasBox();
  const center = screenPoint(
    beforeCircle, box,
    verifyElement.x + verifyElement.width / 2,
    verifyElement.y + verifyElement.height / 2,
  );
  await page.mouse.click(box.x + 1280, box.y + 760);
  await page.keyboard.press('Escape');
  await drawEllipse(
    page,
    center,
    (verifyElement.width / 2 + 18) * beforeCircle.viewport.zoom,
    (verifyElement.height / 2 + 20) * beforeCircle.viewport.zoom,
  );
  await sleep(900);
  const afterCircle = requireOk(await tool('inspect_canvas', {}), 'inspect human circle');
  const newestHumanMark = requireValue(
    afterCircle.elements
      .filter((element) => element.type === 'freedraw' && element.by === 'person')
      .at(-1),
    'The human pencil circle was not detected.',
  );
  const nearIds = new Set(newestHumanMark.nearIds ?? []);
  const circledRectangle = requireValue(
    afterCircle.elements.find(
      (element) =>
        element.type === 'rectangle' && nearIds.has(element.id) && element.text === 'Verify email',
    ),
    `nearIds did not identify the Verify email rectangle: ${JSON.stringify([...nearIds])}`,
  );
  await caption(
    page,
    `inspect_canvas: newest human mark → nearIds → rectangle “${circledRectangle.text}”`,
  );
  await sleep(1700);
  state = afterCircle;
  await applyOperations(
    [{
      op: 'update', id: circledRectangle.id, label: { text: 'Confirm email' },
      strokeColor: '#7048e8', backgroundColor: '#ffec99', fillStyle: 'solid', strokeWidth: 3,
    }],
    'rename and highlight circled step',
  );
  await sleep(2500);

  // Agent patches and human edits share Excalidraw's native undo stack.
  await caption(page, 'One undo stack: Cmd+Z removes the agent patch; redo restores it.');
  await page.mouse.click(box.x + 1280, box.y + 760);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+z');
  await sleep(1600);
  const undone = requireOk(await tool('inspect_canvas', { ids: ['verify'] }), 'inspect undo');
  if (undone.elements[0]?.text !== 'Verify email') {
    throw new Error(`Undo did not restore the old label: ${JSON.stringify(undone.elements[0])}`);
  }
  await page.keyboard.press('Meta+Shift+z');
  await sleep(1700);
  const redone = requireOk(await tool('inspect_canvas', { ids: ['verify'] }), 'inspect redo');
  if (redone.elements[0]?.text !== 'Confirm email') {
    throw new Error(`Redo did not restore the agent patch: ${JSON.stringify(redone.elements[0])}`);
  }

  // The prototype is a self-contained iframe: no server-side rendering and no
  // network dependency. The click is performed inside the real sandboxed iframe.
  await caption(page, 'You: “Put a working signup prototype beside the flow.”');
  await sleep(1700);
  const htmlV1 = prototypeHtml();
  state = requireOk(await tool('inspect_canvas', {}), 'inspect before HTML prototype');
  await applyOperations(
    [{
      op: 'create', id: 'signup-prototype', type: 'embeddable',
      at: { relativeTo: 'flow', side: 'right', gap: 80, align: 'start' },
      width: 360, height: 420, html: htmlV1,
    }],
    'create interactive HTML prototype',
  );
  requireOk(await tool('focus_elements', { ids: ['signup-prototype'] }), 'focus HTML prototype');
  await sleep(2200);
  const iframe = page.locator('iframe.ad-html-embed').first();
  const iframeBox = requireValue(await iframe.boundingBox(), 'HTML prototype iframe is missing.');
  await page.mouse.move(iframeBox.x + iframeBox.width / 2, iframeBox.y + iframeBox.height / 2);
  await page.mouse.click(iframeBox.x + iframeBox.width / 2, iframeBox.y + iframeBox.height / 2);
  await sleep(350);
  await caption(page, 'It is live HTML: click Create account and the prototype responds.');
  const frame = page.frameLocator('iframe.ad-html-embed');
  await frame.locator('#create').click();
  await frame.locator('#msg').waitFor({ state: 'visible' });
  const confirmation = await frame.locator('#msg').textContent();
  if (confirmation?.trim() !== 'Check your inbox') {
    throw new Error(`Interactive prototype did not respond: ${JSON.stringify(confirmation)}`);
  }
  await sleep(2400);

  // Updating HTML is one reversible patch. Remember its patchId for the later
  // selective rollback rather than relying on undo-stack position.
  await caption(page, 'You: “Add a Google sign-in button.” Agent replaces the HTML in one patch.');
  const htmlRead = requireOk(
    await tool('inspect_canvas', { ids: ['signup-prototype'], includeHtml: true }),
    'inspect prototype HTML',
  );
  if (htmlRead.elements[0]?.html?.text !== htmlV1) {
    throw new Error('inspect_canvas(includeHtml) did not return the current prototype source.');
  }
  state = htmlRead;
  const htmlV2 = prototypeHtml({ google: true });
  const googlePatch = await applyOperations(
    [{ op: 'update', id: 'signup-prototype', html: htmlV2 }],
    'add Google button',
  );
  const googlePatchId = requireValue(googlePatch.patchId, 'Google-button patch has no patchId.');
  await sleep(2600);
  if ((await frame.locator('#google').count()) !== 1) {
    throw new Error('Google button is not visible after the HTML patch.');
  }

  // A second human pencil mark expresses the return path. Graph inspection reads
  // structure; capture_canvas returns pixels; apply_patch turns intent into a
  // clean, bound arrow without deleting either human mark.
  await caption(page, 'You sketch a return loop. The agent reads both graph structure and pixels.');
  requireOk(await tool('focus_elements', { ids: ['flow'] }), 'focus flow before loop');
  await page.keyboard.press('Escape');
  await sleep(1000);
  const beforeLoop = requireOk(await tool('inspect_canvas', {}), 'inspect before loop');
  const loopBox = await canvasBox();
  const welcome = requireValue(
    beforeLoop.elements.find((element) => element.id === 'welcome'),
    'Welcome step is missing.',
  );
  const landing = requireValue(
    beforeLoop.elements.find((element) => element.id === 'landing'),
    'Landing step is missing.',
  );
  const welcomeBottom = screenPoint(
    beforeLoop, loopBox,
    welcome.x + welcome.width / 2,
    welcome.y + welcome.height + 8,
  );
  const landingBottom = screenPoint(
    beforeLoop, loopBox,
    landing.x + landing.width / 2,
    landing.y + landing.height + 8,
  );
  const lowerY = screenPoint(beforeLoop, loopBox, 0, 420).y;
  await page.mouse.click(loopBox.x + 1280, loopBox.y + 760);
  await page.keyboard.press('Escape');
  await drawPolyline(page, [
    welcomeBottom,
    { x: welcomeBottom.x + 4, y: lowerY - 8 },
    { x: welcomeBottom.x - 230, y: lowerY + 8 },
    { x: landingBottom.x + 240, y: lowerY - 5 },
    { x: landingBottom.x, y: landingBottom.y + 6 },
    { x: landingBottom.x + 22, y: landingBottom.y + 26 },
    { x: landingBottom.x, y: landingBottom.y + 6 },
    { x: landingBottom.x + 34, y: landingBottom.y + 2 },
  ]);
  await sleep(900);
  const graphState = requireOk(
    await tool('inspect_canvas', { detail: 'graph' }),
    'inspect graph after human loop',
  );
  // In graph detail, nodes are the paged `elements`; edge/frame/mark lists live
  // under `graph` so large node sets can use the normal cursor contract.
  const graphNodes = graphState.elements ?? [];
  const graphEdges = graphState.graph?.edges ?? [];
  const graphMarks = graphState.graph?.marks ?? [];
  const landingNode = requireValue(
    graphNodes.find((node) => node.id === 'landing' && node.text === 'Landing'),
    'Graph view did not expose the Landing node.',
  );
  const welcomeNode = requireValue(
    graphNodes.find((node) => node.id === 'welcome' && node.text === 'Welcome'),
    'Graph view did not expose the Welcome node.',
  );
  const capture = requireOk(
    await tool('capture_canvas', { frameId: 'flow' }),
    'capture signup flow',
  );
  await caption(
    page,
    `graph: ${graphNodes.length} nodes · ${graphEdges.length} edges · ${graphMarks.length} human marks`,
  );
  await showCapture(page, capture.dataUrl);
  await sleep(3600);
  await hideCapture(page);

  state = graphState;
  await applyOperations(
    [{
      op: 'create', id: 'start-over', type: 'arrow', x: 1230, y: 335,
      points: [[0, 0], [0, 90], [-1120, 90], [-1120, 0]],
      start: { id: welcomeNode.id }, end: { id: landingNode.id },
      label: { text: 'Start over' }, strokeStyle: 'dashed', strokeColor: '#7048e8', frameId: 'flow',
    }],
    'add clean bound return arrow',
  );
  await caption(page, 'The sketch stays. A clean, bound “Start over” arrow is added beside it.');
  await sleep(2600);

  // export_canvas returns SVG text; this deterministic harness writes the exact
  // returned text to disk, then previews that same file content on screen.
  await caption(page, 'You: “Export the signup flow as SVG into my repository.”');
  await sleep(1500);
  const exported = requireOk(
    await tool('export_canvas', { format: 'svg', frameId: 'flow' }),
    'export signup flow SVG',
  );
  await writeFile(EXPORTED_SVG, exported.text, 'utf8');
  await showSvgPreview(page, exported.text);
  await sleep(3800);
  await hideSvgPreview(page);

  // Selective rollback uses the remembered Google patch id. Changes made after
  // it—including both human marks and the clean return arrow—remain untouched.
  await caption(page, 'You: “Remove only the Google button.” Agent → revert_patch(patchId).');
  const beforeRevert = requireOk(await tool('inspect_canvas', {}), 'inspect before revert');
  const reverted = requireOk(
    await tool('revert_patch', {
      epoch: beforeRevert.epoch,
      baseRevision: beforeRevert.revision,
      patchId: googlePatchId,
    }),
    'selectively revert Google-button patch',
  );
  state = reverted;
  requireOk(await tool('focus_elements', { ids: ['signup-prototype'] }), 'focus reverted prototype');
  await sleep(1900);
  if ((await frame.locator('#google').count()) !== 0) {
    throw new Error('Selective revert left the Google button in the prototype.');
  }
  if ((await frame.locator('#create').count()) !== 1) {
    throw new Error('Selective revert removed the signup form too.');
  }
  const afterRevert = requireOk(await tool('inspect_canvas', {}), 'inspect after revert');
  const preservedMarks = afterRevert.elements.filter(
    (element) => element.type === 'freedraw' && element.by === 'person',
  );
  if (preservedMarks.length < 2 || !afterRevert.elements.some((element) => element.id === 'start-over')) {
    throw new Error('Selective revert did not preserve later human and agent changes.');
  }
  await caption(page, 'Google patch reverted. The form, both human marks, and later arrow remain.');
  await sleep(2800);

  requireOk(
    await tool('focus_elements', { ids: ['flow', 'signup-prototype'] }),
    'focus final canvas',
  );
  await sleep(1200);
  await caption(
    page,
    'AgentDraw\nExcalidraw + WebMCP\n8 tools · local-first · MIT\nagentdraw.app\n\nDeterministic demo using the built-in mock host',
    { title: true },
  );
  await sleep(4300);

  const frames = await screencast.stop();
  await context.close();
  await browser.close();
  await assemble(frames);
  await rm(FRAMES, { recursive: true, force: true });
  await rm(`${OUT}/frames.txt`, { force: true });
  console.log(
    `Recorded ${OUT}/agentdraw-demo.mp4 from ${frames.length} frames; exported ${EXPORTED_SVG}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
