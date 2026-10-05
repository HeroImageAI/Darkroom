/** Live painting (v3.30): which default strength turns a flat painted shape into a picture? Same seeds, 0.6–0.8. */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/server/config.js';
import { discoverComfy } from '../src/server/discovery.js';
import { ComfyClient, filesFromHistory, historyError } from '../src/shared/comfy.js';
import { buildPrompt, findByTitle, type ApiPrompt } from '../src/shared/workflow.js';
import { composeImagePrompt, type PromptTemplates } from '../src/shared/prompts.js';

const [outDir] = process.argv.slice(2);
const server = await discoverComfy(loadConfig());
const comfy = new ComfyClient(server!.url);
fs.mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync('workflows/manifest.json', 'utf8'));
const T = ((await (await fetch('http://127.0.0.1:5179/api/manifest')).json()) as { prompts: PromptTemplates }).prompts;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768"><rect width="768" height="768" fill="#fff"/><ellipse cx="384" cy="420" rx="170" ry="160" fill="#c8202a"/><ellipse cx="430" cy="245" rx="55" ry="22" fill="#3c8a2e" transform="rotate(-25 430 245)"/><rect x="378" y="230" width="10" height="45" fill="#5a3a1a"/><rect y="560" width="768" height="208" fill="#e9e4dc"/></svg>`;
const up = await comfy.upload('image', new Blob([new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer())]), 'live_paintover.png', { subfolder: 'darkroom', overwrite: true });
const image = `${up.subfolder}/${up.name}`;
const spec = manifest.workflows.klein_enhance;
const prompt = process.env.LIVE_PROMPT === 'generate' ? composeImagePrompt(T, { model: 'klein', mode: 'generate', text: 'A photograph of a ripe red apple on a white table, soft daylight.' }) : composeImagePrompt(T, { model: 'klein', mode: 'enhance', text: '', caption: 'a ripe red apple on a white table, soft daylight, photo', strength: 'subtle' });
console.log(prompt);
for (const d of [0.6, 0.7, 0.8])
  for (const seed of [11, 12, 13]) {
    const g = buildPrompt(JSON.parse(fs.readFileSync(path.join('workflows', spec.file), 'utf8')) as ApiPrompt, spec, { prompt, image_1: image, denoise: d, schedule_steps: Math.max(4, Math.round(4 / d)), megapixels: 0.5, seed });
    const id = await comfy.queuePrompt(g, 'dr-live-strength');
    let h = null;
    while (!(h = await comfy.history(id))) await new Promise((r) => setTimeout(r, 200));
    if (historyError(h)) throw new Error(historyError(h)!);
    fs.writeFileSync(path.join(outDir, `d${d}_s${seed}.png`), await comfy.view(filesFromHistory(h, findByTitle(g, 'DR_OUTPUT'))[0]));
  }
console.log('done');
