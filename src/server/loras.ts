import fs from 'node:fs';
import path from 'node:path';
import { loraFit, modelModules, type LoraFit } from '../shared/loras.js';
import { isVariantOf, MODEL_LABEL, OFFICIAL_KLEIN } from '../shared/finetunes.js';

/**
 * Your own LoRAs (DECISIONS 86). ComfyUI lists every LoRA it can see, but a LoRA only works on the model it was
 * trained for. Darkroom reads each file's header (layer names and sizes, never the weights) and offers a LoRA only
 * under the model whose layers it actually matches: Klein 9B or Qwen-Image 2.1.
 */
export type LoraFamily = 'klein' | 'qwen';

export interface LoraInfo {
  /** ComfyUI's lora_name (relative to its loras folders, as ComfyUI lists it). */
  name: string;
  /** File name without folder and extension. */
  label: string;
  sizeMB: number;
  /** The base model the file declares, when it does. */
  declared: string | null;
}

export interface LoraCatalogue {
  klein: LoraInfo[];
  qwen: LoraInfo[];
  /** LoRAs for other models (Flux.1, Wan, older Qwen-Image, …) or files that could not be read. */
  other: { name: string; reason: string }[];
}

/** A LoRA counts as made for a model when this share of its layers matches. */
const FIT = 0.9;

function readHeader(file: string): Record<string, any> {
  const fd = fs.openSync(file, 'r');
  try {
    const len = Buffer.alloc(8);
    fs.readSync(fd, len, 0, 8, 0);
    const n = Number(len.readBigUInt64LE(0));
    if (!(n > 0 && n < 200_000_000)) throw new Error('not a safetensors file');
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 8);
    return JSON.parse(buf.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

export interface FinetuneInfo {
  /** ComfyUI's unet_name */
  name: string;
  label: string;
  sizeGB: number;
}

export class LoraLibrary {
  private models = new Map<string, Map<string, number>>();
  private variants = new Map<string, { key: string; ok: boolean }>();
  private fits = new Map<string, { key: string; klein: LoraFit; qwen: LoraFit } | { key: string; error: string }>();

  constructor(private comfyUrl: () => string | null) {}

  private async comfyJson<T>(p: string): Promise<T> {
    const url = this.comfyUrl();
    if (!url) throw new Error("ComfyUI isn't running.");
    const r = await fetch(url + p, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`ComfyUI ${p}: ${r.status}`);
    return (await r.json()) as T;
  }

  /** The layers of a diffusion model, read once from its header. */
  private async modelLayers(unetName: string): Promise<Map<string, number>> {
    const cached = this.models.get(unetName);
    if (cached) return cached;
    const folders = (await this.comfyJson<Record<string, string[]>>('/internal/folder_paths')).diffusion_models ?? [];
    const file = folders.map((d) => path.join(d, unetName)).find((f) => fs.existsSync(f));
    if (!file) throw new Error(`Model file ${unetName} not found`);
    const layers = modelModules(readHeader(file));
    this.models.set(unetName, layers);
    return layers;
  }

  /**
   * Your own fine-tunes of a model (DECISIONS 91): every diffusion model ComfyUI lists whose layers match the official
   * one (headers only, cached by size and date). BFL's own files and KV builds are left out.
   */
  async finetunes(official: string): Promise<FinetuneInfo[]> {
    const [folders, info] = await Promise.all([
      this.comfyJson<Record<string, string[]>>('/internal/folder_paths').then((f) => f.diffusion_models ?? []),
      this.comfyJson<Record<string, any>>('/object_info/UNETLoader'),
    ]);
    const names: string[] = info.UNETLoader?.input?.required?.unet_name?.[0] ?? [];
    const ref = await this.modelLayers(official);
    const out: FinetuneInfo[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const base = path.basename(name);
      if (name === official || OFFICIAL_KLEIN.test(base) || !/.safetensors$/i.test(name)) continue;
      const file = folders.map((d) => path.join(d, name)).find((f) => fs.existsSync(f));
      if (!file) continue;
      const st = fs.statSync(file);
      const key = `${st.size}:${st.mtimeMs}`;
      let v = this.variants.get(file);
      if (!v || v.key !== key) {
        let ok = false;
        try {
          ok = isVariantOf(modelModules(readHeader(file)), ref);
        } catch {
          ok = false;
        }
        v = { key, ok };
        this.variants.set(file, v);
      }
      const id = `${base}:${st.size}`;
      if (v.ok && !seen.has(id)) {
        seen.add(id);
        out.push({ name, label: MODEL_LABEL(name), sizeGB: Math.round(st.size / 1e8) / 10 });
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Every LoRA ComfyUI can see, sorted by the model it fits. */
  async catalogue(models: Record<LoraFamily, string>): Promise<LoraCatalogue> {
    const [folders, info] = await Promise.all([
      this.comfyJson<Record<string, string[]>>('/internal/folder_paths').then((f) => f.loras ?? []),
      this.comfyJson<Record<string, any>>('/object_info/LoraLoaderModelOnly'),
    ]);
    const names: string[] = info.LoraLoaderModelOnly?.input?.required?.lora_name?.[0] ?? [];
    const layers = { klein: await this.modelLayers(models.klein), qwen: await this.modelLayers(models.qwen) };
    const out: LoraCatalogue = { klein: [], qwen: [], other: [] };
    for (const name of names) {
      const file = folders.map((d) => path.join(d, name)).find((f) => fs.existsSync(f));
      if (!file) continue;
      const st = fs.statSync(file);
      const key = `${st.size}:${st.mtimeMs}`;
      let fit = this.fits.get(file);
      if (!fit || fit.key !== key) {
        try {
          const h = readHeader(file);
          fit = { key, klein: loraFit(h, layers.klein), qwen: loraFit(h, layers.qwen) };
        } catch (e) {
          fit = { key, error: (e as Error).message };
        }
        this.fits.set(file, fit);
      }
      const label = path.basename(name).replace(/\.safetensors$/i, '');
      if ('error' in fit) {
        out.other.push({ name, reason: `Unreadable file (${fit.error})` });
        continue;
      }
      const entry: LoraInfo = { name, label, sizeMB: Math.round(st.size / 1048576), declared: fit.klein.declared };
      if (fit.klein.score >= FIT) out.klein.push(entry);
      else if (fit.qwen.score >= FIT) out.qwen.push(entry);
      else out.other.push({ name, reason: fit.klein.declared ? `Made for ${fit.klein.declared}` : 'Made for another model' });
    }
    // the same file listed twice (e.g. at the top level and in a sub-folder): show it once
    for (const fam of ['klein', 'qwen'] as const) {
      const seen = new Set<string>();
      out[fam] = out[fam].filter((l) => (seen.has(`${l.label}:${l.sizeMB}`) ? false : (seen.add(`${l.label}:${l.sizeMB}`), true)));
      out[fam].sort((a, b) => a.label.localeCompare(b.label));
    }
    return out;
  }
}
