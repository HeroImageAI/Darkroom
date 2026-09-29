import { describe, expect, it } from 'vitest';
import { padToAspect, zoomOut } from '../src/web/lib/mask';

describe('outpaint padding', () => {
  it('pads a square to 16:9 horizontally, evenly, in multiples of 8', () => {
    const p = padToAspect(1024, 1024, 16 / 9);
    expect(p.top + p.bottom).toBe(0);
    expect((p.left + p.right) % 8).toBe(0);
    expect(p.left % 8).toBe(0);
    expect(Math.abs(p.left - p.right)).toBeLessThanOrEqual(8);
    expect(Math.abs((1024 + p.left + p.right) / 1024 - 16 / 9)).toBeLessThan(0.01);
  });
  it('pads a wide image to 1:1 vertically', () => {
    const p = padToAspect(1344, 768, 1);
    expect(p.left + p.right).toBe(0);
    expect(768 + p.top + p.bottom).toBe(1344);
  });
  it('zooms out 1.5x on all sides', () => {
    expect(zoomOut(1024, 768, 1.5)).toEqual({ left: 256, right: 256, top: 192, bottom: 192 });
  });
});
