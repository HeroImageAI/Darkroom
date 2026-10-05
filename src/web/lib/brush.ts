/**
 * Paint brush for the Edit canvas (DECISIONS 122): round dabs along the pointer path with pen pressure (size and
 * opacity), hardness, and a stabiliser for clean lines. A stroke paints at full strength into a scratch canvas; the
 * layer document shows it at the brush opacity and commits it when the pen lifts, so overlapping dabs never build up
 * past the opacity you set.
 */
import { dabsAlong, pressureCurve } from '../../shared/doc';

export interface BrushSettings {
  size: number;
  /** 0 = soft airbrush, 1 = hard edge */
  hardness: number;
  /** stroke opacity 0..1 (applied when the stroke is shown and committed) */
  opacity: number;
  color: string;
  pressureSize: boolean;
  pressureOpacity: boolean;
  /** stabiliser 0..0.95 — how far the line lags behind the pen to smooth it */
  smoothing: number;
}

export const DEFAULT_BRUSH: BrushSettings = { size: 24, hardness: 0.85, opacity: 1, color: '#1a1917', pressureSize: true, pressureOpacity: false, smoothing: 0.35 };

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A soft or hard round stamp of `d` px in `color` (radial falloff from the hardness radius to the edge). */
function makeStamp(d: number, hardness: number, color: string): HTMLCanvasElement {
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
  /** per-dab alpha so ~10 overlapping dabs reach the pressure's opacity */
  private dabAlpha = (p: number) => (this.s.pressureOpacity ? 1 - Math.pow(1 - pressureCurve(p, 0.05), 1 / 8) : 1);

  constructor(
    private g: CanvasRenderingContext2D,
    private s: BrushSettings,
    color: string,
  ) {
    this.stamp = makeStamp(s.size, s.hardness, color);
  }

  private spacing(): number {
    return Math.max(0.5, this.s.size * 0.08);
  }

  private dab(x: number, y: number, p: number): void {
    const d = this.s.pressureSize ? this.s.size * pressureCurve(p) : this.s.size;
    if (d < 0.6) return;
    const r = d / 2;
    this.g.globalAlpha = this.dabAlpha(p);
    this.g.drawImage(this.stamp, x - r, y - r, d, d);
    this.x0 = Math.min(this.x0, x - r);
    this.y0 = Math.min(this.y0, y - r);
    this.x1 = Math.max(this.x1, x + r);
    this.y1 = Math.max(this.y1, y + r);
    this.d = this.d ? { x0: Math.min(this.d.x0, x - r), y0: Math.min(this.d.y0, y - r), x1: Math.max(this.d.x1, x + r), y1: Math.max(this.d.y1, y + r) } : { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
  }

  /** The area painted since the last call (clamped to W x H), or null. */
  takeDirty(W: number, H: number): Box | null {
    const d = this.d;
    this.d = null;
    if (!d) return null;
    const x = Math.max(0, Math.floor(d.x0) - 2);
    const y = Math.max(0, Math.floor(d.y0) - 2);
    const ex = Math.min(W, Math.ceil(d.x1) + 2);
    const ey = Math.min(H, Math.ceil(d.y1) + 2);
    return ex > x && ey > y ? { x, y, w: ex - x, h: ey - y } : null;
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
    const bx = Math.max(0, Math.floor(this.x0) - 1);
    const by = Math.max(0, Math.floor(this.y0) - 1);
    const ex = Math.min(W, Math.ceil(this.x1) + 1);
    const ey = Math.min(H, Math.ceil(this.y1) + 1);
    return ex > bx && ey > by ? { x: bx, y: by, w: ex - bx, h: ey - by } : null;
  }
}
