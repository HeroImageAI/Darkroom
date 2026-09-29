/**
 * Phase 6 QA: build the golden set, then run every feature on it with fixed seeds.
 *   npx tsx scripts/qa-phase6.ts golden        -> tests/golden/*.png (synthetic, no real people, no Google Earth)
 *   npx tsx scripts/qa-phase6.ts features      -> docs/qa/phase6/<feature>/<case>/, records docs/qa/phase6/runs.json
 *   npx tsx scripts/qa-phase6.ts stress        -> rapid model-family switching, VRAM sampled (OOM check)
 * Runs through scripts/run-workflow.ts (records timing + peak VRAM in bench/results.jsonl).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../src/server/config.js';
import { composeImagePrompt, type PromptTemplates } from '../src/shared/prompts.js';
import { planEnhance } from '../src/shared/enhance.js';
import { samPointsJson } from '../src/shared/workflow.js';
import { buildVlmRequest, type VlmPrompts } from '../src/shared/vlm.js';

const GOLD = path.join(ROOT, 'tests', 'golden');
const QA = path.join(ROOT, 'docs', 'qa', 'phase6');
const T = JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', 'prompts.json'), 'utf8')) as PromptTemplates;
const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', 'vlm_prompts.json'), 'utf8')) as VlmPrompts;
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

interface Result { ok: boolean; seconds?: number; peak?: number; files: string[]; text?: string[]; error?: string }

function run(workflow: string, out: string, set: Record<string, string | number | boolean>, images: Record<string, string> = {}, extra: string[] = []): Result {
  const args = [TSX, 'scripts/run-workflow.ts', workflow, '--out', out, '--label', `qa ${path.relative(QA, out)}`, ...extra];
  for (const [k, v] of Object.entries(set)) args.push('--set', `${k}=${v}`);
  for (const [k, v] of Object.entries(images)) args.push('--image', `${k}=${v}`);
  fs.rmSync(out, { recursive: true, force: true });
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000 });
  const js = (r.stdout ?? '').slice((r.stdout ?? '').lastIndexOf('\n{'));
  let parsed: any = {};
  try {
    parsed = JSON.parse(js);
  } catch {
    /* failed */
  }
  return { ok: r.status === 0, seconds: parsed.seconds, peak: parsed.peakVramGB, files: parsed.files ?? [], text: parsed.text, error: parsed.error ?? (r.status === 0 ? undefined : (r.stderr || r.stdout).slice(-600)) };
}

// ------------------------------------------------------------------ golden set
const GOLDEN = [
  { id: '01_portrait', model: 'klein', w: 896, h: 1120, prompt: 'Close-up portrait of an elderly woman with silver hair and deep laugh lines, wearing a knitted green scarf, soft window light from the left, natural skin texture.' },
  { id: '02_product', model: 'klein', w: 1024, h: 1024, prompt: 'A pair of brown leather hiking boots with red laces on a pale wooden bench, studio product photograph on a seamless light-grey backdrop, softbox lighting.' },
  { id: '03_text_scene', model: 'qwen', w: 1584, h: 1056, prompt: 'A small bakery storefront on a cobbled street. A painted wooden sign above the door reads "SUNRISE BAKERY" in cream serif letters, and a chalkboard beside the door says "Fresh bread daily" in white chalk handwriting. Morning light, realistic photography.' },
  { id: '04_busy_street', model: 'qwen', w: 1664, h: 928, prompt: 'A busy city street at noon seen from a second-floor window: crowds of pedestrians on both pavements, yellow taxis and cars, two cyclists, a red tram, shop signs and awnings, realistic photography with fine detail.' },
  { id: '05_hair', model: 'klein', w: 896, h: 1120, prompt: 'A woman with long curly red hair blowing in the wind, backlit against a plain mid-grey studio backdrop, individual strands catching the light, three-quarter view.' },
  { id: '06_fur', model: 'klein', w: 1024, h: 1024, prompt: 'A fluffy grey Maine Coon cat sitting on a white windowsill, long detailed fur and ear tufts, soft daylight, plain pale wall behind.' },
  { id: '07_transparent', model: 'qwen', w: 1328, h: 1328, prompt: 'A clear glass water carafe and two empty drinking glasses on a light linen tablecloth, sunlight refracting through the glass and casting caustic light patterns, realistic photography.' },
  { id: '08_lowres_src', model: 'klein', w: 1248, h: 832, prompt: 'A small harbour with colourful wooden fishing boats moored along a stone quay, houses on a hillside behind, overcast afternoon.' },
  { id: '09_car', model: 'klein', w: 1344, h: 768, prompt: 'A red vintage 1960s car parked in front of a pastel blue house with a white door and a potted palm, sunny afternoon, photograph.' },
  { id: '10_interior', model: 'qwen', w: 1328, h: 1328, prompt: 'A cozy living room with a green velvet sofa, a brass floor lamp, a potted monstera plant, a wooden coffee table with a teapot, and a tall bookshelf, warm evening light.' },
];

async function golden() {
  fs.mkdirSync(GOLD, { recursive: true });
  let last = '';
  for (const g of GOLDEN) {
    const target = path.join(GOLD, `${g.id}.png`);
    if (fs.existsSync(target)) continue;
    const out = path.join(ROOT, 'bench', 'golden', g.id);
    const r = run(g.model === 'klein' ? 'klein_t2i' : 'qwen_t2i', out, { prompt: g.prompt, seed: 1000 + GOLDEN.indexOf(g), width: g.w, height: g.h }, {}, g.model !== last ? ['--free'] : []);
    last = g.model;
    if (!r.ok || !r.files[0]) {
      console.log('FAIL golden', g.id, r.error);
      continue;
    }
    fs.copyFileSync(r.files[0], target);
    console.log('golden', g.id, r.seconds + 's');
  }
  // low-resolution variant: 320 px wide, heavy JPEG, back to PNG
  const lr = path.join(GOLD, '08_lowres.png');
  if (!fs.existsSync(lr) && fs.existsSync(path.join(GOLD, '08_lowres_src.png'))) {
    const jpg = await sharp(path.join(GOLD, '08_lowres_src.png')).resize(320).jpeg({ quality: 35 }).toBuffer();
    await sharp(jpg).png().toFile(lr);
    console.log('golden 08_lowres (320 px, JPEG q35)');
  }
  // the SeedVR2 4x pre-upscale the app runs before enhancing a picture this small (planEnhance)
  const x4 = path.join(GOLD, '08_lowres_seedvr2x4.png');
  if (!fs.existsSync(x4) && fs.existsSync(lr)) {
    const r = run('upscale', path.join(ROOT, 'bench', 'golden', '08_lowres_x4'), { scale: 4, seed: 1 }, { image_1: lr }, ['--free']);
    if (r.ok && r.files[0]) fs.copyFileSync(r.files[0], x4);
    console.log(r.ok ? 'golden 08_lowres_seedvr2x4' : 'FAIL golden 08_lowres_seedvr2x4 ' + r.error);
  }
  fs.writeFileSync(path.join(GOLD, 'README.md'), `# Golden test set\n\nSynthetic images generated by Darkroom itself (no real people, no Google Earth captures), fixed seeds 1000-1009.\n\n${GOLDEN.map((g) => `- **${g.id}** (${g.model}, ${g.w}×${g.h}): ${g.prompt}`).join('\n')}\n- **08_lowres**: 08_lowres_src downscaled to 320 px wide and saved as JPEG quality 35.\n`);
}

// ------------------------------------------------------------------ feature runs
const g = (id: string) => path.join('tests', 'golden', `${id}.png`);
interface Case { feature: string; id: string; family: string; workflow: string; set: Record<string, string | number | boolean>; images?: Record<string, string>; note?: string; file?: string }

function cases(): Case[] {
  const c: Case[] = [];
  const add = (x: Case) => c.push(x);
  // VLM: caption / reverse / enhance-prompt (Qwen3-VL 8B)
  for (const img of ['01_portrait', '03_text_scene', '04_busy_street']) {
    for (const v of ['short', 'detailed', 'klein']) {
      const r = buildVlmRequest(V, 'caption', v);
      add({ feature: 'caption', id: `${img}-${v}`, family: 'vlm', workflow: 'vlm_image', set: { prompt: r.prompt, max_tokens: r.maxTokens, seed: 7 }, images: { image_1: g(img) } });
    }
    for (const v of ['klein', 'qwen']) {
      const r = buildVlmRequest(V, 'reverse', v);
      add({ feature: 'reverse', id: `${img}-${v}`, family: 'vlm', workflow: 'vlm_image', set: { prompt: r.prompt, max_tokens: r.maxTokens, seed: 7 }, images: { image_1: g(img) } });
    }
  }
  for (const [i, idea] of ['a lighthouse in a storm', 'poster for a jazz night called "Blue Hour" on Friday', 'a cat wearing a tiny crown'].entries()) {
    for (const v of ['klein', 'qwen']) {
      const r = buildVlmRequest(V, 'enhance', v, idea);
      add({ feature: 'enhance_prompt', id: `idea${i + 1}-${v}`, family: 'vlm', workflow: 'vlm_text', set: { prompt: r.prompt, max_tokens: r.maxTokens, seed: 7 } });
    }
  }
  // SAM segmentation, background removal, layers
  add({ feature: 'segment', id: '04-text-person', family: 'sam', workflow: 'sam_segment', set: { text: 'person', individual: false }, images: { image_1: g('04_busy_street') } });
  add({ feature: 'segment', id: '09-text-car', family: 'sam', workflow: 'sam_segment', set: { text: 'car' }, images: { image_1: g('09_car') } });
  add({ feature: 'segment', id: '02-click-boot', family: 'sam', workflow: 'sam_segment', set: { ...samPointsJson([{ x: 430, y: 430 }], []) }, images: { image_1: g('02_product') } });
  add({ feature: 'segment', id: '09-click-car', family: 'sam', workflow: 'sam_segment', set: { ...samPointsJson([{ x: 450, y: 560 }, { x: 250, y: 600 }, { x: 700, y: 520 }], []) }, images: { image_1: g('09_car') }, note: '3 clicks' });
  add({ feature: 'segment', id: '09-box-car', family: 'sam', workflow: 'sam_segment', set: { boxes: JSON.stringify({ x: 150, y: 330, width: 800, height: 380 }) }, images: { image_1: g('09_car') } });
  for (const [img, subject] of [['05_hair', 'woman'], ['06_fur', 'cat'], ['07_transparent', 'carafe'], ['02_product', 'boots']] as const) {
    add({ feature: 'bg_v1_birefnet', id: img, family: 'util', workflow: 'remove_bg_v1', set: {}, images: { image_1: g(img) } });
    add({ feature: 'bg_v2_sam_birefnet', id: img, family: 'sam', workflow: 'remove_bg', set: { subject, matte: 'birefnet.safetensors' }, images: { image_1: g(img) } });
    add({ feature: 'bg_v2_sam_lucida', id: img, family: 'sam', workflow: 'remove_bg', set: { subject, matte: 'lucida.safetensors' }, images: { image_1: g(img) } });
  }
  add({ feature: 'layers_sam', id: '09_car', family: 'sam', workflow: 'sam_layers', set: { text: 'car, house, plant' }, images: { image_1: g('09_car') } });
  add({ feature: 'layers_sam', id: '10_interior', family: 'sam', workflow: 'sam_layers', set: { text: 'sofa, lamp, plant, bookshelf' }, images: { image_1: g('10_interior') } });
  add({ feature: 'layers_qwen', id: '09_car', family: 'layered', workflow: 'qwen_layered', set: { layers: 4, seed: 5, prompt: GOLDEN[8].prompt }, images: { image_1: g('09_car') }, note: 'captioned (the app auto-captions)' });
  add({ feature: 'layers_qwen', id: '02_product', family: 'layered', workflow: 'qwen_layered', set: { layers: 3, seed: 5, prompt: GOLDEN[1].prompt }, images: { image_1: g('02_product') }, note: 'captioned (the app auto-captions)' });
  // Edit on both models
  for (const model of ['klein', 'qwen'] as const) {
    const wf = (m: string) => (model === 'klein' ? { instruct: 'klein_edit', inpaint: 'inpaint', outpaint: 'outpaint', enhance: 'klein_enhance' } : { instruct: 'qwen_edit', inpaint: 'qwen_inpaint', outpaint: 'qwen_outpaint', enhance: 'qwen_enhance' })[m as 'instruct']!;
    add({ feature: `instruct_${model}`, id: '01-scarf-red', family: model, workflow: wf('instruct'), set: { prompt: composeImagePrompt(T, { model, mode: 'instruct', text: 'Change the scarf to a deep red wool scarf' }), seed: 11 }, images: { image_1: g('01_portrait') } });
    add({ feature: `instruct_${model}`, id: '03-sign-text', family: model, workflow: wf('instruct'), set: { prompt: composeImagePrompt(T, { model, mode: 'instruct', text: 'Change the sign text to "MOONLIGHT BAKERY"' }), seed: 11 }, images: { image_1: g('03_text_scene') } });
    add({ feature: `outpaint_${model}`, id: '09-to-wide', family: model, workflow: wf('outpaint'), set: { prompt: composeImagePrompt(T, { model, mode: 'outpaint', text: 'more of the quiet street and neighbouring houses', caption: GOLDEN[8].prompt }), pad_left: 192, pad_right: 192, seed: 11 }, images: { image_1: g('09_car') } });
    for (const [strength, img] of [['subtle', '08_lowres'], ['strong', '08_lowres'], ['subtle', '01_portrait']] as const) {
      const d = strength === 'subtle' ? (model === 'klein' ? 0.3 : 0.35) : model === 'klein' ? 0.6 : 0.65;
      const set: Record<string, string | number> = { prompt: composeImagePrompt(T, { model, mode: 'enhance', text: '', caption: img === '08_lowres' ? GOLDEN[7].prompt : GOLDEN[0].prompt, strength }), denoise: d, seed: 11, megapixels: 1 };
      if (model === 'klein') set.schedule_steps = Math.max(4, Math.round(4 / d));
      // like the app (planEnhance): small sources are pre-upscaled with SeedVR2 before the enhance pass
      const pre = img === '08_lowres' ? planEnhance(320, 213).preScale : planEnhance(896, 1120).preScale;
      add({ feature: `enhance_${model}`, id: `${img}-${strength}`, family: model, workflow: wf('enhance'), set, images: { image_1: pre ? g(`${img}_seedvr2x${pre}`) : g(img) }, note: pre ? `SeedVR2 ${pre}x first` : undefined });
    }
  }
  add({ feature: 'upscale', id: '08_lowres', family: 'seedvr2', workflow: 'upscale', set: { scale: 2, seed: 1 }, images: { image_1: g('08_lowres') } });
  // Video: start + end frame on both models (3 s drafts)
  add({ feature: 'video_wan', id: 'start-end', family: 'wan', workflow: 'wan22_i2v', set: { motion_prompt: 'The camera slowly pushes in toward the red car as the palm leaves sway in a light breeze.', seed: 3, frames: 49, fps: 16, width: 832, height: 480 }, images: { start_image: g('09_car'), end_image: g('09_car') } });
  add({ feature: 'video_ltx', id: 'start-end', family: 'ltx', workflow: 'ltx25_i2v', set: { motion_prompt: 'The camera slowly pushes in toward the red car as the palm leaves sway in a light breeze. A car door closes softly in the distance.', seed: 3, frames: 73, fps: 24, width: 864, height: 480 }, images: { start_image: g('09_car'), end_image: g('09_car') } });
  return c;
}

function features(onlyFeature?: string) {
  const file = path.join(QA, 'runs.json');
  const rec: (Case & Result)[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const done = new Set(rec.filter((r) => r.ok).map((r) => `${r.feature}/${r.id}`));
  // group by family so models load once per family
  const order = ['vlm', 'sam', 'util', 'layered', 'klein', 'qwen', 'seedvr2', 'wan', 'ltx'];
  const all = cases().sort((a, b) => order.indexOf(a.family) - order.indexOf(b.family));
  let last = '';
  for (const k of all) {
    if (onlyFeature && !k.feature.startsWith(onlyFeature)) continue;
    if (done.has(`${k.feature}/${k.id}`)) continue;
    const r = run(k.workflow, path.join(QA, k.feature, k.id), k.set, k.images, k.family !== last ? ['--free'] : []);
    last = k.family;
    const idx = rec.findIndex((x) => x.feature === k.feature && x.id === k.id);
    const row = { ...k, ...r, files: r.files.map((f) => path.relative(ROOT, f)) };
    if (idx >= 0) rec[idx] = row;
    else rec.push(row);
    fs.mkdirSync(QA, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
    console.log(r.ok ? 'ok  ' : 'FAIL', `${k.feature}/${k.id}`, r.seconds ? `${r.seconds}s` : '', r.peak ? `${r.peak}GB` : '', r.ok ? '' : r.error);
  }
}

/** Rapid switching between every model family; pass = no OOM and every job succeeds. */
function stress() {
  const seq: Case[] = [];
  const img = g('09_car');
  for (let round = 0; round < 3; round++) {
    seq.push({ feature: 'stress', id: `${round}-klein`, family: 'klein', workflow: 'klein_t2i', set: { prompt: 'A red kite over green hills', seed: round } });
    seq.push({ feature: 'stress', id: `${round}-qwen`, family: 'qwen', workflow: 'qwen_t2i', set: { prompt: 'A poster that says "STRESS TEST"', seed: round, width: 1024, height: 1024 } });
    const r = buildVlmRequest(V, 'caption', 'short');
    seq.push({ feature: 'stress', id: `${round}-vlm`, family: 'vlm', workflow: 'vlm_image', set: { prompt: r.prompt, max_tokens: 60, seed: round }, images: { image_1: img } });
    seq.push({ feature: 'stress', id: `${round}-sam`, family: 'sam', workflow: 'sam_segment', set: { text: 'car' }, images: { image_1: img } });
    seq.push({ feature: 'stress', id: `${round}-edit`, family: 'qwen', workflow: 'qwen_edit', set: { prompt: 'Make the car blue. Keep everything else unchanged.', seed: round }, images: { image_1: img } });
    seq.push({ feature: 'stress', id: `${round}-upscale`, family: 'seedvr2', workflow: 'upscale', set: { scale: 2, seed: round }, images: { image_1: g('08_lowres') } });
    if (round === 0) seq.push({ feature: 'stress', id: `${round}-layered`, family: 'layered', workflow: 'qwen_layered', set: { layers: 2, seed: round, steps: 10 }, images: { image_1: img } });
    seq.push({ feature: 'stress', id: `${round}-wan`, family: 'wan', workflow: 'wan22_i2v', set: { motion_prompt: 'The car drives slowly away.', seed: round, frames: 17, fps: 16, width: 640, height: 640 }, images: { start_image: img } });
    seq.push({ feature: 'stress', id: `${round}-ltx`, family: 'ltx', workflow: 'ltx25_i2v', set: { motion_prompt: 'The car drives slowly away.', seed: round, frames: 25, fps: 24, width: 640, height: 640 }, images: { start_image: img } });
  }
  const out: (Case & Result)[] = [];
  for (const k of seq) {
    // no explicit --free: the Darkroom server frees on family change; here we mimic it
    const r = run(k.workflow, path.join(QA, 'stress', k.id), k.set, k.images, ['--free']);
    out.push({ ...k, ...r, files: [] });
    console.log(r.ok ? 'ok  ' : 'FAIL', k.id, r.seconds ? `${r.seconds}s` : '', r.peak ? `${r.peak}GB` : '', r.ok ? '' : r.error);
    fs.writeFileSync(path.join(QA, 'stress.json'), JSON.stringify(out, null, 2));
  }
}

const mode = process.argv[2];
if (mode === 'golden') await golden();
else if (mode === 'features') features(process.argv[3]);
else if (mode === 'stress') stress();
else console.log('usage: qa-phase6.ts golden | features [prefix] | stress');
