import { readPsd } from 'ag-psd';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { layersToPsd, layersToZip } from '../src/server/layers';

async function solid(r: number, g: number, b: number, a: number) {
  return new Uint8Array(await sharp({ create: { width: 8, height: 6, channels: 4, background: { r, g, b, alpha: a } } }).png().toBuffer());
}

describe('layer export', () => {
  it('writes a PSD with layers in the right order and visibility', async () => {
    const top = await solid(255, 0, 0, 1);
    const bottom = await solid(0, 0, 255, 1);
    const buf = await layersToPsd([
      { name: 'Top', png: top, visible: true },
      { name: 'Bottom', png: bottom, visible: false },
    ]);
    const psd = readPsd(buf, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
    expect(psd.width).toBe(8);
    expect(psd.height).toBe(6);
    expect(psd.children!.map((c) => c.name)).toEqual(['Bottom', 'Top']); // PSD order is bottom-to-top
    expect(psd.children![0].hidden).toBe(true);
  });
  it('writes a ZIP with numbered PNGs', async () => {
    const zip = layersToZip([
      { name: 'person 1', png: await solid(1, 2, 3, 1), visible: true },
      { name: 'background', png: await solid(4, 5, 6, 1), visible: false },
    ]);
    expect(Object.keys(unzipSync(new Uint8Array(zip)))).toEqual(['01_person_1.png', '02_background_hidden.png']);
  });
});
