import assert from 'node:assert/strict';
import test from 'node:test';
import {
  diffVersions,
  rectsIntersect,
  samplePoints,
  summarizeElement,
  summarizeScene,
} from '../src/lib/scene-summary.ts';

const base = (overrides) => ({
  id: 'a',
  type: 'rectangle',
  x: 10.123,
  y: 20,
  width: 100,
  height: 50,
  angle: 0,
  isDeleted: false,
  version: 1,
  versionNonce: 1,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  opacity: 100,
  locked: false,
  frameId: null,
  groupIds: [],
  ...overrides,
});

test('summarizeElement rounds numbers and reports bound labels', () => {
  const rect = base({ boundElements: [{ id: 't', type: 'text' }] });
  const label = base({ id: 't', type: 'text', text: 'Hello', containerId: 'a', fontSize: 20 });
  const summary = summarizeElement(rect, [rect, label]);
  assert.equal(summary.x, 10.12);
  assert.equal(summary.text, 'Hello');
  assert.equal(summary.boundTextId, 't');
  const labelSummary = summarizeElement(label, [rect, label]);
  assert.equal(labelSummary.containerId, 'a');
  assert.equal(labelSummary.fontSize, 20);
});

test('summarizeElement makes linear points absolute and keeps bindings', () => {
  const arrow = base({
    id: 'arrow',
    type: 'arrow',
    x: 5,
    y: 5,
    points: [
      [0, 0],
      [100, 40],
    ],
    startBinding: { elementId: 'a' },
    endBinding: { elementId: 'b' },
  });
  const summary = summarizeElement(arrow, [arrow]);
  assert.deepEqual(summary.points, [
    { x: 5, y: 5 },
    { x: 105, y: 45 },
  ]);
  assert.equal(summary.startBindingId, 'a');
  assert.equal(summary.endBindingId, 'b');
});

test('summarizeScene skips deleted elements and caps huge customData', () => {
  const kept = base({ id: 'kept', customData: { note: 'ok' } });
  const gone = base({ id: 'gone', isDeleted: true });
  const heavy = base({ id: 'heavy', customData: { blob: 'x'.repeat(9000) } });
  const scene = summarizeScene([kept, gone, heavy]);
  assert.deepEqual(
    scene.map((element) => element.id),
    ['kept', 'heavy'],
  );
  assert.deepEqual(scene[0].customData, { note: 'ok' });
  assert.equal(scene[1].customData, undefined);
});

test('bounds override replaces the raw box and rectsIntersect honours padding', () => {
  const line = base({ id: 'l', type: 'line', x: 0, y: 0, width: 100, height: 0, points: [[0, 0], [50, 50], [100, 0]] });
  const summary = summarizeElement(line, [line], { x: 0, y: 0, width: 100, height: 50 });
  assert.equal(summary.height, 50);
  const a = { x: 0, y: 0, width: 10, height: 10 };
  const b = { x: 50, y: 0, width: 10, height: 10 };
  assert.equal(rectsIntersect(a, b), false);
  assert.equal(rectsIntersect(a, b, 45), true);
  const scene = summarizeScene([line], () => ({ x: 0, y: 0, width: 100, height: 50 }));
  assert.equal(scene[0].height, 50);
});

test('samplePoints preserves endpoints', () => {
  const points = Array.from({ length: 200 }, (_, index) => ({ x: index, y: 0 }));
  const sampled = samplePoints(points, 64);
  assert.equal(sampled.length, 64);
  assert.deepEqual(sampled[0], points[0]);
  assert.deepEqual(sampled.at(-1), points.at(-1));
});

test('diffVersions classifies added, updated, and removed', () => {
  const first = [base({ id: 'a', versionNonce: 1 }), base({ id: 'b', versionNonce: 1 })];
  const seen = diffVersions(new Map(), first).next;
  const second = [
    base({ id: 'a', versionNonce: 2 }),
    base({ id: 'b', versionNonce: 1, isDeleted: true }),
    base({ id: 'c', versionNonce: 1 }),
  ];
  const diff = diffVersions(seen, second);
  assert.deepEqual(diff.addedIds, ['c']);
  assert.deepEqual(diff.updatedIds, ['a']);
  assert.deepEqual(diff.removedIds, ['b']);
  const unchanged = diffVersions(diff.next, second);
  assert.deepEqual([unchanged.addedIds, unchanged.updatedIds, unchanged.removedIds], [[], [], []]);
});

test('outline keeps geometry, text, and bindings and drops styles and points', async () => {
  const { toOutline } = await import('../src/lib/scene-summary.ts');
  const outline = toOutline({
    id: 'a',
    type: 'arrow',
    x: 1,
    y: 2,
    width: 30,
    height: 4,
    angle: 0,
    strokeColor: '#000',
    backgroundColor: 'transparent',
    opacity: 100,
    locked: false,
    frameId: null,
    groupIds: [],
    text: 'yes',
    boundTextId: 't',
    startBindingId: 's',
    endBindingId: 'e',
    points: [{ x: 1, y: 2 }, { x: 31, y: 6 }],
    nearIds: [],
  });
  assert.deepEqual(outline, {
    id: 'a',
    type: 'arrow',
    x: 1,
    y: 2,
    width: 30,
    height: 4,
    text: 'yes',
    boundTextId: 't',
    startBindingId: 's',
    endBindingId: 'e',
  });
});

test('authors are read from the internal mark and the graph view folds labels into nodes', async () => {
  const { buildGraph, summarizeScene } = await import('../src/lib/scene-summary.ts');
  const scene = summarizeScene([
    base({ id: 'f', type: 'frame', name: 'Screen' }),
    base({ id: 'a', type: 'rectangle', frameId: 'f', boundElements: [{ id: 'al', type: 'text' }], customData: { agentdraw: { by: 'agent' }, note: 1 } }),
    base({ id: 'al', type: 'text', text: 'A', containerId: 'a', frameId: 'f' }),
    base({ id: 'b', type: 'ellipse' }),
    base({ id: 'e', type: 'arrow', startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' }, points: [[0, 0], [10, 10]] }),
    base({ id: 'm', type: 'freedraw', points: [[0, 0], [1, 1]] }),
  ]);
  const a = scene.find((entry) => entry.id === 'a');
  assert.equal(a.by, 'agent');
  assert.deepEqual(a.customData, { note: 1 });
  assert.equal(scene.find((entry) => entry.id === 'b').by, 'person');
  const graph = buildGraph(scene);
  assert.deepEqual(graph.nodes.map((node) => node.id), ['a', 'b']);
  assert.equal(graph.nodes[0].text, 'A');
  assert.equal(graph.nodes[0].by, 'agent');
  assert.deepEqual(graph.edges, [{ id: 'e', from: 'a', to: 'b' }]);
  assert.deepEqual(graph.frames, [{ id: 'f', name: 'Screen', children: ['a'] }]);
  assert.deepEqual(graph.marks.map((mark) => mark.id), ['m']);
});

test('html embeds are summarised, not dumped', async () => {
  const { HTML_LINK, withHtml } = await import('../src/lib/html-embed.ts');
  const { summarizeElement, toOutline } = await import('../src/lib/scene-summary.ts');
  const element = base({ id: 'e', type: 'embeddable', link: HTML_LINK, customData: withHtml(undefined, '<button>Sign in</button>') });
  const summary = summarizeElement(element, [element]);
  assert.equal(summary.link, undefined);
  assert.deepEqual(summary.html, { chars: 24, excerpt: '<button>Sign in</button>' });
  assert.equal(toOutline(summary).htmlChars, 24);
});

test('font ids come back as agent-facing names', async () => {
  const { fontFamilyName, summarizeElement } = await import('../src/lib/scene-summary.ts');
  assert.deepEqual([5, 6, 8, 7, 1, 2, 3, 9, 42].map(fontFamilyName), ['hand', 'normal', 'code', 'display', 'hand', 'normal', 'code', 'normal', 'hand']);
  const text = base({ id: 't', type: 'text', text: 'x', fontSize: 20, fontFamily: 6 });
  assert.equal(summarizeElement(text, [text]).fontFamily, 'normal');
});
