/**
 * Your own Klein 9B fine-tunes (DECISIONS 91). A diffusion model counts as a Klein 9B variant when it has the official
 * model's layers with the same sizes (read from the file headers; quantisation scales and other extras are ignored),
 * so it runs in every Klein graph and takes Klein 9B LoRAs.
 */

/** Share (0–1) of the reference model's 2-D layers that the candidate has with the same input width. */
export function sameLayers(candidate: Map<string, number>, reference: Map<string, number>): number {
  if (!reference.size) return 0;
  let hits = 0;
  for (const [k, w] of reference) if (candidate.get(k) === w) hits++;
  return hits / reference.size;
}

/** Variant when ≥ 98 % of the layers match and it has no more than 5 % extra ones (a bigger model built on Klein is not Klein). */
export function isVariantOf(candidate: Map<string, number>, reference: Map<string, number>): boolean {
  return sameLayers(candidate, reference) >= 0.98 && candidate.size <= reference.size * 1.05;
}

/** BFL's own Klein 9B files (other precisions of the same weights) and KV builds (they need their own graph). */
export const OFFICIAL_KLEIN = /^flux-2-klein-9b(?:-fp8|-fp8mixed|-fp8_e4m3fn)?\.safetensors$|(?:^|[-_])kv(?:[-_.]|$)/i;

export const MODEL_LABEL = (name: string) => name.replace(/^.*[\/]/, '').replace(/\.safetensors$/i, '');
