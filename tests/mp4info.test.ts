import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mp4Info } from '../src/server/mp4info';

describe('mp4Info', () => {
  it('reads an LTX clip: size, frame rate, frames, length and sound', () => {
    const i = mp4Info(fs.readFileSync(path.join(__dirname, 'fixtures', 'ltx-864x480-121f.mp4')));
    expect([i.width, i.height, i.frames]).toEqual([864, 480, 121]);
    expect(i.fps).toBeCloseTo(24, 1);
    expect(i.duration).toBeCloseTo(121 / 24, 1);
    expect(i.hasAudio).toBe(true);
  });
  it('is harmless on something that is not an MP4', () => {
    expect(mp4Info(Buffer.from('not a video at all'))).toMatchObject({ width: null, frames: null, hasAudio: false });
  });
});
