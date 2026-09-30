import sharp, { type OverlayOptions } from 'sharp';

/**
 * Pictures side by side on one sheet for the vision model (its graph takes a single image): all scaled to the same
 * height, a dark gap between them, and a label in each top-left corner so the model can tell them apart. Used for
 * Video motion with an end frame (START / END) and Generate "From references" (IMAGE 1, IMAGE 2, IMAGE 3).
 */
export async function labelledSheet(pictures: Uint8Array[], labels: string[], height = 768): Promise<Buffer> {
  const gap = Math.round(height / 32);
  const scaled = await Promise.all(
    pictures.map(async (buf) => {
      const img = sharp(Buffer.from(buf)).rotate().flatten({ background: '#000000' }).resize({ height, withoutEnlargement: false });
      const { data, info } = await img.png().toBuffer({ resolveWithObject: true });
      return { data, width: info.width };
    }),
  );
  const width = scaled.reduce((w, s) => w + s.width, 0) + gap * (scaled.length - 1);
  const fs = Math.round(height / 22);
  const inset = Math.round(height / 48);
  const label = (text: string) => {
    const w = Math.round(fs * (text.length * 0.72 + 1.2));
    const h = Math.round(fs * 1.6);
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${fs / 4}" fill="#000" fill-opacity=".75"/><text x="${fs * 0.6}" y="${fs * 1.15}" font-family="Arial, sans-serif" font-weight="700" font-size="${fs}" fill="#fff">${text}</text></svg>`,
    );
  };
  const layers: OverlayOptions[] = [];
  let x = 0;
  scaled.forEach((s, i) => {
    layers.push({ input: s.data, left: x, top: 0 }, { input: label(labels[i] ?? `IMAGE ${i + 1}`), left: x + inset, top: inset });
    x += s.width + gap;
  });
  return sharp({ create: { width, height, channels: 3, background: '#111111' } }).composite(layers).png().toBuffer();
}

/** Start and end frame of a clip (Video > Suggest / Improve motion with an end frame). */
export function framePair(start: Uint8Array, end: Uint8Array, height = 768): Promise<Buffer> {
  return labelledSheet([start, end], ['START', 'END'], height);
}
