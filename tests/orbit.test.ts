import { describe, expect, it } from 'vitest';
import { ORBIT_LORA, orbitLabel, orbitPrompt, TURNAROUND, validMove } from '../src/shared/orbit.js';

describe('Turn it (orbit LoRA)', () => {
  it('speaks the LoRA card\'s instruction forms', () => {
    expect(orbitPrompt({ angle: 90, side: 'left', height: 'eye' })).toBe('<orbit> rotate the camera 90 degrees to the left, eye level. The image has alpha channel and the background is transparent.');
    expect(orbitPrompt({ angle: 45, side: 'right', height: 'elevated' })).toMatch(/^<orbit> rotate the camera 45 degrees to the right, elevated\./);
    expect(orbitPrompt({ angle: 180, side: 'left', height: 'eye' })).toMatch(/^<orbit> rotate the camera 180 degrees, eye level\./); // no side at 180
    expect(orbitPrompt({ angle: 0, side: 'left', height: 'low' })).toMatch(/^<orbit> keep the camera angle, low angle\./);
  });
  it('a height-only move needs a height', () => {
    expect(validMove({ angle: 0, side: 'left', height: 'eye' })).toBe(false);
    expect(() => orbitPrompt({ angle: 0, side: 'left', height: 'eye' })).toThrow();
  });
  it('labels read like a person would say them', () => {
    expect(orbitLabel({ angle: 90, side: 'left', height: 'eye' })).toBe('Turned 90° left');
    expect(orbitLabel({ angle: 45, side: 'right', height: 'elevated' })).toBe('Turned 45° right, from above');
    expect(orbitLabel({ angle: 0, side: 'right', height: 'low' })).toBe('Seen from low');
  });
  it('turnaround: three turns, all four sides with the picture', () => {
    expect(TURNAROUND.map((m) => m.angle)).toEqual([90, 180, 90]);
    expect(TURNAROUND.every(validMove)).toBe(true);
  });
  it('finds the LoRA file (the ComfyUI-mappable copy)', () => {
    expect(ORBIT_LORA.test('qwen-image-2.1-viewpoint-orbit-comfy.safetensors')).toBe(true);
    expect(ORBIT_LORA.test('qwen-image-2.1-viewpoint-orbit.safetensors.orig')).toBe(false);
  });
});
