const fs = require('fs');
const rep = (s, a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 80)); return s.replace(a, b); };

// workflow.ts: json params, mask kind
let w = fs.readFileSync('src/shared/workflow.ts', 'utf8');
w = rep(w, `  type: 'string' | 'int' | 'float' | 'bool' | 'image' | 'video' | 'combo';`, `  type: 'string' | 'int' | 'float' | 'bool' | 'image' | 'video' | 'combo' | 'json';`);
w = rep(w, `  kind: 'image' | 'video' | 'text';`, `  kind: 'image' | 'video' | 'text' | 'mask';`);
w = rep(w, `    case 'bool':
      return raw === true || raw === 'true' || raw === 1;`, `    case 'bool':
      return raw === true || raw === 'true' || raw === 1;
    case 'json':
      if (typeof raw !== 'string') return raw as InputValue;
      try {
        return JSON.parse(raw) as InputValue;
      } catch {
        throw new WorkflowError(\`\${name} is not valid JSON\`);
      }`);
fs.writeFileSync('src/shared/workflow.ts', w);

// db.ts: group_id column (additive migration), kinds
let db = fs.readFileSync('src/server/db.ts', 'utf8');
db = db.replace(/(export interface Job \{[\s\S]*?)kind: 'image' \| 'video' \| 'text';/, "$1kind: 'image' | 'video' | 'text' | 'mask';");
db = rep(db, `  job_id: string | null;
  input_name: string | null;
}`, `  job_id: string | null;
  input_name: string | null;
  /** Layers from one decomposition share a group id. */
  group_id?: string | null;
}`);
db = rep(db, `    this.db.exec(SCHEMA);
  }`, `    this.db.exec(SCHEMA);
    // additive migrations
    const cols = (this.db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('group_id')) this.db.exec('ALTER TABLE items ADD COLUMN group_id TEXT');
  }

  groupItems(groupId: string): Item[] {
    const rows = this.db.prepare('SELECT * FROM items WHERE group_id = ? ORDER BY created_at, id').all(groupId) as any[];
    return rows.map((r) => decode<Item>(r, JSON_ITEM)!);
  }`);
fs.writeFileSync('src/server/db.ts', db);

// jobs.ts: mask kind, maskFiles, group ids, plate chain
let j = fs.readFileSync('src/server/jobs.ts', 'utf8');
j = rep(j, `    if (spec.kind === 'text') {`, `    if (spec.kind === 'mask') {
      const files = filesFromHistory(h, findByTitle(job.api_prompt as ApiPrompt, spec.outputs.mask ?? 'DR_OUTPUT')).map(ref);
      this.patch(jobId, { status: 'done', progress: 1, stage: 'Done', finished_at: Date.now(), meta: { ...job.meta, files } });
      return;
    }
    if (spec.kind === 'text') {`);
j = rep(j, `      job_id: job.id,
      input_name: null,
    };`, `      job_id: job.id,
      input_name: null,
      group_id: (job.meta.groupId as string | undefined) ?? (job.meta.layers ? job.id : null),
    };`);
j = rep(j, `    this.patch(jobId, { status: 'done', progress: 1, stage: 'Done', finished_at: finished, result_ids: ids });
    this.broadcast({ type: 'library', ids });`, `    const maskFiles = spec.outputs.mask ? filesFromHistory(h, findByTitle(prompt, spec.outputs.mask)).map(ref) : [];
    this.patch(jobId, {
      status: 'done',
      progress: 1,
      stage: 'Done',
      finished_at: finished,
      result_ids: ids,
      ...(maskFiles.length ? { meta: { ...job.meta, maskFiles } } : {}),
    });
    this.broadcast({ type: 'library', ids });`);
j = rep(j, `    if (chain?.kind === 'upscale' && newIds[0]) {`, `    if (chain?.kind === 'plate') {
      // Background plate: Qwen-Image 2.1 inpaints the (dilated) subject mask on the ORIGINAL picture.
      const done = this.store.getJob(job.id);
      const mf = ((done?.meta.maskFiles as FileRef[] | undefined) ?? [])[0];
      const src = chain.firstItemId ? this.store.getItem(chain.firstItemId) : null;
      if (!mf || !src || !this.comfy) return;
      try {
        const bytes = await this.comfy.view(mf);
        const up = await this.comfy.upload('image', new Blob([new Uint8Array(bytes)]), \`plate_mask_\${job.id}.png\`, { subfolder: 'darkroom', overwrite: true });
        const c = chain as Record<string, unknown>;
        await this.submit({
          workflow: 'qwen_inpaint',
          params: { image_1: await this.asInput(src), mask: up.subfolder ? \`\${up.subfolder}/\${up.name}\` : up.name, prompt: String(c.prompt ?? ''), seed: Math.floor(Math.random() * 2 ** 31), grow: 8 },
          meta: { mode: 'edit:plate', model: 'Qwen-Image 2.1 background plate', prompt: 'Background plate', parentId: src.id, ui: src.ui, groupId: (c.groupId as string | undefined) ?? undefined },
        });
      } catch (e) {
        this.broadcast({ type: 'toast', kind: 'error', text: 'Could not make the background plate: ' + friendlyError((e as Error).message) });
      }
      return;
    }
    if (chain?.kind === 'upscale' && newIds[0]) {`);
j = rep(j, `    durationSec?: number;
    chain?: Record<string, unknown>;
  };`, `    durationSec?: number;
    chain?: Record<string, unknown>;
    groupId?: string;
    layers?: boolean;
  };`);
fs.writeFileSync('src/server/jobs.ts', j);

// index.ts: segment + output proxy + group listing
let i = fs.readFileSync('src/server/index.ts', 'utf8');
i = rep(i, `app.post('/api/jobs', async (req, reply) => {`, `/** Run SAM 3.1 and return mask file URLs (not saved to the library). */
app.post('/api/segment', async (req, reply) => {
  const b = (req.body ?? {}) as { itemId: string; text?: string; points?: { x: number; y: number }[]; negPoints?: { x: number; y: number }[]; box?: { x: number; y: number; width: number; height: number }; individual?: boolean; threshold?: number };
  const item = store.getItem(b.itemId);
  if (!item) return reply.code(404).send({ error: 'Picture not found.' });
  if (!b.text?.trim() && !b.points?.length && !b.box) return reply.code(400).send({ error: 'Click on the object, drag a box around it, or type what to select.' });
  const params: Record<string, string | number | boolean> = { image_1: await jobs.asInput(item), individual: !!b.individual };
  if (b.text?.trim()) params.text = b.text.trim();
  if (b.points?.length) params.points = JSON.stringify(b.points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })));
  if (b.negPoints?.length) params.neg_points = JSON.stringify(b.negPoints.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })));
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
  if (!q.filename || !jobs.comfy || /\\.\\.|[\\\\/]/.test(q.filename) || (q.subfolder ?? '').includes('..')) return reply.code(400).send({ error: 'Bad request' });
  const r = await fetch(jobs.comfy.viewUrl({ filename: q.filename, subfolder: q.subfolder ?? '', type: q.type ?? 'output' }));
  if (!r.ok) return reply.code(r.status).send({ error: 'Not found' });
  reply.header('content-type', r.headers.get('content-type') ?? 'application/octet-stream');
  return reply.send(Buffer.from(await r.arrayBuffer()));
});

app.get('/api/groups/:id', async (req) => store.groupItems((req.params as { id: string }).id).map(slim));

app.post('/api/jobs', async (req, reply) => {`);
i = rep(i, `function slim(item: NonNullable<ReturnType<typeof store.getItem>>) {`, `function outputUrl(f: FileRef): string {
  return \`/api/output?\${new URLSearchParams({ filename: f.filename, subfolder: f.subfolder, type: f.type })}\`;
}

function slim(item: NonNullable<ReturnType<typeof store.getItem>>) {`);
i = rep(i, `import { Store, type LibraryQuery } from './db.js';`, `import { Store, type FileRef, type LibraryQuery } from './db.js';`);
fs.writeFileSync('src/server/index.ts', i);
console.log('phase4 server ok');
