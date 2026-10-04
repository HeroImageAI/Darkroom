import { describe, expect, it } from 'vitest';
import { copyMeasure, looksCopied } from '../src/server/copycheck.js';

const F = 'tests/fixtures/qwen-copy/';

// real Qwen-Image 2.1 Instruct results from the 2026-10-03 test suite (DECISIONS 107)
describe('copy check', () => {
  it('flags a Qwen result that is its input with a grain added', async () => {
    expect(looksCopied(await copyMeasure(F + 'shoe.png', F + 'shoe-clay-copied.png'))).toBe(true);
    expect(looksCopied(await copyMeasure(F + 'car.png', F + 'car-board-copied.png'))).toBe(true);
  });
  it('passes results that followed the instruction, even a small change of look', async () => {
    expect(looksCopied(await copyMeasure(F + 'shoe.png', F + 'shoe-clay-ok.png'))).toBe(false);
    expect(looksCopied(await copyMeasure(F + 'car.png', F + 'car-board-ok.png'))).toBe(false);
  });
  it('passes a picture compared with itself (an Instruct that rightly changed almost nothing)', async () => {
    expect(looksCopied(await copyMeasure(F + 'shoe.png', F + 'shoe.png'))).toBe(false);
  });
});
