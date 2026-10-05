/**
 * Paint brush for the Edit canvas (DECISIONS 122, 123): round dabs along the pointer path with pen pressure (size and
 * opacity, through your pen feel), hardness, spacing, paper grain, symmetry and a stabiliser for clean lines.
 * A paint stroke goes at full strength into a scratch canvas; the layer document shows it at the brush opacity and
 * lays it down when the pen lifts, so overlapping dabs never build up past the opacity you set. Smudge and the filter
 * brushes (blur, dodge, burn, sponge…) use the same dabs: smudge moves the layer's own pixels, a filter brush uses the
 * scratch as the shape through which a filtered copy of the layer shows.
 */
import { dabsAlong, pressureCurve } from '../../shared/doc';
import { brushById, type BrushEngine, type BrushFilter, type BrushPreset } from '../../shared/brushes';

export interface BrushSettings {
  size: number;
  /** 0 = soft airbrush, 1 = hard edge */
  hardness: number;
  /** stroke opacity 0..1 (applied when the stroke is shown and laid down) */
  opacity: number;
  color: string;
  pressureSize: boolean;
  pressureOpacity: boolean;
  /** stabiliser 0..0.95 — how far the line lags behind the pen to smooth it */
  smoothing: number;
  /** dab spacing as a share of the diameter */
  spacing: number;
  texture: boolean;
  engine: BrushEngine;
  filter?: BrushFilter;
}

export function settingsOf(p: BrushPreset): Omit<BrushSettings, 'color'> {
  return { size: p.size, hardness: p.hardness, opacity: p.opacity, pressureSize: p.pressureSize, pressureOpacity: p.pressureOpacity, smoothing: p.smoothing, spacing: p.spacing, texture: !!p.texture, engine: p.engine, filter: p.filter };
}

export const DEFAULT_BRUSH: BrushSettings = { ...settingsOf(brushById('round')), color: '#1a1917' };

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StrokeOptions {
  /** mirror across x = mirrorX and/or y = mirrorY (symmetry painting) */
  mirrorX?: number;
  mirrorY?: number;
  /** pen feel: the pressure curve's gamma (1 = linear, <1 soft, >1 firm) */
  gamma?: number;
  /** draw a dab yourself (smudge) instead of stamping into the scratch canvas */
  onDab?: (x: number, y: number, d: number, alpha: number) => void;
}

/** A soft or hard round stamp of `d` px in `color` (radial falloff from the hardness radius to the edge). */
export function makeStamp(d: number, hardness: number, color: string): HTMLCanvasElement {
  const n = Math.max(2, Math.ceil(d));
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  const r = n / 2;
  const grad = g.createRadialGradient(r, r, Math.max(0, r * Math.min(0.98, hardness)), r, r, r);
  grad.addColorStop(0, color);
  grad.addColorStop(1, hexAlpha(color, 0));
  g.fillStyle = grad;
  g.beginPath();
  g.arc(r, r, r, 0, Math.PI * 2);
  g.fill();
  return c;
}

function hexAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(0,0,0,${a})`;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

let paper: HTMLCanvasElement | null = null;
/** Paper grain: a tile of soft noise (alpha 0.25–1) a textured stroke is seen through. Fixed to the canvas, like paper. */
export function paperTile(): HTMLCanvasElement {
  if (paper) return paper;
  const n = 192;
  const raw = document.createElement('canvas');
  raw.width = raw.height = n;
  const g = raw.getContext('2d')!;
  const d = g.createImageData(n, n);
  let s = 1234567;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < n * n; i++) {
    d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = 255;
    d.data[i * 4 + 3] = 64 + Math.round(rnd() * 191);
  }
  g.putImageData(d, 0, 0);
  // a touch of blur so the grain reads as tooth, not pixel noise; drawn 3×3 so the edges wrap seamlessly
  paper = document.createElement('canvas');
  paper.width = paper.height = n;
  const p = paper.getContext('2d')!;
  p.filter = 'blur(0.7px)';
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) p.drawImage(raw, x * n, y * n);
  return paper;
}

export class Stroke {
  private stamp: HTMLCanvasElement;
  private last: { x: number; y: number; p: number } | null = null;
  private smooth: { x: number; y: number; p: number } | null = null;
  private carry = 0;
  private x0 = Infinity;
  private y0 = Infinity;
  private x1 = -Infinity;
  private y1 = -Infinity;
  /** touched since the last takeDirty(): only that area is redrawn while painting */
  private d: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private gamma: number;

  constructor(
    private g: CanvasRenderingContext2D,
    private s: BrushSettings,
    color: string,
    private o: StrokeOptions = {},
  ) {
    this.stamp = makeStamp(s.size, s.hardness, color);
    this.gamma = o.gamma ?? 1;
  }

  get stampCanvas(): HTMLCanvasElement {
    return this.stamp;
  }

  /** per-dab alpha so ~8 overlapping dabs reach the pressure's opacity */
  private dabAlpha(p: number): number {
    return this.s.pressureOpacity ? 1 - Math.pow(1 - pressureCurve(p, 0.05, this.gamma), 1 / 8) : 1;
  }

  private spacing(): number {
    return Math.max(0.5, this.s.size * Math.max(0.02, this.s.spacing || 0.08));
  }

  private touch(x: number, y: number, r: number): void {
    this.x0 = Math.min(this.x0, x - r);
    this.y0 = Math.min(this.y0, y - r);
    this.x1 = Math.max(this.x1, x + r);
    this.y1 = Math.max(this.y1, y + r);
    this.d = this.d ? { x0: Math.min(this.d.x0, x - r), y0: Math.min(this.d.y0, y - r), x1: Math.max(this.d.x1, x + r), y1: Math.max(this.d.y1, y + r) } : { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
  }

  private dab(x: number, y: number, p: number): void {
    const d = this.s.pressureSize ? this.s.size * pressureCurve(p, 0.08, this.gamma) : this.s.size;
    if (d < 0.6) return;
    const r = d / 2;
    const a = this.dabAlpha(p);
    const at: [number, number][] = [[x, y]];
    if (this.o.mirrorX != null) at.push([2 * this.o.mirrorX - x, y]);
    if (this.o.mirrorY != null) at.push([x, 2 * this.o.mirrorY - y]);
    if (this.o.mirrorX != null && this.o.mirrorY != null) at.push([2 * this.o.mirrorX - x, 2 * this.o.mirrorY - y]);
    for (const [px, py] of at) {
      if (this.o.onDab) this.o.onDab(px, py, d, a);
      else {
        this.g.globalAlpha = a;
        this.g.drawImage(this.stamp, px - r, py - r, d, d);
      }
      this.touch(px, py, r);
    }
  }

  /** The area painted since the last call (clamped to W x H), or null. */
  takeDirty(W: number, H: number): Box | null {
    const d = this.d;
    this.d = null;
    if (!d) return null;
    return clampBox(d.x0 - 2, d.y0 - 2, d.x1 + 2, d.y1 + 2, W, H);
  }

  /** Feed a pointer sample (image pixels, pressure 0..1). */
  add(x: number, y: number, p: number): void {
    const k = 1 - Math.min(0.95, Math.max(0, this.s.smoothing));
    this.smooth = this.smooth ? { x: this.smooth.x + (x - this.smooth.x) * k, y: this.smooth.y + (y - this.smooth.y) * k, p: this.smooth.p + (p - this.smooth.p) * k } : { x, y, p };
    this.lineTo(this.smooth);
  }

  private lineTo(pt: { x: number; y: number; p: number }): void {
    if (!this.last) {
      this.last = pt;
      this.dab(pt.x, pt.y, pt.p);
      return;
    }
    const { pts, carry } = dabsAlong(this.last, pt, this.spacing(), this.carry);
    for (const q of pts) this.dab(q.x, q.y, this.last.p + (pt.p - this.last.p) * q.t);
    this.carry = carry;
    this.last = pt;
  }

  /** Pen up: catch the stabilised line up with the last real sample. Returns the touched box (clamped), or null. */
  end(x: number | null, y: number | null, W: number, H: number): Box | null {
    if (x != null && y != null && this.last && this.s.smoothing > 0) this.lineTo({ x, y, p: this.last.p });
    this.g.globalAlpha = 1;
    if (!Number.isFinite(this.x0)) return null;
    return clampBox(this.x0 - 1, this.y0 - 1, this.x1 + 1, this.y1 + 1, W, H);
  }
}

export function clampBox(x0: number, y0: number, x1: number, y1: number, W: number, H: number): Box | null {
  const x = Math.max(0, Math.floor(x0));
  const y = Math.max(0, Math.floor(y0));
  const ex = Math.min(W, Math.ceil(x1));
  const ey = Math.min(H, Math.ceil(y1));
  return ex > x && ey > y ? { x, y, w: ex - x, h: ey - y } : null;
}
