import { api } from '../api';
import { getState, onJob } from '../store';

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
    if (/.(heic|heif)$/i.test(f.name)) {
      failed.push(f.name); // HEIC can't be decoded here (codec licence); see importFailedMessage
      onProgress?.(i + 1, pics.length);
      continue;
    }
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
export function waitForItem(jobId: string, timeoutMs = 180_000): Promise<string> {
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

/** Notice text for files that could not be brought in. */
export function importFailedMessage(failed: string[]): string {
  const heic = failed.filter((f) => /.(heic|heif)$/i.test(f));
  const other = failed.filter((f) => !heic.includes(f));
  return [
    heic.length ? `${heic.join(', ')}: iPhone HEIC photos can't be opened here. Save them as JPEG first (Windows Photos → ⋯ → Save as → .jpg, or set the iPhone camera to "Most Compatible").` : '',
    other.length ? `Could not bring in ${other.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** A frame of a video file at time t (seconds; t < 0 = from the end), as a PNG blob, plus the video's size and length. */
async function videoFrame(file: File, t: number): Promise<{ png: Blob; width: number; height: number; duration: number }> {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = url;
    await new Promise<void>((ok, bad) => {
      v.onloadedmetadata = () => ok();
      v.onerror = () => bad(new Error('unreadable'));
    });
    const at = t < 0 ? Math.max(0, v.duration + t) : Math.min(t, v.duration);
    await new Promise<void>((ok, bad) => {
      v.onseeked = () => ok();
      v.onerror = () => bad(new Error('unreadable'));
      v.currentTime = at;
    });
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    const png = await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('no frame'))), 'image/png'));
    return { png, width: v.videoWidth, height: v.videoHeight, duration: v.duration };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Your own videos into the Library (DECISIONS 100). The file is kept as it is; the browser takes its first and last
 * frames (thumbnail, Extend). Files the browser cannot play (some iPhone HEVC .mov) are reported, not stored.
 */
export async function importVideos(files: File[], onProgress?: (done: number, total: number) => void): Promise<{ ids: string[]; failed: string[] }> {
  const vids = files.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name));
  const ids: string[] = [];
  const failed: string[] = [];
  for (const [i, f] of vids.entries()) {
    try {
      const first = await videoFrame(f, 0.05);
      const last = await videoFrame(f, -0.05);
      const [video, poster, end] = [await api.upload(f, f.name), await api.upload(first.png, 'poster.png'), await api.upload(last.png, 'last.png')];
      const item = await api.post<{ id: string }>('/api/import/video', {
        video: video.name,
        poster: poster.name,
        last: end.name,
        name: f.name.replace(/\.[a-z0-9]+$/i, ''),
        width: first.width,
        height: first.height,
        duration: first.duration,
        boardId: getState().board,
      });
      ids.push(item.id);
    } catch {
      failed.push(f.name);
    }
    onProgress?.(i + 1, vids.length);
  }
  return { ids, failed };
}

export const isVideoFile = (f: File) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name);
