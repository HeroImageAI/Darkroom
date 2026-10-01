import { describe, expect, it } from 'vitest';
import { backToSize, doubledTarget, isBig, planLargeRestore, sharpenPlan, workingSize } from '../src/shared/fullsize';

describe('large pictures', () => {
  it('counts 2 MP and up as large', () => {
    expect(isBig(1344, 768)).toBe(false);
    expect(isBig(4000, 3000)).toBe(true);
  });
  it('matches ComfyUI working size (the 12 MP photo came back from Restore at 1184x880)', () => {
    const w = workingSize(4000, 3000);
    expect(Math.abs(w.w - 1182)).toBeLessThanOrEqual(2);
    expect(Math.abs(w.h - 887)).toBeLessThanOrEqual(2);
  });
  it('scales a result back to the exact original size, even when its aspect differs slightly', () => {
    const p = backToSize({ w: 1184, h: 880 }, { w: 4000, h: 3000 });
    expect(p.target_w).toBe(4000);
    expect(p.target_h).toBe(3000);
    expect(1184 * p.scale).toBeGreaterThanOrEqual(4000);
    expect(880 * p.scale).toBeGreaterThanOrEqual(3000);
    expect(p.scale).toBeLessThanOrEqual(8);
  });
  it('sharpen shrinks to the drawn size first, then rebuilds to full size', () => {
    const p = sharpenPlan(4000, 3000);
    expect(p.preshrink).toBe(1182);
    expect(p.target_w).toBe(4000);
    expect(Math.round(1182 * p.scale)).toBeGreaterThanOrEqual(4000);
  });
  it('Restore + upscale doubles a large photo but stays within 8192 px', () => {
    expect(doubledTarget(3000, 2000)).toEqual({ w: 6000, h: 4000 });
    expect(doubledTarget(6000, 4000)).toEqual({ w: 8192, h: 5461 });
  });
});

describe('large-photo Restore with the restore LoRA', () => {
  it('leaves small pictures to the normal Restore', () => {
    expect(planLargeRestore(1344, 768)).toBeNull();
  });
  it('draws a photo up to 4 MP at its own size and returns it exactly', () => {
    expect(planLargeRestore(2528, 1696)).toEqual({ megapixels: 4, exact: { w: 2528, h: 1696 } });
    expect(planLargeRestore(1920, 1280)).toEqual({ megapixels: 2.34, exact: { w: 1920, h: 1280 } });
  });
  it('draws a bigger photo at 4 MP and lets SeedVR2 take it to full size', () => {
    expect(planLargeRestore(4000, 3000)).toEqual({ megapixels: 4, chainTo: { w: 4000, h: 3000 } });
  });
  it('Restore + upscale doubles, capped at 8192 px', () => {
    expect(planLargeRestore(4000, 3000, true)).toEqual({ megapixels: 4, chainTo: { w: 8000, h: 6000 } });
    expect(planLargeRestore(6000, 4000, true)).toEqual({ megapixels: 4, chainTo: { w: 8192, h: 5461 } });
  });
});
