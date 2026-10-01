/**
 * Compose (DECISIONS 87): arrange pictures, cut-outs and painted shapes on a canvas, then let Qwen or Klein turn the
 * rough collage into one coherent picture. Pure logic shared by the screen, the server and the tests.
 */

export type RenderMode = 'blend' | 'harmonise' | 'reimagine';

export interface ComposeLayer {
  id: string;
  kind: 'picture' | 'paint';
  name: string;
  /** picture: file name in ComfyUI's input folder */
  src?: string;
  /** picture: the Library item it came from, if any */
  itemId?: string | null;
  /** paint: a PNG data URL the size of the canvas */
  paint?: string;
  /** picture: box on the canvas, in canvas pixels (paint layers always cover the canvas) */
  x: number;
  y: number;
  w: number;
  h: number;
  flip?: boolean;
  hidden?: boolean;
  /** picture has a transparent background (a cut-out) */
  cutout?: boolean;
}

export interface ComposeDoc {
  width: number;
  height: number;
  /** bottom to top */
  layers: ComposeLayer[];
  /** optional: what the finished scene should be */
  description: string;
  mode: RenderMode | 'auto';
  /** Library items rendered from this composition, newest first */
  renders?: string[];
}

export interface Composition {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  doc: ComposeDoc;
  /** small JPEG data URL for the list */
  thumb: string | null;
}

export const MODES: { id: RenderMode; label: string; model: string; text: string }[] = [
  { id: 'blend', label: 'Blend edges', model: 'Qwen-Image 2.1', text: 'Keeps your pieces exactly; only redraws the joins, fills gaps and adds contact shadows.' },
  { id: 'harmonise', label: 'Harmonise', model: 'Qwen-Image 2.1', text: 'One coherent photo: matches light, colour, ground and shadows. Faces and objects stay as they are.' },
  { id: 'reimagine', label: 'Reimagine', model: 'Klein 9B', text: 'Turns paint and rough shapes into a real photograph with the same layout. Pieces may be redrawn.' },
];

/** Blank canvas sizes (about 1 MP, multiples of 16 — what both edit models work at). */
export const ASPECTS: { label: string; w: number; h: number }[] = [
  { label: '3:2', w: 1216, h: 832 },
  { label: '1:1', w: 1024, h: 1024 },
  { label: '2:3', w: 832, h: 1216 },
  { label: '16:9', w: 1344, h: 768 },
  { label: '9:16', w: 768, h: 1344 },
  { label: '4:3', w: 1152, h: 864 },
];

/** A canvas with the picture's shape at about `mp` megapixels, sides multiples of 16. */
export function canvasSizeFor(w: number, h: number, mp = 1): { width: number; height: number } {
  const s = Math.sqrt((mp * 1024 * 1024) / (w * h));
  const r16 = (v: number) => Math.max(256, Math.round(v / 16) * 16);
  return { width: r16(w * s), height: r16(h * s) };
}

/** Where a new picture lands: centred, fitted into `fraction` of the canvas (a background fills it). */
export function placeLayer(w: number, h: number, cw: number, ch: number, fraction = 0.5): { x: number; y: number; w: number; h: number } {
  const s = Math.min((cw * fraction) / w, (ch * fraction) / h);
  const lw = Math.round(w * s);
  const lh = Math.round(h * s);
  return { x: Math.round((cw - lw) / 2), y: Math.round((ch - lh) / 2), w: lw, h: lh };
}

/** A picture that covers the whole canvas (cropping the overflow), for the background. */
export function coverLayer(w: number, h: number, cw: number, ch: number): { x: number; y: number; w: number; h: number } {
  const s = Math.max(cw / w, ch / h);
  const lw = Math.round(w * s);
  const lh = Math.round(h * s);
  return { x: Math.round((cw - lw) / 2), y: Math.round((ch - lh) / 2), w: lw, h: lh };
}

/**
 * The suggested mode. The A/B (docs/qa/COMPOSE_AB.md) showed Klein turns paint into a photo far better (Qwen keeps the
 * strokes as paint), while Qwen keeps pasted photos and faces as they are. So: mostly paint → Reimagine, otherwise
 * Harmonise. Blend edges is never chosen for you: it can't fix a piece at the wrong size or place.
 */
export function autoMode(paintCoverage: number, pictureLayers: number): { mode: RenderMode; why: string } {
  if (pictureLayers === 0) return { mode: 'reimagine', why: 'only paint on the canvas' };
  if (paintCoverage >= 0.2) return { mode: 'reimagine', why: 'a lot of the canvas is painted' };
  return { mode: 'harmonise', why: 'mostly photo pieces' };
}

const BLEND =
  'Blend this collage into one coherent, natural photograph. Keep the layout, the position and the identity of every element. Match the lighting, colour, perspective, scale and focus between the elements, and add natural contact shadows and reflections.';

export interface RenderPlan {
  workflow: 'qwen_edit' | 'klein_edit';
  model: string;
  prompt: string;
  /** Blend edges: only the seams (a mask from the layers' edges) are redrawn */
  mask: boolean;
  feather?: number;
}

export function renderPlan(mode: RenderMode, description: string): RenderPlan {
  const d = description.trim().replace(/\s+/g, ' ');
  const scene = d ? ` The scene: ${/[.!?]$/.test(d) ? d : d + '.'}` : '';
  if (mode === 'blend')
    return {
      workflow: 'qwen_edit',
      model: 'Qwen-Image 2.1',
      prompt: `Blend the pasted elements naturally into the photograph: match the light and colour, soften the cut-out edges, fill the gaps with the surroundings and add natural contact shadows on the ground.${scene}`,
      mask: true,
      feather: 12,
    };
  if (mode === 'harmonise') return { workflow: 'qwen_edit', model: 'Qwen-Image 2.1', prompt: `${BLEND} Painted shapes become the real objects they suggest.${scene}`, mask: false };
  return {
    workflow: 'klein_edit',
    model: 'Klein 9B',
    prompt: `Turn this rough collage and painting into a realistic photograph of a real, full-size scene. Keep the composition: the position, size and colour of every shape. Every painted shape becomes the real thing it stands for, at real-world scale. Natural light, real textures, coherent perspective and shadows.${scene}`,
    mask: false,
  };
}

/** Seam mask geometry: how far the band reaches outside and inside a piece's edge, as a share of the canvas's short side. */
export function seamWidths(cw: number, ch: number): { outside: number; inside: number } {
  const s = Math.min(cw, ch);
  return { outside: Math.max(8, Math.round(s * 0.025)), inside: Math.max(4, Math.round(s * 0.009)) };
}

export function emptyDoc(w = 1216, h = 832): ComposeDoc {
  return { width: w, height: h, layers: [], description: '', mode: 'auto' };
}

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Server-side check of a composition sent by the screen; anything unexpected is dropped. */
export function sanitiseDoc(raw: unknown): ComposeDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const width = Math.round(num(r.width, 256, 4096, 0));
  const height = Math.round(num(r.height, 256, 4096, 0));
  if (!width || !height || !Array.isArray(r.layers)) return null;
  const layers: ComposeLayer[] = [];
  for (const l of r.layers.slice(0, 64) as Record<string, unknown>[]) {
    if (!l || typeof l !== 'object') continue;
    const kind = l.kind === 'paint' ? 'paint' : l.kind === 'picture' ? 'picture' : null;
    if (!kind) continue;
    const src = str(l.src, 300);
    const paint = str(l.paint, 24 * 1024 * 1024);
    // input names may have a subfolder (darkroom/…), never a way out of the input folder
    if (kind === 'picture' && (!src || /\\|\.\.|^\/|:/.test(src))) continue;
    if (kind === 'paint' && paint && !paint.startsWith('data:image/png;base64,')) continue;
    layers.push({
      id: str(l.id, 64) || Math.random().toString(36).slice(2),
      kind,
      name: str(l.name, 80) || (kind === 'paint' ? 'Paint' : 'Picture'),
      ...(kind === 'picture' ? { src, itemId: typeof l.itemId === 'string' ? l.itemId : null, cutout: !!l.cutout } : { paint }),
      x: num(l.x, -20000, 20000, 0),
      y: num(l.y, -20000, 20000, 0),
      w: num(l.w, 1, 40000, width),
      h: num(l.h, 1, 40000, height),
      flip: !!l.flip,
      hidden: !!l.hidden,
    });
  }
  const mode = (['auto', 'blend', 'harmonise', 'reimagine'] as const).find((m) => m === r.mode) ?? 'auto';
  const renders = Array.isArray(r.renders) ? (r.renders.filter((x) => typeof x === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(x)) as string[]).slice(0, 200) : [];
  return { width, height, layers, description: str(r.description, 2000), mode, renders };
}
