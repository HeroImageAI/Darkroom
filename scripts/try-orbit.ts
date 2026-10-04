/**
 * A/B of the Qwen-Image 2.1 viewpoint-orbit LoRA (ML-Intern-lab) against plain Qwen-Image 2.1 on Darkroom's own
 * instruction-edit graph (no mask), on cut-outs from the Library. Same seed and settings both sides; the LoRA side
 * gets the `<orbit>` instruction its card asks for, the plain side the same words without the token.
 *   npx tsx scripts/try-orbit.ts <out dir> <steps> <item title>=<name> …
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { discoverComfy } from '../src/server/discovery.js';
import { ComfyClient, filesFromHistory, historyError } from '../src/shared/comfy.js';
import type { ApiPrompt } from '../src/shared/workflow.js';

type Node = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } };
const [outDir, stepsArg, ...pairs] = process.argv.slice(2);
const DR = process.env.DR_URL ?? 'http://127.0.0.1:5178';
const LORA = 'qwen-image-2.1-viewpoint-orbit-comfy.safetensors';
const SEED = 7;
const MOVES = [
  ['45 right', 'rotate the camera 45 degrees to the right, eye level'],
  ['90 left', 'rotate the camera 90 degrees to the left, eye level'],
  ['180', 'rotate the camera 180 degrees, eye level'],
  ['45 right high', 'rotate the camera 45 degrees to the right, elevated'],
] as const;
const ALPHA = 'The image has alpha channel and the background is transparent.';

const server = await discoverComfy(loadConfig());
if (!server) throw new Error('ComfyUI not found');
const comfy = new ComfyClient(server.url);
fs.mkdirSync(outDir, { recursive: true });

function graph(input: string, prompt: string, lora: boolean, prefix: string): Record<string, Node> {
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
  Object.assign(g[samp].inputs, { seed: SEED, steps: Number(stepsArg) || 25 });
  if (lora) {
    // LoRA between the model and its prefix cache, as Darkroom's injectLoras does
    const cache = by('Prefix cache');
    g['900'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: g[cache].inputs.model, lora_name: LORA, strength_model: 1 }, _meta: { title: 'Orbit LoRA' } };
    g[cache].inputs.model = ['900', 0];
  }
  g[out].inputs.filename_prefix = `darkroom/test/orbit_${prefix}`;
  return g;
}

const log: string[] = [];
for (const pair of pairs) {
  const [title, name] = pair.split('=');
  const items = (await (await fetch(`${DR}/api/items?q=${encodeURIComponent(title)}&limit=20`)).json()) as { items: { id: string; title: string }[] };
  const it = items.items.find((i) => i.title === title);
  if (!it) throw new Error(`no item "${title}"`);
  const inp = (await (await fetch(`${DR}/api/items/${it.id}/as-input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ which: 'main' }) })).json()) as { name: string };
  for (const [tag, move] of MOVES) {
    for (const lora of [false, true]) {
      const prompt = lora ? `<orbit> ${move}. ${ALPHA}` : `${move[0].toUpperCase()}${move.slice(1)} around the object. Keep the object identical. ${ALPHA}`;
      const file = `${name}_${tag.replace(/ /g, '-')}_${lora ? 'orbit' : 'plain'}`;
      if (fs.existsSync(path.join(outDir, file + '.png'))) continue;
      const g = graph(inp.name, prompt, lora, file);
      const t0 = Date.now();
      const id = await comfy.queuePrompt(g as unknown as ApiPrompt, 'dr-try-orbit');
      let h = null;
      while (!(h = await comfy.history(id))) await new Promise((r) => setTimeout(r, 1000));
      const err = historyError(h);
      if (err) throw new Error(`${file}: ${err}`);
      const outs = Object.keys(g).filter((k) => g[k]._meta?.title === 'DR_OUTPUT');
      for (const f of filesFromHistory(h, outs)) fs.writeFileSync(path.join(outDir, file + '.png'), await comfy.view(f));
      const line = `${file} ${Math.round((Date.now() - t0) / 1000)}s`;
      log.push(line);
      console.log(line);
    }
  }
}
fs.appendFileSync(path.join(outDir, 'runs.txt'), log.join('\n') + '\n');
