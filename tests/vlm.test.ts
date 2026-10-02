import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildVlm2Request, buildVlmRequest, cleanVlmOutput, nearestAspect, parsePeJson, VLM_VARIANTS, withEnhanceStyle, dropCameraSentences, withCameraMoves, withSound, dropCopiedSound, type VlmPrompts, type VlmTask } from '../src/shared/vlm';

const P = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'presets', 'vlm_prompts.json'), 'utf8')) as VlmPrompts;

describe('vlm_prompts.json', () => {
  for (const [task, variants] of Object.entries(VLM_VARIANTS) as [VlmTask, string[]][]) {
    for (const v of variants) {
      it(`${task}/${v} exists with a system prompt and a token budget`, () => {
        expect(P[task][v].system.length).toBeGreaterThan(40);
        expect(P[task][v].max_tokens).toBeGreaterThan(20);
      });
    }
  }
  it('model-specific rules stay model-specific', () => {
    expect(P.reverse.qwen.system).toMatch(/quot/i);
    expect(P.reverse.klein.system).not.toMatch(/Ultra HD/);
    expect(P.enhance.klein.system).not.toMatch(/Ultra HD/);
    expect(P.motion.wan.system).toMatch(/100 words/);
    expect(P.motion.ltx.system).toMatch(/present tense/);
  });
});

describe('buildVlmRequest', () => {
  it('routes image tasks to the image workflow and enhance to text-only', () => {
    expect(buildVlmRequest(P, 'caption', 'short').workflow).toBe('vlm_image');
    expect(buildVlmRequest(P, 'enhance', 'qwen', 'a cat').workflow).toBe('vlm_text');
  });
  it('fills the user text', () => {
    expect(buildVlmRequest(P, 'enhance', 'klein', 'a red fox').prompt).toContain('User input: a red fox');
  });
  it('uses the empty-prompt variant for motion without text', () => {
    expect(buildVlmRequest(P, 'motion', 'wan', '').prompt).toContain('Bring the image to life');
    expect(buildVlmRequest(P, 'motion', 'wan', 'she waves').prompt).toContain('User text: she waves');
  });
  it('refuses to enhance nothing and unknown variants', () => {
    expect(() => buildVlmRequest(P, 'enhance', 'qwen', '  ')).toThrow(/Type a prompt/);
    expect(() => buildVlmRequest(P, 'caption', 'poem')).toThrow(/Unknown/);
  });
});

describe('cleanVlmOutput', () => {
  it('strips think blocks, labels, fences and wrapping quotes', () => {
    expect(cleanVlmOutput('<think>hmm</think>\nRewritten prompt: "A red fox in snow."')).toBe('A red fox in snow.');
    expect(cleanVlmOutput('```\nA cat\n```')).toBe('A cat');
    expect(cleanVlmOutput('**Prompt:** A cat')).toBe('A cat');
  });
  it('keeps inner quotes for text rendering', () => {
    expect(cleanVlmOutput('A sign reading "OPEN" above the door.')).toBe('A sign reading "OPEN" above the door.');
  });
  // real Qwen3-VL outputs from the Phase 6 QA run
  it('drops a sentence cut off at the token limit', () => {
    const raw = 'A quaint bakery on a cobbled street. A chalkboard reads "Fresh bread daily." Shot at eye level, the frame captures the inviting storefront aga';
    expect(cleanVlmOutput(raw)).toBe('A quaint bakery on a cobbled street. A chalkboard reads "Fresh bread daily."');
    expect(cleanVlmOutput('Shallow depth of field, fine detail. Ultra HD, 4K,')).toBe('Shallow depth of field, fine detail.');
  });
  it('keeps a long fragment rather than losing most of the answer', () => {
    expect(cleanVlmOutput('Hi. A long single clause about a lighthouse in a storm with waves')).toBe('Hi. A long single clause about a lighthouse in a storm with waves');
  });
  it('strips a stray closing quote on its own line', () => {
    expect(cleanVlmOutput('An elderly woman smiles by a window.\n\n"')).toBe('An elderly woman smiles by a window.');
    expect(cleanVlmOutput('A sign reads "OPEN"')).toBe('A sign reads "OPEN"');
  });
});

describe('v2 routing (Addenda Phase 7)', () => {
  const P: any = {
    models: { general: { file: 'general.safetensors', label: 'General' }, pe_t2i: { file: 't2i.safetensors', label: 'PE-T2I' }, pe_i2i: { file: 'i2i.safetensors', label: 'PE-I2I', loader: 'stable_diffusion' } },
    enhance: { qwen: { engine: 'pe_t2i', system_file: 'pe/t2i.txt', output: 'json_ratio', temperature: 1, top_p: 0.95 }, klein: { system: 'KLEIN SYS', user: 'User input: {text}', max_tokens: 300 } },
    edit_enhance: { qwen: { engine: 'pe_i2i', system_file: 'pe/i2i.txt', image: true } },
  };
  const files = (rel: string) => `FILE:${rel}`;
  it('Qwen prompt enhance goes to PE-T2I with its system prompt file and the raw user words', () => {
    const r = buildVlm2Request(P, 'enhance', 'qwen', ' a cat ', files);
    expect(r).toMatchObject({ workflow: 'vlm2_text', output: 'json_ratio', modelLabel: 'PE-T2I' });
    expect(r.params).toMatchObject({ model: 't2i.safetensors', system: 'FILE:pe/t2i.txt', prompt: 'a cat', temperature: 1, top_p: 0.95 });
  });
  it('Klein enhance uses the general model with a real system prompt and the user template', () => {
    expect(buildVlm2Request(P, 'enhance', 'klein', 'a cat').params).toMatchObject({ model: 'general.safetensors', system: 'KLEIN SYS', prompt: 'User input: a cat', max_tokens: 300 });
  });
  it('Qwen edit instructions go to PE-I2I with the picture', () => {
    expect(buildVlm2Request(P, 'edit_enhance', 'qwen', 'make it night', files)).toMatchObject({ workflow: 'vlm2_image', modelLabel: 'PE-I2I' });
    expect(() => buildVlm2Request(P, 'edit_enhance', 'qwen', ' ', files)).toThrow(/instruction/);
  });
  it('parsePeJson reads rewritten_prompt + wh_ratio, and falls back to plain text', () => {
    expect(parsePeJson('</think>\n{"rewritten_prompt": "A fox.", "wh_ratio": "2:3"}')).toEqual({ text: 'A fox.', ratio: '2:3' });
    expect(parsePeJson('A fox in snow.')).toEqual({ text: 'A fox in snow.', ratio: null });
  });
  it('nearestAspect snaps PE ratios to Darkroom aspects', () => {
    expect(nearestAspect('3:2')).toBe('3:2');
    expect(nearestAspect('2:3')).toBe('4:5');
    expect(nearestAspect('21:9')).toBe('16:9');
    expect(nearestAspect('1:2')).toBe('9:16');
    expect(nearestAspect('nonsense')).toBeNull();
  });
  it('cleanVlmOutput drops a lone opening quote but keeps quoted text', () => {
    expect(cleanVlmOutput('</think>\n\n"Change the sign "A" to "B". Keep the rest.')).toBe('Change the sign "A" to "B". Keep the rest.');
    expect(cleanVlmOutput('"OPEN" is painted on the door.')).toBe('"OPEN" is painted on the door.');
  });
});

describe('stripLeakedReasoning', () => {
  it('keeps the text after the last "Final version:" marker', () => {
    const raw = 'The user\'s instruction is "make it night."\n\nIntent: change to night.\n\nFinal version:\n\nChange the scene to night: darken the sky.';
    expect(cleanVlmOutput(raw)).toBe('Change the scene to night: darken the sky.');
  });
  it('falls back to the last paragraph when the answer starts with reasoning and has no marker', () => {
    const raw = "The user's instruction is to add snow.\n\nCheck the rules: no negations.\n\nCover the roofs and the street in fresh snow.";
    expect(cleanVlmOutput(raw)).toBe('Cover the roofs and the street in fresh snow.');
  });
  it('leaves normal multi-paragraph answers alone', () => {
    const raw = 'A lighthouse on a cliff.\n\nWaves crash below.';
    expect(cleanVlmOutput(raw)).toBe(raw);
  });
});

describe('wrapping quotes', () => {
  it('strips quotes around the whole answer even when it quotes text inside', () => {
    expect(cleanVlmOutput('</think>\n\n"Change it to night. Keep the plate "E65 8Q4S" unchanged."')).toBe('Change it to night. Keep the plate "E65 8Q4S" unchanged.');
  });
  it('keeps an answer that merely starts and ends with separate quotations', () => {
    const t = '"SUNRISE BAKERY" becomes "MOONLIGHT BAKERY"';
    expect(cleanVlmOutput(t)).toBe(t);
  });
});

describe('Enhance with a style (DECISIONS 93)', () => {
  const base = { workflow: 'vlm2_text' as const, params: { system: 'SYS', prompt: 'User input: a fox\nRewritten prompt:' }, modelLabel: 'm', output: 'text' as const };
  it('the general engine gets the style in its instructions, the official Qwen enhancer after the idea', () => {
    const k = withEnhanceStyle(base, 'Rendered as an ink sketch.', true);
    expect(k.params.system).toMatch(/^SYS\n\nThe picture will be made in this style, which is added after your prompt automatically: "Rendered as an ink sketch\." /);
    expect(k.params.system).toMatch(/Do not copy the style sentence itself\.$/);
    expect(k.params.prompt).toBe(base.params.prompt);
    const q = withEnhanceStyle(base, 'Style: ink.', false);
    expect(q.params.system).toBe('SYS');
    expect(q.params.prompt).toMatch(/^User input: a fox\nRewritten prompt:\n\nThe picture will be made in this style/);
  });
  it('no style, no change', () => {
    expect(withEnhanceStyle(base, '  ', true)).toBe(base);
  });
});

describe('Motion with camera chips (DECISIONS 94)', () => {
  const base = { workflow: 'vlm2_image' as const, params: { system: 'SYS', prompt: 'P' }, modelLabel: 'm', output: 'text' as const };
  it('the writer is told the camera move and to leave the camera alone', () => {
    const r = withCameraMoves(base, ['The camera slowly pushes in toward the subject.']);
    expect(r.params.system).toMatch(/^SYS\n\nThe camera movement is already decided and is added after your text automatically: "The camera slowly pushes in toward the subject\." /);
    expect(r.params.system).toMatch(/Do not describe any camera movement/);
    expect(withCameraMoves(base, [])).toBe(base);
  });
  it('drops the copied chip sentence and any other camera sentence, keeps the rest', () => {
    const t = 'The camera is locked off on a tripod and does not move. Gentle ripples disturb the water.\nA small orange buoy bobs. The camera holds steady on the boats. A gull cries "hello" overhead.';
    expect(dropCameraSentences(t)).toBe('Gentle ripples disturb the water. A small orange buoy bobs. A gull cries "hello" overhead.');
  });
  it('never empties the text', () => {
    expect(dropCameraSentences('The camera pans left.')).toBe('The camera pans left.');
  });
});

describe('Motion with the chosen sound (DECISIONS 97)', () => {
  const base = { workflow: 'vlm2_image' as const, params: { system: 'SYS', prompt: 'P' }, modelLabel: 'm', output: 'text' as const };
  it('Silent: no sounds; Describe: leave sound to the description; From the scene: unchanged', () => {
    expect(withSound(base, 'off').params.system).toMatch(/no sound: describe only what is seen/);
    expect(withSound(base, 'describe', 'rain on the window').params.system).toMatch(/already decided .*"rain on the window" Do not describe any sounds/);
    expect(withSound(base, 'describe', '  ')).toBe(base);
    expect(withSound(base, 'scene')).toBe(base);
    expect(withSound(base, undefined)).toBe(base);
  });
});

describe('dropCopiedSound', () => {
  it('drops a copied sound sentence, keeps the motion', () => {
    const t = 'The boats bob gently. The orange buoy bobs near the dock. Gulls cry and a ship horn sounds twice.';
    expect(dropCopiedSound(t, 'Gulls cry and a ship horn sounds twice.')).toBe('The boats bob gently. The orange buoy bobs near the dock.');
    expect(dropCopiedSound(t, '')).toBe(t);
    expect(dropCopiedSound('Gulls cry.', 'Gulls cry.')).toBe('Gulls cry.'); // never empties it
  });
});
