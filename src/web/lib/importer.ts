import { api } from '../api';
import { onJob } from '../store';

/**
 * Bring your own pictures into the Library (Home, Edit, Library "Upload"). Each file is uploaded to ComfyUI's input
 * folder and saved as a library item by the `import` workflow, so it can be edited like anything Darkroom made.
 * Everything stays on this PC. Resolves with the new item ids, in the order given; files that fail are skipped.
 */
export async function importPictures(files: File[], onProgress?: (done: number, total: number) => void): Promise<{ ids: string[]; failed: string[] }> {
  const pics = files.filter((f) => f.type.startsWith('image/'));
  const ids: string[] = [];
  const failed: string[] = [];
  for (const [i, f] of pics.entries()) {
    try {
      const up = await api.upload(f, f.name);
      const job = await api.submit({ workflow: 'import', params: { image_1: up.name }, meta: { mode: 'import', model: 'Imported', prompt: f.name.replace(/\.[a-z0-9]+$/i, '') } });
      ids.push(await waitForItem(job.id));
    } catch {
      failed.push(f.name);
    }
    onProgress?.(i + 1, pics.length);
  }
  return { ids, failed };
}

/** Job finished → its item id. Listens for the live update and also polls, so a very fast import is never missed. */
function waitForItem(jobId: string, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      stop();
      clearInterval(poll);
      clearTimeout(timer);
      fn();
    };
    const stop = onJob((j) => {
      if (j.id !== jobId) return;
      if (j.status === 'done' && j.result_ids[0]) finish(() => resolve(j.result_ids[0]));
      else if (j.status === 'error' || j.status === 'lost' || j.status === 'cancelled') finish(() => reject(new Error(j.error ?? 'Import failed')));
    });
    const check = () =>
      api
        .get<{ id: string }[]>(`/api/jobs/${jobId}/items`)
        .then((items) => items[0] && finish(() => resolve(items[0].id)))
        .catch(() => undefined);
    const poll = setInterval(check, 1500);
    const timer = setTimeout(() => finish(() => reject(new Error('Import timed out'))), timeoutMs);
    void check();
  });
}
