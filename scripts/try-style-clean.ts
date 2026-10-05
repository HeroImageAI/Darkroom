/**
 * Style A/B (polish round 2): does "a clean, unbranded single illustration" stop Klein painting fake studio logos and
 * watermarks on Game concept / Concept art pictures? Same prompt and seeds, current vs. clean wording.
 *   npx tsx scripts/try-style-clean.ts <out dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { discoverComfy } from '../src/server/discovery.js';
import { ComfyClient, filesFromHistory, historyError } from '../src/shared/comfy.js';
import { buildPrompt, findByTitle, type ApiPrompt } from '../src/shared/workflow.js';
import { composeImagePrompt, type PromptTemplates } from '../src/shared/prompts.js';

const [outDir] = process.argv.slice(2);
const DR = process.env.DR_URL ?? 'http://127.0.0.1:5179';
const server = await discoverComfy(loadConfig());
if (!server) throw new Error('ComfyUI not found');
const comfy = new ComfyClient(server.url);
fs.mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync('workflows/manifest.json', 'utf8'));
const T = ((await (await fetch(`${DR}/api/manifest`)).json()) as { prompts: PromptTemplates }).prompts;
const styles = JSON.parse(fs.readFileSync('presets/styles.json', 'utf8')).styles as Record<string, string>[];
const game = styles.find((s) => s.id === 'game')!;
const CLEAN = ' A clean, unbranded single illustration on a plain background.';
const variants = { now: game.klein, clean: game.klein + CLEAN, clean2: game.klein + ' A clean, unbranded single illustration.' };
const prompts = ['A desert scavenger character, full body, patched cloth wraps, brass goggles, long rifle, plain grey background', 'A heavy mech walker with moss on its armour plates, three-quarter view', 'A forest witch character with a lantern staff, full body'];

const run = async (values: Record<string, string | number>, file: string) => {
  if (fs.existsSync(file)) return;
  const spec = manifest.workflows.klein_t2i;
  const g = buildPrompt(JSON.parse(fs.readFileSync(path.join('workflows', spec.file), 'utf8')) as ApiPrompt, spec, values);
  const id = await comfy.queuePrompt(g, 'dr-try-style');
  let h = null;
  while (!(h = await comfy.history(id))) await new Promise((r) => setTimeout(r, 700));
  const err = historyError(h);
  if (err) throw new Error(err);
  fs.writeFileSync(file, await comfy.view(filesFromHistory(h, findByTitle(g, spec.outputs.image ?? 'DR_OUTPUT'))[0]));
  console.log(path.basename(file));
};
for (const [i, p] of prompts.entries())
  for (const seed of [7, 21])
    for (const [tag, style] of Object.entries(variants))
      await run({ prompt: composeImagePrompt(T, { model: 'klein', mode: 'generate', text: p, style: { klein: style, qwen: '' } as never }), seed, width: 896, height: 1120 }, path.join(outDir, `p${i}_s${seed}_${tag}.png`));
