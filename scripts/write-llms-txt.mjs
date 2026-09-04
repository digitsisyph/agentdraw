// Writes public/llms.txt from the tool manifest. Runs as part of `pnpm build`.
import { writeFile } from 'node:fs/promises';
import { renderLlmsTxt } from '../src/lib/llms-txt.ts';

const target = new URL('../public/llms.txt', import.meta.url);
await writeFile(target, renderLlmsTxt());
console.log('public/llms.txt written');
