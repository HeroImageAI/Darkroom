/**
 * Enhance planning. Klein / Qwen img2img at enhance strengths keeps whatever blur and JPEG blocking the
 * working image has, so a small source that would be lanczos-enlarged to the working size comes out soft.
 * Such sources are first upscaled with SeedVR2 (a real restorer), then enhanced (Phase 6 QA, DECISIONS 55).
 */
export interface EnhancePlan {
  /** Working size for the diffusion pass, in megapixels (1–2). */
  megapixels: number;
  /** SeedVR2 multiplier to run first, or null when the source is already big enough. */
  preScale: number | null;
}

export function planEnhance(width: number, height: number): EnhancePlan {
  const srcMP = (width * height) / 1e6;
  const megapixels = Math.round(Math.min(2, Math.max(1, srcMP)) * 100) / 100;
  if (!(srcMP > 0) || srcMP >= megapixels * 0.5) return { megapixels, preScale: null };
  // linear factor to reach the working size, rounded up to a half step, within SeedVR2's 2–4x range
  const k = Math.sqrt(megapixels / srcMP);
  return { megapixels, preScale: Math.min(4, Math.max(2, Math.ceil(k * 2) / 2)) };
}
