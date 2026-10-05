/**
 * Edit canvas layer document (DECISIONS 122, Edit suite v3.25). The picture becomes a stack of layers held as canvases
 * at the picture's own size: the picture itself, paint layers, AI results applied as layers, and Library pictures.
 * Each layer has visibility, lock, alpha lock, opacity, one of 16 blend modes and an optional layer mask (white =
 * shown). Every change is one undo step; strokes keep only the pixels they touched. Saved to the server per item.
 */
import { blendOp, moveLayer, nextLayerName, placeOnCanvas, type Blend, type DocJson, type LayerKind } from '../../shared/doc';
import { fileUrl } from '../api';
import { clampBox, makeStamp, paperTile, Stroke, type Box, type BrushSettings, type StrokeOptions } from './brush';
import { brushFilterCss, type BrushEngine } from '../../shared/brushes';
import { floodMask, growMask } from '../../shared/flood';
import { hexToRgb } from '../../shared/colour';

export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  source?: string;
  painted: boolean;
  visible: boolean;
  locked: boolean;
  alphaLock: boolean;
  opacity: number;
  blend: Blend;
  maskOn: boolean;
  canvas: HTMLCanvasElement;
  maskCanvas: HTMLCanvasElement | null;
  rev: number;
  maskRev: number;
}

export type PaintTarget = 'pixels' | 'mask';
type Props = Partial<Pick<Layer, 'name' | 'visible' | 'locked' | 'alphaLock' | 'opacity' | 'blend' | 'maskOn'>>;
interface Entry {
  label: string;
  undo: () => void;
  redo: () => void;
  key?: string;
  at: number;
}
/** A stroke (or shape) in progress. */
interface StrokeState {
  /** the dabs; null for a shape */
  s: Stroke | null;
  engine: BrushEngine;
  erase: boolean;
  opacity: number;
  texture: boolean;
  layerId: string;
  target: PaintTarget;
  /** filter brushes: the filtered copy that shows through */
  src: HTMLCanvasElement | null;
  /** smudge: the layer before the stroke (for Undo) */
  backup: HTMLCanvasElement | null;
  /** shapes: where the preview is */
  box?: Box;
}
interface Snap {
  layers: Layer[];
  active: string;
}

const MAX_UNDO = 80;

export function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

const rid = () => Math.random().toString(36).slice(2, 10);
const partUrl = (itemId: string, part: 'layers' | 'masks', id: string, rev: number) => `/api/items/${itemId}/project/${part}/${id}.png?r=${rev}`;

export class CanvasDoc {
  layers: Layer[] = [];
  active = '';
  /** paint on the active layer's pixels or on its mask */
  target: PaintTarget = 'pixels';
  /** bumped on every change React should show (not on every stroke sample) */
  version = 0;
  /** a new undo step was added (Edit keeps one order of mask and canvas steps) */
  onPush?: () => void;
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private listeners = new Set<() => void>();
  private paintListeners = new Set<() => void>();
  private counter = 1;
  private scratch: HTMLCanvasElement;
  private sg: CanvasRenderingContext2D;
  private stroke: StrokeState | null = null;
  private tmp: Record<'a' | 'b' | 'm' | 'f' | 's', HTMLCanvasElement | null> = { a: null, b: null, m: null, f: null, s: null };
  /** what the server has: `${id}:pixels|mask` → rev */
  private saved = new Map<string, number>();
  private everSaved = false;
  private saving: Promise<void> | null = null;
  /** what needs redrawing: everything, or the area a stroke touched since the last frame */
  private dirty: Box | 'all' | null = 'all';
  private saveAgain = false;

  constructor(
    public itemId: string,
    public width: number,
    public height: number,
  ) {
    this.scratch = newCanvas(width, height);
    this.sg = this.scratch.getContext('2d')!;
  }

  // ------------------------------------------------------------------ loading --
  static async fromItem(itemId: string, width: number, height: number): Promise<CanvasDoc> {
    const d = new CanvasDoc(itemId, width, height);
    const c = newCanvas(width, height);
    c.getContext('2d')!.drawImage(await loadImage(fileUrl(itemId)), 0, 0, width, height);
    d.layers = [d.make({ name: 'Picture', kind: 'picture', source: itemId, painted: false, canvas: c })];
    d.active = d.layers[0].id;
    return d;
  }

  static async fromJson(j: DocJson): Promise<CanvasDoc> {
    const d = new CanvasDoc(j.itemId, j.width, j.height);
    d.layers = await Promise.all(
      j.layers.map(async (m) => {
        const c = newCanvas(j.width, j.height);
        const g = c.getContext('2d')!;
        if (m.painted) g.drawImage(await loadImage(partUrl(j.itemId, 'layers', m.id, m.rev)), 0, 0);
        else if (m.source) {
          const img = await loadImage(fileUrl(m.source));
          const p = placeOnCanvas(img.naturalWidth, img.naturalHeight, j.width, j.height);
          g.drawImage(img, p.x, p.y, p.w, p.h);
        }
        let mc: HTMLCanvasElement | null = null;
        if (m.mask) {
          mc = newCanvas(j.width, j.height);
          mc.getContext('2d')!.drawImage(await loadImage(partUrl(j.itemId, 'masks', m.id, m.rev)), 0, 0);
        }
        const l: Layer = { ...m, canvas: c, maskCanvas: mc, rev: m.rev, maskRev: m.rev };
        d.counter = Math.max(d.counter, m.rev + 1);
        if (m.painted) d.saved.set(`${m.id}:pixels`, m.rev);
        if (mc) d.saved.set(`${m.id}:mask`, m.rev);
        return l;
      }),
    );
    d.active = j.active;
    d.everSaved = true;
    return d;
  }

  private make(p: Partial<Layer> & { name: string; kind: LayerKind; canvas: HTMLCanvasElement }): Layer {
    return { id: rid(), painted: true, visible: true, locked: false, alphaLock: false, opacity: 1, blend: 'normal', maskOn: true, maskCanvas: null, rev: this.counter++, maskRev: 0, ...p };
  }

  // ------------------------------------------------------------- listening --
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** pixels changed (strokes in progress): redraw, no React render */
  onPaint(fn: () => void): () => void {
    this.paintListeners.add(fn);
    return () => this.paintListeners.delete(fn);
  }
  private emit(): void {
    this.version++;
    this.dirtyJson = true;
    this.dirty = 'all';
    for (const f of this.listeners) f();
    this.repaint();
  }
  private repaint(): void {
    for (const f of this.paintListeners) f();
  }

  get activeLayer(): Layer | undefined {
    return this.layers.find((l) => l.id === this.active);
  }
  /** Worth saving: more than the untouched picture. */
  get isProject(): boolean {
    return this.everSaved || this.layers.length > 1 || this.layers.some((l) => l.painted || l.maskCanvas);
  }

  // --------------------------------------------------------------- history --
  private push(e: Omit<Entry, 'at'>): void {
    const top = this.undoStack[this.undoStack.length - 1];
    const now = Date.now();
    this.redoStack = [];
    // dragging a slider is one step
    if (e.key && top?.key === e.key && now - top.at < 1500) {
      top.redo = e.redo;
      top.at = now;
      return;
    }
    this.undoStack.push({ ...e, at: now });
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.onPush?.();
  }
  undo(): boolean {
    const e = this.undoStack.pop();
    if (!e) return false;
    e.undo();
    this.redoStack.push(e);
    this.emit();
    return true;
  }
  redo(): boolean {
    const e = this.redoStack.pop();
    if (!e) return false;
    e.redo();
    this.undoStack.push(e);
    this.emit();
    return true;
  }
  get history(): string[] {
    return this.undoStack.map((e) => e.label);
  }
  get future(): string[] {
    return this.redoStack.map((e) => e.label).reverse();
  }

  private snap(): Snap {
    return { layers: this.layers.map((l) => ({ ...l })), active: this.active };
  }
  private restore(s: Snap): void {
    this.layers = s.layers.map((l) => ({ ...l }));
    this.active = this.layers.some((l) => l.id === s.active) ? s.active : this.layers[this.layers.length - 1].id;
    if (this.target === 'mask' && !this.activeLayer?.maskCanvas) this.target = 'pixels';
  }
  /** A change to the stack (anything but painting): before/after snapshots, canvases shared, never copied. */
  private change(label: string, fn: () => void, key?: string): void {
    const before = this.snap();
    fn();
    const after = this.snap();
    this.push({ label, key, undo: () => this.restore(before), redo: () => this.restore(after) });
    this.emit();
  }

  // ------------------------------------------------------------ the stack --
  select(id: string, target: PaintTarget = 'pixels'): void {
    if (!this.layers.some((l) => l.id === id)) return;
    this.active = id;
    this.target = target === 'mask' && this.layers.find((l) => l.id === id)?.maskCanvas ? 'mask' : 'pixels';
    this.emit();
  }

  private insertAt(l: Layer, where: 'top' | 'above'): void {
    const i = where === 'top' ? this.layers.length : this.layers.findIndex((x) => x.id === this.active) + 1;
    this.layers.splice(Math.max(0, i), 0, l);
    this.active = l.id;
    this.target = 'pixels';
  }

  addPaintLayer(): Layer {
    const l = this.make({ name: nextLayerName(this.layers.map((x) => x.name)), kind: 'paint', canvas: newCanvas(this.width, this.height) });
    this.change('New layer', () => this.insertAt(l, 'above'));
    return l;
  }

  /** A picture as a layer: a Library picture (above the active layer) or an AI result (on top), fitted to the canvas. */
  addImageLayer(img: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width: number; height: number }, o: { name: string; kind: LayerKind; source?: string; mask?: HTMLCanvasElement | null; where?: 'top' | 'above' }): Layer {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const p = placeOnCanvas(w, h, this.width, this.height);
    const c = newCanvas(this.width, this.height);
    c.getContext('2d')!.drawImage(img, p.x, p.y, p.w, p.h);
    const l = this.make({ name: o.name, kind: o.kind, source: o.source, painted: !o.source || !p.exact, canvas: c, maskCanvas: o.mask ?? null, maskRev: o.mask ? this.counter++ : 0 });
    this.change(o.kind === 'result' ? 'Result as a layer' : 'Add picture', () => this.insertAt(l, o.where ?? 'above'));
    return l;
  }

  setProps(id: string, patch: Props, label: string, key?: string): void {
    if (!this.layers.some((l) => l.id === id)) return;
    this.change(label, () => (this.layers = this.layers.map((l) => (l.id === id ? { ...l, ...patch } : l))), key ? `${key}:${id}` : undefined);
  }

  duplicate(id: string): void {
    const src = this.layers.find((l) => l.id === id);
    if (!src) return;
    const c = newCanvas(this.width, this.height);
    c.getContext('2d')!.drawImage(src.canvas, 0, 0);
    let m: HTMLCanvasElement | null = null;
    if (src.maskCanvas) {
      m = newCanvas(this.width, this.height);
      m.getContext('2d')!.drawImage(src.maskCanvas, 0, 0);
    }
    const l = this.make({ ...src, id: rid(), name: `${src.name} copy`, canvas: c, maskCanvas: m, rev: this.counter++, maskRev: m ? this.counter++ : 0 });
    this.change('Duplicate layer', () => {
      this.active = id;
      this.insertAt(l, 'above');
    });
  }

  remove(id: string): void {
    if (this.layers.length < 2) return;
    this.change('Delete layer', () => {
      const i = this.layers.findIndex((l) => l.id === id);
      this.layers = this.layers.filter((l) => l.id !== id);
      if (this.active === id) this.active = this.layers[Math.max(0, i - 1)].id;
    });
  }

  /** dir +1 = up (towards the top of the stack) */
  move(id: string, dir: 1 | -1): void {
    const i = this.layers.findIndex((l) => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.layers.length) return;
    this.change(dir > 0 ? 'Move layer up' : 'Move layer down', () => (this.layers = moveLayer(this.layers, i, j)));
  }

  /** Merge into the layer below: it keeps its own settings; the upper layer's opacity, blend and mask are baked in. */
  mergeDown(id: string): void {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 1) return;
    const up = this.layers[i];
    const lo = this.layers[i - 1];
    const c = newCanvas(this.width, this.height);
    const g = c.getContext('2d')!;
    g.drawImage(this.masked(lo.canvas, lo.maskOn ? lo.maskCanvas : null, 'b'), 0, 0);
    g.globalAlpha = up.opacity;
    g.globalCompositeOperation = blendOp(up.blend);
    if (up.visible) g.drawImage(this.masked(up.canvas, up.maskOn ? up.maskCanvas : null, 'b'), 0, 0);
    const merged: Layer = { ...lo, canvas: c, maskCanvas: null, maskRev: 0, painted: true, rev: this.counter++ };
    this.change('Merge down', () => {
      this.layers = [...this.layers.slice(0, i - 1), merged, ...this.layers.slice(i + 1)];
      this.active = merged.id;
      this.target = 'pixels';
    });
  }

  /** Layer mask: all shown, or from a selection (white = shown; the alpha of `from` is used). */
  addMask(id: string, from?: HTMLCanvasElement | null, label = 'Add layer mask'): void {
    const m = newCanvas(this.width, this.height);
    const g = m.getContext('2d')!;
    if (from) g.drawImage(from, 0, 0, this.width, this.height);
    else {
      g.fillStyle = '#fff';
      g.fillRect(0, 0, this.width, this.height);
    }
    const rev = this.counter++;
    this.change(label, () => {
      this.layers = this.layers.map((l) => (l.id === id ? { ...l, maskCanvas: m, maskOn: true, maskRev: rev } : l));
      this.active = id;
      this.target = 'mask';
    });
  }

  removeMask(id: string): void {
    this.change('Delete layer mask', () => {
      this.layers = this.layers.map((l) => (l.id === id ? { ...l, maskCanvas: null, maskRev: 0 } : l));
      this.target = 'pixels';
    });
  }

  // ------------------------------------------------------------- painting --
  /** Why the active layer can't be painted now, or null when it can. */
  paintBlocker(): string | null {
    const l = this.activeLayer;
    if (!l) return 'Pick a layer first.';
    if (!l.visible) return `“${l.name}” is hidden. Show it to paint on it.`;
    if (l.locked) return `“${l.name}” is locked. Unlock it to paint on it.`;
    return null;
  }

  /**
   * Start a stroke. `erase`: on pixels it erases, on a mask it shows the layer again (the brush hides it).
   * Smudge and the filter brushes work on the layer's pixels; on a mask they paint like the brush.
   */
  beginStroke(s: BrushSettings, erase: boolean, x: number, y: number, p: number, o: Omit<StrokeOptions, 'onDab'> = {}): boolean {
    const l = this.activeLayer;
    if (!l || this.paintBlocker()) return false;
    const target: PaintTarget = this.target === 'mask' && l.maskCanvas ? 'mask' : 'pixels';
    const engine = erase || target === 'mask' ? 'paint' : s.engine;
    this.sg.clearRect(0, 0, this.width, this.height);
    const st: StrokeState = { s: null, engine, erase, opacity: s.opacity, texture: s.texture && engine === 'paint', layerId: l.id, target, src: null, backup: null };
    if (engine === 'filter') {
      // the filtered copy shows through where you paint
      st.src = newCanvas(this.width, this.height);
      const g = st.src.getContext('2d')!;
      g.filter = brushFilterCss(s.filter ?? 'blur', s.size);
      g.drawImage(l.canvas, 0, 0);
    }
    if (engine === 'smudge') {
      st.backup = newCanvas(this.width, this.height);
      st.backup.getContext('2d')!.drawImage(l.canvas, 0, 0);
      st.s = new Stroke(this.sg, s, '#ffffff', { ...o, mirrorX: undefined, mirrorY: undefined, onDab: this.smudger(l, s) });
    } else st.s = new Stroke(this.sg, s, target === 'mask' || erase || engine === 'filter' ? '#ffffff' : s.color, o);
    this.stroke = st;
    st.s.add(x, y, p);
    this.markDirty(st.s.takeDirty(this.width, this.height));
    this.repaint();
    return true;
  }

  /** Smudge: each dab lays down the paint picked up so far and picks up some of what is under it. */
  private smudger(l: Layer, s: BrushSettings): (x: number, y: number, d: number, alpha: number) => void {
    const n = Math.max(2, Math.ceil(s.size));
    const stamp = makeStamp(n, s.hardness, '#ffffff');
    const carry = newCanvas(n, n);
    const cg = carry.getContext('2d')!;
    const tip = newCanvas(n, n);
    const tg = tip.getContext('2d')!;
    const lg = l.canvas.getContext('2d')!;
    let started = false;
    return (x, y, d, alpha) => {
      const r = d / 2;
      if (started) {
        tg.globalCompositeOperation = 'copy';
        tg.drawImage(carry, 0, 0);
        tg.globalCompositeOperation = 'destination-in';
        tg.drawImage(stamp, 0, 0);
        lg.save();
        lg.globalAlpha = alpha * s.opacity;
        lg.globalCompositeOperation = l.alphaLock ? 'source-atop' : 'source-over';
        lg.drawImage(tip, x - r, y - r, d, d);
        lg.restore();
      }
      // pick up what is under the tip now: all of it at first, then a little each dab
      cg.globalAlpha = started ? 0.22 : 1;
      cg.globalCompositeOperation = started ? 'source-over' : 'copy';
      cg.drawImage(l.canvas, x - r, y - r, d, d, 0, 0, n, n);
      cg.globalAlpha = 1;
      started = true;
    };
  }

  strokeTo(x: number, y: number, p: number): void {
    if (!this.stroke?.s) return;
    this.stroke.s.add(x, y, p);
    this.markDirty(this.stroke.s.takeDirty(this.width, this.height));
    this.repaint();
  }

  private markDirty(b: Box | null): void {
    if (!b || this.dirty === 'all') return;
    if (!this.dirty) this.dirty = b;
    else {
      const x = Math.min(this.dirty.x, b.x);
      const y = Math.min(this.dirty.y, b.y);
      this.dirty = { x, y, w: Math.max(this.dirty.x + this.dirty.w, b.x + b.w) - x, h: Math.max(this.dirty.y + this.dirty.h, b.y + b.h) - y };
    }
  }

  /** Redraw what changed since the last frame into `out` (the on-screen canvas). */
  renderChanges(out: HTMLCanvasElement): void {
    const d = this.dirty;
    this.dirty = null;
    if (d === 'all') this.render(out);
    else if (d) this.render(out, undefined, d);
  }

  get stroking(): boolean {
    return !!this.stroke;
  }

  /** The op a finished paint stroke is laid down with. */
  private strokeOp(st: StrokeState, l: Layer): GlobalCompositeOperation {
    if (st.target === 'mask') return st.erase ? 'source-over' : 'destination-out';
    if (st.erase) return 'destination-out';
    if (st.engine === 'filter') return 'source-atop';
    return l.alphaLock ? 'source-atop' : 'source-over';
  }

  /** The stroke's shape within `r`: the scratch, seen through the paper grain for a textured brush. */
  private strokeShape(st: StrokeState, r: Box): HTMLCanvasElement {
    if (!st.texture) return this.scratch;
    const t = this.temp('s');
    const g = t.getContext('2d')!;
    g.clearRect(r.x, r.y, r.w, r.h);
    this.blit(g, this.scratch, r);
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = g.createPattern(paperTile(), 'repeat')!;
    g.fillRect(r.x, r.y, r.w, r.h);
    g.globalCompositeOperation = 'source-over';
    return t;
  }

  /** Lay the stroke onto `g` (a layer, its mask, or a copy of either) within `r`. */
  private layDown(g: CanvasRenderingContext2D, st: StrokeState, l: Layer, r: Box): void {
    if (st.engine === 'smudge') return; // already on the layer
    let src = this.strokeShape(st, r);
    if (st.engine === 'filter' && st.src) {
      const t = this.temp('f');
      const tg = t.getContext('2d')!;
      tg.clearRect(r.x, r.y, r.w, r.h);
      this.blit(tg, st.src, r);
      tg.globalCompositeOperation = 'destination-in';
      this.blit(tg, src, r);
      tg.globalCompositeOperation = 'source-over';
      src = t;
    }
    g.save();
    g.globalAlpha = st.opacity;
    g.globalCompositeOperation = this.strokeOp(st, l);
    this.blit(g, src, r);
    g.restore();
  }

  /** One undoable pixel change of `l` (or its mask) in `box`, from `before`. */
  private pixelStep(l: Layer, target: PaintTarget, box: Box, before: ImageData, label: string): void {
    const tc = target === 'mask' ? l.maskCanvas! : l.canvas;
    const g = tc.getContext('2d', { willReadFrequently: true })!;
    const after = g.getImageData(box.x, box.y, box.w, box.h);
    const put = (d: ImageData) => {
      g.putImageData(d, box.x, box.y);
      this.layers = this.layers.map((q) => (q.id !== l.id ? q : target === 'mask' ? { ...q, maskRev: this.counter++ } : { ...q, rev: this.counter++, painted: true }));
    };
    put(after);
    this.push({ label, undo: () => put(before), redo: () => put(after) });
    this.emit();
  }

  endStroke(x: number | null, y: number | null): void {
    const st = this.stroke;
    if (!st) return;
    const box = st.s ? st.s.end(x, y, this.width, this.height) : st.box ?? null;
    if (st.s) this.markDirty(st.s.takeDirty(this.width, this.height));
    if (st.box) this.markDirty(st.box);
    this.stroke = null;
    const l = this.layers.find((q) => q.id === st.layerId);
    const tc = l && (st.target === 'mask' ? l.maskCanvas : l.canvas);
    if (!box || !l || !tc) return this.repaint();
    const g = tc.getContext('2d', { willReadFrequently: true })!;
    const before = st.backup ? st.backup.getContext('2d', { willReadFrequently: true })!.getImageData(box.x, box.y, box.w, box.h) : g.getImageData(box.x, box.y, box.w, box.h);
    this.layDown(g, st, l, box);
    this.sg.clearRect(box.x, box.y, box.w, box.h);
    const label =
      st.target === 'mask'
        ? st.erase
          ? 'Show on mask'
          : 'Hide on mask'
        : st.erase
          ? 'Erase'
          : st.box
            ? 'Shape'
            : st.engine === 'smudge'
              ? 'Smudge'
              : st.engine === 'filter'
                ? 'Brush effect'
                : 'Paint';
    this.pixelStep(l, st.target, box, before, label);
  }

  /**
   * Shapes: draw a line, rectangle or ellipse from `a` to `b` as a live preview (call again as the pointer moves);
   * endStroke() lays it down. Shift-style constraint (square, circle, 45° lines) with `square`.
   */
  previewShape(kind: 'line' | 'rect' | 'ellipse', a: { x: number; y: number }, b: { x: number; y: number }, s: BrushSettings, fill: boolean, square: boolean): boolean {
    const l = this.activeLayer;
    if (!l || this.paintBlocker()) return false;
    let { x: bx, y: by } = b;
    if (square) {
      const dx = bx - a.x;
      const dy = by - a.y;
      if (kind === 'line') {
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        bx = a.x + Math.cos(ang) * len;
        by = a.y + Math.sin(ang) * len;
      } else {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        bx = a.x + Math.sign(dx || 1) * m;
        by = a.y + Math.sign(dy || 1) * m;
      }
    }
    const target: PaintTarget = this.target === 'mask' && l.maskCanvas ? 'mask' : 'pixels';
    if (this.stroke?.box) {
      this.sg.clearRect(this.stroke.box.x, this.stroke.box.y, this.stroke.box.w, this.stroke.box.h);
      this.markDirty(this.stroke.box);
    }
    const g = this.sg;
    const w = Math.max(1, s.size);
    g.save();
    g.strokeStyle = g.fillStyle = target === 'mask' ? '#ffffff' : s.color;
    g.lineWidth = w;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    if (kind === 'line') {
      g.moveTo(a.x, a.y);
      g.lineTo(bx, by);
    } else if (kind === 'rect') g.rect(Math.min(a.x, bx), Math.min(a.y, by), Math.abs(bx - a.x), Math.abs(by - a.y));
    else g.ellipse((a.x + bx) / 2, (a.y + by) / 2, Math.abs(bx - a.x) / 2, Math.abs(by - a.y) / 2, 0, 0, Math.PI * 2);
    if (fill && kind !== 'line') g.fill();
    else g.stroke();
    g.restore();
    const pad = w / 2 + 2;
    const box = clampBox(Math.min(a.x, bx) - pad, Math.min(a.y, by) - pad, Math.max(a.x, bx) + pad, Math.max(a.y, by) + pad, this.width, this.height);
    this.stroke = { s: null, engine: 'paint', erase: false, opacity: s.opacity, texture: false, layerId: l.id, target, src: null, backup: null, box: box ?? undefined };
    if (box) this.markDirty(box);
    this.repaint();
    return true;
  }

  /** Fill bucket on the active layer: the area around (x, y) of similar colour, in the active layer or the merged picture. */
  fill(x: number, y: number, colour: string, o: { tolerance: number; contiguous: boolean; merged: boolean; opacity: number }): string | null {
    const l = this.activeLayer;
    const why = this.paintBlocker();
    if (why || !l) return why ?? 'Pick a layer first.';
    const target: PaintTarget = this.target === 'mask' && l.maskCanvas ? 'mask' : 'pixels';
    const src = o.merged && target === 'pixels' ? this.flatten() : target === 'mask' ? l.maskCanvas! : l.canvas;
    const data = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, this.width, this.height).data;
    const res = floodMask(data, this.width, this.height, x, y, o.tolerance, o.contiguous);
    if (!res) return 'Click on the picture to fill.';
    // one pixel more, so the fill tucks under an anti-aliased outline
    const bx = clampBox(res.box.x - 1, res.box.y - 1, res.box.x + res.box.w + 1, res.box.y + res.box.h + 1, this.width, this.height)!;
    const full = growMask(res.mask, this.width, this.height, 1);
    const rgb = target === 'mask' ? [255, 255, 255] : (hexToRgb(colour) ?? [0, 0, 0]);
    const patch = new ImageData(bx.w, bx.h);
    for (let yy = 0; yy < bx.h; yy++)
      for (let xx = 0; xx < bx.w; xx++) {
        if (!full[(bx.y + yy) * this.width + bx.x + xx]) continue;
        const i = (yy * bx.w + xx) * 4;
        patch.data[i] = rgb[0];
        patch.data[i + 1] = rgb[1];
        patch.data[i + 2] = rgb[2];
        patch.data[i + 3] = 255;
      }
    const pc = newCanvas(bx.w, bx.h);
    pc.getContext('2d')!.putImageData(patch, 0, 0);
    const tc = target === 'mask' ? l.maskCanvas! : l.canvas;
    const g = tc.getContext('2d', { willReadFrequently: true })!;
    const before = g.getImageData(bx.x, bx.y, bx.w, bx.h);
    g.save();
    g.globalAlpha = o.opacity;
    g.globalCompositeOperation = target === 'pixels' && l.alphaLock ? 'source-atop' : 'source-over';
    g.drawImage(pc, bx.x, bx.y);
    g.restore();
    this.pixelStep(l, target, bx, before, 'Fill');
    return null;
  }

  /** The top visible layer with paint at (x, y) — Ctrl-click picks it. */
  layerAt(x: number, y: number): string | null {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return null;
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i];
      if (!l.visible || l.opacity < 0.05) continue;
      const a = l.canvas.getContext('2d', { willReadFrequently: true })!.getImageData(px, py, 1, 1).data[3];
      const m = l.maskCanvas && l.maskOn ? l.maskCanvas.getContext('2d', { willReadFrequently: true })!.getImageData(px, py, 1, 1).data[3] : 255;
      if (a > 24 && m > 24) return l.id;
    }
    return null;
  }

  // ------------------------------------------------------------ rendering --
  private temp(k: 'a' | 'b' | 'm' | 'f' | 's'): HTMLCanvasElement {
    if (!this.tmp[k]) this.tmp[k] = newCanvas(this.width, this.height);
    return this.tmp[k]!;
  }

  /** draw `src` onto `g` within `r` (the same place on both) */
  private blit(g: CanvasRenderingContext2D, src: HTMLCanvasElement, r: Box): void {
    g.drawImage(src, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  }

  /** `src` through `mask` (into temp `k`), or `src` itself without a mask. */
  private masked(src: HTMLCanvasElement, mask: HTMLCanvasElement | null, k: 'a' | 'b', r: Box = this.full()): HTMLCanvasElement {
    if (!mask) return src;
    const t = this.temp(k);
    const g = t.getContext('2d')!;
    g.clearRect(r.x, r.y, r.w, r.h);
    this.blit(g, src, r);
    g.globalCompositeOperation = 'destination-in';
    this.blit(g, mask, r);
    g.globalCompositeOperation = 'source-over';
    return t;
  }

  /** `base` with the stroke in progress laid on it, in temp `k`. */
  private withStroke(base: HTMLCanvasElement, l: Layer, k: 'a' | 'm', r: Box): HTMLCanvasElement {
    const st = this.stroke!;
    if (st.engine === 'smudge') return base;
    const t = this.temp(k);
    const g = t.getContext('2d')!;
    g.clearRect(r.x, r.y, r.w, r.h);
    this.blit(g, base, r);
    this.layDown(g, st, l, r);
    return t;
  }

  private full(): Box {
    return { x: 0, y: 0, w: this.width, h: this.height };
  }

  /** Draw the stack (with any stroke in progress) into `out` (width x height): all of it, or only `r`. */
  render(out: HTMLCanvasElement, only?: string, r: Box = this.full()): void {
    const g = out.getContext('2d')!;
    g.clearRect(r.x, r.y, r.w, r.h);
    for (const l of this.layers) {
      if (!l.visible || (only && l.id !== only)) continue;
      const live = this.stroke?.layerId === l.id ? this.stroke : null;
      const px = live && live.target === 'pixels' ? this.withStroke(l.canvas, l, 'a', r) : l.canvas;
      let mask = l.maskOn ? l.maskCanvas : null;
      if (live && live.target === 'mask' && l.maskCanvas) mask = this.withStroke(l.maskCanvas, l, 'm', r);
      g.globalAlpha = l.opacity;
      g.globalCompositeOperation = blendOp(l.blend);
      this.blit(g, this.masked(px, mask, 'b', r), r);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  /** The merged picture (what Flatten saves and what the AI sees). */
  flatten(): HTMLCanvasElement {
    const c = newCanvas(this.width, this.height);
    this.render(c);
    return c;
  }

  flattenBlob(): Promise<Blob> {
    const c = this.flatten();
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not merge the layers'))), 'image/png'));
  }

  // ---------------------------------------------------------------- saving --
  toJson(): DocJson {
    return {
      v: 1,
      itemId: this.itemId,
      width: this.width,
      height: this.height,
      active: this.active,
      updatedAt: Date.now(),
      layers: this.layers.map((l) => ({
        id: l.id,
        name: l.name,
        kind: l.kind,
        ...(l.source ? { source: l.source } : {}),
        painted: l.painted,
        visible: l.visible,
        locked: l.locked,
        alphaLock: l.alphaLock,
        opacity: l.opacity,
        blend: l.blend,
        mask: !!l.maskCanvas,
        maskOn: l.maskOn,
        // one number busts the cache of both PNGs
        rev: Math.max(l.rev, l.maskRev),
      })),
    };
  }

  get unsaved(): boolean {
    return this.isProject && (this.saving !== null || this.pending().length > 0 || this.dirtyJson);
  }
  private dirtyJson = true;
  private lastJson = '';

  private pending(): { l: Layer; part: 'layers' | 'masks'; rev: number }[] {
    const out: { l: Layer; part: 'layers' | 'masks'; rev: number }[] = [];
    for (const l of this.layers) {
      if (l.painted && this.saved.get(`${l.id}:pixels`) !== l.rev) out.push({ l, part: 'layers', rev: l.rev });
      if (l.maskCanvas && this.saved.get(`${l.id}:mask`) !== l.maskRev) out.push({ l, part: 'masks', rev: l.maskRev });
    }
    return out;
  }

  /** Upload changed layer PNGs, then the document. One save at a time; a change during a save saves again after. */
  save(): Promise<void> {
    if (!this.isProject) return Promise.resolve();
    if (this.saving) {
      this.saveAgain = true;
      return this.saving;
    }
    this.saving = (async () => {
      try {
        for (const p of this.pending()) {
          const c = p.part === 'masks' ? p.l.maskCanvas! : p.l.canvas;
          const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not save a layer'))), 'image/png'));
          const r = await fetch(`/api/items/${this.itemId}/project/${p.part}/${p.l.id}`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: blob });
          if (!r.ok) throw new Error('Could not save a layer');
          this.saved.set(`${p.l.id}:${p.part === 'masks' ? 'mask' : 'pixels'}`, p.rev);
        }
        const j = this.toJson();
        const text = JSON.stringify({ ...j, updatedAt: 0 });
        if (text !== this.lastJson) {
          const r = await fetch(`/api/items/${this.itemId}/project`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(j) });
          if (!r.ok) throw new Error('Could not save the layers');
          this.lastJson = text;
        }
        this.everSaved = true;
        this.dirtyJson = false;
      } finally {
        this.saving = null;
      }
      if (this.saveAgain) {
        this.saveAgain = false;
        await this.save();
      }
    })();
    return this.saving;
  }
}
