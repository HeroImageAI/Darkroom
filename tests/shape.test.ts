import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyShape, shapeSizes } from '../src/shared/shape.js';
import { findByTitle, type ApiPrompt } from '../src/shared/workflow.js';

const graph = (f: string) => JSON.parse(fs.readFileSync(`workflows/${f}`, 'utf8')) as ApiPrompt;

describe('Shape in Instruct', () => {
  it('sizes: ~1 MP work canvas, the picture\'s pixel count at the new shape', () => {
    const { work, full } = shapeSizes('16:9', 1080, 1600); // a portrait storyboard page to widescreen
    expect(work.w / work.h).toBeCloseTo(16 / 9, 1);
    expect(work.w * work.h).toBeGreaterThan(0.9e6);
    expect(work.w % 32 + work.h % 32).toBe(0);
    expect(full.w / full.h).toBeCloseTo(16 / 9, 1);
    expect(Math.abs(full.w * full.h - 1080 * 1600) / (1080 * 1600)).toBeLessThan(0.03);
    expect(full.w % 16 + full.h % 16).toBe(0);
  });
  for (const [file, family, canvas, resize] of [
    ['qwen_edit.json', 'qwen', 'Encode picture', 'Back to source size'],
    ['klein_edit.v2.json', 'klein', 'Encode canvas', 'Fill to full size'],
  ] as const) {
    it(`${family}: the sampler starts from an empty canvas of the shape and the result is resized to it`, () => {
      const g = graph(file);
      const c = findByTitle(g, canvas)[0];
      expect(applyShape(g, family, { w: 1344, h: 768 }, { w: 1728, h: 976 })).toBe(true);
      const shapeNode = findByTitle(g, 'Shape canvas')[0];
      expect(g[shapeNode].inputs).toMatchObject({ width: 1344, height: 768 });
      // nothing reads the encoded picture any more
      expect(Object.values(g).some((n) => Object.values(n.inputs).some((v) => Array.isArray(v) && v[0] === c))).toBe(false);
      expect(g[findByTitle(g, resize)[0]].inputs).toMatchObject({ width: 1728, height: 976 });
    });
  }
  it('leaves an unknown graph alone', () => {
    expect(applyShape({ '1': { class_type: 'X', inputs: {} } }, 'qwen', { w: 1, h: 1 }, { w: 1, h: 1 })).toBe(false);
  });
});
