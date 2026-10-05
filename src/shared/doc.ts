/**
 * Edit canvas document (DECISIONS 122, Edit suite v3.25): a picture as a stack of layers — the picture itself, paint
 * layers, AI results and pictures from the Library — each with visibility, lock, alpha lock, opacity, a blend mode and
 * an optional layer mask. Saved per Library item under data/projects/<item id>/ (project.json + layer PNGs).
 * The pixels live in the browser (src/web/lib/doc.ts); this file holds what both sides share.
 */
import { sanitizeAdjust, type Adjust } from './adjust.js';

export const BLENDS = [
  { id: 'normal', label: 'Normal', op: 'source-over' },
  { id: 'multiply', label: 'Multiply', op: 'multiply' },
  { id: 'screen', label: 'Screen', op: 'screen' },
  { id: 'overlay', label: 'Overlay', op: 'overlay' },
  { id: 'soft-light', label: 'Soft light', op: 'soft-light' },
  { id: 'hard-light', label: 'Hard light', op: 'hard-light' },
  { id: 'color-dodge', label: 'Colour dodge', op: 'color-dodge' },
  { id: 'color-burn', label: 'Colour burn', op: 'color-burn' },
  { id: 'darken', label: 'Darken', op: 'darken' },
  { id: 'lighten', label: 'Lighten', op: 'lighten' },
  { id: 'difference', label: 'Difference', op: 'difference' },
  { id: 'exclusion', label: 'Exclusion', op: 'exclusion' },
  { id: 'hue', label: 'Hue', op: 'hue' },
  { id: 'saturation', label: 'Saturation', op: 'saturation' },
  { id: 'color', label: 'Colour', op: 'color' },
  { id: 'luminosity', label: 'Luminosity', op: 'luminosity' },
] as const;

export type Blend = (typeof BLENDS)[number]['id'];

/** picture = the item itself or a Library picture, paint = drawn here, result = an AI result applied as a layer. */
/** adjust = an adjustment layer (DECISIONS 124): no pixels, it changes the look of everything below it */
export type LayerKind = 'picture' | 'paint' | 'result' | 'adjust';

export interface DocLayerMeta {
  id: string;
  name: string;
  kind: LayerKind;
  /** Library item the pixels came from (picture / result); unchanged ones are loaded from the item, not stored again. */
  source?: string;
  /** true once its pixels differ from `source` (then layers/<id>.png holds them). */
  painted: boolean;
  visible: boolean;
  locked: boolean;
  alphaLock: boolean;
  opacity: number;
  blend: Blend;
  /** has masks/<id>.png (white = shown). */
  mask: boolean;
  maskOn: boolean;
  /** bumped on every pixel change; a cache-buster for the stored PNGs. */
  rev: number;
  /** an adjustment layer's settings */
  adjust?: Adjust;
}

export interface DocJson {
  v: 1;
  itemId: string;
  width: number;
  height: number;
  /** bottom to top */
  layers: DocLayerMeta[];
  active: string;
  updatedAt: number;
}

export const LAYER_ID = /^[a-z0-9_-]{1,40}$/i;
const MAX_LAYERS = 64;

export function blendOp(b: string): GlobalCompositeOperation {
  return (BLENDS.find((x) => x.id === b)?.op ?? 'source-over') as GlobalCompositeOperation;
}

const clamp01 = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1);

/** A stored or sent document, checked and normalised; null when it isn't one. */
export function parseDoc(raw: unknown, itemId?: string): DocJson | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const w = Number(r.width);
  const h = Number(r.height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 16384 || h > 16384) return null;
  if (!Array.isArray(r.layers) || !r.layers.length || r.layers.length > MAX_LAYERS) return null;
  const seen = new Set<string>();
  const layers: DocLayerMeta[] = [];
  for (const x of r.layers as Record<string, unknown>[]) {
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !LAYER_ID.test(x.id) || seen.has(x.id)) return null;
    seen.add(x.id);
    const kind: LayerKind = x.kind === 'picture' || x.kind === 'result' || x.kind === 'adjust' ? x.kind : 'paint';
    layers.push({
      id: x.id,
      name: String(x.name ?? 'Layer').slice(0, 80) || 'Layer',
      kind,
      ...(typeof x.source === 'string' && /^[0-9a-f-]{8,40}$/i.test(x.source) ? { source: x.source } : {}),
      painted: kind !== 'adjust' && (kind === 'paint' || !!x.painted || typeof x.source !== 'string'),
      ...(kind === 'adjust' ? { adjust: sanitizeAdjust(x.adjust) } : {}),
      visible: x.visible !== false,
      locked: !!x.locked,
      alphaLock: !!x.alphaLock,
      opacity: clamp01(x.opacity),
      blend: BLENDS.some((b) => b.id === x.blend) ? (x.blend as Blend) : 'normal',
      mask: !!x.mask,
      maskOn: x.maskOn !== false,
      rev: Number.isInteger(x.rev) ? (x.rev as number) : 0,
    });
  }
  const active = typeof r.active === 'string' && seen.has(r.active) ? r.active : layers[layers.length - 1].id;
  return { v: 1, itemId: itemId ?? String(r.itemId ?? ''), width: w, height: h, layers, active, updatedAt: Date.now() };
}

/** Move the layer at `from` to `to` (bottom-to-top indices), returning a new array. */
export function moveLayer<T>(layers: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= layers.length || to >= layers.length) return layers;
  const out = layers.slice();
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}

/** "Layer 3" → the next free number among the names. */
export function nextLayerName(names: string[], base = 'Layer'): string {
  let n = 1;
  const re = new RegExp(`^${base} (\\d+)$`);
  for (const s of names) {
    const m = re.exec(s);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  return `${base} ${n}`;
}

/**
 * Where a picture of size (w, h) goes on a w0 × h0 canvas: same size or the same shape (within 2%) fills it; anything
 * else is fitted inside and centred. AI results of the canvas come back the same shape, so they line up.
 */
export function placeOnCanvas(w: number, h: number, w0: number, h0: number): { x: number; y: number; w: number; h: number; exact: boolean } {
  if (Math.abs(w / h - w0 / h0) / (w0 / h0) <= 0.02) return { x: 0, y: 0, w: w0, h: h0, exact: true };
  const s = Math.min(w0 / w, h0 / h);
  const dw = Math.round(w * s);
  const dh = Math.round(h * s);
  return { x: Math.round((w0 - dw) / 2), y: Math.round((h0 - dh) / 2), w: dw, h: dh, exact: false };
}

/** Linear interpolation of pressure to a 0..1 factor with a floor, so a light touch still leaves a mark. */
export function pressureCurve(p: number, floor = 0.08, gamma = 1): number {
  const x = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0.5));
  return floor + (1 - floor) * Math.pow(x, gamma);
}

/** Dab positions from a to b at `spacing` px, carrying the leftover distance between calls (returns the new leftover). */
export function dabsAlong(a: { x: number; y: number }, b: { x: number; y: number }, spacing: number, carry: number): { pts: { x: number; y: number; t: number }[]; carry: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const pts: { x: number; y: number; t: number }[] = [];
  if (len === 0) return { pts, carry };
  let d = spacing - carry;
  while (d <= len) {
    const t = d / len;
    pts.push({ x: a.x + dx * t, y: a.y + dy * t, t });
    d += spacing;
  }
  return { pts, carry: len - (d - spacing) };
}
