/**
 * Transform for the Edit canvas (Edit suite v3.27): a layer (or the part of it inside the selection) is drawn through
 * a grid of points. Move, scale and rotate move the corners together; Perspective moves each corner freely and the
 * inner points follow the projective map; Warp lets you drag any of the grid points. The grid is drawn as triangles,
 * each an affine copy of its piece of the source, slightly overdrawn so no seams show.
 */
import { homography, project, triangleAffine, type Pt } from '../../shared/warp';

export interface Mesh {
  /** points per side (2 = just the corners) */
  n: number;
  /** n × n points, row by row, in picture pixels */
  pts: Pt[];
}

/** The straight grid over a box. */
export function gridMesh(box: { x: number; y: number; w: number; h: number }, n: number): Mesh {
  const pts: Pt[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pts.push({ x: box.x + (box.w * i) / (n - 1), y: box.y + (box.h * j) / (n - 1) });
  return { n, pts };
}

export const corners = (m: Mesh): [Pt, Pt, Pt, Pt] => [m.pts[0], m.pts[m.n - 1], m.pts[m.n * m.n - 1], m.pts[m.n * (m.n - 1)]];

/** Inner points from the four corners by the projective map (perspective). */
export function perspectiveMesh(src: Mesh, dstCorners: Pt[]): Mesh | null {
  const h = homography(corners(src), dstCorners);
  if (!h) return null;
  return { n: src.n, pts: src.pts.map((p) => project(h, p)) };
}

/** Move, scale (about the box centre) and rotate (degrees) a mesh as one piece. */
export function affineMesh(src: Mesh, o: { dx: number; dy: number; sx: number; sy: number; rot: number }): Mesh {
  const c = corners(src);
  const cx = (c[0].x + c[2].x) / 2;
  const cy = (c[0].y + c[2].y) / 2;
  const a = (o.rot * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return {
    n: src.n,
    pts: src.pts.map((p) => {
      const x = (p.x - cx) * o.sx;
      const y = (p.y - cy) * o.sy;
      return { x: cx + o.dx + x * cos - y * sin, y: cy + o.dy + x * sin + y * cos };
    }),
  };
}

/** Grow a triangle a little about its centre so neighbouring triangles overlap and leave no hairline seams. */
function inflate(t: [Pt, Pt, Pt], px: number): [Pt, Pt, Pt] {
  const cx = (t[0].x + t[1].x + t[2].x) / 3;
  const cy = (t[0].y + t[1].y + t[2].y) / 3;
  return t.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / d) * px, y: p.y + (dy / d) * px };
  }) as [Pt, Pt, Pt];
}

/**
 * Draw `src` (whose grid is `from`) onto `g` so that its grid lands on `to`. `scale` maps picture pixels to `g`'s
 * pixels (a smaller preview while dragging).
 */
export function drawMesh(g: CanvasRenderingContext2D, src: CanvasImageSource, from: Mesh, to: Mesh, scale = 1): void {
  const n = from.n;
  const tri = (a: number, b: number, c: number) => {
    const s: [Pt, Pt, Pt] = [from.pts[a], from.pts[b], from.pts[c]];
    const d: [Pt, Pt, Pt] = [to.pts[a], to.pts[b], to.pts[c]].map((p) => ({ x: p.x * scale, y: p.y * scale })) as [Pt, Pt, Pt];
    const m = triangleAffine(s, d);
    if (!m) return;
    const clip = inflate(d, 0.6);
    g.save();
    g.beginPath();
    g.moveTo(clip[0].x, clip[0].y);
    g.lineTo(clip[1].x, clip[1].y);
    g.lineTo(clip[2].x, clip[2].y);
    g.closePath();
    g.clip();
    g.setTransform(...m);
    // only the source rectangle under this triangle, a pixel wider
    const xs = s.map((p) => p.x);
    const ys = s.map((p) => p.y);
    const x0 = Math.floor(Math.min(...xs)) - 1;
    const y0 = Math.floor(Math.min(...ys)) - 1;
    const x1 = Math.ceil(Math.max(...xs)) + 1;
    const y1 = Math.ceil(Math.max(...ys)) + 1;
    g.drawImage(src, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    g.restore();
  };
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      tri(a, a + 1, a + n);
      tri(a + 1, a + n + 1, a + n);
    }
}

/** Is a plain move / scale / rotate (no perspective or warp) — then one drawImage with a transform does it exactly. */
export function isAffine(from: Mesh, to: Mesh): boolean {
  const [a, b, , d] = corners(from);
  const [A, B, C, D] = corners(to);
  const m = triangleAffine([a, b, d], [A, B, D]);
  if (!m) return false;
  const [c] = [corners(from)[2]];
  const px = m[0] * c.x + m[2] * c.y + m[4];
  const py = m[1] * c.x + m[3] * c.y + m[5];
  if (Math.hypot(px - C.x, py - C.y) > 0.5) return false;
  return to.pts.every((p, i) => {
    const s = from.pts[i];
    return Math.hypot(m[0] * s.x + m[2] * s.y + m[4] - p.x, m[1] * s.x + m[3] * s.y + m[5] - p.y) < 0.5;
  });
}
