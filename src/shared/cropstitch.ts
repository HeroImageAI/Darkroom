/**
 * Crop-and-stitch planning for masked edits, done in Darkroom rather than with the ComfyUI-Inpaint-CropAndStitch
 * custom nodes (JP's decision: core nodes only). The rules follow One Node · FLUX.2 [klein]
 * (github.com/yanokusnir-ai/one-node-flux-2-klein, web/one_node_flux_2_klein.js "INPAINT workflow patching"):
 * the model sees the mask's bounding box grown by `context` (1.5) around its centre, sampled at a size whose long
 * side is the context box's long side × 1.5 rounded up to 64 and clamped to 512–1536. Only the crop is sampled;
 * the result is scaled back and composited into the untouched original.
 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropPlan {
  /** Region of the source to cut out (pixels, inside the image). */
  crop: Box;
  /** Size the crop is sampled at (multiples of `step`, aspect of the crop). */
  target: { w: number; h: number };
}

/** Bounding box of mask pixels with alpha/value above `threshold` (RGBA data, 4 bytes per pixel). */
export function maskBBox(data: Uint8ClampedArray | Uint8Array, width: number, height: number, channel = 3, threshold = 16): Box | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + channel] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function planCrop(
  bbox: Box,
  imgW: number,
  imgH: number,
  opts: { context?: number; minSide?: number; maxSide?: number; step?: number; pad?: number } = {},
): CropPlan {
  const context = opts.context ?? 1.5;
  const minSide = opts.minSide ?? 512;
  const maxSide = opts.maxSide ?? 1536;
  const step = opts.step ?? 64;
  // pad covers the grown + feathered mask edge so the blend zone is inside the crop
  const pad = opts.pad ?? 32;
  // context box around the mask centre, at least as big as the padded mask, at most the image
  let w = Math.min(imgW, Math.max(bbox.w + 2 * pad, Math.round(bbox.w * context)));
  let h = Math.min(imgH, Math.max(bbox.h + 2 * pad, Math.round(bbox.h * context)));
  // very small masks: give the model enough surroundings to read the scene (at least minSide/2 of real pixels)
  w = Math.min(imgW, Math.max(w, Math.round(minSide / 2)));
  h = Math.min(imgH, Math.max(h, Math.round(minSide / 2)));
  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;
  const x = clamp(Math.round(cx - w / 2), 0, imgW - w);
  const y = clamp(Math.round(cy - h / 2), 0, imgH - h);
  // sampling size: long side = context box long side × 1.5, rounded up to `step`, clamped to [minSide, maxSide]
  const long = Math.max(w, h);
  const t = clamp(Math.ceil((long * 1.5) / step) * step, minSide, maxSide);
  const scale = t / long;
  const tw = Math.max(step, Math.round((w * scale) / 16) * 16);
  const th = Math.max(step, Math.round((h * scale) / 16) * 16);
  return { crop: { x, y, w, h }, target: { w: tw, h: th } };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
