import { useEffect, useState } from 'react';
import { api, type Item } from '../api';
import { useApp } from '../store';

/** Load a library item (re-fetches when the library changes). */
export function useItem(id: string | null | undefined): Item | null {
  return useItemLoad(id).item;
}

/** Like useItem, but also says when the item no longer exists (deleted for good), so screens can stop "Opening…". */
export function useItemLoad(id: string | null | undefined): { item: Item | null; missing: boolean } {
  const [state, setState] = useState<{ item: Item | null; missing: boolean }>({ item: null, missing: false });
  const rev = useApp((s) => s.libraryRev);
  useEffect(() => {
    if (!id) {
      setState({ item: null, missing: false });
      return;
    }
    let live = true;
    api
      .item(id)
      .then((r) => live && setState({ item: r.item, missing: false }))
      .catch((e) => live && setState({ item: null, missing: (e as { status?: number }).status === 404 }));
    return () => {
      live = false;
    };
  }, [id, rev]);
  return state;
}

/** State persisted in localStorage so a reload never loses what you typed. */
export function usePersistent<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem('dr.' + key);
      if (!raw) return initial;
      const parsed = JSON.parse(raw);
      const isObj = (x: unknown) => x !== null && typeof x === 'object' && !Array.isArray(x);
      return isObj(initial) && isObj(parsed) ? { ...(initial as any), ...parsed } : parsed;
    } catch {
      return initial;
    }
  });
  const set = (next: T | ((p: T) => T)) => {
    setV((prev) => {
      const val = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      try {
        localStorage.setItem('dr.' + key, JSON.stringify(val));
      } catch {
        /* storage full / blocked */
      }
      return val;
    });
  };
  return [v, set];
}

export function notifyDesktop(title: string, body: string): void {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') new Notification(title, { body });
}

export async function ensureNotifyPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

/**
 * Work in progress vs preferences (DECISIONS 82). One settings object; the keys in `sessionKeys` (the prompt, the
 * pictures in use, what is on screen) live in sessionStorage, so they survive switching screens and reloads but a
 * fresh launch of Darkroom starts with a clean workspace. Everything else (model, aspect, quality…) is a preference
 * and stays in localStorage. Older versions kept everything in localStorage; those work-in-progress values are
 * ignored.
 */
export function useWorkspace<T extends object>(key: string, initial: T, sessionKeys: (keyof T)[]): [T, (v: T | ((p: T) => T)) => void] {
  const isSession = (k: string) => (sessionKeys as string[]).includes(k);
  const read = (store: Storage) => {
    try {
      const raw = store.getItem('dr.' + key);
      const v = raw ? JSON.parse(raw) : null;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const [v, setV] = useState<T>(() => {
    const prefs = Object.fromEntries(Object.entries(read(localStorage)).filter(([k]) => !isSession(k)));
    const work = Object.fromEntries(Object.entries(read(sessionStorage)).filter(([k]) => isSession(k)));
    return { ...initial, ...prefs, ...work };
  });
  const set = (next: T | ((p: T) => T)) => {
    setV((prev) => {
      const val = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      const entries = Object.entries(val as Record<string, unknown>);
      try {
        localStorage.setItem('dr.' + key, JSON.stringify(Object.fromEntries(entries.filter(([k]) => !isSession(k)))));
        sessionStorage.setItem('dr.' + key, JSON.stringify(Object.fromEntries(entries.filter(([k]) => isSession(k)))));
      } catch {
        /* storage full / blocked */
      }
      return val;
    });
  };
  return [v, set];
}

/** A single work-in-progress value (what is on screen): kept for this launch only. */
export function useSessionState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem('dr.' + key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = (next: T | ((p: T) => T)) => {
    setV((prev) => {
      const val = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      try {
        sessionStorage.setItem('dr.' + key, JSON.stringify(val));
      } catch {
        /* ignore */
      }
      return val;
    });
  };
  return [v, set];
}
