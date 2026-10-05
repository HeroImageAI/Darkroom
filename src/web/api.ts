import type { Item as DbItem, Job as DbJob } from '../server/db';
import type { Manifest } from '../shared/manifest';
import type { CameraPreset, PromptTemplates, StylePreset } from '../shared/prompts';
import type { Board } from '../server/db';
import { getState } from './store';

export type { Board };

/** `layered`: has Edit canvas layers saved with it (DECISIONS 122) */
export type Item = Omit<DbItem, 'api_prompt'> & { layered?: boolean };
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
  put: <T>(url: string, body: unknown) =>
    fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => handle<T>(r)),
  upload: (blob: Blob, filename: string) => {
    const fd = new FormData();
    fd.append('file', blob, filename);
    return fetch('/api/upload', { method: 'POST', body: fd }).then((r) => handle<{ name: string; width: number | null; height: number | null }>(r));
  },
  asInput: (id: string, which: 'main' | 'poster' | 'last' = 'main') =>
    api.post<{ name: string; width: number | null; height: number | null }>(`/api/items/${id}/as-input`, { which }),
  // every new job carries the working board (a new version of a picture stays in that picture's board, server-side)
  submit: (body: SubmitBody) => api.post<Job>('/api/jobs', { ...body, meta: { boardId: getState().board, ...body.meta } }),
  cancel: (id: string) => api.post(`/api/jobs/${id}/cancel`),
  item: (id: string) => api.get<{ item: Item; lineage: Item[] }>(`/api/items/${id}`),
  boards: () => api.get<{ boards: Board[]; none: number }>('/api/boards'),
  createBoard: (name: string) => api.post<Board>('/api/boards', { name }),
  renameBoard: (id: string, name: string) => api.patch<Board>(`/api/boards/${id}`, { name }),
  deleteBoard: (id: string) => fetch(`/api/boards/${id}`, { method: 'DELETE' }).then((r) => handle<{ ok: true }>(r)),
  moveToBoard: (ids: string[], boardId: string | null) => api.post<{ moved: string[] }>('/api/items/board', { ids, boardId }),
  items: (q: { filter?: string; q?: string; limit?: number; offset?: number; board?: string; stack?: 1 }) =>
    api.get<{ total: number; items: Item[] }>(`/api/items?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))}`),
  favourite: (id: string, favourite: boolean) => api.patch<Item>(`/api/items/${id}`, { favourite }),
  /** Library delete: to "Recently deleted" (restorable), back, or for good (files to the Windows Recycle Bin). */
  deleteItems: (ids: string[]) => api.post<{ deleted: string[] }>('/api/items/delete', { ids }),
  restoreItems: (ids: string[]) => api.post<{ restored: string[] }>('/api/items/restore', { ids }),
  /** Video Takes: hide failed / cancelled / lost renders. */
  dismissJobs: (body: { ids: string[] } | { failedOfKind: string }) => api.post<{ dismissed: string[] }>('/api/jobs/dismiss', body),
  purgeItems: (body: { ids: string[] } | { all: true }) => api.post<{ purged: number; recycled: number; failed: string[] }>('/api/items/purge', body),
  vlm: (body: { task: 'caption' | 'reverse' | 'enhance' | 'motion' | 'edit_enhance' | 'compose' | 'scene'; variant: string; style?: string; camera?: string[]; sound?: { mode: 'scene' | 'describe' | 'off'; text?: string }; text?: string; itemId?: string; input?: string; which?: 'main' | 'poster' | 'last'; save?: boolean; input2?: string; inputs?: string[] }) =>
    api.post<{ text: string; seconds: number; model?: string; ratio?: string; aspect?: string | null }>('/api/vlm', body),
  outpaintPrepare: (body: { itemId: string; pad: { left: number; top: number; right: number; bottom: number }; feather?: number; step: 8 | 32 }) =>
    api.post<{
      image: string;
      mask: string;
      width: number;
      height: number;
      pad: { left: number; top: number; right: number; bottom: number };
      feather: number;
      bbox: { x: number; y: number; w: number; h: number } | null;
    }>('/api/outpaint/prepare', body),
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
    layers?: boolean;
    groupId?: string;
    /** The new item's Library title (DECISIONS 111). */
    title?: string;
    /** Board for the new result(s); filled in from the working board by api.submit. */
    boardId?: string | null;
  };
  force?: boolean;
}

export const fileUrl = (id: string, which: 'main' | 'poster' | 'last' = 'main') => `/api/items/${id}/file?which=${which}`;
export const downloadUrl = (id: string, which: 'main' | 'poster' | 'last' = 'main') => `/api/items/${id}/file?which=${which}&download=1`;
export const thumbUrl = (id: string) => `/api/items/${id}/thumb`;
export const graphUrl = (id: string) => `/api/items/${id}/graph`;
export const inputUrl = (name: string) => `/api/input?name=${encodeURIComponent(name)}`;
