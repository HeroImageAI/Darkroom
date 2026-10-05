/**
 * Edit canvas layer document (DECISIONS 122, Edit suite v3.25). The picture becomes a stack of layers held as canvases
 * at the picture's own size: the picture itself, paint layers, AI results applied as layers, and Library pictures.
 * Each layer has visibility, lock, alpha lock, opacity, one of 16 blend modes and an optional layer mask (white =
 * shown). Every change is one undo step; strokes keep only the pixels they touched. Saved to the server per item.
 */
import { blendOp, moveLayer, nextLayerName, placeOnCanvas, type Blend, type DocJson, type LayerKind } from '../../shared/doc';
import { fileUrl } from '../api';
import { Stroke, type Box, type BrushSettings } from './brush';

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
  private stroke: { s: Stroke; erase: boolean; opacity: number; layerId: string; target: PaintTarget } | null = null;
  private tmp: Record<'a' | 'b' | 'm', HTMLCanvasElement | null> = { a: null, b: null, m: null };
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

  /** `erase`: on pixels it erases, on a mask it shows the layer again (the brush hides it). */
  beginStroke(s: BrushSettings, erase: boolean, x: number, y: number, p: number): boolean {
    const l = this.activeLayer;
    if (!l || this.paintBlocker()) return false;
    const target: PaintTarget = this.target === 'mask' && l.maskCanvas ? 'mask' : 'pixels';
    this.sg.clearRect(0, 0, this.width, this.height);
    const colour = target === 'mask' || erase ? '#ffffff' : s.color;
    this.stroke = { s: new Stroke(this.sg, s, colour), erase, opacity: s.opacity, layerId: l.id, target };
    this.stroke.s.add(x, y, p);
    this.markDirty(this.stroke.s.takeDirty(this.width, this.height));
    this.repaint();
    return true;
  }

  strokeTo(x: number, y: number, p: number): void {
    if (!this.stroke) return;
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

  /** The op a finished stroke is laid down with. */
  private strokeOp(st: NonNullable<CanvasDoc['stroke']>, l: Layer): GlobalCompositeOperation {
    if (st.target === 'mask') return st.erase ? 'source-over' : 'destination-out';
    if (st.erase) return 'destination-out';
    return l.alphaLock ? 'source-atop' : 'source-over';
  }

  endStroke(x: number | null, y: number | null): void {
    const st = this.stroke;
    if (!st) return;
    const box = st.s.end(x, y, this.width, this.height);
    this.markDirty(st.s.takeDirty(this.width, this.height));
    this.stroke = null;
    const l = this.layers.find((q) => q.id === st.layerId);
    const tc = l && (st.target === 'mask' ? l.maskCanvas : l.canvas);
    if (!box || !l || !tc) return this.repaint();
    const g = tc.getContext('2d', { willReadFrequently: true })!;
    const before = g.getImageData(box.x, box.y, box.w, box.h);
    g.save();
    g.globalAlpha = st.opacity;
    g.globalCompositeOperation = this.strokeOp(st, l);
    g.drawImage(this.scratch, box.x, box.y, box.w, box.h, box.x, box.y, box.w, box.h);
    g.restore();
    const after = g.getImageData(box.x, box.y, box.w, box.h);
    this.sg.clearRect(box.x, box.y, box.w, box.h);
    const put = (d: ImageData, b: Box) => {
      g.putImageData(d, b.x, b.y);
      this.layers = this.layers.map((q) => (q.id !== l.id ? q : st.target === 'mask' ? { ...q, maskRev: this.counter++ } : { ...q, rev: this.counter++, painted: true }));
    };
    put(after, box);
    const label = st.target === 'mask' ? (st.erase ? 'Show on mask' : 'Hide on mask') : st.erase ? 'Erase' : 'Paint';
    this.push({ label, undo: () => put(before, box), redo: () => put(after, box) });
    this.emit();
  }

  // ------------------------------------------------------------ rendering --
  private temp(k: 'a' | 'b' | 'm'): HTMLCanvasElement {
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
    const t = this.temp(k);
    const g = t.getContext('2d')!;
    g.clearRect(r.x, r.y, r.w, r.h);
    this.blit(g, base, r);
    g.globalAlpha = st.opacity;
    g.globalCompositeOperation = this.strokeOp(st, l);
    this.blit(g, this.scratch, r);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
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
