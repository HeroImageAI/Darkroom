/**
 * Minimal ComfyUI HTTP/WebSocket client. No Node- or browser-specific imports:
 * fetch and WebSocket are injected so this is unit-testable and shared by the
 * server and the CLI workflow runner.
 */
import type { ApiPrompt } from './workflow.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface OutputFile {
  filename: string;
  subfolder: string;
  type: string; // output | temp | input
  kind: 'image' | 'video';
  nodeId: string;
}

export interface SystemStats {
  system: { comfyui_version: string; argv: string[]; ram_total: number; ram_free: number; [k: string]: unknown };
  devices: { name: string; type: string; vram_total: number; vram_free: number; torch_vram_total: number; torch_vram_free: number }[];
}

export type ComfyEvent =
  | { type: 'status'; queueRemaining: number; sid?: string }
  | { type: 'execution_start'; promptId: string }
  | { type: 'execution_cached'; promptId: string; nodes: string[] }
  | { type: 'executing'; promptId: string; node: string | null }
  | { type: 'progress'; promptId: string; node: string; value: number; max: number }
  | { type: 'executed'; promptId: string; node: string; output: Record<string, unknown> }
  | { type: 'execution_success'; promptId: string }
  | { type: 'execution_error'; promptId: string; node: string; nodeType: string; message: string; exceptionType: string }
  | { type: 'execution_interrupted'; promptId: string }
  | { type: 'preview'; image: Uint8Array; mime: string }
  | { type: 'unknown'; raw: unknown };

/** Parse one WebSocket frame from ComfyUI into a typed event. */
export function parseWsMessage(data: string | ArrayBuffer | Uint8Array): ComfyEvent {
  if (typeof data !== 'string') {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.length < 8) return { type: 'unknown', raw: null };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eventType = view.getUint32(0); // 1 = PREVIEW_IMAGE
    if (eventType !== 1) return { type: 'unknown', raw: eventType };
    const format = view.getUint32(4); // 1 = JPEG, 2 = PNG
    return { type: 'preview', image: bytes.slice(8), mime: format === 2 ? 'image/png' : 'image/jpeg' };
  }
  let msg: { type?: string; data?: Record<string, any> };
  try {
    msg = JSON.parse(data);
  } catch {
    return { type: 'unknown', raw: data };
  }
  const d = msg.data ?? {};
  switch (msg.type) {
    case 'status':
      return { type: 'status', queueRemaining: d.status?.exec_info?.queue_remaining ?? 0, sid: d.sid };
    case 'execution_start':
      return { type: 'execution_start', promptId: d.prompt_id };
    case 'execution_cached':
      return { type: 'execution_cached', promptId: d.prompt_id, nodes: d.nodes ?? [] };
    case 'executing':
      return { type: 'executing', promptId: d.prompt_id, node: d.node ?? null };
    case 'progress':
      return { type: 'progress', promptId: d.prompt_id, node: String(d.node), value: d.value, max: d.max };
    case 'executed':
      return { type: 'executed', promptId: d.prompt_id, node: String(d.node), output: d.output ?? {} };
    case 'execution_success':
      return { type: 'execution_success', promptId: d.prompt_id };
    case 'execution_error':
      return {
        type: 'execution_error',
        promptId: d.prompt_id,
        node: String(d.node_id ?? ''),
        nodeType: d.node_type ?? '',
        message: d.exception_message ?? 'Unknown error',
        exceptionType: d.exception_type ?? '',
      };
    case 'execution_interrupted':
      return { type: 'execution_interrupted', promptId: d.prompt_id };
    default:
      return { type: 'unknown', raw: msg };
  }
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|gif)$/i;

/** Collect saved files from one node's `output` object (history or `executed`). */
export function filesFromNodeOutput(nodeId: string, output: Record<string, unknown>): OutputFile[] {
  const files: OutputFile[] = [];
  for (const key of ['images', 'gifs', 'videos', 'video', 'animated']) {
    const list = output[key];
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      if (!f || typeof f !== 'object' || typeof (f as any).filename !== 'string') continue;
      const ff = f as { filename: string; subfolder?: string; type?: string };
      files.push({
        filename: ff.filename,
        subfolder: ff.subfolder ?? '',
        type: ff.type ?? 'output',
        kind: VIDEO_EXT.test(ff.filename) ? 'video' : 'image',
        nodeId,
      });
    }
  }
  return files;
}

export interface HistoryEntry {
  outputs?: Record<string, Record<string, unknown>>;
  status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] };
  prompt?: unknown[];
}

export function filesFromHistory(entry: HistoryEntry, onlyNodes?: string[]): OutputFile[] {
  const out: OutputFile[] = [];
  for (const [nodeId, output] of Object.entries(entry.outputs ?? {})) {
    if (onlyNodes && !onlyNodes.includes(nodeId)) continue;
    out.push(...filesFromNodeOutput(nodeId, output));
  }
  return out;
}

/** Text produced by text nodes (e.g. PreviewAny after TextGenerate), in node order. */
export function textFromHistory(entry: HistoryEntry, onlyNodes?: string[]): string[] {
  const out: string[] = [];
  for (const [nodeId, output] of Object.entries(entry.outputs ?? {})) {
    if (onlyNodes && !onlyNodes.includes(nodeId)) continue;
    const t = (output as Record<string, unknown>).text;
    if (Array.isArray(t)) out.push(...t.filter((x): x is string => typeof x === 'string'));
    else if (typeof t === 'string') out.push(t);
  }
  return out;
}

/** Error text from a failed history entry, if any. */
export function historyError(entry: HistoryEntry): string | null {
  if (entry.status?.status_str !== 'error') return null;
  const err = entry.status.messages?.find((m) => m[0] === 'execution_error');
  const d = err?.[1] as Record<string, string> | undefined;
  return d ? `${d.node_type ?? 'node'}: ${d.exception_message ?? 'failed'}` : 'Execution failed';
}

export function viewQuery(f: Pick<OutputFile, 'filename' | 'subfolder' | 'type'>): string {
  const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder, type: f.type });
  return `/view?${q.toString()}`;
}

/** True when /system_stats comes from a server started by Comfy Desktop (not some other ComfyUI). */
export function isDesktopServer(stats: SystemStats, marker = 'instance-model-paths'): boolean {
  return stats.system.argv.some((a) => a.includes(marker));
}

/** Turn a ComfyUI /prompt validation error body into one readable sentence. */
export function describePromptError(body: any): string {
  if (!body || typeof body !== 'object') return 'ComfyUI rejected the workflow.';
  const parts: string[] = [];
  if (body.error?.message) parts.push(body.error.message);
  for (const [id, ne] of Object.entries<any>(body.node_errors ?? {})) {
    for (const e of ne.errors ?? []) parts.push(`${ne.class_type ?? id}: ${e.details || e.message}`);
  }
  return parts.join(' — ') || 'ComfyUI rejected the workflow.';
}

export class ComfyClient {
  constructor(
    public baseUrl: string,
    private fetchImpl: FetchLike = (u, i) => fetch(u, i),
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await this.fetchImpl(this.baseUrl + path, init);
    if (!r.ok) {
      let body: unknown = null;
      try {
        body = await r.json();
      } catch {
        /* not json */
      }
      const err = new Error(path === '/prompt' ? describePromptError(body) : `${path} → HTTP ${r.status}`);
      (err as any).status = r.status;
      (err as any).body = body;
      throw err;
    }
    return (await r.json()) as T;
  }

  systemStats() {
    return this.json<SystemStats>('/system_stats');
  }

  objectInfo() {
    return this.json<Record<string, any>>('/object_info');
  }

  async queuePrompt(
    prompt: ApiPrompt,
    clientId: string,
    extraPngInfo?: Record<string, unknown>,
    previewMethod?: 'auto' | 'latent2rgb' | 'taesd' | 'none',
  ): Promise<string> {
    const body: Record<string, unknown> = { prompt, client_id: clientId };
    const extra: Record<string, unknown> = {};
    if (extraPngInfo) extra.extra_pnginfo = extraPngInfo;
    if (previewMethod) extra.preview_method = previewMethod;
    if (Object.keys(extra).length) body.extra_data = extra;
    const r = await this.json<{ prompt_id: string }>('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.prompt_id;
  }

  async history(promptId: string): Promise<HistoryEntry | null> {
    const r = await this.json<Record<string, HistoryEntry>>(`/history/${encodeURIComponent(promptId)}`);
    return r[promptId] ?? null;
  }

  queue() {
    return this.json<{ queue_running: unknown[][]; queue_pending: unknown[][] }>('/queue');
  }

  async interrupt(promptId?: string): Promise<void> {
    await this.fetchImpl(this.baseUrl + '/interrupt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(promptId ? { prompt_id: promptId } : {}),
    });
  }

  async deleteFromQueue(promptIds: string[]): Promise<void> {
    await this.fetchImpl(this.baseUrl + '/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: promptIds }),
    });
  }

  async free(unloadModels = true, freeMemory = true): Promise<void> {
    await this.fetchImpl(this.baseUrl + '/free', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unload_models: unloadModels, free_memory: freeMemory }),
    });
  }

  /** Upload to ComfyUI's input folder. Returns the name to put in LoadImage. */
  async upload(
    kind: 'image' | 'mask',
    data: Blob,
    filename: string,
    opts: { subfolder?: string; overwrite?: boolean; originalRef?: { filename: string; subfolder: string; type: string } } = {},
  ): Promise<{ name: string; subfolder: string; type: string }> {
    const fd = new FormData();
    fd.append('image', data, filename);
    fd.append('type', 'input');
    if (opts.subfolder) fd.append('subfolder', opts.subfolder);
    if (opts.overwrite) fd.append('overwrite', 'true');
    if (kind === 'mask' && opts.originalRef) fd.append('original_ref', JSON.stringify(opts.originalRef));
    const r = await this.json<{ name: string; subfolder: string; type: string }>(`/upload/${kind}`, {
      method: 'POST',
      body: fd,
    });
    return r;
  }

  viewUrl(f: Pick<OutputFile, 'filename' | 'subfolder' | 'type'>): string {
    return this.baseUrl + viewQuery(f);
  }

  async view(f: Pick<OutputFile, 'filename' | 'subfolder' | 'type'>): Promise<Uint8Array> {
    const r = await this.fetchImpl(this.viewUrl(f));
    if (!r.ok) throw new Error(`view ${f.filename} → HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  /** Whether an input-folder file (LoadImage name, e.g. "darkroom/x.png") still exists. */
  async inputExists(name: string): Promise<boolean> {
    const i = name.lastIndexOf('/');
    const f = { filename: i >= 0 ? name.slice(i + 1) : name, subfolder: i >= 0 ? name.slice(0, i) : '', type: 'input' };
    try {
      const r = await this.fetchImpl(this.viewUrl(f));
      await r.body?.cancel().catch(() => undefined);
      return r.ok;
    } catch {
      return false;
    }
  }
}

/** Input name to use in LoadImage for an upload result. */
export function inputName(u: { name: string; subfolder: string }): string {
  return u.subfolder ? `${u.subfolder}/${u.name}` : u.name;
}
