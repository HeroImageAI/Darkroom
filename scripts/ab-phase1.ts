/**
 * Phase 1 A/B: old prompts (v1.0-baseline) vs new model-specific prompts, fixed seeds.
 *   npx tsx scripts/ab-phase1.ts [--only klein|qwen|wan|ltx] [--dry]
 * Renders via scripts/run-workflow.ts into docs/qa/phase1/<group>/, records docs/qa/phase1/runs.json.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/server/config.js';
import { composeImagePrompt, composeMotionPrompt, type CameraPreset, type PromptTemplates, type StylePreset } from '../src/shared/prompts.js';

const OUT = path.join(ROOT, 'docs', 'qa', 'phase1');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const dry = process.argv.includes('--dry');
const T = JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', 'prompts.json'), 'utf8')) as PromptTemplates;
const STYLES = (JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', 'styles.json'), 'utf8')) as { styles: StylePreset[] }).styles;
const CAMS = (JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', 'camera.json'), 'utf8')) as { camera: CameraPreset[] }).camera;

// Old (v1.0-baseline) texts, verbatim.
const OLD_SUFFIX: Record<string, string> = {
  photographic: 'photograph, natural light, 35mm lens, shallow depth of field, true-to-life colour, fine film grain',
  concept: 'concept art, painterly digital illustration, strong silhouette, atmospheric perspective, dramatic lighting, production design sheet quality',
  product: 'studio product photography, seamless backdrop, softbox lighting, crisp reflections, centred composition, commercial catalogue quality',
  ink: 'ink sketch on white paper, confident black linework, cross-hatching, loose gestural strokes, no colour',
  screenprint: 'screen print, two to three flat spot colours, visible halftone dots, slight misregistration, bold graphic shapes, textured paper',
};
const OLD_CAM_PUSH = 'The camera slowly pushes in toward the subject.';

const SUBJECTS = [
  { id: 'fisherman', text: 'A weathered fisherman mending an orange net on a wooden pier at dawn', seed: 101 },
  { id: 'teapot', text: 'A ceramic teapot with a chipped blue glaze on a linen tablecloth next to a cup of tea', seed: 202 },
  { id: 'courier', text: 'A bicycle courier riding through a rainy city street at night, neon reflections on wet asphalt', seed: 303 },
];
const SRC = 'bench/klein_t2i/klein_00001_.png'; // fisherman 1024x1024 (Klein), used for edits and video
const MASK = 'bench/inputs/mask_net.png';
const CAPTION = 'A weathered fisherman mending an orange net on a wooden pier at dawn, misty lake behind him';

interface Run {
  group: string;
  key: string; // grid cell id
  variant: 'old' | 'new';
  family: 'klein' | 'qwen' | 'wan' | 'ltx';
  workflow: string;
  file?: string;
  set: Record<string, string | number>;
  images?: Record<string, string>;
  prompt: string;
}
const runs: Run[] = [];

// ---- styles × subjects × models
for (const model of ['klein', 'qwen'] as const) {
  for (const sub of SUBJECTS) {
    for (const st of STYLES.filter((s) => s.id !== 'none')) {
      const oldP = `${sub.text}, ${OLD_SUFFIX[st.id]}`;
      const newP = composeImagePrompt(T, { model, mode: 'generate', text: sub.text, style: st });
      const size = model === 'klein' ? { width: 1024, height: 1024 } : { width: 1328, height: 1328 };
      for (const [variant, prompt] of [['old', oldP], ['new', newP]] as const) {
        runs.push({ group: `styles-${model}`, key: `${sub.id}-${st.id}`, variant, family: model, workflow: model === 'klein' ? 'klein_t2i' : 'qwen_t2i', set: { prompt, seed: sub.seed, ...size }, prompt });
      }
    }
  }
}

// ---- edits (both models)
const EDITS = [
  { mode: 'instruct' as const, key: 'instruct-night', text: 'Change the time of day to a clear night with a full moon', masked: false },
  { mode: 'instruct' as const, key: 'instruct-net-blue-masked', text: 'Make the fishing net bright blue', masked: true },
  { mode: 'inpaint' as const, key: 'inpaint-traps', text: 'A pile of lobster traps and coiled yellow rope' },
  { mode: 'outpaint' as const, key: 'outpaint-wide', text: '' },
];
for (const model of ['klein', 'qwen'] as const) {
  for (const ed of EDITS) {
    const wf = { instruct: model === 'klein' ? 'klein_edit' : 'qwen_edit', inpaint: model === 'klein' ? 'inpaint' : 'qwen_inpaint', outpaint: model === 'klein' ? 'outpaint' : 'qwen_outpaint' }[ed.mode];
    const oldP = ed.mode === 'outpaint' ? ed.text || CAPTION : ed.text; // v1: raw text, outpaint fell back to item.prompt
    const newP = composeImagePrompt(T, { model, mode: ed.mode, text: ed.text, masked: 'masked' in ed ? ed.masked : false, caption: CAPTION });
    const images: Record<string, string> = { image_1: SRC };
    if (ed.mode === 'inpaint' || ('masked' in ed && ed.masked)) images.mask = MASK;
    const extra = ed.mode === 'outpaint' ? { pad_left: 256, pad_right: 256 } : {};
    for (const [variant, prompt] of [['old', oldP], ['new', newP]] as const) {
      runs.push({ group: `edits-${model}`, key: ed.key, variant, family: model, workflow: wf, set: { prompt, seed: 77, ...extra }, images, prompt });
    }
  }
}

// ---- video (both models), 3 s drafts
const MOTIONS = [
  { key: 'net-pull', motion: 'He pulls the orange net tight with both hands, then lifts his head and looks out over the lake', camera: ['push'] },
  { key: 'empty-motion', motion: '', camera: [] as string[] },
];
for (const vm of ['wan', 'ltx'] as const) {
  for (const mo of MOTIONS) {
    const oldP = [mo.motion.trim(), ...(mo.camera.length ? [OLD_CAM_PUSH] : [])].filter(Boolean).join(' ') || 'Natural, subtle motion.';
    const newP = composeMotionPrompt(T, CAMS, { model: vm, motion: mo.motion, camera: mo.camera });
    const base = vm === 'wan' ? { frames: 49, fps: 16, width: 640, height: 640 } : { frames: 73, fps: 24, width: 640, height: 640 };
    const wf = vm === 'wan' ? 'wan22_i2v' : 'ltx25_i2v';
    runs.push({ group: `video-${vm}`, key: mo.key, variant: 'old', family: vm, workflow: wf, file: `${wf}.json`, set: { motion_prompt: oldP, seed: 55, ...base }, images: { start_image: SRC }, prompt: oldP });
    runs.push({ group: `video-${vm}`, key: mo.key, variant: 'new', family: vm, workflow: wf, set: { motion_prompt: newP, seed: 55, ...base }, images: { start_image: SRC }, prompt: newP });
  }
}

fs.mkdirSync(OUT, { recursive: true });
const recordFile = path.join(OUT, 'runs.json');
const record: (Run & { file_out?: string; seconds?: number; ok?: boolean })[] = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, 'utf8')) : [];
const done = new Set(record.filter((r) => r.ok).map((r) => `${r.group}/${r.key}/${r.variant}`));

let lastFamily = '';
for (const r of runs) {
  if (only && r.family !== only) continue;
  const id = `${r.group}/${r.key}/${r.variant}`;
  if (done.has(id)) continue;
  if (dry) {
    console.log(id, '|', r.prompt);
    continue;
  }
  const dir = path.join(OUT, r.group, `${r.key}-${r.variant}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const args = [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/run-workflow.ts', r.workflow, '--out', dir, '--label', `ab ${id}`];
  if (r.family !== lastFamily) args.push('--free');
  if (r.file) args.push('--file', r.file);
  for (const [k, v] of Object.entries(r.set)) args.push('--set', `${k}=${v}`);
  for (const [k, v] of Object.entries(r.images ?? {})) args.push('--image', `${k}=${v}`);
  const res = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  lastFamily = r.family;
  const m = /"seconds": ([\d.]+)/.exec(res.stdout ?? '');
  const ok = res.status === 0;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !/_poster|_last/.test(f)) : [];
  record.push({ ...r, ok, seconds: m ? Number(m[1]) : undefined, file_out: files[0] ? path.relative(ROOT, path.join(dir, files[0])) : undefined });
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2));
  console.log(ok ? 'ok ' : 'FAIL', id, m ? m[1] + 's' : '', ok ? '' : (res.stdout + res.stderr).slice(-400));
}
