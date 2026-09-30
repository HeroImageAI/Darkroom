import { describe, expect, it } from 'vitest';
import { maskBBox, planCrop } from '../src/shared/cropstitch';

function rgba(w: number, h: number, box: { x: number; y: number; w: number; h: number }) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) d[(y * w + x) * 4 + 3] = 255;
  return d;
}

describe('maskBBox', () => {
  it('finds the painted area', () => {
    expect(maskBBox(rgba(100, 80, { x: 10, y: 20, w: 30, h: 5 }), 100, 80)).toEqual({ x: 10, y: 20, w: 30, h: 5 });
  });
  it('returns null for an empty mask', () => {
    expect(maskBBox(new Uint8ClampedArray(40 * 4), 10, 4)).toBeNull();
  });
});

describe('planCrop (One Node rules, core-node crop-and-stitch)', () => {
  it('a small mask on a big picture: crop around it and sample at a higher resolution', () => {
    const p = planCrop({ x: 1900, y: 1000, w: 200, h: 120 }, 4000, 3000);
    // context box: max(bbox*1.5, bbox + 64 pad, 256) -> 300 x 256, centred on the mask
    expect(p.crop).toEqual({ x: 1850, y: 932, w: 300, h: 256 });
    // long side 300 * 1.5 = 450 -> rounded up to 64 = 512 (also the minimum)
    expect(Math.max(p.target.w, p.target.h)).toBe(512);
    expect(p.target.w / p.target.h).toBeCloseTo(300 / 256, 1);
  });
  it('a large mask is capped at 1536 on the long side', () => {
    const p = planCrop({ x: 100, y: 100, w: 1800, h: 1200 }, 2400, 1600);
    expect(Math.max(p.target.w, p.target.h)).toBe(1536);
    expect(p.target.w % 16).toBe(0);
    expect(p.target.h % 16).toBe(0);
  });
  it('the crop stays inside the image when the mask touches an edge', () => {
    const p = planCrop({ x: 0, y: 700, w: 150, h: 100 }, 1024, 768);
    expect(p.crop.x).toBe(0);
    expect(p.crop.y + p.crop.h).toBeLessThanOrEqual(768);
    expect(p.crop.x + p.crop.w).toBeLessThanOrEqual(1024);
  });
  it('the crop always contains the mask plus its blend padding', () => {
    const b = { x: 500, y: 300, w: 40, h: 400 };
    const p = planCrop(b, 1344, 768);
    expect(p.crop.x).toBeLessThanOrEqual(b.x - 32);
    expect(p.crop.x + p.crop.w).toBeGreaterThanOrEqual(b.x + b.w + 32);
    expect(p.crop.y).toBeLessThanOrEqual(Math.max(0, b.y - 32));
  });
  it('never crops more than the image', () => {
    const p = planCrop({ x: 0, y: 0, w: 1024, h: 1024 }, 1024, 1024);
    expect(p.crop).toEqual({ x: 0, y: 0, w: 1024, h: 1024 });
  });
});
