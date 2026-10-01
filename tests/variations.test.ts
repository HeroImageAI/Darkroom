import { describe, expect, it } from 'vitest';
import { expandVariations } from '../src/shared/variations';

describe('prompt variations', () => {
  it('leaves a plain prompt alone', () => {
    expect(expandVariations('a red car')).toEqual({ prompts: ['a red car'], total: 1 });
  });
  it('expands every combination, last group fastest', () => {
    const v = expandVariations('a {red|green} car at {dawn|night}');
    expect(v.total).toBe(4);
    expect(v.prompts).toEqual(['a red car at dawn', 'a red car at night', 'a green car at dawn', 'a green car at night']);
  });
  it('ignores braces without a choice, trims options and allows an empty one', () => {
    expect(expandVariations('logo {brand} in { gold | silver }').prompts).toEqual(['logo {brand} in gold', 'logo {brand} in silver']);
    expect(expandVariations('a cat{| wearing a crown}').prompts).toEqual(['a cat', 'a cat wearing a crown']);
  });
  it('stops at the limit but reports the full count', () => {
    const v = expandVariations('{a|b|c|d} {e|f|g|h} {i|j}', 10);
    expect(v.total).toBe(32);
    expect(v.prompts).toHaveLength(10);
  });
});

describe('prompt variations: tidy joins', () => {
  it('drops the space left before punctuation', () => {
    expect(expandVariations('a {red | blue}, shiny car').prompts).toEqual(['a red, shiny car', 'a blue, shiny car']);
  });
});
