import { useSyncExternalStore } from 'react';

export type Screen = 'home' | 'generate' | 'edit' | 'compose' | 'video' | 'timeline' | 'library' | 'setup';
export interface Route {
  screen: Screen;
  id?: string;
  query: URLSearchParams;
}

function parse(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  const [pathPart, qs] = h.split('?');
  const [screen, id] = pathPart.split('/');
  const s: Screen = (['home', 'generate', 'edit', 'compose', 'video', 'timeline', 'library', 'setup'] as const).includes(screen as Screen) ? (screen as Screen) : 'home';
  return { screen: s, id: id || undefined, query: new URLSearchParams(qs ?? '') };
}

const LAST = 'dr.lastRoute';

/**
 * Darkroom opens on Home (no screen in the address). The last screen you worked on — including the picture open in
 * Edit or the take in Video — is remembered and offered on Home as "Continue where you left off".
 * One-off handoff parameters (e.g. from "Use as…") are not kept.
 */
function remember(r: Route): void {
  if (r.screen === 'home') return;
  const keep = new URLSearchParams();
  const take = r.query.get('take');
  if (r.screen === 'video' && take) keep.set('take', take);
  const qs = keep.toString();
  try {
    localStorage.setItem(LAST, `${r.screen}${r.id ? '/' + r.id : ''}${qs ? '?' + qs : ''}`);
  } catch {
    /* ignore */
  }
}

/** The last screen worked on, as a hash path like "edit/<id>", or null. */
export function lastRoute(): { screen: Screen; path: string } | null {
  try {
    const last = localStorage.getItem(LAST);
    if (!last) return null;
    const screen = last.split(/[/?]/)[0] as Screen;
    // Compose is part of Edit now (DECISIONS 126): no "continue" back to it
    return ['generate', 'edit', 'video', 'timeline', 'library'].includes(screen) ? { screen, path: last } : null;
  } catch {
    return null;
  }
}

let current = parse();
remember(current);
const subs = new Set<() => void>();
window.addEventListener('hashchange', () => {
  current = parse();
  remember(current);
  subs.forEach((s) => s());
});

export function useRoute(): Route {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => current,
  );
}

export function go(screen: Screen, id?: string, query?: Record<string, string>): void {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  location.hash = `#/${screen}${id ? '/' + id : ''}${qs}`;
}
