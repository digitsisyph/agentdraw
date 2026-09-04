import assert from 'node:assert/strict';
import test from 'node:test';
import { HTML_LINK, describeHtml, htmlOf, isHtmlLink, withHtml } from '../src/lib/html-embed.ts';

test('html is kept in the internal customData mark and read back', () => {
  const html = '<!doctype html><h1>登录 · Login</h1><script>document.title = "ok"</script>';
  const customData = withHtml({ note: 1, agentdraw: { by: 'agent' } }, html);
  assert.deepEqual(customData, { note: 1, agentdraw: { by: 'agent', html } });
  assert.equal(htmlOf({ customData }), html);
  assert.equal(htmlOf({ customData: { note: 1 } }), null);
  assert.deepEqual(withHtml(customData, null), { note: 1, agentdraw: { by: 'agent' } });
  assert.ok(isHtmlLink(HTML_LINK));
  assert.equal(isHtmlLink('https://example.com'), false);
});

test('describeHtml reports size and a whitespace-collapsed excerpt', () => {
  const html = '<div>\n   hello   world\n</div>' + 'x'.repeat(500);
  const summary = describeHtml(html, 20);
  assert.equal(summary.chars, html.length);
  assert.equal(summary.excerpt, '<div> hello world </');
});
