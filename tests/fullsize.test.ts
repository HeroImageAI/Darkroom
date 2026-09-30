import { describe, expect, it } from 'vitest';
import { backToSize, doubledTarget, isBig, sharpenPlan, workingSize } from '../src/shared/fullsize';

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
