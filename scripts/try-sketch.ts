/**
 * Sketch to render A/B (Edit suite v3.29): what Klein 9B and Qwen-Image 2.1 already do with a drawing, before any
 * ControlNet. Per industry: Klein draws a clean ink sketch (a stand-in for a designer's drawing), then each variant
 * renders it. Straight to ComfyUI (not the Library). Writes <out>/<case>_<variant>.png and the sketch.
 *   npx tsx scripts/try-sketch.ts <out dir> [case …]
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { discoverComfy } from '../src/server/discovery.js';
import { ComfyClient, filesFromHistory, historyError } from '../src/shared/comfy.js';
import { buildPrompt, findByTitle, type ApiPrompt } from '../src/shared/workflow.js';
import { composeImagePrompt, type PromptTemplates } from '../src/shared/prompts.js';

const [outDir, ...only] = process.argv.slice(2);
const DR = process.env.DR_URL ?? 'http://127.0.0.1:5179';
const server = await discoverComfy(loadConfig());
if (!server) throw new Error('ComfyUI not found');
const comfy = new ComfyClient(server.url);
fs.mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync('workflows/manifest.json', 'utf8'));
const T = ((await (await fetch(`${DR}/api/manifest`)).json()) as { prompts: PromptTemplates }).prompts;

const CASES: { id: string; w: number; h: number; sketch: string; render: string }[] = [
  { id: 'footwear', w: 1024, h: 1024, sketch: 'Clean black ink line drawing of a running sneaker, side view, product design sketch on white paper, confident outlines and panel lines, no shading, no colour, no text.', render: 'a photorealistic product photo of this sneaker: white knit upper, grey suede overlays, a volt green sole, on a light grey studio background' },
  { id: 'apparel', w: 1024, h: 1024, sketch: 'Clean black ink technical flat sketch of a zip hoodie, front view, fashion design flat on white paper, seams and pockets drawn, no shading, no colour, no text.', render: 'a photorealistic product photo of this hoodie: heather grey cotton fleece, a black zip and drawstrings, flat lay on white' },
  { id: 'automotive', w: 1344, h: 768, sketch: 'Clean black ink line drawing of a sports car, three-quarter front view, car design sketch on white paper, panel lines and wheels drawn, no shading, no colour, no text.', render: 'a photorealistic studio photo of this sports car in metallic deep blue paint, on a dark grey studio floor' },
  { id: 'gaming', w: 1024, h: 1024, sketch: 'Clean black ink line drawing of a fantasy creature knight character, full body, standing, concept art sketch on white paper, armour plates drawn, no shading, no colour, no text.', render: 'finished game concept art of this creature knight: weathered dark steel armour, glowing amber eyes, dramatic rim light, painterly' },
  { id: 'film', w: 1344, h: 768, sketch: 'Clean black ink storyboard drawing of a rainy city street at night with a lone figure under a streetlight, wide shot, on white paper, no shading, no colour, no text.', render: 'a cinematic film still of this scene at night: wet asphalt reflecting neon signs, light rain, moody teal and orange light' },
];

const run = async (workflow: string, values: Record<string, string | number>, file: string) => {
  if (fs.existsSync(file)) return;
  const spec = manifest.workflows[workflow];
  const template = JSON.parse(fs.readFileSync(path.join('workflows', spec.file), 'utf8')) as ApiPrompt;
  const g = buildPrompt(template, spec, values);
  const t0 = Date.now();
  const id = await comfy.queuePrompt(g, 'dr-try-sketch');
  let h = null;
  while (!(h = await comfy.history(id))) await new Promise((r) => setTimeout(r, 700));
  const err = historyError(h);
  if (err) throw new Error(`${path.basename(file)}: ${err}`);
  const outs = findByTitle(g, spec.outputs.image ?? spec.outputs.images ?? 'DR_OUTPUT');
  const f = filesFromHistory(h, outs)[0];
  fs.writeFileSync(file, await comfy.view(f));
  const line = `${path.basename(file)} ${((Date.now() - t0) / 1000).toFixed(1)}s`;
  fs.appendFileSync(path.join(outDir, 'runs.txt'), line + '\n');
  console.log(line);
};

const SEED = 11;
// colour blocking: a sketch with rough colour painted on (scripts make colour_sketch.png); are the colours kept?
if (only.includes('colour')) {
  const f = path.join(outDir, 'colour_sketch.png');
  const up = await comfy.upload('image', new Blob([new Uint8Array(fs.readFileSync(f))]), 'sketch_colour.png', { subfolder: 'darkroom', overwrite: true });
  const sketch = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
  const say = 'Turn this coloured sketch into a photorealistic product photo of this sneaker on a light grey studio background. Keep the colours as they are painted on the drawing.';
  for (const [tag, wf, m] of [['klein', 'klein_edit', 'klein'], ['qwen', 'qwen_edit', 'qwen']] as const)
    await run(wf, { seed: SEED, image_1: sketch, prompt: composeImagePrompt(T, { model: m, mode: 'instruct', text: say }) }, path.join(outDir, `colour_${tag}.png`));
}
for (const c of CASES.filter((x) => !only.length || only.includes(x.id))) {
  const sketchFile = path.join(outDir, `${c.id}_sketch.png`);
  await run('klein_t2i', { prompt: composeImagePrompt(T, { model: 'klein', mode: 'generate', text: c.sketch }), seed: SEED, width: c.w, height: c.h }, sketchFile);
  const up = await comfy.upload('image', new Blob([new Uint8Array(fs.readFileSync(sketchFile))]), `sketch_${c.id}.png`, { subfolder: 'darkroom', overwrite: true });
  const sketch = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
  const say = `Turn this line drawing into ${c.render}. Follow the drawing exactly: the same outline, proportions, details and composition.`;
  const plain = `Turn this line drawing into ${c.render}.`;
  const variants: [string, string, Record<string, string | number>][] = [
    ['klein', 'klein_edit', { image_1: sketch, prompt: composeImagePrompt(T, { model: 'klein', mode: 'instruct', text: say }) }],
    ['qwen', 'qwen_edit', { image_1: sketch, prompt: composeImagePrompt(T, { model: 'qwen', mode: 'instruct', text: say }) }],
    ['klein-plain', 'klein_edit', { image_1: sketch, prompt: composeImagePrompt(T, { model: 'klein', mode: 'instruct', text: plain }) }],
    ['qwen-plain', 'qwen_edit', { image_1: sketch, prompt: composeImagePrompt(T, { model: 'qwen', mode: 'instruct', text: plain }) }],
  ];
  for (const [tag, wf, v] of variants) await run(wf, { seed: SEED, ...v }, path.join(outDir, `${c.id}_${tag}.png`));
}
