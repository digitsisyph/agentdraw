/**
 * Agent-authored HTML rides along in an embeddable's internal customData and
 * is rendered by AgentDraw's own sandboxed srcdoc iframe (Excalidraw's
 * renderEmbeddable hook). The element's link is a fixed marker, because
 * Excalidraw sanitises links and would turn a data: URL into about:blank.
 */
export const MAX_HTML_CHARS = 200_000;
/** Key under customData where AgentDraw keeps its own marks; hidden from agents' customData view. */
export const INTERNAL_DATA_KEY = 'agentdraw';
export const HTML_LINK = 'https://agentdraw.app/html';

type Data = Record<string, unknown> | undefined;

function internal(customData: Data): Record<string, unknown> {
  const value = customData?.[INTERNAL_DATA_KEY];
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function isHtmlLink(link: string | null | undefined): link is string {
  return link === HTML_LINK;
}

export function htmlOf(element: { customData?: Data; link?: string | null }): string | null {
  const html = internal(element.customData).html;
  return typeof html === 'string' ? html : null;
}

/** customData with the HTML set, keeping every other internal mark and the agent's own keys. */
export function withHtml(customData: Data, html: string | null): Record<string, unknown> {
  const marks = { ...internal(customData) };
  if (html === null) delete marks.html;
  else marks.html = html;
  return { ...customData, [INTERNAL_DATA_KEY]: marks };
}

/** What inspect_canvas says about an HTML embed without spending the tokens on its source. */
export function describeHtml(html: string, excerptChars = 200) {
  const excerpt = html.replace(/\s+/g, ' ').trim().slice(0, excerptChars);
  return { chars: html.length, excerpt };
}
