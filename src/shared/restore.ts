/**
 * Restore (DECISIONS 100): long clips are restored in windows of 97 frames (4 s at 24 fps). Each window after the
 * first starts 17 frames before the previous one ended and is guided by those 17 restored frames, so the windows
 * join without a jump (Lightricks' chaining); those overlap frames are dropped when joining. Window lengths keep
 * LTX's 8n+1 grid; at most 7 frames at the very end can be left out.
 */
export const RESTORE_WINDOW = 97;
export const RESTORE_OVERLAP = 17;
export const RESTORE_MAX_WINDOWS = 8;

export interface RestoreWindow {
  start: number;
  length: number;
  /** frames to drop at the start of this window's output when joining (the overlap) */
  skip: number;
}

export function restoreWindows(total: number, L = RESTORE_WINDOW, O = RESTORE_OVERLAP, max = RESTORE_MAX_WINDOWS): RestoreWindow[] {
  const grid = (n: number) => Math.floor((n - 1) / 8) * 8 + 1;
  const out: RestoreWindow[] = [];
  let start = 0;
  while (out.length < max) {
    const left = total - start;
    if (left < 9 || (out.length && left <= O)) break;
    const length = Math.min(L, grid(left));
    out.push({ start, length, skip: out.length ? O : 0 });
    if (start + length >= total - 7) break;
    start = start + length - O;
  }
  return out;
}

/** Frames of the source the restored clip covers. */
export const restoredFrames = (w: RestoreWindow[]) => (w.length ? w[w.length - 1].start + w[w.length - 1].length : 0);

/** The working canvas: the clip's shape at up to 1280 px on the long side, sides multiples of 32 (fits the card). */
export function restoreCanvas(w: number, h: number, long = 1280): { width: number; height: number } {
  const s = long / Math.max(w, h);
  const r32 = (v: number) => Math.max(256, Math.floor(v / 32) * 32);
  return { width: r32(w * s), height: r32(h * s) };
}
