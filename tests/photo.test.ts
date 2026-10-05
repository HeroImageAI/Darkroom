import { describe, expect, it } from 'vitest';
import { autoLevels, curveTable, histogram, isNeutral, mergeAdjust, NEUTRAL, toneTable } from '../src/shared/adjust';
import { border, colourRange, combine, growShrink, maskBox } from '../src/shared/selection';
import { convexQuad, homography, project, triangleAffine } from '../src/shared/warp';

describe('adjustments', () => {
  it('a straight curve and neutral settings change nothing', () => {
    const t = curveTable([]);
    expect(t[0]).toBe(0);
    expect(t[128]).toBeCloseTo(128 / 255, 5);
    const tone = toneTable(NEUTRAL);
    for (const i of [0, 37, 128, 200, 255]) expect([tone[i * 4], tone[i * 4 + 1], tone[i * 4 + 2]]).toEqual([i, i, i]);
    expect(isNeutral(mergeAdjust({}))).toBe(true);
    expect(isNeutral(mergeAdjust({ contrast: 0.1 }))).toBe(false);
  });

  it('a curve through its points never overshoots', () => {
    const t = curveTable([
      { x: 0.25, y: 0.15 },
      { x: 0.75, y: 0.9 },
    ]);
    expect(t[Math.round(0.25 * 255)]).toBeCloseTo(0.15, 1);
    expect(t[Math.round(0.75 * 255)]).toBeCloseTo(0.9, 1);
    for (let i = 1; i < 256; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1] - 1e-6);
  });

  it('levels stretch the range; exposure brightens; contrast spreads', () => {
    const lv = toneTable(mergeAdjust({ levels: { black: 50, white: 200, gamma: 1, outBlack: 0, outWhite: 255 } }));
    expect(lv[50 * 4]).toBe(0);
    expect(lv[200 * 4]).toBe(255);
    expect(lv[125 * 4]).toBeGreaterThan(120);
    expect(toneTable(mergeAdjust({ exposure: 1 }))[64 * 4]).toBe(128);
    const c = toneTable(mergeAdjust({ contrast: 0.5 }));
    expect(c[64 * 4]).toBeLessThan(64);
    expect(c[192 * 4]).toBeGreaterThan(192);
  });

  it('per-channel curves only touch their channel', () => {
    const t = toneTable(mergeAdjust({ curves: { rgb: [], r: [{ x: 0.5, y: 0.7 }], g: [], b: [] } }));
    expect(t[128 * 4]).toBeGreaterThan(160);
    expect(t[128 * 4 + 1]).toBe(128);
  });

  it('histogram and auto levels find the used range', () => {
    const d = new Uint8Array(4 * 100);
    for (let i = 0; i < 100; i++) d.set([40 + i, 40 + i, 40 + i, 255], i * 4);
    const h = histogram(d);
    expect(h.l[40]).toBe(1);
    expect(autoLevels(h.l, 0)).toEqual({ black: 40, white: 139 });
  });
});

describe('selections', () => {
  const sq = (w: number, h: number, x0: number, y0: number, x1: number, y1: number) => {
    const m = new Uint8Array(w * h);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * w + x] = 255;
    return m;
  };
  it('grows and shrinks by a distance', () => {
    const m = sq(30, 30, 10, 10, 19, 19);
    expect(maskBox(growShrink(m, 30, 30, 3), 30, 30)).toEqual({ x: 7, y: 7, w: 16, h: 16 });
    expect(maskBox(growShrink(m, 30, 30, -3), 30, 30)).toEqual({ x: 13, y: 13, w: 4, h: 4 });
  });
  it('a border is a band round the edge', () => {
    const b = border(sq(30, 30, 10, 10, 19, 19), 30, 30, 4);
    expect(b[15 * 30 + 15]).toBe(0); // middle
    expect(b[15 * 30 + 10]).toBe(255); // edge
    expect(b[15 * 30 + 3]).toBe(0); // far outside
  });
  it('combines masks', () => {
    const a = new Uint8Array([255, 255, 0, 0]);
    const b = new Uint8Array([255, 0, 255, 0]);
    expect(Array.from(combine(a, b, 'add'))).toEqual([255, 255, 255, 0]);
    expect(Array.from(combine(a, b, 'subtract'))).toEqual([0, 255, 0, 0]);
    expect(Array.from(combine(a, b, 'intersect'))).toEqual([255, 0, 0, 0]);
  });
  it('selects a colour range with a soft edge', () => {
    const d = new Uint8Array([200, 30, 30, 255, 180, 40, 40, 255, 20, 200, 20, 255]);
    const m = colourRange(d, 3, 1, [200, 30, 30], 12);
    expect(m[0]).toBe(255);
    expect(m[1]).toBeGreaterThan(0);
    expect(m[1]).toBeLessThan(255);
    expect(m[2]).toBe(0);
  });
});

describe('perspective', () => {
  it('maps four corners exactly', () => {
    const src = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ];
    const dst = [
      { x: 10, y: 20 },
      { x: 120, y: 5 },
      { x: 110, y: 90 },
      { x: 0, y: 70 },
    ];
    const h = homography(src, dst)!;
    for (let i = 0; i < 4; i++) {
      const p = project(h, src[i]);
      expect(p.x).toBeCloseTo(dst[i].x, 6);
      expect(p.y).toBeCloseTo(dst[i].y, 6);
    }
    expect(convexQuad(dst)).toBe(true);
    expect(convexQuad([dst[0], dst[2], dst[1], dst[3]])).toBe(false);
  });
  it('finds the affine map between two triangles', () => {
    const m = triangleAffine(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ],
      [
        { x: 5, y: 5 },
        { x: 7, y: 5 },
        { x: 5, y: 8 },
      ],
    )!;
    expect(m).toEqual([2, 0, 0, 3, 5, 5]);
  });
});
