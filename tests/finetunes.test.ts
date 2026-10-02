import { describe, expect, it } from 'vitest';
import { isVariantOf, OFFICIAL_KLEIN, sameLayers } from '../src/shared/finetunes';
import { modelModules } from '../src/shared/loras';

const klein = (prefix = '', extra: Record<string, { shape: number[] }> = {}) => ({
  [`${prefix}double_blocks.0.img_attn.qkv.weight`]: { shape: [12288, 4096] },
  [`${prefix}double_blocks.0.img_attn.qkv.weight_scale`]: { shape: [] },
  [`${prefix}single_blocks.0.linear1.weight`]: { shape: [36864, 4096] },
  [`${prefix}final_layer.linear.weight`]: { shape: [128, 4096] },
  ...extra,
});

describe('Klein fine-tunes', () => {
  const ref = modelModules(klein());
  it('a fine-tune saved with ComfyUI prefixes and without scales is the same model', () => {
    expect(sameLayers(modelModules(klein('model.diffusion_model.')), ref)).toBe(1);
    expect(isVariantOf(modelModules(klein('model.diffusion_model.')), ref)).toBe(true);
  });
  it('a model with other widths (Klein 4B, Qwen) is not', () => {
    const k4 = modelModules({ 'double_blocks.0.img_attn.qkv.weight': { shape: [9216, 3072] }, 'single_blocks.0.linear1.weight': { shape: [27648, 3072] }, 'final_layer.linear.weight': { shape: [128, 3072] } });
    expect(isVariantOf(k4, ref)).toBe(false);
  });
  it('a much bigger model that merely contains Klein layers is not', () => {
    const extra = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`extra.${i}.weight`, { shape: [64, 64] }]));
    expect(isVariantOf(modelModules(klein('', extra)), ref)).toBe(false);
  });
  it("BFL's own files and KV builds are left out", () => {
    for (const n of ['flux-2-klein-9b.safetensors', 'flux-2-klein-9b-fp8.safetensors', 'flux-2-klein-9b-fp8mixed.safetensors', 'flux-2-klein-9b-kv-fp8.safetensors', 'flux-2-klein-9b-kv.safetensors'])
      expect(OFFICIAL_KLEIN.test(n), n).toBe(true);
    for (const n of ['nsfwKlein.safetensors', 'DarkBeast-Klein9b-V2.safetensors', 'kvasir-klein.safetensors']) expect(OFFICIAL_KLEIN.test(n), n).toBe(false);
  });
});
