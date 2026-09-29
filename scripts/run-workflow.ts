/**
 * Run one Darkroom workflow against the live ComfyUI, measure it, save outputs.
 *
 *   npx tsx scripts/run-workflow.ts klein_t2i --set prompt="a red fox" --set seed=1 --out bench/klein
 *   npx tsx scripts/run-workflow.ts qwen_edit --image image_1=path.png --set prompt="make it night"
 *   flags: --free (POST /free first)  --label name (benchmark label)
 */
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { loadConfig, ROOT } from '../src/server/config.js';
import { discoverComfy } from '../src/server/discovery.js';
import { ComfyClient, filesFromHistory, historyError, inputName, parseWsMessage } from '../src/shared/comfy.js';
import { buildPrompt, outputNodeIds, type ApiPrompt, type ParamValues } from '../src/shared/workflow.js';
import type { Manifest } from '../src/shared/manifest.js';

const args = process.argv.slice(2);
const wfName = args[0];
const values: ParamValues = {};
const uploads: Record<string, string> = {};
let outDir = path.join(ROOT, 'bench', wfName ?? 'x');
let label = wfName;
let doFree = false;
let fileOverride: string | null = null;
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--set' || a === '--image' || a === '--video') {
    const [k, ...rest] = args[++i].split('=');
    const v = rest.join('=');
    if (a === '--set') values[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    else uploads[k] = v;
  } else if (a === '--out') outDir = path.resolve(args[++i]);
  else if (a === '--label') label = args[++i];
  else if (a === '--free') doFree = true;
  else if (a === '--file') fileOverride = args[++i];
}

const cfg = loadConfig();
const manifest = JSON.parse(fs.readFileSync(path.join(cfg.paths.workflows, 'manifest.json'), 'utf8')) as Manifest;
const spec = manifest.workflows[wfName];
if (!spec) throw new Error(`Unknown workflow ${wfName}`);
const template = JSON.parse(fs.readFileSync(path.join(cfg.paths.workflows, fileOverride ?? spec.file), 'utf8')) as ApiPrompt;

const server = await discoverComfy(cfg);
if (!server) throw new Error('ComfyUI Desktop server not found');
const comfy = new ComfyClient(server.url);

if (doFree) {
  await comfy.free(true, true);
  await new Promise((r) => setTimeout(r, 1500));
}

for (const [k, file] of Object.entries(uploads)) {
  const up = await comfy.upload('image', new Blob([fs.readFileSync(file)]), path.basename(file), { subfolder: 'darkroom', overwrite: true });
  values[k] = inputName(up);
}

const prompt = buildPrompt(template, spec, values);
const outIds = outputNodeIds(prompt, spec);
const clientId = 'dr-cli-' + Math.random().toString(36).slice(2);
const ws = new WebSocket(server.url.replace(/^http/, 'ws') + '/ws?clientId=' + clientId);
await new Promise((r, j) => {
  ws.once('open', r);
  ws.once('error', j);
});

let peak = 0;
const baseStats = await comfy.systemStats();
const baseUsed = baseStats.devices[0].vram_total - baseStats.devices[0].vram_free;
const sampler = setInterval(async () => {
  try {
    const s = await comfy.systemStats();
    peak = Math.max(peak, s.devices[0].vram_total - s.devices[0].vram_free);
  } catch {
    /* busy */
  }
}, 500);

const t0 = Date.now();
let lastLine = '';
const promptId = await comfy.queuePrompt(prompt, clientId, { darkroom: { workflow: wfName, params: values } });
const done = new Promise<string | null>((resolve) => {
  ws.on('message', (data, isBinary) => {
    const ev = parseWsMessage(isBinary ? new Uint8Array(data as Buffer) : data.toString());
    if ('promptId' in ev && ev.promptId !== promptId) return;
    if (ev.type === 'progress') {
      const line = `  ${prompt[ev.node]?._meta?.title ?? ev.node}: ${ev.value}/${ev.max}`;
      if (line !== lastLine) process.stdout.write(line + '\r');
      lastLine = line;
    }
    if (ev.type === 'execution_success') resolve(null);
    if (ev.type === 'execution_error') resolve(`${ev.nodeType}: ${ev.message}`);
    if (ev.type === 'execution_interrupted') resolve('interrupted');
  });
});
const err = await done;
const secs = (Date.now() - t0) / 1000;
clearInterval(sampler);
ws.close();

const hist = await comfy.history(promptId);
const herr = hist ? historyError(hist) : null;
fs.mkdirSync(outDir, { recursive: true });
const saved: string[] = [];
if (hist && !err && !herr) {
  const wanted = Object.values(outIds).flat();
  for (const f of filesFromHistory(hist, wanted)) {
    const dest = path.join(outDir, f.filename);
    fs.writeFileSync(dest, await comfy.view(f));
    saved.push(dest);
  }
}
const result = {
  label,
  workflow: wfName,
  ok: !err && !herr,
  error: err ?? herr,
  seconds: Math.round(secs * 10) / 10,
  peakVramGB: Math.round((peak / 1e9) * 10) / 10,
  baseVramGB: Math.round((baseUsed / 1e9) * 10) / 10,
  values,
  files: saved,
  at: new Date().toISOString(),
};
fs.appendFileSync(path.join(ROOT, 'bench', 'results.jsonl'), JSON.stringify(result) + '\n');
console.log('\n' + JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
