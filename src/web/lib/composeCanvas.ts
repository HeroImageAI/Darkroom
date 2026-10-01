/**
 * Compose canvas work in the browser (DECISIONS 87): flatten the layers into the picture sent to Qwen / Klein, build
 * the seam mask for "Blend edges", measure how much is painted, and trim cut-outs to their subject.
 */
import { inputUrl } from '../api';
import { seamWidths, type ComposeDoc, type ComposeLayer } from '../../shared/compose';

/** The colour of an empty canvas — shown on screen and sent to the model, so what you see is what renders. */
export const PAPER = '#f2f0ea';

const cache = new Map<string, Promise<HTMLImageElement>>();

/** Load (once) a picture from an URL or data URL. */
export function loadImg(url: string): Promise<HTMLImageElement> {
  let p = cache.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => {
        cache.delete(url);
        reject(new Error('Could not load a picture on the canvas.'));
      };
      img.src = url;
    });
    if (!url.startsWith('data:')) cache.set(url, p);
  }
  return p;
}

export const layerUrl = (l: ComposeLayer) => (l.kind === 'paint' ? l.paint || '' : inputUrl(l.src!));

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Paint layers are drawn from their live canvas when there is one (mid-edit), otherwise from the saved PNG. */
export type PaintSource = (id: string) => HTMLCanvasElement | undefined;

async function drawLayer(ctx: CanvasRenderingContext2D, l: ComposeLayer, doc: ComposeDoc, paint: PaintSource) {
  if (l.kind === 'paint') {
    const live = paint(l.id);
    if (live) ctx.drawImage(live, 0, 0, doc.width, doc.height);
    else if (l.paint) ctx.drawImage(await loadImg(l.paint), 0, 0, doc.width, doc.height);
    return;
  }
  const img = await loadImg(layerUrl(l));
  ctx.save();
  if (l.flip) {
    ctx.translate(l.x + l.w, l.y);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0, l.w, l.h);
  } else ctx.drawImage(img, l.x, l.y, l.w, l.h);
  ctx.restore();
}

/** The composition as one picture (`scale` 1 = full size). */
export async function flatten(doc: ComposeDoc, paint: PaintSource, scale = 1): Promise<HTMLCanvasElement> {
  const c = makeCanvas(doc.width * scale, doc.height * scale);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.scale(scale, scale);
  for (const l of doc.layers) if (!l.hidden) await drawLayer(ctx, l, doc, paint);
  return c;
}

export const toBlob = (c: HTMLCanvasElement, type = 'image/png', q?: number) =>
  new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not export the canvas.'))), type, q));

const covers = (l: ComposeLayer, doc: ComposeDoc) => l.kind === 'picture' && !l.cutout && l.x <= 1 && l.y <= 1 && l.x + l.w >= doc.width - 1 && l.y + l.h >= doc.height - 1;

/** Index of the background: the top-most visible picture that fills the whole canvas; -1 when there is none. */
export function backgroundIndex(doc: ComposeDoc): number {
  for (let i = doc.layers.length - 1; i >= 0; i--) if (!doc.layers[i].hidden && covers(doc.layers[i], doc)) return i;
  return -1;
}

/** Alpha of `src` blurred by `sigma`, thresholded: low threshold grows the shape, high threshold shrinks it. */
function grownAlpha(src: HTMLCanvasElement, sigma: number, threshold: number): Uint8Array {
  const c = makeCanvas(src.width, src.height);
  const ctx = c.getContext('2d')!;
  ctx.filter = `blur(${sigma}px)`;
  ctx.drawImage(src, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const out = new Uint8Array(c.width * c.height);
  const t = threshold * 255;
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3] > t ? 1 : 0;
  return out;
}

/**
 * "Blend edges" mask: a band around the edge of every piece on top of the background, plus a strip under each
 * picture for its contact shadow. White = redraw. Null when there is no background or nothing on top of it.
 */
export async function seamMask(doc: ComposeDoc, paint: PaintSource): Promise<HTMLCanvasElement | null> {
  const bg = backgroundIndex(doc);
  const pieces = doc.layers.slice(bg + 1).filter((l) => !l.hidden);
  if (bg < 0 || !pieces.length) return null;
  const sil = makeCanvas(doc.width, doc.height);
  const sctx = sil.getContext('2d')!;
  const shadow = makeCanvas(doc.width, doc.height);
  const shctx = shadow.getContext('2d')!;
  shctx.fillStyle = '#fff';
  for (const l of pieces) {
    await drawLayer(sctx, l, doc, paint);
    if (l.kind === 'picture') shctx.fillRect(l.x, l.y + l.h * 0.88, l.w, l.h * 0.2);
  }
  const { outside, inside } = seamWidths(doc.width, doc.height);
  const outer = grownAlpha(sil, outside / 2, 0.02);
  const inner = grownAlpha(sil, inside / 2, 0.98);
  const sh = shctx.getImageData(0, 0, doc.width, doc.height).data;
  const m = makeCanvas(doc.width, doc.height);
  const mctx = m.getContext('2d')!;
  const img = mctx.createImageData(doc.width, doc.height);
  let any = false;
  for (let i = 0; i < outer.length; i++) {
    const on = !inner[i] && (!!outer[i] || sh[i * 4 + 3] > 0);
    const v = on ? 255 : 0;
    any ||= on;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  mctx.putImageData(img, 0, 0);
  return any ? m : null;
}

/** Share of the canvas covered by visible paint (0–1), measured small for speed. */
export async function paintCoverage(doc: ComposeDoc, paint: PaintSource): Promise<number> {
  const layers = doc.layers.filter((l) => l.kind === 'paint' && !l.hidden);
  if (!layers.length) return 0;
  const s = 96 / Math.max(doc.width, doc.height);
  const c = makeCanvas(doc.width * s, doc.height * s);
  const ctx = c.getContext('2d')!;
  ctx.scale(s, s);
  for (const l of layers) await drawLayer(ctx, l, doc, paint);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 32) n++;
  return n / (c.width * c.height);
}

/** Box of the non-transparent pixels, or null when the picture is fully opaque or empty. */
export function alphaBox(img: HTMLImageElement): { x: number; y: number; w: number; h: number } | null {
  const c = makeCanvas(img.naturalWidth, img.naturalHeight);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  return box.w === width && box.h === height ? null : box;
}

/** Is the layer's pixel under canvas point (px, py) visible? Used to pick the piece you clicked, not its empty box. */
export async function hitsLayer(l: ComposeLayer, px: number, py: number, doc: ComposeDoc, paint: PaintSource): Promise<boolean> {
  if (l.kind === 'paint') {
    const c = paint(l.id);
    if (!c) return false;
    const x = Math.floor((px / doc.width) * c.width);
    const y = Math.floor((py / doc.height) * c.height);
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return false;
    return c.getContext('2d', { willReadFrequently: true })!.getImageData(x, y, 1, 1).data[3] > 16;
  }
  if (px < l.x || py < l.y || px >= l.x + l.w || py >= l.y + l.h) return false;
  if (!l.cutout) return true;
  const img = await loadImg(layerUrl(l));
  let u = (px - l.x) / l.w;
  if (l.flip) u = 1 - u;
  const c = makeCanvas(1, 1);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, Math.floor(u * img.naturalWidth), Math.floor(((py - l.y) / l.h) * img.naturalHeight), 1, 1, 0, 0, 1, 1);
  return ctx.getImageData(0, 0, 1, 1).data[3] > 16;
}
