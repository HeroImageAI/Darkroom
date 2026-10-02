/**
 * Model-aware prompt composition. Every prompt Darkroom sends to a model is built here from
 * presets/prompts.json + styles.json + camera.json, keyed by model, so a Klein-style prompt can
 * never reach Qwen (or the reverse) and Wan/LTX get their own motion phrasing.
 * Rules and sources: docs/PROMPT_AUDIT.md.
 */

export type ImageModelKey = 'klein' | 'qwen';
export type VideoModelKey = 'wan' | 'ltx';
export type ImageMode = 'generate' | 'instruct' | 'inpaint' | 'outpaint' | 'enhance';

export interface ImageTemplates {
  generate: string;
  ref_token: string;
  ref_hint: string;
  instruct: string;
  instruct_masked: string;
  /** Qwen: circle quick edit — the picture carries a red circle round the target (Addenda Phase 3). */
  instruct_circled?: string;
  inpaint: string;
  outpaint: string;
  outpaint_surroundings: string;
  outpaint_default?: string;
  caption?: string;
  /** Qwen only: native RGBA output wording (model card). */
  transparent?: string;
  /** Qwen: official restoration wording, used when removing something (background plate). */
  inpaint_remove?: string;
  /** Qwen: inpaint wording when the mask is shown to the model as <image2>. */
  inpaint_masked?: string;
  /** Outpaint on a pre-padded black canvas; {scene} gets outpaint_scene. */
  outpaint_canvas?: string;
  outpaint_scene?: string;
  enhance_subtle?: string;
  enhance_strong?: string;
  enhance_default_caption?: string;
  /** Edit-style Enhance ("Restore"): instruction with preservation clauses; {scene} gets enhance_scene if set. */
  enhance_restore?: string;
  enhance_scene?: string;
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
  /** Instruct only: image_1 carries a red circle round the target (circle quick edit). */
  circled?: boolean;
  /** Description of the original picture (for Qwen inpaint/outpaint). Never an edit instruction. */
  caption?: string | null;
  /** Generate only, Qwen only: ask for a transparent background (real alpha). */
  transparent?: boolean;
  /** Enhance only. "restore" = edit-style (Addenda Phase 2); subtle/strong = img2img touch-up. */
  strength?: 'subtle' | 'strong' | 'restore';
  /** Inpaint only: the fill removes something (background plate) rather than adding content. */
  remove?: boolean;
  /** Inpaint only: the graph shows the model the mask as <image2> (Qwen crop-and-stitch, Addenda Phase 3). */
  maskShown?: boolean;
  /** Outpaint only: the picture was pre-padded on a black canvas (Addenda Phase 4); use the canvas templates. */
  canvas?: boolean;
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
      // the circle must always be asked away, even when the user already said what to keep
      if (a.circled && tpl.instruct_circled) return fill(tpl.instruct_circled, { instruction: sentence(text) });
      if (PRESERVE_WORDS.test(text)) return tidy(sentence(text)); // the user already said what to keep
      return fill(a.masked ? tpl.instruct_masked : tpl.instruct, { instruction: sentence(text) });
    }
    case 'inpaint': {
      if (a.maskShown && !a.remove && tpl.inpaint_masked) {
        // the mask itself is <image2>, so a reference picture the user calls <image2> is sent as <image3>
        return fill(tpl.inpaint_masked, { fill: fragment(text.replace(/<image2>/g, '<image3>')) });
      }
      const caption = a.caption && tpl.caption ? sub(tpl.caption, { text: sentence(a.caption) }) : '';
      return fill(a.remove && tpl.inpaint_remove ? tpl.inpaint_remove : tpl.inpaint, { fill: a.remove || a.model === 'klein' ? fragment(text) : text.trim().replace(/\.+$/, ''), caption });
    }
    case 'enhance': {
      if (a.strength === 'restore') {
        if (!tpl.enhance_restore) throw new Error(`No restore template for ${a.model}`);
        const cap = (a.caption ?? '').trim().replace(/[.!?]+$/, '');
        const scene = cap && tpl.enhance_scene ? sub(tpl.enhance_scene, { text: cap }) : '';
        return fill(tpl.enhance_restore, { scene });
      }
      const tplText = a.strength === 'strong' ? tpl.enhance_strong : tpl.enhance_subtle;
      if (!tplText) throw new Error(`No enhance template for ${a.model}`);
      if (a.model === 'klein') {
        const cap = sentence(a.caption ?? '') || tpl.enhance_default_caption || '';
        return fill(tplText, { caption: cap });
      }
      const caption = a.caption && tpl.caption ? sub(tpl.caption, { text: sentence(a.caption) }) : '';
      return fill(tplText, { caption });
    }
    case 'outpaint': {
      if (a.canvas && tpl.outpaint_canvas) {
        // the user's description of the new areas wins over the caption of the old picture
        const scene = (text || (a.caption ?? '')).trim().replace(/[.!?]+$/, '');
        return fill(tpl.outpaint_canvas, { scene: scene && tpl.outpaint_scene ? sub(tpl.outpaint_scene, { text: a.model === 'qwen' ? fragment(scene) : scene }) : '' });
      }
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
  /** What the clip should sound like (DECISIONS 97), added after motion and camera; speech in double quotes. */
  sound?: string;
}

export function composeMotionPrompt(t: PromptTemplates, cams: CameraPreset[], a: ComposeMotionArgs): string {
  const tpl = t[a.model];
  const phrases = a.camera
    .map((id) => cams.find((c) => c.id === id))
    .filter((c): c is CameraPreset => !!c)
    .map((c) => c[a.model]);
  const motion = sentence(a.motion) || (phrases.length ? '' : tpl.fallback);
  const body = fill(tpl.motion, { motion, camera: phrases.join(' ') }) || tidy(tpl.fallback);
  // the sound description reads as its own sentence: capital first, a full stop unless it ends in . ! ? (inside or outside quotes)
  const raw = (a.sound ?? '').trim().replace(/\s+/g, ' ');
  const sound = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) + (/[.!?]["”']?$/.test(raw) ? '' : '.') : '';
  return sound ? `${body} ${sound}` : body;
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
