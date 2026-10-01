import { describe, expect, it } from 'vitest';
import { injectLoras, loraFit, modelModules, parseLoras } from '../src/shared/loras';
import type { ApiPrompt } from '../src/shared/workflow';

// a tiny "Klein-like" model header: 4096 wide
const klein = modelModules({
  'double_blocks.0.img_attn.qkv.weight': { shape: [12288, 4096] },
  'double_blocks.0.img_attn.proj.weight': { shape: [4096, 4096] },
  'single_blocks.0.linear1.weight': { shape: [36864, 4096] },
});

describe('LoRA fit', () => {
  it('a LoRA made for the model fits (native names)', () => {
    const f = loraFit(
      {
        __metadata__: { ss_base_model_version: 'flux2_klein_9b' },
        'diffusion_model.double_blocks.0.img_attn.qkv.lora_A.weight': { shape: [32, 4096] },
        'diffusion_model.double_blocks.0.img_attn.qkv.lora_B.weight': { shape: [12288, 32] },
        'diffusion_model.single_blocks.0.linear1.lora_A.weight': { shape: [32, 4096] },
      },
      klein,
    );
    expect(f.score).toBe(1);
    expect(f.declared).toBe('flux2_klein_9b');
  });
  it('the same names at the wrong width (a Klein 4B LoRA) do not fit', () => {
    expect(loraFit({ 'diffusion_model.double_blocks.0.img_attn.proj.lora_A.weight': { shape: [128, 3072] } }, klein).score).toBe(0);
  });
  it('Kohya-style names are matched too', () => {
    expect(loraFit({ 'lora_unet_double_blocks_0_img_attn_proj.lora_down.weight': { shape: [16, 4096] } }, klein).score).toBe(1);
  });
  it('a LoRA for another architecture does not fit', () => {
    expect(loraFit({ 'transformer.transformer_blocks.0.attn.add_k_proj.lora_A.weight': { shape: [64, 3072] } }, klein).score).toBe(0);
  });
});

describe('LoRA injection', () => {
  const graph = (): ApiPrompt => ({
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'm.safetensors' }, _meta: { title: 'DR_MODEL' } },
    '2': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 }, _meta: { title: 'Shift' } },
    '3': { class_type: 'BasicScheduler', inputs: { model: ['1', 0] }, _meta: { title: 'DR_STEPS' } },
  });
  it('chains the LoRAs after the model and rewires every user of it', () => {
    const p = injectLoras(graph(), [
      { name: 'a.safetensors', strength: 0.8 },
      { name: 'b.safetensors', strength: 1 },
    ]);
    expect(p['4']).toMatchObject({ class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'a.safetensors', strength_model: 0.8 } });
    expect(p['5'].inputs.model).toEqual(['4', 0]);
    expect(p['2'].inputs.model).toEqual(['5', 0]);
    expect(p['3'].inputs.model).toEqual(['5', 0]);
  });
  it('does nothing without LoRAs', () => {
    expect(injectLoras(graph(), [])).toEqual(graph());
  });
  it('parses the job setting safely and caps it', () => {
    expect(parseLoras('[{"name":"a","strength":5},{"name":"b","strength":1},{"name":"c","strength":1},{"name":"d","strength":1}]')).toEqual([
      { name: 'a', strength: 2 },
      { name: 'b', strength: 1 },
      { name: 'c', strength: 1 },
    ]);
    expect(parseLoras('not json')).toEqual([]);
    expect(parseLoras(undefined)).toEqual([]);
  });
});
