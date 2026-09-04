import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_OPERATIONS,
  PatchError,
  normalizeOperations,
  operationJsonSchema,
} from '../src/lib/patch-schema.ts';

const context = () => {
  let counter = 0;
  return {
    existing: new Map([
      ['box', { type: 'rectangle', locked: false, containerId: null }],
      ['frame1', { type: 'frame', locked: false, containerId: null }],
      ['locked', { type: 'ellipse', locked: true, containerId: null }],
      ['label', { type: 'text', locked: false, containerId: 'box' }],
      ['title', { type: 'text', locked: false, containerId: null }],
    ]),
    newId: () => `gen${(counter += 1)}`,
  };
};

const fails = (input, code) => {
  assert.throws(
    () => normalizeOperations(input, context()),
    (error) => error instanceof PatchError && error.code === code,
    `expected ${code}`,
  );
};

test('creates shapes, labels, arrows with bindings, and frames', () => {
  const ops = normalizeOperations(
    [
      { op: 'create', type: 'rectangle', x: 0, y: 0, width: 200, height: 100, label: { text: 'Login' }, backgroundColor: '#a5d8ff' },
      { op: 'create', id: 'next', type: 'ellipse', x: 400, y: 0, width: 120, height: 120 },
      { op: 'create', type: 'arrow', x: 0, y: 0, start: { id: 'box' }, end: { id: 'next' }, endArrowhead: 'arrow' },
      { op: 'create', type: 'frame', x: -20, y: -20, width: 800, height: 400, name: 'Flow' },
      { op: 'create', type: 'text', x: 10, y: 10, text: 'Step 1', fontSize: 24 },
      { op: 'create', type: 'embeddable', x: 0, y: 500, width: 640, height: 480, link: 'http://localhost:5173' },
    ],
    context(),
  );
  const byType = (type) => ops.find((op) => op.spec.type === type);
  assert.equal(ops.length, 6);
  assert.equal(byType('rectangle').spec.id, 'gen1');
  assert.deepEqual(byType('rectangle').spec.label, { text: 'Login' });
  assert.deepEqual(byType('arrow').spec.start, { id: 'box' });
  assert.deepEqual(byType('arrow').spec.end, { id: 'next' });
  assert.equal(byType('frame').spec.name, 'Flow');
  assert.equal(byType('embeddable').spec.link, 'http://localhost:5173');
  assert.equal(ops[0].spec.type, 'frame');
  assert.equal(ops.at(-1).spec.type, 'arrow');
});

test('rejects unknown fields, bad types, and misplaced text', () => {
  fails([{ op: 'create', type: 'rectangle', x: 0, y: 0, bogus: 1 }], 'invalid_input');
  fails([{ op: 'create', type: 'sticker', x: 0, y: 0 }], 'invalid_input');
  fails([{ op: 'create', type: 'rectangle', x: 0, y: 0, text: 'no' }], 'invalid_input');
  fails([{ op: 'create', type: 'text', x: 0, y: 0, text: '   ' }], 'invalid_input');
  fails([{ op: 'create', type: 'embeddable', x: 0, y: 0 }], 'invalid_input');
  fails([{ op: 'create', type: 'embeddable', x: 0, y: 0, link: 'javascript:alert(1)' }], 'invalid_url');
  fails([{ op: 'paint', id: 'box' }], 'invalid_input');
});

test('rejects references to missing, locked, or duplicated elements', () => {
  fails([{ op: 'update', id: 'nope', x: 1 }], 'shape_not_found');
  fails([{ op: 'delete', id: 'locked' }], 'shape_locked');
  fails([{ op: 'create', id: 'box', type: 'rectangle', x: 0, y: 0 }], 'duplicate_shape_id');
  fails([{ op: 'create', type: 'arrow', x: 0, y: 0, start: { id: 'ghost' } }], 'shape_not_found');
  fails([{ op: 'create', type: 'rectangle', x: 0, y: 0, frameId: 'box' }], 'invalid_input');
  fails([{ op: 'create', type: 'rectangle', x: 0, y: 0, frameId: 'ghost' }], 'shape_not_found');
  fails(
    [
      { op: 'delete', id: 'box' },
      { op: 'update', id: 'box', x: 1 },
    ],
    'shape_not_found',
  );
});

test('update accepts text only on free text elements and needs a change', () => {
  const ops = normalizeOperations([{ op: 'update', id: 'title', text: 'Renamed', x: 5 }], context());
  assert.equal(ops[0].spec.text, 'Renamed');
  fails([{ op: 'update', id: 'box', text: 'no' }], 'invalid_input');
  fails([{ op: 'update', id: 'label', text: 'no' }], 'invalid_input');
  fails([{ op: 'update', id: 'box' }], 'invalid_input');
  fails([{ op: 'update', id: 'box', name: 'x' }], 'invalid_input');
});

test('enforces the operation count limit and exposes a JSON schema', () => {
  const tooMany = Array.from({ length: MAX_OPERATIONS + 1 }, () => ({ op: 'delete', id: 'box' }));
  fails(tooMany, 'invalid_input');
  const schema = operationJsonSchema();
  assert.equal(schema.oneOf.length, 6);
  assert.deepEqual(schema.oneOf[0].required, ['op', 'type']);
  assert.deepEqual(schema.oneOf.map((entry) => entry.properties.op.const), ['create', 'update', 'delete', 'move', 'duplicate', 'style']);
});

test('accepts only 3, 4, 6, or 8 hex digit colors', () => {
  for (const color of ['#abc', '#abcd', '#aabbcc', '#aabbccdd', 'transparent']) {
    const [op] = normalizeOperations([{ op: 'create', type: 'rectangle', x: 0, y: 0, strokeColor: color }], context());
    assert.equal(op.spec.strokeColor, color);
  }
  for (const color of ['#12345', '#ab', '#abcdefg', 'red', 'rgb(1,2,3)']) {
    fails([{ op: 'create', type: 'rectangle', x: 0, y: 0, strokeColor: color }], 'invalid_input');
  }
});

test('rejects references to elements deleted earlier in the same patch', () => {
  fails(
    [
      { op: 'delete', id: 'box' },
      { op: 'create', type: 'arrow', x: 0, y: 0, start: { id: 'box' }, end: { x: 100, y: 100 } },
    ],
    'shape_not_found',
  );
  fails(
    [
      { op: 'delete', id: 'frame1' },
      { op: 'create', type: 'rectangle', x: 0, y: 0, frameId: 'frame1' },
    ],
    'shape_not_found',
  );
  fails(
    [
      { op: 'delete', id: 'frame1' },
      { op: 'update', id: 'box', frameId: 'frame1' },
    ],
    'shape_not_found',
  );
});

test('frameId must point at a frame, including ones created in the same patch', () => {
  fails(
    [
      { op: 'create', id: 'notAFrame', type: 'rectangle', x: 0, y: 0 },
      { op: 'create', type: 'ellipse', x: 0, y: 0, frameId: 'notAFrame' },
    ],
    'invalid_input',
  );
  fails([{ op: 'update', id: 'box', frameId: 'title' }], 'invalid_input');
  const ops = normalizeOperations(
    [
      { op: 'create', id: 'f', type: 'frame', x: 0, y: 0, width: 400, height: 300 },
      { op: 'create', type: 'ellipse', x: 10, y: 10, frameId: 'f' },
      { op: 'update', id: 'box', frameId: 'f' },
    ],
    context(),
  );
  assert.equal(ops[1].spec.frameId, 'f');
  assert.equal(ops[2].spec.frameId, 'f');
});

test('arrows bind only to bindable targets and never to themselves; lines never bind', () => {
  fails([{ op: 'create', type: 'line', x: 0, y: 0, start: { id: 'box' }, end: { x: 10, y: 10 } }], 'invalid_input');
  fails([{ op: 'create', type: 'arrow', x: 0, y: 0, start: { id: 'box' }, end: { id: 'box' } }], 'invalid_input');
  fails([{ op: 'create', type: 'arrow', x: 0, y: 0, start: { id: 'box' }, end: { id: 'label' } }], 'invalid_input');
  fails(
    [
      { op: 'create', id: 'a1', type: 'arrow', x: 0, y: 0, points: [[0, 0], [10, 10]] },
      { op: 'create', type: 'arrow', x: 0, y: 0, start: { id: 'a1' }, end: { id: 'box' } },
    ],
    'invalid_input',
  );
  const [op] = normalizeOperations(
    [{ op: 'create', type: 'arrow', x: 0, y: 0, start: { id: 'box' }, end: { id: 'frame1' } }],
    context(),
  );
  assert.deepEqual(op.spec.end, { id: 'frame1' });
});

test('points stay within the coordinate limit', () => {
  fails([{ op: 'create', type: 'line', x: 0, y: 0, points: [[0, 0], [5_000_000, 0]] }], 'invalid_input');
});

test('bound labels keep their geometry but accept style changes', () => {
  fails([{ op: 'update', id: 'label', x: 5000 }], 'invalid_input');
  fails([{ op: 'update', id: 'label', frameId: 'frame1' }], 'invalid_input');
  const [op] = normalizeOperations([{ op: 'update', id: 'label', strokeColor: '#ff0000' }], context());
  assert.equal(op.spec.strokeColor, '#ff0000');
});

test('error messages name missing ids, recreate-only fields, and non-array operations', () => {
  assert.throws(() => normalizeOperations([{ op: 'delete' }], context()), /operations\[0\]\.id is required/);
  assert.throws(() => normalizeOperations([{ op: 'update', id: 'box', points: [[0, 0], [1, 1]] }], context()), /recreate/);
  assert.throws(() => normalizeOperations({ op: 'delete' }, context()), /array of 1–50/);
  assert.throws(
    () => normalizeOperations([{ op: 'create', type: 'rectangle', x: 0, y: 0, link: `https://x.com/${'a'.repeat(2049)}` }], context()),
    (error) => error instanceof PatchError && error.code === 'invalid_url',
  );
});

test('reports every invalid operation at once, without cascading', () => {
  assert.throws(
    () =>
      normalizeOperations(
        [
          { op: 'create', id: 'first', type: 'rectangle', x: 0, y: 0, strokeColor: '#12345' },
          { op: 'update', id: 'ghost', x: 1 },
          { op: 'create', type: 'arrow', x: 0, y: 0, start: { id: 'first' }, end: { id: 'box' } },
          { op: 'delete' },
        ],
        context(),
      ),
    (error) => {
      assert.ok(error instanceof PatchError);
      assert.equal(error.code, 'invalid_input');
      assert.match(error.message, /3 operations have problems/);
      assert.deepEqual(
        error.details.errors.map((entry) => [entry.index, entry.code]),
        [
          [0, 'invalid_input'],
          [1, 'shape_not_found'],
          [3, 'invalid_input'],
        ],
      );
      return true;
    },
  );
});

test('labels can be replaced or removed through update, on shapes and arrows', () => {
  const ops = normalizeOperations(
    [
      { op: 'update', id: 'box', label: { text: 'Renamed', fontSize: 20 } },
      { op: 'update', id: 'box', label: null },
    ],
    context(),
  );
  assert.deepEqual(ops[0].spec.label, { text: 'Renamed', fontSize: 20 });
  assert.equal(ops[1].spec.label, null);
  fails([{ op: 'update', id: 'title', label: { text: 'x' } }], 'invalid_input');
  fails([{ op: 'update', id: 'frame1', label: { text: 'x' } }], 'invalid_input');
  const [arrow] = normalizeOperations(
    [{ op: 'create', type: 'arrow', x: 0, y: 0, start: { id: 'box' }, end: { id: 'frame1' }, label: { text: 'yes' } }],
    context(),
  );
  assert.deepEqual(arrow.spec.label, { text: 'yes' });
});

test('creates may reference elements created later in the same patch; output is dependency-ordered', () => {
  const ops = normalizeOperations(
    [
      { op: 'create', id: 'edge', type: 'arrow', x: 0, y: 0, start: { id: 'a' }, end: { id: 'b' } },
      { op: 'update', id: 'box', frameId: 'f' },
      { op: 'create', id: 'a', type: 'rectangle', x: 0, y: 0, frameId: 'f' },
      { op: 'create', id: 'b', type: 'ellipse', x: 300, y: 0 },
      { op: 'create', id: 'f', type: 'frame', x: -20, y: -20, width: 600, height: 300 },
    ],
    context(),
  );
  assert.deepEqual(
    ops.map((op) => (op.op === 'create' ? `create:${op.spec.id}` : `${op.op}:${op.spec?.id ?? op.id}`)),
    ['create:f', 'create:a', 'create:b', 'create:edge', 'update:box'],
  );
  fails(
    [
      { op: 'create', id: 'edge', type: 'arrow', x: 0, y: 0, start: { id: 'later' }, end: { x: 1, y: 1 } },
      { op: 'create', id: 'later', type: 'arrow', x: 0, y: 0 },
    ],
    'invalid_input',
  );
  fails(
    [
      { op: 'create', id: 'dup', type: 'rectangle', x: 0, y: 0 },
      { op: 'create', id: 'dup', type: 'rectangle', x: 0, y: 0 },
    ],
    'duplicate_shape_id',
  );
});

test('move, duplicate, and style operations', () => {
  const ops = normalizeOperations(
    [
      { op: 'move', ids: ['box', 'frame1'], dx: 10, dy: 0 },
      { op: 'duplicate', ids: ['box'] },
      { op: 'style', ids: ['box', 'label'], strokeColor: '#e03131' },
    ],
    context(),
  );
  assert.deepEqual(ops[0], { op: 'move', ids: ['box', 'frame1'], dx: 10, dy: 0 });
  assert.deepEqual(ops[1], { op: 'duplicate', ids: ['box'], dx: 40, dy: 40 });
  assert.deepEqual(ops[2], { op: 'style', ids: ['box', 'label'], style: { strokeColor: '#e03131' } });
  fails([{ op: 'move', ids: ['label'], dx: 5 }], 'invalid_input');
  fails([{ op: 'move', ids: ['box'] }], 'invalid_input');
  fails([{ op: 'style', ids: ['box'] }], 'invalid_input');
  fails([{ op: 'move', ids: ['locked'], dx: 5 }], 'shape_locked');
  fails([{ op: 'duplicate', ids: ['ghost'] }], 'shape_not_found');
  fails([{ op: 'move', ids: [], dx: 5 }], 'invalid_input');
});

test('at places a new element relative to an anchor instead of x/y', () => {
  const [op] = normalizeOperations([{ op: 'create', type: 'rectangle', at: { relativeTo: 'box', side: 'right' } }], context());
  assert.deepEqual(op.spec.at, { relativeTo: 'box', side: 'right', gap: 40, align: 'center' });
  assert.equal(op.spec.x, 0);
  fails([{ op: 'create', type: 'rectangle' }], 'invalid_input');
  fails([{ op: 'create', type: 'arrow', at: { relativeTo: 'box', side: 'right' } }], 'invalid_input');
  fails([{ op: 'create', type: 'rectangle', at: { relativeTo: 'label', side: 'right' } }], 'invalid_input');
  fails([{ op: 'create', type: 'rectangle', at: { relativeTo: 'ghost', side: 'right' } }], 'shape_not_found');
  fails([{ op: 'create', type: 'rectangle', at: { relativeTo: 'box', side: 'inside' } }], 'invalid_input');
  const ordered = normalizeOperations(
    [
      { op: 'create', id: 'b', type: 'rectangle', at: { relativeTo: 'a', side: 'below', gap: 20, align: 'start' } },
      { op: 'create', id: 'a', type: 'rectangle', x: 0, y: 0 },
    ],
    context(),
  );
  assert.deepEqual(ordered.map((entry) => entry.spec.id), ['a', 'b']);
});

test('images need a valid data URL and nothing else accepts one', () => {
  const [op] = normalizeOperations(
    [{ op: 'create', type: 'image', x: 0, y: 0, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
    context(),
  );
  assert.equal(op.spec.dataUrl, 'data:image/png;base64,iVBORw0KGgo=');
  fails([{ op: 'create', type: 'image', x: 0, y: 0 }], 'invalid_input');
  fails([{ op: 'create', type: 'image', x: 0, y: 0, dataUrl: 'data:text/html;base64,AAAA' }], 'invalid_input');
  fails([{ op: 'create', type: 'rectangle', x: 0, y: 0, dataUrl: 'data:image/png;base64,AAAA' }], 'invalid_input');
});

test('embeddables take a link or html, never both, and html is embeddable-only', () => {
  const [op] = normalizeOperations([{ op: 'create', type: 'embeddable', x: 0, y: 0, html: '<h1>Hi</h1>' }], context());
  assert.equal(op.spec.html, '<h1>Hi</h1>');
  assert.equal(op.spec.link, undefined);
  fails([{ op: 'create', type: 'embeddable', x: 0, y: 0 }], 'invalid_input');
  fails([{ op: 'create', type: 'embeddable', x: 0, y: 0, html: '<p>a</p>', link: 'https://example.com' }], 'invalid_input');
  fails([{ op: 'create', type: 'embeddable', x: 0, y: 0, html: '   ' }], 'invalid_input');
  fails([{ op: 'create', type: 'embeddable', x: 0, y: 0, html: 'x'.repeat(200_001) }], 'too_large');
  fails([{ op: 'create', type: 'rectangle', x: 0, y: 0, html: '<p>a</p>' }], 'invalid_input');
  fails([{ op: 'update', id: 'box', html: '<p>a</p>' }], 'invalid_input');
  fails([{ op: 'create', type: 'rectangle', x: 0, y: 0, customData: { agentdraw: { by: 'agent' } } }], 'invalid_input');
});

test('fonts: family and size on text and labels, on create and update', () => {
  const ops = normalizeOperations(
    [
      { op: 'create', id: 't', type: 'text', x: 0, y: 0, text: 'Title', fontFamily: 'display', fontSize: 36 },
      { op: 'create', id: 'r', type: 'rectangle', x: 0, y: 0, label: { text: 'const x = 1', fontFamily: 'code' } },
      { op: 'update', id: 'title', fontFamily: 'normal', fontSize: 20, textAlign: 'right' },
      { op: 'update', id: 'box', label: { text: 'Box', fontFamily: 'normal' } },
    ],
    context(),
  );
  const byId = (id) => ops.find((op) => op.spec?.id === id);
  assert.equal(byId('t').spec.fontFamily, 'display');
  assert.equal(byId('r').spec.label.fontFamily, 'code');
  assert.deepEqual({ ...byId('title').spec }, { id: 'title', fontFamily: 'normal', fontSize: 20, textAlign: 'right' });
  assert.equal(byId('box').spec.label.fontFamily, 'normal');
  fails([{ op: 'create', type: 'text', x: 0, y: 0, text: 'x', fontFamily: 'comic' }], 'invalid_input');
  fails([{ op: 'update', id: 'box', fontSize: 20 }], 'invalid_input');
  fails([{ op: 'update', id: 'label', fontFamily: 'code' }], 'invalid_input');
  fails([{ op: 'create', type: 'rectangle', x: 0, y: 0, fontFamily: 'code' }], 'invalid_input');
  const schema = operationJsonSchema();
  assert.deepEqual(schema.oneOf[0].properties.fontFamily.enum, ['hand', 'normal', 'code', 'display']);
  assert.ok(schema.oneOf[1].properties.fontFamily);
});
