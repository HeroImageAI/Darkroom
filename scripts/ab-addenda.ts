/**
 * A/B runner for the Addenda 1+2 phases. Every case runs once per variant with a fixed seed; records go to
 * docs/qa/addenda/<phase>/runs.json (resumable: finished case/variant pairs are skipped).
 *   npx tsx scripts/ab-addenda.ts p1 [group-prefix]
 * Grids: python scripts/ab_addenda_grids.py p1
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/server/config.js';
import { composeImagePrompt, type PromptTemplates } from '../src/shared/prompts.js';
import { maskBBox, planCrop, type Box, type CropPlan } from '../src/shared/cropstitch.js';
import { buildOutpaintCanvas } from '../src/server/outpaint.js';
import { snapPad, type Pad } from '../src/shared/outpaint.js';
import sharp from 'sharp';
import { buildVlm2Request, type Vlm2Prompts, type Vlm2Task } from '../src/shared/vlm.js';

const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const g = (id: string) => path.join('tests', 'golden', `${id}.png`);

interface Case { key: string; set: Record<string, string | number>; images?: Record<string, string>; caption?: string; workflow?: string }
interface Variant {
  id: string;
  label: string;
  workflow: string;
  file?: string;
  set?: Record<string, string | number>;
  /** Case-specific overrides (prompt built from the case caption, a different input image, ...). */
  build?: (c: Case) => { set?: Record<string, string | number>; images?: Record<string, string> };
}
interface Group { id: string; variants: Variant[]; cases: Case[] }
interface Row { group: string; key: string; variant: string; ok: boolean; seconds?: number; peak?: number; file_out?: string; error?: string; set: Record<string, string | number>; text?: string }

// One Node T2I templates (config.json "t2i_templates"), credited: github.com/yanokusnir-ai/one-node-flux-2-klein
const ONE_NODE_FOX = 'A young fox is gently peeking through tall, vibrant green wheat stalks. The fox stands out with its large, fuzzy ears as she holds a direct gaze into the camera. The scene is beautifully illuminated by soft natural light, while a blurred foreground elegantly frames the majestic animal.';
const ONE_NODE_CHURCH = 'A black and white landscape photograph of a steepled church atop a rolling hill, rising from a dense, glowing sea of low-lying fog. Dark trees flank the structure. Behind it, layers of forested ridges recede into misty mountain peaks under an overcast sky. The scene features profound atmospheric depth, contrasting the bright, sweeping mist against the sharply silhouetted terrain.';

const GOLD = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'golden', 'prompts.json'), 'utf8')) as Record<string, { prompt: string; w: number; h: number }>;
const KEEP = ' Keep the composition, the people and all other details exactly as they are.';

// Qwen 2.1 sizes: Draft ≈ 1–1.2 MP, Native 2K from the official size table (multiples of 32)
const QWEN_DRAFT: Record<string, [number, number]> = { '1:1': [1024, 1024], '3:2': [1248, 832], '16:9': [1376, 768], '4:3': [1152, 864] };
const QWEN_2K: Record<string, [number, number]> = { '1:1': [2048, 2048], '3:2': [2528, 1696], '16:9': [2752, 1536], '4:3': [2400, 1792] };
// Klein review sizes: Darkroom's ~1 MP aspects and ~2 MP ones (multiples of 16)
const KLEIN_1MP: Record<string, [number, number]> = { '1:1': [1024, 1024], '3:2': [1248, 832], '16:9': [1344, 768], '4:5': [896, 1120] };
const KLEIN_2MP: Record<string, [number, number]> = { '1:1': [1408, 1408], '3:2': [1728, 1152], '16:9': [1920, 1088], '4:5': [1264, 1584] };
const KLEIN_REVIEW: [string, string, string][] = [
  ['fox', ONE_NODE_FOX, '1:1'],
  ['church', ONE_NODE_CHURCH, '16:9'],
  ['portrait', GOLD['01_portrait'].prompt, '4:5'],
  ['bakery-text', GOLD['03_text_scene'].prompt, '3:2'],
  ['busy-street', GOLD['04_busy_street'].prompt, '16:9'],
  ['fur', GOLD['06_fur'].prompt, '1:1'],
];
const QWEN_PROMPTS: [string, string, string][] = [
  ['bakery-text', GOLD['03_text_scene'].prompt, '3:2'],
  ['busy-street', GOLD['04_busy_street'].prompt, '16:9'],
  ['glass', GOLD['07_transparent'].prompt, '1:1'],
  ['interior', GOLD['10_interior'].prompt, '4:3'],
];

// Enhance (Phase 2). One Node's Enhance preset, verbatim (config.json discover_prompts > OTHER > Enhance),
// credited: github.com/yanokusnir-ai/one-node-flux-2-klein
const ONE_NODE_ENHANCE = 'Enhance the overall image quality by restoring fine details and sharpening the focus. Remove all types of blur, including motion and lens blur, while preserving the original features, textures, and likeness. Increase clarity and micro-contrast without introducing artifacts, ensuring a clean, high-definition result that stays true to the source.';
// Qwen adaptation (not a copy): names the edit target the official way (<image1>), lists the defects, and states
// what must survive, since Qwen follows explicit preservation lists closely.
const QWEN_ENHANCE = 'Enhance the overall quality of <image1>: restore fine detail and sharp focus, and remove motion blur, lens blur, noise and compression artefacts. Keep the composition, every face and its likeness, the colours, the lighting and every object exactly as they are, and add nothing new.';
// Toned-down Klein variant: One Node's restoration ask without "increase clarity and micro-contrast", which the first
// A/B round showed pushes clean pictures into HDR crunch and neon saturation; preservation stated as a list.
const KLEIN_ENHANCE_GENTLE = 'Restore this photograph: remove the blur, noise and compression artefacts and bring back fine, natural detail and sharp focus. Keep the same composition, the same person and likeness, the original colours, contrast and lighting, and the natural skin and fabric texture. Make it look like a clean, sharp original photograph, not a processed one.';
const T = JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', 'prompts.json'), 'utf8')) as PromptTemplates;
const firstSentence = (s: string) => s.split(/(?<=[.!?])\s/)[0].replace(/[.!?]$/, '');
const ENHANCE_CASES: Case[] = [
  // "current" pipeline pre-upscales this with SeedVR2 4x (planEnhance); the edit variants get the raw 320 px JPEG
  { key: 'lowres-320px', set: { seed: 51 }, images: { image_1: g('08_lowres') }, caption: firstSentence(GOLD['08_lowres_src'].prompt) },
  { key: 'lowres-after-seedvr2', set: { seed: 51 }, images: { image_1: g('08_lowres_seedvr2x4') }, caption: firstSentence(GOLD['08_lowres_src'].prompt) },
  { key: 'lens-blur', set: { seed: 52 }, images: { image_1: g('11_lens_blur') }, caption: firstSentence(GOLD['09_car'].prompt) },
  { key: 'motion-blur', set: { seed: 53 }, images: { image_1: g('12_motion_blur') }, caption: firstSentence(GOLD['01_portrait'].prompt) },
  { key: 'clean-portrait', set: { seed: 54 }, images: { image_1: g('01_portrait') }, caption: firstSentence(GOLD['01_portrait'].prompt) },
];
const currentInput = (c: Case) => (c.key === 'lowres-320px' ? { images: { image_1: g('08_lowres_seedvr2x4') } } : {});

// Inpaint (Phase 3). Masks come from SAM 3.1 text prompts on the golden pictures (generated once by `setup.p3`).
const MASKS: Record<string, [string, string]> = {
  teapot: ['10_interior', 'teapot'],
  car: ['09_car', 'car'],
  chalkboard: ['03_text_scene', 'chalkboard sign'],
  scarf: ['01_portrait', 'scarf'],
  taxi: ['04_busy_street', 'yellow car:1'], // "taxi" matched nothing on this picture; one yellow car = the same small target
};
const maskPath = (k: string) => path.join('tests', 'golden', 'masks', `${k}.png`);
const PLANS: Record<string, CropPlan> = {};
async function planFor(k: string): Promise<CropPlan> {
  if (PLANS[k]) return PLANS[k];
  const img = await sharp(path.join(ROOT, g(MASKS[k][0]))).metadata();
  const raw = await sharp(path.join(ROOT, maskPath(k))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bb = maskBBox(raw.data, raw.info.width, raw.info.height, 0, 127);
  if (!bb) throw new Error(`empty mask ${k}`);
  return (PLANS[k] = planCrop(bb, img.width!, img.height!));
}
const cropSet = (p: CropPlan) => ({ crop_x: p.crop.x, crop_y: p.crop.y, crop_w: p.crop.w, crop_h: p.crop.h, target_w: p.target.w, target_h: p.target.h });
interface InpaintCase extends Case { mask: string; fill: string; ref?: string; denoise?: number }
const INPAINT_CASES: InpaintCase[] = [
  { key: 'teapot-tulips', mask: 'teapot', fill: 'a small glass vase of yellow tulips', set: { seed: 61 } },
  { key: 'car-scooter', mask: 'car', fill: 'a vintage pale blue Vespa scooter parked at the kerb', set: { seed: 62 } },
  { key: 'chalkboard-text', mask: 'chalkboard', fill: 'a chalkboard sign that reads "Open 7 till 7" in white chalk', set: { seed: 63 } },
  { key: 'scarf-silk-100', mask: 'scarf', fill: 'a mustard yellow silk scarf', set: { seed: 64 } },
  { key: 'scarf-silk-60', mask: 'scarf', fill: 'a mustard yellow silk scarf', set: { seed: 64 }, denoise: 0.6 },
  { key: 'taxi-van-small', mask: 'taxi', fill: 'a red delivery van', set: { seed: 65 } },
  { key: 'teapot-ref-car', mask: 'teapot', fill: 'a small toy model of the red car from the reference picture', ref: '09_car', set: { seed: 66 } },
].map((c) => ({ ...c, images: { image_1: g(MASKS[c.mask][0]), mask: maskPath(c.mask), ...(c.ref ? { image_2: g(c.ref) } : {}) } }));

// Circle quick edit (Addendum 2 C): a red ellipse drawn round the mask's box stands in for the user's annotation.
// Built by `setup.p3c` into bench/annot (not committed).
const annotPath = (k: string) => path.join('bench', 'annot', `${k}.png`);
const ANNOT_CASES = INPAINT_CASES.filter((c) => !c.ref && !c.denoise).map((c) => ({ ...c, images: { image_1: annotPath(c.mask) } }));
const annotOrig = (c: Case) => g(MASKS[(c as InpaintCase).mask][0]);

// Outpaint (Phase 4). One Node's outpaint preset, verbatim (config.json autofill_prompts.outpaint), credited:
// github.com/yanokusnir-ai/one-node-flux-2-klein. Its "[briefly describe …]" slot is filled with the caption.
const ONE_NODE_OUTPAINT = 'Extend the composition of this image. Replace all black or empty spaces with a logical continuation of the background and foreground. Ensure the transition is invisible and the new elements perfectly match the perspective and color palette of the original image. Scene description: ';
const QWEN_OUTPAINT_MASKED = 'In <image1>, the area marked white in <image2> is empty canvas: fill it with a natural continuation of the scene, matching the perspective, lighting and colours so the transition is invisible. The picture shows ';
const QWEN_OUTPAINT_NATIVE = 'Extend <image1> to a larger frame: keep everything in the picture exactly as it is and continue the scene naturally beyond its edges. The picture shows ';
interface OutCase extends Case { src: string; pad: Pad }
const OUT_CASES: OutCase[] = [
  { key: 'car-right', src: '09_car', pad: { left: 0, top: 0, right: 384, bottom: 0 }, set: { seed: 71 } },
  { key: 'interior-sides', src: '10_interior', pad: { left: 256, top: 0, right: 256, bottom: 0 }, set: { seed: 72 } },
  { key: 'portrait-down', src: '01_portrait', pad: { left: 0, top: 0, right: 0, bottom: 320 }, set: { seed: 73 } },
  { key: 'harbour-sky', src: '08_lowres_src', pad: { left: 0, top: 256, right: 0, bottom: 0 }, set: { seed: 74 } },
  { key: 'large-2k-right', src: '13_large_2k', pad: { left: 0, top: 0, right: 512, bottom: 0 }, set: { seed: 75 } },
].map((c) => ({ ...c, caption: c.src === '13_large_2k' ? firstSentence(GOLD['03_text_scene'].prompt) : firstSentence(GOLD[c.src === '08_lowres_src' ? '08_lowres_src' : c.src].prompt) }));
const CANVAS: Record<string, { image: string; mask: string; w: number; h: number; pad: Pad; bbox: Box }> = {};
const canvasKey = (c: OutCase, step: number) => `${c.key}-s${step}`;
const lowerFirst = (s = '') => s.charAt(0).toLowerCase() + s.slice(1);
function outCrop(c: OutCase, step: number, whole: boolean) {
  const cv = CANVAS[canvasKey(c, step)];
  const p = planCrop(whole ? { x: 0, y: 0, w: cv.w, h: cv.h } : cv.bbox, cv.w, cv.h);
  return { images: { image_1: cv.image, mask: cv.mask }, set: { ...cropSet(p), denoise: 1, grow: 0, feather: 6 } };
}
const padSet = (p: Pad) => ({ pad_left: p.left, pad_top: p.top, pad_right: p.right, pad_bottom: p.bottom });

// Phase 5. The official Qwen-Image 2.1 background-removal wording (ComfyUI template image_qwen_image_2_1_background_removal).
const QWEN_REMOVE_BG = 'Remove the background, and output a PNG image';
const extract = (what: string) => `Extract ${what} from <image1> onto a transparent background, and output a PNG image`;

// Phase 6: every built-in preset on both models (fixed seeds). Source picture per category; slots filled for Text edit.
const EDIT_PRESETS = (JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', 'edit_presets.json'), 'utf8')) as { presets: { id: string; category: string; klein: string; qwen: string; images?: 2 }[] }).presets;
const presetSource: Record<string, string> = { Angles: '10_interior', Relight: '01_portrait', Styles: '09_car' };
const presetCases = (category: string): Case[] =>
  EDIT_PRESETS.filter((p) => p.category === category).map((p, i) => {
    const fill = (t: string) => t.replace('[OLD TEXT]', 'SUNRISE BAKERY').replace('[NEW TEXT]', 'MOONLIGHT BAKERY');
    const src = p.id === 'enhance' ? '11_lens_blur' : p.id === 'text-edit' ? '03_text_scene' : p.id === 'try-on' ? '01_portrait' : p.id === 'texture-transfer' ? '09_car' : presetSource[category];
    const ref = p.id === 'try-on' ? '16_outfit' : p.id === 'texture-transfer' ? '06_fur' : undefined;
    return { key: p.id, set: { seed: 500 + i, klein_prompt: fill(p.klein), qwen_prompt: fill(p.qwen) }, images: { image_1: g(src), ...(ref ? { image_2: g(ref) } : {}) } };
  });
const presetVariants: Variant[] = [
  { id: 'klein', label: 'Klein 9B (Klein wording)', workflow: 'klein_edit', build: (c) => ({ set: { prompt: String(c.set.klein_prompt), klein_prompt: '', qwen_prompt: '' } }) },
  { id: 'qwen', label: 'Qwen-Image 2.1 (Qwen wording)', workflow: 'qwen_edit', build: (c) => ({ set: { prompt: String(c.set.qwen_prompt), klein_prompt: '', qwen_prompt: '' } }) },
];

// Phase 7: the general VLM (captions, reverse prompts, Klein prompts). Same requests as production (buildVlm2Request on
// presets/vlm_prompts.json), only the model file differs. JP chose "A/B first" before any 19 GB download.
const VP = JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', 'vlm_prompts.json'), 'utf8')) as Vlm2Prompts;
const readPreset = (rel: string) => fs.readFileSync(path.join(ROOT, 'presets', rel), 'utf8');
function vlmCase(key: string, task: Vlm2Task, variant: string, text: string, image?: string): Case {
  const r = buildVlm2Request(VP, task, variant, text, readPreset);
  return { key, workflow: r.workflow, set: { ...(r.params as Record<string, string | number>) }, ...(image ? { images: { image_1: g(image) } } : {}) };
}
const VLM_CASES: Case[] = [
  ...['01_portrait', '03_text_scene', '04_busy_street'].flatMap((img) => ['short', 'detailed', 'klein'].map((v) => vlmCase(`caption-${v}-${img}`, 'caption', v, '', img))),
  ...['03_text_scene', '04_busy_street'].flatMap((img) => ['klein', 'qwen'].map((v) => vlmCase(`reverse-${v}-${img}`, 'reverse', v, '', img))),
  ...['a lighthouse in a storm', 'poster for a jazz night called "Blue Hour" on Friday', 'a cat wearing a tiny crown'].map((idea, i) => vlmCase(`klein-enhance-${i + 1}`, 'enhance', 'klein', idea)),
  vlmCase('klein-edit-night', 'edit_enhance', 'klein', 'make it night', '09_car'),
  vlmCase('klein-edit-sign', 'edit_enhance', 'klein', 'change the sign to MOONLIGHT BAKERY', '03_text_scene'),
];
const vlmVariant = (id: string, label: string, file: string): Variant => ({
  id, label, workflow: 'vlm2_image',
  set: { model: file },
});

const cacheVariants = (workflow: string): Variant[] =>
  (['default', 'int8', 'int4'] as const).map((dt) => ({ id: dt, label: `Prefix cache: ${dt}`, workflow, ...(dt === 'default' ? {} : { file: `experiments/${workflow}.cache_${dt}.json` }) }));

// The author's prompt, verbatim from the model page (typos included: the LoRA was trained on it).
const LORA_AUTHOR_PROMPT = 'restore the image quality, remove any compression artefacts, remove any haze and soft edges, enrich the original with new intricate detail in all textures and surfaces createing a professional photorealistic photograph with natral lighting and skin texture.';

const PHASES: Record<string, Group[]> = {
  // Full review (v3.3): Klein precision (fp8mixed vs the installed full bf16 model), Klein at 2 MP, Klein steps,
  // and a whole-picture VAE decode instead of tiles. Same seeds throughout.
  rv: [
    {
      id: 'klein-precision',
      variants: [
        { id: 'fp8mixed', label: 'Darkroom: klein-9b fp8mixed (9 GB)', workflow: 'klein_t2i' },
        { id: 'bf16', label: 'klein-9b full bf16 (18 GB)', workflow: 'klein_t2i', file: 'experiments/klein_t2i.bf16.json' },
      ],
      cases: KLEIN_REVIEW.map(([key, prompt, ar], i) => ({ key, set: { prompt, seed: 7000 + i, width: KLEIN_1MP[ar][0], height: KLEIN_1MP[ar][1] } })),
    },
    {
      id: 'klein-batch4',
      variants: [
        { id: 'fp8mixed', label: 'fp8mixed, batch of 4', workflow: 'klein_t2i', set: { batch: 4 } },
        { id: 'bf16', label: 'bf16, batch of 4', workflow: 'klein_t2i', file: 'experiments/klein_t2i.bf16.json', set: { batch: 4 } },
      ],
      cases: [{ key: 'fox-x4', set: { prompt: ONE_NODE_FOX, seed: 7100, width: 1024, height: 1024 } }],
    },
    {
      id: 'klein-2mp',
      variants: [
        { id: '1mp', label: 'Klein at ~1 MP (Darkroom)', workflow: 'klein_t2i' },
        { id: '2mp', label: 'Klein at ~2 MP', workflow: 'klein_t2i', build: (c) => ({ set: { width: KLEIN_2MP[c.key.split('@')[1].replace('x', ':')][0], height: KLEIN_2MP[c.key.split('@')[1].replace('x', ':')][1] } }) },
      ],
      cases: KLEIN_REVIEW.map(([key, prompt, ar], i) => ({ key: `${key}@${ar.replace(':', 'x')}`, set: { prompt, seed: 7000 + i, width: KLEIN_1MP[ar][0], height: KLEIN_1MP[ar][1] } })),
    },
    {
      id: 'klein-steps',
      variants: [
        { id: 's4', label: '4 steps (Darkroom)', workflow: 'klein_t2i', set: { steps: 4 } },
        { id: 's6', label: '6 steps', workflow: 'klein_t2i', set: { steps: 6 } },
      ],
      cases: KLEIN_REVIEW.map(([key, prompt, ar], i) => ({ key, set: { prompt, seed: 7000 + i, width: KLEIN_1MP[ar][0], height: KLEIN_1MP[ar][1] } })),
    },
    {
      id: 'edit-worksize',
      variants: [
        { id: 'klein-1mp', label: 'Klein edit, works at 1 MP (Darkroom)', workflow: 'klein_edit' },
        { id: 'klein-2mp', label: 'Klein edit, works at 2 MP', workflow: 'klein_edit', file: 'experiments/klein_edit.work2mp.json' },
        { id: 'qwen-1mp', label: 'Qwen edit, works at 1 MP (Darkroom)', workflow: 'qwen_edit' },
        { id: 'qwen-176', label: 'Qwen edit, works at 1.76 MP (native)', workflow: 'qwen_edit', file: 'experiments/qwen_edit.work176.json' },
      ],
      cases: [
        { key: 'large-relight', set: { prompt: 'Relight the scene with warm golden late-afternoon sunlight from the left, source out of frame.' + KEEP, seed: 91 }, images: { image_1: g('13_large_2k') } },
        { key: 'bakery-sign', set: { prompt: 'Change the sign text to "MOONLIGHT BAKERY".' + KEEP, seed: 92 }, images: { image_1: g('03_text_scene') } },
        { key: 'interior-season', set: { prompt: 'Make it a snowy winter evening outside the window, with warm lamp light inside.' + KEEP, seed: 93 }, images: { image_1: g('10_interior') } },
      ],
    },
    {
      id: 'qwen-decode-2k',
      variants: [
        { id: 'tiled', label: 'Tiled decode (Darkroom)', workflow: 'qwen_t2i', set: { steps: 40 } },
        { id: 'whole', label: 'Whole-picture decode', workflow: 'qwen_t2i', file: 'experiments/qwen_t2i.vaedecode.json', set: { steps: 40 } },
      ],
      cases: QWEN_PROMPTS.slice(0, 2).map(([key, prompt, ar], i) => ({ key, set: { prompt, seed: 4000 + i, width: QWEN_2K[ar][0], height: QWEN_2K[ar][1] } })),
    },
  ],
  // "Ultimate Upscaler Klein-9b" LoRA (civitai.com/models/2474084, Flux2-Klein-Image-RestoreV1.safetensors) against
  // Darkroom's Klein Restore. The LoRA graph is the shipped one plus LoraLoaderModelOnly (strength 1, as the author
  // recommends) between the model and the sampler. Same seeds, same 4 steps.
  lora: [
    {
      id: 'restore-lora',
      variants: [
        { id: 'current', label: 'Darkroom Restore today', workflow: 'klein_enhance_edit',
          build: (c) => ({ set: { prompt: composeImagePrompt(T, { model: 'klein', mode: 'enhance', text: '', caption: c.caption, strength: 'restore' }), megapixels: 1 } }) },
        { id: 'lora_dr', label: 'LoRA + Darkroom prompt', workflow: 'klein_enhance_edit', file: 'experiments/klein_enhance_edit.restore_lora.json',
          build: (c) => ({ set: { prompt: composeImagePrompt(T, { model: 'klein', mode: 'enhance', text: '', caption: c.caption, strength: 'restore' }), megapixels: 1 } }) },
        { id: 'lora_author', label: "LoRA + the author's prompt", workflow: 'klein_enhance_edit', file: 'experiments/klein_enhance_edit.restore_lora.json',
          build: () => ({ set: { prompt: LORA_AUTHOR_PROMPT, megapixels: 1 } }) },
      ],
      cases: ENHANCE_CASES,
    },
    {
      id: 'restore-lora-large',
      variants: [
        { id: 'current_2mp', label: 'Darkroom Restore today (2 MP, then SeedVR2 to full size)', workflow: 'klein_enhance_edit',
          build: (c) => ({ set: { prompt: composeImagePrompt(T, { model: 'klein', mode: 'enhance', text: '', caption: c.caption, strength: 'restore' }), megapixels: 2 } }) },
        { id: 'current_4mp', label: 'Darkroom Restore at 4 MP, no LoRA (fair baseline)', workflow: 'klein_enhance_edit',
          build: (c) => ({ set: { prompt: composeImagePrompt(T, { model: 'klein', mode: 'enhance', text: '', caption: c.caption, strength: 'restore' }), megapixels: 4 } }) },
        { id: 'lora_dr_4mp', label: 'LoRA + Darkroom prompt at 4 MP', workflow: 'klein_enhance_edit', file: 'experiments/klein_enhance_edit.restore_lora.json',
          build: (c) => ({ set: { prompt: composeImagePrompt(T, { model: 'klein', mode: 'enhance', text: '', caption: c.caption, strength: 'restore' }), megapixels: 4 } }) },
        { id: 'lora_author_4mp', label: "LoRA + author's prompt at 4 MP", workflow: 'klein_enhance_edit', file: 'experiments/klein_enhance_edit.restore_lora.json',
          build: () => ({ set: { prompt: LORA_AUTHOR_PROMPT, megapixels: 4 } }) },
      ],
      cases: [{ key: 'large-2528', set: { seed: 57 }, images: { image_1: g('13_large_2k') }, caption: firstSentence(GOLD['03_text_scene'].prompt) }],
    },
  ],
  // ComfyUI templates 0.11.73 embed the official Qwen-Image 2.1 prompt enhancers with their own sampling settings
  // (thinking on, max 4096, repetition 1.0, presence penalty 1.5 for T2I / 0 for I2I, I2I loader "qwen_image").
  // Same system prompts as Darkroom's (byte-identical); only the run settings differ.
  c381pe: [
    {
      id: 'qwen-pe-settings',
      variants: [
        { id: 'darkroom', label: 'Darkroom today (thinking off, 1024/1536 tokens, rep 1.05)', workflow: 'vlm2_text' },
        {
          id: 'official',
          label: 'Official template settings',
          workflow: 'vlm2_text',
          build: (c): { set: Record<string, string | number> } => ({
            set: c.workflow === 'vlm2_image'
              ? { thinking: 'true', max_tokens: 4096, repetition_penalty: 1, presence_penalty: 0, loader: 'qwen_image' }
              : { thinking: 'true', max_tokens: 4096, repetition_penalty: 1, presence_penalty: 1.5 },
          }),
        },
      ],
      cases: [
        ...['poster for a jazz night called "Blue Hour" on Friday', 'a lighthouse in a storm', 'a cat wearing a tiny crown', 'product photo of a ceramic mug, seen from above'].map((t, i) => vlmCase(`t2i-${i + 1}`, 'enhance', 'qwen', t)),
        vlmCase('i2i-night', 'edit_enhance', 'qwen', 'make it night', '09_car'),
        vlmCase('i2i-sign', 'edit_enhance', 'qwen', 'change the sign to MOONLIGHT BAKERY', '03_text_scene'),
        vlmCase('i2i-winter', 'edit_enhance', 'qwen', 'make it winter', '10_interior'),
        vlmCase('i2i-remove', 'edit_enhance', 'qwen', 'remove the car', '09_car'),
      ],
    },
  ],
  // ComfyUI 0.38.1 fixed the int8 / int4 Qwen-Image 2.1 prefix cache (#16667). Same seeds; only the cache precision
  // differs (experiments/<graph>.cache_<dtype>.json are copies of the shipped graphs with that one setting changed).
  c381: [
    {
      id: 'qwen-ref-native2k',
      variants: cacheVariants('qwen_ref'),
      cases: [
        { key: '2ref', set: { prompt: 'The woman from <image1> sits on the green velvet sofa in the room from <image2>, reading a book. Keep her face, hair and green scarf identical.', seed: 31, steps: 40, width: 2048, height: 2048 }, images: { image_1: g('01_portrait'), image_2: g('10_interior') } },
        { key: '3ref', set: { prompt: 'The woman from <image1> leans on the red car from <image2>, parked in the harbour from <image3> on an overcast afternoon. Keep her face and scarf identical.', seed: 31, steps: 40, width: 2048, height: 2048 }, images: { image_1: g('01_portrait'), image_2: g('09_car'), image_3: g('08_lowres_src') } },
      ],
    },
    {
      id: 'qwen-edit-2img',
      variants: cacheVariants('qwen_edit'),
      cases: [
        { key: 'try-on', set: { prompt: 'Dress the person in <image1> in the outfit from <image2>, with the same style, materials, textures and colours, fitted naturally to their body and lit like <image1>. Keep the face, identity, hair, expression, pose, background and framing of <image1> unchanged.', seed: 41 }, images: { image_1: g('01_portrait'), image_2: g('16_outfit') } },
        { key: 'text', set: { prompt: 'In <image1>, replace the text "SUNRISE BAKERY" with "MOONLIGHT BAKERY". Keep the same font, letter shapes, colour, effects, texture, position, size and alignment, and keep everything else unchanged.', seed: 42 }, images: { image_1: g('03_text_scene') } },
      ],
    },
  ],
  // Phase 7 follow-up: the Klein "Enhance instruction" rewrite turned "make it night" into warm light (relight rule bias).
  p7b: [
    {
      id: 'klein-edit-enhance',
      variants: [
        vlmVariant('qwen3vl8b', 'Qwen3-VL 8B, revised Klein edit prompt', 'qwen3vl_8b_int8_convrot.safetensors'),
        vlmVariant('pe_i2i', 'PE-I2I with the same Klein edit prompt', 'qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors'),
      ],
      cases: [
        vlmCase('night', 'edit_enhance', 'klein', 'make it night', '09_car'),
        vlmCase('sign', 'edit_enhance', 'klein', 'change the sign to MOONLIGHT BAKERY', '03_text_scene'),
        vlmCase('winter', 'edit_enhance', 'klein', 'make it winter', '10_interior'),
        vlmCase('remove-car', 'edit_enhance', 'klein', 'remove the car', '09_car'),
        vlmCase('cat-roof', 'edit_enhance', 'klein', 'add a cat sleeping on the car roof', '09_car'),
        vlmCase('side-light', 'edit_enhance', 'klein', 'light her from the side', '01_portrait'),
      ],
    },
  ],
  // Phase 6 follow-up: the Qwen style wording barely restyled some looks and texture transfer copied the reference's subject.
  p6b: [
    {
      id: 'qwen-style-wording',
      variants: [
        { id: 'current', label: 'Qwen: current wording', workflow: 'qwen_edit', build: (c) => ({ set: { prompt: String(c.set.qwen_prompt), qwen_prompt: '', strong: '' } }) },
        { id: 'strong', label: 'Qwen: transform every surface, short keep clause', workflow: 'qwen_edit', build: (c) => ({ set: { prompt: String(c.set.strong), qwen_prompt: '', strong: '' } }) },
      ],
      cases: presetCases('Styles').filter((c) => ['style-3d-render', 'style-embroidery', 'style-low-poly', 'style-claymation', 'style-16-bit-pixel', 'style-natgeo'].includes(c.key)).map((c) => {
        const look = String(c.set.qwen_prompt).replace(/^Restyle <image1> as /, '').replace(/. Keep .*$/, '');
        return { ...c, set: { seed: c.set.seed, qwen_prompt: c.set.qwen_prompt, strong: `Transform <image1> completely into ${look}, re-rendering every surface, object and the background in that style. Keep only the composition and the layout.` } };
      }).concat(presetCases('Other').filter((c) => c.key === 'texture-transfer').map((c) => ({ ...c, set: { seed: c.set.seed, qwen_prompt: c.set.qwen_prompt, strong: 'Cover the subject of <image1> in the material and surface texture shown in <image2>, following its contours and the lighting of <image1>. Use only the material of <image2>; do not add any object or animal from <image2>. Keep the shape and the background of <image1> unchanged.' } }))),
    },
  ],
  p3c: [
    {
      id: 'circle-edit',
      variants: [
        { id: 'klein-annot', label: 'Klein edit on the annotated picture', workflow: 'klein_edit',
          build: (c) => ({ set: { prompt: `Replace the object circled in red with ${(c as InpaintCase).fill}. Remove the red circle completely and keep everything else exactly the same.` } }) },
        { id: 'qwen-annot', label: 'Qwen edit on the annotated picture', workflow: 'qwen_edit',
          build: (c) => ({ set: { prompt: `In <image1>, replace the object circled in red with ${(c as InpaintCase).fill}. Remove the red circle completely and keep everything else exactly the same.` } }) },
        { id: 'qwen-guide', label: 'Qwen: clean picture + annotated copy as <image2>', workflow: 'qwen_edit',
          build: (c) => ({ images: { image_1: annotOrig(c), image_2: annotPath((c as InpaintCase).mask) }, set: { prompt: `<image2> is a copy of <image1> with a red circle drawn on it. In <image1>, replace the object that is circled in red in <image2> with ${(c as InpaintCase).fill}. Keep everything else in <image1> exactly the same.` } }) },
        { id: 'klein-guide', label: 'Klein: clean picture + annotated copy as image 2', workflow: 'klein_edit',
          build: (c) => ({ images: { image_1: annotOrig(c), image_2: annotPath((c as InpaintCase).mask) }, set: { prompt: `Image 2 is a copy of image 1 with a red circle drawn on it. In image 1, replace the object that is circled in red in image 2 with ${(c as InpaintCase).fill}. Keep everything else in image 1 exactly the same.` } }) },
      ],
      cases: ANNOT_CASES,
    },
  ],
  p7: [
    {
      id: 'vlm-general',
      variants: [
        vlmVariant('qwen3vl8b', 'Qwen3-VL 8B int8 (current, 9.4 GB)', 'qwen3vl_8b_int8_convrot.safetensors'),
        vlmVariant('pe_i2i', 'Qwen3.5-VL 9B PE-I2I as a general VLM (int8, 9.5 GB)', 'qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors'),
        vlmVariant('qwen35_4b', 'Qwen3.5 4B bf16 (9.3 GB)', 'qwen3.5_4b_bf16.safetensors'),
      ],
      cases: VLM_CASES,
    },
  ],
  p6:['Angles', 'Relight', 'Styles', 'Other'].map((cat) => ({ id: `presets-${cat.toLowerCase()}`, variants: presetVariants, cases: presetCases(cat) })),
  p5: [
    {
      id: 'upscale-colour',
      variants: [
        { id: 'lab', label: 'SeedVR2 4x, LAB colour match (Darkroom v2)', workflow: 'upscale', set: { scale: 4, colour: 'lab' } },
        { id: 'wavelet', label: 'SeedVR2 4x, wavelet colour match (One Node)', workflow: 'upscale', set: { scale: 4, colour: 'wavelet' } },
      ],
      cases: [
        { key: 'lowres-320px', set: { seed: 1 }, images: { image_1: g('08_lowres') } },
        { key: 'pixelated', set: { seed: 1 }, images: { image_1: g('15_pixelated') } },
        { key: 'rgba-hair', set: { seed: 1 }, images: { image_1: g('14_rgba_hair') } },
      ],
    },
    {
      id: 'upscale-scale',
      variants: [
        { id: 'x2', label: '2x', workflow: 'upscale', set: { scale: 2 } },
        { id: 'x4', label: '4x', workflow: 'upscale', set: { scale: 4 } },
        { id: 'x6', label: '6x', workflow: 'upscale', set: { scale: 6 } },
        { id: 'x8', label: '8x (tile 512)', workflow: 'upscale', set: { scale: 8 } },
        { id: 'x8t256', label: '8x, tile 256', workflow: 'upscale', set: { scale: 8, tile: 256, tile_overlap: 64 } },
        { id: 'x8t1024', label: '8x, tile 1024', workflow: 'upscale', set: { scale: 8, tile: 1024, tile_overlap: 256 } },
      ],
      cases: [{ key: 'lowres-320px', set: { seed: 1, colour: 'lab' }, images: { image_1: g('08_lowres') } }],
    },
    {
      id: 'upscale-preshrink',
      variants: [
        { id: 'direct', label: 'Pixelated 384 px, 4x directly', workflow: 'upscale', set: { scale: 4 } },
        { id: 'shrink192', label: 'Scale by longer side to 192 px first, then 8x (One Node option)', workflow: 'upscale', set: { scale: 8, preshrink: 192 } },
      ],
      cases: [{ key: 'pixelated', set: { seed: 1, colour: 'lab' }, images: { image_1: g('15_pixelated') } }],
    },
    {
      id: 'remove-bg',
      variants: [
        { id: 'qwen', label: 'Qwen-Image 2.1 native extraction (official wording)', workflow: 'qwen_enhance_edit', set: { prompt: QWEN_REMOVE_BG, steps: 25, megapixels: 1 } },
        { id: 'sam_lucida', label: 'SAM 3.1 + Lucida matte (Darkroom v2)', workflow: 'remove_bg', build: (c) => ({ set: { subject: c.caption ?? '', matte: 'lucida.safetensors' } }) },
        { id: 'sam_birefnet', label: 'SAM 3.1 + BiRefNet matte', workflow: 'remove_bg', build: (c) => ({ set: { subject: c.caption ?? '', matte: 'birefnet.safetensors' } }) },
        { id: 'birefnet', label: 'BiRefNet only (one click)', workflow: 'remove_bg_v1' },
      ],
      cases: [
        { key: 'hair', set: { seed: 91 }, images: { image_1: g('05_hair') }, caption: 'woman' },
        { key: 'fur', set: { seed: 92 }, images: { image_1: g('06_fur') }, caption: 'cat' },
        { key: 'glass', set: { seed: 93 }, images: { image_1: g('07_transparent') }, caption: 'carafe, glass' },
        { key: 'product', set: { seed: 94 }, images: { image_1: g('02_product') }, caption: 'boots' },
      ],
    },
    {
      id: 'layers-qwen21',
      variants: [{ id: 'qwen21', label: 'Qwen-Image 2.1: one extraction per layer', workflow: 'qwen_enhance_edit', set: { steps: 25, megapixels: 1 } }],
      cases: [
        { key: 'car', set: { seed: 95, prompt: extract('the red car') }, images: { image_1: g('09_car') } },
        { key: 'palm', set: { seed: 95, prompt: extract('the potted palm') }, images: { image_1: g('09_car') } },
        { key: 'background', set: { seed: 95, prompt: 'Remove the red car and the potted palm from <image1> and fill in the wall, the pavement and the road behind them naturally. Keep everything else exactly as it is.' }, images: { image_1: g('09_car') } },
      ],
    },
    {
      id: 'layers-layered',
      variants: [{ id: 'layered', label: 'Qwen-Image-Layered, 4 layers (captioned)', workflow: 'qwen_layered', set: { layers: 4, seed: 5 } }],
      cases: [{ key: 'car-scene', set: { prompt: GOLD['09_car'].prompt }, images: { image_1: g('09_car') } }],
    },
  ],
  p4: [
    {
      id: 'outpaint-klein',
      variants: [
        { id: 'current', label: 'Darkroom v2: pad in the graph, whole canvas at 1 MP', workflow: 'outpaint',
          build: (c) => { const oc = c as OutCase; return { images: { image_1: g(oc.src) }, set: { ...padSet(oc.pad), prompt: composeImagePrompt(T, { model: 'klein', mode: 'outpaint', text: '', caption: oc.caption }) } }; } },
        { id: 'full', label: 'One Node prep + whole canvas (crop and stitch)', workflow: 'klein_inpaint_cs',
          build: (c) => { const oc = c as OutCase; const b = outCrop(oc, 8, true); return { images: b.images, set: { ...b.set, prompt: ONE_NODE_OUTPAINT + oc.caption } }; } },
        { id: 'extend', label: 'One Node prep + new strip and context only', workflow: 'klein_inpaint_cs',
          build: (c) => { const oc = c as OutCase; const b = outCrop(oc, 8, false); return { images: b.images, set: { ...b.set, prompt: ONE_NODE_OUTPAINT + oc.caption } }; } },
      ],
      cases: OUT_CASES,
    },
    {
      id: 'outpaint-qwen',
      variants: [
        { id: 'current', label: 'Darkroom v2: model sees the original, samples the padded canvas', workflow: 'qwen_outpaint',
          build: (c) => { const oc = c as OutCase; return { images: { image_1: g(oc.src) }, set: { ...padSet(oc.pad), prompt: composeImagePrompt(T, { model: 'qwen', mode: 'outpaint', text: '', caption: oc.caption }) } }; } },
        { id: 'full', label: 'Shared prep + mask as <image2>, whole canvas', workflow: 'qwen_inpaint_cs',
          build: (c) => { const oc = c as OutCase; const b = outCrop(oc, 32, true); return { images: b.images, set: { ...b.set, prompt: QWEN_OUTPAINT_MASKED + lowerFirst(oc.caption) + '.' } }; } },
        { id: 'extend', label: 'Shared prep + mask as <image2>, new strip and context only', workflow: 'qwen_inpaint_cs',
          build: (c) => { const oc = c as OutCase; const b = outCrop(oc, 32, false); return { images: b.images, set: { ...b.set, prompt: QWEN_OUTPAINT_MASKED + lowerFirst(oc.caption) + '.' } }; } },
        { id: 'native', label: 'Native aspect change: Qwen extends the frame itself', workflow: 'qwen_outpaint_native',
          build: (c) => { const oc = c as OutCase; const cv = CANVAS[canvasKey(oc, 32)]; return { images: { image_1: g(oc.src) }, set: { width: cv.w, height: cv.h, prompt: QWEN_OUTPAINT_NATIVE + lowerFirst(oc.caption) + '.' } }; } },
      ],
      cases: OUT_CASES,
    },
  ],
  p3: [
    {
      id: 'inpaint-klein',
      variants: [
        { id: 'current', label: 'Darkroom v2: whole picture at 1 MP + composite', workflow: 'inpaint',
          build: (c) => { const ic = c as InpaintCase; return { set: { prompt: composeImagePrompt(T, { model: 'klein', mode: 'inpaint', text: ic.fill }) } }; } },
        { id: 'cropstitch', label: 'Crop and stitch (core nodes, One Node rules)', workflow: 'klein_inpaint_cs',
          build: (c) => { const ic = c as InpaintCase; return { set: { prompt: composeImagePrompt(T, { model: 'klein', mode: 'inpaint', text: ic.fill }), denoise: ic.denoise ?? 1, ...cropSet(PLANS[ic.mask]) } }; } },
      ],
      cases: INPAINT_CASES,
    },
    {
      id: 'inpaint-qwen',
      variants: [
        { id: 'current', label: 'Darkroom v2: whole picture + composite', workflow: 'qwen_inpaint',
          build: (c) => { const ic = c as InpaintCase; return { set: { prompt: composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: ic.fill }) } }; } },
        { id: 'native', label: 'Crop and stitch, native (crop = <image1>)', workflow: 'qwen_inpaint_cs',
          build: (c) => { const ic = c as InpaintCase; return { set: { prompt: composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: ic.fill.replace('the reference picture', '<image2>') }), denoise: ic.denoise ?? 1, ...cropSet(PLANS[ic.mask]) } }; } },
        { id: 'maskref', label: 'Native + mask shown as <image2>', workflow: 'qwen_inpaint_cs', file: 'experiments/qwen_inpaint_cs.maskref.json',
          build: (c) => { const ic = c as InpaintCase; return { set: { prompt: `In <image1>, replace the area marked white in <image2> with ${ic.fill.replace('the reference picture', '<image3>')}. Keep everything outside that area unchanged.`, denoise: ic.denoise ?? 1, ...cropSet(PLANS[ic.mask]) } }; } },
        { id: 'controlnet', label: 'Fun ControlNet Union, inpaint mode', workflow: 'qwen_inpaint_cs', file: 'experiments/qwen_inpaint_cs.controlnet.json',
          build: (c) => { const ic = c as InpaintCase; return { set: { prompt: composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: ic.fill.replace('the reference picture', '<image1>') }), denoise: ic.denoise ?? 1, ...cropSet(PLANS[ic.mask]) } }; } },
      ],
      cases: INPAINT_CASES,
    },
  ],
  p2: [
    {
      id: 'enhance-klein',
      variants: [
        { id: 'current', label: 'Darkroom v2: img2img, denoise 0.3 (+ SeedVR2 first if small)', workflow: 'klein_enhance',
          build: (c) => ({ ...currentInput(c), set: { prompt: composeImagePrompt(T, { model: 'klein', mode: 'enhance', text: '', caption: c.caption, strength: 'subtle' }), denoise: 0.3, schedule_steps: 13, megapixels: 1 } }) },
        { id: 'edit', label: 'Edit-style: ReferenceLatent + empty latent, One Node prompt', workflow: 'klein_enhance_edit',
          build: () => ({ set: { prompt: ONE_NODE_ENHANCE, megapixels: 1 } }) },
        { id: 'edit_scene', label: 'Edit-style + "Scene:" caption line', workflow: 'klein_enhance_edit',
          build: (c) => ({ set: { prompt: `${ONE_NODE_ENHANCE} Scene: ${c.caption}.`, megapixels: 1 } }) },
        { id: 'edit_gentle', label: 'Edit-style, toned-down prompt + scene line (round 2)', workflow: 'klein_enhance_edit',
          build: (c) => ({ set: { prompt: `${KLEIN_ENHANCE_GENTLE} Scene: ${c.caption}.`, megapixels: 1 } }) },
      ],
      cases: ENHANCE_CASES,
    },
    {
      id: 'enhance-qwen',
      variants: [
        { id: 'current', label: 'Darkroom v2: img2img, denoise 0.35 (+ SeedVR2 first if small)', workflow: 'qwen_enhance',
          build: (c) => ({ ...currentInput(c), set: { prompt: composeImagePrompt(T, { model: 'qwen', mode: 'enhance', text: '', caption: c.caption, strength: 'subtle' }), denoise: 0.35, steps: 25, megapixels: 1 } }) },
        { id: 'edit', label: 'Edit-style: image_1 + empty latent, Qwen restore prompt', workflow: 'qwen_enhance_edit',
          build: () => ({ set: { prompt: QWEN_ENHANCE, steps: 25, megapixels: 1 } }) },
        { id: 'edit_scene', label: 'Edit-style + "The picture shows ..." line', workflow: 'qwen_enhance_edit',
          build: (c) => ({ set: { prompt: `${QWEN_ENHANCE} The picture shows ${(c.caption ?? '').charAt(0).toLowerCase()}${(c.caption ?? '').slice(1)}.`, steps: 25, megapixels: 1 } }) },
      ],
      cases: ENHANCE_CASES,
    },
  ],
  p1: [
    {
      id: 'klein-t2i-sampler',
      variants: [
        { id: 'flux2', label: 'Darkroom: Flux2Scheduler + euler', workflow: 'klein_t2i' },
        { id: 'onenode', label: 'One Node: AuraFlow shift 3 + er_sde/simple', workflow: 'klein_t2i', file: 'experiments/klein_t2i.onenode.json' },
      ],
      cases: [
        ...['01_portrait', '02_product', '05_hair', '06_fur', '08_lowres_src', '09_car'].map((id, i) => ({
          key: id, set: { prompt: GOLD[id].prompt, seed: 3000 + i, width: GOLD[id].w, height: GOLD[id].h },
        })),
        { key: 'onenode-fox', set: { prompt: ONE_NODE_FOX, seed: 3010, width: 1024, height: 1024 } },
        { key: 'onenode-church', set: { prompt: ONE_NODE_CHURCH, seed: 3011, width: 1344, height: 768 } },
      ],
    },
    {
      id: 'klein-edit-sampler',
      variants: [
        { id: 'flux2', label: 'Darkroom: Flux2Scheduler + euler', workflow: 'klein_edit' },
        { id: 'onenode', label: 'One Node: AuraFlow shift 3 + er_sde/simple', workflow: 'klein_edit', file: 'experiments/klein_edit.onenode.json' },
      ],
      cases: [
        { key: 'scarf-red', set: { prompt: 'Change the scarf to a deep red wool scarf.' + KEEP, seed: 11 }, images: { image_1: g('01_portrait') } },
        { key: 'sign-text', set: { prompt: 'Change the sign text to "MOONLIGHT BAKERY".' + KEEP, seed: 11 }, images: { image_1: g('03_text_scene') } },
        // relight wording follows the Addendum 1 F rules: direction + "source out of frame"
        { key: 'relight-amber', set: { prompt: 'Relight the scene with warm amber late-afternoon light from the right side, source out of frame. Keep the car, the house and the composition identical.', seed: 11 }, images: { image_1: g('09_car') } },
        { key: 'style-oil', set: { prompt: 'Change the style to a classical oil painting with thick impasto brushstrokes and rich canvas texture. Keep the cat, its pose and the window identical.', seed: 11 }, images: { image_1: g('06_fur') } },
      ],
    },
    {
      id: 'klein-kv',
      variants: [
        { id: 'fp8', label: 'Darkroom: klein-9b fp8mixed', workflow: 'klein_ref' },
        { id: 'kv', label: 'klein-9b-kv bf16 + FluxKVCache', workflow: 'klein_ref', file: 'experiments/klein_ref.kv.json' },
      ],
      cases: [
        { key: 'texture-2ref', set: { prompt: 'Using image 1 as the subject and geometry reference and image 2 as the texture reference, replace the paint of the car in image 1 with the long grey fur of the cat in image 2. Keep the car shape, the house and the lighting from image 1 identical.', seed: 21, width: 1344, height: 768 }, images: { image_1: g('09_car'), image_2: g('06_fur') } },
        { key: 'room-2ref', set: { prompt: 'Using image 1 as the person reference and image 2 as the room reference, show the woman from image 1 sitting on the green velvet sofa in the room from image 2, reading a book in warm evening light. Keep her face, hair and green scarf identical to image 1.', seed: 21, width: 1024, height: 1024 }, images: { image_1: g('01_portrait'), image_2: g('10_interior') } },
        { key: 'scene-3ref', set: { prompt: 'Using image 1 as the person, image 2 as the car and image 3 as the location, show the woman from image 1 leaning on the red car from image 2, parked in the harbour from image 3 on an overcast afternoon. Keep her face and scarf identical to image 1 and the car identical to image 2.', seed: 21, width: 1344, height: 768 }, images: { image_1: g('01_portrait'), image_2: g('09_car'), image_3: g('08_lowres_src') } },
      ],
    },
    {
      id: 'qwen-steps-draft',
      variants: [
        { id: 's25', label: '25 steps (ComfyUI template, Darkroom)', workflow: 'qwen_t2i', set: { steps: 25 } },
        { id: 's40', label: '40 steps (official pipeline)', workflow: 'qwen_t2i', set: { steps: 40 } },
      ],
      cases: [
        ...QWEN_PROMPTS.map(([key, prompt, ar], i) => ({ key, set: { prompt, seed: 4000 + i, width: QWEN_DRAFT[ar][0], height: QWEN_DRAFT[ar][1] } })),
        { key: 'onenode-fox', set: { prompt: ONE_NODE_FOX, seed: 4010, width: 1024, height: 1024 } },
        { key: 'onenode-church', set: { prompt: ONE_NODE_CHURCH, seed: 4011, width: 1376, height: 768 } },
      ],
    },
    {
      id: 'qwen-native-2k',
      variants: [
        { id: 's25', label: 'Native 2K, 25 steps', workflow: 'qwen_t2i', set: { steps: 25 } },
        { id: 's40', label: 'Native 2K, 40 steps', workflow: 'qwen_t2i', set: { steps: 40 } },
      ],
      cases: QWEN_PROMPTS.map(([key, prompt, ar], i) => ({ key, set: { prompt, seed: 4000 + i, width: QWEN_2K[ar][0], height: QWEN_2K[ar][1] } })),
    },
    {
      id: 'qwen-refs-vram',
      variants: [
        { id: 'draft', label: 'Draft 1 MP', workflow: 'qwen_ref', set: { width: 1024, height: 1024 } },
        { id: 'native2k', label: 'Native 2K', workflow: 'qwen_ref', set: { width: 2048, height: 2048 } },
      ],
      cases: [
        { key: '1ref', set: { prompt: 'The woman from <image1> sits in a sunlit café, holding a cup of coffee. Keep her face, hair and green scarf identical.', seed: 31, steps: 25 }, images: { image_1: g('01_portrait') } },
        { key: '2ref', set: { prompt: 'The woman from <image1> sits on the green velvet sofa in the room from <image2>, reading a book. Keep her face, hair and green scarf identical.', seed: 31, steps: 25 }, images: { image_1: g('01_portrait'), image_2: g('10_interior') } },
        { key: '3ref', set: { prompt: 'The woman from <image1> leans on the red car from <image2>, parked in the harbour from <image3> on an overcast afternoon. Keep her face and scarf identical.', seed: 31, steps: 25 }, images: { image_1: g('01_portrait'), image_2: g('09_car'), image_3: g('08_lowres_src') } },
      ],
    },
  ],
};

function run(v: Variant, c: Case, out: string, free: boolean) {
  const b = v.build?.(c) ?? {};
  const set = { ...c.set, ...(v.set ?? {}), ...(b.set ?? {}) };
  const images = { ...(c.images ?? {}), ...(b.images ?? {}) };
  const args = [TSX, 'scripts/run-workflow.ts', c.workflow ?? v.workflow, '--out', out, '--label', `addenda ${path.basename(out)}`];
  if (v.file) args.push('--file', v.file);
  if (free) args.push('--free');
  for (const [k, val] of Object.entries(set)) if (val !== '') args.push('--set', `${k}=${val}`); // '' = helper key blanked by a variant
  for (const [k, val] of Object.entries(images)) args.push('--image', `${k}=${val}`);
  fs.rmSync(out, { recursive: true, force: true });
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 25 * 60 * 1000 });
  const js = (r.stdout ?? '').slice((r.stdout ?? '').lastIndexOf('\n{'));
  let p: any = {};
  try {
    p = JSON.parse(js);
  } catch {
    /* failed */
  }
  return { ok: r.status === 0, seconds: p.seconds, peak: p.peakVramGB, file: (p.files ?? [])[0] as string | undefined, error: r.status === 0 ? undefined : String(p.error ?? r.stderr ?? r.stdout).slice(-500), set };
}

/** Per-phase preparation before any run. */
const SETUP: Record<string, () => Promise<void>> = {
  p6: async () => {
    const outfit = path.join(ROOT, g('16_outfit'));
    if (fs.existsSync(outfit)) return;
    const r = run(
      { id: 'outfit', label: 'outfit', workflow: 'klein_t2i' },
      { key: 'outfit', set: { prompt: 'A mustard yellow double-breasted wool coat with large horn buttons, laid flat on a plain white background, clean product photograph.', seed: 600, width: 1024, height: 1024 } },
      path.join(ROOT, 'bench', 'golden', '16_outfit'),
      true,
    );
    if (!r.ok || !r.file) throw new Error(`outfit: ${r.error}`);
    fs.copyFileSync(r.file, outfit);
    console.log('golden 16_outfit');
  },
  p4: async () => {
    const dir = path.join(ROOT, 'tests', 'golden', 'outpaint');
    fs.mkdirSync(dir, { recursive: true });
    // the "large picture" case: a 2528x1696 Qwen Native 2K render from Phase 1
    const big = path.join(ROOT, g('13_large_2k'));
    if (!fs.existsSync(big)) {
      const p1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'qa', 'addenda', 'p1', 'runs.json'), 'utf8')) as Row[];
      const r = p1.find((x) => x.group === 'qwen-native-2k' && x.key === 'bakery-text' && x.variant === 's40');
      if (!r?.file_out) throw new Error('Phase 1 2K render not found');
      fs.copyFileSync(path.join(ROOT, r.file_out), big);
    }
    for (const c of OUT_CASES) {
      for (const step of [8, 32]) {
        const k = canvasKey(c, step);
        const cv = await buildOutpaintCanvas(fs.readFileSync(path.join(ROOT, g(c.src))), c.pad, { step });
        const image = path.join('tests', 'golden', 'outpaint', `${k}.png`);
        const mask = path.join('tests', 'golden', 'outpaint', `${k}-mask.png`);
        fs.writeFileSync(path.join(ROOT, image), cv.image);
        fs.writeFileSync(path.join(ROOT, mask), cv.mask);
        const raw = await sharp(cv.mask).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const bbox = maskBBox(raw.data, raw.info.width, raw.info.height, 0, 16)!;
        CANVAS[k] = { image, mask, w: cv.width, h: cv.height, pad: cv.pad, bbox };
        console.log('canvas', k, cv.width, cv.height, 'feather', cv.feather, 'bbox', JSON.stringify(bbox));
      }
    }
  },
  p3c: async () => {
    fs.mkdirSync(path.join(ROOT, 'bench', 'annot'), { recursive: true });
    for (const k of new Set(ANNOT_CASES.map((c) => c.mask))) {
      const src = path.join(ROOT, g(MASKS[k][0]));
      const meta = await sharp(src).metadata();
      const raw = await sharp(path.join(ROOT, maskPath(k))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const b = maskBBox(raw.data, raw.info.width, raw.info.height, 0, 127)!;
      const sw = Math.max(5, Math.round(Math.min(meta.width!, meta.height!) / 150));
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2, rx = b.w * 0.62 + sw, ry = b.h * 0.62 + sw;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}"><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#ff1a1a" stroke-width="${sw}"/></svg>`;
      await sharp(src).composite([{ input: Buffer.from(svg) }]).png().toFile(path.join(ROOT, annotPath(k)));
      console.log('annot', k, JSON.stringify(b));
    }
  },
  p3: async () => {
    fs.mkdirSync(path.join(ROOT, 'tests', 'golden', 'masks'), { recursive: true });
    for (const [k, [img, text]] of Object.entries(MASKS)) {
      const dest = path.join(ROOT, maskPath(k));
      if (!fs.existsSync(dest)) {
        const out = path.join(ROOT, 'bench', 'masks', k);
        const r = run({ id: 'sam', label: 'SAM', workflow: 'sam_segment' }, { key: k, set: { text }, images: { image_1: g(img) } }, out, false);
        if (!r.ok || !r.file) throw new Error(`mask ${k}: ${r.error}`);
        fs.copyFileSync(r.file, dest);
        console.log('mask', k, text);
      }
      const p = await planFor(k);
      console.log('plan', k, JSON.stringify(p));
    }
  },
};

/** Chained test (not a grid of independent cases): each outpaint round extends the previous round's result. */
async function outpaintRounds(model: 'klein' | 'qwen', workflow: string) {
  const dir = path.join(ROOT, 'docs', 'qa', 'addenda', 'p4r');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'runs.json');
  const rows: Row[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  let src = path.join(ROOT, g('09_car'));
  const caption = firstSentence(GOLD['09_car'].prompt);
  for (let round = 1; round <= 3; round++) {
    // each model through the route that won its Phase 4 A/B: Klein = black-canvas prep + crop-and-stitch graph,
    // Qwen = its v2 graph (pads internally, sees the original)
    const cv = await buildOutpaintCanvas(fs.readFileSync(src), { left: 0, top: 0, right: 256, bottom: 0 }, { step: model === 'qwen' ? 32 : 8 });
    let c: Case;
    if (model === 'qwen') {
      const meta = await sharp(src).metadata();
      const rel = path.relative(ROOT, src);
      c = { key: `round${round}`, set: { prompt: composeImagePrompt(T, { model, mode: 'outpaint', text: '', caption }), seed: 80 + round, ...padSet(snapPad(meta.width!, meta.height!, { left: 0, top: 0, right: 256, bottom: 0 }, 32)) }, images: { image_1: rel } };
    } else {
      fs.mkdirSync(path.join(dir, 'canvas'), { recursive: true });
      const image = path.join(dir, 'canvas', `${model}-round${round}.png`);
      const mask = path.join(dir, 'canvas', `${model}-round${round}-mask.png`);
      fs.writeFileSync(image, cv.image);
      fs.writeFileSync(mask, cv.mask);
      const p = planCrop({ x: 0, y: 0, w: cv.width, h: cv.height }, cv.width, cv.height);
      const prompt = composeImagePrompt(T, { model, mode: 'outpaint', text: '', caption, canvas: true });
      c = { key: `round${round}`, set: { prompt, seed: 80 + round, ...cropSet(p), denoise: 1, grow: 0, feather: 6 }, images: { image_1: path.relative(ROOT, image), mask: path.relative(ROOT, mask) } };
    }
    const r = run({ id: model, label: model, workflow }, c, path.join(dir, `${model}-round${round}`), round === 1);
    const row: Row = { group: 'outpaint-3rounds', key: `round${round}`, variant: model, ok: r.ok, seconds: r.seconds, peak: r.peak, error: r.error, set: { width: cv.width, height: cv.height }, file_out: r.file ? path.relative(ROOT, r.file) : undefined };
    const i = rows.findIndex((x) => x.key === row.key && x.variant === model);
    if (i >= 0) rows[i] = row;
    else rows.push(row);
    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
    console.log(r.ok ? 'ok  ' : 'FAIL', model, `round ${round}`, `${cv.width}x${cv.height}`, r.seconds ? `${r.seconds}s` : '', r.ok ? '' : r.error);
    if (!r.ok || !r.file) break;
    src = r.file;
  }
  fs.writeFileSync(path.join(dir, 'variants.json'), JSON.stringify({ 'outpaint-3rounds': [{ id: 'klein', label: 'Klein 9B, 3 rounds of +256 px' }, { id: 'qwen', label: 'Qwen-Image 2.1, 3 rounds of +256 px' }] }, null, 2));
}

const [phase, only] = process.argv.slice(2);
if (phase === 'p4r') {
  // usage: ab-addenda.ts p4r <klein-workflow> <qwen-workflow>
  await outpaintRounds('klein', only ?? 'klein_inpaint_cs');
  await outpaintRounds('qwen', process.argv[4] ?? 'qwen_inpaint_cs');
  process.exit(0);
}
const groups = PHASES[phase];
await SETUP[phase]?.();
if (!groups) throw new Error(`usage: ab-addenda.ts <${Object.keys(PHASES).join('|')}> [group-prefix]`);
const dir = path.join(ROOT, 'docs', 'qa', 'addenda', phase);
const file = path.join(dir, 'runs.json');
fs.mkdirSync(dir, { recursive: true });
const rows: Row[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
const meta = Object.fromEntries(groups.map((gr) => [gr.id, gr.variants.map((v) => ({ id: v.id, label: v.label }))]));
fs.writeFileSync(path.join(dir, 'variants.json'), JSON.stringify(meta, null, 2));

for (const gr of groups) {
  if (only && !gr.id.startsWith(only)) continue;
  // variant-major order: each model/graph loads once, and its first case carries the load time (noted as "cold")
  for (const v of gr.variants) {
    let first = true;
    for (const c of gr.cases) {
      if (rows.some((r) => r.group === gr.id && r.key === c.key && r.variant === v.id && r.ok)) continue;
      const out = path.join(dir, gr.id, `${c.key}-${v.id}`);
      const r = run(v, c, out, first);
      const txt = path.join(out, 'output.txt');
      const row: Row = { group: gr.id, key: c.key, variant: v.id, ok: r.ok, seconds: r.seconds, peak: r.peak, error: r.error, set: r.set, file_out: r.file ? path.relative(ROOT, r.file) : undefined, ...(fs.existsSync(txt) ? { text: fs.readFileSync(txt, 'utf8') } : {}) };
      if (first) (row as any).cold = true;
      first = false;
      const i = rows.findIndex((x) => x.group === gr.id && x.key === c.key && x.variant === v.id);
      if (i >= 0) rows[i] = row;
      else rows.push(row);
      fs.writeFileSync(file, JSON.stringify(rows, null, 2));
      console.log(r.ok ? 'ok  ' : 'FAIL', gr.id, c.key, v.id, r.seconds ? `${r.seconds}s` : '', r.peak ? `${r.peak}GB` : '', r.ok ? '' : r.error);
    }
  }
}
