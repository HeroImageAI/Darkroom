/** Colour helpers for the Edit colour picker (Edit suite v3.26): hex ↔ RGB ↔ HSV, all 0–1 except hue 0–360. */

export interface Hsv {
  h: number;
  s: number;
  v: number;
}

export function hexToRgb(hex: string): [number, number, number] | null {
  let m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) {
    const s = /^#?([0-9a-f]{3})$/i.exec(hex.trim());
    if (!s) return null;
    m = [s[0], s[1].split('').map((c) => c + c).join('')] as unknown as RegExpExecArray;
  }
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0')).join('');
}

export function rgbToHsv(r: number, g: number, b: number): Hsv {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

export const hexToHsv = (hex: string): Hsv => {
  const rgb = hexToRgb(hex) ?? [0, 0, 0];
  return rgbToHsv(...rgb);
};
export const hsvToHex = (hsv: Hsv): string => rgbToHex(...hsvToRgb(hsv));
