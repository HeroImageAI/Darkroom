/** Build BENCHMARKS.md from bench/results.jsonl (written by scripts/run-workflow.ts). */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/server/config.js';

interface R {
  label: string;
  workflow: string;
  ok: boolean;
  seconds: number;
  peakVramGB: number;
  baseVramGB: number;
  values: Record<string, any>;
  at: string;
}
const rows = fs
  .readFileSync(path.join(ROOT, 'bench', 'results.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as R)
  .filter((r) => r.ok);

const size = (v: Record<string, any>) => (v.width ? `${v.width}×${v.height}` : '');
const clip = (v: Record<string, any>) => (v.frames && v.fps ? (v.frames - 1) / v.fps : v.frames ? (v.frames - 1) / (v.width ? 16 : 16) : null);

let md = `# Benchmarks

Measured on this machine: RTX 3090 24 GB, Threadripper 1950X, 64 GB RAM, ComfyUI 0.37.4 (Comfy Desktop), Windows 11.
Times are wall-clock from queueing to the last output, measured through the API by \`scripts/run-workflow.ts\`
(\`bench/results.jsonl\` has the raw data). "Peak VRAM" is whole-GPU usage sampled every 0.5 s (it includes Windows and other
apps, ~1.3 GB at idle). ComfyUI's dynamic VRAM keeps models resident while there is room, so peaks near 22-24 GB are normal
and not a sign of trouble.

"Cold" = first run after the models were unloaded (includes loading from disk); "warm" = models already in memory.

| Run | Workflow | Size | Clip | Time | Per second of video | Peak VRAM |
|---|---|---|---|---|---|---|
`;
for (const r of rows) {
  const c = r.workflow.includes('wan') || r.workflow.includes('ltx') ? clip({ ...r.values, fps: r.values.fps ?? (r.workflow.includes('ltx') ? 24 : 16) }) : null;
  md += `| ${r.label} | ${r.workflow} | ${size(r.values)} | ${c ? c.toFixed(1) + ' s' : ''} | ${r.seconds.toFixed(1)} s | ${c ? (r.seconds / c).toFixed(1) + ' s/s' : ''} | ${r.peakVramGB.toFixed(1)} GB |\n`;
}
md += fs.existsSync(path.join(ROOT, 'bench', 'notes.md')) ? '\n' + fs.readFileSync(path.join(ROOT, 'bench', 'notes.md'), 'utf8') : '';
fs.writeFileSync(path.join(ROOT, 'BENCHMARKS.md'), md);
console.log(`wrote BENCHMARKS.md with ${rows.length} rows`);
