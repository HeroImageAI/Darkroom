import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import sharp from 'sharp';
import { zipSync } from 'fflate';
import type { WebSocket } from 'ws';
import { inputName, type SystemStats } from '../shared/comfy.js';
import type { Manifest } from '../shared/manifest.js';
import { loadConfig, ROOT } from './config.js';
import { Store, type FileRef, type LibraryQuery } from './db.js';
import { desktopRunning, launchDesktop, tailDesktopLog } from './desktop.js';
import { discoverComfy } from './discovery.js';
import { JobManager, publicJob, VramWarning, type SubmitRequest } from './jobs.js';
import { buildVlm2Request, nearestAspect, parsePeJson, dropCameraSentences, dropCopiedSound, withCameraMoves, withSound, type SoundMode, withEnhanceStyle, type Vlm2Entry, type Vlm2Prompts, type Vlm2Task } from '../shared/vlm.js';
import { validateTemplates } from '../shared/prompts.js';
import { samPointsJson } from '../shared/workflow.js';
import { layersToPsd, layersToZip, type LayerInput } from './layers.js';
import { buildOutpaintCanvas } from './outpaint.js';
import { maskBBox } from '../shared/cropstitch.js';
import type { Pad } from '../shared/outpaint.js';
import { mergePresets, upsertUserPreset, type EditPreset, type UserPreset } from '../shared/presets.js';
import { readDarkroomMeta } from '../shared/pngmeta.js';
import { outputDirFromArgv, outputPath, recycle } from './trash.js';
import { labelledSheet } from './framepair.js';
import { sanitiseDoc } from '../shared/compose.js';
import { duration as timelineDuration, endOf, exactFrames, exportSize, ordered, planGeneration, sanitiseTimeline, type GenerateRequest } from '../shared/timeline.js';
import { planVideo } from '../shared/manifest.js';
import { desktopPython, grabFrame, inputDirFromArgv, inside, runExport } from './timeline.js';

const cfg = loadConfig();
const store = new Store(cfg.paths.data);
const sockets = new Set<WebSocket>();
const broadcast = (msg: unknown) => {
  const text = JSON.stringify(msg);
  for (const s of sockets) if (s.readyState === 1) s.send(text);
};

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}
const manifest = (): Manifest => readJson<Manifest>(path.join(cfg.paths.workflows, 'manifest.json'));
const jobs = new JobManager(store, manifest, cfg.paths.workflows, path.join(cfg.paths.data, 'thumbs'), broadcast);

// ---------------------------------------------------------------- status --
type ComfyState = 'online' | 'offline' | 'starting' | 'desktop-open';
const status = {
  comfy: 'offline' as ComfyState,
  url: null as string | null,
  version: null as string | null,
  vram: null as { total: number; free: number } | null,
  queue: 0,
  desktopRunning: false,
  startRequestedAt: 0,
  message: '',
  /** consecutive failed polls while we believed ComfyUI was online */
  misses: 0,
  unresponsiveSince: 0,
};
const GRACE_POLLS = 4; // ~12-16 s: heavy VAE/model-load steps can pause ComfyUI's HTTP for a few seconds
const STALL_SEC = 180;

function applyStats(stats: SystemStats | null): void {
  if (!stats) return;
  status.version = stats.system.comfyui_version;
  const d = stats.devices[0];
  status.vram = d ? { total: d.vram_total, free: d.vram_free } : null;
}

async function poll(): Promise<void> {
  const found = await discoverComfy(cfg).catch(() => null);
  const before = JSON.stringify([status.comfy, status.url]);
  if (!found && status.comfy === 'online' && status.url) {
    // Don't declare ComfyUI offline on a short hiccup; keep the WebSocket and the job state.
    status.misses++;
    if (!status.unresponsiveSince) status.unresponsiveSince = Date.now();
    const busy = store.activeJobs().some((j) => j.status === 'running');
    const secs = (Date.now() - status.unresponsiveSince) / 1000;
    if (busy && secs > STALL_SEC) {
      status.message = `ComfyUI has not responded for ${Math.round(secs / 60)} min while rendering. It may be stuck (often when graphics memory is completely full). Open the Comfy Desktop window; if it doesn't recover, use Restart there - Darkroom reconnects on its own and keeps your library.`;
      broadcast({ type: 'status', status: publicStatus() });
      return;
    }
    if (status.misses < GRACE_POLLS || busy) return;
  }
  if (found) {
    status.misses = 0;
    status.unresponsiveSince = 0;
    status.comfy = 'online';
    status.url = found.url;
    status.message = '';
    applyStats(found.stats);
    jobs.setServer(found.url);
    try {
      const q = await jobs.comfy!.queue();
      status.queue = q.queue_running.length + q.queue_pending.length;
    } catch {
      /* ignore */
    }
  } else {
    jobs.setServer(null);
    status.url = null;
    status.vram = null;
    status.queue = 0;
    status.desktopRunning = await desktopRunning(cfg.desktop.exe);
    const starting = Date.now() - status.startRequestedAt < cfg.comfy.startTimeoutSec * 1000;
    if (starting && !status.desktopRunning) status.comfy = 'starting';
    else if (status.desktopRunning) {
      status.comfy = starting ? 'starting' : 'desktop-open';
      status.message =
        'Comfy Desktop is open but its ComfyUI server is not running yet. In the Comfy Desktop window, click your "ComfyUI" install to launch it. Tip: Comfy Desktop → Settings → "Auto-launch on startup" does this for you.';
    } else {
      status.comfy = 'offline';
      status.message = "ComfyUI isn't running.";
    }
  }
  if (JSON.stringify([status.comfy, status.url]) !== before) broadcast({ type: 'status', status: publicStatus() });
  else broadcast({ type: 'status', status: publicStatus() });
}

function publicStatus() {
  const { startRequestedAt: _s, misses: _m, unresponsiveSince: _u, ...rest } = status;
  return { ...rest, connected: jobs.connected };
}

// ---------------------------------------------------------------- server --
const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 64 * 1024 * 1024 });
await app.register(fastifyWebsocket);
await app.register(fastifyMultipart, { limits: { fileSize: 512 * 1024 * 1024 } });

app.setErrorHandler((err: any, _req, reply) => {
  reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500).send({ error: err.message ?? String(err) });
});

app.get('/api/events', { websocket: true }, (socket) => {
  sockets.add(socket);
  socket.send(JSON.stringify({ type: 'hello', status: publicStatus(), jobs: store.activeJobs().map(publicJob) }));
  socket.on('close', () => sockets.delete(socket));
});

app.get('/api/status', async () => publicStatus());

app.post('/api/comfy/start', async () => {
  if (status.comfy === 'online') return { ok: true, already: true };
  const running = await desktopRunning(cfg.desktop.exe);
  status.startRequestedAt = Date.now();
  if (!running) {
    const r = launchDesktop(cfg.desktop.exe);
    if (!r.ok) return { ok: false, error: r.error };
  }
  status.comfy = 'starting';
  broadcast({ type: 'status', status: publicStatus() });
  return { ok: true, desktopWasRunning: running };
});

app.get('/api/comfy/log', async () => ({ log: tailDesktopLog(cfg.desktop.logsDir, 120) }));

app.post('/api/free', async () => {
  await jobs.comfy?.free(true, true);
  return { ok: true };
});

app.get('/api/manifest', async (_req, reply) => {
  const prompts = readJson(path.join(cfg.paths.presets, 'prompts.json'));
  const errs = validateTemplates(prompts);
  // a hand edit that breaks a template must not silently send malformed prompts
  if (errs.length) return reply.code(500).send({ error: `presets/prompts.json: ${errs.join('; ')}` });
  return {
    manifest: manifest(),
    styles: readJson(path.join(cfg.paths.presets, 'styles.json')),
    camera: readJson(path.join(cfg.paths.presets, 'camera.json')),
    prompts,
    comfyUrl: status.url,
  };
});

app.post('/api/upload', async (req, reply) => {
  if (!jobs.comfy) return reply.code(503).send({ error: "ComfyUI isn't running." });
  const part = await req.file();
  if (!part) return reply.code(400).send({ error: 'No file' });
  const buf = await part.toBuffer();
  const ext = (path.extname(part.filename || '') || (part.mimetype === 'video/mp4' ? '.mp4' : part.mimetype === 'video/quicktime' ? '.mov' : '.png')).toLowerCase();
  const name = `dr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}${ext}`;
  const up = await jobs.comfy.upload('image', new Blob([new Uint8Array(buf)]), name, { subfolder: 'darkroom' });
  let width: number | null = null;
  let height: number | null = null;
  if (part.mimetype.startsWith('image/')) {
    const m = await sharp(buf).metadata().catch(() => null);
    width = m?.width ?? null;
    height = m?.height ?? null;
  }
  return { name: inputName(up), width, height };
});

/** Your own video into the Library (DECISIONS 100): the uploaded file plus its first and last frames from the browser. */
app.post('/api/import/video', async (req, reply) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === 'string' && !/\.\.|\\/.test(b[k] as string) ? (b[k] as string) : '');
  if (!str('video') || !str('poster') || !str('last')) return reply.code(400).send({ error: 'Video and its frames are needed.' });
  try {
    const num = (k: string) => (typeof b[k] === 'number' && Number.isFinite(b[k]) ? (b[k] as number) : undefined);
    const item = await jobs.importVideo({ video: str('video'), poster: str('poster'), last: str('last'), name: str('name') || 'Video', boardId: b.boardId, width: num('width'), height: num('height'), duration: num('duration') });
    return slim(item);
  } catch (e) {
    return reply.code(500).send({ error: (e as Error).message });
  }
});

/** Make a library item usable as a workflow input (uploads it once to ComfyUI's input folder). */
app.post('/api/items/:id/as-input', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { which = 'main' } = (req.body ?? {}) as { which?: 'main' | 'poster' | 'last' };
  const item = store.getItem(id);
  if (!item) return reply.code(404).send({ error: 'Not found' });
  try {
    const name = await jobs.asInput(item, which);
    return { name, width: item.width, height: item.height };
  } catch (e) {
    return reply.code(503).send({ error: (e as Error).message });
  }
});

/**
 * Local VLM (Qwen3-VL 8B): caption | reverse | enhance | motion.
 * body: { task, variant, text?, itemId?, input?, which? }  -> { text, seconds }
 */
app.post('/api/vlm', async (req, reply) => {
  const b = (req.body ?? {}) as { task: Vlm2Task; variant: string; style?: string; camera?: string[]; sound?: { mode: SoundMode; text?: string }; text?: string; itemId?: string; input?: string; which?: 'main' | 'poster' | 'last'; seed?: number; save?: boolean; input2?: string; inputs?: string[] };
  if (!jobs.comfy) return reply.code(503).send({ error: "ComfyUI isn't running." });
  let request;
  let pair = false;
  try {
    // Addenda Phase 7: per-task engine routing (general VLM / Qwen-Image 2.1 PE-T2I / PE-I2I) with real system prompts
    const prompts = readJson<Vlm2Prompts>(path.join(cfg.paths.presets, 'vlm_prompts.json'));
    // Video motion with an end frame: the "<variant>_pair" prompt, which asks for the motion from START to END
    pair = b.task === 'motion' && !!b.input2 && !!(prompts.motion as Record<string, unknown> | undefined)?.[`${b.variant}_pair`];
    request = buildVlm2Request(prompts, b.task, pair ? `${b.variant}_pair` : b.variant, b.text ?? '', (rel) => fs.readFileSync(path.join(cfg.paths.presets, rel), 'utf8'));
    // Motion with the sound chosen on Video (DECISIONS 97)
    if (b.task === 'motion' && b.sound) request = withSound(request, b.sound.mode, b.sound.text);
    // Motion with the camera chips chosen on Video (DECISIONS 94): the writer leaves the camera to them
    if (b.task === 'motion' && Array.isArray(b.camera) && b.camera.length) {
      const cams = readJson<{ camera: Record<string, string>[] }>(path.join(cfg.paths.presets, 'camera.json')).camera;
      const model = b.variant === 'ltx' ? 'ltx' : 'wan';
      request = withCameraMoves(request, b.camera.map((id) => cams.find((c) => c.id === id)?.[model] ?? '').filter(Boolean));
    }
    // Enhance with the style chosen on Generate (DECISIONS 93)
    if (b.task === 'enhance' && b.style && b.style !== 'none') {
      const st = readJson<{ styles: Record<string, string>[] }>(path.join(cfg.paths.presets, 'styles.json')).styles.find((x) => x.id === b.style);
      const entry = (prompts.enhance as Record<string, Vlm2Entry> | undefined)?.[b.variant];
      if (st?.[b.variant]) request = withEnhanceStyle(request, st[b.variant], !entry?.system_file);
    }
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
  const params: Record<string, string | number | boolean> = { ...request.params, seed: b.seed ?? Math.floor(Math.random() * 2 ** 31) };
  if (request.workflow === 'vlm2_image') {
    let name = b.input;
    if (!name && b.itemId) {
      const item = store.getItem(b.itemId);
      if (!item) return reply.code(404).send({ error: 'Picture not found.' });
      name = await jobs.asInput(item, b.which ?? (item.kind === 'video' ? 'poster' : 'main'));
    }
    const asRef = (n: string) => {
      const i = n.lastIndexOf('/');
      return { filename: n.slice(i + 1), subfolder: i >= 0 ? n.slice(0, i) : '', type: 'input' };
    };
    /** Several pictures as one labelled sheet (the vision graph takes a single image). */
    const sheetOf = async (names: string[], labels: string[], prefix: string) => {
      const sheet = await labelledSheet(await Promise.all(names.map((n) => jobs.comfy!.view(asRef(n)))), labels);
      return inputName(await jobs.comfy!.upload('image', new Blob([new Uint8Array(sheet)]), `${prefix}_${Date.now().toString(36)}.png`, { subfolder: 'darkroom' }));
    };
    if (b.task === 'compose') {
      // Generate "From references": every reference labelled IMAGE 1..3 on one sheet
      const refs = (b.inputs ?? []).filter((x) => typeof x === 'string').slice(0, 3);
      if (!refs.length) return reply.code(400).send({ error: 'Add a reference picture first.' });
      try {
        name = await sheetOf(refs, refs.map((_, i) => `IMAGE ${i + 1}`), 'refs_sheet');
        // say how many references exist and the exact words to use, or the model invents an "image 3" (seen with one)
        const tokens = refs.map((_, i) => (b.variant === 'qwen' ? `<image${i + 1}>` : `image ${i + 1}`));
        params.prompt = `There ${refs.length === 1 ? 'is 1 reference picture' : `are ${refs.length} reference pictures`}; name each one as ${tokens.join(', ')} and no others.
${params.prompt}`;
      } catch (e) {
        return reply.code(400).send({ error: 'Could not read the references: ' + (e as Error).message });
      }
    }
    if (!name) return reply.code(400).send({ error: 'This needs a picture.' });
    if (pair && b.input2) {
      // Video motion with an end frame: START and END side by side
      try {
        name = await sheetOf([name, b.input2], ['START', 'END'], 'motion_pair');
      } catch (e) {
        return reply.code(400).send({ error: 'Could not read the end frame: ' + (e as Error).message });
      }
    }
    params.image_1 = name;
  }
  const t0 = Date.now();
  try {
    const job = await jobs.submit({ workflow: request.workflow, params, meta: { mode: `vlm:${b.task}`, model: request.modelLabel, prompt: b.text ?? '' } });
    const done = await jobs.waitFor(job.id);
    if (done.status !== 'done') return reply.code(500).send({ error: done.error ?? 'The model did not answer.' });
    const meta = done.meta as Record<string, unknown>;
    let text = String(meta.text ?? '');
    // camera chips own the camera (DECISIONS 94): the written motion keeps none of its own
    if (b.task === 'motion' && Array.isArray(b.camera) && b.camera.length) text = dropCameraSentences(text);
    // your sound description is added by Video itself (DECISIONS 97): the written motion keeps no copy of it
    if (b.task === 'motion' && b.sound?.mode === 'describe' && b.sound.text) text = dropCopiedSound(text, b.sound.text);
    let ratio: string | null = null;
    if (request.output === 'json_ratio') ({ text, ratio } = parsePeJson(String(meta.raw ?? text)));
    if (b.save && b.itemId && b.task === 'caption') store.updateItem(b.itemId, { caption: text });
    return { text, seconds: Math.round((Date.now() - t0) / 100) / 10, model: request.modelLabel, ...(ratio ? { ratio, aspect: nearestAspect(ratio) } : {}) };
  } catch (e) {
    return reply.code(500).send({ error: (e as Error).message });
  }
});

/**
 * "Restore settings from image" (Addendum 1 H): read the darkroom tEXt chunk from a dropped PNG, or a settings JSON
 * sidecar. Works on files that are no longer in the library.
 */
app.post('/api/restore', async (req, reply) => {
  const part = await req.file();
  if (!part) return reply.code(400).send({ error: 'No file' });
  const meta = readDarkroomMeta(new Uint8Array(await part.toBuffer()));
  if (!meta) return reply.code(404).send({ error: 'No Darkroom settings found in that file. Only pictures saved by Darkroom (or their settings JSON) can be restored.' });
  return meta;
});

/** Settings of a library item as JSON (the sidecar: also for videos, and for PNGs whose chunks were stripped). */
app.get('/api/items/:id/settings', async (req, reply) => {
  const item = store.getItem((req.params as { id: string }).id);
  if (!item) return reply.code(404).send({ error: 'Not found' });
  const body = { darkroom: { app: 'Darkroom', mode: item.mode, model: item.model, prompt: item.prompt, seed: item.seed, ui: item.ui ?? null, parent: item.parent_id ?? null, item: item.id } };
  reply.header('content-disposition', `attachment; filename="darkroom-${item.id}.json"`);
  return body;
});

/** Edit presets: read-only built-ins merged with the user's own file by label (Addendum 1 F). */
const userPresetsFile = () => path.join(cfg.paths.data, 'user_presets.json');
const readUserPresets = (): UserPreset[] => {
  try {
    const j = JSON.parse(fs.readFileSync(userPresetsFile(), 'utf8'));
    return Array.isArray(j.presets) ? j.presets : [];
  } catch {
    return [];
  }
};
app.get('/api/presets', async () => {
  const builtin = readJson<{ presets: EditPreset[] }>(path.join(cfg.paths.presets, 'edit_presets.json')).presets;
  return { presets: mergePresets(builtin, readUserPresets()) };
});
app.put('/api/presets/mine', async (req, reply) => {
  const p = (req.body ?? {}) as UserPreset;
  if (!p.label?.trim()) return reply.code(400).send({ error: 'Give the preset a name.' });
  if (!p.hidden && !p.klein?.trim() && !p.qwen?.trim()) return reply.code(400).send({ error: 'The preset has no text.' });
  const next = upsertUserPreset(readUserPresets(), p);
  fs.mkdirSync(path.dirname(userPresetsFile()), { recursive: true });
  fs.writeFileSync(userPresetsFile(), JSON.stringify({ presets: next }, null, 2));
  return { ok: true };
});

/**
 * Outpaint canvas prep (Addendum 1 D): the item on a black canvas + a mask that fades into the original, uploaded to
 * ComfyUI's input folder. Returns the names, the canvas size and the mask's bounding box (for the crop plan).
 * body: { itemId, pad: {left,top,right,bottom}, feather? (0 = Auto), step (8 Klein, 32 Qwen) }
 */
app.post('/api/outpaint/prepare', async (req, reply) => {
  const b = (req.body ?? {}) as { itemId: string; pad: Pad; feather?: number; step?: number };
  const item = store.getItem(b.itemId);
  if (!item?.file) return reply.code(404).send({ error: 'Picture not found.' });
  if (!jobs.comfy) return reply.code(503).send({ error: "ComfyUI isn't running." });
  const pad = { left: b.pad?.left | 0, top: b.pad?.top | 0, right: b.pad?.right | 0, bottom: b.pad?.bottom | 0 };
  if (!(pad.left || pad.top || pad.right || pad.bottom)) return reply.code(400).send({ error: 'Choose how far to extend first.' });
  try {
    const src = Buffer.from(await jobs.comfy.view(item.file));
    const cv = await buildOutpaintCanvas(src, pad, { step: b.step === 32 ? 32 : 8, feather: b.feather ?? 0 });
    const tag = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const img = await jobs.comfy.upload('image', new Blob([new Uint8Array(cv.image)]), `outpaint_${tag}.png`, { subfolder: 'darkroom' });
    const msk = await jobs.comfy.upload('image', new Blob([new Uint8Array(cv.mask)]), `outpaint_${tag}_mask.png`, { subfolder: 'darkroom' });
    const raw = await sharp(cv.mask).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const bbox = maskBBox(raw.data, raw.info.width, raw.info.height, 0, 16);
    return { image: inputName(img), mask: inputName(msk), width: cv.width, height: cv.height, pad: cv.pad, feather: cv.feather, bbox };
  } catch (e) {
    return reply.code(500).send({ error: (e as Error).message });
  }
});

/** Run SAM 3.1 and return mask file URLs (not saved to the library). */
app.post('/api/segment', async (req, reply) => {
  const b = (req.body ?? {}) as { itemId: string; text?: string; points?: { x: number; y: number }[]; negPoints?: { x: number; y: number }[]; box?: { x: number; y: number; width: number; height: number }; individual?: boolean; threshold?: number };
  const item = store.getItem(b.itemId);
  if (!item) return reply.code(404).send({ error: 'Picture not found.' });
  if (!b.text?.trim() && !b.points?.length && !b.box) return reply.code(400).send({ error: 'Click on the object, drag a box around it, or type what to select.' });
  const params: Record<string, string | number | boolean> = { image_1: await jobs.asInput(item), individual: !!b.individual };
  if (b.text?.trim()) params.text = b.text.trim();
  Object.assign(params, samPointsJson(b.points ?? [], b.negPoints ?? []));
  if (b.box) params.boxes = JSON.stringify({ x: Math.round(b.box.x), y: Math.round(b.box.y), width: Math.round(b.box.width), height: Math.round(b.box.height) });
  if (b.threshold) params.threshold = b.threshold;
  const t0 = Date.now();
  try {
    const job = await jobs.submit({ workflow: 'sam_segment', params, meta: { mode: 'segment', model: 'SAM 3.1', prompt: b.text ?? '' } });
    const done = await jobs.waitFor(job.id, 5 * 60 * 1000);
    if (done.status !== 'done') return reply.code(500).send({ error: done.error ?? 'Segmentation failed.' });
    const files = ((done.meta as Record<string, unknown>).files as FileRef[] | undefined) ?? [];
    return { masks: files.map(outputUrl), seconds: Math.round((Date.now() - t0) / 100) / 10 };
  } catch (e) {
    return reply.code(500).send({ error: (e as Error).message });
  }
});

/** Proxy a ComfyUI output file (e.g. a SAM mask) that is not a library item. */
app.get('/api/output', async (req, reply) => {
  const q = req.query as { filename?: string; subfolder?: string; type?: string };
  if (!q.filename || !jobs.comfy || /\.\.|[\\/]/.test(q.filename) || (q.subfolder ?? '').includes('..')) return reply.code(400).send({ error: 'Bad request' });
  const r = await fetch(jobs.comfy.viewUrl({ filename: q.filename, subfolder: q.subfolder ?? '', type: q.type ?? 'output' }));
  if (!r.ok) return reply.code(r.status).send({ error: 'Not found' });
  reply.header('content-type', r.headers.get('content-type') ?? 'application/octet-stream');
  return reply.send(Buffer.from(await r.arrayBuffer()));
});

app.get('/api/groups/:id', async (req) => store.groupItems((req.params as { id: string }).id).map(slim));

/** Export layers (top-to-bottom) as a layered PSD or a ZIP of PNGs. */
app.post('/api/layers/export', async (req, reply) => {
  const b = (req.body ?? {}) as { format: 'psd' | 'zip'; layers: { id: string; name: string; visible: boolean }[] };
  if (!jobs.comfy) return reply.code(503).send({ error: "ComfyUI isn't running, so the layer files can't be read." });
  if (!b.layers?.length) return reply.code(400).send({ error: 'No layers to export.' });
  const inputs: LayerInput[] = [];
  for (const l of b.layers) {
    const it = store.getItem(l.id);
    if (!it) continue;
    inputs.push({ name: l.name, visible: l.visible, png: new Uint8Array(await sharp(await jobs.comfy.view(it.file)).png().toBuffer()) });
  }
  const buf = b.format === 'psd' ? await layersToPsd(inputs) : layersToZip(inputs);
  reply.header('content-type', b.format === 'psd' ? 'image/vnd.adobe.photoshop' : 'application/zip');
  reply.header('content-disposition', `attachment; filename="darkroom-layers.${b.format}"`);
  return reply.send(buf);
});

app.post('/api/jobs', async (req, reply) => {
  const body = req.body as SubmitRequest;
  try {
    const job = await jobs.submit(body);
    return publicJob(job);
  } catch (e) {
    if (e instanceof VramWarning) return reply.code(409).send({ warning: e.message, freeGB: e.freeGB, needGB: e.needGB });
    return reply.code(400).send({ error: (e as Error).message });
  }
});

app.get('/api/jobs', async (req) => {
  const { kind, limit, live } = req.query as { kind?: string; limit?: string; live?: string };
  if (live && kind) return store.liveTakes(kind, Number(limit) || 30).map(publicJob);
  return store.recentJobs(kind, Number(limit) || 50).map(publicJob);
});

/** Takes panel: hide failed / cancelled / lost renders (one, or every one of a kind). */
app.post('/api/jobs/dismiss', async (req) => {
  const b = (req.body ?? {}) as { ids?: string[]; failedOfKind?: string };
  const ids = b.failedOfKind ? store.failedJobIds(b.failedOfKind) : Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === 'string') : [];
  const done = store.dismissJobs(ids);
  if (done.length) broadcast({ type: 'library' });
  return { dismissed: done };
});

app.get('/api/jobs/active', async () => store.activeJobs().map(publicJob));

app.post('/api/jobs/:id/cancel', async (req) => {
  await jobs.cancel((req.params as { id: string }).id);
  return { ok: true };
});

app.get('/api/items', async (req) => {
  const q = req.query as Record<string, string>;
  const res = store.listItems({ filter: (q.filter as LibraryQuery['filter']) ?? 'all', q: q.q, limit: Number(q.limit) || 60, offset: Number(q.offset) || 0, board: q.board || undefined, stack: q.stack === '1' });
  return { total: res.total, items: res.items.map(slim) };
});

app.get('/api/items/:id', async (req, reply) => {
  const item = store.getItem((req.params as { id: string }).id);
  if (!item) return reply.code(404).send({ error: 'Not found' });
  const lineage = store.lineage(item.root_id ?? item.id).map(slim);
  return { item: slim(item), lineage };
});

app.patch('/api/items/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!store.getItem(id)) return reply.code(404).send({ error: 'Not found' });
  const body = req.body as { favourite?: boolean; tags?: string[]; caption?: string };
  store.updateItem(id, { favourite: body.favourite, tags: body.tags, caption: body.caption });
  const item = store.getItem(id)!;
  broadcast({ type: 'item', item: slim(item) });
  return slim(item);
});

// ---- Your own LoRAs, sorted by the model they fit (DECISIONS 86)
/** Your own Klein 9B fine-tunes (DECISIONS 91). */
app.get('/api/models/klein', async (_req, reply) => {
  try {
    const official = jobs.loraModels().klein;
    return { official, finetunes: await jobs.loraLibrary.finetunes(official) };
  } catch (e) {
    return reply.code(503).send({ error: (e as Error).message });
  }
});

app.get('/api/loras', async (_req, reply) => {
  if (!jobs.comfy) return reply.code(503).send({ error: "ComfyUI isn't running." });
  try {
    return await jobs.loraLibrary.catalogue(jobs.loraModels());
  } catch (e) {
    return reply.code(500).send({ error: (e as Error).message });
  }
});

// ---- Compose (DECISIONS 87): saved compositions. Deleting only hides one (restorable); pictures are never touched.
app.get('/api/compositions', async () => store.compositions());

app.get('/api/compositions/:id', async (req, reply) => store.composition((req.params as { id: string }).id) ?? reply.code(404).send({ error: 'Composition not found' }));

app.put('/api/compositions/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^[A-Za-z0-9-]{6,64}$/.test(id)) return reply.code(400).send({ error: 'Bad composition id' });
  const b = req.body as { name?: unknown; doc?: unknown; thumb?: unknown };
  const doc = sanitiseDoc(b?.doc);
  if (!doc) return reply.code(400).send({ error: 'That composition could not be read.' });
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : 'Untitled composition';
  const thumb = typeof b.thumb === 'string' && b.thumb.startsWith('data:image/') && b.thumb.length < 400_000 ? b.thumb : null;
  return store.saveComposition(id, name, doc, thumb);
});

app.post('/api/compositions/:id/delete', async (req, reply) => (store.deleteComposition((req.params as { id: string }).id) ? { ok: true } : reply.code(404).send({ error: 'Composition not found' })));

app.post('/api/compositions/:id/restore', async (req, reply) => (store.restoreComposition((req.params as { id: string }).id) ? { ok: true } : reply.code(404).send({ error: 'Composition not found' })));

// ---- Timeline (DECISIONS 103): films put together from Library clips and your own sound.
app.get('/api/timelines', async () => store.timelines());

app.get('/api/timelines/:id', async (req, reply) => store.timeline((req.params as { id: string }).id) ?? reply.code(404).send({ error: 'Timeline not found' }));

app.put('/api/timelines/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^[A-Za-z0-9-]{6,64}$/.test(id)) return reply.code(400).send({ error: 'Bad timeline id' });
  const b = req.body as { name?: unknown; doc?: unknown };
  const doc = sanitiseTimeline(b?.doc);
  if (!doc) return reply.code(400).send({ error: 'That timeline could not be read.' });
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : 'Untitled film';
  return store.saveTimeline(id, name, doc);
});

app.post('/api/timelines/:id/delete', async (req, reply) => (store.deleteTimeline((req.params as { id: string }).id) ? { ok: true } : reply.code(404).send({ error: 'Timeline not found' })));

app.post('/api/timelines/:id/restore', async (req, reply) => (store.restoreTimeline((req.params as { id: string }).id) ? { ok: true } : reply.code(404).send({ error: 'Timeline not found' })));

/** One export at a time: it reads every clip from disk and keeps a CPU busy. */
let exporting: string | null = null;

app.post('/api/timelines/:id/export', async (req, reply) => {
  const { id } = req.params as { id: string };
  const t = store.timeline(id);
  if (!t) return reply.code(404).send({ error: 'Timeline not found' });
  if (!t.doc.clips.length) return reply.code(400).send({ error: 'Put at least one clip on the timeline first.' });
  if (exporting) return reply.code(409).send({ error: 'Another film is being exported; try again when it is done.' });
  if (!jobs.comfy) return reply.code(503).send({ error: "ComfyUI isn't running, so Darkroom can't find the clips' files. Start it and try again." });
  const python = desktopPython(cfg);
  if (!python) return reply.code(500).send({ error: "Darkroom can't find Comfy Desktop's Python, which puts the film together." });
  const argv = ((await jobs.comfy.systemStats()) as SystemStats).system?.argv;
  const outDir = outputDirFromArgv(argv);
  const inDir = inputDirFromArgv(argv);
  if (!outDir || !inDir) return reply.code(409).send({ error: "ComfyUI doesn't report its folders, so the film can't be put together." });
  const items = new Map(t.doc.clips.map((c) => [c.itemId, store.getItem(c.itemId)]));
  const fileOf = (f: FileRef | null | undefined) => (!f ? null : (f.type ?? 'output') === 'input' ? inside(inDir, path.join(f.subfolder ?? '', f.filename)) : outputPath(outDir, f));
  const clips = [];
  for (const c of ordered(t.doc.clips)) {
    const it = items.get(c.itemId);
    const p = fileOf(it?.file);
    if (!it || !p || !fs.existsSync(p)) return reply.code(400).send({ error: `A clip on the timeline is no longer in the Library (${it?.prompt?.slice(0, 40) || 'deleted'}). Remove it and export again.` });
    clips.push({ id: c.id, path: p, start: c.start, in: c.in, out: c.out, muted: !!c.muted });
  }
  const sounds = [];
  for (const s of t.doc.sounds) {
    const p = inside(inDir, s.file);
    if (!p || !fs.existsSync(p)) return reply.code(400).send({ error: `The sound "${s.name}" is missing. Remove it and export again.` });
    sounds.push({ id: s.id, path: p, start: s.start, in: s.in, out: s.out, volume: s.volume });
  }
  const size = exportSize(t.doc, (itemId) => {
    const it = items.get(itemId);
    return it?.width && it.height ? { width: it.width, height: it.height } : null;
  });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '_' + crypto.randomBytes(3).toString('hex');
  const sub = path.join('darkroom', 'video');
  fs.mkdirSync(path.join(outDir, sub), { recursive: true });
  const names = { out: `timeline_${stamp}.mp4`, poster: `timeline_${stamp}_poster.png`, last: `timeline_${stamp}_last.png` };
  exporting = id;
  broadcast({ type: 'export', timelineId: id, progress: 0 });
  try {
    await runExport(
      python,
      {
        out: path.join(outDir, sub, names.out),
        poster: path.join(outDir, sub, names.poster),
        last: path.join(outDir, sub, names.last),
        ...size,
        fps: t.doc.fps,
        crf: 18,
        duration: timelineDuration(t.doc),
        clips,
        sounds,
      },
      (progress) => broadcast({ type: 'export', timelineId: id, progress }),
    );
    const ref = (filename: string): FileRef => ({ filename, subfolder: 'darkroom/video', type: 'output' });
    const item = await jobs.addVideo({
      file: ref(names.out),
      poster: ref(names.poster),
      last: ref(names.last),
      name: t.name,
      mode: 'timeline',
      workflow: 'timeline_export',
      model: 'Timeline',
      ui: { timelineId: id },
      params: { timeline: id, clips: clips.length, sounds: sounds.length },
      boardId: (req.body as { boardId?: unknown } | null)?.boardId,
      ...size,
    });
    broadcast({ type: 'export', timelineId: id, progress: 1, itemId: item.id });
    return slim(item);
  } catch (e) {
    broadcast({ type: 'export', timelineId: id, progress: -1 });
    return reply.code(500).send({ error: 'The film could not be put together: ' + (e as Error).message });
  } finally {
    exporting = null;
  }
});

/**
 * Timeline AI tools (DECISIONS 104): fill a gap, extend a clip, retake a moment. The guide frames are read straight
 * from the clips' files, LTX renders the new clip at exactly the right length, and a placeholder holds its place on
 * the film until it lands (the job's chain swaps it in).
 */
app.post('/api/timelines/:id/generate', async (req, reply) => {
  const { id } = req.params as { id: string };
  const t = store.timeline(id);
  if (!t) return reply.code(404).send({ error: 'Timeline not found' });
  const b = (req.body ?? {}) as { request?: GenerateRequest; prompt?: unknown; quality?: unknown; keyMoments?: { itemId: string; at: number }[]; soundSync?: unknown; seed?: unknown };
  if (!b.request || !['fill', 'extend', 'retake'].includes(b.request.kind)) return reply.code(400).send({ error: 'What should be made?' });
  if (!jobs.comfy) return reply.code(503).send({ error: "ComfyUI isn't running. Start it from the status pill at the top." });
  const python = desktopPython(cfg);
  if (!python) return reply.code(500).send({ error: "Darkroom can't find Comfy Desktop's Python, which reads the clips' frames." });
  const argv = ((await jobs.comfy.systemStats()) as SystemStats).system?.argv;
  const outDir = outputDirFromArgv(argv);
  const inDir = inputDirFromArgv(argv);
  if (!outDir || !inDir) return reply.code(409).send({ error: "ComfyUI doesn't report its folders." });
  const newId = () => crypto.randomBytes(6).toString('hex');
  let plan;
  try {
    plan = planGeneration(t.doc, b.request, newId);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
  const pathOf = (itemId: string) => {
    const f = store.getItem(itemId)?.file;
    return !f ? null : (f.type ?? 'output') === 'input' ? inside(inDir, path.join(f.subfolder ?? '', f.filename)) : outputPath(outDir, f);
  };
  const stamp = Date.now().toString(36) + newId().slice(0, 4);
  const frameFile = async (ref: { itemId: string; t: number } | null, tag: string) => {
    if (!ref) return null;
    const src = pathOf(ref.itemId);
    if (!src || !fs.existsSync(src)) throw new Error('A clip next to it is no longer in the Library.');
    const rel = `darkroom/tlf_${stamp}_${tag}.png`;
    fs.mkdirSync(path.join(inDir, 'darkroom'), { recursive: true });
    await grabFrame(python, src, ref.t, path.join(inDir, rel));
    return rel;
  };
  try {
    const first = await frameFile(plan.first, 'a');
    const last = await frameFile(plan.last, 'b');
    if (!first) return reply.code(400).send({ error: 'There is no picture to start from.' });
    const m = manifest();
    const model = (m as any).video?.ltx;
    const quality = (['draft', 'final', 'hd'].includes(b.quality as string) ? b.quality : 'draft') as 'draft' | 'final' | 'hd';
    const size = exportSize(t.doc, (itemId) => {
      const it = store.getItem(itemId);
      return it?.width && it.height ? { width: it.width, height: it.height } : null;
    });
    const vp = planVideo(model, quality, plan.seconds, size.width, size.height);
    const ex = exactFrames(plan.seconds, t.doc.fps);
    const keys = [];
    for (const k of (Array.isArray(b.keyMoments) ? b.keyMoments : []).slice(0, 6)) {
      const it = store.getItem(k.itemId);
      if (!it || it.kind !== 'image') continue;
      keys.push({ image: await jobs.asInput(it), frame: Math.round(Math.min(1, Math.max(0, k.at / plan.seconds)) * (ex.frames - 1)), strength: 0.7 });
    }
    let sound: { file: string; start: number; seconds: number } | null = null;
    if (b.soundSync) {
      const s = t.doc.sounds.find((x) => x.start <= plan.start + 0.05 && endOf(x) >= plan.start + plan.seconds - 0.05);
      if (!s) return reply.code(400).send({ error: 'To animate to your sound, a sound on the sound track must cover the whole stretch.' });
      sound = { file: s.file, start: Math.round((s.in + (plan.start - s.start)) * 1000) / 1000, seconds: plan.seconds };
    }
    let prompt = String(b.prompt ?? '').trim().slice(0, 2000) || 'Natural, continuous motion that carries on from what came before.';
    // several pictures in one clip: ask for one continuous shot, or LTX may cut or dissolve between them (DECISIONS 104)
    if (keys.length || (first && last)) prompt = `One continuous shot without any cuts. ${prompt}`;
    const label = { fill: 'Filling the gap', extend: 'Extending', retake: 'Retaking' }[b.request.kind];
    const pendingId = newId();
    const job = await jobs.submit({
      workflow: vp.workflow,
      params: {
        start_image: first,
        ...(last ? { end_image: last } : {}),
        motion_prompt: prompt,
        seed: typeof b.seed === 'number' ? b.seed : Math.floor(Math.random() * 2 ** 31),
        frames: ex.frames,
        fps: ex.fps,
        width: vp.width,
        height: vp.height,
        ...(keys.length ? { key_moments: JSON.stringify(keys) } : {}),
        ...(sound ? { sound_sync: JSON.stringify(sound) } : {}),
      },
      meta: {
        mode: 'timeline',
        model: `LTX 2.5 · ${label.toLowerCase()}`,
        prompt,
        ui: { model: 'ltx', quality, timelineId: id },
        estimateSec: vp.estimateSec ?? undefined,
        durationSec: plan.seconds,
        chain: { kind: 'timeline', timelineId: id, pendingId, start: plan.start, seconds: plan.seconds, muted: !!sound },
      },
      force: true,
    });
    const doc = { ...plan.doc, pending: [...(plan.doc.pending ?? []), { id: pendingId, jobId: job.id, kind: b.request.kind, start: plan.start, length: plan.seconds, label }] };
    const saved = store.saveTimeline(id, t.name, doc);
    broadcast({ type: 'timeline', id, doc: saved.doc });
    return { doc: saved.doc, job: publicJob(job) };
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

// ---- Boards (collections). Deleting a board never deletes its pictures; they just have no board any more.
const boardName = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 60) : '');

app.get('/api/boards', async () => ({ boards: store.boards(), none: store.listItems({ filter: 'all', board: 'none', limit: 1 }).total }));

app.post('/api/boards', async (req, reply) => {
  const name = boardName((req.body as { name?: unknown })?.name);
  if (!name) return reply.code(400).send({ error: 'Give the board a name.' });
  if (store.boards().some((b) => b.name.toLowerCase() === name.toLowerCase())) return reply.code(409).send({ error: `There is already a board called "${name}".` });
  const board = store.createBoard(name, crypto.randomUUID());
  broadcast({ type: 'library' });
  return board;
});

app.patch('/api/boards/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const name = boardName((req.body as { name?: unknown })?.name);
  if (!name) return reply.code(400).send({ error: 'Give the board a name.' });
  if (store.boards().some((b) => b.id !== id && b.name.toLowerCase() === name.toLowerCase())) return reply.code(409).send({ error: `There is already a board called "${name}".` });
  if (!store.renameBoard(id, name)) return reply.code(404).send({ error: 'Board not found' });
  broadcast({ type: 'library' });
  return store.board(id);
});

app.delete('/api/boards/:id', async (req, reply) => {
  if (!store.deleteBoard((req.params as { id: string }).id)) return reply.code(404).send({ error: 'Board not found' });
  broadcast({ type: 'library' });
  return { ok: true };
});

app.post('/api/items/board', async (req, reply) => {
  const b = req.body as { ids?: unknown; boardId?: unknown };
  const boardId = typeof b?.boardId === 'string' ? b.boardId : null;
  if (boardId && !store.board(boardId)) return reply.code(404).send({ error: 'Board not found' });
  const moved = store.moveToBoard(idList(b), boardId);
  if (moved.length) broadcast({ type: 'library' });
  return { moved };
});

/** A board as a ZIP of its files (pictures and videos, original quality), streamed from ComfyUI's output folder. */
app.get('/api/boards/:id/zip', async (req, reply) => {
  const board = store.board((req.params as { id: string }).id);
  if (!board) return reply.code(404).send({ error: 'Board not found' });
  if (!jobs.comfy) return reply.code(503).send({ error: "ComfyUI isn't running, so the files can't be fetched." });
  const items = store.listItems({ filter: 'all', board: board.id, limit: 100000 }).items;
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  for (const it of items) {
    try {
      const bytes = await jobs.comfy.view(it.file);
      const ext = path.extname(it.file.filename) || '.png';
      const base = (it.prompt || it.mode).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '') || 'darkroom';
      let name = `${base}-v${it.version}${ext}`;
      for (let n = 2; used.has(name); n++) name = `${base}-v${it.version}-${n}${ext}`;
      used.add(name);
      files[name] = [new Uint8Array(bytes), { level: 0 }] as unknown as Uint8Array; // already compressed media
    } catch {
      /* a file ComfyUI no longer has is skipped */
    }
  }
  const zip = zipSync(files as Parameters<typeof zipSync>[0]);
  const slug = board.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'board';
  reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="darkroom-${slug}.zip"`);
  return reply.send(Buffer.from(zip));
});

// ---- Library delete: Delete moves items to "Recently deleted" (restorable); Delete forever removes the rows and sends
// the files to the Windows Recycle Bin. Files another item still uses are left alone.
const idList = (body: unknown): string[] => {
  const ids = (body as { ids?: unknown })?.ids;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string').slice(0, 1000) : [];
};

app.post('/api/items/delete', async (req) => {
  const done = store.softDelete(idList(req.body));
  if (done.length) broadcast({ type: 'library' });
  return { deleted: done };
});

app.post('/api/items/restore', async (req) => {
  const done = store.restoreItems(idList(req.body));
  if (done.length) broadcast({ type: 'library' });
  return { restored: done };
});

app.post('/api/items/purge', async (req, reply) => {
  const body = req.body as { ids?: string[]; all?: boolean };
  const ids = body?.all ? store.deletedIds() : idList(body);
  if (!ids.length) return { purged: 0, recycled: 0, failed: [] };
  if (!jobs.comfy) return reply.code(503).send({ error: "ComfyUI isn't running, so Darkroom can't find its output folder. Start it and try again." });
  const outDir = outputDirFromArgv(((await jobs.comfy.systemStats()) as SystemStats).system?.argv);
  if (!outDir) return reply.code(409).send({ error: "ComfyUI doesn't report its output folder, so files were not removed." });
  const items = store.purgeItems(ids);
  const files = new Set<string>();
  for (const it of items) {
    for (const f of [it.file, it.poster, it.last_frame]) {
      if (!f || store.fileInUse(f)) continue;
      const p = outputPath(outDir, f);
      if (p) files.add(p);
    }
    fs.rmSync(jobs.thumbPath(it.id), { force: true }); // Darkroom's own thumbnail cache, rebuilt on demand
  }
  const r = await recycle([...files]);
  broadcast({ type: 'library' });
  return { purged: items.length, recycled: r.recycled.length, failed: r.failed };
});

app.get('/api/items/:id/file', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { which = 'main', download } = req.query as { which?: string; download?: string };
  const item = store.getItem(id);
  if (!item) return reply.code(404).send({ error: 'Not found' });
  if (!jobs.comfy) return reply.code(503).send({ error: "ComfyUI isn't running, so the file can't be fetched." });
  const f = which === 'poster' ? item.poster : which === 'last' ? item.last_frame : item.file;
  if (!f) return reply.code(404).send({ error: 'Not available' });
  const headers: Record<string, string> = {};
  if (req.headers.range) headers.range = req.headers.range;
  const r = await fetch(jobs.comfy.viewUrl(f), { headers });
  reply.code(r.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = r.headers.get(h);
    if (v) reply.header(h, v);
  }
  reply.header('cache-control', 'private, max-age=3600');
  if (download) {
    const ext = path.extname(f.filename);
    const slug = (item.prompt || item.mode).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '') || 'darkroom';
    reply.header('content-disposition', `attachment; filename="darkroom-${slug}-${item.seed ?? 'x'}${which === 'main' ? '' : '-' + which}${ext}"`);
  }
  return reply.send(r.body ? Readable.fromWeb(r.body as any) : null);
});

/** Preview of an uploaded input (reference, mask, start frame). */
app.get('/api/input', async (req, reply) => {
  const { name } = req.query as { name?: string };
  if (!name || name.includes('..') || !jobs.comfy) return reply.code(404).send({ error: 'Not found' });
  const i = name.lastIndexOf('/');
  const f = { filename: name.slice(i + 1), subfolder: i >= 0 ? name.slice(0, i) : '', type: 'input' };
  const r = await fetch(jobs.comfy.viewUrl(f));
  if (!r.ok) return reply.code(r.status).send({ error: 'Not found' });
  reply.header('content-type', r.headers.get('content-type') ?? 'application/octet-stream').header('cache-control', 'private, max-age=86400');
  return reply.send(Buffer.from(await r.arrayBuffer()));
});

app.get('/api/jobs/:id/items', async (req) => {
  const job = store.getJob((req.params as { id: string }).id);
  if (!job) return [];
  return job.result_ids.map((id) => store.getItem(id)).filter(Boolean).map((i) => slim(i!));
});

app.get('/api/items/:id/thumb', async (req, reply) => {
  const { id } = req.params as { id: string };
  const p = jobs.thumbPath(id);
  if (!fs.existsSync(p)) {
    const item = store.getItem(id);
    const f = item?.kind === 'video' ? item.poster : item?.file;
    if (!item || !f || !jobs.comfy) return reply.code(404).send({ error: 'No thumbnail' });
    await jobs.makeThumb(id, f);
  }
  reply.header('content-type', 'image/webp').header('cache-control', 'private, max-age=86400');
  return reply.send(fs.createReadStream(p));
});

app.get('/api/items/:id/graph', async (req, reply) => {
  const item = store.getItem((req.params as { id: string }).id);
  if (!item?.api_prompt) return reply.code(404).send({ error: 'No graph stored' });
  reply.header('content-type', 'application/json');
  reply.header('content-disposition', `attachment; filename="darkroom-graph-${item.workflow}-${item.seed ?? item.id.slice(0, 8)}.json"`);
  return JSON.stringify(item.api_prompt, null, 2);
});

function outputUrl(f: FileRef): string {
  return `/api/output?${new URLSearchParams({ filename: f.filename, subfolder: f.subfolder, type: f.type })}`;
}

function slim(item: NonNullable<ReturnType<typeof store.getItem>>) {
  const { api_prompt: _a, ...rest } = item;
  return rest;
}

// Production: serve the built UI.
const dist = path.join(ROOT, 'dist');
if (fs.existsSync(path.join(dist, 'index.html'))) {
  await app.register(fastifyStatic, { root: dist, prefix: '/' });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
}

await poll();
setInterval(() => void poll(), 3000);
await app.listen({ host: cfg.server.host, port: cfg.server.port });
console.log(`Darkroom server on http://${cfg.server.host}:${cfg.server.port} - ComfyUI: ${status.url ?? 'not found'}`);
