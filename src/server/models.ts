import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

/**
 * Model setup (DECISIONS 138): the models Darkroom needs (scripts/models.json), which ones ComfyUI already has, and
 * downloading the missing ones from Hugging Face into ComfyUI's models folder, so a fresh PC needs no manual copying.
 * Downloads go to a .part file next to the target (resumed after a restart or a dropped connection) and are moved
 * into place only when complete; an existing file is never overwritten.
 */
export interface ModelEntry {
  file: string;
  folder: string;
  gb: number | null;
  repo?: string | null;
  path?: string | null;
  group: string;
  /** the publisher asks for a free Hugging Face account and a click on Agree */
  signIn?: boolean;
  optional?: boolean;
  /** other file names that count as this model (e.g. ComfyUI's repack of the same weights) */
  also?: string[];
  source?: string;
  note?: string;
  convert?: 'orbit-keys';
}

export type ModelStatus = 'present' | 'missing' | 'queued' | 'downloading' | 'failed' | 'sign-in' | 'licence' | 'manual';

export interface ModelState extends ModelEntry {
  status: ModelStatus;
  /** the file name ComfyUI has, when it is one of `also` */
  presentAs?: string;
  received?: number;
  total?: number;
  error?: string;
}

export interface ModelList {
  groups: Record<string, string>;
  models: ModelEntry[];
}

type Comfy = { baseUrl: string; systemStats(): Promise<unknown> } | null;

/** ComfyUI's default models folder, read from the paths file Comfy Desktop passes it (--extra-model-paths-config). */
export function modelsDirFromArgv(argv: string[] | undefined): string | null {
  const i = argv?.indexOf('--extra-model-paths-config') ?? -1;
  if (!argv || i < 0 || !argv[i + 1] || !fs.existsSync(argv[i + 1])) return null;
  return modelsDirFromYaml(fs.readFileSync(argv[i + 1], 'utf8'));
}

/** The base_path of the block marked is_default (else the first base_path) in an extra_model_paths YAML. */
export function modelsDirFromYaml(text: string): string | null {
  const blocks = text.split(/\r?\n(?=\S)/);
  const base = (b: string) => /^\s+base_path:\s*['"]?(.+?)['"]?\s*$/m.exec(b)?.[1] ?? null;
  const def = blocks.find((b) => /^\s+is_default:\s*true/m.test(b) && base(b));
  const any = blocks.find((b) => base(b));
  const p = base(def ?? any ?? '');
  return p ? path.resolve(p) : null;
}

/**
 * Rename a LoRA's keys diffusion_model.* -> transformer.* (DECISIONS 113): only under that name does ComfyUI map
 * Qwen-Image 2.1's split MLP halves onto its fused gate_up layer. The tensor data is copied unchanged.
 */
export async function convertOrbitKeys(src: string, dest: string): Promise<void> {
  const fd = fs.openSync(src, 'r');
  const lenBuf = Buffer.alloc(8);
  fs.readSync(fd, lenBuf, 0, 8, 0);
  const n = Number(lenBuf.readBigUInt64LE());
  const hb = Buffer.alloc(n);
  fs.readSync(fd, hb, 0, n, 8);
  fs.closeSync(fd);
  const header = JSON.parse(hb.toString('utf8')) as Record<string, unknown>;
  const out: Record<string, unknown> = {
    __metadata__: { ...((header.__metadata__ as object) ?? {}), darkroom_note: 'keys renamed diffusion_model.* -> transformer.* so ComfyUI maps img_mlp gate_layer/proj onto the fused gate_up' },
  };
  for (const [k, v] of Object.entries(header)) if (k !== '__metadata__') out[k.replace(/^diffusion_model\./, 'transformer.')] = v;
  let json = JSON.stringify(out);
  json += ' '.repeat((8 - (Buffer.byteLength(json) % 8)) % 8);
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(Buffer.byteLength(json)));
  const w = fs.createWriteStream(dest);
  w.write(len);
  w.write(json);
  await pipeline(fs.createReadStream(src, { start: 8 + n }), w);
}

export class ModelSetup {
  private states = new Map<string, Partial<ModelState>>();
  private queue: string[] = [];
  private running = false;
  private abort: AbortController | null = null;
  private seen: { at: number; files: Map<string, Map<string, number>> } | null = null;

  constructor(
    private listPath: string,
    private dataDir: string,
    private comfy: () => Comfy,
    private broadcast: (msg: unknown) => void,
  ) {}

  list(): ModelList {
    const j = JSON.parse(fs.readFileSync(this.listPath, 'utf8')) as ModelList;
    return { groups: j.groups ?? {}, models: j.models };
  }

  // ---- your Hugging Face token: typed into Darkroom by you, kept in data/ (never in git), sent only to huggingface.co
  private tokenFile(): string {
    return path.join(this.dataDir, 'huggingface-token.txt');
  }
  token(): string | null {
    try {
      return fs.readFileSync(this.tokenFile(), 'utf8').trim() || null;
    } catch {
      return null;
    }
  }
  setToken(t: string | null): void {
    if (t) fs.writeFileSync(this.tokenFile(), t.trim(), { encoding: 'utf8', mode: 0o600 });
    else fs.rmSync(this.tokenFile(), { force: true });
    // a new token may open what the old one could not
    for (const [k, s] of this.states) if (s.status === 'sign-in' || s.status === 'licence') this.states.delete(k);
  }

  /**
   * The files ComfyUI sees, per folder, with their sizes (its own list covers every models folder it is configured
   * with). The size matters: a failed download can leave a tiny error page under the model's name.
   */
  private async comfyFiles(folders: string[], fresh = false): Promise<Map<string, Map<string, number>> | null> {
    const c = this.comfy();
    if (!c) return null;
    if (!fresh && this.seen && Date.now() - this.seen.at < 5000) return this.seen.files;
    const roots = (await (await fetch(`${c.baseUrl}/internal/folder_paths`)).json().catch(() => ({}))) as Record<string, string[]>;
    const files = new Map<string, Map<string, number>>();
    await Promise.all(
      [...new Set(folders)].map(async (f) => {
        const r = await fetch(`${c.baseUrl}/models/${encodeURIComponent(f)}`).catch(() => null);
        const names = r?.ok ? ((await r.json()) as string[]) : [];
        const sizes = new Map<string, number>();
        for (const n of names) {
          const p = (roots[f] ?? []).map((d) => path.join(d, n)).find((x) => fs.existsSync(x));
          const base = n.split(/[\\/]/).pop()!;
          sizes.set(base, Math.max(sizes.get(base) ?? 0, p ? fs.statSync(p).size : 0));
        }
        files.set(f, sizes);
      }),
    );
    this.seen = { at: Date.now(), files };
    return files;
  }

  async modelsDir(): Promise<string | null> {
    const c = this.comfy();
    if (!c) return null;
    const stats = (await c.systemStats().catch(() => null)) as { system?: { argv?: string[] } } | null;
    return modelsDirFromArgv(stats?.system?.argv);
  }

  /** Every model with its state; null when ComfyUI is not running (it is what says which files it has). */
  async scan(fresh = false): Promise<ModelState[] | null> {
    const { models } = this.list();
    const seen = await this.comfyFiles(
      models.map((m) => m.folder),
      fresh,
    );
    if (!seen) return null;
    return models.map((m) => {
      const have = seen.get(m.folder);
      const as = [m.file, ...(m.also ?? [])].find((n) => complete(m, have?.get(n)));
      const s = this.states.get(m.file) ?? {};
      if (as) return { ...m, status: 'present', presentAs: as === m.file ? undefined : as };
      return { ...m, status: (s.status as ModelStatus) ?? (m.repo ? 'missing' : 'manual'), received: s.received, total: s.total, error: s.error };
    });
  }

  /** fitGraph against what ComfyUI has now; nothing changes when ComfyUI cannot be asked. */
  async fit(prompt: Graph): Promise<string[]> {
    const { models } = this.list();
    const seen = await this.comfyFiles(models.map((m) => m.folder)).catch(() => null);
    if (!seen) return [];
    return fitGraph(prompt, models, (folder, file) => {
      const m = models.find((x) => x.file === file || x.also?.includes(file));
      return m ? complete(m, seen.get(folder)?.get(file)) : true;
    });
  }

  async summary(): Promise<{ checked: boolean; missing: number; missingGB: number; optionalMissing: number }> {
    const all = await this.scan();
    if (!all) return { checked: false, missing: 0, missingGB: 0, optionalMissing: 0 };
    const miss = all.filter((m) => m.status !== 'present' && !m.optional);
    return { checked: true, missing: miss.length, missingGB: +miss.reduce((a, m) => a + (m.gb ?? 0), 0).toFixed(1), optionalMissing: all.filter((m) => m.status !== 'present' && m.optional).length };
  }

  status(): { running: boolean; queue: string[] } {
    return { running: this.running, queue: [...this.queue] };
  }

  private set(file: string, s: Partial<ModelState>): void {
    this.states.set(file, { ...this.states.get(file), ...s });
    this.broadcast({ type: 'models', file, ...this.states.get(file) });
  }

  /** Queue missing models for download (those already present are skipped). */
  async download(files: string[]): Promise<{ queued: string[]; error?: string }> {
    const all = await this.scan(true);
    if (!all) return { queued: [], error: 'Start ComfyUI first: Darkroom asks it which models it already has.' };
    const dir = await this.modelsDir();
    if (!dir) return { queued: [], error: "ComfyUI did not say where its models folder is. Start it from Comfy Desktop (it passes the folder), then try again." };
    const pick = all.filter((m) => files.includes(m.file) && m.status !== 'present' && m.repo && !this.queue.includes(m.file) && m.status !== 'downloading');
    const needGB = pick.reduce((a, m) => a + (m.gb ?? 0), 0);
    const free = freeGB(dir);
    if (free !== null && free < needGB + 2) return { queued: [], error: `Not enough room on the models drive: ${needGB.toFixed(1)} GB to download, ${free.toFixed(1)} GB free.` };
    for (const m of pick) {
      this.queue.push(m.file);
      this.set(m.file, { status: 'queued', error: undefined });
    }
    void this.run(dir);
    return { queued: pick.map((m) => m.file) };
  }

  /** Stop: the current file keeps its .part and resumes next time. */
  cancel(): void {
    for (const f of this.queue) this.set(f, { status: 'missing' });
    this.queue = [];
    this.abort?.abort();
  }

  private async run(dir: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.broadcast({ type: 'models-run', running: true });
    try {
      while (this.queue.length) {
        const file = this.queue[0];
        const m = this.list().models.find((x) => x.file === file);
        if (m?.repo && m.path) await this.fetchOne(dir, m);
        this.queue.shift();
      }
    } finally {
      this.running = false;
      this.seen = null;
      this.broadcast({ type: 'models-run', running: false });
    }
  }

  private async fetchOne(dir: string, m: ModelEntry): Promise<void> {
    const target = path.join(dir, m.folder, m.file);
    if (fs.existsSync(target)) return this.set(m.file, { status: 'present' });
    const stage = path.join(dir, '.darkroom-download');
    fs.mkdirSync(stage, { recursive: true });
    const part = path.join(stage, (m.convert ? 'src-' : '') + m.file + '.part');
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    const url = `https://huggingface.co/${m.repo}/resolve/main/${m.path!.split('/').map(encodeURIComponent).join('/')}`;
    const headers: Record<string, string> = { 'user-agent': 'Darkroom' };
    const token = this.token();
    if (token) headers.authorization = `Bearer ${token}`;
    if (have) headers.range = `bytes=${have}-`;
    this.abort = new AbortController();
    this.set(m.file, { status: 'downloading', received: have, total: (m.gb ?? 0) * 1e9, error: undefined });
    try {
      const r = await fetch(url, { headers, signal: this.abort.signal, redirect: 'follow' });
      if (r.status === 401) return this.set(m.file, { status: 'sign-in', error: 'Needs your Hugging Face token (free account).' });
      if (r.status === 403) return this.set(m.file, { status: 'licence', error: `Open https://huggingface.co/${m.repo} while signed in and press Agree.` });
      if (r.status === 416) {
        // the .part is already complete
      } else if (!r.ok || !r.body) {
        throw new Error(`Hugging Face answered ${r.status}`);
      }
      const resumed = r.status === 206;
      const len = Number(r.headers.get('content-length') ?? 0);
      const total = r.status === 416 ? have : (resumed ? have : 0) + len;
      if (r.status !== 416) {
        let got = resumed ? have : 0;
        let last = 0;
        const count = new Transform({
          transform: (chunk: Buffer, _e, cb) => {
            got += chunk.length;
            if (Date.now() - last > 700) {
              last = Date.now();
              this.set(m.file, { received: got, total });
            }
            cb(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(r.body as never), count, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }));
      }
      if (total && fs.statSync(part).size !== total) throw new Error('The download was incomplete; press Download to resume.');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) return this.set(m.file, { status: 'present' });
      if (m.convert === 'orbit-keys') {
        await convertOrbitKeys(part, target + '.tmp');
        fs.renameSync(target + '.tmp', target);
        fs.rmSync(part, { force: true });
      } else {
        fs.renameSync(part, target);
      }
      this.set(m.file, { status: 'present', received: total, total });
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      this.set(m.file, { status: aborted ? 'missing' : 'failed', error: aborted ? undefined : (e as Error).message });
    } finally {
      this.abort = null;
    }
  }
}

/** A real model file, not an error page saved under its name by a failed download (one was found on JP's PC). */
export function complete(m: Pick<ModelEntry, 'gb'>, size: number | undefined): boolean {
  if (!size || size < 100_000) return false;
  return !m.gb || m.gb < 0.1 || size >= m.gb * 1e9 * 0.5;
}

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/**
 * Fit a graph to the models this PC has (DECISIONS 138): a model file the graph names but ComfyUI lacks is swapped for
 * another name of the same model (`also`: Klein 9B from Black Forest Labs vs ComfyUI's repack), and a missing
 * optional LoRA is left out (its loader node is bypassed), so a fresh install works without your old downloads.
 * Returns the optional files that were left out.
 */
export function fitGraph(prompt: Graph, list: ModelEntry[], has: (folder: string, file: string) => boolean): string[] {
  const left: string[] = [];
  for (const [id, node] of Object.entries(prompt)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (typeof v !== 'string') continue;
      const m = list.find((x) => x.file === v || x.also?.includes(v));
      if (!m || has(m.folder, v)) continue;
      const other = [m.file, ...(m.also ?? [])].find((n) => n !== v && has(m.folder, n));
      if (other) node.inputs[k] = other;
      else if (m.optional && /^LoraLoader/.test(node.class_type)) {
        // bypass: whatever read the loader's model (0) / clip (1) now reads the loader's own inputs
        for (const other2 of Object.values(prompt))
          for (const [k2, v2] of Object.entries(other2.inputs))
            if (Array.isArray(v2) && v2[0] === id) other2.inputs[k2] = v2[1] === 1 ? node.inputs.clip : node.inputs.model;
        delete prompt[id];
        left.push(v);
        break;
      }
    }
  }
  return left;
}

/** Free space on the drive holding `dir`, in GB (null when the system cannot say). */
export function freeGB(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return (s.bavail * s.bsize) / 1e9;
  } catch {
    return null;
  }
}
