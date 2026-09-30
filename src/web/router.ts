import { useSyncExternalStore } from 'react';

export type Screen = 'generate' | 'edit' | 'video' | 'library';
export interface Route {
  screen: Screen;
  id?: string;
  query: URLSearchParams;
}

function parse(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  const [pathPart, qs] = h.split('?');
  const [screen, id] = pathPart.split('/');
  const s: Screen = (['generate', 'edit', 'video', 'library'] as const).includes(screen as Screen) ? (screen as Screen) : 'generate';
  return { screen: s, id: id || undefined, query: new URLSearchParams(qs ?? '') };
}

const LAST = 'dr.lastRoute';

/**
 * Opening Darkroom without a screen in the URL (the desktop shortcut, a bookmark of the root) returns to the screen
 * you last used, including the picture open in Edit or the take in Video. One-off handoff parameters are not kept.
 */
function restoreLast(): void {
  if (location.hash.replace(/^#\/?/, '')) return;
  try {
    const last = localStorage.getItem(LAST);
    if (last) history.replaceState(null, '', `${location.pathname}${location.search}#/${last}`);
  } catch {
    /* storage unavailable: start on Generate */
  }
}

function remember(r: Route): void {
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

restoreLast();
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
