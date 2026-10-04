/**
 * A/B for Qwen-Image 2.1 LoRAs on Darkroom's own Instruct graph (no mask): plain vs the Consistency LoRA vs Turbo8
 * (8 steps), same seed. Times each run. Pictures come from the Library by title.
 *   npx tsx scripts/try-qwen-loras.ts <out dir> "<title>=<name>=<instruction>" …
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { discoverComfy } from '../src/server/discovery.js';
import { ComfyClient, filesFromHistory, historyError } from '../src/shared/comfy.js';
import type { ApiPrompt } from '../src/shared/workflow.js';

type Node = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } };
const [outDir, ...cases] = process.argv.slice(2);
const DR = process.env.DR_URL ?? 'http://127.0.0.1:5178';
const SEED = 7;
const VARIANTS: { tag: string; lora?: string; strength?: number; steps: number }[] = [
  { tag: 'plain', steps: 25 },
  { tag: 'consistency', lora: 'qwen-image-2.1-consistency.safetensors', strength: 1, steps: 25 },
  { tag: 'turbo8', lora: 'turbo8_lora_step2500.safetensors', strength: 1, steps: 8 },
  { tag: 'turbo8-0.65-16', lora: 'turbo8_lora_step2500.safetensors', strength: 0.65, steps: 16 },
];
const server = await discoverComfy(loadConfig());
if (!server) throw new Error('ComfyUI not found');
const comfy = new ComfyClient(server.url);
fs.mkdirSync(outDir, { recursive: true });

function graph(input: string, prompt: string, v: (typeof VARIANTS)[number], prefix: string): Record<string, Node> {
  const g = JSON.parse(fs.readFileSync('workflows/qwen_edit.json', 'utf8')) as Record<string, Node>;
  const by = (t: string) => Object.keys(g).find((k) => g[k]._meta?.title === t)!;
  const samp = by('DR_SAMPLER'), lat = by('DR_MASK_LATENT'), comp = by('DR_MASK_COMPOSITE'), out = by('DR_OUTPUT'), enc = by('DR_PROMPT');
  g[samp].inputs.latent_image = g[lat].inputs.samples;
  g[out].inputs.images = g[comp].inputs.source;
  for (const t of ['DR_MASK', 'DR_MASK_GROW', 'DR_MASK_LATENT', 'DR_MASK_COMPOSITE', 'DR_IMAGE_2', 'Mask to image (feather)', 'DR_FEATHER', 'Feathered mask']) {
    const k = by(t);
    if (k) delete g[k];
  }
  delete g[enc].inputs['images.image_2'];
  g[by('DR_IMAGE_1')].inputs.image = input;
  g[enc].inputs.prompt = prompt;
  Object.assign(g[samp].inputs, { seed: SEED, steps: v.steps });
  if (v.lora) {
    const cache = by('Prefix cache');
    g['900'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: g[cache].inputs.model, lora_name: v.lora, strength_model: v.strength ?? 1 }, _meta: { title: 'LoRA' } };
    g[cache].inputs.model = ['900', 0];
  }
  g[out].inputs.filename_prefix = `darkroom/test/qlora_${prefix}`;
  return g;
}

for (const c of cases) {
  const [title, name, instruction] = c.split('=');
  const items = (await (await fetch(`${DR}/api/items?q=${encodeURIComponent(title)}&limit=20`)).json()) as { items: { id: string; title: string }[] };
  const it = items.items.find((i) => i.title === title);
  if (!it) throw new Error(`no item "${title}"`);
  const inp = (await (await fetch(`${DR}/api/items/${it.id}/as-input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ which: 'main' }) })).json()) as { name: string };
  fs.copyFileSync(path.join('E:/Comfy-Desktop/ComfyUI-Shared/input', inp.name), path.join(outDir, `${name}_input.png`));
  for (const v of VARIANTS) {
    const file = `${name}_${v.tag}`;
    if (fs.existsSync(path.join(outDir, file + '.png'))) continue;
    const g = graph(inp.name, instruction, v, file);
    const t0 = Date.now();
    const id = await comfy.queuePrompt(g as unknown as ApiPrompt, 'dr-try-qwen-loras');
    let h = null;
    while (!(h = await comfy.history(id))) await new Promise((r) => setTimeout(r, 500));
    const err = historyError(h);
    if (err) throw new Error(`${file}: ${err}`);
    const outs = Object.keys(g).filter((k) => g[k]._meta?.title === 'DR_OUTPUT');
    for (const f of filesFromHistory(h, outs)) fs.writeFileSync(path.join(outDir, file + '.png'), await comfy.view(f));
    const line = `${file} ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    fs.appendFileSync(path.join(outDir, 'runs.txt'), line + '\n');
    console.log(line);
  }
}
