/**
 * Camera wording A/B for LTX 2.5 (audit #8: "Static" still pushed in, "Orbit" gave a pull-back). The same picture, the
 * same motion and seed, with each camera sentence; Draft quality to keep it quick. Straight to ComfyUI (not the Library).
 *   npx tsx scripts/try-camera.ts <out dir> "<item title>" "<motion>" "<tag>=<camera sentence>" …
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { discoverComfy } from '../src/server/discovery.js';
import { ComfyClient, filesFromHistory, historyError } from '../src/shared/comfy.js';
import { buildPrompt, findByTitle, type ApiPrompt } from '../src/shared/workflow.js';
import { planVideo } from '../src/shared/manifest.js';

const [outDir, title, motion, ...variants] = process.argv.slice(2);
const DR = process.env.DR_URL ?? 'http://127.0.0.1:5178';
const server = await discoverComfy(loadConfig());
if (!server) throw new Error('ComfyUI not found');
const comfy = new ComfyClient(server.url);
fs.mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync('workflows/manifest.json', 'utf8'));
const items = (await (await fetch(`${DR}/api/items?q=${encodeURIComponent(title)}&limit=20`)).json()) as { items: { id: string; title: string; width: number; height: number }[] };
const it = items.items.find((i) => i.title === title);
if (!it) throw new Error(`no item "${title}"`);
const inp = (await (await fetch(`${DR}/api/items/${it.id}/as-input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ which: 'main' }) })).json()) as { name: string };
const vp = planVideo(manifest.video.ltx, 'draft', 5, it.width, it.height);
const spec = manifest.workflows[vp.workflow];
const template = JSON.parse(fs.readFileSync(path.join('workflows', spec.file), 'utf8')) as ApiPrompt;
for (const v of variants) {
  const [tag, camera] = v.split('=');
  const file = path.join(outDir, `${tag}.mp4`);
  if (fs.existsSync(file)) continue;
  const g = buildPrompt(template, spec, { start_image: inp.name, motion_prompt: `${motion} ${camera}`, seed: 11, frames: vp.frames, fps: vp.fps, width: vp.width, height: vp.height });
  const t0 = Date.now();
  const id = await comfy.queuePrompt(g, 'dr-try-camera');
  let h = null;
  while (!(h = await comfy.history(id))) await new Promise((r) => setTimeout(r, 1000));
  const err = historyError(h);
  if (err) throw new Error(`${tag}: ${err}`);
  for (const f of filesFromHistory(h, findByTitle(g, spec.outputs.video))) fs.writeFileSync(file, await comfy.view(f));
  console.log(tag, Math.round((Date.now() - t0) / 1000) + 's');
}
