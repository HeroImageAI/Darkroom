import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  bypassNode,
  danglingLinks,
  findByTitle,
  prune,
  removeNodes,
  setInput,
  validateSpec,
  WorkflowError,
  type ApiPrompt,
  type WorkflowSpec,
} from '../src/shared/workflow';
import type { Manifest } from '../src/shared/manifest';

const WF = path.resolve(__dirname, '..', 'workflows');
const manifest = JSON.parse(fs.readFileSync(path.join(WF, 'manifest.json'), 'utf8')) as Manifest;
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(WF, f), 'utf8')) as ApiPrompt;

function tiny(): ApiPrompt {
  return {
    '1': { class_type: 'LoadImage', inputs: { image: 'a.png' }, _meta: { title: 'DR_IMAGE_1' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: '' }, _meta: { title: 'DR_PROMPT' } },
    '3': { class_type: 'ReferenceLatent', inputs: { conditioning: ['2', 0], latent: ['1', 0] }, _meta: { title: 'DR_REF' } },
    '4': { class_type: 'KSampler', inputs: { positive: ['3', 0], seed: 0 }, _meta: { title: 'DR_SAMPLER' } },
    '5': { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: 'x' }, _meta: { title: 'DR_OUTPUT' } },
    '6': { class_type: 'VAELoader', inputs: { vae_name: 'orphan' }, _meta: { title: 'Unused' } },
  };
}

describe('primitives', () => {
  it('finds nodes by exact (trimmed) title', () => {
    const p = tiny();
    p['2']._meta!.title = '  DR_PROMPT ';
    expect(findByTitle(p, 'DR_PROMPT')).toEqual(['2']);
    expect(findByTitle(p, 'DR_PROMPT_2')).toEqual([]);
  });

  it('sets inputs and throws for unknown titles', () => {
    const p = tiny();
    setInput(p, { title: 'DR_SAMPLER', input: 'seed' }, 42);
    expect(p['4'].inputs.seed).toBe(42);
    expect(() => setInput(p, { title: 'NOPE', input: 'x' }, 1)).toThrow(WorkflowError);
  });

  it('removes nodes and unlinks consumers', () => {
    const p = tiny();
    removeNodes(p, ['1']);
    expect(p['1']).toBeUndefined();
    expect('latent' in p['3'].inputs).toBe(false);
  });

  it('bypasses a node by rewiring consumers to its input', () => {
    const p = tiny();
    bypassNode(p, '3', 'conditioning');
    expect(p['4'].inputs.positive).toEqual(['2', 0]);
    expect(p['3']).toBeUndefined();
  });

  it('bypasses a multi-output node slot by slot', () => {
    const p: ApiPrompt = {
      '1': { class_type: 'Cond', inputs: {}, _meta: { title: 'c' } },
      '2': { class_type: 'Guide', inputs: { positive: ['1', 0], negative: ['1', 1], latent: ['1', 2] }, _meta: { title: 'DR_END' } },
      '3': { class_type: 'SaveImage', inputs: { a: ['2', 0], b: ['2', 1], c: ['2', 2] }, _meta: { title: 'out' } },
    };
    const spec: WorkflowSpec = {
      file: 'x',
      family: 'f',
      kind: 'video',
      outputs: { v: 'out' },
      params: {
        end: {
          type: 'image',
          targets: [{ title: 'DR_END', input: 'image' }],
          whenMissing: {
            bypass: [
              { title: 'DR_END', input: 'positive', outputSlot: 0 },
              { title: 'DR_END', input: 'negative', outputSlot: 1 },
              { title: 'DR_END', input: 'latent', outputSlot: 2 },
            ],
          },
        },
      },
    };
    const out = buildPrompt(p, spec, {});
    expect(out['3'].inputs).toEqual({ a: ['1', 0], b: ['1', 1], c: ['1', 2] });
    expect(out['2']).toBeUndefined();
  });

  it('prunes nodes no output depends on', () => {
    const p = tiny();
    prune(p);
    expect(p['6']).toBeUndefined();
    expect(Object.keys(p).sort()).toEqual(['1', '2', '3', '4', '5']);
  });

  it('reports dangling links', () => {
    const p = tiny();
    delete p['2'];
    expect(danglingLinks(p)).toEqual(['3.conditioning -> 2']);
  });
});

describe('buildPrompt', () => {
  const spec: WorkflowSpec = {
    file: 'tiny',
    family: 't',
    kind: 'image',
    outputs: { image: 'DR_OUTPUT' },
    params: {
      prompt: { type: 'string', targets: [{ title: 'DR_PROMPT', input: 'text' }], default: '' },
      seed: { type: 'int', targets: [{ title: 'DR_SAMPLER', input: 'seed' }], default: 0, min: 0, max: 100 },
      image_1: {
        type: 'image',
        targets: [{ title: 'DR_IMAGE_1', input: 'image' }],
        whenMissing: { bypass: [{ title: 'DR_REF', input: 'conditioning' }], remove: ['DR_IMAGE_1'] },
      },
    },
  };

  it('does not mutate the template', () => {
    const t = tiny();
    const before = JSON.stringify(t);
    buildPrompt(t, spec, { prompt: 'hi', seed: 5, image_1: 'b.png' });
    expect(JSON.stringify(t)).toBe(before);
  });

  it('applies values, clamps numbers and prunes', () => {
    const p = buildPrompt(tiny(), spec, { prompt: 'hi', seed: 500, image_1: 'b.png' });
    expect(p['2'].inputs.text).toBe('hi');
    expect(p['4'].inputs.seed).toBe(100);
    expect(p['1'].inputs.image).toBe('b.png');
    expect(p['6']).toBeUndefined();
  });

  it('drops optional branches when a media value is missing', () => {
    const p = buildPrompt(tiny(), spec, { prompt: 'hi' });
    expect(p['1']).toBeUndefined();
    expect(p['3']).toBeUndefined();
    expect(p['4'].inputs.positive).toEqual(['2', 0]);
    expect(danglingLinks(p)).toEqual([]);
  });

  it('requires non-optional media', () => {
    const s: WorkflowSpec = { ...spec, params: { ...spec.params, image_1: { type: 'image', targets: [{ title: 'DR_IMAGE_1', input: 'image' }], label: 'Start frame' } } };
    expect(() => buildPrompt(tiny(), s, {})).toThrow(/Start frame is required/);
  });

  it('survives re-export: node ids change, titles stay', () => {
    const t = tiny();
    const renumbered: ApiPrompt = {};
    const map: Record<string, string> = {};
    Object.keys(t).forEach((id, i) => (map[id] = String(100 + i)));
    for (const [id, n] of Object.entries(t)) {
      const inputs = Object.fromEntries(
        Object.entries(n.inputs).map(([k, v]) => [k, Array.isArray(v) ? [map[v[0] as string], v[1]] : v]),
      );
      renumbered[map[id]] = { ...n, inputs };
    }
    const p = buildPrompt(renumbered, spec, { prompt: 'x', seed: 3, image_1: 'c.png' });
    expect(Object.values(p).find((n) => n._meta?.title === 'DR_SAMPLER')!.inputs.seed).toBe(3);
  });
});

describe('shipped workflows', () => {
  for (const [name, spec] of Object.entries(manifest.workflows)) {
    const file = path.join(WF, spec.file);
    if (!fs.existsSync(file)) continue;
    it(`${name}: every manifest title exists`, () => {
      expect(validateSpec(load(spec.file), spec)).toEqual([]);
    });
    it(`${name}: builds with only required inputs`, () => {
      const values: Record<string, string> = {};
      for (const [k, p] of Object.entries(spec.params)) {
        if ((p.type === 'image' || p.type === 'video') && !p.whenMissing) values[k] = 'x.png';
      }
      const p = buildPrompt(load(spec.file), spec, values);
      expect(danglingLinks(p)).toEqual([]);
      for (const title of Object.values(spec.outputs)) expect(findByTitle(p, title).length).toBeGreaterThan(0);
    });
  }

  it('klein_ref with one reference drops refs 2 and 3', () => {
    const spec = manifest.workflows.klein_ref;
    const p = buildPrompt(load(spec.file), spec, { image_1: 'a.png', prompt: 'x' });
    expect(findByTitle(p, 'DR_IMAGE_2')).toEqual([]);
    expect(findByTitle(p, 'DR_IMAGE_3')).toEqual([]);
    expect(findByTitle(p, 'DR_IMAGE_1')).toHaveLength(1);
  });

  it('qwen_edit without a mask keeps no mask nodes', () => {
    const spec = manifest.workflows.qwen_edit;
    const p = buildPrompt(load(spec.file), spec, { image_1: 'a.png', prompt: 'x' });
    expect(Object.values(p).some((n) => n.class_type === 'LoadImageMask')).toBe(false);
    expect(Object.values(p).some((n) => n.class_type === 'SetLatentNoiseMask')).toBe(false);
  });
});
