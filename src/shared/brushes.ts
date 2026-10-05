/**
 * Brush presets for the Edit canvas (Edit suite v3.26). Three engines:
 *  - paint:  colour dabs into a stroke buffer (pencil, ink, marker, airbrush, chalk, flat);
 *  - smudge: drags the layer's own pixels along the stroke;
 *  - filter: a filtered copy of the layer (blur, dodge, burn, sponge…) shows through the stroke — a darkroom's own tools.
 * Each preset is a starting point; size, opacity and the rest stay as you last left them per preset.
 */
export type BrushEngine = 'paint' | 'smudge' | 'filter' | 'clone';
export type BrushFilter = 'blur' | 'dodge' | 'burn' | 'sponge' | 'saturate';

export interface BrushPreset {
  id: string;
  label: string;
  engine: BrushEngine;
  size: number;
  hardness: number;
  opacity: number;
  pressureSize: boolean;
  pressureOpacity: boolean;
  smoothing: number;
  /** dab spacing as a share of the diameter */
  spacing: number;
  /** paper grain in the dab (chalk) */
  texture?: boolean;
  filter?: BrushFilter;
  tip: string;
}

export const BRUSHES: BrushPreset[] = [
  { id: 'pencil', label: 'Pencil', engine: 'paint', size: 4, hardness: 0.95, opacity: 0.9, pressureSize: false, pressureOpacity: true, smoothing: 0.2, spacing: 0.15, texture: true, tip: 'Sketching: pressure makes it darker' },
  { id: 'ink', label: 'Ink pen', engine: 'paint', size: 8, hardness: 0.98, opacity: 1, pressureSize: true, pressureOpacity: false, smoothing: 0.5, spacing: 0.06, tip: 'Clean line art: pressure makes it thicker, smoothed' },
  { id: 'marker', label: 'Marker', engine: 'paint', size: 28, hardness: 0.75, opacity: 0.55, pressureSize: false, pressureOpacity: false, smoothing: 0.25, spacing: 0.08, tip: 'Flat, see-through strokes that do not build up inside a stroke' },
  { id: 'airbrush', label: 'Airbrush', engine: 'paint', size: 120, hardness: 0, opacity: 0.35, pressureSize: false, pressureOpacity: true, smoothing: 0.3, spacing: 0.06, tip: 'Soft shading and glows' },
  { id: 'chalk', label: 'Chalk', engine: 'paint', size: 36, hardness: 0.6, opacity: 0.85, pressureSize: true, pressureOpacity: true, smoothing: 0.2, spacing: 0.1, texture: true, tip: 'Grainy, painterly texture' },
  { id: 'round', label: 'Round', engine: 'paint', size: 24, hardness: 0.85, opacity: 1, pressureSize: true, pressureOpacity: false, smoothing: 0.35, spacing: 0.08, tip: 'All-round brush' },
  { id: 'clone', label: 'Clone', engine: 'clone', size: 60, hardness: 0.6, opacity: 1, pressureSize: false, pressureOpacity: false, smoothing: 0.15, spacing: 0.08, tip: 'Copy one part of the picture over another: Alt-click where to copy from, then paint' },
  { id: 'smudge', label: 'Smudge', engine: 'smudge', size: 40, hardness: 0.5, opacity: 0.7, pressureSize: true, pressureOpacity: true, smoothing: 0.2, spacing: 0.1, tip: 'Push and blend the paint that is there' },
  { id: 'blur', label: 'Blur', engine: 'filter', filter: 'blur', size: 60, hardness: 0.3, opacity: 0.8, pressureSize: false, pressureOpacity: true, smoothing: 0.2, spacing: 0.1, tip: 'Soften detail where you paint' },
  { id: 'dodge', label: 'Dodge', engine: 'filter', filter: 'dodge', size: 90, hardness: 0.1, opacity: 0.35, pressureSize: false, pressureOpacity: true, smoothing: 0.2, spacing: 0.1, tip: 'Lighten, as under the enlarger' },
  { id: 'burn', label: 'Burn', engine: 'filter', filter: 'burn', size: 90, hardness: 0.1, opacity: 0.35, pressureSize: false, pressureOpacity: true, smoothing: 0.2, spacing: 0.1, tip: 'Darken and deepen' },
  { id: 'sponge', label: 'Sponge', engine: 'filter', filter: 'sponge', size: 70, hardness: 0.3, opacity: 0.5, pressureSize: false, pressureOpacity: true, smoothing: 0.2, spacing: 0.1, tip: 'Take the colour out' },
  { id: 'vivid', label: 'Saturate', engine: 'filter', filter: 'saturate', size: 70, hardness: 0.3, opacity: 0.5, pressureSize: false, pressureOpacity: true, smoothing: 0.2, spacing: 0.1, tip: 'Make colours richer' },
];

export const brushById = (id: string): BrushPreset => BRUSHES.find((b) => b.id === id) ?? BRUSHES.find((b) => b.id === 'round')!;

/** The CSS filter that makes a filter brush's source, for a brush of `size` px. */
export function brushFilterCss(f: BrushFilter, size: number): string {
  switch (f) {
    case 'blur':
      return `blur(${Math.max(1, Math.round(size / 10))}px)`;
    case 'dodge':
      return 'brightness(1.4) contrast(0.95)';
    case 'burn':
      return 'brightness(0.68) contrast(1.08) saturate(1.1)';
    case 'sponge':
      return 'saturate(0)';
    case 'saturate':
      return 'saturate(1.7)';
  }
}

/** Pen feel: firm (needs pressure) to soft (a light touch is enough), as the curve's gamma. */
export const penGamma = (feel: number) => Math.pow(2, -Math.max(-1, Math.min(1, feel)));
