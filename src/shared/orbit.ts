/**
 * Turn it (DECISIONS 114): new views of a cut-out with the Qwen-Image 2.1 viewpoint-orbit LoRA. The LoRA was trained on
 * exactly these instruction forms (its model card), so the UI offers only what they can say.
 */
export const ORBIT_LORA = /viewpoint-orbit.*\.safetensors$/i;

export type OrbitAngle = 0 | 45 | 90 | 135 | 180;
export type OrbitSide = 'left' | 'right';
export type OrbitHeight = 'low' | 'eye' | 'elevated';
export interface OrbitMove {
  angle: OrbitAngle;
  side: OrbitSide;
  height: OrbitHeight;
}

const HEIGHT: Record<OrbitHeight, string> = { low: 'low angle', eye: 'eye level', elevated: 'elevated' };
const ALPHA = 'The image has alpha channel and the background is transparent.';

/** A move the LoRA understands: 0° only changes the height, so it needs low or elevated. */
export const validMove = (m: OrbitMove): boolean => ([0, 45, 90, 135, 180] as number[]).includes(m.angle) && (m.angle !== 0 || m.height !== 'eye');

/** The instruction, in the LoRA's own words, with the transparency sentence its card recommends. */
export function orbitPrompt(m: OrbitMove): string {
  if (!validMove(m)) throw new Error('Pick an angle, or a low or elevated view.');
  const move =
    m.angle === 0
      ? `keep the camera angle, ${HEIGHT[m.height]}`
      : m.angle === 180
        ? `rotate the camera 180 degrees, ${HEIGHT[m.height]}`
        : `rotate the camera ${m.angle} degrees to the ${m.side}, ${HEIGHT[m.height]}`;
  return `<orbit> ${move}. ${ALPHA}`;
}

/** How the move reads in the Library and on the sheet. */
export function orbitLabel(m: OrbitMove): string {
  const h = m.height === 'eye' ? '' : `, ${m.height === 'low' ? 'from low' : 'from above'}`;
  if (m.angle === 0) return `Seen ${m.height === 'low' ? 'from low' : 'from above'}`;
  if (m.angle === 180) return `Turned 180°${h}`;
  return `Turned ${m.angle}° ${m.side}${h}`;
}

/** Turnaround: three turns that, with the picture itself, show it from all four sides. */
export const TURNAROUND: OrbitMove[] = [
  { angle: 90, side: 'right', height: 'eye' },
  { angle: 180, side: 'right', height: 'eye' },
  { angle: 90, side: 'left', height: 'eye' },
];
