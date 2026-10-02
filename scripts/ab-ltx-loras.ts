/** LTX LoRA tests (DECISIONS 98): Cinemagraph and Slow-Motion on Darkroom's distilled single-pass graph. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../src/server/config.js';

const OUT = path.join(ROOT, 'docs', 'qa', 'ltx-loras');
fs.mkdirSync(OUT, { recursive: true });
const g = (id: string) => path.join('tests', 'golden', `${id}.png`);
const CINE = 'CINEMAGRAPH_MOTION, tripod locked-off static camera, zero camera movement. Only the water in the harbour ripples gently and the orange buoy bobs; the boats, the houses, the hills and the sky stay completely frozen. Seamless natural loop.';
const CINE_PLAIN = 'Tripod locked-off static camera, zero camera movement. Only the water in the harbour ripples gently and the orange buoy bobs; the boats, the houses, the hills and the sky stay completely frozen. Seamless natural loop.';
const STREET = 'Crowds of pedestrians walk along the pavements and cross the street, yellow taxis drive forward, a cyclist rides past. The camera holds a locked-off static shot for the whole clip.';
const RUNS = [
  { key: 'cine-plain', image: g('08_lowres_src'), prompt: CINE_PLAIN },
  { key: 'cine-lora', image: g('08_lowres_src'), prompt: CINE, file: 'experiments/ltx25_i2v.lora_cinemagraph.json' },
  { key: 'street-base', image: g('04_busy_street'), prompt: STREET },
  { key: 'street-slow0.5', image: g('04_busy_street'), prompt: STREET, file: 'experiments/ltx25_i2v.slowmo_0.5.json' },
  { key: 'street-slow0.2', image: g('04_busy_street'), prompt: STREET, file: 'experiments/ltx25_i2v.slowmo_0.2.json' },
  { key: 'street-fps0.2-nolora', image: g('04_busy_street'), prompt: STREET, file: 'experiments/ltx25_i2v.motionfps_0.2.json' },
];
const rows: any[] = [];
for (const r of RUNS) {
  const dir = path.join(OUT, r.key);
  fs.rmSync(dir, { recursive: true, force: true });
  const args = [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/run-workflow.ts', 'ltx25_i2v', '--out', dir, '--image', `start_image=${r.image}`, '--set', `motion_prompt=${r.prompt}`, '--set', 'seed=77', '--set', 'frames=121', '--set', 'width=864', '--set', 'height=480'];
  if (r.file) args.push('--file', r.file);
  const p = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 20 * 60 * 1000 });
  let j: any = {};
  try {
    j = JSON.parse((p.stdout ?? '').slice((p.stdout ?? '').lastIndexOf('\n{')));
  } catch {
    /* failed */
  }
  rows.push({ key: r.key, ok: p.status === 0, seconds: j.seconds, peak: j.peakVramGB, files: j.files, error: p.status === 0 ? undefined : String(j.error ?? p.stderr).slice(-300) });
  fs.writeFileSync(path.join(OUT, 'runs.json'), JSON.stringify(rows, null, 2));
  console.log(p.status === 0 ? 'ok  ' : 'FAIL', r.key, j.seconds ? `${j.seconds}s` : '', j.peakVramGB ? `${j.peakVramGB}GB` : '', p.status === 0 ? '' : rows.at(-1).error);
}
