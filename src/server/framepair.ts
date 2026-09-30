import sharp from 'sharp';

/**
 * Start and end frame side by side for the vision model (Video > Suggest / Improve motion with an end frame): both
 * scaled to the same height, a dark gap between them, and a START / END label in each top-left corner, so the model
 * can tell which is which. The graph then scales the whole sheet to ~1 MP.
 */
export async function framePair(start: Uint8Array, end: Uint8Array, height = 768): Promise<Buffer> {
  const gap = Math.round(height / 32);
  const scaled = await Promise.all(
    [start, end].map(async (buf) => {
      const img = sharp(Buffer.from(buf)).rotate().flatten({ background: '#000000' }).resize({ height, withoutEnlargement: false });
      const { data, info } = await img.png().toBuffer({ resolveWithObject: true });
      return { data, width: info.width };
    }),
  );
  const width = scaled[0].width + gap + scaled[1].width;
  const label = (text: string) => {
    const fs = Math.round(height / 22);
    const w = Math.round(fs * (text.length * 0.72 + 1.2));
    const h = Math.round(fs * 1.6);
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${fs / 4}" fill="#000" fill-opacity=".75"/><text x="${fs * 0.6}" y="${fs * 1.15}" font-family="Arial, sans-serif" font-weight="700" font-size="${fs}" fill="#fff">${text}</text></svg>`,
    );
  };
  const inset = Math.round(height / 48);
  return sharp({ create: { width, height, channels: 3, background: '#111111' } })
    .composite([
      { input: scaled[0].data, left: 0, top: 0 },
      { input: scaled[1].data, left: scaled[0].width + gap, top: 0 },
      { input: label('START'), left: inset, top: inset },
      { input: label('END'), left: scaled[0].width + gap + inset, top: inset },
    ])
    .png()
    .toBuffer();
}
