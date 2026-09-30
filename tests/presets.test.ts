import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fillerIn, firstSlot, mergePresets, upsertUserPreset, type EditPreset } from '../src/shared/presets';

const B: EditPreset[] = [
  { id: 'relight-a', label: 'Amber Sideglow', category: 'Relight', klein: 'Relight K', qwen: 'Relight Q' },
  { id: 'text-edit', label: 'Text edit', category: 'Other', klein: 'Replace "[OLD TEXT]" with "[NEW TEXT]"', qwen: 'In <image1>, replace…' },
];

describe('mergePresets (built-ins read-only, user file merged by label)', () => {
  it('built-ins pass through', () => {
    expect(mergePresets(B, []).map((p) => p.source)).toEqual(['built-in', 'built-in']);
  });
  it('a user entry with a built-in label overrides only the fields it sets', () => {
    const m = mergePresets(B, [{ label: 'amber sideglow', klein: 'My Klein wording' }]);
    expect(m[0]).toMatchObject({ id: 'relight-a', label: 'Amber Sideglow', klein: 'My Klein wording', qwen: 'Relight Q', source: 'edited' });
  });
  it('hidden hides a built-in; new labels become my presets', () => {
    const m = mergePresets(B, [{ label: 'Text edit', hidden: true }, { label: 'Film noir', klein: 'Make it noir. Keep everything else.' }]);
    expect(m.map((p) => p.label)).toEqual(['Amber Sideglow', 'Film noir']);
    expect(m[1]).toMatchObject({ category: 'Mine', qwen: 'Make it noir. Keep everything else.', source: 'mine' });
  });
  it('the shipped presets survive a merge with an empty user file', () => {
    const f = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'presets', 'edit_presets.json'), 'utf8'));
    expect(mergePresets(f.presets, [])).toHaveLength(f.presets.length);
  });
});

describe('upsertUserPreset', () => {
  it('adds, then updates by label without losing other fields', () => {
    let l = upsertUserPreset([], { label: 'Film noir', klein: 'A' });
    l = upsertUserPreset(l, { label: 'FILM NOIR', qwen: 'B' });
    expect(l).toEqual([{ label: 'Film noir', klein: 'A', qwen: 'B' }]);
  });
});

describe('helpers', () => {
  it('firstSlot finds the first [BRACKET] slot', () => {
    const t = 'Replace "[OLD TEXT]" with "[NEW TEXT]"';
    const s = firstSlot(t)!;
    expect(t.slice(s.start, s.end)).toBe('[OLD TEXT]');
    expect(firstSlot('no slot')).toBeNull();
  });
  it('fillerIn flags style-guide filler', () => {
    expect(fillerIn('A cat, 8K, hyper-realistic, masterpiece')).toEqual(['8k', 'hyper-realistic', 'masterpiece']);
    expect(fillerIn('A cat on a windowsill in soft light')).toEqual([]);
  });
});
