/**
 * Try the Timeline AI graph changes (DECISIONS 104) on the LTX image-to-video graph.
 *   npx tsx scripts/try-ltx-tools.ts <out dir> <json of { params, uploads: {name: file}, keys?: [{file, frame, strength}], sound?: {file, start, seconds} }>
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { discoverComfy } from '../src/server/discovery.js';
import { ComfyClient, filesFromHistory, historyError, inputName } from '../src/shared/comfy.js';
import { addKeyMoments, addSoundToPicture } from '../src/shared/ltxguides.js';
import { buildPrompt, type ApiPrompt } from '../src/shared/workflow.js';

const [outDir, specArg] = process.argv.slice(2);
const spec = JSON.parse(fs.existsSync(specArg) ? fs.readFileSync(specArg, 'utf8') : specArg);
const cfg = loadConfig();
const server = await discoverComfy(cfg);
if (!server) throw new Error('ComfyUI not found');
const comfy = new ComfyClient(server.url);
const up = async (f: string) => inputName(await comfy.upload('image', new Blob([fs.readFileSync(f)]), path.basename(f), { subfolder: 'darkroom', overwrite: true }));
const manifest = JSON.parse(fs.readFileSync('workflows/manifest.json', 'utf8'));
const wf = spec.workflow ?? 'ltx25_i2v';
const params = { ...spec.params };
for (const [k, f] of Object.entries(spec.uploads ?? {})) params[k] = await up(f as string);
let g = buildPrompt(JSON.parse(fs.readFileSync(`workflows/${manifest.workflows[wf].file}`, 'utf8')) as ApiPrompt, manifest.workflows[wf], params);
if (spec.keys) g = addKeyMoments(g, await Promise.all(spec.keys.map(async (k: { file: string; frame: number; strength: number }) => ({ image: await up(k.file), frame: k.frame, strength: k.strength }))));
if (spec.sound) g = addSoundToPicture(g, { file: await up(spec.sound.file), start: spec.sound.start, seconds: spec.sound.seconds });
if (spec.modality) for (const n of Object.values(g)) if (n.class_type === 'LTXVDualCFGGuider') {
  g.modality = { class_type: 'LTXVModalityGuidance', inputs: { model: n.inputs.model, modality_scale: spec.modality, start_percent: 0, end_percent: 1 }, _meta: { title: 'Lip-sync guidance' } };
  n.inputs.model = ['modality', 0];
}
for (const n of Object.values(g)) if (n.class_type === 'SaveVideo') Object.assign(n.inputs, { 'format.codec.encoding': 're-encode', 'format.codec.encoding.crf': 18 });
await comfy.free(true, true);
const t0 = Date.now();
const id = await comfy.queuePrompt(g, 'dr-try-tools');
let h = null;
while (!(h = await comfy.history(id))) await new Promise((r) => setTimeout(r, 2000));
const err = historyError(h);
fs.mkdirSync(outDir, { recursive: true });
if (!err) for (const f of filesFromHistory(h, Object.keys(g).filter((k) => g[k]._meta?.title === 'DR_OUTPUT'))) fs.writeFileSync(path.join(outDir, 'out.mp4'), await comfy.view(f));
console.log(JSON.stringify({ error: err, seconds: (Date.now() - t0) / 1000 }));
