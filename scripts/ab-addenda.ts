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
import { maskBBox, planCrop, type CropPlan } from '../src/shared/cropstitch.js';
import sharp from 'sharp';

const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const g = (id: string) => path.join('tests', 'golden', `${id}.png`);

interface Case { key: string; set: Record<string, string | number>; images?: Record<string, string>; caption?: string }
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
interface Row { group: string; key: string; variant: string; ok: boolean; seconds?: number; peak?: number; file_out?: string; error?: string; set: Record<string, string | number> }

// One Node T2I templates (config.json "t2i_templates"), credited: github.com/yanokusnir-ai/one-node-flux-2-klein
const ONE_NODE_FOX = 'A young fox is gently peeking through tall, vibrant green wheat stalks. The fox stands out with its large, fuzzy ears as she holds a direct gaze into the camera. The scene is beautifully illuminated by soft natural light, while a blurred foreground elegantly frames the majestic animal.';
const ONE_NODE_CHURCH = 'A black and white landscape photograph of a steepled church atop a rolling hill, rising from a dense, glowing sea of low-lying fog. Dark trees flank the structure. Behind it, layers of forested ridges recede into misty mountain peaks under an overcast sky. The scene features profound atmospheric depth, contrasting the bright, sweeping mist against the sharply silhouetted terrain.';

const GOLD = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'golden', 'prompts.json'), 'utf8')) as Record<string, { prompt: string; w: number; h: number }>;
const KEEP = ' Keep the composition, the people and all other details exactly as they are.';

// Qwen 2.1 sizes: Draft ≈ 1–1.2 MP, Native 2K from the official size table (multiples of 32)
const QWEN_DRAFT: Record<string, [number, number]> = { '1:1': [1024, 1024], '3:2': [1248, 832], '16:9': [1376, 768], '4:3': [1152, 864] };
const QWEN_2K: Record<string, [number, number]> = { '1:1': [2048, 2048], '3:2': [2528, 1696], '16:9': [2752, 1536], '4:3': [2400, 1792] };
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

const PHASES: Record<string, Group[]> = {
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
  const args = [TSX, 'scripts/run-workflow.ts', v.workflow, '--out', out, '--label', `addenda ${path.basename(out)}`];
  if (v.file) args.push('--file', v.file);
  if (free) args.push('--free');
  for (const [k, val] of Object.entries(set)) args.push('--set', `${k}=${val}`);
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

const [phase, only] = process.argv.slice(2);
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
      const row: Row = { group: gr.id, key: c.key, variant: v.id, ok: r.ok, seconds: r.seconds, peak: r.peak, error: r.error, set: r.set, file_out: r.file ? path.relative(ROOT, r.file) : undefined };
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
