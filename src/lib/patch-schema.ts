/**
 * Validation for agent patches, kept pure so it is unit-testable. Every field
 * an agent may set is whitelisted here; anything else is rejected before any
 * element is touched.
 */

import { MAX_HTML_CHARS } from './html-embed.ts';

export const MAX_OPERATIONS = 50;
export const MAX_TEXT_CHARS = 4000;
export const MAX_URL_CHARS = 2048;
export const MAX_CUSTOM_DATA_CHARS = 8000;
export const COORDINATE_LIMIT = 1_000_000;

export const CREATABLE_TYPES = [
  'rectangle',
  'ellipse',
  'diamond',
  'text',
  'arrow',
  'line',
  'frame',
  'embeddable',
  'image',
] as const;
export type CreatableType = (typeof CREATABLE_TYPES)[number];
export const SIDES = ['right', 'left', 'below', 'above'] as const;
export const ALIGNS = ['start', 'center', 'end'] as const;
export const MAX_IMAGE_DATA_CHARS = 1_500_000;
export const MAX_IDS_PER_OPERATION = 50;
const IMAGE_DATA_PATTERN = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

export const FILL_STYLES = ['hachure', 'cross-hatch', 'solid', 'zigzag'] as const;
export const STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const;
export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
export const VERTICAL_ALIGNS = ['top', 'middle', 'bottom'] as const;
export const ARROWHEADS = ['arrow', 'bar', 'dot', 'triangle', 'none'] as const;
export const ROUNDNESS = ['round', 'sharp'] as const;
/** Agent-facing font names, mapped to Excalidraw's built-in families. */
export const FONT_FAMILIES = ['hand', 'normal', 'code', 'display'] as const;
export type FontFamilyName = (typeof FONT_FAMILIES)[number];
export const FONT_FAMILY_IDS: Record<FontFamilyName, number> = { hand: 5, normal: 6, code: 8, display: 7 };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const COLOR_PATTERN = /^(transparent|#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))$/;

export class PatchError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface LabelSpec {
  text: string;
  fontSize?: number;
  fontFamily?: FontFamilyName;
  textAlign?: (typeof TEXT_ALIGNS)[number];
  verticalAlign?: (typeof VERTICAL_ALIGNS)[number];
}

export interface StyleSpec {
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: (typeof FILL_STYLES)[number];
  strokeWidth?: number;
  strokeStyle?: (typeof STROKE_STYLES)[number];
  roughness?: number;
  opacity?: number;
  roundness?: (typeof ROUNDNESS)[number];
}

export type Endpoint = { id: string } | { x: number; y: number };

/** Place a new element next to an existing one instead of giving coordinates. */
export interface PlacementSpec {
  relativeTo: string;
  side: (typeof SIDES)[number];
  gap: number;
  align: (typeof ALIGNS)[number];
}

export interface CreateSpec extends StyleSpec {
  id: string;
  type: CreatableType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  angle?: number;
  frameId?: string | null;
  locked?: boolean;
  link?: string;
  customData?: Record<string, unknown>;
  text?: string;
  fontSize?: number;
  fontFamily?: FontFamilyName;
  textAlign?: (typeof TEXT_ALIGNS)[number];
  verticalAlign?: (typeof VERTICAL_ALIGNS)[number];
  label?: LabelSpec;
  name?: string;
  points?: [number, number][];
  start?: Endpoint;
  end?: Endpoint;
  startArrowhead?: (typeof ARROWHEADS)[number];
  endArrowhead?: (typeof ARROWHEADS)[number];
  at?: PlacementSpec;
  /** Embeddables only: your own HTML, rendered live in the sandboxed frame instead of a link. */
  html?: string;
  /** Images only: a base64 data URL; the bridge stores it and fills in fileId. */
  dataUrl?: string;
  fileId?: string;
}

export interface UpdateSpec extends StyleSpec {
  /** Replace the bound label; null removes it. Rectangles, ellipses, diamonds, and arrows. */
  label?: LabelSpec | null;
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  angle?: number;
  frameId?: string | null;
  locked?: boolean;
  link?: string | null;
  /** Embeddables only: replace the rendered HTML. */
  html?: string;
  customData?: Record<string, unknown> | null;
  text?: string;
  /** Free text elements only; labels take these through label: { ... }. */
  fontSize?: number;
  fontFamily?: FontFamilyName;
  textAlign?: (typeof TEXT_ALIGNS)[number];
  verticalAlign?: (typeof VERTICAL_ALIGNS)[number];
  name?: string;
}

export type NormalizedOperation =
  | { op: 'create'; spec: CreateSpec }
  | { op: 'update'; spec: UpdateSpec }
  | { op: 'delete'; id: string }
  | { op: 'move'; ids: string[]; dx: number; dy: number }
  | { op: 'duplicate'; ids: string[]; dx: number; dy: number }
  | { op: 'style'; ids: string[]; style: StyleSpec };

export interface ExistingElement {
  type: string;
  locked: boolean;
  containerId: string | null;
}

export interface PatchContext {
  existing: ReadonlyMap<string, ExistingElement>;
  newId: () => string;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PatchError('invalid_input', `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(record: Record<string, unknown>, allowed: readonly string[], label: string) {
  const extras = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extras.length) {
    throw new PatchError('invalid_input', `${label} has unsupported fields: ${extras.join(', ')}.`);
  }
}

function idValue(value: unknown, label: string) {
  if (value === undefined) throw new PatchError('invalid_input', `${label} is required.`);
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new PatchError(
      'invalid_input',
      `${label} must be 1–120 letters, numbers, dots, dashes, or underscores.`,
    );
  }
  return value;
}

function numberValue(
  record: Record<string, unknown>,
  key: string,
  label: string,
  range: { min: number; max: number },
) {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PatchError('invalid_input', `${label}.${key} must be a finite number.`);
  }
  if (value < range.min || value > range.max) {
    throw new PatchError('invalid_input', `${label}.${key} must be between ${range.min} and ${range.max}.`);
  }
  return value;
}

function stringValue(record: Record<string, unknown>, key: string, label: string, max: number) {
  const value = record[key];
  if (typeof value !== 'string' || value.length > max) {
    throw new PatchError('invalid_input', `${label}.${key} must be a string of at most ${max} characters.`);
  }
  return value;
}

function enumValue<T extends string>(
  record: Record<string, unknown>,
  key: string,
  label: string,
  options: readonly T[],
) {
  const value = record[key];
  if (!options.includes(value as T)) {
    throw new PatchError('invalid_input', `${label}.${key} must be one of ${options.join(', ')}.`);
  }
  return value as T;
}

function colorValue(record: Record<string, unknown>, key: string, label: string) {
  const value = stringValue(record, key, label, 12);
  if (!COLOR_PATTERN.test(value)) {
    throw new PatchError('invalid_input', `${label}.${key} must be "transparent" or a hex color.`);
  }
  return value;
}

function urlValue(record: Record<string, unknown>, key: string, label: string) {
  const raw = record[key];
  if (typeof raw !== 'string') throw new PatchError('invalid_url', `${label}.${key} must be an http(s) URL string.`);
  if (raw.length > MAX_URL_CHARS) {
    throw new PatchError('invalid_url', `${label}.${key} must be at most ${MAX_URL_CHARS} characters.`);
  }
  const value = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PatchError('invalid_url', `${label}.${key} must be an http(s) URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PatchError('invalid_url', `${label}.${key} must be an http(s) URL.`);
  }
  return value;
}

function customDataValue(record: Record<string, unknown>, label: string) {
  const value = objectValue(record.customData, `${label}.customData`);
  if (value.agentdraw !== undefined) {
    throw new PatchError('invalid_input', `${label}.customData.agentdraw is reserved for the board’s own marks.`);
  }
  if (JSON.stringify(value).length > MAX_CUSTOM_DATA_CHARS) {
    throw new PatchError('invalid_input', `${label}.customData must serialize to at most ${MAX_CUSTOM_DATA_CHARS} characters.`);
  }
  return value;
}

function styleValues(record: Record<string, unknown>, label: string): StyleSpec {
  const style: StyleSpec = {};
  if (record.strokeColor !== undefined) style.strokeColor = colorValue(record, 'strokeColor', label);
  if (record.backgroundColor !== undefined) style.backgroundColor = colorValue(record, 'backgroundColor', label);
  if (record.fillStyle !== undefined) style.fillStyle = enumValue(record, 'fillStyle', label, FILL_STYLES);
  if (record.strokeWidth !== undefined) style.strokeWidth = numberValue(record, 'strokeWidth', label, { min: 0.5, max: 8 });
  if (record.strokeStyle !== undefined) style.strokeStyle = enumValue(record, 'strokeStyle', label, STROKE_STYLES);
  if (record.roughness !== undefined) style.roughness = numberValue(record, 'roughness', label, { min: 0, max: 2 });
  if (record.opacity !== undefined) style.opacity = numberValue(record, 'opacity', label, { min: 0, max: 100 });
  if (record.roundness !== undefined) style.roundness = enumValue(record, 'roundness', label, ROUNDNESS);
  return style;
}

function labelValue(record: Record<string, unknown>, label: string): LabelSpec {
  const value = objectValue(record.label, `${label}.label`);
  assertKeys(value, ['text', 'fontSize', 'fontFamily', 'textAlign', 'verticalAlign'], `${label}.label`);
  const spec: LabelSpec = { text: stringValue(value, 'text', `${label}.label`, MAX_TEXT_CHARS) };
  if (value.fontSize !== undefined) spec.fontSize = numberValue(value, 'fontSize', `${label}.label`, { min: 8, max: 200 });
  if (value.fontFamily !== undefined) spec.fontFamily = enumValue(value, 'fontFamily', `${label}.label`, FONT_FAMILIES);
  if (value.textAlign !== undefined) spec.textAlign = enumValue(value, 'textAlign', `${label}.label`, TEXT_ALIGNS);
  if (value.verticalAlign !== undefined) spec.verticalAlign = enumValue(value, 'verticalAlign', `${label}.label`, VERTICAL_ALIGNS);
  return spec;
}

function placementValue(
  record: Record<string, unknown>,
  label: string,
  context: PatchContext,
  declared: ReadonlyMap<string, CreatableType>,
  deleted: ReadonlySet<string>,
): PlacementSpec {
  const value = objectValue(record.at, `${label}.at`);
  assertKeys(value, ['relativeTo', 'side', 'gap', 'align'], `${label}.at`);
  const relativeTo = idValue(value.relativeTo, `${label}.at.relativeTo`);
  if (deleted.has(relativeTo)) {
    throw new PatchError('shape_not_found', `${label}.at.relativeTo ${relativeTo} is deleted earlier in this patch.`);
  }
  const anchor = context.existing.get(relativeTo);
  if (!anchor && !declared.has(relativeTo)) {
    throw new PatchError('shape_not_found', `${label}.at.relativeTo refers to unknown element ${relativeTo}.`);
  }
  if (anchor?.containerId) {
    throw new PatchError('invalid_input', `${label}.at.relativeTo ${relativeTo} is a label; anchor to its container ${anchor.containerId}.`);
  }
  return {
    relativeTo,
    side: enumValue(value, 'side', `${label}.at`, SIDES),
    gap: value.gap === undefined ? 40 : numberValue(value, 'gap', `${label}.at`, { min: 0, max: 5000 }),
    align: value.align === undefined ? 'center' : enumValue(value, 'align', `${label}.at`, ALIGNS),
  };
}

function htmlValue(record: Record<string, unknown>, label: string) {
  const value = record.html;
  if (typeof value !== 'string' || !value.trim()) {
    throw new PatchError('invalid_input', `${label}.html must be a non-empty string of HTML.`);
  }
  if (value.length > MAX_HTML_CHARS) {
    throw new PatchError('too_large', `${label}.html is ${value.length} characters; the limit is ${MAX_HTML_CHARS}. Inline less, or load assets from a URL inside the page.`);
  }
  return value;
}

function imageDataValue(record: Record<string, unknown>, label: string) {
  const value = record.dataUrl;
  if (typeof value !== 'string' || value.length > MAX_IMAGE_DATA_CHARS || !IMAGE_DATA_PATTERN.test(value)) {
    throw new PatchError(
      'invalid_input',
      `${label}.dataUrl must be a base64 data URL of a png, jpeg, gif, webp, or svg image, at most ${MAX_IMAGE_DATA_CHARS} characters.`,
    );
  }
  return value;
}

const BINDABLE_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'text', 'image', 'embeddable', 'iframe', 'frame']);

function frameIdValue(
  value: unknown,
  label: string,
  context: PatchContext,
  known: ReadonlyMap<string, CreatableType>,
  deleted: ReadonlySet<string>,
) {
  const frameId = idValue(value, label);
  const frameType = deleted.has(frameId) ? undefined : (context.existing.get(frameId)?.type ?? known.get(frameId));
  if (!frameType) throw new PatchError('shape_not_found', `${label} ${frameId} does not exist.`);
  if (frameType !== 'frame') throw new PatchError('invalid_input', `${label} ${frameId} is a ${frameType}, not a frame.`);
  return frameId;
}

function endpointValue(
  record: Record<string, unknown>,
  key: string,
  label: string,
  context: PatchContext,
  known: ReadonlyMap<string, CreatableType>,
  deleted: ReadonlySet<string>,
): Endpoint {
  const value = objectValue(record[key], `${label}.${key}`);
  if (value.id !== undefined) {
    assertKeys(value, ['id'], `${label}.${key}`);
    const id = idValue(value.id, `${label}.${key}.id`);
    if (deleted.has(id)) {
      throw new PatchError('shape_not_found', `${label}.${key} refers to ${id}, which is deleted earlier in this patch.`);
    }
    const target = context.existing.get(id);
    const targetType = target?.type ?? known.get(id);
    if (!targetType) {
      throw new PatchError('shape_not_found', `${label}.${key} refers to unknown element ${id}.`);
    }
    if (target?.containerId) {
      throw new PatchError('invalid_input', `${label}.${key} cannot bind to a label; bind to its container ${target.containerId}.`);
    }
    if (!BINDABLE_TYPES.has(targetType)) {
      throw new PatchError(
        'invalid_input',
        `${label}.${key} cannot bind to a ${targetType}; arrows bind to rectangle, ellipse, diamond, text, image, embeddable, or frame.`,
      );
    }
    return { id };
  }
  assertKeys(value, ['x', 'y'], `${label}.${key}`);
  return {
    x: numberValue(value, 'x', `${label}.${key}`, { min: -COORDINATE_LIMIT, max: COORDINATE_LIMIT }),
    y: numberValue(value, 'y', `${label}.${key}`, { min: -COORDINATE_LIMIT, max: COORDINATE_LIMIT }),
  };
}

const CREATE_KEYS = [
  'op', 'id', 'type', 'x', 'y', 'width', 'height', 'angle', 'frameId', 'locked', 'link', 'customData',
  'strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'roundness',
  'text', 'fontSize', 'fontFamily', 'textAlign', 'verticalAlign', 'label', 'name', 'points', 'start', 'end',
  'startArrowhead', 'endArrowhead', 'at', 'dataUrl', 'html',
];
const STYLE_KEYS = ['strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'roundness'];
const UPDATE_KEYS = [
  'op', 'id', 'x', 'y', 'width', 'height', 'angle', 'frameId', 'locked', 'link', 'customData',
  'strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'roundness',
  'text', 'name', 'label', 'html', 'fontSize', 'fontFamily', 'textAlign', 'verticalAlign',
];

const RECREATE_ONLY_KEYS = ['type', 'points', 'start', 'end', 'startArrowhead', 'endArrowhead'];
const LABEL_CONTAINER_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'arrow']);

export function normalizeOperations(input: unknown, context: PatchContext): NormalizedOperation[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_OPERATIONS) {
    throw new PatchError('invalid_input', `operations must be an array of 1–${MAX_OPERATIONS} items.`);
  }
  const known = new Map<string, CreatableType>();
  const deleted = new Set<string>();
  const result: NormalizedOperation[] = [];
  const errors: { index: number; code: string; message: string }[] = [];

  // Every create in the patch is visible to every other operation, whatever
  // the order; the operations are sorted into dependency order afterwards.
  const declared = new Map<string, CreatableType>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    if (candidate.op !== 'create' || typeof candidate.id !== 'string') continue;
    if (!ID_PATTERN.test(candidate.id) || !(CREATABLE_TYPES as readonly unknown[]).includes(candidate.type)) continue;
    if (!declared.has(candidate.id)) declared.set(candidate.id, candidate.type as CreatableType);
  }

  const requireExisting = (id: string, label: string) => {
    if (deleted.has(id)) throw new PatchError('shape_not_found', `${label}: element ${id} was deleted earlier in this patch.`);
    const element = context.existing.get(id);
    if (!element) throw new PatchError('shape_not_found', `${label}: element ${id} does not exist.`);
    if (element.locked) throw new PatchError('shape_locked', `${label}: element ${id} is locked.`);
    return element;
  };
  const idsValue = (value: unknown, label: string, options: { labels: boolean }) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_IDS_PER_OPERATION) {
      throw new PatchError('invalid_input', `${label}.ids must list 1–${MAX_IDS_PER_OPERATION} element ids.`);
    }
    const ids = [...new Set(value.map((entry, index) => idValue(entry, `${label}.ids[${index}]`)))];
    for (const id of ids) {
      const element = requireExisting(id, label);
      if (!options.labels && element.containerId) {
        throw new PatchError('invalid_input', `${label}.ids: ${id} is a bound label; use its container ${element.containerId}.`);
      }
    }
    return ids;
  };

  input.forEach((raw, index) => {
    const label = `operations[${index}]`;
    try {
      const record = objectValue(raw, label);
      const op = record.op;
      if (op === 'create') {
        assertKeys(record, CREATE_KEYS, label);
        const type = enumValue(record, 'type', label, CREATABLE_TYPES);
        const id = record.id === undefined ? context.newId() : idValue(record.id, `${label}.id`);
        if (context.existing.has(id) || known.has(id)) {
          throw new PatchError('duplicate_shape_id', `${label}: element ${id} already exists.`);
        }
        known.set(id, type);
        const at = record.at === undefined ? undefined : placementValue(record, label, context, declared, deleted);
        if (at && (type === 'arrow' || type === 'line')) {
          throw new PatchError('invalid_input', `${label}.at applies to shapes, text, frames, images, and embeds; give arrows points or bindings.`);
        }
        for (const axis of ['x', 'y'] as const) {
          if (record[axis] === undefined && !at) {
            throw new PatchError('invalid_input', `${label}.${axis} is required, or use at to place the element next to another one.`);
          }
        }
        const spec: CreateSpec = {
          ...styleValues(record, label),
          id,
          type,
          x: record.x === undefined ? 0 : numberValue(record, 'x', label, { min: -COORDINATE_LIMIT, max: COORDINATE_LIMIT }),
          y: record.y === undefined ? 0 : numberValue(record, 'y', label, { min: -COORDINATE_LIMIT, max: COORDINATE_LIMIT }),
        };
        if (at) spec.at = at;
        if (type === 'image') {
          spec.dataUrl = imageDataValue(record, label);
        } else if (record.dataUrl !== undefined) {
          throw new PatchError('invalid_input', `${label}.dataUrl applies to images only.`);
        }
        if (record.width !== undefined) spec.width = numberValue(record, 'width', label, { min: 1, max: 20000 });
        if (record.height !== undefined) spec.height = numberValue(record, 'height', label, { min: 1, max: 20000 });
        if (record.angle !== undefined) spec.angle = numberValue(record, 'angle', label, { min: -Math.PI * 2, max: Math.PI * 2 });
        if (record.frameId !== undefined && record.frameId !== null) {
          spec.frameId = frameIdValue(record.frameId, `${label}.frameId`, context, declared, deleted);
        }
        if (record.locked !== undefined) {
          if (typeof record.locked !== 'boolean') throw new PatchError('invalid_input', `${label}.locked must be a boolean.`);
          spec.locked = record.locked;
        }
        if (record.link !== undefined) spec.link = urlValue(record, 'link', label);
        if (record.customData !== undefined) spec.customData = customDataValue(record, label);
        if (type === 'text') {
          spec.text = stringValue(record, 'text', label, MAX_TEXT_CHARS);
          if (!spec.text.trim()) throw new PatchError('invalid_input', `${label}.text must not be empty.`);
          if (record.fontSize !== undefined) spec.fontSize = numberValue(record, 'fontSize', label, { min: 8, max: 200 });
          if (record.fontFamily !== undefined) spec.fontFamily = enumValue(record, 'fontFamily', label, FONT_FAMILIES);
          if (record.textAlign !== undefined) spec.textAlign = enumValue(record, 'textAlign', label, TEXT_ALIGNS);
          if (record.verticalAlign !== undefined) spec.verticalAlign = enumValue(record, 'verticalAlign', label, VERTICAL_ALIGNS);
        } else if (record.text !== undefined || record.fontSize !== undefined || record.fontFamily !== undefined) {
          throw new PatchError('invalid_input', `${label}: use label for text on a ${type}.`);
        }
        if (record.label !== undefined) {
          if (type === 'text' || type === 'frame' || type === 'embeddable') {
            throw new PatchError('invalid_input', `${label}: ${type} cannot carry a label.`);
          }
          spec.label = labelValue(record, label);
        }
        if (type === 'frame') {
          if (record.name !== undefined) spec.name = stringValue(record, 'name', label, 200);
        } else if (record.name !== undefined) {
          throw new PatchError('invalid_input', `${label}.name applies to frames only.`);
        }
        if (type === 'embeddable') {
          if (record.html !== undefined) spec.html = htmlValue(record, label);
          if (!spec.link && spec.html === undefined) {
            throw new PatchError('invalid_input', `${label}: embeddable needs a link (a web page) or html (your own page).`);
          }
          if (spec.link && spec.html !== undefined) {
            throw new PatchError('invalid_input', `${label}: give an embeddable either link or html, not both.`);
          }
        } else if (record.html !== undefined) {
          throw new PatchError('invalid_input', `${label}.html applies to embeddables only.`);
        }
        if (type === 'arrow' || type === 'line') {
          if (record.points !== undefined) {
            if (!Array.isArray(record.points) || record.points.length < 2 || record.points.length > 500) {
              throw new PatchError('invalid_input', `${label}.points must be an array of 2–500 [x, y] pairs.`);
            }
            spec.points = record.points.map((point, pointIndex) => {
              if (
                !Array.isArray(point) ||
                point.length !== 2 ||
                point.some((n) => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > COORDINATE_LIMIT)
              ) {
                throw new PatchError('invalid_input', `${label}.points[${pointIndex}] must be [x, y] within ±${COORDINATE_LIMIT}.`);
              }
              return [point[0] as number, point[1] as number];
            });
          }
          if (record.start !== undefined) spec.start = endpointValue(record, 'start', label, context, declared, deleted);
          if (record.end !== undefined) spec.end = endpointValue(record, 'end', label, context, declared, deleted);
          const startId = spec.start && 'id' in spec.start ? spec.start.id : null;
          const endId = spec.end && 'id' in spec.end ? spec.end.id : null;
          if (type === 'line' && (startId || endId)) {
            throw new PatchError('invalid_input', `${label}: lines cannot bind to shapes; use an arrow.`);
          }
          if (startId && startId === endId) {
            throw new PatchError('invalid_input', `${label}: start and end cannot bind to the same element.`);
          }
          if (record.startArrowhead !== undefined) spec.startArrowhead = enumValue(record, 'startArrowhead', label, ARROWHEADS);
          if (record.endArrowhead !== undefined) spec.endArrowhead = enumValue(record, 'endArrowhead', label, ARROWHEADS);
        } else if (record.points !== undefined || record.start !== undefined || record.end !== undefined) {
          throw new PatchError('invalid_input', `${label}: points, start, and end apply to arrows and lines only.`);
        }
        result.push({ op: 'create', spec });
      } else if (op === 'update') {
        for (const key of RECREATE_ONLY_KEYS) {
          if (record[key] !== undefined && !(UPDATE_KEYS as readonly string[]).includes(key)) {
            throw new PatchError('invalid_input', `${label}.${key} cannot be updated; recreate the element to change it.`);
          }
        }
        assertKeys(record, UPDATE_KEYS, label);
        const id = idValue(record.id, `${label}.id`);
        const element = requireExisting(id, label);
        if (element.containerId) {
          const geometry = ['x', 'y', 'width', 'height', 'angle', 'frameId'].filter((key) => record[key] !== undefined);
          if (geometry.length) {
            throw new PatchError(
              'invalid_input',
              `${label}: ${id} is a bound label; ${geometry.join(', ')} follow its container ${element.containerId}. Update the container instead.`,
            );
          }
        }
        const spec: UpdateSpec = { ...styleValues(record, label), id };
        if (record.x !== undefined) spec.x = numberValue(record, 'x', label, { min: -COORDINATE_LIMIT, max: COORDINATE_LIMIT });
        if (record.y !== undefined) spec.y = numberValue(record, 'y', label, { min: -COORDINATE_LIMIT, max: COORDINATE_LIMIT });
        if (record.width !== undefined) spec.width = numberValue(record, 'width', label, { min: 1, max: 20000 });
        if (record.height !== undefined) spec.height = numberValue(record, 'height', label, { min: 1, max: 20000 });
        if (record.angle !== undefined) spec.angle = numberValue(record, 'angle', label, { min: -Math.PI * 2, max: Math.PI * 2 });
        if (record.frameId !== undefined) {
          spec.frameId =
            record.frameId === null ? null : frameIdValue(record.frameId, `${label}.frameId`, context, declared, deleted);
        }
        if (record.locked !== undefined) {
          if (typeof record.locked !== 'boolean') throw new PatchError('invalid_input', `${label}.locked must be a boolean.`);
          spec.locked = record.locked;
        }
        if (record.link !== undefined) spec.link = record.link === null ? null : urlValue(record, 'link', label);
        if (record.html !== undefined) {
          if (element.type !== 'embeddable') throw new PatchError('invalid_input', `${label}.html applies to embeddables only.`);
          if (record.link !== undefined) throw new PatchError('invalid_input', `${label}: give either link or html, not both.`);
          spec.html = htmlValue(record, label);
        }
        if (record.customData !== undefined) spec.customData = record.customData === null ? null : customDataValue(record, label);
        const typography = ['fontSize', 'fontFamily', 'textAlign', 'verticalAlign'].filter((key) => record[key] !== undefined);
        if (typography.length) {
          if (element.type !== 'text') {
            throw new PatchError('invalid_input', `${label}: ${typography.join(', ')} apply to text elements; for a shape’s label use label: { text, fontSize, fontFamily, textAlign }.`);
          }
          if (element.containerId) {
            throw new PatchError('invalid_input', `${label}: ${id} is a bound label; update its container ${element.containerId} with label: { ... } instead.`);
          }
          if (record.fontSize !== undefined) spec.fontSize = numberValue(record, 'fontSize', label, { min: 8, max: 200 });
          if (record.fontFamily !== undefined) spec.fontFamily = enumValue(record, 'fontFamily', label, FONT_FAMILIES);
          if (record.textAlign !== undefined) spec.textAlign = enumValue(record, 'textAlign', label, TEXT_ALIGNS);
          if (record.verticalAlign !== undefined) spec.verticalAlign = enumValue(record, 'verticalAlign', label, VERTICAL_ALIGNS);
        }
        if (record.text !== undefined) {
          if (element.type !== 'text') throw new PatchError('invalid_input', `${label}: only text elements accept text; recreate shapes to change labels.`);
          if (element.containerId) {
            throw new PatchError('invalid_input', `${label}: ${id} is a bound label; update its container ${element.containerId} with label: { text } instead.`);
          }
          spec.text = stringValue(record, 'text', label, MAX_TEXT_CHARS);
          if (!spec.text.trim()) throw new PatchError('invalid_input', `${label}.text must not be empty.`);
        }
        if (record.label !== undefined) {
          if (!LABEL_CONTAINER_TYPES.has(element.type)) {
            throw new PatchError('invalid_input', `${label}.label applies to rectangles, ellipses, diamonds, and arrows.`);
          }
          spec.label = record.label === null ? null : labelValue(record, label);
        }
        if (record.name !== undefined) {
          if (element.type !== 'frame') throw new PatchError('invalid_input', `${label}.name applies to frames only.`);
          spec.name = stringValue(record, 'name', label, 200);
        }
        if (Object.keys(spec).length === 1) {
          throw new PatchError('invalid_input', `${label}: update needs at least one property.`);
        }
        result.push({ op: 'update', spec });
      } else if (op === 'delete') {
        assertKeys(record, ['op', 'id'], label);
        const id = idValue(record.id, `${label}.id`);
        requireExisting(id, label);
        deleted.add(id);
        result.push({ op: 'delete', id });
      } else if (op === 'move' || op === 'duplicate') {
        assertKeys(record, ['op', 'ids', 'dx', 'dy'], label);
        const ids = idsValue(record.ids, label, { labels: false });
        const fallback = op === 'duplicate' ? 40 : 0;
        const dx = record.dx === undefined ? fallback : numberValue(record, 'dx', label, { min: -COORDINATE_LIMIT, max: COORDINATE_LIMIT });
        const dy = record.dy === undefined ? fallback : numberValue(record, 'dy', label, { min: -COORDINATE_LIMIT, max: COORDINATE_LIMIT });
        if (op === 'move' && !dx && !dy) throw new PatchError('invalid_input', `${label}: move needs a non-zero dx or dy.`);
        result.push({ op, ids, dx, dy });
      } else if (op === 'style') {
        assertKeys(record, ['op', 'ids', ...STYLE_KEYS], label);
        const ids = idsValue(record.ids, label, { labels: true });
        const style = styleValues(record, label);
        if (!Object.keys(style).length) throw new PatchError('invalid_input', `${label}: style needs at least one style property.`);
        result.push({ op: 'style', ids, style });
      } else {
        throw new PatchError('invalid_input', `${label}.op must be create, update, delete, move, duplicate, or style.`);
      }
    } catch (error) {
      if (!(error instanceof PatchError)) throw error;
      errors.push({ index, code: error.code, message: error.message });
    }  });
  if (errors.length) {
    const [first] = errors;
    throw new PatchError(
      first.code,
      errors.length === 1
        ? first.message
        : `${first.message} (${errors.length} operations have problems; see details.errors.)`,
      { errors },
    );
  }
  return orderForApply(result);
}

/**
 * Frames before their children, shapes before the arrows bound to them,
 * creates before updates and deletes: so a patch can be written in any order.
 */
function orderForApply(operations: NormalizedOperation[]) {
  const rank = (operation: NormalizedOperation) => {
    if (operation.op !== 'create') return 4;
    if (operation.spec.type === 'frame') return 0;
    if (operation.spec.type === 'arrow' || operation.spec.type === 'line') return 3;
    return operation.spec.at ? 2 : 1;
  };
  return operations
    .map((operation, index) => ({ operation, index, rank: rank(operation) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.operation);
}

/** JSON Schema advertised to agents through WebMCP. */
export function operationJsonSchema() {
  const labelSchema = {
            type: 'object',
            properties: {
              text: { type: 'string', maxLength: MAX_TEXT_CHARS },
              fontSize: { type: 'number', minimum: 8, maximum: 200 },
              fontFamily: { enum: [...FONT_FAMILIES] },
              textAlign: { enum: [...TEXT_ALIGNS] },
              verticalAlign: { enum: [...VERTICAL_ALIGNS] },
            },
            required: ['text'],
            additionalProperties: false,
          };
  const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$' };
  const idList = { type: 'array', minItems: 1, maxItems: MAX_IDS_PER_OPERATION, uniqueItems: true, items: id };
  const coord = { type: 'number', minimum: -COORDINATE_LIMIT, maximum: COORDINATE_LIMIT };
  const size = { type: 'number', minimum: 1, maximum: 20000 };
  const color = { type: 'string', pattern: '^(transparent|#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))$' };
  const style = {
    strokeColor: color,
    backgroundColor: color,
    fillStyle: { enum: [...FILL_STYLES] },
    strokeWidth: { type: 'number', minimum: 0.5, maximum: 8 },
    strokeStyle: { enum: [...STROKE_STYLES] },
    roughness: { type: 'number', minimum: 0, maximum: 2 },
    opacity: { type: 'number', minimum: 0, maximum: 100 },
    roundness: { enum: [...ROUNDNESS] },
  };
  const endpoint = {
    oneOf: [
      { type: 'object', properties: { id }, required: ['id'], additionalProperties: false },
      { type: 'object', properties: { x: coord, y: coord }, required: ['x', 'y'], additionalProperties: false },
    ],
  };
  return {
    oneOf: [
      {
        type: 'object',
        properties: {
          op: { const: 'create' },
          id,
          type: { enum: [...CREATABLE_TYPES] },
          x: coord,
          y: coord,
          width: size,
          height: size,
          angle: { type: 'number' },
          frameId: id,
          locked: { type: 'boolean' },
          link: { type: 'string', maxLength: MAX_URL_CHARS },
          customData: { type: 'object' },
          ...style,
          text: { type: 'string', maxLength: MAX_TEXT_CHARS },
          fontSize: { type: 'number', minimum: 8, maximum: 200 },
          fontFamily: { enum: [...FONT_FAMILIES] },
          textAlign: { enum: [...TEXT_ALIGNS] },
          verticalAlign: { enum: [...VERTICAL_ALIGNS] },
          label: labelSchema,
          name: { type: 'string', maxLength: 200 },
          points: { type: 'array', minItems: 2, maxItems: 500, items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
          start: endpoint,
          end: endpoint,
          startArrowhead: { enum: [...ARROWHEADS] },
          endArrowhead: { enum: [...ARROWHEADS] },
          at: {
            type: 'object',
            properties: {
              relativeTo: id,
              side: { enum: [...SIDES] },
              gap: { type: 'number', minimum: 0, maximum: 5000 },
              align: { enum: [...ALIGNS] },
            },
            required: ['relativeTo', 'side'],
            additionalProperties: false,
          },
          dataUrl: { type: 'string', maxLength: MAX_IMAGE_DATA_CHARS },
          html: { type: 'string', maxLength: MAX_HTML_CHARS },
        },
        required: ['op', 'type'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          op: { const: 'update' },
          id,
          x: coord,
          y: coord,
          width: size,
          height: size,
          angle: { type: 'number' },
          frameId: { anyOf: [id, { type: 'null' }] },
          label: { anyOf: [labelSchema, { type: 'null' }] },
          locked: { type: 'boolean' },
          link: { anyOf: [{ type: 'string', maxLength: MAX_URL_CHARS }, { type: 'null' }] },
          customData: { anyOf: [{ type: 'object' }, { type: 'null' }] },
          ...style,
          text: { type: 'string', maxLength: MAX_TEXT_CHARS },
          fontSize: { type: 'number', minimum: 8, maximum: 200 },
          fontFamily: { enum: [...FONT_FAMILIES] },
          textAlign: { enum: [...TEXT_ALIGNS] },
          verticalAlign: { enum: [...VERTICAL_ALIGNS] },
          name: { type: 'string', maxLength: 200 },
          html: { type: 'string', maxLength: MAX_HTML_CHARS },
        },
        required: ['op', 'id'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { op: { const: 'delete' }, id },
        required: ['op', 'id'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { op: { const: 'move' }, ids: idList, dx: coord, dy: coord },
        required: ['op', 'ids'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { op: { const: 'duplicate' }, ids: idList, dx: coord, dy: coord },
        required: ['op', 'ids'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { op: { const: 'style' }, ids: idList, ...style },
        required: ['op', 'ids'],
        additionalProperties: false,
      },
    ],
  };
}
