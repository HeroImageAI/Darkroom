import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildVlmRequest, cleanVlmOutput, VLM_VARIANTS, type VlmPrompts, type VlmTask } from '../src/shared/vlm';

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
});
