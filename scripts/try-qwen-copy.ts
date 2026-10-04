/**
 * Why does Qwen-Image 2.1 Instruct sometimes return the input unchanged? Runs Darkroom's qwen_edit graph (no mask,
 * no reference) on a picture already in ComfyUI's input folder, with one change per variant, and saves each result.
 *   npx tsx scripts/try-qwen-copy.ts <out dir> <input name> "<prompt>" [variant …]
 * variants (combinable, e.g. cfg2.5seed7): base · seedN · empty (the encoder's own empty latent, as in the official template) · steps50 ·
 *           cfgX (cfg X + a negative prompt) · tag ("<image1>" in the prompt)
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { discoverComfy } from '../src/server/discovery.js';
import { ComfyClient, filesFromHistory, historyError } from '../src/shared/comfy.js';
import type { ApiPrompt } from '../src/shared/workflow.js';

type Node = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } };
const [outDir, input, prompt, ...variants] = process.argv.slice(2);
const server = await discoverComfy(loadConfig());
if (!server) throw new Error('ComfyUI not found');
const comfy = new ComfyClient(server.url);
fs.mkdirSync(outDir, { recursive: true });

function graph(v: string): Record<string, Node> {
  const g = JSON.parse(fs.readFileSync('workflows/qwen_edit.json', 'utf8')) as Record<string, Node>;
  const by = (t: string) => Object.keys(g).find((k) => g[k]._meta?.title === t)!;
  // what Darkroom does when there is no mask and no reference (manifest whenMissing)
  const lat = by('DR_MASK_LATENT'), comp = by('DR_MASK_COMPOSITE'), out = by('DR_OUTPUT');
  const samp = by('DR_SAMPLER');
  g[samp].inputs.latent_image = g[lat].inputs.samples;
  g[out].inputs.images = g[comp].inputs.source;
  for (const t of ['DR_MASK', 'DR_MASK_GROW', 'DR_MASK_LATENT', 'DR_MASK_COMPOSITE', 'DR_IMAGE_2', 'Mask to image (feather)', 'DR_FEATHER', 'Feathered mask']) {
    const k = by(t);
    if (k) delete g[k];
  }
  const enc = by('DR_PROMPT');
  delete g[enc].inputs['images.image_2'];
  g[by('DR_IMAGE_1')].inputs.image = input;
  g[enc].inputs.prompt = v === 'tag' ? `In <image1>: ${prompt}` : prompt;
  const seed = /seed(\d+)/.exec(v), cfg = /cfg([\d.]+)/.exec(v);
  Object.assign(g[samp].inputs, { seed: seed ? Number(seed[1]) : 42 });
  if (v === 'empty') g[samp].inputs.latent_image = [enc, 2];
  if (v === 'steps50') g[samp].inputs.steps = 50;
  if (cfg) {
    g[samp].inputs.cfg = Number(cfg[1]);
    g[enc].inputs.negative_prompt = 'an unchanged copy of the input picture';
  }
  g[out].inputs.filename_prefix = `darkroom/test/qwencopy_${v}`;
  return g;
}

for (const v of variants.length ? variants : ['base']) {
  const g = graph(v);
  const t0 = Date.now();
  const id = await comfy.queuePrompt(g as unknown as ApiPrompt, 'dr-try-qwen-copy');
  let h = null;
  while (!(h = await comfy.history(id))) await new Promise((r) => setTimeout(r, 1000));
  const err = historyError(h);
  if (err) throw new Error(v + ': ' + err);
  const out = Object.keys(g).filter((k) => g[k]._meta?.title === 'DR_OUTPUT');
  for (const f of filesFromHistory(h, out)) fs.writeFileSync(path.join(outDir, `${v}.png`), await comfy.view(f));
  console.log(v, Math.round((Date.now() - t0) / 1000) + 's');
}
