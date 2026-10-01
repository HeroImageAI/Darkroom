import { api } from '../api';
import { toast } from '../store';

/**
 * Delete from anywhere (Library, Generate History, Video Takes): items go to the Library's "Recently deleted", and the
 * notice offers Undo. Every panel is a view of the Library, so the item disappears everywhere at once.
 */
export async function deleteWithUndo(ids: string[], what = 'item'): Promise<string[]> {
  if (!ids.length) return [];
  try {
    const r = await api.deleteItems(ids);
    const n = r.deleted.length;
    toast(`${n === 1 ? `1 ${what}` : `${n} ${what}s`} moved to Recently deleted.`, 'ok', 8000, {
      label: 'Undo',
      run: () => void api.restoreItems(r.deleted).then(() => toast('Restored.', 'ok')),
    });
    return r.deleted;
  } catch (e) {
    toast((e as Error).message, 'error');
    return [];
  }
}

/** Show the Library on a given filter (the "See all in Library" links). */
export function openLibrary(filter: 'all' | 'videos' = 'all'): void {
  try {
    localStorage.setItem('dr.library.filter', JSON.stringify(filter));
  } catch {
    /* ignore */
  }
  location.hash = '#/library';
}
