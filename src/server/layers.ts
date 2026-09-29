/**
 * Layer export: layered PSD (ag-psd, MIT) and ZIP of PNGs (fflate, MIT).
 * Layers are given top-to-bottom; every layer is placed at 0,0 on a canvas the size of the largest layer
 * (all Darkroom layer outputs share the source's size).
 */
import { writePsdBuffer, type Psd } from 'ag-psd';
import { zipSync } from 'fflate';
import sharp from 'sharp';

export interface LayerInput {
  name: string;
  png: Uint8Array;
  visible: boolean;
}

async function rgba(png: Uint8Array): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
}

/** Top-to-bottom in, PSD out (PSD children are bottom-to-top). */
export async function layersToPsd(layers: LayerInput[]): Promise<Buffer> {
  const decoded = await Promise.all(layers.map(async (l) => ({ l, img: await rgba(l.png) })));
  const width = Math.max(...decoded.map((d) => d.img.width));
  const height = Math.max(...decoded.map((d) => d.img.height));
  // flattened composite for viewers that don't read layers
  const visible = decoded.filter((d) => d.l.visible).reverse();
  const base = sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  const flat = await base
    .composite(visible.map((d) => ({ input: Buffer.from(d.l.png), left: 0, top: 0 })))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const psd: Psd = {
    width,
    height,
    imageData: { width, height, data: new Uint8ClampedArray(flat.data.buffer, flat.data.byteOffset, flat.data.byteLength) },
    children: decoded
      .slice()
      .reverse()
      .map((d) => ({ name: d.l.name, hidden: !d.l.visible, left: 0, top: 0, imageData: d.img })),
  };
  return Buffer.from(writePsdBuffer(psd, { generateThumbnail: false }));
}

export function layersToZip(layers: LayerInput[]): Buffer {
  const files: Record<string, Uint8Array> = {};
  layers.forEach((l, i) => {
    const safe = l.name.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 40) || 'layer';
    files[`${String(i + 1).padStart(2, '0')}_${safe}${l.visible ? '' : '_hidden'}.png`] = l.png;
  });
  return Buffer.from(zipSync(files, { level: 0 }));
}
