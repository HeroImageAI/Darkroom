import { expect, it } from 'vitest';
import { gibibytes, playbackDuration } from '../src/shared/mediaInfo';
it('uses encoded frame duration rather than request duration or terminal-frame time', () => {
  expect(playbackDuration({ frames: 132, fps: 24, duration: 5.4583 })).toBe(5.5);
  expect(playbackDuration({ frames: 89, fps: 24, duration: 8 })).toBeCloseTo(3.7083);
  expect(playbackDuration({ duration: 3 })).toBe(3);
});
it('reports physical memory capacity using binary units', () => expect(gibibytes(24 * 1024 ** 3)).toBe(24));
