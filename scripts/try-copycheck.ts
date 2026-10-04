/**
 * Calibrate the copy check (src/server/copycheck.ts) on real edits: the test-suite edits from the Library and the
 * try-qwen-copy.ts experiments.   npx tsx scripts/try-copycheck.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { copyMeasure } from '../src/server/copycheck.js';

const OUT = 'E:/Comfy-Desktop/ComfyUI-Shared/output';
const IN = 'E:/Comfy-Desktop/ComfyUI-Shared/input/darkroom';
const rows: [string, string, string][] = JSON.parse(fs.readFileSync('tests/results/qwen-copy/pairs.json', 'utf8'));
const file = (j: string) => {
  const f = JSON.parse(j) as { filename: string; subfolder: string };
  return path.join(OUT, f.subfolder, f.filename);
};
const res: string[] = [];
for (const [title, out, src] of rows) {
  const m = await copyMeasure(file(src), file(out));
  res.push(`${m.low.toFixed(1).padStart(5)} ${m.grain.toFixed(2).padStart(5)}  ${title}`);
}
for (const [dir, src] of [
  ['aut06', 'lib_282bfeeb-9f7e-421d-9b8f-82afab7dd58e_main.png'],
  ['aut06-seeds', 'lib_282bfeeb-9f7e-421d-9b8f-82afab7dd58e_main.png'],
  ['ftw06-seeds', 'lib_32cafd66-47cb-4877-a4ff-7cbdc7e1bbe3_main.png'],
]) {
  for (const f of fs.readdirSync(`tests/results/qwen-copy/${dir}`).filter((x) => x.endsWith('.png'))) {
    const m = await copyMeasure(path.join(IN, src), `tests/results/qwen-copy/${dir}/${f}`);
    res.push(`${m.low.toFixed(1).padStart(5)} ${m.grain.toFixed(2).padStart(5)}  try ${dir} ${f}`);
  }
}
console.log('  low grain  item');
console.log(res.sort((a, b) => parseFloat(a) - parseFloat(b)).join('\n'));
