import { describe, expect, it } from 'vitest';
import { outpaintFeather, outpaintMask, snapPad } from '../src/shared/outpaint';

const px = (w: number, h: number, fill: [number, number, number]) => {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set([...fill, 255], i * 4);
  return d;
};

describe('outpaintFeather (One Node rule)', () => {
  it('Auto = min(48, short side / 6)', () => {
    expect(outpaintFeather(1344, 768)).toBe(48);
    expect(outpaintFeather(300, 200)).toBe(33);
  });
  it('override is capped at 256 and at half the short side', () => {
    expect(outpaintFeather(2000, 2000, 400)).toBe(256);
    expect(outpaintFeather(300, 200, 150)).toBe(100);
  });
});

describe('snapPad', () => {
  it('rounds the canvas to the step, adding only on padded sides', () => {
    const p = snapPad(1344, 768, { left: 100, top: 0, right: 100, bottom: 0 }, 32);
    expect((1344 + p.left + p.right) % 32).toBe(0);
    expect(p.top + p.bottom).toBe(0);
    const q = snapPad(1000, 700, { left: 0, top: 0, right: 150, bottom: 0 }, 8);
    expect(q.left).toBe(0);
    expect((1000 + q.right) % 8).toBe(0);
  });
});

describe('outpaintMask', () => {
  it('new area white, original black, gradient only from the extended sides into the original', () => {
    const m = outpaintMask(100, 50, { left: 0, top: 0, right: 20, bottom: 0 }, 10, null);
    const W = 120;
    expect(m[10 * W + 110]).toBe(255); // padded area
    expect(m[10 * W + 99]).toBe(255); // original pixel on the seam: fully masked
    expect(m[10 * W + 95]).toBeGreaterThan(0); // inside the feather band
    expect(m[10 * W + 95]).toBeLessThan(255);
    expect(m[10 * W + 50]).toBe(0); // deep inside the original
    expect(m[10 * W + 0]).toBe(0); // the left side is not extended, so no fade there
  });
  it('fills leftover black connected to an extended edge, but not dark content inside the picture', () => {
    const w = 60, h = 20;
    const src = px(w, h, [120, 120, 120]);
    for (let y = 0; y < h; y++) for (let x = 50; x < w; x++) src.set([0, 0, 0], (y * w + x) * 4); // black strip at the right edge
    for (let y = 5; y < 10; y++) for (let x = 10; x < 20; x++) src.set([5, 5, 5], (y * w + x) * 4); // a dark object in the middle
    const m = outpaintMask(w, h, { left: 0, top: 0, right: 8, bottom: 0 }, 2, src);
    const W = w + 8;
    expect(m[10 * W + 45]).toBe(0); // grey original stays
    expect(m[10 * W + 52]).toBe(255); // leftover black strip touching the extended edge is repainted
    expect(m[7 * W + 15]).toBe(0); // the dark object in the middle is NOT (One Node's global rule would repaint it)
  });
});
