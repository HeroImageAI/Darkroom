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
    const clip = inflate(d, 1.25);
    g.save();
    g.beginPath();
    g.moveTo(clip[0].x, clip[0].y);
    g.lineTo(clip[1].x, clip[1].y);
    g.lineTo(clip[2].x, clip[2].y);
    g.closePath();
    g.clip();
    g.setTransform(...m);
    // only the source rectangle under this triangle, wider than the overlap so the seams get pixels too
    const xs = s.map((p) => p.x);
    const ys = s.map((p) => p.y);
    const x0 = Math.floor(Math.min(...xs)) - 3;
    const y0 = Math.floor(Math.min(...ys)) - 3;
    const x1 = Math.ceil(Math.max(...xs)) + 3;
    const y1 = Math.ceil(Math.max(...ys)) + 3;
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

/** A finer grid through a coarse control grid (piecewise bilinear), so a warp bends smoothly. */
export function refine(ctrl: Mesh, n: number): Mesh {
  const m = ctrl.n - 1;
  const pts: Pt[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const u = (i / (n - 1)) * m;
      const v = (j / (n - 1)) * m;
      const ci = Math.min(m - 1, Math.floor(u));
      const cj = Math.min(m - 1, Math.floor(v));
      const fu = u - ci;
      const fv = v - cj;
      const p = (a: number, b: number) => ctrl.pts[(cj + b) * ctrl.n + ci + a];
      const top = { x: p(0, 0).x + (p(1, 0).x - p(0, 0).x) * fu, y: p(0, 0).y + (p(1, 0).y - p(0, 0).y) * fu };
      const bot = { x: p(0, 1).x + (p(1, 1).x - p(0, 1).x) * fu, y: p(0, 1).y + (p(1, 1).y - p(0, 1).y) * fu };
      pts.push({ x: top.x + (bot.x - top.x) * fv, y: top.y + (bot.y - top.y) * fv });
    }
  return { n, pts };
}

/**
 * The same mesh drawn on the GPU: textured triangles share their edges exactly, so a perspective or warp has no
 * hairline seams (the 2D canvas clips each triangle with anti-aliasing). Returns a canvas of out.w × out.h.
 */
class MeshGL {
  readonly canvas = document.createElement('canvas');
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture;
  private buf: WebGLBuffer;
  constructor() {
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true, antialias: false });
    if (!gl) throw new Error('no WebGL');
    this.gl = gl;
    const sh = (t: number, src: string) => {
      const s = gl.createShader(t)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, 'attribute vec2 a_pos; attribute vec2 a_uv; uniform vec2 u_dst; uniform vec2 u_src; varying vec2 v_uv; void main(){ v_uv = a_uv / u_src; vec2 c = a_pos / u_dst * 2.0 - 1.0; gl_Position = vec4(c.x, -c.y, 0.0, 1.0); }'));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, 'precision highp float; varying vec2 v_uv; uniform sampler2D u_tex; void main(){ gl_FragColor = texture2D(u_tex, v_uv); }'));
    gl.linkProgram(p);
    this.prog = p;
    this.tex = gl.createTexture()!;
    this.buf = gl.createBuffer()!;
  }
  draw(src: HTMLCanvasElement, from: Mesh, to: Mesh, w: number, h: number): HTMLCanvasElement {
    const gl = this.gl;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const n = from.n;
    const v: number[] = [];
    const put = (k: number) => v.push(to.pts[k].x, to.pts[k].y, from.pts[k].x, from.pts[k].y);
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        [a, a + 1, a + n, a + 1, a + n + 1, a + n].forEach(put);
      }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
    const pos = gl.getAttribLocation(this.prog, 'a_pos');
    const uv = gl.getAttribLocation(this.prog, 'a_uv');
    gl.enableVertexAttribArray(pos);
    gl.enableVertexAttribArray(uv);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
    gl.uniform2f(gl.getUniformLocation(this.prog, 'u_dst'), w, h);
    gl.uniform2f(gl.getUniformLocation(this.prog, 'u_src'), src.width, src.height);
    gl.uniform1i(gl.getUniformLocation(this.prog, 'u_tex'), 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, v.length / 4);
    return this.canvas;
  }
}

let meshGL: MeshGL | null | undefined;
/** Draw a mesh seam-free on the GPU when it can, else with the 2D canvas. */
export function drawMeshBest(g: CanvasRenderingContext2D, src: HTMLCanvasElement, from: Mesh, to: Mesh, w: number, h: number): void {
  if (meshGL === undefined) {
    try {
      meshGL = new MeshGL();
    } catch {
      meshGL = null;
    }
  }
  if (meshGL) g.drawImage(meshGL.draw(src, from, to, w, h), 0, 0);
  else drawMesh(g, src, from, to);
}
