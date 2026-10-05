/**
 * Adjustment layers on the GPU (Edit suite v3.27): one WebGL pass applies the tone tables (exposure, brightness,
 * contrast, levels, curves) and the colour work (hue, saturation, lightness, vibrance, temperature, tint, black &
 * white, split tone, grain) to a region of the picture. Only the region that changed is processed, so painting under
 * an adjustment layer stays quick. Grain is keyed to picture pixels, so it never crawls between redraws.
 */
import { toneTable, type Adjust } from '../../shared/adjust';

const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FS = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_img;
uniform sampler2D u_lut;
uniform vec2 u_size;     // region size in px
uniform vec2 u_offset;   // region origin in picture px
uniform float u_hue, u_sat, u_light, u_vib, u_temp, u_tint, u_bw, u_shH, u_shA, u_hiH, u_hiA, u_grain;

vec3 hue2rgb(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}
vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  if (d < 1e-5) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
vec3 hsl2rgb(vec3 hsl) {
  vec3 rgb = hue2rgb(hsl.x);
  float c = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
  return (rgb - 0.5) * c + hsl.z;
}
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
void main() {
  // the canvas region is uploaded top row first, so flip v to read it the right way up
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec4 c = texture2D(u_img, uv);
  if (c.a < 0.002) { gl_FragColor = vec4(0.0); return; }
  vec3 rgb = c.rgb;
  rgb = vec3(
    texture2D(u_lut, vec2((rgb.r * 255.0 + 0.5) / 256.0, 0.5)).r,
    texture2D(u_lut, vec2((rgb.g * 255.0 + 0.5) / 256.0, 0.5)).g,
    texture2D(u_lut, vec2((rgb.b * 255.0 + 0.5) / 256.0, 0.5)).b);
  rgb *= vec3(1.0 + 0.14 * u_temp + 0.04 * u_tint, 1.0 - 0.10 * u_tint, 1.0 - 0.16 * u_temp + 0.04 * u_tint);
  vec3 hsl = rgb2hsl(clamp(rgb, 0.0, 1.0));
  hsl.x = fract(hsl.x + u_hue / 360.0);
  hsl.y = clamp(hsl.y * (1.0 + u_sat), 0.0, 1.0);
  hsl.y = clamp(hsl.y + u_vib * (1.0 - hsl.y) * hsl.y * 1.5, 0.0, 1.0);
  rgb = hsl2rgb(hsl);
  rgb = u_light > 0.0 ? mix(rgb, vec3(1.0), u_light * 0.6) : mix(rgb, vec3(0.0), -u_light * 0.6);
  float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(rgb, vec3(lum), u_bw);
  float shw = (1.0 - lum) * (1.0 - lum);
  float hiw = lum * lum;
  rgb += (hue2rgb(u_shH / 360.0) - 0.5) * u_shA * shw * 0.5;
  rgb += (hue2rgb(u_hiH / 360.0) - 0.5) * u_hiA * hiw * 0.5;
  if (u_grain > 0.0) {
    vec2 px = floor(u_offset + vec2(uv.x, uv.y) * u_size);
    float n = hash(px) + hash(px + 17.0) - 1.0;
    rgb += n * u_grain * 0.16 * (0.35 + 4.0 * lum * (1.0 - lum));
  }
  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), c.a);
}`;

export class AdjustGL {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private img: WebGLTexture;
  private lut: WebGLTexture;
  private lutKey = '';
  private u: Record<string, WebGLUniformLocation | null> = {};

  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: true });
    if (!gl) throw new Error('This browser has no WebGL, so adjustment layers cannot be shown.');
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'program');
    this.prog = p;
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['u_img', 'u_lut', 'u_size', 'u_offset', 'u_hue', 'u_sat', 'u_light', 'u_vib', 'u_temp', 'u_tint', 'u_bw', 'u_shH', 'u_shA', 'u_hiH', 'u_hiA', 'u_grain']) this.u[n] = gl.getUniformLocation(p, n);
    const tex = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.img = tex();
    this.lut = tex();
    gl.uniform1i(this.u.u_img, 0);
    gl.uniform1i(this.u.u_lut, 1);
  }

  /** `src` (a region `r` of the picture, already cut to r.w × r.h) adjusted; the result is this.canvas. */
  apply(src: HTMLCanvasElement, a: Adjust, r: { x: number; y: number; w: number; h: number }): HTMLCanvasElement {
    const gl = this.gl;
    if (this.canvas.width !== r.w || this.canvas.height !== r.h) {
      this.canvas.width = r.w;
      this.canvas.height = r.h;
    }
    gl.viewport(0, 0, r.w, r.h);
    gl.useProgram(this.prog);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    const key = JSON.stringify([a.exposure, a.brightness, a.contrast, a.levels, a.curves]);
    if (key !== this.lutKey) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, toneTable(a));
      this.lutKey = key;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.img);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.uniform2f(this.u.u_size, r.w, r.h);
    gl.uniform2f(this.u.u_offset, r.x, r.y);
    const f = (n: string, v: number) => gl.uniform1f(this.u[n], v);
    f('u_hue', a.hue);
    f('u_sat', a.saturation);
    f('u_light', a.lightness);
    f('u_vib', a.vibrance);
    f('u_temp', a.temperature);
    f('u_tint', a.tint);
    f('u_bw', a.bw);
    f('u_shH', a.shadowsHue);
    f('u_shA', a.shadowsAmount);
    f('u_hiH', a.highlightsHue);
    f('u_hiA', a.highlightsAmount);
    f('u_grain', a.grain);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return this.canvas;
  }
}

let shared: AdjustGL | null = null;
/** One GPU context for every adjustment layer (browsers allow only a few). */
export function adjustGL(): AdjustGL {
  return (shared ??= new AdjustGL());
}
