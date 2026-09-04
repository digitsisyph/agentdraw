/**
 * Turns validated patch specs into Excalidraw elements. Uses Excalidraw's own
 * builders so labels are measured, ids are honoured, and defaults match what
 * a person would get from the toolbar.
 */
import {
  convertToExcalidrawElements,
  getCommonBounds,
  restoreElements,
} from '@excalidraw/excalidraw';
import type {
  ExcalidrawElement,
  ExcalidrawLinearElement,
  ExcalidrawTextElement,
} from '@excalidraw/excalidraw/element/types';
import { FONT_FAMILY_IDS } from './patch-schema';
import type { CreateSpec, LabelSpec, StyleSpec, UpdateSpec } from './patch-schema';
import { HTML_LINK, htmlOf, withHtml } from './html-embed';

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Pair = [number, number];
const ARROW_GAP = 8;

export function randomInteger() {
  return Math.floor(Math.random() * 2 ** 31);
}

export function stamp<T extends ExcalidrawElement>(element: T, patch: Partial<T>): T {
  return {
    ...element,
    ...patch,
    version: element.version + 1,
    versionNonce: randomInteger(),
    updated: Date.now(),
  };
}

export function elementBounds(element: ExcalidrawElement): Bounds {
  const [minX, minY, maxX, maxY] = getCommonBounds([element]);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function sceneBounds(elements: readonly ExcalidrawElement[]): Bounds | null {
  const live = elements.filter((element) => !element.isDeleted);
  if (!live.length) return null;
  const [minX, minY, maxX, maxY] = getCommonBounds(live);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function centerOf(element: ExcalidrawElement) {
  const bounds = elementBounds(element);
  return { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
}

/**
 * Where an arrow should touch `element` when aimed at `toward`: the boundary
 * of its box (or ellipse) along the ray from its centre, plus a small gap.
 * Excalidraw re-routes bound arrows when the person drags things; this makes
 * agent-made and agent-moved arrows look right immediately.
 */
export function anchorOn(element: ExcalidrawElement, toward: { x: number; y: number }, gap: number) {
  const bounds = elementBounds(element);
  const center = centerOf(element);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-6) return center;
  const ux = dx / distance;
  const uy = dy / distance;
  const halfW = bounds.w / 2;
  const halfH = bounds.h / 2;
  let reach: number;
  if (element.type === 'ellipse') {
    const denominator = Math.hypot(ux / Math.max(halfW, 1e-6), uy / Math.max(halfH, 1e-6));
    reach = 1 / denominator;
  } else {
    const reachX = Math.abs(ux) > 1e-6 ? halfW / Math.abs(ux) : Infinity;
    const reachY = Math.abs(uy) > 1e-6 ? halfH / Math.abs(uy) : Infinity;
    reach = Math.min(reachX, reachY);
  }
  const total = Math.min(reach + gap, distance / 2);
  return { x: center.x + ux * total, y: center.y + uy * total };
}

function linearGeometry(points: readonly Pair[]) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function styleProps(spec: StyleSpec) {
  const props: Record<string, unknown> = {};
  if (spec.strokeColor !== undefined) props.strokeColor = spec.strokeColor;
  if (spec.backgroundColor !== undefined) props.backgroundColor = spec.backgroundColor;
  if (spec.fillStyle !== undefined) props.fillStyle = spec.fillStyle;
  if (spec.strokeWidth !== undefined) props.strokeWidth = spec.strokeWidth;
  if (spec.strokeStyle !== undefined) props.strokeStyle = spec.strokeStyle;
  if (spec.roughness !== undefined) props.roughness = spec.roughness;
  if (spec.opacity !== undefined) props.opacity = spec.opacity;
  if (spec.roundness !== undefined) {
    props.roundness = spec.roundness === 'round' ? { type: 3 } : null;
  }
  return props;
}

function commonProps(spec: CreateSpec) {
  return {
    id: spec.id,
    x: spec.x,
    y: spec.y,
    ...(spec.angle !== undefined ? { angle: spec.angle } : {}),
    ...(spec.frameId ? { frameId: spec.frameId } : {}),
    ...(spec.locked !== undefined ? { locked: spec.locked } : {}),
    ...(spec.link !== undefined ? { link: spec.link } : {}),
    ...(spec.customData !== undefined ? { customData: spec.customData } : {}),
    ...styleProps(spec),
  };
}

function restoreOne(partial: Record<string, unknown>) {
  const [element] = restoreElements([partial as unknown as ExcalidrawElement], null);
  if (!element) throw new Error(`Could not build ${String(partial.type)} element.`);
  return element as ExcalidrawElement;
}

function arrowheadValue(value: string | undefined, fallback: string | null) {
  if (value === undefined) return fallback;
  return value === 'none' ? null : value;
}

function withBoundElement(element: ExcalidrawElement, bound: { id: string; type: 'arrow' | 'text' }) {
  const existing = element.boundElements ?? [];
  if (existing.some((entry) => entry.id === bound.id)) return element;
  return stamp(element, { boundElements: [...existing, bound] });
}

const LABEL_CONTAINER_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'arrow']);

export function labelOf(container: ExcalidrawElement, all: readonly ExcalidrawElement[]) {
  return all.find(
    (other): other is ExcalidrawTextElement =>
      other.type === 'text' && !other.isDeleted && (other as ExcalidrawTextElement).containerId === container.id,
  );
}

/** The point halfway along a polyline, by length. */
export function polylineMidpoint(points: readonly { x: number; y: number }[]) {
  if (points.length === 1) return points[0];
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y));
  const total = lengths.reduce((sum, value) => sum + value, 0);
  let remaining = total / 2;
  for (let index = 0; index < lengths.length; index += 1) {
    if (remaining <= lengths[index] || index === lengths.length - 1) {
      const t = lengths[index] ? remaining / lengths[index] : 0;
      const a = points[index];
      const b = points[index + 1];
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= lengths[index];
  }
  return points[0];
}

/**
 * Builds or rebuilds a container's bound label through Excalidraw's converter,
 * so the text is measured, wrapped to the container, and centred for its
 * current geometry. An existing label keeps its id.
 */
export function buildLabel(
  container: ExcalidrawElement,
  existing: ExcalidrawTextElement | undefined,
  spec: LabelSpec | undefined,
): { container: ExcalidrawElement; label: ExcalidrawTextElement } {
  const fontSize = spec?.fontSize ?? existing?.fontSize;
  const fontFamily = spec?.fontFamily !== undefined ? FONT_FAMILY_IDS[spec.fontFamily] : existing?.fontFamily;
  const textAlign = spec?.textAlign ?? existing?.textAlign;
  const verticalAlign = spec?.verticalAlign ?? existing?.verticalAlign;
  const skeleton: Record<string, unknown> = {
    type: container.type,
    id: container.id,
    x: container.x,
    y: container.y,
    width: container.width,
    height: container.height,
    label: {
      text: spec?.text ?? existing?.text ?? '',
      ...(fontSize !== undefined ? { fontSize } : {}),
      ...(fontFamily !== undefined ? { fontFamily } : {}),
      ...(textAlign !== undefined ? { textAlign } : {}),
      ...(verticalAlign !== undefined ? { verticalAlign } : {}),
      ...(existing?.strokeColor ? { strokeColor: existing.strokeColor } : {}),
    },
  };
  if (container.type === 'arrow') {
    const linear = container as ExcalidrawLinearElement;
    skeleton.points = linear.points.map((point) => [point[0], point[1]]);
    skeleton.startArrowhead = linear.startArrowhead;
    skeleton.endArrowhead = linear.endArrowhead;
  }
  const converted = convertToExcalidrawElements([skeleton as never], { regenerateIds: false });
  const rebuiltContainer = converted.find((element) => element.id === container.id);
  const rebuiltText = converted.find(
    (element) => element.type === 'text' && (element as ExcalidrawTextElement).containerId === container.id,
  ) as ExcalidrawTextElement | undefined;
  if (!rebuiltText) throw new Error(`Could not build a label for ${container.id}.`);
  const labelId = existing?.id ?? rebuiltText.id;
  const label: ExcalidrawTextElement = {
    ...rebuiltText,
    id: labelId,
    frameId: container.frameId,
    groupIds: container.groupIds,
    locked: container.locked,
    opacity: existing?.opacity ?? container.opacity,
    version: (existing?.version ?? 0) + 1,
    versionNonce: randomInteger(),
    updated: Date.now(),
  };
  const boundElements = [
    ...(container.boundElements ?? []).filter((bound) => bound.type !== 'text'),
    { type: 'text' as const, id: labelId },
  ];
  const patch: Record<string, unknown> = { boundElements };
  if (container.type !== 'arrow' && rebuiltContainer) {
    // Excalidraw grows a container that cannot hold its text; do the same.
    if (rebuiltContainer.height > container.height) patch.height = rebuiltContainer.height;
    if (rebuiltContainer.width > container.width) patch.width = rebuiltContainer.width;
  }
  return { container: stamp(container, patch as Partial<ExcalidrawElement>), label };
}

/** Moves elements by a delta. Arrow and line points are relative, so they follow. */
export function translateElements(elements: readonly ExcalidrawElement[], dx: number, dy: number) {
  if (!dx && !dy) return [...elements];
  return elements.map((element) => stamp(element, { x: element.x + dx, y: element.y + dy }));
}

/**
 * Fresh ids for a set of elements. References inside the set follow the
 * renaming; bindings and frame or container references that point outside
 * the set are dropped, so the copy stands on its own.
 */
export function remapIds(
  elements: readonly ExcalidrawElement[],
  newId: () => string,
): { elements: ExcalidrawElement[]; idMap: Map<string, string> } {
  const idMap = new Map(elements.map((element) => [element.id, newId()]));
  const groupMap = new Map<string, string>();
  const mapGroup = (group: string) => {
    if (!groupMap.has(group)) groupMap.set(group, newId());
    return groupMap.get(group)!;
  };
  const remapped = elements.map((element) => {
    const next: Record<string, unknown> = {
      ...element,
      id: idMap.get(element.id),
      groupIds: element.groupIds.map(mapGroup),
      frameId: element.frameId ? (idMap.get(element.frameId) ?? null) : null,
      boundElements: element.boundElements
        ? element.boundElements.filter((bound) => idMap.has(bound.id)).map((bound) => ({ ...bound, id: idMap.get(bound.id)! }))
        : element.boundElements,
      version: 1,
      versionNonce: randomInteger(),
      updated: Date.now(),
    };
    if (element.type === 'text') {
      const containerId = (element as ExcalidrawTextElement).containerId;
      next.containerId = containerId ? (idMap.get(containerId) ?? null) : null;
    }
    if (element.type === 'arrow' || element.type === 'line') {
      const linear = element as ExcalidrawLinearElement;
      next.startBinding =
        linear.startBinding && idMap.has(linear.startBinding.elementId)
          ? { ...linear.startBinding, elementId: idMap.get(linear.startBinding.elementId)! }
          : null;
      next.endBinding =
        linear.endBinding && idMap.has(linear.endBinding.elementId)
          ? { ...linear.endBinding, elementId: idMap.get(linear.endBinding.elementId)! }
          : null;
    }
    return next as unknown as ExcalidrawElement;
  });
  return { elements: remapped, idMap };
}

/** Restyles one element with the agent's whitelisted style fields. */
export function applyStyle(element: ExcalidrawElement, style: StyleSpec) {
  const patch = styleProps(style);
  return Object.keys(patch).length ? stamp(element, patch as Partial<ExcalidrawElement>) : element;
}

export interface BuildResult {
  created: ExcalidrawElement[];
  /** Existing elements that changed as a side effect (arrow targets). */
  updated: ExcalidrawElement[];
}

export function buildElements(
  spec: CreateSpec,
  existing: ReadonlyMap<string, ExcalidrawElement>,
): BuildResult {
  const result = buildElementsRaw(spec, existing);
  // Excalidraw's converter leaves a label's frameId null even when its
  // container sits in a frame; Excalidraw itself keeps them in sync.
  const created = result.created.map((element) => {
    if (element.type !== 'text' || !element.containerId) return element;
    const container = result.created.find((other) => other.id === element.containerId);
    return container?.frameId && element.frameId !== container.frameId
      ? { ...element, frameId: container.frameId }
      : element;
  });
  return { created, updated: result.updated };
}

function buildElementsRaw(
  spec: CreateSpec,
  existing: ReadonlyMap<string, ExcalidrawElement>,
): BuildResult {
  const label = spec.label
    ? {
        label: {
          text: spec.label.text,
          ...(spec.label.fontSize !== undefined ? { fontSize: spec.label.fontSize } : {}),
          ...(spec.label.fontFamily !== undefined ? { fontFamily: FONT_FAMILY_IDS[spec.label.fontFamily] } : {}),
          ...(spec.label.textAlign !== undefined ? { textAlign: spec.label.textAlign } : {}),
          ...(spec.label.verticalAlign !== undefined ? { verticalAlign: spec.label.verticalAlign } : {}),
        },
      }
    : {};

  switch (spec.type) {
    case 'text': {
      const created = convertToExcalidrawElements(
        [
          {
            type: 'text',
            ...commonProps(spec),
            text: spec.text ?? '',
            ...(spec.fontSize !== undefined ? { fontSize: spec.fontSize } : {}),
            ...(spec.fontFamily !== undefined ? { fontFamily: FONT_FAMILY_IDS[spec.fontFamily] } : {}),
            ...(spec.textAlign !== undefined ? { textAlign: spec.textAlign } : {}),
            ...(spec.verticalAlign !== undefined ? { verticalAlign: spec.verticalAlign } : {}),
          },
        ],
        { regenerateIds: false },
      );
      return { created, updated: [] };
    }
    case 'rectangle':
    case 'ellipse':
    case 'diamond': {
      const created = convertToExcalidrawElements(
        [
          {
            type: spec.type,
            ...commonProps(spec),
            ...(spec.width !== undefined ? { width: spec.width } : {}),
            ...(spec.height !== undefined ? { height: spec.height } : {}),
            ...label,
          },
        ],
        { regenerateIds: false },
      );
      return { created, updated: [] };
    }
    case 'frame': {
      const width = spec.width ?? 800;
      const height = spec.height ?? 600;
      const created = convertToExcalidrawElements(
        [
          {
            type: 'frame',
            ...commonProps(spec),
            width,
            height,
            ...(spec.name ? { name: spec.name } : {}),
            children: [],
          },
        ],
        { regenerateIds: false },
      );
      // Excalidraw's converter treats a 0 coordinate as "not given" and pads
      // the frame by 10; pin the geometry to what the agent asked for.
      return {
        created: created.map((element) =>
          element.type === 'frame' ? { ...element, x: spec.x, y: spec.y, width, height } : element,
        ),
        updated: [],
      };
    }
    case 'embeddable': {
      const source =
        spec.html !== undefined ? { ...spec, link: HTML_LINK, customData: withHtml(spec.customData, spec.html) } : spec;
      return {
        created: [
          restoreOne({
            type: 'embeddable',
            ...commonProps(source),
            width: spec.width ?? 640,
            height: spec.height ?? 480,
          }),
        ],
        updated: [],
      };
    }
    case 'image': {
      if (!spec.fileId) throw new Error('An image needs its file stored first.');
      return {
        created: [
          restoreOne({
            type: 'image',
            ...commonProps(spec),
            width: spec.width ?? 400,
            height: spec.height ?? 300,
            fileId: spec.fileId,
            status: 'saved',
            scale: [1, 1],
          }),
        ],
        updated: [],
      };
    }
    case 'arrow':
    case 'line': {
      const startTarget = spec.start && 'id' in spec.start ? existing.get(spec.start.id) : undefined;
      const endTarget = spec.end && 'id' in spec.end ? existing.get(spec.end.id) : undefined;
      const given = spec.points;
      const startCenter =
        spec.start && 'x' in spec.start ? spec.start : startTarget ? centerOf(startTarget) : { x: spec.x, y: spec.y };
      const endCenter =
        spec.end && 'x' in spec.end
          ? spec.end
          : endTarget
            ? centerOf(endTarget)
            : given
              ? { x: spec.x + given[given.length - 1][0], y: spec.y + given[given.length - 1][1] }
              : { x: spec.x + (spec.width ?? 200), y: spec.y + (spec.height ?? 0) };
      // Aim each bound end at the neighbouring point so multi-point arrows bend naturally.
      const startAim = given && given.length > 2 ? { x: spec.x + given[1][0], y: spec.y + given[1][1] } : endCenter;
      const endAim =
        given && given.length > 2
          ? { x: spec.x + given[given.length - 2][0], y: spec.y + given[given.length - 2][1] }
          : startCenter;
      const startPoint = startTarget ? anchorOn(startTarget, startAim, ARROW_GAP) : startCenter;
      const endPoint = endTarget ? anchorOn(endTarget, endAim, ARROW_GAP) : endCenter;

      let origin: { x: number; y: number };
      let points: Pair[];
      if (given) {
        const [firstX, firstY] = given[0];
        origin = startTarget ? startPoint : { x: spec.x + firstX, y: spec.y + firstY };
        points = given.map(([px, py]) => [px - firstX, py - firstY]);
        if (startTarget) {
          // Keep the drawn shape; only the first point moves onto the start shape.
          const shiftX = origin.x - (spec.x + firstX);
          const shiftY = origin.y - (spec.y + firstY);
          points = points.map((point, index) => (index === 0 ? point : [point[0] - shiftX, point[1] - shiftY]));
        }
        if (endTarget) points[points.length - 1] = [endPoint.x - origin.x, endPoint.y - origin.y];
      } else {
        origin = startPoint;
        points = [
          [0, 0],
          [endPoint.x - origin.x, endPoint.y - origin.y],
        ];
      }
      const geometry = linearGeometry(points);
      const bindings = Boolean(startTarget || endTarget);
      if (!bindings) {
        const created = convertToExcalidrawElements(
          [
            {
              type: spec.type,
              ...commonProps(spec),
              x: origin.x,
              y: origin.y,
              width: geometry.width,
              height: geometry.height,
              points: points.map(([px, py]) => [px, py]),
              ...(spec.type === 'arrow'
                ? {
                    startArrowhead: arrowheadValue(spec.startArrowhead, null),
                    endArrowhead: arrowheadValue(spec.endArrowhead, 'arrow'),
                  }
                : {}),
              ...label,
            } as Parameters<typeof convertToExcalidrawElements>[0] extends (infer T)[] | null ? T : never,
          ],
          { regenerateIds: false },
        );
        return { created, updated: [] };
      }
      // An arrow between two children of one frame belongs to that frame, as it would when drawn by hand.
      const sharedFrame =
        spec.frameId ?? (startTarget?.frameId && startTarget.frameId === endTarget?.frameId ? startTarget.frameId : undefined);
      const arrow = restoreOne({
        type: spec.type,
        ...commonProps(spec),
        ...(sharedFrame ? { frameId: sharedFrame } : {}),
        x: origin.x,
        y: origin.y,
        width: geometry.width,
        height: geometry.height,
        points,
        startBinding: startTarget ? { elementId: startTarget.id, focus: 0, gap: ARROW_GAP } : null,
        endBinding: endTarget ? { elementId: endTarget.id, focus: 0, gap: ARROW_GAP } : null,
        startArrowhead: spec.type === 'arrow' ? arrowheadValue(spec.startArrowhead, null) : null,
        endArrowhead: spec.type === 'arrow' ? arrowheadValue(spec.endArrowhead, 'arrow') : null,
        roundness: spec.roundness === 'sharp' ? null : { type: 2 },
      });
      const updated: ExcalidrawElement[] = [];
      for (const target of [startTarget, endTarget]) {
        if (!target) continue;
        const already = updated.find((entry) => entry.id === target.id) ?? target;
        const next = withBoundElement(already, { id: arrow.id, type: 'arrow' });
        if (next !== already) {
          const index = updated.findIndex((entry) => entry.id === target.id);
          if (index >= 0) updated[index] = next;
          else updated.push(next);
        }
      }
      if (spec.label && spec.type === 'arrow') {
        const labelled = buildLabel(arrow, undefined, spec.label);
        return { created: [labelled.container, labelled.label], updated };
      }
      return { created: [arrow], updated };
    }
  }
}

/** Elements that must move with `element`: its label, and for frames, every child and their labels. */
export function dependentsOf(element: ExcalidrawElement, all: readonly ExcalidrawElement[]) {
  const ids = new Set<string>();
  for (const other of all) {
    if (other.isDeleted || other.id === element.id) continue;
    if (other.type === 'text' && other.containerId === element.id) ids.add(other.id);
    if (element.type === 'frame' && other.frameId === element.id) ids.add(other.id);
  }
  if (element.type === 'frame') {
    for (const other of all) {
      if (other.isDeleted || other.type !== 'text' || !other.containerId) continue;
      if (ids.has(other.containerId)) ids.add(other.id);
    }
  }
  return ids;
}

/** Applies an update spec; returns every element that changed. */
export function applyUpdate(
  element: ExcalidrawElement,
  spec: UpdateSpec,
  all: readonly ExcalidrawElement[],
): ExcalidrawElement[] {
  const retype =
    spec.text !== undefined ||
    spec.fontSize !== undefined ||
    spec.fontFamily !== undefined ||
    spec.textAlign !== undefined ||
    spec.verticalAlign !== undefined;
  if (retype && element.type === 'text') {
    const text = element as ExcalidrawTextElement;
    const rebuilt = convertToExcalidrawElements(
      [
        {
          type: 'text',
          id: text.id,
          x: spec.x ?? text.x,
          y: spec.y ?? text.y,
          text: spec.text ?? text.originalText ?? text.text,
          fontSize: spec.fontSize ?? text.fontSize,
          fontFamily: spec.fontFamily !== undefined ? FONT_FAMILY_IDS[spec.fontFamily] : text.fontFamily,
          textAlign: spec.textAlign ?? text.textAlign,
          verticalAlign: spec.verticalAlign ?? text.verticalAlign,
          strokeColor: spec.strokeColor ?? text.strokeColor,
          opacity: spec.opacity ?? text.opacity,
          angle: spec.angle ?? text.angle,
          frameId: spec.frameId === undefined ? text.frameId : spec.frameId,
          groupIds: text.groupIds,
          locked: spec.locked ?? text.locked,
          link: spec.link === undefined ? (text.link ?? undefined) : (spec.link ?? undefined),
          customData: spec.customData === undefined ? text.customData : (spec.customData ?? undefined),
        },
      ],
      { regenerateIds: false },
    );
    return rebuilt.map((next) => ({ ...next, version: text.version + 1 }));
  }

  const patch: Record<string, unknown> = { ...styleProps(spec) };
  if (spec.width !== undefined) patch.width = spec.width;
  if (spec.height !== undefined) patch.height = spec.height;
  if (spec.angle !== undefined) patch.angle = spec.angle;
  if (spec.frameId !== undefined) patch.frameId = spec.frameId;
  if (spec.locked !== undefined) patch.locked = spec.locked;
  if (spec.link !== undefined) {
    patch.link = spec.link;
    // A real link replaces agent HTML.
    if (htmlOf(element) !== null) patch.customData = withHtml(element.customData, null);
  }
  if (spec.html !== undefined) {
    patch.link = HTML_LINK;
    patch.customData = withHtml(element.customData, spec.html);
  }
  if (spec.customData !== undefined) patch.customData = spec.customData ?? undefined;
  if (spec.name !== undefined && element.type === 'frame') patch.name = spec.name;

  const dx = spec.x !== undefined ? spec.x - element.x : 0;
  const dy = spec.y !== undefined ? spec.y - element.y : 0;
  if (dx || dy) {
    patch.x = element.x + dx;
    patch.y = element.y + dy;
  }
  const changed: ExcalidrawElement[] = [stamp(element, patch as Partial<ExcalidrawElement>)];
  const dependents = dx || dy ? dependentsOf(element, all) : new Set<string>();
  const existingLabel = LABEL_CONTAINER_TYPES.has(element.type) ? labelOf(element, all) : undefined;
  let handledLabelId: string | null = null;
  if (spec.label === null) {
    if (existingLabel) {
      changed.push(stamp(existingLabel, { isDeleted: true }));
      changed[0] = stamp(changed[0], {
        boundElements: (changed[0].boundElements ?? []).filter((bound) => bound.id !== existingLabel.id),
      });
      handledLabelId = existingLabel.id;
    }
  } else if (spec.label || (existingLabel && (spec.width !== undefined || spec.height !== undefined))) {
    // A new text or a new size: let Excalidraw measure and centre the label again.
    const rebuilt = buildLabel(changed[0], existingLabel, spec.label ?? undefined);
    changed[0] = rebuilt.container;
    changed.push(rebuilt.label);
    handledLabelId = rebuilt.label.id;
  }
  for (const other of all) {
    if (other.isDeleted || other.id === handledLabelId) continue;
    const followUp: Record<string, unknown> = {};
    if (dependents.has(other.id)) {
      followUp.x = other.x + dx;
      followUp.y = other.y + dy;
    }
    // A label lives in whatever frame its container does.
    if (spec.frameId !== undefined && other.type === 'text' && other.containerId === element.id) {
      followUp.frameId = spec.frameId;
    }
    if (Object.keys(followUp).length) changed.push(stamp(other, followUp as Partial<ExcalidrawElement>));
  }
  return changed;
}

/**
 * Recomputes the endpoints of arrows and lines bound to any of `movedIds`,
 * so an agent's move or resize keeps connections attached. Returns the ids
 * of the arrows it changed.
 */
export function rerouteBoundArrows(
  byId: Map<string, ExcalidrawElement>,
  movedIds: ReadonlySet<string>,
): string[] {
  const rerouted: string[] = [];
  for (const element of byId.values()) {
    if (element.isDeleted || (element.type !== 'arrow' && element.type !== 'line')) continue;
    const linear = element as ExcalidrawLinearElement;
    const startId = linear.startBinding?.elementId;
    const endId = linear.endBinding?.elementId;
    if (!(startId && movedIds.has(startId)) && !(endId && movedIds.has(endId))) continue;
    const startTarget = startId ? byId.get(startId) : undefined;
    const endTarget = endId ? byId.get(endId) : undefined;
    if (startTarget?.isDeleted || endTarget?.isDeleted) continue;
    const absolute = linear.points.map(([px, py]) => ({ x: linear.x + px, y: linear.y + py }));
    if (absolute.length < 2) continue;
    const first = absolute[0];
    const last = absolute[absolute.length - 1];
    const startAim = absolute.length > 2 ? absolute[1] : endTarget ? centerOf(endTarget) : last;
    const endAim = absolute.length > 2 ? absolute[absolute.length - 2] : startTarget ? centerOf(startTarget) : first;
    const newStart = startTarget ? anchorOn(startTarget, startAim, ARROW_GAP) : first;
    const newEnd = endTarget ? anchorOn(endTarget, endAim, ARROW_GAP) : last;
    const route = [newStart, ...absolute.slice(1, -1), newEnd];
    const points = route.map((point) => [point.x - newStart.x, point.y - newStart.y] as Pair);
    const geometry = linearGeometry(points);
    byId.set(
      linear.id,
      stamp(linear, {
        x: newStart.x,
        y: newStart.y,
        points: points as unknown as ExcalidrawLinearElement['points'],
        width: geometry.width,
        height: geometry.height,
      } as Partial<ExcalidrawLinearElement>),
    );
    rerouted.push(linear.id);
    const label = labelOf(linear, [...byId.values()]);
    if (label) {
      const mid = polylineMidpoint(route);
      byId.set(label.id, stamp(label, { x: mid.x - label.width / 2, y: mid.y - label.height / 2 }));
      rerouted.push(label.id);
    }
  }
  return rerouted;
}

/** Marks an element deleted along with its label and frame children; unbinds arrows. */
export function deleteWithDependents(
  byId: Map<string, ExcalidrawElement>,
  id: string,
): string[] {
  const removed = new Set<string>([id]);
  for (const other of byId.values()) {
    if (other.isDeleted) continue;
    if ((other.type === 'text' && other.containerId === id) || other.frameId === id) removed.add(other.id);
  }
  for (const other of byId.values()) {
    if (other.isDeleted || other.type !== 'text' || !other.containerId) continue;
    if (removed.has(other.containerId)) removed.add(other.id);
  }
  for (const removedId of removed) {
    const element = byId.get(removedId);
    if (element && !element.isDeleted) byId.set(removedId, stamp(element, { isDeleted: true }));
  }
  for (const other of byId.values()) {
    if (other.isDeleted) continue;
    let next: ExcalidrawElement = other;
    if (other.boundElements?.some((bound) => removed.has(bound.id))) {
      next = stamp(next, { boundElements: other.boundElements.filter((bound) => !removed.has(bound.id)) });
    }
    if (other.type === 'arrow' || other.type === 'line') {
      const linear = next as ExcalidrawLinearElement;
      const patch: { startBinding?: null; endBinding?: null } = {};
      if (linear.startBinding && removed.has(linear.startBinding.elementId)) patch.startBinding = null;
      if (linear.endBinding && removed.has(linear.endBinding.elementId)) patch.endBinding = null;
      if (Object.keys(patch).length) next = stamp(linear, patch as Partial<ExcalidrawLinearElement>);
    }
    if (next !== other) byId.set(next.id, next);
  }
  return [...removed];
}
