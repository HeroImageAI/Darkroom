/**
 * Fill bucket (Edit suite v3.26): which pixels a click fills. Scanline flood fill on RGBA data with a colour tolerance
 * (0–255, on the largest channel difference, alpha included); `contiguous: false` takes every matching pixel.
 * Returns a 0/255 mask and the box it covers, or null when nothing matched.
 */
export interface FillResult {
  mask: Uint8Array;
  box: { x: number; y: number; w: number; h: number };
  count: number;
}

export function floodMask(data: Uint8ClampedArray | Uint8Array, w: number, h: number, sx: number, sy: number, tolerance: number, contiguous = true): FillResult | null {
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  const i0 = (sy * w + sx) * 4;
  const r0 = data[i0];
  const g0 = data[i0 + 1];
  const b0 = data[i0 + 2];
  const a0 = data[i0 + 3];
  const tol = Math.max(0, Math.min(255, tolerance));
  const match = (p: number) => {
    const i = p * 4;
    // fully transparent pixels match each other whatever their colour channels hold
    if (a0 === 0 && data[i + 3] === 0) return true;
    return Math.max(Math.abs(data[i] - r0), Math.abs(data[i + 1] - g0), Math.abs(data[i + 2] - b0), Math.abs(data[i + 3] - a0)) <= tol;
  };
  const mask = new Uint8Array(w * h);
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  let count = 0;
  const mark = (x: number, y: number) => {
    mask[y * w + x] = 255;
    count++;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  if (!contiguous) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (match(y * w + x)) mark(x, y);
  } else {
    const stack: number[] = [sx, sy];
    while (stack.length) {
      const y = stack.pop()!;
      let x = stack.pop()!;
      while (x >= 0 && !mask[y * w + x] && match(y * w + x)) x--;
      x++;
      let up = false;
      let down = false;
      while (x < w && !mask[y * w + x] && match(y * w + x)) {
        mark(x, y);
        if (y > 0) {
          const m = !mask[(y - 1) * w + x] && match((y - 1) * w + x);
          if (m && !up) stack.push(x, y - 1);
          up = m;
        }
        if (y < h - 1) {
          const m = !mask[(y + 1) * w + x] && match((y + 1) * w + x);
          if (m && !down) stack.push(x, y + 1);
          down = m;
        }
        x++;
      }
    }
  }
  if (!count) return null;
  return { mask, box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, count };
}

/** Grow a 0/255 mask by `px` (a square step per pixel, enough to close the anti-aliased seam of a line). */
export function growMask(mask: Uint8Array, w: number, h: number, px: number): Uint8Array {
  let cur = mask;
  for (let k = 0; k < px; k++) {
    const next = new Uint8Array(cur);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (cur[y * w + x]) continue;
        if ((x > 0 && cur[y * w + x - 1]) || (x < w - 1 && cur[y * w + x + 1]) || (y > 0 && cur[(y - 1) * w + x]) || (y < h - 1 && cur[(y + 1) * w + x])) next[y * w + x] = 255;
      }
    cur = next;
  }
  return cur;
}
