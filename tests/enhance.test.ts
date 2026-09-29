import { describe, expect, it } from 'vitest';
import { planEnhance } from '../src/shared/enhance';

describe('planEnhance', () => {
  it('pre-upscales small pictures with SeedVR2 (QA: 320 px JPEG came out soft without it)', () => {
    expect(planEnhance(320, 213)).toEqual({ megapixels: 1, preScale: 4 });
    expect(planEnhance(640, 426)).toEqual({ megapixels: 1, preScale: 2 }); // 1.92x -> 2x = 1.09 MP
    expect(planEnhance(480, 320)).toEqual({ megapixels: 1, preScale: 3 }); // 2.55x rounds up to 3x
    expect(planEnhance(560, 420)).toEqual({ megapixels: 1, preScale: 2.5 }); // 2.07x rounds up to 2.5x
  });
  it('enhances pictures near the working size directly', () => {
    expect(planEnhance(1024, 1024).preScale).toBeNull();
    expect(planEnhance(800, 700).preScale).toBeNull(); // 0.56 MP >= half of 1 MP
    expect(planEnhance(2048, 2048)).toEqual({ megapixels: 2, preScale: null });
  });
  it('never asks SeedVR2 for less than 2x or more than 4x', () => {
    expect(planEnhance(700, 700).preScale).toBe(2);
    expect(planEnhance(100, 100).preScale).toBe(4);
    expect(planEnhance(0, 0).preScale).toBeNull();
  });
});
