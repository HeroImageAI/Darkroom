import { describe, expect, it } from 'vitest';
import { asksForLettering, describesVehicle } from '../src/shared/hints.js';

describe('Generate hints', () => {
  it('spots vehicles', () => {
    for (const p of [
      'A rugged overlander vehicle, matte black with reinforced steel bumpers',
      'A compact electric crossover concept car with a full-width light bar',
      'a red pickup truck on a dirt road',
      'A vintage SUV parked by the sea',
      'a 4x4 climbing a dune',
      'a café racer motorcycle in a garage',
    ])
      expect(describesVehicle(p), p).toBe(true);
  });
  it('leaves other subjects alone', () => {
    for (const p of [
      'A lightweight trail running shoe with a sculpted foam midsole',
      'A technical rain shell jacket with a storm hood',
      'a scarf with a careful pattern', // "car" inside a word
      'a desert scavenger character in layered cloth',
    ])
      expect(describesVehicle(p), p).toBe(false);
  });
  it('spots lettering in quotes', () => {
    expect(asksForLettering('with "OVERLANDER" emblazoned in bold chrome letters on the hood')).toBe(true);
    expect(asksForLettering('a poster that reads “Darkroom”')).toBe(true);
    expect(asksForLettering('a quiet harbour at dusk')).toBe(false);
  });
});
