/**
 * Save Video quality (DECISIONS 102): the same restore join saved with ComfyUI's default H.264 encoding and with a
 * given CRF, to compare quality and size. npx tsx scripts/try-video-crf.ts <out dir> <crf> <part1.mp4> <part2.mp4>
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { discoverComfy } from '../src/server/discovery.js';
import { ComfyClient, filesFromHistory, historyError, inputName } from '../src/shared/comfy.js';
import { restoreJoinPrompt, restoreWindows } from '../src/shared/restore.js';

const [outDir, crf, ...parts] = process.argv.slice(2);
const server = await discoverComfy(loadConfig());
if (!server) throw new Error('ComfyUI not found');
const comfy = new ComfyClient(server.url);
const up = async (f: string) => inputName(await comfy.upload('image', new Blob([fs.readFileSync(f)]), path.basename(f), { subfolder: 'darkroom', overwrite: true }));
const files = await Promise.all(parts.map(up));
fs.mkdirSync(outDir, { recursive: true });
for (const mode of ['default', `crf${crf}`]) {
  const g = restoreJoinPrompt({ source: files[0], parts: files, windows: restoreWindows(177).slice(0, parts.length), sound: false, output: `darkroom/test/crf_${mode}` });
  if (mode !== 'default') for (const n of Object.values(g)) if (n.class_type === 'SaveVideo') Object.assign(n.inputs, { 'format.codec.encoding': 're-encode', 'format.codec.encoding.crf': Number(crf) });
  const id = await comfy.queuePrompt(g, 'dr-try-crf');
  let h = null;
  while (!(h = await comfy.history(id))) await new Promise((r) => setTimeout(r, 1000));
  const err = historyError(h);
  if (err) throw new Error(mode + ': ' + err);
  for (const f of filesFromHistory(h, Object.keys(g).filter((k) => g[k]._meta?.title === 'DR_OUTPUT'))) fs.writeFileSync(path.join(outDir, `${mode}.mp4`), await comfy.view(f));
  console.log(mode, fs.statSync(path.join(outDir, `${mode}.mp4`)).size);
}
