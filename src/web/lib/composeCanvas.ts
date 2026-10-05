/**
 * Drawing an old Compose composition (DECISIONS 87) — used now only to turn one into an Edit layer project
 * (DECISIONS 125): each picture and paint layer is drawn in its place on a canvas of the composition's size.
 */
import { inputUrl } from '../api';
import type { ComposeDoc, ComposeLayer } from '../../shared/compose';

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
        reject(new Error('Could not load a picture of the composition.'));
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

export type PaintSource = (id: string) => HTMLCanvasElement | undefined;

/** One layer in its place: paint covers the canvas; a picture sits in its box, mirrored when flipped. */
export async function drawLayer(ctx: CanvasRenderingContext2D, l: ComposeLayer, doc: ComposeDoc, paint: PaintSource) {
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
