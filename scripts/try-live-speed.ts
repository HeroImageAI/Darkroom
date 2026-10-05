/**
 * Live painting (v3.30): how fast can Klein re-render a painted canvas on this GPU? Warm runs (the model loaded),
 * refine (img2img at a strength) at ~0.5–0.6 MP vs. Klein edit (instruction) on a 768 px picture.
 *   npx tsx scripts/try-live-speed.ts <sketch.png> <out dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/server/config.js';
import { discoverComfy } from '../src/server/discovery.js';
import { ComfyClient, filesFromHistory, historyError } from '../src/shared/comfy.js';
import { buildPrompt, findByTitle, type ApiPrompt } from '../src/shared/workflow.js';

const [sketch, outDir] = process.argv.slice(2);
const server = await discoverComfy(loadConfig());
if (!server) throw new Error('ComfyUI not found');
const comfy = new ComfyClient(server.url);
fs.mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync('workflows/manifest.json', 'utf8'));
const png = await sharp(sketch).resize(768, 768, { fit: 'inside' }).png().toBuffer();
const up = await comfy.upload('image', new Blob([new Uint8Array(png)]), 'live_speed.png', { subfolder: 'darkroom', overwrite: true });
const image = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
const run = async (wf: string, values: Record<string, string | number>, tag: string) => {
  const spec = manifest.workflows[wf];
  const g = buildPrompt(JSON.parse(fs.readFileSync(path.join('workflows', spec.file), 'utf8')) as ApiPrompt, spec, values);
  const t0 = Date.now();
  const id = await comfy.queuePrompt(g, 'dr-live-speed');
  let h = null;
  while (!(h = await comfy.history(id))) await new Promise((r) => setTimeout(r, 100));
  const err = historyError(h);
  if (err) throw new Error(err);
  const s = (Date.now() - t0) / 1000;
  fs.writeFileSync(path.join(outDir, `${tag}.png`), await comfy.view(filesFromHistory(h, findByTitle(g, spec.outputs.image ?? 'DR_OUTPUT'))[0]));
  return s;
};
const prompt = 'A photorealistic product photo of a colour-blocked running sneaker on a light grey studio background.';
const cases: [string, string, Record<string, string | number>][] = [
  ['refine_0.5mp_d50', 'klein_enhance', { prompt, image_1: image, denoise: 0.5, schedule_steps: 8, megapixels: 0.5 }],
  ['refine_0.6mp_d60', 'klein_enhance', { prompt, image_1: image, denoise: 0.6, schedule_steps: 7, megapixels: 0.6 }],
  ['edit_768', 'klein_edit', { prompt: 'Turn this drawing into ' + prompt, image_1: image }],
];
for (const [tag, wf, v] of cases) {
  const times: number[] = [];
  for (let i = 0; i < 5; i++) times.push(await run(wf, { ...v, seed: 5 + i }, `${tag}_${i}`));
  console.log(tag.padEnd(18), times.map((t) => t.toFixed(1)).join('  '), ' warm avg', (times.slice(1).reduce((a, b) => a + b, 0) / 4).toFixed(2), 's');
}
