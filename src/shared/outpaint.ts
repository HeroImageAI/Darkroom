/**
 * Outpaint canvas prep (Addendum 1 D), after One Node · FLUX.2 [klein] (github.com/yanokusnir-ai/one-node-flux-2-klein,
 * web/one_node_flux_2_klein.js "Build outpaint mask"): the source is placed on a black canvas; the mask is white over
 * the new area and fades from white to black INTO the original over `feather` px, so the model repaints a band of the
 * original and the seam disappears.
 *
 * Deliberate difference: One Node re-masks every pixel of the original with R,G,B < 18 so leftover black from an
 * earlier round gets filled - which also regenerates real dark content (night skies, black clothing, shadows). Here only
 * near-black pixels CONNECTED to an outpainted edge are added (flood fill from the sides that are being extended).
 */
export interface Pad {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Feather into the original: Auto = min(48, shortSide / 6); an override is capped at 256 and at half the short side. */
export function outpaintFeather(origW: number, origH: number, override = 0): number {
  const short = Math.min(origW, origH);
  const base = override > 0 ? Math.min(256, override) : Math.min(48, Math.floor(short / 6));
  return Math.max(1, Math.min(base, Math.floor(short / 2)));
}

/** Round padding so the final canvas is a multiple of `step` (8 for Klein, 32 for Qwen); extra pixels go to padded sides. */
export function snapPad(origW: number, origH: number, pad: Pad, step: number): Pad {
  const fix = (a: number, b: number, size: number): [number, number] => {
    const total = size + a + b;
    const extra = (step - (total % step)) % step;
    if (!extra) return [a, b];
    if (a > 0 && b > 0) return [a + Math.floor(extra / 2), b + Math.ceil(extra / 2)];
    return a > 0 ? [a + extra, b] : b > 0 ? [a, b + extra] : [a, b];
  };
  const [left, right] = fix(pad.left, pad.right, origW);
  const [top, bottom] = fix(pad.top, pad.bottom, origH);
  return { left, top, right, bottom };
}

/**
 * Mask for a padded canvas (1 byte per pixel, 255 = repaint). `src` is the ORIGINAL picture's RGBA pixels, used only
 * for the leftover-black detection (pass null to skip it).
 */
export function outpaintMask(origW: number, origH: number, pad: Pad, feather: number, src: Uint8Array | Uint8ClampedArray | null, blackThreshold = 18): Uint8Array {
  const W = origW + pad.left + pad.right;
  const H = origH + pad.top + pad.bottom;
  const m = new Uint8Array(W * H).fill(255);
  const L = pad.left;
  const T = pad.top;
  for (let y = 0; y < origH; y++) {
    for (let x = 0; x < origW; x++) {
      // distance into the original from each side that is being extended (only those sides fade)
      let d = Infinity;
      if (pad.left > 0) d = Math.min(d, x);
      if (pad.right > 0) d = Math.min(d, origW - 1 - x);
      if (pad.top > 0) d = Math.min(d, y);
      if (pad.bottom > 0) d = Math.min(d, origH - 1 - y);
      m[(T + y) * W + (L + x)] = d < feather ? Math.round(255 * (1 - d / feather)) : 0;
    }
  }
  if (src) markEdgeBlack(m, W, origW, origH, L, T, pad, src, blackThreshold);
  return m;
}

/** Flood-fill near-black pixels of the original that touch an extended edge, and mark them for repainting. */
function markEdgeBlack(m: Uint8Array, W: number, w: number, h: number, L: number, T: number, pad: Pad, src: Uint8Array | Uint8ClampedArray, thr: number) {
  const dark = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return src[i] < thr && src[i + 1] < thr && src[i + 2] < thr;
  };
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const seed = (x: number, y: number) => {
    const k = y * w + x;
    if (!seen[k] && dark(x, y)) {
      seen[k] = 1;
      stack.push(k);
    }
  };
  if (pad.left > 0) for (let y = 0; y < h; y++) seed(0, y);
  if (pad.right > 0) for (let y = 0; y < h; y++) seed(w - 1, y);
  if (pad.top > 0) for (let x = 0; x < w; x++) seed(x, 0);
  if (pad.bottom > 0) for (let x = 0; x < w; x++) seed(x, h - 1);
  while (stack.length) {
    const k = stack.pop()!;
    const x = k % w;
    const y = (k - x) / w;
    m[(T + y) * W + (L + x)] = 255;
    if (x > 0) seed(x - 1, y);
    if (x < w - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < h - 1) seed(x, y + 1);
  }
}
