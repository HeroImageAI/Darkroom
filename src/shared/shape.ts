/**
 * Shape in Instruct (DECISIONS 117): an instruction edit that comes back in another shape. Both edit graphs start from
 * the picture itself as the canvas and scale the result back to the picture's size, so the result always had the
 * picture's shape (MOV-IMG-01: a portrait storyboard page gave a portrait "widescreen" keyframe). With a shape, the
 * canvas becomes an empty latent of that shape (~1 MP, as the models work) and the result is scaled to the picture's
 * own pixel count in the new shape; the picture stays the model's reference, so it is redrawn to fill the new frame.
 */
import { findByTitle, type ApiPrompt } from './workflow.js';

export const SHAPES = ['16:9', '3:2', '1:1', '4:5', '9:16'] as const;
export type Shape = (typeof SHAPES)[number];

const ratio = (s: Shape) => {
  const [a, b] = s.split(':').map(Number);
  return a / b;
};
const snap = (v: number, m: number) => Math.max(m, Math.round(v / m) * m);

/** Work size (~1 MP, multiples of 32) and full size (the picture's pixel count, multiples of 16) for a shape. */
export function shapeSizes(shape: Shape, srcW: number, srcH: number): { work: { w: number; h: number }; full: { w: number; h: number } } {
  const r = ratio(shape);
  const work = { w: snap(Math.sqrt(1024 * 1024 * r), 32), h: snap(Math.sqrt((1024 * 1024) / r), 32) };
  const px = Math.max(512 * 512, Math.min(srcW * srcH, 4096 * 4096));
  const full = { w: snap(Math.sqrt(px * r), 16), h: snap(Math.sqrt(px / r), 16) };
  return { work, full };
}

/**
 * Re-shape an instruction-edit graph (Qwen `qwen_edit` or Klein `klein_edit`, no mask): the sampler starts from an
 * empty latent of the work size, and the final resize goes to the full size instead of the picture's.
 * Returns false when the graph is not one it knows (it is then left alone).
 */
export function applyShape(prompt: ApiPrompt, family: 'qwen' | 'klein', work: { w: number; h: number }, full: { w: number; h: number }): boolean {
  const byTitle = (t: string) => findByTitle(prompt, t)[0];
  const resize = byTitle(family === 'qwen' ? 'Back to source size' : 'Fill to full size');
  const canvas = byTitle(family === 'qwen' ? 'Encode picture' : 'Encode canvas');
  if (!resize || !canvas) return false;
  // every input that read the encoded picture now reads the empty latent
  const id = '9900';
  prompt[id] = family === 'qwen'
    ? { class_type: 'EmptyLatentImage', inputs: { width: work.w, height: work.h, batch_size: 1 }, _meta: { title: 'Shape canvas' } }
    : { class_type: 'EmptyFlux2LatentImage', inputs: { width: work.w, height: work.h, batch_size: 1 }, _meta: { title: 'Shape canvas' } };
  let used = 0;
  for (const [k, n] of Object.entries(prompt)) {
    if (k === id) continue;
    for (const [name, v] of Object.entries(n.inputs))
      if (Array.isArray(v) && v[0] === canvas) {
        n.inputs[name] = [id, 0];
        used++;
      }
  }
  Object.assign(prompt[resize].inputs, { width: full.w, height: full.h });
  return used > 0;
}
