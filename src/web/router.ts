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

let current = parse();
const subs = new Set<() => void>();
window.addEventListener('hashchange', () => {
  current = parse();
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
