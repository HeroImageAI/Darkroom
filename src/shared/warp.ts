/**
 * Transform maths for the Edit canvas (Edit suite v3.27): the perspective (projective) map between four corners, used
 * to place a layer — a print on a hoodie, a decal on a car door — and the corner handles of free transform.
 */

export interface Pt {
  x: number;
  y: number;
}

/** 3×3 homography (row-major, h[8] = 1) taking the four `src` points to the four `dst` points; null if degenerate. */
export function homography(src: Pt[], dst: Pt[]): number[] | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  const A: number[][] = [];
  const B: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    B.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    B.push(v);
  }
  const h = solve(A, B);
  return h ? [...h, 1] : null;
}

/** Gaussian elimination with partial pivoting. */
function solve(A: number[][], B: number[]): number[] | null {
  const n = B.length;
  const M = A.map((r, i) => [...r, B[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

export function project(h: number[], p: Pt): Pt {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

/** The affine map (a, b, c, d, e, f as for canvas setTransform) taking triangle s to triangle t. */
export function triangleAffine(s: [Pt, Pt, Pt], t: [Pt, Pt, Pt]): [number, number, number, number, number, number] | null {
  const [s0, s1, s2] = s;
  const [t0, t1, t2] = t;
  const den = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (Math.abs(den) < 1e-9) return null;
  const a = ((t1.x - t0.x) * (s2.y - s0.y) - (t2.x - t0.x) * (s1.y - s0.y)) / den;
  const c = ((t2.x - t0.x) * (s1.x - s0.x) - (t1.x - t0.x) * (s2.x - s0.x)) / den;
  const b = ((t1.y - t0.y) * (s2.y - s0.y) - (t2.y - t0.y) * (s1.y - s0.y)) / den;
  const d = ((t2.y - t0.y) * (s1.x - s0.x) - (t1.y - t0.y) * (s2.x - s0.x)) / den;
  return [a, b, c, d, t0.x - a * s0.x - c * s0.y, t0.y - b * s0.x - d * s0.y];
}

/** Is the quad (corners in order) convex and not folded? A perspective handle drag must keep it so. */
export function convexQuad(q: Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-9) return false;
    const s = Math.sign(z);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}
