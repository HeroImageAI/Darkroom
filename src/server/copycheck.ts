/**
 * Did an instruction edit come back as (nearly) its own input? Qwen-Image 2.1 sometimes ignores the instruction for a
 * given seed and returns the picture with a fine grain added (DECISIONS 107). Measured on small greyscale copies:
 *   low   — mean difference of the blurred pictures (0–255): how much the content changed
 *   grain — fine detail of the result ÷ fine detail of the input: >1 means the result is grainier
 */
import sharp from 'sharp';

const W = 256;

async function grey(file: string | Buffer, w: number, h: number) {
  const img = sharp(file).flatten({ background: '#ffffff' }).greyscale().resize(w, h, { fit: 'fill' });
  const [raw, soft, low] = await Promise.all([
    img.clone().raw().toBuffer(),
    img.clone().blur(0.8).raw().toBuffer(),
    img.clone().blur(3).raw().toBuffer(),
  ]);
  let fine = 0;
  for (let i = 0; i < raw.length; i++) fine += Math.abs(raw[i] - soft[i]);
  return { low, fine: fine / raw.length };
}

export async function copyMeasure(input: string | Buffer, output: string | Buffer) {
  const m = await sharp(input).metadata();
  const h = Math.max(16, Math.round((W * (m.height ?? W)) / (m.width ?? W)));
  const [a, b] = await Promise.all([grey(input, W, h), grey(output, W, h)]);
  let low = 0;
  for (let i = 0; i < a.low.length; i++) low += Math.abs(a.low[i] - b.low[i]);
  return { low: low / a.low.length, grain: b.fine / Math.max(0.5, a.fine) };
}

/** Calibrated on the 2026-10-03 test suite (scripts/try-copycheck.ts): every Qwen copy had grain ≥ 1.9 and low ≤ 24;
 *  no Qwen result that followed its instruction had grain above 1.5. Only meant for Qwen Instruct without a mask —
 *  some Klein styles (a marker sketch) add real fine detail. */
export const looksCopied = (m: { low: number; grain: number }) => m.grain >= 1.6 && m.low <= 25;
