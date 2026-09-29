/**
 * Model-aware prompt composition. Every prompt Darkroom sends to a model is built here from
 * presets/prompts.json + styles.json + camera.json, keyed by model, so a Klein-style prompt can
 * never reach Qwen (or the reverse) and Wan/LTX get their own motion phrasing.
 * Rules and sources: docs/PROMPT_AUDIT.md.
 */

export type ImageModelKey = 'klein' | 'qwen';
export type VideoModelKey = 'wan' | 'ltx';
export type ImageMode = 'generate' | 'instruct' | 'inpaint' | 'outpaint';

export interface ImageTemplates {
  generate: string;
  ref_token: string;
  ref_hint: string;
  instruct: string;
  instruct_masked: string;
  inpaint: string;
  outpaint: string;
  outpaint_surroundings: string;
  outpaint_default?: string;
  caption?: string;
  /** Qwen only: native RGBA output wording (model card). */
  transparent?: string;
}

export interface VideoTemplates {
  motion: string;
  fallback: string;
  max_words: number;
  hint: string;
}

export interface PromptTemplates {
  klein: ImageTemplates;
  qwen: ImageTemplates;
  wan: VideoTemplates;
  ltx: VideoTemplates;
}

export interface StylePreset {
  id: string;
  label: string;
  klein: string;
  qwen: string;
}

export interface CameraPreset {
  id: string;
  label: string;
  exclusive?: boolean;
  wan: string;
  ltx: string;
}

/** Fill {placeholders}; unknown/empty ones become ''. Then tidy whitespace and punctuation. */
export function fill(template: string, vars: Record<string, string | undefined>): string {
  const out = template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
  return tidy(out);
}

/** Substitute placeholders without tidying (for inner fragments that start with punctuation). */
export function sub(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

export function tidy(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/([.!?])\s*\.(?!\.)/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/^[\s,.;:]+/, '')
    .trim();
}

/** Ensure a user fragment ends like a sentence so a template can append another sentence. */
export function sentence(s: string): string {
  const t = s.trim();
  if (!t) return '';
  return /[.!?"')\]]$/.test(t) ? t : t + '.';
}

/** Lower-case the first letter so a user fragment reads well mid-sentence ("A stack" -> "a stack"). */
export function fragment(s: string): string {
  const t = s.trim().replace(/[.!?]+$/, '');
  if (!t) return '';
  // keep acronyms / quoted text / proper-looking words intact
  if (/^[A-Z]{2,}|^["']/.test(t)) return t;
  return t.charAt(0).toLowerCase() + t.slice(1);
}

const PRESERVE_WORDS = /\b(keep|keeping|unchanged|preserve|preserving|as it is|as they are|intact)\b/i;

export interface ComposeImageArgs {
  model: ImageModelKey;
  mode: ImageMode;
  /** Generate: the user's prompt. Instruct: the instruction. Inpaint: what fills the mask. Outpaint: optional surroundings. */
  text: string;
  style?: StylePreset | null;
  masked?: boolean;
  /** Description of the original picture (for Qwen inpaint/outpaint). Never an edit instruction. */
  caption?: string | null;
  /** Generate only, Qwen only: ask for a transparent background (real alpha). */
  transparent?: boolean;
}

export function composeImagePrompt(t: PromptTemplates, a: ComposeImageArgs): string {
  const tpl = t[a.model];
  const text = a.text.trim();
  switch (a.mode) {
    case 'generate': {
      const body = fill(tpl.generate, { prompt: sentence(text), style: a.style ? a.style[a.model] : '' });
      return a.transparent && tpl.transparent ? fill(tpl.transparent, { prompt: sentence(body) }) : body;
    }
    case 'instruct': {
      if (PRESERVE_WORDS.test(text)) return tidy(sentence(text)); // the user already said what to keep
      return fill(a.masked ? tpl.instruct_masked : tpl.instruct, { instruction: sentence(text) });
    }
    case 'inpaint': {
      const caption = a.caption && tpl.caption ? sub(tpl.caption, { text: sentence(a.caption) }) : '';
      return fill(tpl.inpaint, { fill: fragment(text), caption });
    }
    case 'outpaint': {
      if (!text && !a.caption && tpl.outpaint_default) return tidy(tpl.outpaint_default);
      const caption = a.caption && tpl.caption ? sub(tpl.caption, { text: sentence(a.caption) }) : '';
      const sur = text ? sub(tpl.outpaint_surroundings, { text: fragment(text) }) : '';
      return fill(tpl.outpaint, { caption, surroundings: sur });
    }
  }
}

/** Token the user should type to refer to reference image n (1-based) for this model. */
export function refToken(t: PromptTemplates, model: ImageModelKey, n: number): string {
  return t[model].ref_token.replace('{n}', String(n));
}

export interface ComposeMotionArgs {
  model: VideoModelKey;
  motion: string;
  camera: string[]; // camera preset ids
}

export function composeMotionPrompt(t: PromptTemplates, cams: CameraPreset[], a: ComposeMotionArgs): string {
  const tpl = t[a.model];
  const phrases = a.camera
    .map((id) => cams.find((c) => c.id === id))
    .filter((c): c is CameraPreset => !!c)
    .map((c) => c[a.model]);
  const motion = sentence(a.motion) || (phrases.length ? '' : tpl.fallback);
  return fill(tpl.motion, { motion, camera: phrases.join(' ') }) || tidy(tpl.fallback);
}

export function wordCount(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

/**
 * The best available description of an item's picture for templates that need a caption:
 * the nearest ancestor that was *generated* (its user prompt), never an edit instruction.
 */
export interface CaptionSource {
  id: string;
  mode: string;
  prompt: string;
  parent_id: string | null;
  ui?: Record<string, unknown>;
}

export function captionFromLineage(items: CaptionSource[], startId: string): string | null {
  const byId = new Map(items.map((i) => [i.id, i]));
  let cur = byId.get(startId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (typeof cur.ui?.caption === 'string' && cur.ui.caption) return cur.ui.caption as string;
    if (cur.mode === 'generate') {
      const raw = typeof cur.ui?.prompt === 'string' && cur.ui.prompt ? (cur.ui.prompt as string) : cur.prompt;
      return raw?.trim() || null;
    }
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return null;
}

/** Validate a loaded prompts.json so a hand edit can't silently break routing. */
export function validateTemplates(t: unknown): string[] {
  const errs: string[] = [];
  const o = t as Record<string, Record<string, unknown>>;
  for (const m of ['klein', 'qwen'] as const) {
    for (const k of ['generate', 'ref_token', 'instruct', 'instruct_masked', 'inpaint', 'outpaint', 'outpaint_surroundings']) {
      if (typeof o?.[m]?.[k] !== 'string') errs.push(`${m}.${k} missing`);
    }
  }
  for (const m of ['wan', 'ltx'] as const) {
    for (const k of ['motion', 'fallback']) if (typeof o?.[m]?.[k] !== 'string') errs.push(`${m}.${k} missing`);
  }
  return errs;
}
