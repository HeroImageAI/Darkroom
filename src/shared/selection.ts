/**
 * Selection maths for the Edit canvas (Edit suite v3.27). A selection is a W×H alpha mask (0..255); these change it:
 * grow and shrink by a distance (a chamfer distance transform, so 40 px costs the same as 1 px), a border band, and
 * combining two masks (replace, add, subtract, intersect). Feathering is a blur, done by the canvas.
 */

export type SelOp = 'replace' | 'add' | 'subtract' | 'intersect';

/** Distance (≈ px, chamfer 3-4) from each pixel to the nearest pixel where `inside` is true; 0 inside. */
export function distanceTo(inside: (i: number) => boolean, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = inside(i) ? 0 : INF;
  const a = 1;
  const b = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (y > 0) {
        v = Math.min(v, d[i - w] + a);
        if (x > 0) v = Math.min(v, d[i - w - 1] + b);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + b);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + a);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + a);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + b);
        if (x > 0) v = Math.min(v, d[i + w - 1] + b);
      }
      d[i] = v;
    }
  return d;
}

/** Grow (px > 0) or shrink (px < 0) a mask by about |px| pixels. Soft edges count as inside from alpha 128. */
export function growShrink(mask: Uint8Array | Uint8ClampedArray, w: number, h: number, px: number): Uint8Array {
  const out = new Uint8Array(w * h);
  if (px === 0) {
    out.set(mask);
    return out;
  }
  if (px > 0) {
    const d = distanceTo((i) => mask[i] >= 128, w, h);
    for (let i = 0; i < w * h; i++) out[i] = d[i] <= px ? 255 : mask[i];
  } else {
    const d = distanceTo((i) => mask[i] < 128, w, h);
    for (let i = 0; i < w * h; i++) out[i] = d[i] > -px ? mask[i] : 0;
  }
  return out;
}

/** A band `px` wide around the selection's edge (half inside, half outside). */
export function border(mask: Uint8Array | Uint8ClampedArray, w: number, h: number, px: number): Uint8Array {
  const half = Math.max(1, px / 2);
  const dOut = distanceTo((i) => mask[i] >= 128, w, h);
  const dIn = distanceTo((i) => mask[i] < 128, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = (mask[i] >= 128 ? dIn[i] <= half : dOut[i] <= half) ? 255 : 0;
  return out;
}

/** Combine `next` into `cur` (both 0..255 masks). */
export function combine(cur: Uint8Array | Uint8ClampedArray, next: Uint8Array | Uint8ClampedArray, op: SelOp): Uint8Array {
  const out = new Uint8Array(cur.length);
  for (let i = 0; i < cur.length; i++) {
    const a = cur[i];
    const b = next[i];
    out[i] = op === 'replace' ? b : op === 'add' ? Math.max(a, b) : op === 'subtract' ? Math.min(a, 255 - b) : Math.min(a, b);
  }
  return out;
}

/** The box around everything selected (alpha > 8), or null. */
export function maskBox(mask: Uint8Array | Uint8ClampedArray, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Select by colour range: every pixel within `tolerance` (0..255, largest channel difference) of `rgb`, softened at the edge. */
export function colourRange(data: Uint8ClampedArray | Uint8Array, w: number, h: number, rgb: [number, number, number], tolerance: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const soft = Math.max(4, tolerance * 0.75);
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] < 8) continue;
    const dd = Math.max(Math.abs(data[i * 4] - rgb[0]), Math.abs(data[i * 4 + 1] - rgb[1]), Math.abs(data[i * 4 + 2] - rgb[2]));
    out[i] = dd <= tolerance ? 255 : dd <= tolerance + soft ? Math.round(255 * (1 - (dd - tolerance) / soft)) : 0;
  }
  return out;
}
