import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import sharp from 'sharp';
import type { WebSocket } from 'ws';
import { inputName, type SystemStats } from '../shared/comfy.js';
import type { Manifest } from '../shared/manifest.js';
import { loadConfig, ROOT } from './config.js';
import { Store, type LibraryQuery } from './db.js';
import { desktopRunning, launchDesktop, tailDesktopLog } from './desktop.js';
import { discoverComfy } from './discovery.js';
import { JobManager, publicJob, VramWarning, type SubmitRequest } from './jobs.js';

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
};

function applyStats(stats: SystemStats | null): void {
  if (!stats) return;
  status.version = stats.system.comfyui_version;
  const d = stats.devices[0];
  status.vram = d ? { total: d.vram_total, free: d.vram_free } : null;
}

async function poll(): Promise<void> {
  const found = await discoverComfy(cfg).catch(() => null);
  const before = JSON.stringify([status.comfy, status.url]);
  if (found) {
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
  const { startRequestedAt: _s, ...rest } = status;
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

app.get('/api/manifest', async () => ({
  manifest: manifest(),
  styles: readJson(path.join(cfg.paths.presets, 'styles.json')),
  camera: readJson(path.join(cfg.paths.presets, 'camera.json')),
  comfyUrl: status.url,
}));

/** Prompt enhancement stub: returns the prompt unchanged. Swap in an LLM call here later. */
app.post('/api/enhance', async (req) => {
  const { prompt } = (req.body ?? {}) as { prompt?: string };
  return { prompt: (prompt ?? '').trim(), enhanced: false, note: 'Enhance is not connected to a language model yet — your prompt was kept as written.' };
});

app.post('/api/upload', async (req, reply) => {
  if (!jobs.comfy) return reply.code(503).send({ error: "ComfyUI isn't running." });
  const part = await req.file();
  if (!part) return reply.code(400).send({ error: 'No file' });
  const buf = await part.toBuffer();
  const ext = path.extname(part.filename || '') || (part.mimetype === 'video/mp4' ? '.mp4' : '.png');
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
  const { kind, limit } = req.query as { kind?: string; limit?: string };
  return store.recentJobs(kind, Number(limit) || 50).map(publicJob);
});

app.get('/api/jobs/active', async () => store.activeJobs().map(publicJob));

app.post('/api/jobs/:id/cancel', async (req) => {
  await jobs.cancel((req.params as { id: string }).id);
  return { ok: true };
});

app.get('/api/items', async (req) => {
  const q = req.query as Record<string, string>;
  const res = store.listItems({ filter: (q.filter as LibraryQuery['filter']) ?? 'all', q: q.q, limit: Number(q.limit) || 60, offset: Number(q.offset) || 0 });
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
  const body = req.body as { favourite?: boolean; tags?: string[] };
  store.updateItem(id, { favourite: body.favourite, tags: body.tags });
  const item = store.getItem(id)!;
  broadcast({ type: 'item', item: slim(item) });
  return slim(item);
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
