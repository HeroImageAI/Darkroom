import type { Item as DbItem, Job as DbJob } from '../server/db';
import type { Manifest } from '../shared/manifest';
import type { CameraPreset, PromptTemplates, StylePreset } from '../shared/prompts';

export type Item = Omit<DbItem, 'api_prompt'>;
export type Job = Omit<DbJob, 'api_prompt'>;

export interface Status {
  comfy: 'online' | 'offline' | 'starting' | 'desktop-open';
  url: string | null;
  version: string | null;
  vram: { total: number; free: number } | null;
  queue: number;
  desktopRunning: boolean;
  message: string;
  connected: boolean;
}

export type Style = StylePreset;
export type Camera = CameraPreset;
export interface Bootstrap {
  manifest: Manifest;
  styles: { styles: Style[] };
  camera: { camera: Camera[] };
  prompts: PromptTemplates;
  comfyUrl: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: any,
  ) {
    super(message);
  }
}

async function handle<T>(r: Response): Promise<T> {
  const text = await r.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!r.ok) throw new ApiError(body?.error ?? body?.warning ?? `Request failed (${r.status})`, r.status, body);
  return body as T;
}

export const api = {
  get: <T>(url: string) => fetch(url).then((r) => handle<T>(r)),
  post: <T>(url: string, body?: unknown) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => handle<T>(r)),
  patch: <T>(url: string, body: unknown) =>
    fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => handle<T>(r)),
  upload: (blob: Blob, filename: string) => {
    const fd = new FormData();
    fd.append('file', blob, filename);
    return fetch('/api/upload', { method: 'POST', body: fd }).then((r) => handle<{ name: string; width: number | null; height: number | null }>(r));
  },
  asInput: (id: string, which: 'main' | 'poster' | 'last' = 'main') =>
    api.post<{ name: string; width: number | null; height: number | null }>(`/api/items/${id}/as-input`, { which }),
  submit: (body: SubmitBody) => api.post<Job>('/api/jobs', body),
  cancel: (id: string) => api.post(`/api/jobs/${id}/cancel`),
  item: (id: string) => api.get<{ item: Item; lineage: Item[] }>(`/api/items/${id}`),
  items: (q: { filter?: string; q?: string; limit?: number; offset?: number }) =>
    api.get<{ total: number; items: Item[] }>(`/api/items?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))}`),
  favourite: (id: string, favourite: boolean) => api.patch<Item>(`/api/items/${id}`, { favourite }),
};

export interface SubmitBody {
  workflow: string;
  params: Record<string, string | number | boolean | null | undefined>;
  meta: {
    mode: string;
    model?: string;
    prompt?: string;
    negative?: string;
    parentId?: string | null;
    ui?: Record<string, unknown>;
    estimateSec?: number | null;
    notify?: boolean;
    durationSec?: number;
    chain?: Record<string, unknown>;
  };
  force?: boolean;
}

export const fileUrl = (id: string, which: 'main' | 'poster' | 'last' = 'main') => `/api/items/${id}/file?which=${which}`;
export const downloadUrl = (id: string, which: 'main' | 'poster' | 'last' = 'main') => `/api/items/${id}/file?which=${which}&download=1`;
export const thumbUrl = (id: string) => `/api/items/${id}/thumb`;
export const graphUrl = (id: string) => `/api/items/${id}/graph`;
export const inputUrl = (name: string) => `/api/input?name=${encodeURIComponent(name)}`;
