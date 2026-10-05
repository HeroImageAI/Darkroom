/**
 * Photo adjustments for adjustment layers (Edit suite v3.27): the settings, and the tone lookup tables they make.
 * Tone (exposure, brightness, contrast, levels, curves) becomes four 256-entry tables (master, R, G, B) the GPU
 * applies per pixel; colour (hue, saturation, lightness, vibrance, temperature, tint, black & white, split tone, grain)
 * is done in the shader from the numbers here. Everything is neutral at its default.
 */

export interface CurvePoint {
  x: number;
  y: number;
}

export interface Adjust {
  /** stops, -3..3 */
  exposure: number;
  /** -1..1 */
  brightness: number;
  /** -1..1 */
  contrast: number;
  /** input black / white point 0..255, midtone gamma 0.1..10 (1 = neutral); output range 0..255 */
  levels: { black: number; white: number; gamma: number; outBlack: number; outWhite: number };
  /** 0..1 points, sorted by x; [] = straight */
  curves: { rgb: CurvePoint[]; r: CurvePoint[]; g: CurvePoint[]; b: CurvePoint[] };
  /** degrees -180..180 */
  hue: number;
  /** -1..1 */
  saturation: number;
  lightness: number;
  vibrance: number;
  /** warm (+) / cool (-), -1..1 */
  temperature: number;
  /** magenta (+) / green (-), -1..1 */
  tint: number;
  /** 0..1, how far to black & white */
  bw: number;
  /** split tone: hue 0..360, amount 0..1 */
  shadowsHue: number;
  shadowsAmount: number;
  highlightsHue: number;
  highlightsAmount: number;
  /** film grain 0..1 */
  grain: number;
}

export const NEUTRAL: Adjust = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  levels: { black: 0, white: 255, gamma: 1, outBlack: 0, outWhite: 255 },
  curves: { rgb: [], r: [], g: [], b: [] },
  hue: 0,
  saturation: 0,
  lightness: 0,
  vibrance: 0,
  temperature: 0,
  tint: 0,
  bw: 0,
  shadowsHue: 210,
  shadowsAmount: 0,
  highlightsHue: 40,
  highlightsAmount: 0,
  grain: 0,
};

/** Presets for the Adjust panel: quick darkroom looks that set several sliders at once. */
export const LOOKS: { id: string; label: string; adjust: Partial<Adjust> }[] = [
  { id: 'punch', label: 'Punch', adjust: { contrast: 0.25, vibrance: 0.3 } },
  { id: 'fade', label: 'Faded film', adjust: { contrast: -0.15, levels: { black: 0, white: 255, gamma: 1, outBlack: 28, outWhite: 240 }, saturation: -0.15, grain: 0.25 } },
  { id: 'warm', label: 'Golden hour', adjust: { temperature: 0.35, tint: 0.05, vibrance: 0.15 } },
  { id: 'cool', label: 'Blue hour', adjust: { temperature: -0.35, exposure: -0.2 } },
  { id: 'bw', label: 'Silver gelatin', adjust: { bw: 1, contrast: 0.2, grain: 0.3 } },
  { id: 'split', label: 'Teal & orange', adjust: { shadowsHue: 190, shadowsAmount: 0.35, highlightsHue: 30, highlightsAmount: 0.3, contrast: 0.1 } },
];

export function mergeAdjust(a: Partial<Adjust> | undefined): Adjust {
  return {
    ...NEUTRAL,
    ...a,
    levels: { ...NEUTRAL.levels, ...(a?.levels ?? {}) },
    curves: { ...NEUTRAL.curves, ...(a?.curves ?? {}) },
  };
}

/** Settings from outside (a saved project), with every number checked and kept in range. */
export function sanitizeAdjust(raw: unknown): Adjust {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const pts = (v: unknown): CurvePoint[] => (Array.isArray(v) ? v.slice(0, 16).filter((p) => p && typeof p === 'object').map((p: any) => ({ x: num(p.x, 0, 1, 0), y: num(p.y, 0, 1, 0) })) : []);
  const L = (r.levels ?? {}) as Record<string, unknown>;
  const C = (r.curves ?? {}) as Record<string, unknown>;
  return {
    exposure: num(r.exposure, -3, 3, 0),
    brightness: num(r.brightness, -1, 1, 0),
    contrast: num(r.contrast, -1, 1, 0),
    levels: { black: num(L.black, 0, 254, 0), white: num(L.white, 1, 255, 255), gamma: num(L.gamma, 0.1, 10, 1), outBlack: num(L.outBlack, 0, 254, 0), outWhite: num(L.outWhite, 1, 255, 255) },
    curves: { rgb: pts(C.rgb), r: pts(C.r), g: pts(C.g), b: pts(C.b) },
    hue: num(r.hue, -180, 180, 0),
    saturation: num(r.saturation, -1, 1, 0),
    lightness: num(r.lightness, -1, 1, 0),
    vibrance: num(r.vibrance, -1, 1, 0),
    temperature: num(r.temperature, -1, 1, 0),
    tint: num(r.tint, -1, 1, 0),
    bw: num(r.bw, 0, 1, 0),
    shadowsHue: num(r.shadowsHue, 0, 360, 210),
    shadowsAmount: num(r.shadowsAmount, 0, 1, 0),
    highlightsHue: num(r.highlightsHue, 0, 360, 40),
    highlightsAmount: num(r.highlightsAmount, 0, 1, 0),
    grain: num(r.grain, 0, 1, 0),
  };
}

export function isNeutral(a: Adjust): boolean {
  return JSON.stringify(mergeAdjust(a)) === JSON.stringify(NEUTRAL);
}

/**
 * Monotone cubic interpolation (Fritsch–Carlson) through the points, sampled at 256 steps; with the ends pinned to
 * (0,0) and (1,1) unless the points move them. A curve can bend but never overshoot or fold back.
 */
export function curveTable(points: CurvePoint[]): Float32Array {
  const out = new Float32Array(256);
  const pts = [...points].filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) })).sort((a, b) => a.x - b.x);
  if (!pts.length || pts[0].x > 0) pts.unshift({ x: 0, y: pts.length && pts[0].x === 0 ? pts[0].y : 0 });
  if (pts[pts.length - 1].x < 1) pts.push({ x: 1, y: 1 });
  // drop duplicate x
  const p = pts.filter((q, i) => i === 0 || q.x > pts[i - 1].x);
  const n = p.length;
  if (n < 2) {
    for (let i = 0; i < 256; i++) out[i] = i / 255;
    return out;
  }
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((p[i + 1].y - p[i].y) / (p[i + 1].x - p[i].x));
  const m: number[] = [d[0]];
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  let k = 0;
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    while (k < n - 2 && x > p[k + 1].x) k++;
    const h = p[k + 1].x - p[k].x;
    const t = Math.min(1, Math.max(0, (x - p[k].x) / h));
    const t2 = t * t;
    const t3 = t2 * t;
    out[i] = clamp01((2 * t3 - 3 * t2 + 1) * p[k].y + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * p[k + 1].y + (t3 - t2) * h * m[k + 1]);
  }
  return out;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * The tone tables: RGBA bytes, 256 × 1, where the red byte of entry i is what red value i becomes (and so on), with
 * exposure, brightness, contrast, levels and the master curve folded into each channel's own curve.
 */
export function toneTable(a: Adjust): Uint8Array {
  const master = curveTable(a.curves.rgb);
  const ch = [curveTable(a.curves.r), curveTable(a.curves.g), curveTable(a.curves.b)];
  const L = a.levels;
  const lo = Math.min(L.black, L.white - 1) / 255;
  const hi = Math.max(L.white, L.black + 1) / 255;
  const gamma = Math.min(10, Math.max(0.1, L.gamma || 1));
  const expo = Math.pow(2, Math.max(-3, Math.min(3, a.exposure)));
  const c = Math.max(-1, Math.min(1, a.contrast));
  const cf = c >= 0 ? 1 + c * 2 : 1 + c; // 0..3 slope around mid-grey
  const out = new Uint8Array(256 * 4);
  const sample = (tab: Float32Array, v: number) => {
    const f = clamp01(v) * 255;
    const i = Math.floor(f);
    const t = f - i;
    return i >= 255 ? tab[255] : tab[i] * (1 - t) + tab[i + 1] * t;
  };
  for (let i = 0; i < 256; i++) {
    let v = i / 255;
    v = clamp01((v - lo) / (hi - lo));
    v = Math.pow(v, 1 / gamma);
    v = L.outBlack / 255 + v * ((L.outWhite - L.outBlack) / 255);
    v = v * expo;
    v = v + a.brightness * 0.5;
    v = (v - 0.5) * cf + 0.5;
    v = sample(master, v);
    for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.round(sample(ch[k], v) * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Histogram of a picture's RGBA bytes: luminance and each channel, 256 bins each (for Levels). */
export function histogram(data: Uint8ClampedArray | Uint8Array, step = 1): { l: Uint32Array; r: Uint32Array; g: Uint32Array; b: Uint32Array } {
  const l = new Uint32Array(256);
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4 * step) {
    if (data[i + 3] < 8) continue;
    r[data[i]]++;
    g[data[i + 1]]++;
    b[data[i + 2]]++;
    l[Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])]++;
  }
  return { l, r, g, b };
}

/** Auto levels: black and white points where `clip` (share of pixels) is cut at each end. */
export function autoLevels(hist: Uint32Array, clip = 0.005): { black: number; white: number } {
  let total = 0;
  for (const v of hist) total += v;
  if (!total) return { black: 0, white: 255 };
  const cut = total * clip;
  let acc = 0;
  let black = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc > cut) {
      black = i;
      break;
    }
  }
  acc = 0;
  let white = 255;
  for (let i = 255; i >= 0; i--) {
    acc += hist[i];
    if (acc > cut) {
      white = i;
      break;
    }
  }
  return white - black < 8 ? { black: 0, white: 255 } : { black, white };
}
