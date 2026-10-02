import { describe, expect, it } from 'vitest';
import { restoreCanvas, restoredFrames, restoreWindows } from '../src/shared/restore';

describe('restore windows', () => {
  it('a short clip is one window', () => {
    expect(restoreWindows(73)).toEqual([{ start: 0, length: 73, skip: 0 }]);
    expect(restoreWindows(97)).toEqual([{ start: 0, length: 97, skip: 0 }]);
  });
  it('a 10 s clip: windows overlap by 17, lengths on the 8n+1 grid, nearly every frame covered', () => {
    const w = restoreWindows(242);
    expect(w).toEqual([
      { start: 0, length: 97, skip: 0 },
      { start: 80, length: 97, skip: 17 },
      { start: 160, length: 81, skip: 17 },
    ]);
    expect(242 - restoredFrames(w)).toBeLessThanOrEqual(7);
    for (const x of w) expect((x.length - 1) % 8).toBe(0);
  });
  it('stops at 8 windows (about 26 s at 24 fps)', () => {
    const w = restoreWindows(5000);
    expect(w).toHaveLength(8);
    expect(restoredFrames(w)).toBe(7 * 80 + 97);
  });
});

describe('restore canvas', () => {
  it('up to 1280 on the long side, multiples of 32', () => {
    expect(restoreCanvas(640, 352)).toEqual({ width: 1280, height: 704 });
    expect(restoreCanvas(1920, 1080)).toEqual({ width: 1280, height: 704 });
    expect(restoreCanvas(1080, 1920)).toEqual({ width: 704, height: 1280 });
    expect(restoreCanvas(640, 480)).toEqual({ width: 1280, height: 960 });
  });
});
