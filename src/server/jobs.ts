import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { checkMatte } from '../shared/matte.js';
import { mp4Info } from './mp4info.js';
import { restoreJoinPrompt, type RestoreWindow } from '../shared/restore.js';
import { addKeyMoments, addSoundToPicture, type KeyMoment, type SoundSync } from '../shared/ltxguides.js';
import { endOf, type TimelineClip } from '../shared/timeline.js';
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
import { copyMeasure, looksCopied } from './copycheck.js';
import { ORBIT_LORA, orbitLabel, orbitPrompt, TURNAROUND, type OrbitMove } from '../shared/orbit.js';
import { outputDirFromArgv } from './trash.js';
import { applyShape, shapeSizes, SHAPES, type Shape } from '../shared/shape.js';

/** Qwen-Image 2.1 helper LoRAs (DECISIONS 119), found in the loras folder by name. */
const TURBO_LORA = /turbo8.*\.safetensors$/i;
const CONSISTENCY_LORA = /qwen-image-2\.1-consistency(?!-2000).*\.safetensors$/i;

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
    /** The new item's Library title, when Darkroom can name it (Timeline AI clips). */
    title?: string;
    /** A live frame or a control map: the files go on the job, never a Library item (v3.30). */
    preview?: boolean;
  };
  /** Proceed even if the VRAM check fails. */
  force?: boolean;
}

export type Broadcast = (msg: unknown) => void;

// One client id per library, kept across restarts: ComfyUI tells only the client that queued a prompt when it finishes,
// so a restarted Darkroom (a new id) would never hear about a render that was already running.
const clientIdFor = (dir: string) => 'darkroom-server-' + crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 8);
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
    return { klein: unet('klein_t2i'), qwen: unet('qwen_t2i'), ltx: unet('ltx25_i2v') };
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
    this.clientId = clientIdFor(thumbsDir);
    // safety net for a missed "finished" message: settle active jobs against ComfyUI's queue and history now and then
    setInterval(() => {
      if (this.connected && this.store.activeJobs().some((j) => j.prompt_id)) void this.resync();
    }, 30_000).unref();
    setInterval(() => void this.watchStalls(), 15_000).unref();
  }
  private clientId: string;
  /** When each running job last moved (a step, a node). */
  private lastActivity = new Map<string, number>();
  private stallWarned = new Set<string>();

  /**
   * A video that stops moving while the graphics card is full (DECISIONS 136): on Windows the NVIDIA driver then lends
   * the card normal RAM over PCIe ("sysmem fallback") — the GPU shows 100 % busy but a 1-minute render takes 5–15. Say
   * so once, with what helps, instead of a silent "Model Initializing".
   */
  private async watchStalls(): Promise<void> {
    const running = this.store.activeJobs().filter((j) => j.status === 'running' && j.kind === 'video' && !this.stallWarned.has(j.id));
    if (!running.length) return;
    const now = Date.now();
    const stuck = running.filter((j) => now - (this.lastActivity.get(j.id) ?? j.started_at ?? now) >= 90_000);
    if (!stuck.length) return;
    const free = await this.vramFreeGB();
    if (free === null || free >= 1) return;
    for (const j of stuck) {
      this.stallWarned.add(j.id);
      this.patch(j.id, { stage: 'Slow: graphics memory full' });
      this.broadcast({
        type: 'toast',
        kind: 'info',
        text: `The video render is running slowly: the graphics card is full (${free.toFixed(1)} GB free), so Windows is lending it normal memory, which is many times slower. It will finish, just later. Closing other apps that use the GPU (browsers, games, video calls) helps; the lasting fix is in Darkroom's README (Troubleshooting, "A video takes 5–15 minutes").`,
      });
    }
  }
  private ingesting = new Set<string>();

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
    const ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws?clientId=' + this.clientId);
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
        this.lastActivity.set(job.id, Date.now());
        this.patch(job.id, { status: 'running', started_at: Date.now(), stage: 'Starting', progress: 0 });
        break;
      case 'executing':
        this.lastActivity.set(job.id, Date.now());
        if (ev.node) {
          const node = (job.api_prompt as ApiPrompt)[ev.node];
          this.patch(job.id, { status: 'running', stage: stageName(node ? titleOf(node) : '', node?.class_type ?? '') });
        }
        break;
      case 'progress': {
        this.lastActivity.set(job.id, Date.now());
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
    let prompt = buildPrompt(this.template(spec.file), spec, req.params);
    // Restore (DECISIONS 100): the join is built for exactly the restored parts
    if (req.workflow === 'video_restore_join') {
      const parts = JSON.parse(String(req.params.parts ?? '[]')) as string[];
      const windows = JSON.parse(String(req.params.windows ?? '[]')) as RestoreWindow[];
      if (!parts.length || parts.length !== windows.length) throw new WorkflowError('The restored parts do not match their windows.');
      const silent = req.params.silent === true || req.params.silent === 1 || req.params.silent === 'true';
      prompt = restoreJoinPrompt({ source: String(req.params.video), parts, windows, sound: !silent, output: String(req.params.output ?? 'darkroom/video/restored') });
    }
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
    // Timeline AI tools (DECISIONS 104): key moments (more guide pictures), your sound to animate to, lip-sync boost
    if (spec.family === 'ltx') {
      const json = <T>(k: string): T | null => {
        const v = req.params[k];
        if (typeof v !== 'string' || !v) return null;
        try {
          return JSON.parse(v) as T;
        } catch {
          throw new WorkflowError(`${k} could not be read.`);
        }
      };
      const keys = json<KeyMoment[]>('key_moments');
      if (keys?.length) prompt = addKeyMoments(prompt, keys);
      const sound = json<SoundSync>('sound_sync');
      if (sound) {
        prompt = addSoundToPicture(prompt, sound);
        // Lightricks' audio-video guidance: one extra pass per step, so the mouth follows the words
        for (const [id, node] of Object.entries(prompt)) {
          if (node.class_type !== 'LTXVDualCFGGuider') continue;
          prompt[`${id}_sync`] = { class_type: 'LTXVModalityGuidance', inputs: { model: node.inputs.model, modality_scale: 3, start_percent: 0, end_percent: 1 }, _meta: { title: 'Lip-sync guidance' } };
          node.inputs.model = [`${id}_sync`, 0];
        }
      }
    }
    // Auto length (DECISIONS 100): LTX's duration head reads the prompt and picks the clip's length (2 s up to the
    // number of seconds given, on LTX's 8n+1 frame grid); the clip's real length is read from the file afterwards
    const autoMax = Number(req.params.auto_duration);
    if (spec.family === 'ltx' && autoMax > 0) {
      const [frames] = findByTitle(prompt, 'DR_FRAMES');
      const [model] = findByTitle(prompt, 'DR_MODEL');
      const [text] = findByTitle(prompt, 'DR_MOTION_PROMPT');
      const [fps] = findByTitle(prompt, 'DR_FPS');
      if (!frames || !model || !text || !fps) throw new WorkflowError('Auto length is not available for this kind of take.');
      prompt.auto_head = { class_type: 'ModelPatchLoader', inputs: { name: 'ltx-2.5-duration-head-bf16.safetensors' }, _meta: { title: 'Duration head' } };
      prompt.auto_len = {
        class_type: 'LTXVDurationPredictor',
        inputs: { model: [model, 0], positive: [text, 0], duration_head: ['auto_head', 0], frame_rate: [fps, 0], min_seconds: 2, max_seconds: Math.min(10, Math.max(2, autoMax)) },
        _meta: { title: 'Auto length' },
      };
      for (const node of Object.values(prompt))
        for (const [k, v] of Object.entries(node.inputs)) if (Array.isArray(v) && v[0] === frames && v[1] === 0) node.inputs[k] = ['auto_len', 0];
    }
    // Slow motion (DECISIONS 98): LTX is told the motion's frame rate (fps / speed) while the clip still plays at fps
    const speed = Number(req.params.motion_speed);
    if (spec.family === 'ltx' && speed > 0 && speed < 1) {
      for (const [id, node] of Object.entries(prompt)) {
        if (node.class_type !== 'LTXVConditioning') continue;
        const mathId = `${id}_motion_fps`;
        prompt[mathId] = { class_type: 'ComfyMathExpression', inputs: { expression: `a / ${speed}`, 'values.a': node.inputs.frame_rate }, _meta: { title: 'Motion fps' } };
        node.inputs.frame_rate = [mathId, 0];
      }
    }
    // Shape in Instruct (DECISIONS 117): the result in another shape — an empty canvas of that shape instead of the picture
    const shape = req.params.shape;
    if (typeof shape === 'string' && (SHAPES as readonly string[]).includes(shape) && !req.params.mask && (req.workflow === 'qwen_edit' || req.workflow === 'klein_edit')) {
      const parent = req.meta.parentId ? this.store.getItem(req.meta.parentId) : null;
      const { work, full } = shapeSizes(shape as Shape, parent?.width ?? 1024, parent?.height ?? 1024);
      if (!applyShape(prompt, req.workflow === 'qwen_edit' ? 'qwen' : 'klein', work, full)) throw new WorkflowError('This edit cannot change the shape.');
    }
    // Silent (DECISIONS 97): the clip is saved without its audio track
    if (req.params.silent === true || req.params.silent === 1 || req.params.silent === 'true') {
      for (const node of Object.values(prompt)) if (node.class_type === 'CreateVideo') delete node.inputs.audio;
    }
    // H.264 at CRF 18 (DECISIONS 102): ComfyUI 0.38 encodes at the x264 default of 23; 18 keeps the fine detail
    // (ComfyUI's own default from the next release), which matters most where a clip is encoded again (Restore, Extend)
    for (const node of Object.values(prompt))
      if (node.class_type === 'SaveVideo' && node.inputs['format.codec'] === 'h264' && !node.inputs['format.codec.encoding'])
        Object.assign(node.inputs, { 'format.codec.encoding': 're-encode', 'format.codec.encoding.crf': 18 });
    // your own LoRAs (DECISIONS 86): only ones made for this job's model, put on the graph's model
    const loras = parseLoras(req.params.loras);
    // Qwen helpers Darkroom adds itself (DECISIONS 119): Turbo8 for Fast (8 steps), and the Consistency LoRA on a
    // whole-picture instruction so it stays on the picture's frame (not for Turn it or a new shape, which move it)
    if (spec.family.startsWith('qwen') && (req.workflow === 'qwen_edit' || req.workflow === 'qwen_t2i' || req.workflow === 'qwen_ref')) {
      const have = (await this.loraLibrary.catalogue(this.loraModels())).qwen.map((l) => l.name);
      const add = (re: RegExp) => {
        const name = have.find((n) => re.test(n));
        if (name && !loras.some((l) => l.name === name)) loras.push({ name, strength: 1 });
        return !!name;
      };
      const on = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';
      if (on(req.params.fast)) {
        if (!add(TURBO_LORA)) throw new WorkflowError('Fast needs the Turbo8 LoRA for Qwen-Image 2.1 in your ComfyUI loras folder.');
        for (const id of findByTitle(prompt, 'DR_SAMPLER')) prompt[id].inputs.steps = 8;
      }
      const wholePicture = req.workflow === 'qwen_edit' && req.meta.mode === 'edit:instruct' && !req.params.mask && !req.params.shape;
      if (wholePicture && req.params.keep_frame !== 0 && req.params.keep_frame !== '0') add(CONSISTENCY_LORA);
    }
    if (loras.length) {
      const family = spec.family === 'klein' ? 'klein' : spec.family.startsWith('qwen') ? 'qwen' : spec.family === 'ltx' ? 'ltx' : null;
      if (!family || !findByTitle(prompt, 'DR_MODEL').length) throw new WorkflowError('LoRAs can only be used with Klein 9B, Qwen-Image 2.1 and LTX 2.5.');
      const fits = new Set((await this.loraLibrary.catalogue(this.loraModels()))[family].map((l) => l.name));
      const wrong = loras.filter((l) => !fits.has(l.name));
      if (wrong.length) throw new WorkflowError(`${wrong.map((l) => l.name).join(', ')} is not a ${({ klein: 'Klein 9B', qwen: 'Qwen-Image 2.1', ltx: 'LTX 2.5' } as const)[family]} LoRA.`);
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
      const promptId = await this.comfy.queuePrompt(prompt, this.clientId, pngInfo, 'latent2rgb');
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

  /** Pull outputs of a finished job into the library (once, even when the message and a resync both see it). */
  async ingest(jobId: string): Promise<void> {
    if (this.ingesting.has(jobId)) return;
    this.ingesting.add(jobId);
    try {
      await this.ingestNow(jobId);
    } finally {
      this.ingesting.delete(jobId);
    }
  }

  private async ingestNow(jobId: string): Promise<void> {
    const job = this.store.getJob(jobId);
    if (!job || !job.prompt_id || !this.comfy || job.status === 'done') return;
    const h = await this.comfy.history(job.prompt_id);
    if (!h) return;
    const err = historyError(h);
    if (err) return this.fail(jobId, err);
    const spec = this.manifest().workflows[job.workflow];
    if (job.meta.preview) {
      // a live-painting frame (v3.30): shown in Edit, never a Library item
      const files = filesFromHistory(h, findByTitle(job.api_prompt as ApiPrompt, spec.outputs.image ?? 'DR_OUTPUT')).map(ref);
      this.patch(jobId, { status: 'done', progress: 1, stage: 'Done', finished_at: Date.now(), meta: { ...job.meta, files } });
      return;
    }
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
      ...(typeof job.meta.title === 'string' ? { title: job.meta.title } : {}),
      group_id: (job.meta.groupId as string | undefined) ?? (job.meta.layers ? job.id : null),
      // a new version stays in its picture's board; anything new goes to the board you are working in
      board_id: parent ? (parent.board_id ?? null) : this.liveBoard(job.meta.boardId),
    };
    if (spec.kind === 'video') {
      const vid = role('video')[0];
      if (!vid) return this.fail(jobId, 'ComfyUI finished but produced no video.');
      const poster = role('poster')[0] ?? null;
      const last = role('last')[0] ?? null;
      const fps = Number(p.fps) || parent?.fps || null;
      const metaDur = typeof job.meta.durationSec === 'number' ? (job.meta.durationSec as number) : (parent?.duration ?? null);
      const frames = Number(p.frames) || (metaDur && fps ? Math.round(metaDur * fps) + 1 : null);
      const item: Item = {
        ...base,
        id: crypto.randomUUID(),
        kind: 'video',
        width: Number(p.width) || parent?.width || null,
        height: Number(p.height) || parent?.height || null,
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
      if (/\.(mp4|mov|m4v)$/i.test(vid.filename)) {
        const real = await this.comfy!.view(ref(vid)).then((b) => mp4Info(Buffer.from(b))).catch(() => null);
        if (real?.frames && real.fps) Object.assign(item, { fps: real.fps, frames: real.frames, duration: (real.frames - 1) / real.fps });
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
    // Qwen Instruct sometimes returns its input with a grain added for a given seed (DECISIONS 107): say so
    let copied: { low: number; grain: number } | null = null;
    if (job.workflow === 'qwen_edit' && job.meta.mode === 'edit:instruct' && !p.mask && parent?.kind === 'image' && ids.length) {
      const out = this.store.getItem(ids[0])!;
      const m = await Promise.all([this.comfy.view(parent.file), this.comfy.view(out.file)])
        .then(([a, b]) => copyMeasure(Buffer.from(a), Buffer.from(b)))
        .catch(() => null);
      if (m && looksCopied(m)) copied = { low: Math.round(m.low * 10) / 10, grain: Math.round(m.grain * 100) / 100 };
    }
    this.patch(jobId, {
      status: 'done',
      progress: 1,
      stage: 'Done',
      finished_at: finished,
      result_ids: ids,
      ...(maskFiles.length || copied ? { meta: { ...job.meta, ...(maskFiles.length ? { maskFiles } : {}), ...(copied ? { copied } : {}) } } : {}),
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
    // Turn it (DECISIONS 114): a picture with a background was cut out first; now turn the cut-out
    if (chain?.kind === 'turn_pre' && newIds[0]) {
      const c = chain as Record<string, any>;
      const cut = this.store.getItem(newIds[0]);
      if (cut) await this.turn(cut, c.move as OrbitMove, { turnaround: c.turnaround, view: c.view, sourceId: c.sourceId, followOf: job.id }).catch((e) => this.broadcast({ type: 'toast', kind: 'error', text: 'Turn it: ' + friendlyError((e as Error).message) }));
      return;
    }
    if (chain?.kind === 'sheet') {
      const c = chain as Record<string, any>;
      return void this.trySheet(String(c.sheet), Number(c.total), String(c.sourceId), String(c.name)).catch((e) => this.broadcast({ type: 'toast', kind: 'error', text: 'Sheet: ' + (e as Error).message }));
    }
    if (chain?.kind === 'turn_cut') {
      const c = chain as Record<string, any>;
      return void this.tryTurnaround(String(c.turnaround), String(c.sourceId)).catch((e) => this.broadcast({ type: 'toast', kind: 'error', text: 'Turnaround sheet: ' + (e as Error).message }));
    }
    if (chain?.kind === 'turn' && newIds[0]) {
      const c = chain as Record<string, any>;
      // the LoRA sometimes paints the background white: cut the new view out again so it stays a cut-out
      const it = this.store.getItem(newIds[0]);
      const clear = it ? await this.hasAlpha(it.file).catch(() => true) : true;
      if (c.turnaround) {
        if (it && !clear) {
          // a turnaround view waits for its clean cut-out; the sheet is made when every view has one (DECISIONS 115)
          this.store.setItemUi(it.id, { needsCut: true });
          await this.submit({
            workflow: 'qwen_remove_bg',
            params: { image_1: await this.asInput(it), seed: Math.floor(Math.random() * 2 ** 31) },
            meta: { mode: 'edit:remove_bg', model: 'Qwen-Image 2.1 extraction', prompt: it.prompt, parentId: it.id, ui: { ...(it.ui ?? {}), cutOf: it.id }, ...(it.title ? { title: it.title } : {}), chain: { kind: 'turn_cut', turnaround: c.turnaround, sourceId: c.sourceId } },
          }).catch(() => this.store.setItemUi(it.id, { needsCut: false }));
          return;
        }
        return void this.tryTurnaround(String(c.turnaround), String(c.sourceId)).catch((e) => this.broadcast({ type: 'toast', kind: 'error', text: 'Turnaround sheet: ' + (e as Error).message }));
      }
      if (it && !clear)
        await this.submit({
          workflow: 'qwen_remove_bg',
          params: { image_1: await this.asInput(it), seed: Math.floor(Math.random() * 2 ** 31) },
          meta: { mode: 'edit:remove_bg', model: 'Qwen-Image 2.1 extraction', prompt: it.prompt, parentId: it.id, ui: it.ui, followOf: job.id, ...(it.title ? { title: it.title } : {}) },
        }).catch(() => undefined);
      return;
    }
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
    // Cut out (DECISIONS 99): the matte is done; put the take over the chosen background with it
    if (chain?.kind === 'composite' && newIds[0] && chain.firstItemId) {
      const take = this.store.getItem(chain.firstItemId);
      const matte = this.store.getItem(newIds[0]);
      const c = chain as Record<string, unknown>;
      const background = String(c.background ?? '');
      if (!take || !matte || !background || !this.comfy) return;
      // some seeds give a grey matte (the picture's shading bleeding in): check its first and last frames, and make
      // it again with another seed (twice at most) rather than turning the subject into a see-through ghost
      try {
        const checks = await Promise.all(
          [matte.poster, matte.last_frame].filter((f): f is FileRef => !!f).map(async (f) => checkMatte(new Uint8Array(await sharp(Buffer.from(await this.comfy!.view(f))).greyscale().raw().toBuffer()))),
        );
        const attempt = Number(c.attempt ?? 0);
        if (checks.length && checks.every((x) => x.foreground < 0.005)) {
          this.broadcast({ type: 'toast', kind: 'error', text: 'Cut out: Alpha-Gen found no clear subject in this take (wide scenes and crowds often have none). The matte is in the Library.' });
          return;
        }
        if (checks.some((x) => !x.ok) && attempt < 2) {
          this.store.softDelete([matte.id]);
          this.broadcast({ type: 'library' });
          this.broadcast({ type: 'toast', kind: 'info', text: `Cut out: the matte came out unsure (grey), so Darkroom is making it again${attempt ? ' once more' : ''}.` });
          await this.submit({ workflow: job.workflow, params: { ...job.params, seed: Math.floor(Math.random() * 2 ** 31) } as Record<string, string | number>, meta: { ...(job.meta as { mode: string }), chain: { ...c, attempt: attempt + 1 } } });
          return;
        }
      } catch (e) {
        // the check is a safeguard: if it cannot run, carry on with the matte as it is
        this.broadcast({ type: 'toast', kind: 'info', text: 'Cut out: could not check the matte (' + friendlyError((e as Error).message) + '); using it as it is.' });
      }
      try {
        await this.submit({
          workflow: 'video_composite',
          params: { video: await this.asInput(take), video_2: await this.asInput(matte), image_1: background },
          meta: { mode: 'cutout', model: `${take.model} · cut out`, prompt: take.prompt, parentId: take.id, ui: take.ui, durationSec: take.duration ?? undefined, notify: !!job.meta.notify, followOf: job.id },
        });
      } catch (e) {
        this.broadcast({ type: 'toast', kind: 'error', text: 'Could not put the cut-out on its background: ' + friendlyError((e as Error).message) });
      }
      return;
    }
    // Restore (DECISIONS 100): the next window, guided by this one's last 17 restored frames; after the last, the join
    if (chain?.kind === 'restore' && newIds[0] && chain.firstItemId) {
      const c = chain as { kind: string; firstItemId: string; windows: RestoreWindow[]; index?: number; parts?: string[]; partJobs?: string[] };
      const src = this.store.getItem(c.firstItemId);
      const part = this.store.getItem(newIds[0]);
      if (!src || !part || !this.comfy) return;
      const parts = [...(c.parts ?? []), part.id];
      const partJobs = [...(c.partJobs ?? []), job.id];
      const next = (c.index ?? 0) + 1;
      try {
        if (next < c.windows.length) {
          const w = c.windows[next];
          await this.submit({
            workflow: job.workflow,
            params: { ...(job.params as Record<string, string | number>), prev: await this.asInput(part), start: w.start, length: w.length },
            meta: { ...(job.meta as { mode: string }), model: `LTX 2.5 · Restore, part ${next + 1} of ${c.windows.length}`, followOf: job.id, chain: { ...c, index: next, parts, partJobs } },
          });
        } else {
          const items = parts.map((id) => this.store.getItem(id)).filter((x): x is Item => !!x);
          const sound = await this.comfy.view(src.file).then((b) => mp4Info(Buffer.from(b)).hasAudio).catch(() => false);
          await this.submit({
            workflow: 'video_restore_join',
            params: { video: await this.asInput(src), parts: JSON.stringify(await Promise.all(items.map((it) => this.asInput(it)))), windows: JSON.stringify(c.windows), ...(sound ? {} : { silent: 1 }) },
            meta: {
              mode: 'restore',
              model: 'LTX 2.5 · Restore',
              prompt: src.prompt,
              parentId: src.id,
              ui: { ...(src.ui ?? {}), sound: sound ? 'scene' : 'off' },
              notify: !!job.meta.notify,
              followOf: job.id,
              chain: { kind: 'restore_done', parts, partJobs },
            },
          });
        }
      } catch (e) {
        this.broadcast({ type: 'toast', kind: 'error', text: 'Restore stopped: ' + friendlyError((e as Error).message) + ' The restored parts are in Recently deleted.' });
        this.store.softDelete(parts);
        this.broadcast({ type: 'library' });
      }
      return;
    }
    // Timeline AI tools (DECISIONS 104): the new clip takes its placeholder's place on the film
    if (chain?.kind === 'timeline' && newIds[0]) {
      const c = chain as { timelineId?: string; pendingId?: string; start?: number; seconds?: number; muted?: boolean };
      const t = c.timelineId ? this.store.timeline(c.timelineId) : null;
      const it = this.store.getItem(newIds[0]);
      // a placeholder you removed while it rendered: the clip stays in the Library only
      if (!t || !it || !(t.doc.pending ?? []).some((p) => p.id === c.pendingId)) return;
      const clip: TimelineClip = { id: `g${(c.pendingId ?? '').slice(0, 10)}`, itemId: it.id, start: c.start ?? 0, in: 0, out: Math.round(Math.min(it.duration ?? c.seconds ?? 1, c.seconds ?? Infinity) * 1000) / 1000, ...(c.muted ? { muted: true } : {}) };
      const doc = { ...t.doc, clips: [...t.doc.clips, clip], pending: (t.doc.pending ?? []).filter((p) => p.id !== c.pendingId) };
      if (!doc.pending.length) delete (doc as { pending?: unknown }).pending;
      this.store.saveTimeline(t.id, t.name, doc);
      this.broadcast({ type: 'timeline', id: t.id, doc, added: clip.id, end: endOf(clip) });
      return;
    }
    // the restored clip is joined: its parts go to Recently deleted and their takes are put away
    if (chain?.kind === 'restore_done' && newIds[0]) {
      const c = chain as { parts?: string[]; partJobs?: string[] };
      this.store.softDelete(c.parts ?? []);
      this.store.dismissJobs(c.partJobs ?? []);
      this.broadcast({ type: 'library' });
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
      // both clips have sound (LTX, not silent): join the sound too (DECISIONS 97); otherwise frames only
      const sounded = (it: Item) => (it.ui as Record<string, unknown>)?.model !== 'wan' && (it.ui as Record<string, unknown>)?.sound !== 'off' && !it.workflow.startsWith('wan');
      await this.submit({
        workflow: sounded(first) && sounded(second) ? 'video_join_audio' : 'video_join',
        params: { video: a, video_2: b, fps: first.fps ?? second.fps ?? 24 },
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

  /**
   * Your own video into the Library (DECISIONS 100). The uploaded file is the item's file (in ComfyUI's input
   * folder); the browser supplies its first and last frames (poster, Extend); size, frame rate, frames and length come
   * from the file's MP4 header when it has one, else from the browser.
   */
  async importVideo(a: { video: string; poster: string; last: string; name: string; boardId?: unknown; width?: number; height?: number; duration?: number }): Promise<Item> {
    const input = (n: string): FileRef => {
      const i = n.lastIndexOf('/');
      return { filename: n.slice(i + 1), subfolder: i >= 0 ? n.slice(0, i) : '', type: 'input' };
    };
    return this.addVideo({
      file: input(a.video),
      poster: input(a.poster),
      last: input(a.last),
      name: a.name,
      mode: 'import',
      workflow: 'import_video',
      model: 'Imported',
      ui: { model: 'imported' },
      params: { video: a.video },
      inputName: a.video,
      boardId: a.boardId,
      width: a.width,
      height: a.height,
      duration: a.duration,
    });
  }

  /**
   * A finished video file into the Library: imports and Timeline films. Size, frame rate, frames, length and whether
   * it has sound come from the file's MP4 header when it has one, else from what the caller knows.
   */
  async addVideo(a: {
    file: FileRef;
    poster: FileRef;
    last: FileRef;
    name: string;
    mode: string;
    workflow: string;
    model: string;
    ui: Record<string, unknown>;
    params: Record<string, unknown>;
    inputName?: string | null;
    boardId?: unknown;
    width?: number;
    height?: number;
    duration?: number;
  }): Promise<Item> {
    if (!this.comfy) throw new Error("ComfyUI isn't running.");
    const real = await this.comfy.view(a.file).then((b) => mp4Info(Buffer.from(b))).catch(() => null);
    const fps = real?.fps ?? null;
    const frames = real?.frames ?? null;
    const item: Item = {
      id: crypto.randomUUID(),
      created_at: Date.now(),
      kind: 'video',
      mode: a.mode,
      workflow: a.workflow,
      model: a.model,
      family: 'util',
      prompt: a.name.slice(0, 200),
      negative: '',
      seed: null,
      width: real?.width ?? a.width ?? null,
      height: real?.height ?? a.height ?? null,
      duration: frames && fps ? (frames - 1) / fps : (a.duration ?? null),
      fps,
      frames,
      params: a.params,
      ui: { ...a.ui, sound: real && !real.hasAudio ? 'off' : 'scene' },
      api_prompt: null,
      file: a.file,
      poster: a.poster,
      last_frame: a.last,
      render_ms: null,
      parent_id: null,
      root_id: null,
      version: 1,
      favourite: false,
      tags: [],
      job_id: null,
      input_name: a.inputName ?? null,
      board_id: this.liveBoard(a.boardId),
    };
    await this.makeThumb(item.id, item.poster!).catch(() => null);
    this.store.insertItem(item);
    this.broadcast({ type: 'library' });
    return item;
  }

  /** A finished picture file into the Library (P3 compare sheets). */
  /** Does this picture have see-through pixels? */
  async hasAlpha(f: FileRef): Promise<boolean> {
    const st = await sharp(Buffer.from(await this.comfy!.view(f))).stats();
    return st.channels.length >= 4 && st.channels[3].min < 250;
  }

  /**
   * Turn it (DECISIONS 114): the same object seen from another angle, by Qwen-Image 2.1 with the viewpoint-orbit LoRA.
   * The LoRA works on cut-outs, so a picture with a background is cut out first (one more job, a few seconds).
   */
  async turn(src: Item, move: OrbitMove, o: { turnaround?: string; view?: number; sourceId?: string; followOf?: string } = {}): Promise<Job> {
    const lora = (await this.loraLibrary.catalogue(this.loraModels())).qwen.find((l) => ORBIT_LORA.test(l.name));
    if (!lora) throw new WorkflowError('Turn it needs the Qwen-Image 2.1 viewpoint-orbit LoRA in your ComfyUI loras folder.');
    const prompt = orbitPrompt(move);
    const label = orbitLabel(move);
    const ui = { ...(src.ui ?? {}), ...(o.turnaround ? { turnaround: o.turnaround, view: o.view } : {}) };
    if (!(await this.hasAlpha(src.file).catch(() => false)))
      return this.submit({
        workflow: 'qwen_remove_bg',
        params: { image_1: await this.asInput(src), seed: Math.floor(Math.random() * 2 ** 31) },
        meta: { mode: 'edit:remove_bg', model: 'Qwen-Image 2.1 extraction', prompt: src.prompt, parentId: src.id, ui: src.ui, ...(src.title ? { title: `${src.title} · cut-out` } : {}), ...(o.followOf ? { followOf: o.followOf } : {}), chain: { kind: 'turn_pre', move, turnaround: o.turnaround, view: o.view, sourceId: o.sourceId ?? src.id } },
      });
    // named after the picture: the cut-out's title, else the picture it was cut from
    const base = (src.title || (o.sourceId ? this.store.getItem(o.sourceId)?.title : '') || '').replace(/ · cut-out$/, '');
    return this.submit({
      workflow: 'qwen_edit',
      params: { image_1: await this.asInput(src), prompt, seed: Math.floor(Math.random() * 2 ** 31), loras: JSON.stringify([{ name: lora.name, strength: 1 }]) },
      meta: {
        mode: 'edit:turn',
        model: 'Qwen-Image 2.1 · Turn it',
        prompt: label,
        parentId: src.id,
        ui,
        ...(base ? { title: `${base} · ${label.toLowerCase()}` } : {}),
        ...(o.followOf ? { followOf: o.followOf } : {}),
        chain: { kind: 'turn', move, turnaround: o.turnaround, view: o.view, sourceId: o.sourceId ?? src.id },
      },
    });
  }

  /**
   * Sheet maker (DECISIONS 118): one instruction run per value ("black and volt", "navy and red"…), each its own picture,
   * then one grid with the values typed underneath — the models miscount grids and garble labels when asked for a sheet.
   */
  async sheet(src: Item, o: { workflow: string; model: 'klein' | 'qwen'; prompts: string[]; labels: string[]; seed: number; name: string; extra?: Record<string, string> }): Promise<Job[]> {
    const g = crypto.randomUUID();
    const base = (src.title || 'Picture').replace(/ · cut-out$/, '');
    const inp = await this.asInput(src);
    const out: Job[] = [];
    for (const [i, prompt] of o.prompts.entries())
      out.push(
        await this.submit({
          workflow: o.workflow,
          params: { image_1: inp, prompt, seed: o.seed, ...(o.extra ?? {}) },
          meta: {
            mode: 'edit:instruct',
            model: o.model === 'klein' ? 'Klein 9B edit' : 'Qwen-Image 2.1 edit',
            prompt: o.labels[i],
            parentId: src.id,
            ui: { ...(src.ui ?? {}), sheet: g, sheetIndex: i, sheetLabel: o.labels[i] },
            title: `${base} · ${o.labels[i]}`.slice(0, 120),
            chain: { kind: 'sheet', sheet: g, total: o.prompts.length, sourceId: src.id, name: o.name },
          },
        }),
      );
    return out;
  }

  private async trySheet(g: string, total: number, sourceId: string, name: string): Promise<void> {
    const all = this.store.itemsBySheet(g);
    if (all.some((v) => v.mode === 'sheet')) return;
    const pics = all.filter((v) => v.mode === 'edit:instruct').sort((a, b) => Number((a.ui as any)?.sheetIndex) - Number((b.ui as any)?.sheetIndex));
    if (pics.length < total || !this.comfy) return;
    const src = this.store.getItem(sourceId);
    const cols = total <= 3 ? total : total === 4 ? 2 : 3;
    const rows = Math.ceil(total / cols);
    const H = 640;
    const imgs = await Promise.all(pics.map(async (it) => sharp(Buffer.from(await this.comfy!.view(it.file))).flatten({ background: '#ffffff' }).resize({ height: H }).png().toBuffer({ resolveWithObject: true })));
    const cw = Math.max(...imgs.map((x) => x.info.width));
    const gap = 24;
    const label = 52;
    const top = 72;
    const W = cols * cw + (cols + 1) * gap;
    const Ht = top + rows * (H + label + gap) + gap;
    const esc = (t: string) => t.replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch]!);
    const base = (src?.title || 'Picture').replace(/ · cut-out$/, '');
    const texts = [`<text x="${gap}" y="46" font-family="Segoe UI, Arial" font-size="30" font-weight="600" fill="#1c1917">${esc(`${base} · ${name}`)}</text>`];
    const parts: OverlayOptions[] = [];
    for (const [i, im] of imgs.entries()) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const x = gap + c * (cw + gap) + Math.round((cw - im.info.width) / 2);
      const y = top + r * (H + label + gap);
      parts.push({ input: im.data, left: x, top: y });
      texts.push(`<text x="${gap + c * (cw + gap) + cw / 2}" y="${y + H + 34}" text-anchor="middle" font-family="Segoe UI, Arial" font-size="24" fill="#3a332e">${esc(String((pics[i].ui as any)?.sheetLabel ?? ''))}</text>`);
    }
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Ht}">${texts.join('')}</svg>`);
    const sheetPng = await sharp({ create: { width: W, height: Ht, channels: 3, background: '#ffffff' } }).composite([...parts, { input: svg, left: 0, top: 0 }]).png().toBuffer();
    const outDir = outputDirFromArgv(((await this.comfy.systemStats()) as { system?: { argv?: string[] } }).system?.argv);
    if (!outDir) throw new Error("ComfyUI doesn't report its output folder.");
    const file = `sheet_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}.png`;
    fs.mkdirSync(path.join(outDir, 'darkroom', 'sheet'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'darkroom', 'sheet', file), sheetPng);
    const title = `${base} · ${name}`;
    const item = await this.addPicture({ file: { filename: file, subfolder: 'darkroom/sheet', type: 'output' }, name: title, title, mode: 'sheet', model: 'Sheet', params: { sheet: g, views: pics.map((p) => p.id), labels: pics.map((p) => (p.ui as any)?.sheetLabel) }, boardId: src?.board_id ?? pics[0].board_id });
    this.store.setItemUi(item.id, { sheet: g });
    this.broadcast({ type: 'library', ids: [item.id] });
    this.broadcast({ type: 'toast', kind: 'ok', text: `Sheet ready: "${title}" is in your Library, with each picture on its own.` });
  }

  /** Turnaround: three turns of one picture; when all three are in, one sheet of the four sides. */
  async turnaround(src: Item): Promise<Job[]> {
    const g = crypto.randomUUID();
    const out: Job[] = [];
    for (const [i, m] of TURNAROUND.entries()) out.push(await this.turn(src, m, { turnaround: g, view: i + 1, sourceId: src.id }));
    return out;
  }

  private async tryTurnaround(g: string, sourceId: string): Promise<void> {
    const all = this.store.itemsByTurnaround(g);
    if (all.some((v) => v.mode === 'sheet')) return;
    // one final picture per view: its clean cut-out when it needed one, else the turned view itself
    const views: Item[] = [];
    for (let v = 1; v <= TURNAROUND.length; v++) {
      const turned = all.find((x) => x.mode === 'edit:turn' && Number((x.ui as any)?.view) === v);
      const cut = all.find((x) => x.mode === 'edit:remove_bg' && Number((x.ui as any)?.view) === v);
      const done = cut ?? (turned && !(turned.ui as any)?.needsCut ? turned : null);
      if (!done) return;
      views.push(done);
    }
    const src = this.store.getItem(sourceId);
    // the sheet starts with the cut-out the turns were made from (the source itself, or the cut-out made first)
    const firstTurn = all.find((x) => x.mode === 'edit:turn');
    const first = this.store.getItem(firstTurn?.parent_id ?? sourceId) ?? src;
    if (!first || !this.comfy) return;
    const ordered = [first, ...views];
    const labels = ['As made', ...TURNAROUND.map(orbitLabel)];
    const H = 768;
    const pics = await Promise.all(ordered.map(async (it) => sharp(Buffer.from(await this.comfy!.view(it.file))).flatten({ background: '#ffffff' }).resize({ height: H }).png().toBuffer({ resolveWithObject: true })));
    const gap = 24;
    const bar = 56;
    const W = pics.reduce((w, p) => w + p.info.width, 0) + gap * (pics.length + 1);
    let x = gap;
    const parts: OverlayOptions[] = [];
    const texts: string[] = [];
    for (const [i, p] of pics.entries()) {
      parts.push({ input: p.data, left: x, top: bar });
      texts.push(`<text x="${x}" y="36" font-family="Segoe UI, Arial" font-size="24" fill="#3a332e">${labels[i]}</text>`);
      x += p.info.width + gap;
    }
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${bar}">${texts.join('')}</svg>`);
    const sheet = await sharp({ create: { width: W, height: H + bar + gap, channels: 3, background: '#ffffff' } }).composite([{ input: svg, left: 0, top: 0 }, ...parts]).png().toBuffer();
    const outDir = outputDirFromArgv(((await this.comfy.systemStats()) as { system?: { argv?: string[] } }).system?.argv);
    if (!outDir) throw new Error("ComfyUI doesn't report its output folder.");
    const name = `turnaround_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}.png`;
    fs.mkdirSync(path.join(outDir, 'darkroom', 'sheet'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'darkroom', 'sheet', name), sheet);
    const base = (src?.title || first.title || 'Picture').replace(/ · cut-out$/, '');
    const item = await this.addPicture({ file: { filename: name, subfolder: 'darkroom/sheet', type: 'output' }, name: `${base} · turnaround`, title: `${base} · turnaround`, mode: 'sheet', model: 'Turnaround', params: { turnaround: g, views: ordered.map((v) => v.id) }, boardId: src?.board_id ?? first.board_id });
    this.store.setItemUi(item.id, { turnaround: g });
    this.broadcast({ type: 'library', ids: [item.id] });
    this.broadcast({ type: 'toast', kind: 'ok', text: `Turnaround ready: "${base} · turnaround" is in your Library, with the three new views.` });
  }

  async addPicture(a: { file: FileRef; name: string; title?: string; mode: string; model: string; params: Record<string, unknown>; boardId?: unknown; parentId?: string; ui?: Record<string, unknown> }): Promise<Item> {
    // a new version of a picture (Edit canvas "Flatten to version", DECISIONS 122) joins its lineage and board
    const parent = a.parentId ? this.store.getItem(a.parentId) : null;
    const rootId = parent ? (parent.root_id ?? parent.id) : null;
    const item: Item = {
      id: crypto.randomUUID(),
      created_at: Date.now(),
      kind: 'image',
      mode: a.mode,
      workflow: a.mode,
      model: a.model,
      family: 'util',
      prompt: a.name.slice(0, 300),
      negative: '',
      seed: null,
      width: null,
      height: null,
      duration: null,
      fps: null,
      frames: null,
      params: a.params,
      ui: a.ui ?? {},
      api_prompt: null,
      file: a.file,
      poster: null,
      last_frame: null,
      render_ms: null,
      parent_id: parent?.id ?? null,
      root_id: rootId,
      version: parent ? this.store.maxVersion(rootId!) + 1 : 1,
      favourite: false,
      tags: [],
      job_id: null,
      input_name: null,
      board_id: parent ? (parent.board_id ?? null) : this.liveBoard(a.boardId),
      title: a.title ?? null,
    };
    const meta = await this.makeThumb(item.id, a.file).catch(() => null);
    if (meta) Object.assign(item, { width: meta.width, height: meta.height });
    this.store.insertItem(item);
    this.broadcast({ type: 'library' });
    return item;
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
