import type { ApiPrompt } from './workflow.js';

/** A LoRA applied to a job: ComfyUI's lora_name (relative to its loras folders) and a strength. */
export interface LoraUse {
  name: string;
  strength: number;
}

/** Up to this many LoRAs per job (more rarely helps and makes results unpredictable). */
export const MAX_LORAS = 3;

/** Parse the `loras` job setting (JSON) safely; anything malformed is ignored. */
export function parseLoras(raw: unknown): LoraUse[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is LoraUse => !!x && typeof (x as LoraUse).name === 'string' && Number.isFinite((x as LoraUse).strength))
      .slice(0, MAX_LORAS)
      .map((x) => ({ name: x.name, strength: Math.max(-2, Math.min(2, x.strength)) }));
  } catch {
    return [];
  }
}

/**
 * Put LoRAs on a graph's model (DECISIONS 86): a chain of LoraLoaderModelOnly nodes after the node titled DR_MODEL
 * (the UNETLoader), and every node that used DR_MODEL's output now uses the end of the chain. Graphs that already have
 * a LoRA of their own (the restore LoRA, DR_LORA) keep it: it simply sits after the user's chain.
 */
export function injectLoras(prompt: ApiPrompt, loras: LoraUse[]): ApiPrompt {
  if (!loras.length) return prompt;
  const modelId = Object.keys(prompt).find((id) => prompt[id]._meta?.title === 'DR_MODEL' && /UNETLoader|UnetLoader/i.test(prompt[id].class_type));
  if (!modelId) throw new Error('This workflow has no model loader to put a LoRA on.');
  const consumers: [string, string][] = [];
  for (const [id, node] of Object.entries(prompt))
    for (const [k, v] of Object.entries(node.inputs)) if (Array.isArray(v) && v[0] === modelId && v[1] === 0) consumers.push([id, k]);
  let prev: [string, number] = [modelId, 0];
  let next = Math.max(...Object.keys(prompt).map((k) => Number(k) || 0)) + 1;
  loras.forEach((l, i) => {
    const id = String(next++);
    prompt[id] = { class_type: 'LoraLoaderModelOnly', inputs: { model: prev, lora_name: l.name, strength_model: l.strength }, _meta: { title: `DR_USER_LORA_${i + 1}` } };
    prev = [id, 0];
  });
  for (const [id, k] of consumers) prompt[id].inputs[k] = prev;
  return prompt;
}

/** Which LoRA keys address which model module, and with what input width. */
const SUFFIX = /\.(?:lora_A|lora_down)(?:\.default)?\.weight$/;
const PREFIXES = [/^base_model\.model\./, /^model\.diffusion_model\./, /^diffusion_model\./, /^transformer\./, /^model\./];
const strip = (k: string) => PREFIXES.reduce((s, re) => s.replace(re, ''), k);

/** Model header -> module name (dots) -> input width, for every 2-D weight. */
export function modelModules(header: Record<string, { shape?: number[] }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of Object.entries(header)) {
    if (!k.endsWith('.weight') || !v?.shape || v.shape.length !== 2) continue;
    out.set(strip(k.slice(0, -'.weight'.length)), v.shape[1]);
  }
  return out;
}

export interface LoraFit {
  /** Share (0–1) of the LoRA's layers that exist in the model with the right size. */
  score: number;
  /** The base model the LoRA declares in its metadata, if any. */
  declared: string | null;
  layers: number;
}

/**
 * How well a LoRA fits a model: its down-projection layers must exist in the model with the same input width.
 * Kohya-style names (lora_unet_double_blocks_0_img_attn_proj) are matched against the model's names with dots as _.
 */
export function loraFit(lora: Record<string, { shape?: number[] } | Record<string, string>>, model: Map<string, number>): LoraFit {
  const meta = (lora.__metadata__ ?? {}) as Record<string, string>;
  const declared = meta.ss_base_model_version ?? meta['modelspec.architecture'] ?? null;
  const underscored = new Map([...model].map(([k, v]) => [k.replace(/\./g, '_'), v]));
  let layers = 0;
  let hits = 0;
  for (const [k, v] of Object.entries(lora)) {
    if (k === '__metadata__' || !SUFFIX.test(k)) continue;
    const shape = (v as { shape?: number[] }).shape;
    if (!shape || shape.length !== 2) continue;
    layers++;
    const name = strip(k.replace(SUFFIX, ''));
    const width = name.startsWith('lora_unet_') ? underscored.get(name.slice('lora_unet_'.length)) : model.get(name);
    if (width === shape[1]) hits++;
  }
  return { score: layers ? hits / layers : 0, declared, layers };
}
