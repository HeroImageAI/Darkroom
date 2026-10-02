/**
 * LTX 2.5 A/B (DECISIONS 96): Darkroom's single-stage graph against the official two-stage structure, on the same
 * start frames, prompts and seeds. Writes clips, a runs.json with time and peak memory, and per-case contact sheets
 * (start / middle / end frames and a 100 % crop of the middle frame) via scripts/ab-ltx-sheet.py.
 *   npx tsx scripts/ab-ltx.ts [variant-filter]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { composeMotionPrompt, type CameraPreset, type PromptTemplates } from '../src/shared/prompts.js';
import { ROOT } from '../src/server/config.js';

const OUT = path.join(ROOT, 'docs', 'qa', 'ltx');
const T = JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', 'prompts.json'), 'utf8')) as PromptTemplates;
const cams = JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', 'camera.json'), 'utf8')).camera as CameraPreset[];
const g = (id: string) => path.join('tests', 'golden', `${id}.png`);

interface Case { key: string; image: string; motion: string; camera: string[]; w: number; h: number }
const CASES: Case[] = [
  { key: 'portrait', image: g('01_portrait'), motion: 'She turns her head slightly toward the window and her smile widens; loose strands of silver hair lift in a soft breeze and the knitted scarf shifts with her breathing. Quiet room tone, a distant bird outside.', camera: ['push'], w: 704, h: 1280 },
  { key: 'harbour', image: g('08_lowres_src'), motion: 'The moored boats rock gently on small waves, ropes sway, an orange buoy bobs, and a seagull glides across the harbour. Water laps against the quay, gulls call in the distance.', camera: ['static'], w: 1280, h: 704 },
  { key: 'street', image: g('04_busy_street'), motion: 'Crowds of pedestrians walk along the pavements and cross the street, yellow taxis drive forward and stop at the light, awnings flutter. Busy city ambience with car horns.', camera: ['static'], w: 1280, h: 704 },
  { key: 'bakery', image: g('03_text_scene'), motion: 'A woman walks past the bakery window carrying a paper bag, warm light flickers inside, and steam drifts from the doorway. Footsteps on cobblestones, a shop bell rings.', camera: ['push'], w: 1280, h: 704 },
];
const VARIANTS = [
  { id: 'single', label: 'Darkroom today: single pass at full size', file: undefined as string | undefined },
  { id: 'two', label: 'Two-stage (half size, x2 latent upscale, 3-step refine)', file: 'experiments/ltx25_i2v.twostage.json' },
  { id: 'two07', label: 'Two-stage, start held at 0.7 in stage 1 (official)', file: 'experiments/ltx25_i2v.twostage07.json' },
];

const only = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const runsFile = path.join(OUT, 'runs.json');
const rows: any[] = fs.existsSync(runsFile) ? JSON.parse(fs.readFileSync(runsFile, 'utf8')) : [];
for (const v of VARIANTS) {
  if (only && !v.id.startsWith(only)) continue;
  let first = true;
  for (const c of CASES) {
    if (rows.some((r) => r.key === c.key && r.variant === v.id && r.ok)) continue;
    const prompt = composeMotionPrompt(T, cams, { model: 'ltx', motion: c.motion, camera: c.camera });
    const dir = path.join(OUT, `${c.key}-${v.id}`);
    fs.rmSync(dir, { recursive: true, force: true });
    const args = [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/run-workflow.ts', 'ltx25_i2v', '--out', dir, '--image', `start_image=${c.image}`, '--set', `motion_prompt=${prompt}`, '--set', 'seed=1234', '--set', 'frames=121', '--set', `width=${c.w}`, '--set', `height=${c.h}`];
    if (v.file) args.push('--file', v.file);
    if (first) args.push('--free');
    const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 30 * 60 * 1000 });
    let p: any = {};
    try {
      p = JSON.parse((r.stdout ?? '').slice((r.stdout ?? '').lastIndexOf('\n{')));
    } catch {
      /* failed */
    }
    const row = { key: c.key, variant: v.id, ok: r.status === 0, seconds: p.seconds, peak: p.peakVramGB, cold: first, files: p.files, error: r.status === 0 ? undefined : String(p.error ?? r.stderr ?? '').slice(-400) };
    first = false;
    const i = rows.findIndex((x) => x.key === c.key && x.variant === v.id);
    if (i >= 0) rows[i] = row;
    else rows.push(row);
    fs.writeFileSync(runsFile, JSON.stringify(rows, null, 2));
    console.log(row.ok ? 'ok  ' : 'FAIL', c.key, v.id, row.seconds ? `${row.seconds}s` : '', row.peak ? `${row.peak}GB` : '', row.error ?? '');
  }
}
fs.writeFileSync(path.join(OUT, 'variants.json'), JSON.stringify(VARIANTS.map(({ id, label }) => ({ id, label })), null, 2));
