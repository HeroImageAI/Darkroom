import { describe, expect, it } from 'vitest';
import { checkMatte } from '../src/shared/matte';

describe('checkMatte', () => {
  it('a solid matte passes, a grey one fails, an empty one fails', () => {
    const solid = [...Array(800).fill(0), ...Array(200).fill(252)];
    expect(checkMatte(solid)).toMatchObject({ foreground: 0.2, ok: true });
    const grey = [...Array(800).fill(3), ...Array(200).fill(115)];
    expect(checkMatte(grey).ok).toBe(false);
    expect(checkMatte(grey).level).toBeCloseTo(0.45, 2);
    expect(checkMatte(Array(1000).fill(0))).toMatchObject({ foreground: 0, ok: false });
  });
});
