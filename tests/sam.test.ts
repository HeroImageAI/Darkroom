import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPrompt, samPointsJson, samTextPrompt, type ApiPrompt } from '../src/shared/workflow';
import type { Manifest } from '../src/shared/manifest';

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', 'manifest.json'), 'utf8')) as Manifest;
const graph = (file: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', file), 'utf8')) as ApiPrompt;

// Found in the Phase 6 QA run: "person" on a crowded street selected one person; a single click on a boot selected nothing.
describe('SAM text prompts', () => {
  it('asks for every match per category unless a count is given', () => {
    expect(samTextPrompt('person', 20)).toBe('person:20');
    expect(samTextPrompt('car, house ,plant:2', 3)).toBe('car:3, house:3, plant:2');
    expect(samTextPrompt(' , ', 3)).toBe('');
  });
  it('sam_segment sends the capped text to the SAM text encoder', () => {
    const spec = manifest.workflows.sam_segment;
    const p = buildPrompt(graph(spec.file), spec, { image_1: 'x.png', text: 'person' });
    const enc = Object.values(p).find((n) => n._meta?.title === 'DR_TEXT')!;
    expect(enc.inputs.text).toBe('person:20');
  });
  it('remove_bg and sam_layers use their own caps', () => {
    expect(manifest.workflows.remove_bg.params.subject.samMaxPerCategory).toBe(10);
    expect(manifest.workflows.sam_layers.params.text.samMaxPerCategory).toBe(3);
  });
});

describe('SAM point prompts', () => {
  it('sends a lone click twice so SAM returns the whole object', () => {
    expect(JSON.parse(samPointsJson([{ x: 430.4, y: 429.6 }], []).points!)).toEqual([
      { x: 430, y: 430 },
      { x: 430, y: 430 },
    ]);
  });
  it('leaves multi-point and negative selections alone', () => {
    const r = samPointsJson([{ x: 1, y: 2 }], [{ x: 5, y: 6 }]);
    expect(JSON.parse(r.points!)).toHaveLength(1);
    expect(JSON.parse(r.neg_points!)).toEqual([{ x: 5, y: 6 }]);
    expect(samPointsJson([], [])).toEqual({});
  });
});
