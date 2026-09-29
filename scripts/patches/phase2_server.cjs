// Phase 2 server: text jobs (VLM), waiting, auto-unload, /api/vlm, item captions.
const fs = require('fs');
const rep = (s, a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 80)); return s.replace(a, b); };

// kinds
let db = fs.readFileSync('src/server/db.ts', 'utf8');
db = db.replace(/(export interface Job \{[\s\S]*?)kind: 'image' \| 'video';/, "$1kind: 'image' | 'video' | 'text';");
db = rep(db, `  updateItem(id: string, patch: Partial<Pick<Item, 'favourite' | 'tags' | 'input_name'>>): void {`,
`  updateItem(id: string, patch: Partial<Pick<Item, 'favourite' | 'tags' | 'input_name'>> & { caption?: string }): void {
    if (patch.caption !== undefined) {
      const it = this.getItem(id);
      if (it) this.db.prepare('UPDATE items SET ui = ? WHERE id = ?').run(JSON.stringify({ ...(it.ui ?? {}), caption: patch.caption }), id);
    }`);
fs.writeFileSync('src/server/db.ts', db);

let wf = fs.readFileSync('src/shared/workflow.ts', 'utf8');
wf = rep(wf, `  kind: 'image' | 'video';`, `  kind: 'image' | 'video' | 'text';`);
fs.writeFileSync('src/shared/workflow.ts', wf);

// jobs.ts
let j = fs.readFileSync('src/server/jobs.ts', 'utf8');
j = rep(j, `import { ComfyClient, filesFromHistory, historyError, parseWsMessage, type OutputFile } from '../shared/comfy.js';`,
`import { ComfyClient, filesFromHistory, historyError, parseWsMessage, textFromHistory, type OutputFile } from '../shared/comfy.js';
import { cleanVlmOutput } from '../shared/vlm.js';`);
j = rep(j, `  private patch(id: string, p: Partial<Job>): void {
    this.store.updateJob(id, p);
    const job = this.store.getJob(id);
    if (job) this.broadcast({ type: 'job', job: publicJob(job) });
  }`, `  private waiters = new Map<string, ((job: Job) => void)[]>();

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
  }`);
j = rep(j, `    const spec = this.manifest().workflows[job.workflow];`, `    const spec = this.manifest().workflows[job.workflow];
    if (spec.kind === 'text') {
      const text = cleanVlmOutput(textFromHistory(h, findByTitle(job.api_prompt as ApiPrompt, spec.outputs.text ?? 'DR_OUTPUT')).join('\\n'));
      this.patch(jobId, { status: 'done', progress: 1, stage: 'Done', finished_at: Date.now(), meta: { ...job.meta, text } });
      // Auto-unload the VLM when nothing else is waiting, so the next image/video job gets the whole GPU.
      if (this.store.activeJobs().length === 0) void this.comfy.free(true, true).catch(() => undefined);
      return;
    }`);
fs.writeFileSync('src/server/jobs.ts', j);

// index.ts: /api/vlm + caption patch
let i = fs.readFileSync('src/server/index.ts', 'utf8');
i = rep(i, `app.post('/api/jobs', async (req, reply) => {`, `/**
 * Local VLM (Qwen3-VL 8B): caption | reverse | enhance | motion.
 * body: { task, variant, text?, itemId?, input?, which? }  -> { text, seconds }
 */
app.post('/api/vlm', async (req, reply) => {
  const b = (req.body ?? {}) as { task: VlmTask; variant: string; text?: string; itemId?: string; input?: string; which?: 'main' | 'poster' | 'last'; seed?: number; save?: boolean };
  if (!jobs.comfy) return reply.code(503).send({ error: "ComfyUI isn't running." });
  let request;
  try {
    const prompts = readJson<VlmPrompts>(path.join(cfg.paths.presets, 'vlm_prompts.json'));
    request = buildVlmRequest(prompts, b.task, b.variant, b.text ?? '');
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
  const params: Record<string, string | number> = { prompt: request.prompt, max_tokens: request.maxTokens, seed: b.seed ?? Math.floor(Math.random() * 2 ** 31) };
  if (request.workflow === 'vlm_image') {
    let name = b.input;
    if (!name && b.itemId) {
      const item = store.getItem(b.itemId);
      if (!item) return reply.code(404).send({ error: 'Picture not found.' });
      name = await jobs.asInput(item, b.which ?? (item.kind === 'video' ? 'poster' : 'main'));
    }
    if (!name) return reply.code(400).send({ error: 'This needs a picture.' });
    params.image_1 = name;
  }
  const t0 = Date.now();
  try {
    const job = await jobs.submit({ workflow: request.workflow, params, meta: { mode: \`vlm:\${b.task}\`, model: 'Qwen3-VL 8B', prompt: b.text ?? '' } });
    const done = await jobs.waitFor(job.id);
    if (done.status !== 'done') return reply.code(500).send({ error: done.error ?? 'The model did not answer.' });
    const text = String((done.meta as Record<string, unknown>).text ?? '');
    if (b.save && b.itemId && b.task === 'caption') store.updateItem(b.itemId, { caption: text });
    return { text, seconds: Math.round((Date.now() - t0) / 100) / 10 };
  } catch (e) {
    return reply.code(500).send({ error: (e as Error).message });
  }
});

app.post('/api/jobs', async (req, reply) => {`);
i = rep(i, `  const body = req.body as { favourite?: boolean; tags?: string[] };
  store.updateItem(id, { favourite: body.favourite, tags: body.tags });`, `  const body = req.body as { favourite?: boolean; tags?: string[]; caption?: string };
  store.updateItem(id, { favourite: body.favourite, tags: body.tags, caption: body.caption });`);
i = rep(i, `import { JobManager, publicJob, VramWarning, type SubmitRequest } from './jobs.js';`, `import { JobManager, publicJob, VramWarning, type SubmitRequest } from './jobs.js';
import { buildVlmRequest, type VlmPrompts, type VlmTask } from '../shared/vlm.js';`);
fs.writeFileSync('src/server/index.ts', i);
console.log('phase2 server patched');
