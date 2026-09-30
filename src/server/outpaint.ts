import sharp from 'sharp';
import { outpaintFeather, outpaintMask, snapPad, type Pad } from '../shared/outpaint.js';

export interface OutpaintCanvas {
  /** Padded picture: the original on black. */
  image: Buffer;
  /** Greyscale mask PNG, white = repaint (new area + feather band + leftover black touching an extended edge). */
  mask: Buffer;
  width: number;
  height: number;
  pad: Pad;
  feather: number;
}

/**
 * Build the outpaint canvas and mask (Addendum 1 D) from a picture file. `step` rounds the canvas: 8 for Klein, 32 for
 * Qwen-Image 2.1. `feather` 0 = Auto (min(48, short side / 6)).
 */
export async function buildOutpaintCanvas(src: Buffer, pad: Pad, opts: { step: number; feather?: number }): Promise<OutpaintCanvas> {
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const p = snapPad(w, h, pad, opts.step);
  const W = w + p.left + p.right;
  const H = h + p.top + p.bottom;
  const feather = outpaintFeather(w, h, opts.feather ?? 0);
  const m = outpaintMask(w, h, p, feather, data);
  const rgb = await sharp(src).removeAlpha().png().toBuffer();
  const image = await sharp({ create: { width: W, height: H, channels: 3, background: '#000000' } })
    .composite([{ input: rgb, left: p.left, top: p.top }])
    .png()
    .toBuffer();
  const mask = await sharp(Buffer.from(m), { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  return { image, mask, width: W, height: H, pad: p, feather };
}
