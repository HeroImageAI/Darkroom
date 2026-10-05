/** Live painting (v3.30): Klein edit ("Turn this drawing into …") at smaller sizes — speed and look. */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/server/config.js';
import { discoverComfy } from '../src/server/discovery.js';
import { ComfyClient, filesFromHistory, historyError } from '../src/shared/comfy.js';
import { buildPrompt, findByTitle, type ApiPrompt } from '../src/shared/workflow.js';
import { composeImagePrompt, type PromptTemplates } from '../src/shared/prompts.js';

const [outDir] = process.argv.slice(2);
const comfy = new ComfyClient((await discoverComfy(loadConfig()))!.url);
fs.mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync('workflows/manifest.json', 'utf8'));
const T = ((await (await fetch('http://127.0.0.1:5179/api/manifest')).json()) as { prompts: PromptTemplates }).prompts;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768"><rect width="768" height="768" fill="#fff"/><rect y="560" width="768" height="208" fill="#e9e4dc"/><ellipse cx="384" cy="420" rx="170" ry="160" fill="#c8202a"/><ellipse cx="430" cy="245" rx="55" ry="22" fill="#3c8a2e" transform="rotate(-25 430 245)"/><rect x="378" y="230" width="10" height="45" fill="#5a3a1a"/></svg>`;
const spec = manifest.workflows.klein_edit;
const prompt = composeImagePrompt(T, { model: 'klein', mode: 'instruct', text: 'Turn this drawing into a photograph of a ripe red apple on a white table, soft daylight. Follow the drawing: the same outline, proportions, details and composition. Keep the colours as they are painted on the drawing.' });
for (const mp of [0.25, 0.4]) {
  const side = 768;
  const up = await comfy.upload('image', new Blob([new Uint8Array(await sharp(Buffer.from(svg)).resize(side, side).png().toBuffer())]), `live_edit_${side}.png`, { subfolder: 'darkroom', overwrite: true });
  const times: number[] = [];
  for (const seed of [11, 12, 13, 14]) {
    const g = buildPrompt(JSON.parse(fs.readFileSync(path.join('workflows', spec.file), 'utf8')) as ApiPrompt, spec, { prompt, image_1: `${up.subfolder}/${up.name}`, seed });
    for (const id of ['9', '14']) (g[id].inputs as Record<string, unknown>).megapixels = mp;
    const t0 = Date.now();
    const id = await comfy.queuePrompt(g, 'dr-live-edit');
    let h = null;
    while (!(h = await comfy.history(id))) await new Promise((r) => setTimeout(r, 100));
    if (historyError(h)) throw new Error(historyError(h)!);
    times.push((Date.now() - t0) / 1000);
    fs.writeFileSync(path.join(outDir, `mp${mp}_s${seed}.png`), await comfy.view(filesFromHistory(h, findByTitle(g, 'DR_OUTPUT'))[0]));
  }
  console.log(mp, 'MP', times.map((t) => t.toFixed(1)).join(' '));
}
