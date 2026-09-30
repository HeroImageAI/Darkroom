import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { framePair } from '../src/server/framepair';
import { buildVlm2Request, type Vlm2Prompts } from '../src/shared/vlm';
import fs from 'node:fs';
import path from 'node:path';

const solid = (w: number, h: number, colour: string) => sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer();

describe('framePair (motion with an end frame)', () => {
  it('puts both frames side by side at one height, start on the left', async () => {
    const sheet = await framePair(await solid(1344, 768, '#ff0000'), await solid(768, 1344, '#0000ff'), 384);
    const { data, info } = await sharp(sheet).raw().toBuffer({ resolveWithObject: true });
    expect(info.height).toBe(384);
    const startW = 672; // 1344x768 at height 384
    const gap = 12;
    expect(info.width).toBe(startW + gap + Math.round((768 / 1344) * 384));
    const c = info.channels;
    const px = (x: number, y: number) => [...data.subarray((y * info.width + x) * c, (y * info.width + x) * c + 3)];
    expect(px(startW / 2, 300)).toEqual([255, 0, 0]); // start (below the label)
    expect(px(startW + gap + 100, 300)).toEqual([0, 0, 255]); // end
  });
});

describe('motion pair prompts', () => {
  const P = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'presets', 'vlm_prompts.json'), 'utf8')) as Vlm2Prompts;
  it('exist for Wan and LTX, with and without the user text', () => {
    for (const v of ['wan_pair', 'ltx_pair']) {
      const empty = buildVlm2Request(P, 'motion', v, '');
      const withText = buildVlm2Request(P, 'motion', v, 'he turns to the camera');
      expect(empty.workflow).toBe('vlm2_image');
      expect(String(empty.params.system)).toMatch(/START frame .* END frame/);
      expect(String(withText.params.prompt)).toContain('he turns to the camera');
    }
  });
});
