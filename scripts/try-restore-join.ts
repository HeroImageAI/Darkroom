/**
 * Try the Restore join graph (DECISIONS 100) on restored windows from the command line.
 *   npx tsx scripts/try-restore-join.ts <source.mp4> <total frames> <out dir> <part1.mp4> <part2.mp4> ...
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { discoverComfy } from '../src/server/discovery.js';
import { ComfyClient, filesFromHistory, historyError, inputName } from '../src/shared/comfy.js';
import { mp4Info } from '../src/server/mp4info.js';
import { restoreJoinPrompt, restoreWindows } from '../src/shared/restore.js';

const [source, total, outDir, ...parts] = process.argv.slice(2);
const cfg = loadConfig();
const server = await discoverComfy(cfg);
if (!server) throw new Error('ComfyUI not found');
const comfy = new ComfyClient(server.url);
const up = async (f: string) => inputName(await comfy.upload('image', new Blob([fs.readFileSync(f)]), path.basename(f), { subfolder: 'darkroom', overwrite: true }));
const windows = restoreWindows(Number(total)).slice(0, parts.length);
const g = restoreJoinPrompt({ source: await up(source), parts: await Promise.all(parts.map(up)), windows, sound: mp4Info(fs.readFileSync(source)).hasAudio });
const t0 = Date.now();
const id = await comfy.queuePrompt(g, 'dr-try-join');
let h = null;
while (!(h = await comfy.history(id))) await new Promise((r) => setTimeout(r, 1000));
const err = historyError(h);
fs.mkdirSync(outDir, { recursive: true });
if (!err) for (const f of filesFromHistory(h, Object.keys(g).filter((k) => g[k]._meta?.title === 'DR_OUTPUT'))) fs.writeFileSync(path.join(outDir, f.filename), await comfy.view(f));
console.log(JSON.stringify({ error: err, seconds: (Date.now() - t0) / 1000, windows }));
