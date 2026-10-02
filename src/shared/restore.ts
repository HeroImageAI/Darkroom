import type { ApiPrompt } from './workflow.js';

/**
 * Restore (DECISIONS 100): long clips are restored in windows of 97 frames (4 s at 24 fps). Each window after the
 * first starts 17 frames before the previous one ended and is guided by those 17 restored frames, so the windows
 * join without a jump (Lightricks' chaining). When joining, the 17 overlap frames are crossfaded (the guided frames
 * come back a little different after the VAE, which would show as a step at a hard cut). Window lengths keep
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
    if (left < 9 || (out.length && left < O + 8)) break; // a window after the first must add 8 new frames or more
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

/**
 * The graph that joins restored windows into one clip, built for exactly these parts: each part's own frames, the
 * overlaps crossfaded (a ramp of 17 masks), one encode at the end, and the source's sound put back (trimmed to the
 * restored length) unless it has none.
 */
export function restoreJoinPrompt(a: { source: string; parts: string[]; windows: RestoreWindow[]; sound: boolean; output?: string }): ApiPrompt {
  const O = RESTORE_OVERLAP;
  const g: ApiPrompt = {};
  let next = 1;
  const node = (class_type: string, title: string, inputs: Record<string, unknown>) => {
    const id = String(next++);
    g[id] = { class_type, inputs, _meta: { title } } as ApiPrompt[string];
    return id;
  };
  const src = node('LoadVideo', 'DR_VIDEO', { file: a.source });
  const srcParts = node('GetVideoComponents', 'Source', { video: [src, 0] });
  const parts = a.parts.map((file, i) => node('GetVideoComponents', `Part ${i + 1}`, { video: [node('LoadVideo', `DR_PART_${i + 1}`, { file }), 0] }));
  const size = node('GetImageSize', 'Size', { image: [parts[0], 0] });
  const ramp =
    parts.length > 1
      ? node('BatchMasksNode', 'Crossfade ramp', Object.fromEntries(Array.from({ length: O }, (_, j) => [`masks.mask${j}`, [node('SolidMask', `Ramp ${j + 1}`, { value: Math.round(((j + 1) / (O + 1)) * 1000) / 1000, width: [size, 0], height: [size, 1] }), 0]])))
      : '';
  const slice = (p: string, from: number, length: number, title: string) => node('ImageFromBatch', title, { image: [p, 0], batch_index: from, length });
  const segments: string[] = [];
  a.windows.forEach((w, i) => {
    if (i > 0) {
      const prev = a.windows[i - 1];
      const tail = slice(parts[i - 1], prev.length - O, O, `Part ${i} tail`);
      const head = slice(parts[i], 0, O, `Part ${i + 1} head`);
      segments.push(node('ImageCompositeMasked', `Crossfade ${i}`, { destination: [tail, 0], source: [head, 0], x: 0, y: 0, resize_source: false, mask: [ramp, 0] }));
    }
    const from = i > 0 ? O : 0;
    const to = i < a.windows.length - 1 ? w.length - O : w.length;
    if (to > from) segments.push(slice(parts[i], from, to - from, `Part ${i + 1} frames`));
  });
  const frames = segments.length === 1 ? segments[0] : node('BatchImagesNode', 'Joined', Object.fromEntries(segments.map((s, k) => [`images.image${k}`, [s, 0]])));
  const total = restoredFrames(a.windows);
  const video: Record<string, unknown> = { images: [frames, 0], fps: [srcParts, 2] };
  if (a.sound) {
    const len = node('ComfyMathExpression', 'Restored seconds', { expression: `${total} / a`, 'values.a': [srcParts, 2] });
    video.audio = [node('TrimAudioDuration', 'Sound', { audio: [srcParts, 1], start_index: 0, duration: [len, 0] }), 0];
  }
  const created = node('CreateVideo', 'Create video', video);
  node('SaveVideo', 'DR_OUTPUT', { video: [created, 0], filename_prefix: a.output ?? 'darkroom/video/restored', format: 'mp4', 'format.codec': 'h264' });
  node('SaveImage', 'DR_POSTER', { images: [slice(frames, 0, 1, 'Poster frame'), 0], filename_prefix: 'darkroom/video/restored_poster' });
  node('SaveImage', 'DR_LAST_FRAME', { images: [slice(frames, 4095, 1, 'Last frame'), 0], filename_prefix: 'darkroom/video/restored_last' });
  return g;
}
