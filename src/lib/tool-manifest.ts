/**
 * The eight WebMCP tools as the agent sees them: names, descriptions, schemas,
 * annotations. Pure data, so llms.txt and the tests read the same source the
 * page registers.
 */
import { MAX_OPERATIONS, operationJsonSchema } from './patch-schema.ts';

export type ToolName =
  | 'get_capabilities'
  | 'inspect_canvas'
  | 'apply_patch'
  | 'revert_patch'
  | 'focus_elements'
  | 'capture_canvas'
  | 'export_canvas'
  | 'import_scene';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface ToolManifestEntry {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}

const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$' };
const idArray = (max: number) => ({ type: 'array', minItems: 1, maxItems: max, uniqueItems: true, items: id });

export const TOOL_MANIFEST: readonly ToolManifestEntry[] = [
  {
    name: 'get_capabilities',
    title: 'Read whiteboard capabilities',
    description:
      'What you can draw on this Excalidraw whiteboard: element types, style options, defaults, limits, arrow binding rules, and layout guidance. Read once per session before inspecting.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'inspect_canvas',
    title: 'Inspect the whiteboard',
    description:
      'Read every element on the whiteboard in a compact form: type, bounding box, text or label, bindings, absolute points for strokes and lines (sampled to 64), and for the person’s strokes the nearIds of shapes they touch. Also returns the viewport (scene coordinates), what the person has selected, the scene bounds, a suggested empty origin for new content, and how many elements the person changed since you last looked. The only type you can read but not create is freedraw. Embeddables carrying html report html: { chars, excerpt } instead of a link; pass includeHtml: true together with ids to get html.text, the full source. Pass sinceRevision to get only the elements that changed since then, plus the change log. detail: "outline" drops styles and points and keeps geometry, text, and bindings; detail: "graph" returns the board as a graph (elements are the nodes, plus graph.edges with from/to/text, graph.frames with their children, and graph.marks for the person’s strokes), the cheapest way to understand a flow or architecture diagram; every element carries by: "agent" or "person"; limit (default 250, max 500) and cursor page through large boards, and nextCursor tells you when there is more; a cursor is bound to the revision it was issued at and answers cursor_expired if the board changed in between, so start over from the first page. A label is a separate text element bound to its shape, so a labelled shape counts as two elements everywhere: elementCount counts the whole board, matchedCount what matched after filters, returnedCount what this page holds. Writes need the epoch and revision from this call or from your last apply_patch response.',
    inputSchema: {
      type: 'object',
      properties: {
        sinceRevision: { type: 'integer', minimum: 0 },
        ids: idArray(200),
        frameId: id,
        viewportOnly: { type: 'boolean' },
        detail: { type: 'string', enum: ['full', 'outline', 'graph'] },
        includeHtml: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        cursor: { type: 'string', pattern: '^c[0-9]{1,7}\\.[0-9]{1,9}$' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, untrustedContentHint: true },
  },
  {
    name: 'apply_patch',
    title: 'Draw on the whiteboard',
    description:
      'Atomically create, update, delete, move, duplicate, or restyle up to 50 elements per call: rectangles, ellipses, diamonds, text, arrows and lines, frames, embeddable web pages, and images from a base64 dataUrl. An embeddable takes either link (a web page) or html (your own page, rendered live in a sandboxed frame; update it with html again). Place a new element without coordinates with at: { relativeTo, side, gap?, align? } and it lands beside that element, joining its frame. move shifts ids by dx/dy with their labels and frame children; duplicate copies ids (labels, children, and the arrows between them included) offset by dx/dy and reports each copy with its sourceId; style restyles ids in one go. Labels are measured automatically; update a shape or arrow with label: { text } to rename it (label: null removes it), and resizing re-centres the label. Text and labels take fontSize, fontFamily (hand, normal, code, display), textAlign, and verticalAlign, on create and on update. Arrows with start/end { id } are anchored to those shapes’ edges and re-routed, labels included, when you move or resize the shapes. Moving a frame moves its children and labels. Operations may reference elements created anywhere in the same patch (an arrow before its shapes, a child before its frame); they are applied in dependency order. Requires the epoch and revision from your latest inspect_canvas or apply_patch; a stale revision is rejected whole with revision_conflict, and every invalid operation is listed in error.details.errors. Returns a patchId for revert_patch, created ids with bounds and boundTextId, the ids you updated, the ids touched as side effects, and the ids removed.',
    inputSchema: {
      type: 'object',
      properties: {
        epoch: { type: 'string', minLength: 1, maxLength: 120 },
        baseRevision: { type: 'integer', minimum: 0 },
        operations: { type: 'array', minItems: 1, maxItems: MAX_OPERATIONS, items: operationJsonSchema() },
      },
      required: ['epoch', 'baseRevision', 'operations'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: 'revert_patch',
    title: 'Undo one of your patches',
    description:
      'Roll back one patch you applied earlier, identified by the patchId that apply_patch returned, without touching anything else on the board. Refused with revert_conflict if the person or a later patch changed any of the affected elements since; then inspect and fix by hand. Needs the current epoch and revision like apply_patch. Only the last 20 patches of this page load can be reverted. The person can still undo everything with Cmd+Z.',
    inputSchema: {
      type: 'object',
      properties: {
        epoch: { type: 'string', minLength: 1, maxLength: 120 },
        baseRevision: { type: 'integer', minimum: 0 },
        patchId: { type: 'string', minLength: 1, maxLength: 120 },
      },
      required: ['epoch', 'baseRevision', 'patchId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: 'import_scene',
    title: 'Load a saved diagram onto the board',
    description:
      'Load an .excalidraw document (the text from export_canvas, a file from the person’s repository, or a template) as JSON text or object. mode "append" (default) places it beside the existing content, or at the given at: { x, y }; mode "replace" clears the board first. Ids are regenerated, so inspect_canvas afterwards to learn them. Needs the current epoch and revision like apply_patch and returns a patchId for revert_patch. At most 2000 elements.',
    inputSchema: {
      type: 'object',
      properties: {
        epoch: { type: 'string', minLength: 1, maxLength: 120 },
        baseRevision: { type: 'integer', minimum: 0 },
        scene: { anyOf: [{ type: 'string', maxLength: 2_000_000 }, { type: 'object' }] },
        mode: { type: 'string', enum: ['append', 'replace'] },
        at: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
          additionalProperties: false,
        },
      },
      required: ['epoch', 'baseRevision', 'scene'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: 'focus_elements',
    title: 'Show elements to the person',
    description:
      'Select one or more elements and scroll the person’s view to them. Does not change the document, but it does change selectionIds.',
    inputSchema: {
      type: 'object',
      properties: { ids: idArray(50) },
      required: ['ids'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'capture_canvas',
    title: 'See the whiteboard as an image',
    description:
      'Render the whole whiteboard, the given element ids (their labels come along), or one frame by frameId, to a PNG data URL with the longest side at most 1600px, so you can look at what was drawn, including the person’s freehand sketches. The response’s scale is pixels per scene unit; on a large or scattered board the whole-board capture is too small to read, so pass the ids of the part you care about instead.',
    inputSchema: {
      type: 'object',
      properties: { ids: idArray(200), frameId: id },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, untrustedContentHint: true },
  },
  {
    name: 'export_canvas',
    title: 'Export the whiteboard as a file',
    description:
      'Return the whole board, the given element ids (their labels come along), or one frame by frameId, as text you can save: format "svg" for a picture, or "excalidraw" for the standard .excalidraw JSON that opens on excalidraw.com and in this app. Use it to put a diagram into a repository, a README, or a document. SVG fonts are not inlined unless inlineFonts is true, so the file stays small and any viewer can open it. The response carries the text, its character count, a suggested file name, and the bounds. Exports over 2,000,000 characters are refused; pass ids for the part you need.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['svg', 'excalidraw'] },
        ids: idArray(500),
        frameId: id,
        inlineFonts: { type: 'boolean' },
      },
      required: ['format'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, untrustedContentHint: true },
  },
];
