import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { renderLlmsTxt } from '../src/lib/llms-txt.ts';
import { TOOL_MANIFEST } from '../src/lib/tool-manifest.ts';
import { BOOTSTRAP_PROMPT, SITE_URL } from '../src/lib/site.ts';

test('llms.txt lists every tool and the bootstrap prompt', () => {
  assert.ok(!renderLlmsTxt().includes('github.com'));
  const text = renderLlmsTxt();
  assert.equal(TOOL_MANIFEST.length, 8);
  for (const tool of TOOL_MANIFEST) assert.ok(text.includes(`### ${tool.name}`), tool.name);
  assert.ok(text.includes(BOOTSTRAP_PROMPT));
  assert.ok(text.includes(SITE_URL));
});

test('public/llms.txt matches the manifest (run pnpm build to regenerate)', async () => {
  const committed = await readFile(new URL('../public/llms.txt', import.meta.url), 'utf8');
  assert.equal(committed, renderLlmsTxt());
});
