/**
 * Pure summaries of Excalidraw elements for agents. Structural types only, so
 * this module has no Excalidraw import and runs under node:test.
 */

import { INTERNAL_DATA_KEY, describeHtml, htmlOf, isHtmlLink } from './html-embed.ts';
import { FONT_FAMILY_IDS, MAX_CUSTOM_DATA_CHARS, type FontFamilyName } from './patch-schema.ts';

/** Excalidraw font ids, legacy ones included, back to the agent-facing names. */
export function fontFamilyName(id: number): FontFamilyName {
  for (const [name, familyId] of Object.entries(FONT_FAMILY_IDS)) if (familyId === id) return name as FontFamilyName;
  if (id === 1) return 'hand';
  if (id === 2 || id === 9) return 'normal';
  if (id === 3) return 'code';
  return 'hand';
}

export { INTERNAL_DATA_KEY };

export interface ElementLike {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  isDeleted: boolean;
  version: number;
  versionNonce: number;
  strokeColor: string;
  backgroundColor: string;
  opacity: number;
  locked: boolean;
  frameId: string | null;
  groupIds: readonly string[];
  link?: string | null;
  customData?: Record<string, unknown>;
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  containerId?: string | null;
  name?: string | null;
  points?: readonly (readonly number[])[];
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  boundElements?: readonly { id: string; type: string }[] | null;
}

export interface Point {
  x: number;
  y: number;
}

export interface HtmlSummary {
  chars: number;
  excerpt: string;
  /** Only when inspect_canvas was asked for it with includeHtml. */
  text?: string;
}

export interface SummarizedElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  opacity: number;
  locked: boolean;
  frameId: string | null;
  groupIds: string[];
  link?: string;
  /** Embeddables carrying agent HTML report its size and an excerpt instead of the link. */
  html?: HtmlSummary;
  text?: string;
  fontSize?: number;
  fontFamily?: FontFamilyName;
  name?: string;
  containerId?: string;
  boundTextId?: string;
  startBindingId?: string;
  endBindingId?: string;
  points?: Point[];
  /** For the person's marks: ids of shapes their bounding box touches. */
  nearIds?: string[];
  customData?: Record<string, unknown>;
  /** Who created it: agents mark their elements; everything else is the person's. */
  by: 'agent' | 'person';
}

export function authorOf(element: Pick<ElementLike, 'customData'>): 'agent' | 'person' {
  const marker = element.customData?.[INTERNAL_DATA_KEY] as { by?: unknown } | undefined;
  return marker?.by === 'agent' ? 'agent' : 'person';
}

/** The compact projection for large boards: geometry, text, and bindings only. */
export interface OutlineElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  text?: string;
  name?: string;
  link?: string;
  htmlChars?: number;
  locked?: true;
  frameId?: string;
  groupIds?: string[];
  containerId?: string;
  boundTextId?: string;
  startBindingId?: string;
  endBindingId?: string;
  nearIds?: string[];
  by?: 'agent';
}

export function toOutline(summary: SummarizedElement): OutlineElement {
  const outline: OutlineElement = {
    id: summary.id,
    type: summary.type,
    x: summary.x,
    y: summary.y,
    width: summary.width,
    height: summary.height,
  };
  if (summary.angle) outline.angle = summary.angle;
  if (summary.text !== undefined) outline.text = summary.text;
  if (summary.name !== undefined) outline.name = summary.name;
  if (summary.link) outline.link = summary.link;
  if (summary.html) outline.htmlChars = summary.html.chars;
  if (summary.locked) outline.locked = true;
  if (summary.frameId) outline.frameId = summary.frameId;
  if (summary.groupIds.length) outline.groupIds = summary.groupIds;
  if (summary.containerId) outline.containerId = summary.containerId;
  if (summary.boundTextId) outline.boundTextId = summary.boundTextId;
  if (summary.startBindingId) outline.startBindingId = summary.startBindingId;
  if (summary.endBindingId) outline.endBindingId = summary.endBindingId;
  if (summary.nearIds?.length) outline.nearIds = summary.nearIds;
  if (summary.by === 'agent') outline.by = 'agent';
  return outline;
}

export type GraphNode = OutlineElement;
export interface GraphEdge {
  id: string;
  from?: string;
  to?: string;
  text?: string;
  frameId?: string;
  by?: 'agent';
}
export interface GraphFrame {
  id: string;
  name: string;
  children: string[];
}
export interface GraphMark {
  id: string;
  type: string;
  nearIds: string[];
}

/**
 * The board as a graph: labelled shapes are nodes, arrows and lines are edges,
 * frames are groups, the person's strokes are marks. Bound labels fold into
 * their containers.
 */
export function buildGraph(summaries: readonly SummarizedElement[]) {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const frames: GraphFrame[] = [];
  const marks: GraphMark[] = [];
  for (const summary of summaries) {
    if (summary.containerId) continue;
    if (summary.type === 'frame' || summary.type === 'magicframe') {
      frames.push({
        id: summary.id,
        name: summary.name ?? '',
        children: summaries
          .filter((other) => other.frameId === summary.id && !other.containerId)
          .map((other) => other.id),
      });
    } else if (summary.type === 'arrow' || summary.type === 'line') {
      const edge: GraphEdge = { id: summary.id };
      if (summary.startBindingId) edge.from = summary.startBindingId;
      if (summary.endBindingId) edge.to = summary.endBindingId;
      if (summary.text) edge.text = summary.text;
      if (summary.frameId) edge.frameId = summary.frameId;
      if (summary.by === 'agent') edge.by = 'agent';
      edges.push(edge);
    } else if (summary.type === 'freedraw') {
      marks.push({ id: summary.id, type: summary.type, nearIds: summary.nearIds ?? [] });
    } else {
      nodes.push(toOutline(summary));
    }
  }
  return { nodes, edges, frames, marks };
}

export function round(value: number) {
  return Math.round(value * 100) / 100;
}

export function samplePoints(points: readonly Point[], limit = 64) {
  if (points.length <= limit) return [...points];
  const sampled: Point[] = [];
  const lastIndex = points.length - 1;
  for (let index = 0; index < limit; index += 1) {
    sampled.push(points[Math.round((index / (limit - 1)) * lastIndex)]);
  }
  return sampled;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** True when two rectangles overlap after padding the first by `pad` units. */
export function rectsIntersect(a: Rect, b: Rect, pad = 0) {
  return (
    a.x - pad < b.x + b.width &&
    a.x + a.width + pad > b.x &&
    a.y - pad < b.y + b.height &&
    a.y + a.height + pad > b.y
  );
}

export function summarizeElement(
  element: ElementLike,
  elements: readonly ElementLike[],
  bounds?: Rect,
): SummarizedElement {
  const summary: SummarizedElement = {
    id: element.id,
    type: element.type,
    x: round(bounds ? bounds.x : element.x),
    y: round(bounds ? bounds.y : element.y),
    width: round(bounds ? bounds.width : element.width),
    height: round(bounds ? bounds.height : element.height),
    angle: round(element.angle),
    strokeColor: element.strokeColor,
    backgroundColor: element.backgroundColor,
    opacity: element.opacity,
    locked: element.locked,
    frameId: element.frameId ?? null,
    groupIds: [...element.groupIds],
    by: authorOf(element),
  };
  const html = htmlOf(element);
  if (html !== null) summary.html = describeHtml(html);
  else if (element.link && !isHtmlLink(element.link)) summary.link = element.link;
  if (element.type === 'text') {
    summary.text = element.text ?? '';
    if (typeof element.fontSize === 'number') summary.fontSize = element.fontSize;
    if (typeof element.fontFamily === 'number') summary.fontFamily = fontFamilyName(element.fontFamily);
    if (element.containerId) summary.containerId = element.containerId;
  }
  if (element.type === 'frame' || element.type === 'magicframe') {
    summary.name = element.name ?? '';
  }
  const boundText = element.boundElements?.find((bound) => bound.type === 'text');
  if (boundText) {
    const textElement = elements.find(
      (candidate) => candidate.id === boundText.id && !candidate.isDeleted,
    );
    if (textElement) {
      summary.boundTextId = textElement.id;
      summary.text = textElement.text ?? '';
    }
  }
  if (element.type === 'arrow' || element.type === 'line' || element.type === 'freedraw') {
    if (element.points) {
      summary.points = samplePoints(
        element.points.map((point) => ({
          x: round(element.x + (point[0] ?? 0)),
          y: round(element.y + (point[1] ?? 0)),
        })),
      );
    }
    if (element.startBinding?.elementId) summary.startBindingId = element.startBinding.elementId;
    if (element.endBinding?.elementId) summary.endBindingId = element.endBinding.elementId;
  }
  if (element.customData) {
    const { [INTERNAL_DATA_KEY]: _internal, ...visible } = element.customData;
    if (Object.keys(visible).length) {
      const serialized = JSON.stringify(visible);
      if (serialized.length <= MAX_CUSTOM_DATA_CHARS) summary.customData = visible;
    }
  }
  return summary;
}

export function summarizeScene(
  elements: readonly ElementLike[],
  boundsOf?: (element: ElementLike) => Rect | undefined,
) {
  return elements
    .filter((element) => !element.isDeleted)
    .map((element) => summarizeElement(element, elements, boundsOf?.(element)));
}

export interface SeenVersion {
  nonce: number;
  deleted: boolean;
}

export interface VersionDiff {
  addedIds: string[];
  updatedIds: string[];
  removedIds: string[];
  next: Map<string, SeenVersion>;
}

/** Compares elements to the versions last seen; the basis of the change journal. */
export function diffVersions(
  seen: ReadonlyMap<string, SeenVersion>,
  elements: readonly ElementLike[],
): VersionDiff {
  const addedIds: string[] = [];
  const updatedIds: string[] = [];
  const removedIds: string[] = [];
  const next = new Map<string, SeenVersion>();
  for (const element of elements) {
    const previous = seen.get(element.id);
    next.set(element.id, { nonce: element.versionNonce, deleted: element.isDeleted });
    if (!previous) {
      if (!element.isDeleted) addedIds.push(element.id);
      continue;
    }
    if (previous.nonce === element.versionNonce && previous.deleted === element.isDeleted) continue;
    if (element.isDeleted && !previous.deleted) removedIds.push(element.id);
    else if (!element.isDeleted && previous.deleted) addedIds.push(element.id);
    else if (!element.isDeleted) updatedIds.push(element.id);
  }
  for (const [id, previous] of seen) {
    if (!next.has(id) && !previous.deleted) removedIds.push(id);
  }
  return { addedIds, updatedIds, removedIds, next };
}
