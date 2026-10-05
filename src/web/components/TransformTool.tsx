import { useEffect, useRef } from 'react';
import { Check, FlipHorizontal, FlipVertical, RotateCcw, X } from 'lucide-react';
import { affineMesh, corners, drawMeshBest, gridMesh, perspectiveMesh, refine, type Mesh } from '../lib/mesh';
import { convexQuad, type Pt } from '../../shared/warp';

/**
 * Transform (Edit suite v3.27, DECISIONS 124): the lifted pixels of a layer, placed with handles drawn over the
 * picture. Free: drag inside to move, a corner or side to scale (Shift keeps the shape), the round handle to turn
 * (Shift snaps to 15°). Perspective: drag each corner. Warp: drag any point of the 4 × 4 grid.
 */
export type TransformMode = 'free' | 'perspective' | 'warp';
export interface Free {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  rot: number;
}
export interface TransformState {
  mode: TransformMode;
  src: HTMLCanvasElement;
  box: { x: number; y: number; w: number; h: number };
  free: Free;
  /** perspective corners (TL, TR, BR, BL) */
  quad: Pt[];
  /** warp control points, 4 × 4 */
  warp: Pt[];
}

export const NO_FREE: Free = { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 };

export function startTransform(src: HTMLCanvasElement, box: TransformState['box']): TransformState {
  return { mode: 'free', src, box, free: NO_FREE, quad: corners(gridMesh(box, 2)), warp: gridMesh(box, 4).pts };
}

/** Where the pixels are now, as a 4 × 4 grid (to switch between modes without a jump). */
function currentGrid(s: TransformState): Mesh {
  const base = gridMesh(s.box, 4);
  if (s.mode === 'free') return affineMesh(base, s.free);
  if (s.mode === 'perspective') return perspectiveMesh(base, s.quad) ?? base;
  return { n: 4, pts: s.warp };
}

/** Nothing moved: applying would only mark the layer as changed (and turn a plain picture into a project). */
export function untouched(s: TransformState): boolean {
  const a = currentGrid(s).pts;
  const b = gridMesh(s.box, 4).pts;
  return a.every((p, i) => Math.abs(p.x - b[i].x) < 0.01 && Math.abs(p.y - b[i].y) < 0.01);
}

export function switchMode(s: TransformState, mode: TransformMode): TransformState {
  if (mode === s.mode) return s;
  const g = currentGrid(s);
  if (mode === 'perspective') return { ...s, mode, quad: corners(g) };
  if (mode === 'warp') return { ...s, mode, warp: g.pts };
  // back to free: only a plain move/scale/turn survives the switch
  return { ...s, mode, free: s.mode === 'free' ? s.free : NO_FREE };
}

/** Draw the lifted pixels where the handles say. */
export function drawTransform(g: CanvasRenderingContext2D, s: TransformState): void {
  const { box, free } = s;
  if (s.mode === 'free') {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const a = (free.rot * Math.PI) / 180;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.translate(cx + free.dx, cy + free.dy);
    g.rotate(a);
    g.scale(free.sx, free.sy);
    g.drawImage(s.src, box.x, box.y, box.w, box.h, -box.w / 2, -box.h / 2, box.w, box.h);
    g.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }
  const from = gridMesh(box, 24);
  const to = s.mode === 'perspective' ? perspectiveMesh(from, s.quad) : refine({ n: 4, pts: s.warp }, 24);
  if (to) drawMeshBest(g, s.src, from, to, g.canvas.width, g.canvas.height);
}

/** The free transform's corners and side midpoints in picture pixels. */
function freePoints(s: TransformState) {
  const { box, free } = s;
  const cx = box.x + box.w / 2 + free.dx;
  const cy = box.y + box.h / 2 + free.dy;
  const a = (free.rot * Math.PI) / 180;
  const at = (lx: number, ly: number): Pt => {
    const x = lx * free.sx;
    const y = ly * free.sy;
    return { x: cx + x * Math.cos(a) - y * Math.sin(a), y: cy + x * Math.sin(a) + y * Math.cos(a) };
  };
  const hw = box.w / 2;
  const hh = box.h / 2;
  return { cx, cy, at, hw, hh };
}

type Grab = { kind: 'body' | 'rotate' | 'scale' | 'corner' | 'warp'; i?: number; sx?: number; sy?: number; start: Pt; s0: TransformState };

export function TransformOverlay({ s, set, W, H, scale, toImage }: { s: TransformState; set: (s: TransformState) => void; W: number; H: number; scale: number; toImage: (e: { clientX: number; clientY: number }) => Pt }) {
  const grab = useRef<Grab | null>(null);
  const hs = 7 / scale; // handle radius in picture pixels
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const g = grab.current;
      if (!g) return;
      const p = toImage(e);
      const s0 = g.s0;
      if (g.kind === 'body') {
        if (s0.mode === 'free') set({ ...s0, free: { ...s0.free, dx: s0.free.dx + p.x - g.start.x, dy: s0.free.dy + p.y - g.start.y } });
        else if (s0.mode === 'perspective') set({ ...s0, quad: s0.quad.map((q) => ({ x: q.x + p.x - g.start.x, y: q.y + p.y - g.start.y })) });
        else set({ ...s0, warp: s0.warp.map((q) => ({ x: q.x + p.x - g.start.x, y: q.y + p.y - g.start.y })) });
      } else if (g.kind === 'rotate') {
        const { cx, cy } = freePoints(s0);
        let rot = s0.free.rot + ((Math.atan2(p.y - cy, p.x - cx) - Math.atan2(g.start.y - cy, g.start.x - cx)) * 180) / Math.PI;
        if (e.shiftKey) rot = Math.round(rot / 15) * 15;
        set({ ...s0, free: { ...s0.free, rot } });
      } else if (g.kind === 'scale') {
        // the opposite corner (or side) stays where it is
        const { at, hw, hh } = freePoints(s0);
        const sxs = g.sx ?? 0;
        const sys = g.sy ?? 0;
        const anchor = at(-sxs * hw, -sys * hh);
        const a = (s0.free.rot * Math.PI) / 180;
        const vx = p.x - anchor.x;
        const vy = p.y - anchor.y;
        const qx = vx * Math.cos(-a) - vy * Math.sin(-a);
        const qy = vx * Math.sin(-a) + vy * Math.cos(-a);
        let sx = sxs ? qx / (sxs * 2 * hw) : s0.free.sx;
        let sy = sys ? qy / (sys * 2 * hh) : s0.free.sy;
        if (Math.abs(sx) < 0.02) sx = 0.02 * Math.sign(sx || 1);
        if (Math.abs(sy) < 0.02) sy = 0.02 * Math.sign(sy || 1);
        if (e.shiftKey && sxs && sys) {
          const k = Math.max(Math.abs(sx / s0.free.sx), Math.abs(sy / s0.free.sy));
          sx = s0.free.sx * k * Math.sign(sx / s0.free.sx);
          sy = s0.free.sy * k * Math.sign(sy / s0.free.sy);
        }
        // the centre moves so that the anchor stays put
        const lx = sxs * hw * sx;
        const ly = sys * hh * sy;
        const ncx = anchor.x + lx * Math.cos(a) - ly * Math.sin(a);
        const ncy = anchor.y + lx * Math.sin(a) + ly * Math.cos(a);
        set({ ...s0, free: { ...s0.free, sx, sy, dx: ncx - (s0.box.x + s0.box.w / 2), dy: ncy - (s0.box.y + s0.box.h / 2) } });
      } else if (g.kind === 'corner' && g.i != null) {
        const quad = s0.quad.slice();
        quad[g.i] = p;
        if (convexQuad(quad)) set({ ...s0, quad });
      } else if (g.kind === 'warp' && g.i != null) {
        const warp = s0.warp.slice();
        warp[g.i] = p;
        set({ ...s0, warp });
      }
    };
    const up = () => (grab.current = null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [set, toImage]);
  const start = (e: React.PointerEvent, g: Omit<Grab, 'start' | 's0'>) => {
    e.stopPropagation();
    e.preventDefault();
    grab.current = { ...g, start: toImage(e), s0: s };
  };
  const handle = (p: Pt, key: string, g: Omit<Grab, 'start' | 's0'>, label: string, round = false) => (
    <rect
      key={key}
      x={p.x - hs}
      y={p.y - hs}
      width={hs * 2}
      height={hs * 2}
      rx={round ? hs : hs * 0.3}
      className="tf-handle"
      aria-label={label}
      onPointerDown={(e) => start(e, g)}
    />
  );
  let outline: Pt[];
  const handles: React.ReactNode[] = [];
  if (s.mode === 'free') {
    const { at, hw, hh } = freePoints(s);
    outline = [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)];
    for (const [sx, sy, name] of [
      [-1, -1, 'top left'],
      [1, -1, 'top right'],
      [1, 1, 'bottom right'],
      [-1, 1, 'bottom left'],
      [0, -1, 'top'],
      [1, 0, 'right'],
      [0, 1, 'bottom'],
      [-1, 0, 'left'],
    ] as const)
      handles.push(handle(at(sx * hw, sy * hh), `s${sx}${sy}`, { kind: 'scale', sx, sy }, `Scale from the ${name}`));
    const top = at(0, -hh);
    const knob = at(0, -hh - 28 / scale / Math.max(0.05, Math.abs(s.free.sy)));
    handles.push(<line key="rl" x1={top.x} y1={top.y} x2={knob.x} y2={knob.y} className="tf-line" />);
    handles.push(handle(knob, 'rot', { kind: 'rotate' }, 'Turn', true));
  } else if (s.mode === 'perspective') {
    outline = s.quad;
    s.quad.forEach((p, i) => handles.push(handle(p, `c${i}`, { kind: 'corner', i }, `Corner ${i + 1}`)));
  } else {
    outline = [s.warp[0], s.warp[3], s.warp[15], s.warp[12]];
    for (let j = 0; j < 4; j++) {
      handles.push(<polyline key={`h${j}`} points={[0, 1, 2, 3].map((i) => `${s.warp[j * 4 + i].x},${s.warp[j * 4 + i].y}`).join(' ')} className="tf-line" />);
      handles.push(<polyline key={`v${j}`} points={[0, 1, 2, 3].map((i) => `${s.warp[i * 4 + j].x},${s.warp[i * 4 + j].y}`).join(' ')} className="tf-line" />);
    }
    s.warp.forEach((p, i) => handles.push(handle(p, `w${i}`, { kind: 'warp', i }, `Warp point ${i + 1}`, true)));
  }
  return (
    <svg className="tf-overlay" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Transform handles">
      <polygon points={outline.map((p) => `${p.x},${p.y}`).join(' ')} className="tf-body" onPointerDown={(e) => start(e, { kind: 'body' })} aria-label="Move" />
      {handles}
    </svg>
  );
}

export function TransformBar({ s, set, onApply, onCancel }: { s: TransformState; set: (s: TransformState) => void; onApply: () => void; onCancel: () => void }) {
  return (
    <div className="paint-bar" role="toolbar" aria-label="Transform" onPointerDown={(e) => e.stopPropagation()}>
      <div className="segmented sym" role="group" aria-label="Transform mode">
        {(['free', 'perspective', 'warp'] as TransformMode[]).map((m) => (
          <button key={m} type="button" aria-pressed={s.mode === m} onClick={() => set(switchMode(s, m))}>
            {{ free: 'Free', perspective: 'Perspective', warp: 'Warp' }[m]}
          </button>
        ))}
      </div>
      {s.mode === 'free' && (
        <>
          <button type="button" className="btn sm" title="Flip left to right" aria-label="Flip left to right" onClick={() => set({ ...s, free: { ...s.free, sx: -s.free.sx } })}>
            <FlipHorizontal size={14} />
          </button>
          <button type="button" className="btn sm" title="Flip upside down" aria-label="Flip upside down" onClick={() => set({ ...s, free: { ...s.free, sy: -s.free.sy } })}>
            <FlipVertical size={14} />
          </button>
          <span className="note mono">
            {Math.round(Math.abs(s.free.sx) * 100)}% × {Math.round(Math.abs(s.free.sy) * 100)}% · {Math.round(s.free.rot)}°
          </span>
        </>
      )}
      <span className="note">
        {s.mode === 'free' ? 'Drag inside to move, a handle to scale (Shift keeps the shape), the round one to turn' : s.mode === 'perspective' ? 'Drag the corners, e.g. onto a door or a box side' : 'Drag the grid points to bend it round a shape'}
      </span>
      <button type="button" className="btn sm" title="Start again" onClick={() => set(startTransform(s.src, s.box))}>
        <RotateCcw size={14} /> Reset
      </button>
      <button type="button" className="btn sm" onClick={onCancel} title="Cancel (Esc)">
        <X size={14} /> Cancel
      </button>
      <button type="button" className="btn sm primary" onClick={onApply} title="Apply (Enter)">
        <Check size={14} /> Apply
      </button>
    </div>
  );
}
