import { describe, expect, it } from 'vitest';
import { detectPixelBlock } from '../src/shared/pixelblock';

function blocky(w: number, h: number, b: number, seed = 7) {
  const d = new Uint8Array(w * h * 4);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) % 256);
  const cells: number[][] = [];
  for (let cy = 0; cy < Math.ceil(h / b); cy++) for (let cx = 0; cx < Math.ceil(w / b); cx++) cells.push([rnd(), rnd(), rnd()]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = cells[Math.floor(y / b) * Math.ceil(w / b) + Math.floor(x / b)];
      d.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    }
  return d;
}

describe('detectPixelBlock', () => {
  it('finds the block size of a nearest-neighbour enlargement', () => {
    expect(detectPixelBlock(blocky(384, 384, 4), 384, 384)).toBe(4);
    expect(detectPixelBlock(blocky(300, 200, 6), 300, 200)).toBe(6);
  });
  it('returns 1 for a picture that is not pixelated', () => {
    expect(detectPixelBlock(blocky(256, 256, 1), 256, 256)).toBe(1);
  });
});
