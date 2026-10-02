/**
 * Cut out (DECISIONS 99): is an Alpha-Gen matte usable? A good matte is near black outside the subject and near white
 * on it; a bad one (some seeds) comes out grey, with the picture's shading bleeding in, which would turn the subject
 * into a see-through ghost. Measured on the matte's first and last frames (grey values 0-255).
 */
export interface MatteCheck {
  /** Share of the frame that is subject (above 15 % grey). */
  foreground: number;
  /** Median brightness of the subject pixels, 0-1 (1 = solid). */
  level: number;
  ok: boolean;
}

export function checkMatte(grey: Uint8Array | number[]): MatteCheck {
  const fg: number[] = [];
  for (const v of grey) if (v > 38) fg.push(v);
  const foreground = grey.length ? fg.length / grey.length : 0;
  if (!fg.length) return { foreground: 0, level: 0, ok: false };
  fg.sort((a, b) => a - b);
  const level = fg[Math.floor(fg.length / 2)] / 255;
  return { foreground, level, ok: level >= 0.85 };
}
