import { useSyncExternalStore } from 'react';
import type { Bootstrap, Job, Status } from './api';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'ok';
  text: string;
  /** Optional button in the toast, e.g. Undo after a delete. */
  action?: { label: string; run: () => void };
}

export interface AppState {
  status: Status | null;
  socket: 'connecting' | 'open' | 'closed';
  boot: Bootstrap | null;
  jobs: Record<string, Job>;
  previews: Record<string, string>;
  libraryRev: number;
  toasts: Toast[];
  /** The board new results go to (a preference, kept across launches); null = no board. */
  board: string | null;
  /** Timeline exports in progress (DECISIONS 103): 0–1, -1 failed; itemId once the film is in the Library. */
  exports: Record<string, { progress: number; itemId?: string }>;
}

const savedBoard = (() => {
  try {
    return JSON.parse(localStorage.getItem('dr.board') ?? 'null') as string | null;
  } catch {
    return null;
  }
})();
let state: AppState = { status: null, socket: 'connecting', boot: null, jobs: {}, previews: {}, libraryRev: 0, toasts: [], board: savedBoard, exports: {} };
const listeners = new Set<() => void>();
const jobListeners = new Set<(job: Job) => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach((l) => l());
}

export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => sel(state),
  );
}

const timelineListeners = new Set<(msg: { id: string; doc: unknown }) => void>();
/** Timeline changes made by the server (an AI clip landing on the film, DECISIONS 104). */
export function onTimeline(fn: (msg: { id: string; doc: unknown }) => void): () => void {
  timelineListeners.add(fn);
  return () => timelineListeners.delete(fn);
}

/** Subscribe to job updates (e.g. to react when a specific job finishes). */
export function onJob(fn: (job: Job) => void): () => void {
  jobListeners.add(fn);
  return () => jobListeners.delete(fn);
}

let toastId = 1;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = kind === 'error' ? 9000 : 4000, action?: Toast['action']): void {
  const id = toastId++;
  setState((s) => ({ toasts: [...s.toasts, { id, kind, text, action }] }));
  setTimeout(() => dismissToast(id), ms);
}
export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

function upsertJob(job: Job): void {
  setState((s) => {
    const jobs = { ...s.jobs, [job.id]: job };
    const previews = { ...s.previews };
    if (job.status !== 'running' && job.status !== 'queued') delete previews[job.id];
    return { jobs, previews };
  });
  jobListeners.forEach((l) => l(job));
}

/** Live connection to the Darkroom server. Reconnects forever with backoff. */
export function connectEvents(): void {
  let retry = 500;
  const open = () => {
    setState({ socket: 'connecting' });
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/events`);
    ws.onopen = () => {
      retry = 500;
      setState({ socket: 'open' });
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string);
      switch (msg.type) {
        case 'hello':
          // (re)connected: anything that changed while the socket was down is read again
          setState((s) => ({ status: msg.status, libraryRev: s.libraryRev + 1 }));
          (msg.jobs as Job[]).forEach(upsertJob);
          break;
        case 'status':
          setState({ status: msg.status });
          break;
        case 'job':
          upsertJob(msg.job);
          break;
        case 'preview':
          setState((s) => ({ previews: { ...s.previews, [msg.jobId]: `data:${msg.mime};base64,${msg.data}` } }));
          break;
        case 'library':
        case 'item':
          setState((s) => ({ libraryRev: s.libraryRev + 1 }));
          break;
        case 'toast':
          toast(msg.text, msg.kind ?? 'info');
          break;
        case 'timeline':
          timelineListeners.forEach((l) => l(msg));
          break;
        case 'export':
          setState((s) => ({ exports: { ...s.exports, [msg.timelineId]: { progress: msg.progress, itemId: msg.itemId } } }));
          break;
        case 'queue':
          setState((s) => (s.status ? { status: { ...s.status, queue: msg.remaining } } : {}));
          break;
      }
    };
    ws.onclose = () => {
      setState({ socket: 'closed' });
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 5000);
    };
  };
  open();
}

/** Choose the board new results go to. */
export function setActiveBoard(id: string | null): void {
  try {
    localStorage.setItem('dr.board', JSON.stringify(id));
  } catch {
    /* ignore */
  }
  setState({ board: id });
}
