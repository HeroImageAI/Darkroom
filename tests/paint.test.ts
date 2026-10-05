import { describe, expect, it } from 'vitest';
import { floodMask, growMask } from '../src/shared/flood';
import { hexToHsv, hexToRgb, hsvToHex, rgbToHex } from '../src/shared/colour';

/** w×h RGBA, all `fill`, with a vertical wall of `wall` at column `wx`. */
function canvas(w: number, h: number, fill: number[], wall?: { x: number; c: number[] }): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = wall && x === wall.x ? wall.c : fill;
      d.set(c, (y * w + x) * 4);
    }
  return d;
}

describe('fill bucket', () => {
  it('fills up to a wall, not past it', () => {
    const d = canvas(10, 6, [255, 255, 255, 255], { x: 4, c: [0, 0, 0, 255] });
    const r = floodMask(d, 10, 6, 1, 1, 10)!;
    expect(r.count).toBe(4 * 6);
    expect(r.box).toEqual({ x: 0, y: 0, w: 4, h: 6 });
    expect(r.mask[5]).toBe(0); // beyond the wall
  });

  it('takes every matching pixel when not contiguous', () => {
    const d = canvas(10, 6, [255, 255, 255, 255], { x: 4, c: [0, 0, 0, 255] });
    expect(floodMask(d, 10, 6, 1, 1, 10, false)!.count).toBe(9 * 6);
  });

  it('tolerance lets near colours in', () => {
    const d = canvas(10, 2, [200, 200, 200, 255], { x: 5, c: [190, 200, 200, 255] });
    expect(floodMask(d, 10, 2, 0, 0, 5)!.count).toBe(5 * 2);
    expect(floodMask(d, 10, 2, 0, 0, 12)!.count).toBe(10 * 2);
  });

  it('treats all transparent pixels as one colour, and refuses a click outside', () => {
    const d = canvas(4, 4, [0, 0, 0, 0]);
    d.set([255, 0, 0, 0], 0); // transparent but red channels
    expect(floodMask(d, 4, 4, 2, 2, 0)!.count).toBe(16);
    expect(floodMask(d, 4, 4, -1, 2, 0)).toBeNull();
  });

  it('grows a mask by a pixel', () => {
    const m = new Uint8Array(9);
    m[4] = 255;
    expect(Array.from(growMask(m, 3, 3, 1))).toEqual([0, 255, 0, 255, 255, 255, 0, 255, 0]);
  });
});

describe('colour', () => {
  it('converts hex, rgb and hsv both ways', () => {
    expect(hexToRgb('#d02020')).toEqual([208, 32, 32]);
    expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
    expect(hexToRgb('nope')).toBeNull();
    expect(rgbToHex(208, 32, 32)).toBe('#d02020');
    const hsv = hexToHsv('#d02020');
    expect(hsv.h).toBeCloseTo(0);
    expect(hsv.s).toBeCloseTo(176 / 208);
    for (const c of ['#d02020', '#20d0a0', '#123456', '#ffffff', '#000000', '#7f7f7f']) expect(hsvToHex(hexToHsv(c))).toBe(c);
  });
});
