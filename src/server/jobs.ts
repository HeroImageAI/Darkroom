import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import WebSocket from 'ws';
import { ComfyClient, filesFromHistory, historyError, parseWsMessage, textFromHistory, type OutputFile } from '../shared/comfy.js';
import { cleanVlmOutput } from '../shared/vlm.js';
import { friendlyError } from '../shared/errors.js';
import type { Manifest } from '../shared/manifest.js';
import { buildPrompt, findByTitle, titleOf, WorkflowError, type ApiPrompt, type ParamValues } from '../shared/workflow.js';
import type { FileRef, Item, Job, Store } from './db.js';
import { backToSize } from '../shared/fullsize.js';
import { injectLoras, parseLoras } from '../shared/loras.js';
import { LoraLibrary, type LoraFamily } from './loras.js';

export interface SubmitRequest {
  workflow: string;
  params: ParamValues;
  meta: {
    mode: string; // generate | edit:inpaint | video | ...
    model?: string; // display name
    prompt?: string;
    negative?: string;
    parentId?: string | null;
    ui?: Record<string, unknown>; // UI settings for "Reuse settings"
    estimateSec?: number | null;
    notify?: boolean;
    durationSec?: number;
    chain?: Record<string, unknown>;
    groupId?: string;
    layers?: boolean;
    /** Set on server-side follow-up jobs: the job whose chain started this one (the UI follows it). */
    followOf?: string;
  };
  /** Proceed even if the VRAM check fails. */
  force?: boolean;
}

export type Broadcast = (msg: unknown) => void;

const CLIENT_ID = 'darkroom-server-' + crypto.randomBytes(4).toString('hex');
const FREE_FAMILIES_IGNORED = new Set(['util']);

export class VramWarning extends Error {
  constructor(
    message: string,
    public freeGB: number,
    public needGB: number,
  ) {
    super(message);
  }
}

export class JobManager {
  comfy: ComfyClient | null = null;
  /** Your LoRAs, sorted by the model they fit (read from the files' headers). */
  readonly loraLibrary = new LoraLibrary(() => this.comfy?.baseUrl ?? null);

  /** The diffusion-model files LoRAs are matched against: whatever the Klein and Qwen graphs load. */
  loraModels(): Record<LoraFamily, string> {
    const unet = (wf: string) => {
      const spec = this.manifest().workflows[wf];
      const node = Object.values(this.template(spec.file)).find((n) => n._meta?.title === 'DR_MODEL');
      return String(node?.inputs.unet_name ?? '');
    };
    return { klein: unet('klein_t2i'), qwen: unet('qwen_t2i') };
  }
  private ws: WebSocket | null = null;
  private lastFamily: string | null = null;
  private previewAt = 0;
  private templates = new Map<string, ApiPrompt>();

  constructor(
    private store: Store,
    private manifest: () => Manifest,
    private workflowsDir: string,
    private thumbsDir: string,
    private broadcast: Broadcast,
  ) {
    fs.mkdirSync(thumbsDir, { recursive: true });
  }

  template(file: string): ApiPrompt {
    // Re-read when the file changes so a re-exported workflow is picked up without restart.
    const p = path.join(this.workflowsDir, file);
    const key = `${file}:${fs.statSync(p).mtimeMs}`;
    let t = this.templates.get(key);
    if (!t) {
      t = JSON.parse(fs.readFileSync(p, 'utf8')) as ApiPrompt;
      this.templates.set(key, t);
    }
    return t;
  }

  /** Called by discovery when the ComfyUI URL changes (or goes away). */
  setServer(url: string | null): void {
    if (url && this.comfy?.baseUrl === url && this.ws) return;
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = null;
    this.comfy = url ? new ComfyClient(url) : null;
    if (url) this.connect(url);
  }

  private connect(url: string): void {
    const ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws?clientId=' + CLIENT_ID);
    this.ws = ws;
    ws.on('open', () => void this.resync());
    ws.on('message', (data, isBinary) => this.onMessage(isBinary ? new Uint8Array(data as Buffer) : data.toString()));
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
    });
    ws.on('error', () => {
      /* discovery will retry */
    });
  }

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** After a (re)connect or server restart: settle jobs that finished while we were away. */
  async resync(): Promise<void> {
    if (!this.comfy) return;
    let queue: { queue_running: unknown[][]; queue_pending: unknown[][] };
    try {
      queue = await this.comfy.queue();
    } catch {
      return;
    }
    const inQueue = new Set([...queue.queue_running, ...queue.queue_pending].map((q) => String(q[1])));
    const running = new Set(queue.queue_running.map((q) => String(q[1])));
    for (const job of this.store.activeJobs()) {
      if (!job.prompt_id) continue;
      if (inQueue.has(job.prompt_id)) {
        if (running.has(job.prompt_id) && job.status !== 'running') this.patch(job.id, { status: 'running', started_at: job.started_at ?? Date.now() });
        continue;
      }
      const h = await this.comfy.history(job.prompt_id).catch(() => null);
      if (h && h.status?.completed) await this.ingest(job.id);
      else if (h && historyError(h)) this.fail(job.id, historyError(h)!);
      else this.patch(job.id, { status: 'lost', error: 'This job was not found in ComfyUI any more (ComfyUI was probably restarted).', finished_at: Date.now() });
    }
  }

  private waiters = new Map<string, ((job: Job) => void)[]>();

  private patch(id: string, p: Partial<Job>): void {
    this.store.updateJob(id, p);
    const job = this.store.getJob(id);
    if (job) this.broadcast({ type: 'job', job: publicJob(job) });
    if (job && ['done', 'error', 'cancelled', 'lost'].includes(job.status)) {
      for (const w of this.waiters.get(id) ?? []) w(job);
      this.waiters.delete(id);
    }
  }

  /** Resolve when a job finishes (any terminal status) or after timeoutMs. */
  waitFor(id: string, timeoutMs = 10 * 60 * 1000): Promise<Job> {
    const now = this.store.getJob(id);
    if (now && ['done', 'error', 'cancelled', 'lost'].includes(now.status)) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('The model took too long to answer.')), timeoutMs);
      const list = this.waiters.get(id) ?? [];
      list.push((job) => {
        clearTimeout(t);
        resolve(job);
      });
      this.waiters.set(id, list);
    });
  }

  private fail(id: string, raw: string): void {
    this.patch(id, { status: 'error', error: friendlyError(raw), finished_at: Date.now() });
  }

  private onMessage(data: string | Uint8Array): void {
    const ev = parseWsMessage(data);
    if (ev.type === 'status') {
      this.broadcast({ type: 'queue', remaining: ev.queueRemaining });
      return;
    }
    if (ev.type === 'preview') {
      const now = Date.now();
      if (now - this.previewAt < 250) return;
      this.previewAt = now;
      const running = this.store.activeJobs().find((j) => j.status === 'running');
      if (running) this.broadcast({ type: 'preview', jobId: running.id, mime: ev.mime, data: Buffer.from(ev.image).toString('base64') });
      return;
    }
    if (!('promptId' in ev) || !ev.promptId) return;
    const job = this.store.jobByPrompt(ev.promptId);
    if (!job) return;
    switch (ev.type) {
      case 'execution_start':
        this.patch(job.id, { status: 'running', started_at: Date.now(), stage: 'Starting', progress: 0 });
        break;
      case 'executing':
        if (ev.node) {
          const node = (job.api_prompt as ApiPrompt)[ev.node];
          this.patch(job.id, { status: 'running', stage: stageName(node ? titleOf(node) : '', node?.class_type ?? '') });
        }
        break;
      case 'progress': {
        const node = (job.api_prompt as ApiPrompt)[ev.node];
        const samplers = samplerIds(job.api_prompt as ApiPrompt);
        const idx = Math.max(0, samplers.indexOf(ev.node));
        const frac = (idx + ev.value / Math.max(1, ev.max)) / Math.max(1, samplers.length || 1);
        // throttle DB writes: only broadcast, persist every ~10%
        const progress = Math.min(0.99, frac);
        if (Math.floor(progress * 10) !== Math.floor(job.progress * 10)) this.store.updateJob(job.id, { progress });
        this.broadcast({
          type: 'job',
          job: publicJob({ ...job, status: 'running', progress, stage: stageName(node ? titleOf(node) : '', node?.class_type ?? '') + ` ${ev.value}/${ev.max}` }),
        });
        break;
      }
      case 'execution_success':
        void this.ingest(job.id);
        break;
      case 'execution_error':
        this.fail(job.id, `${ev.nodeType}: ${ev.message}`);
        break;
      case 'execution_interrupted':
        this.patch(job.id, { status: 'cancelled', error: null, finished_at: Date.now() });
        break;
    }
  }

  async vramFreeGB(): Promise<number | null> {
    if (!this.comfy) return null;
    try {
      const s = await this.comfy.systemStats();
      return s.devices[0].vram_free / 1e9;
    } catch {
      return null;
    }
  }

  async submit(req: SubmitRequest): Promise<Job> {
    if (!this.comfy) throw new Error("ComfyUI isn't running. Start it from the status pill at the top.");
    const m = this.manifest();
    const spec = m.workflows[req.workflow];
    if (!spec) throw new Error(`Unknown workflow ${req.workflow}`);
    // An optional picture that has since disappeared from ComfyUI's input folder (e.g. a reference kept in the UI
    // across sessions) would fail the whole job at LoadImage; drop it and run without it, as One Node does for its
    // inpaint reference (Addendum 1 C). Required pictures still fail loudly.
    for (const [name, p] of Object.entries(spec.params)) {
      const v = req.params[name];
      if (p.type !== 'image' || !p.whenMissing || typeof v !== 'string' || !v) continue;
      if (!(await this.comfy.inputExists(v))) {
        req = { ...req, params: { ...req.params } };
        delete req.params[name];
        this.broadcast({ type: 'toast', kind: 'info', text: `The ${(p.label ?? name).toLowerCase()} picture is no longer available, so it was left out.` });
      }
    }
    const prompt = buildPrompt(this.template(spec.file), spec, req.params);
    // your own Klein 9B fine-tune (DECISIONS 91): only a file whose layers match Klein 9B replaces the graph's model
    const weights = typeof req.params.klein_weights === 'string' ? req.params.klein_weights : '';
    if (weights) {
      const nodeId = findByTitle(prompt, 'DR_MODEL')[0];
      const node = nodeId ? prompt[nodeId] : undefined;
      if (spec.family !== 'klein' || !node) throw new WorkflowError('A Klein 9B fine-tune can only be used with Klein 9B.');
      const ok = (await this.loraLibrary.finetunes(this.loraModels().klein)).some((f) => f.name === weights);
      if (!ok) throw new WorkflowError(`${weights} is not a Klein 9B model on this PC.`);
      node.inputs.unet_name = weights;
    }
    // your own LoRAs (DECISIONS 86): only ones made for this job's model, put on the graph's model
    const loras = parseLoras(req.params.loras);
    if (loras.length) {
      const family = spec.family === 'klein' ? 'klein' : spec.family.startsWith('qwen') ? 'qwen' : null;
      if (!family || !findByTitle(prompt, 'DR_MODEL').length) throw new WorkflowError('LoRAs can only be used with Klein 9B and Qwen-Image 2.1.');
      const fits = new Set((await this.loraLibrary.catalogue(this.loraModels()))[family].map((l) => l.name));
      const wrong = loras.filter((l) => !fits.has(l.name));
      if (wrong.length) throw new WorkflowError(`${wrong.map((l) => l.name).join(', ')} is not a ${family === 'klein' ? 'Klein 9B' : 'Qwen-Image 2.1'} LoRA.`);
      injectLoras(prompt, loras);
    }

    const active = this.store.activeJobs();
    const familyChanged = this.lastFamily !== null && this.lastFamily !== spec.family && !FREE_FAMILIES_IGNORED.has(spec.family);
    if (spec.kind === 'video' || familyChanged) {
      // Applied by ComfyUI between prompts, so it never interrupts a running job.
      await this.comfy.free(true, true);
    }
    if (spec.kind === 'video' && !req.force && active.length === 0) {
      await new Promise((r) => setTimeout(r, 1200));
      const free = await this.vramFreeGB();
      const need = (m as any).vramNeedGB?.[spec.family] ?? 8;
      if (free !== null && free < need) {
        throw new VramWarning(
          `Only ${free.toFixed(1)} GB of graphics memory is free and ${spec.label ?? 'this model'} needs about ${need} GB. Close other GPU apps (games, other ComfyUI windows, browsers with WebGPU) and try again, or queue anyway.`,
          free,
          need,
        );
      }
    }
    if (!FREE_FAMILIES_IGNORED.has(spec.family)) this.lastFamily = spec.family;

    const id = crypto.randomUUID();
    const job: Job = {
      id,
      prompt_id: null,
      workflow: req.workflow,
      kind: spec.kind,
      family: spec.family,
      status: 'queued',
      created_at: Date.now(),
      started_at: null,
      finished_at: null,
      progress: 0,
      stage: 'Waiting in queue',
      error: null,
      meta: req.meta,
      params: req.params as Record<string, unknown>,
      api_prompt: prompt,
      estimate_sec: req.meta.estimateSec ?? null,
      result_ids: [],
    };
    this.store.insertJob(job);
    try {
      const pngInfo = {
        darkroom: {
          app: 'Darkroom',
          workflow: req.workflow,
          mode: req.meta.mode,
          model: req.meta.model,
          prompt: req.meta.prompt,
          params: req.params,
          // the screen's own settings, so "Restore settings from image" works on a file outside the library
          ui: req.meta.ui ?? null,
          parent: req.meta.parentId ?? null,
          job: id,
        },
      };
      const promptId = await this.comfy.queuePrompt(prompt, CLIENT_ID, pngInfo, 'latent2rgb');
      this.patch(id, { prompt_id: promptId });
    } catch (e) {
      this.fail(id, (e as Error).message);
      throw new Error(friendlyError((e as Error).message));
    }
    return this.store.getJob(id)!;
  }

  async cancel(id: string): Promise<void> {
    const job = this.store.getJob(id);
    if (!job || !job.prompt_id || !this.comfy) return;
    if (job.status === 'running') await this.comfy.interrupt(job.prompt_id);
    else if (job.status === 'queued') {
      await this.comfy.deleteFromQueue([job.prompt_id]);
      this.patch(id, { status: 'cancelled', finished_at: Date.now() });
    }
  }

  /** Pull outputs of a finished job into the library. */
  async ingest(jobId: string): Promise<void> {
    const job = this.store.getJob(jobId);
    if (!job || !job.prompt_id || !this.comfy || job.status === 'done') return;
    const h = await this.comfy.history(job.prompt_id);
    if (!h) return;
    const err = historyError(h);
    if (err) return this.fail(jobId, err);
    const spec = this.manifest().workflows[job.workflow];
    if (spec.kind === 'mask') {
      const files = filesFromHistory(h, findByTitle(job.api_prompt as ApiPrompt, spec.outputs.mask ?? 'DR_OUTPUT')).map(ref);
      this.patch(jobId, { status: 'done', progress: 1, stage: 'Done', finished_at: Date.now(), meta: { ...job.meta, files } });
      return;
    }
    if (spec.kind === 'text') {
      const raw = textFromHistory(h, findByTitle(job.api_prompt as ApiPrompt, spec.outputs.text ?? 'DR_OUTPUT')).join('\n');
      // raw kept alongside: structured answers (PE-T2I JSON) must be parsed before any prose clean-up
      this.patch(jobId, { status: 'done', progress: 1, stage: 'Done', finished_at: Date.now(), meta: { ...job.meta, text: cleanVlmOutput(raw), raw } });
      // Auto-unload the VLM when nothing else is waiting, so the next image/video job gets the whole GPU.
      if (this.store.activeJobs().length === 0) void this.comfy.free(true, true).catch(() => undefined);
      return;
    }
    const prompt = job.api_prompt as ApiPrompt;
    const role = (r: string): OutputFile[] => {
      const t = spec.outputs[r];
      return t ? filesFromHistory(h, findByTitle(prompt, t)) : [];
    };
    const finished = Date.now();
    const renderMs = job.started_at ? finished - job.started_at : null;
    const parent = job.meta.parentId ? this.store.getItem(job.meta.parentId) : null;
    const rootId = parent ? (parent.root_id ?? parent.id) : null;
    const version = parent ? this.store.maxVersion(rootId!) + 1 : 1;
    const ids: string[] = [];
    const p = job.params as Record<string, any>;
    const base = {
      created_at: finished,
      mode: job.meta.mode,
      workflow: job.workflow,
      model: job.meta.model ?? '',
      family: job.family,
      prompt: job.meta.prompt ?? String(p.prompt ?? p.motion_prompt ?? ''),
      negative: job.meta.negative ?? String(p.negative ?? ''),
      seed: typeof p.seed === 'number' ? p.seed : null,
      params: job.params,
      ui: job.meta.ui ?? {},
      api_prompt: job.api_prompt,
      render_ms: renderMs,
      parent_id: parent?.id ?? null,
      root_id: rootId,
      favourite: false,
      tags: [] as string[],
      job_id: job.id,
      input_name: null,
      group_id: (job.meta.groupId as string | undefined) ?? (job.meta.layers ? job.id : null),
      // a new version stays in its picture's board; anything new goes to the board you are working in
      board_id: parent ? (parent.board_id ?? null) : this.liveBoard(job.meta.boardId),
    };
    if (spec.kind === 'video') {
      const vid = role('video')[0];
      if (!vid) return this.fail(jobId, 'ComfyUI finished but produced no video.');
      const poster = role('poster')[0] ?? null;
      const last = role('last')[0] ?? null;
      const fps = Number(p.fps) || null;
      const metaDur = typeof job.meta.durationSec === 'number' ? (job.meta.durationSec as number) : null;
      const frames = Number(p.frames) || (metaDur && fps ? Math.round(metaDur * fps) + 1 : null);
      const item: Item = {
        ...base,
        id: crypto.randomUUID(),
        kind: 'video',
        width: Number(p.width) || null,
        height: Number(p.height) || null,
        fps,
        frames,
        duration: fps && frames ? (frames - 1) / fps : null,
        file: ref(vid),
        poster: poster ? ref(poster) : null,
        last_frame: last ? ref(last) : null,
        version,
      };
      if (poster) {
        const meta = await this.makeThumb(item.id, poster).catch(() => null);
        if (meta) {
          item.width = meta.width;
          item.height = meta.height;
        }
      }
      this.store.insertItem(item);
      ids.push(item.id);
    } else {
      for (const f of role('image')) {
        const item: Item = {
          ...base,
          id: crypto.randomUUID(),
          kind: 'image',
          width: null,
          height: null,
          fps: null,
          frames: null,
          duration: null,
          file: ref(f),
          poster: null,
          last_frame: null,
          version,
        };
        const meta = await this.makeThumb(item.id, f).catch(() => null);
        if (meta) {
          item.width = meta.width;
          item.height = meta.height;
        }
        this.store.insertItem(item);
        ids.push(item.id);
      }
      if (!ids.length) return this.fail(jobId, 'ComfyUI finished but produced no image.');
    }
    const maskFiles = spec.outputs.mask ? filesFromHistory(h, findByTitle(prompt, spec.outputs.mask)).map(ref) : [];
    this.patch(jobId, {
      status: 'done',
      progress: 1,
      stage: 'Done',
      finished_at: finished,
      result_ids: ids,
      ...(maskFiles.length ? { meta: { ...job.meta, maskFiles } } : {}),
    });
    this.broadcast({ type: 'library', ids });
    void this.runChain(this.store.getJob(jobId)!, ids);
  }

  /** Upload a library item's file (or its poster / last frame) to ComfyUI's input folder. */
  async asInput(item: Item, which: 'main' | 'poster' | 'last' = 'main'): Promise<string> {
    if (!this.comfy) throw new Error("ComfyUI isn't running.");
    if (which === 'main' && item.input_name) return item.input_name;
    const f = which === 'poster' ? item.poster : which === 'last' ? item.last_frame : item.file;
    if (!f) throw new Error('That frame is not available for this item.');
    const bytes = await this.comfy.view(f);
    const up = await this.comfy.upload('image', new Blob([new Uint8Array(bytes)]), `lib_${item.id}_${which}${path.extname(f.filename)}`, {
      subfolder: 'darkroom',
      overwrite: true,
    });
    const name = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
    if (which === 'main') this.store.updateItem(item.id, { input_name: name });
    return name;
  }

  /** Follow-up work declared by a finished job (e.g. Extend = render continuation, then join). */
  private async runChain(job: Job, newIds: string[]): Promise<void> {
    const chain = job.meta.chain as { kind?: string; firstItemId?: string } | undefined;
    if (chain?.kind === 'plate') {
      // Background plate: Qwen-Image 2.1 inpaints the (dilated) subject mask on the ORIGINAL picture.
      const done = this.store.getJob(job.id);
      const mf = ((done?.meta.maskFiles as FileRef[] | undefined) ?? [])[0];
      const src = chain.firstItemId ? this.store.getItem(chain.firstItemId) : null;
      if (!mf || !src || !this.comfy) return;
      try {
        const bytes = await this.comfy.view(mf);
        const up = await this.comfy.upload('image', new Blob([new Uint8Array(bytes)]), `plate_mask_${job.id}.png`, { subfolder: 'darkroom', overwrite: true });
        const c = chain as Record<string, unknown>;
        await this.submit({
          workflow: 'qwen_inpaint',
          params: { image_1: await this.asInput(src), mask: up.subfolder ? `${up.subfolder}/${up.name}` : up.name, prompt: String(c.prompt ?? ''), seed: Math.floor(Math.random() * 2 ** 31), grow: 8 },
          meta: { mode: 'edit:plate', model: 'Qwen-Image 2.1 background plate', prompt: 'Background plate', parentId: src.id, ui: src.ui, groupId: (c.groupId as string | undefined) ?? (job.meta.layers ? job.id : undefined) },
        });
      } catch (e) {
        this.broadcast({ type: 'toast', kind: 'error', text: 'Could not make the background plate: ' + friendlyError((e as Error).message) });
      }
      return;
    }
    if (chain?.kind === 'upscale' && newIds[0]) {
      const it = this.store.getItem(newIds[0]);
      if (!it) return;
      // "to": bring the result to an exact size (a large photo restored at ~1 MP goes back to its own size, DECISIONS 79)
      const to = (chain as { to?: { w: number; h: number } }).to;
      const size = to && it.width && it.height ? backToSize({ w: it.width, h: it.height }, to) : null;
      try {
        await this.submit({
          workflow: 'upscale',
          params: { image_1: await this.asInput(it), scale: 2, seed: Math.floor(Math.random() * 2 ** 31), ...(size ?? {}) },
          meta: { mode: 'upscale', model: size ? `SeedVR2 7B → ${size.target_w}×${size.target_h}` : 'SeedVR2 7B', prompt: it.prompt, parentId: it.id, ui: it.ui, followOf: job.id },
        });
      } catch (e) {
        this.broadcast({ type: 'toast', kind: 'error', text: 'Could not start the upscale: ' + friendlyError((e as Error).message) });
      }
      return;
    }
    if (chain?.kind === 'enhance' && newIds[0]) {
      // SeedVR2 pre-upscale of a small picture finished; now the Klein / Qwen enhance pass runs on it.
      const it = this.store.getItem(newIds[0]);
      const c = chain as { workflow?: string; params?: Record<string, string | number>; meta?: Record<string, unknown> };
      if (!it || !c.workflow) return;
      try {
        await this.submit({
          workflow: c.workflow,
          params: { ...(c.params ?? {}), image_1: await this.asInput(it), seed: Math.floor(Math.random() * 2 ** 31) },
          meta: { mode: 'edit:enhance', ...(c.meta ?? {}), parentId: it.id, followOf: job.id },
        });
      } catch (e) {
        this.broadcast({ type: 'toast', kind: 'error', text: 'Could not start the enhance pass: ' + friendlyError((e as Error).message) });
      }
      return;
    }
    if (chain?.kind !== 'join' || !chain.firstItemId || !newIds[0]) return;
    const first = this.store.getItem(chain.firstItemId);
    const second = this.store.getItem(newIds[0]);
    if (!first || !second) return;
    try {
      const a = await this.asInput(first);
      const b = await this.asInput(second);
      await this.submit({
        workflow: 'video_join',
        params: { video: a, video_2: b, fps: first.fps ?? second.fps ?? 16 },
        meta: {
          mode: 'extend',
          model: first.model,
          prompt: first.prompt,
          parentId: first.id,
          ui: { ...(first.ui ?? {}), extendedFrom: first.id, continuation: second.id },
          durationSec: (first.duration ?? 0) + (second.duration ?? 0),
          notify: !!job.meta.notify,
        },
      });
    } catch (e) {
      this.broadcast({ type: 'toast', kind: 'error', text: 'Could not join the clips: ' + friendlyError((e as Error).message) });
    }
  }

  /** The board a new result should go to, if it (still) exists. */
  private liveBoard(id: unknown): string | null {
    return typeof id === 'string' && id && this.store.board(id) ? id : null;
  }

  thumbPath(id: string): string {
    return path.join(this.thumbsDir, `${id}.webp`);
  }

  async makeThumb(id: string, f: FileRef): Promise<{ width: number; height: number }> {
    const bytes = await this.comfy!.view(f);
    const img = sharp(bytes);
    const meta = await img.metadata();
    await img.resize(480, 480, { fit: 'inside' }).webp({ quality: 82 }).toFile(this.thumbPath(id));
    return { width: meta.width ?? 0, height: meta.height ?? 0 };
  }
}

function ref(f: OutputFile): FileRef {
  return { filename: f.filename, subfolder: f.subfolder, type: f.type };
}

function samplerIds(prompt: ApiPrompt): string[] {
  return Object.keys(prompt)
    .filter((id) => /KSampler|SamplerCustom|FrameInterpolate/.test(prompt[id].class_type))
    .sort((a, b) => Number(a) - Number(b));
}

function stageName(title: string, cls: string): string {
  if (/Loader|Load/.test(cls)) return 'Loading model';
  if (/TextEncode|CLIPText/.test(cls)) return 'Reading prompt';
  if (/Sampler/.test(cls)) return title === 'Low noise' ? 'Refining motion' : 'Rendering';
  if (/Decode/.test(cls)) return 'Decoding';
  if (/Interpolate/.test(cls)) return 'Smoothing';
  if (/Save/.test(cls)) return 'Saving';
  if (/Upscal|SeedVR2/.test(cls)) return 'Upscaling';
  if (/RemoveBackground/.test(cls)) return 'Cutting out';
  return 'Working';
}

/** Job without the (large) API prompt, for the browser. */
export function publicJob(j: Job) {
  const { api_prompt: _drop, ...rest } = j;
  return rest;
}
