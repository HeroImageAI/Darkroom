/**
 * Large pictures (DECISIONS 79). Klein and Qwen draw at about 1 MP; the graphs scale a whole-picture result back to
 * the source size, so a 12 MP photo keeps its size but only ~1 MP of real detail (Restore even returned ~1 MP).
 * SeedVR2 (upscale v3, with an exact final size) rebuilds the detail at the original size.
 */

/** From this size on, a whole-picture result is noticeably softer than the original. */
export const BIG_PICTURE_MP = 2;
/** SeedVR2 range used by the upscale graph. */
const MAX_SCALE = 8;
/** Longest side Darkroom will upscale to (memory and time stay reasonable on a 24 GB card). */
export const MAX_SIDE = 8192;

export const isBig = (w: number, h: number) => w * h >= BIG_PICTURE_MP * 1e6;

/** The size ImageScaleToTotalPixels gives for `mp` megapixels (ComfyUI counts 1 MP as 1024 x 1024). */
export function workingSize(w: number, h: number, mp = 1): { w: number; h: number } {
  const s = Math.sqrt((mp * 1024 * 1024) / (w * h));
  return { w: Math.round(w * s), h: Math.round(h * s) };
}

export interface FullSizePlan {
  /** Pre-shrink (longest side) before SeedVR2, or undefined to use the picture as it is. */
  preshrink?: number;
  scale: number;
  target_w: number;
  target_h: number;
}

/** Upscale a result of size `from` to exactly `to` (Restore / Subtle on a large photo). */
export function backToSize(from: { w: number; h: number }, to: { w: number; h: number }): FullSizePlan {
  const scale = Math.min(MAX_SCALE, Math.ceil(Math.max(to.w / from.w, to.h / from.h) * 1000) / 1000);
  return { scale: Math.max(1, scale), target_w: to.w, target_h: to.h };
}

/**
 * "Sharpen to full resolution" for a whole-picture edit already enlarged to the original size: shrink it back to the
 * size it was really drawn at (so SeedVR2 sees clean pixels, not the lanczos blow-up), then rebuild up to full size.
 */
export function sharpenPlan(w: number, h: number, mp = 1): FullSizePlan {
  const work = workingSize(w, h, mp);
  const plan = backToSize(work, { w, h });
  return { ...plan, preshrink: Math.max(work.w, work.h) };
}

/** Restore + upscale on a large photo: twice the original, capped at MAX_SIDE on the long side. */
export function doubledTarget(w: number, h: number): { w: number; h: number } {
  const k = Math.min(2, MAX_SIDE / Math.max(w, h));
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

/** ComfyUI's megapixel unit (ImageScaleToTotalPixels): 1 MP = 1024 x 1024. */
const COMFY_MP = 1024 * 1024;
/** Klein + the restore LoRA stays sharp up to here (DECISIONS 83); beyond it SeedVR2 finishes the job. */
export const LARGE_RESTORE_MP = 4;

export interface LargeRestorePlan {
  /** Working size for Klein + LoRA, in ComfyUI megapixels. */
  megapixels: number;
  /** Exact output size from the graph itself (photos up to ~4 MP come back at exactly their own size). */
  exact?: { w: number; h: number };
  /** SeedVR2 to this size afterwards (photos above 4 MP, or Restore + upscale). */
  chainTo?: { w: number; h: number };
}

/**
 * Klein Restore of a large photo (2 MP and up) with the restore LoRA (DECISIONS 83): draw at the photo's own size up
 * to 4 MP; larger photos are drawn at 4 MP and SeedVR2 takes them to full size. `doubled` = Restore + upscale.
 */
export function planLargeRestore(w: number, h: number, doubled = false): LargeRestorePlan | null {
  if (!isBig(w, h)) return null;
  const mp = (w * h) / COMFY_MP;
  const megapixels = Math.round(Math.min(LARGE_RESTORE_MP, mp) * 100) / 100;
  if (doubled) return { megapixels, chainTo: doubledTarget(w, h) };
  // within ~5% of 4 MP the drawn size is the photo's size, so a resample is enough
  return mp <= LARGE_RESTORE_MP * 1.05 ? { megapixels, exact: { w, h } } : { megapixels, chainTo: { w, h } };
}
