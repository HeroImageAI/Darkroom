import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captionFromLineage,
  composeImagePrompt,
  composeMotionPrompt,
  fill,
  refToken,
  validateTemplates,
  type CameraPreset,
  type ImageMode,
  type PromptTemplates,
  type StylePreset,
} from '../src/shared/prompts';

const P = path.resolve(__dirname, '..', 'presets');
const T = JSON.parse(fs.readFileSync(path.join(P, 'prompts.json'), 'utf8')) as PromptTemplates;
const styles = (JSON.parse(fs.readFileSync(path.join(P, 'styles.json'), 'utf8')) as { styles: StylePreset[] }).styles;
const cams = (JSON.parse(fs.readFileSync(path.join(P, 'camera.json'), 'utf8')) as { camera: CameraPreset[] }).camera;
const style = (id: string) => styles.find((s) => s.id === id)!;

// Tokens that belong to one model only.
const QWEN_ONLY = [/<image\d>/, /\bStyle:/, /Ultra HD/, /Perform inpainting/, /using outpainting/, /original caption is/];
const KLEIN_ONLY = [/Shot as a natural-light/, /Rendered as painterly/, /Continue the scene beyond/, /blending seamlessly/, /Crisp focus, fine natural detail/, /Re-rendered in high quality/];

describe('shipped presets', () => {
  it('prompts.json is complete', () => expect(validateTemplates(T)).toEqual([]));
  it('every style has text for both models, and no negation words', () => {
    for (const s of styles) {
      expect(typeof s.klein).toBe('string');
      expect(typeof s.qwen).toBe('string');
      expect(`${s.klein} ${s.qwen}`).not.toMatch(/\bno\b|\bnot\b|\bwithout\b|\bdon't\b/i);
    }
  });
  it('every camera chip has a Wan and an LTX phrase', () => {
    for (const c of cams) {
      expect(c.wan.length).toBeGreaterThan(5);
      expect(c.ltx.length).toBeGreaterThan(5);
    }
  });
});

describe('no cross-contamination', () => {
  const modes: ImageMode[] = ['generate', 'instruct', 'inpaint', 'outpaint', 'enhance'];
  for (const s of styles) {
    for (const mode of modes) {
      it(`klein ${mode} / ${s.id} contains no Qwen-only wording`, () => {
        const out = composeImagePrompt(T, { model: 'klein', mode, text: 'a red bicycle', style: s, caption: 'a street at dusk' });
        for (const re of QWEN_ONLY) expect(out).not.toMatch(re);
      });
      it(`qwen ${mode} / ${s.id} contains no Klein-only wording`, () => {
        const out = composeImagePrompt(T, { model: 'qwen', mode, text: 'a red bicycle', style: s, caption: 'a street at dusk' });
        for (const re of KLEIN_ONLY) expect(out).not.toMatch(re);
      });
    }
  }
  it('reference tokens are model-specific', () => {
    expect(refToken(T, 'qwen', 2)).toBe('<image2>');
    expect(refToken(T, 'klein', 2)).toBe('image 2');
  });
});

describe('generate', () => {
  it('appends the model-specific style sentence', () => {
    expect(composeImagePrompt(T, { model: 'klein', mode: 'generate', text: 'A fox in snow', style: style('photographic') })).toBe(
      'A fox in snow. Shot as a natural-light photograph on a 35 mm lens, with shallow depth of field, true-to-life colour and fine film grain.',
    );
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'generate', text: 'A fox in snow', style: style('photographic') })).toMatch(
      /^A fox in snow\. Style: realistic photography/,
    );
  });
  it('style None leaves the prompt as written (plus a full stop)', () => {
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'generate', text: 'Poster reading "OPEN"', style: style('none') })).toBe('Poster reading "OPEN"');
  });
});

describe('edit modes', () => {
  it('instruct adds a preservation clause', () => {
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'instruct', text: 'make the net blue' })).toBe('make the net blue. Keep everything else unchanged.');
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'instruct', text: 'make the net blue', masked: true })).toBe(
      'make the net blue. Keep the rest of the image unchanged.',
    );
    expect(composeImagePrompt(T, { model: 'klein', mode: 'instruct', text: 'Make the net blue.' })).toMatch(/^Make the net blue\. Keep the composition/);
  });
  it("instruct doesn't double up when the user already says what to keep", () => {
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'instruct', text: 'Make it night, keep the man unchanged' })).toBe(
      'Make it night, keep the man unchanged.',
    );
  });
  it('qwen inpaint keeps the user text for adding content (A/B: the official template left remnants)', () => {
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: 'A stack of old books', caption: 'a fisherman on a pier' })).toBe('A stack of old books.');
  });
  it('qwen removal (background plate) uses the official template with the caption', () => {
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: 'the background', caption: 'a fisherman on a pier', remove: true })).toBe(
      'Perform inpainting on this image. Fill the marked area with the background. The original caption is: a fisherman on a pier.',
    );
  });
  it('klein inpaint describes the fill in scene context', () => {
    expect(composeImagePrompt(T, { model: 'klein', mode: 'inpaint', text: 'A stack of old books.' })).toBe(
      'a stack of old books, blending seamlessly into the surrounding scene with matching lighting, perspective, colour and texture.',
    );
  });
  it('outpaint templates', () => {
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'outpaint', text: 'pine trees', caption: 'a lake at dawn' })).toBe(
      'Extend the image beyond its boundaries using outpainting. The original caption is: a lake at dawn. The new areas show pine trees.',
    );
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'outpaint', text: '' })).toBe('Extend the image beyond its boundaries using outpainting.');
    expect(composeImagePrompt(T, { model: 'klein', mode: 'outpaint', text: 'pine trees' })).toBe(
      'Continue the scene beyond its original edges, showing pine trees, matching the existing lighting, perspective, colour palette and style.',
    );
    expect(composeImagePrompt(T, { model: 'klein', mode: 'outpaint', text: '' })).toMatch(/^Continue the scene beyond its original edges, matching/);
  });
});

describe('motion', () => {
  it('uses the model-specific camera phrase', () => {
    expect(composeMotionPrompt(T, cams, { model: 'wan', motion: 'She turns her head', camera: ['push'] })).toBe(
      'She turns her head. The camera slowly pushes in toward the subject.',
    );
    expect(composeMotionPrompt(T, cams, { model: 'ltx', motion: 'She turns her head', camera: ['push'] })).toBe(
      'She turns her head. The camera slowly pushes in toward the subject until it fills most of the frame.',
    );
  });
  it('falls back to a model-specific default when empty', () => {
    expect(composeMotionPrompt(T, cams, { model: 'wan', motion: '', camera: [] })).toBe(T.wan.fallback);
    expect(composeMotionPrompt(T, cams, { model: 'ltx', motion: '  ', camera: [] })).toBe(T.ltx.fallback);
    expect(composeMotionPrompt(T, cams, { model: 'wan', motion: '', camera: ['static'] })).toBe(cams[0].wan);
  });
});

describe('caption source', () => {
  const items = [
    { id: 'a', mode: 'generate', prompt: 'A fisherman on a pier. Shot as a…', parent_id: null, ui: { prompt: 'A fisherman on a pier' } },
    { id: 'b', mode: 'edit:instruct', prompt: 'make the net blue', parent_id: 'a' },
    { id: 'c', mode: 'edit:inpaint', prompt: 'lobster traps', parent_id: 'b' },
  ];
  it('walks up to the generated picture and never returns an instruction', () => {
    expect(captionFromLineage(items, 'c')).toBe('A fisherman on a pier');
  });
  it('prefers an explicit caption when an item has one', () => {
    expect(captionFromLineage([...items, { id: 'd', mode: 'import', prompt: 'x.png', parent_id: null, ui: { caption: 'a red car' } }], 'd')).toBe('a red car');
  });
  it('returns null for imports without a caption', () => {
    expect(captionFromLineage([{ id: 'i', mode: 'import', prompt: 'photo.png', parent_id: null }], 'i')).toBeNull();
  });
});

describe('fill', () => {
  it('drops empty placeholders cleanly', () => expect(fill('{a} {b}.', { a: 'Hello.' })).toBe('Hello.'));
});

describe('enhance', () => {
  it('Klein describes the picture then asks for detail', () => {
    expect(composeImagePrompt(T, { model: 'klein', mode: 'enhance', text: '', caption: 'A fisherman on a pier', strength: 'subtle' })).toBe(
      'A fisherman on a pier. Crisp focus, fine natural detail and clean texture, with the same composition, people, text and colours.',
    );
    expect(composeImagePrompt(T, { model: 'klein', mode: 'enhance', text: '', strength: 'strong' })).toMatch(/^A high-quality version of this picture\. Re-rendered/);
  });
  it('Qwen gets an instruction with explicit preservation and the caption', () => {
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'enhance', text: '', caption: 'a red car', strength: 'subtle' })).toBe(
      'Enhance this image: sharpen fine detail and clarity, and clean up noise and compression artifacts. Keep the composition, identity, all text and colours unchanged. The original caption is: a red car.',
    );
  });
  // Addenda Phase 2 A/B (docs/qa/addenda/p2): edit-style "Restore" won on blur for both models
  it('Klein Restore adds a Scene line from the caption, and drops it when there is none', () => {
    const withScene = composeImagePrompt(T, { model: 'klein', mode: 'enhance', text: '', caption: 'A red vintage car in front of a blue house.', strength: 'restore' });
    expect(withScene).toMatch(/^Restore this photograph: /);
    expect(withScene).toMatch(/not a processed one\. Scene: A red vintage car in front of a blue house\.$/);
    expect(composeImagePrompt(T, { model: 'klein', mode: 'enhance', text: '', strength: 'restore' })).toMatch(/not a processed one\.$/);
  });
  it('Qwen Restore names the edit target the official way and ignores the caption', () => {
    const p = composeImagePrompt(T, { model: 'qwen', mode: 'enhance', text: '', caption: 'a red car', strength: 'restore' });
    expect(p).toMatch(/^Enhance the overall quality of <image1>: /);
    expect(p).not.toContain('red car');
  });
});

describe('Qwen inpaint with the mask shown as <image2> (Addenda Phase 3 winner)', () => {
  it('names the mask and asks for a replacement', () => {
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: 'A small glass vase of yellow tulips', maskShown: true })).toBe(
      'In <image1>, replace the area marked white in <image2> with a small glass vase of yellow tulips. Keep everything outside that area unchanged.',
    );
  });
  it('moves the reference to <image3> because the mask takes <image2>', () => {
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: 'a toy model of the car in <image2>', maskShown: true })).toContain('the car in <image3>');
  });
  it('keeps quoted text exactly', () => {
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: '"Open 7 till 7" chalk lettering', maskShown: true })).toContain('with "Open 7 till 7" chalk lettering.');
  });
  it('the background plate keeps the official removal wording', () => {
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: 'the background', remove: true, maskShown: true })).toMatch(/^Perform inpainting/);
  });
});

describe('qwen fill keeps quoted text intact', () => {
  it('does not strip a closing quote', () => {
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: 'a sign reading "OPEN"' })).toBe('a sign reading "OPEN".');
  });
});
