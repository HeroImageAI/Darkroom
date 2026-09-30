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

const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const g = (id: string) => path.join('tests', 'golden', `${id}.png`);

interface Variant { id: string; label: string; workflow: string; file?: string; set?: Record<string, string | number> }
interface Case { key: string; set: Record<string, string | number>; images?: Record<string, string> }
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

const PHASES: Record<string, Group[]> = {
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
  const set = { ...c.set, ...(v.set ?? {}) };
  const args = [TSX, 'scripts/run-workflow.ts', v.workflow, '--out', out, '--label', `addenda ${path.basename(out)}`];
  if (v.file) args.push('--file', v.file);
  if (free) args.push('--free');
  for (const [k, val] of Object.entries(set)) args.push('--set', `${k}=${val}`);
  for (const [k, val] of Object.entries(c.images ?? {})) args.push('--image', `${k}=${val}`);
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

const [phase, only] = process.argv.slice(2);
const groups = PHASES[phase];
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
