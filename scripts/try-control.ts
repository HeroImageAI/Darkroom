/**
 * Depth and pose control A/B (Edit plan phase 5, JP's download OK 2026-10-05): do Klein 9B and Qwen-Image 2.1 follow a
 * depth map (Lotus) or a pose skeleton (SDPose) given as a picture, with no ControlNet? Maps are made from Library
 * photos; then each model renders from the map alone, and (pose) puts an existing character into the pose.
 *   npx tsx scripts/try-control.ts <out dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { discoverComfy } from '../src/server/discovery.js';
import { ComfyClient, filesFromHistory, historyError } from '../src/shared/comfy.js';
import { buildPrompt, findByTitle, type ApiPrompt } from '../src/shared/workflow.js';
import { composeImagePrompt, refToken, type PromptTemplates } from '../src/shared/prompts.js';

const [outDir] = process.argv.slice(2);
const DR = 'http://127.0.0.1:5179';
const comfy = new ComfyClient((await discoverComfy(loadConfig()))!.url);
fs.mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync('workflows/manifest.json', 'utf8'));
const T = ((await (await fetch(`${DR}/api/manifest`)).json()) as { prompts: PromptTemplates }).prompts;
const items = ((await (await fetch(`${DR}/api/items?limit=2000&filter=generated`)).json()) as { items: any[] }).items;
const find = (re: RegExp) => items.find((i) => i.kind === 'image' && re.test(i.prompt ?? ''));

const queue = async (g: ApiPrompt, out: string) => {
  const id = await comfy.queuePrompt(g, 'dr-try-control');
  let h = null;
  while (!(h = await comfy.history(id))) await new Promise((r) => setTimeout(r, 300));
  const err = historyError(h);
  if (err) throw new Error(`${path.basename(out)}: ${err}`);
  const f = filesFromHistory(h, findByTitle(g, 'DR_OUTPUT'))[0];
  const bytes = await comfy.view(f);
  fs.writeFileSync(out, bytes);
  const up = await comfy.upload('image', new Blob([new Uint8Array(bytes)]), path.basename(out), { subfolder: 'darkroom', overwrite: true });
  return `${up.subfolder}/${up.name}`;
};
const asInput = async (it: any) => ((await (await fetch(`${DR}/api/items/${it.id}/as-input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"which":"main"}' })).json()) as { name: string }).name;

const depthGraph = (image: string): ApiPrompt => ({
  '1': { class_type: 'LoadImage', inputs: { image } },
  '2': { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['1', 0], upscale_method: 'lanczos', megapixels: 0.6, resolution_steps: 64 } },
  '3': { class_type: 'UNETLoader', inputs: { unet_name: 'lotus-depth-d-v1-1.safetensors', weight_dtype: 'default' } },
  '4': { class_type: 'VAELoader', inputs: { vae_name: 'vae-ft-mse-840000-ema-pruned.safetensors' } },
  '5': { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['4', 0] } },
  '6': { class_type: 'LotusConditioning', inputs: {} },
  '7': { class_type: 'BasicGuider', inputs: { model: ['3', 0], conditioning: ['6', 0] } },
  '8': { class_type: 'BasicScheduler', inputs: { model: ['3', 0], scheduler: 'normal', steps: 1, denoise: 1 } },
  '9': { class_type: 'SetFirstSigma', inputs: { sigmas: ['8', 0], sigma: 999 } },
  '10': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
  '11': { class_type: 'DisableNoise', inputs: {} },
  '12': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['11', 0], guider: ['7', 0], sampler: ['10', 0], sigmas: ['9', 0], latent_image: ['5', 0] } },
  '13': { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['4', 0] } },
  '14': { class_type: 'ImageInvert', inputs: { image: ['13', 0] } },
  '15': { class_type: 'SaveImage', inputs: { images: ['14', 0], filename_prefix: 'darkroom/control/depth' }, _meta: { title: 'DR_OUTPUT' } },
});
const poseGraph = (image: string): ApiPrompt => ({
  '1': { class_type: 'LoadImage', inputs: { image } },
  '2': { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['1', 0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 8 } },
  '3': { class_type: 'UNETLoader', inputs: { unet_name: 'rt_detr_v4-x-hgnet_fp16.safetensors', weight_dtype: 'default' } },
  '4': { class_type: 'RTDETR_detect', inputs: { model: ['3', 0], image: ['2', 0], threshold: 0.5, class_name: 'person', max_detections: 4 } },
  '5': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdpose_wholebody_fp16.safetensors' } },
  '6': { class_type: 'SDPoseKeypointExtractor', inputs: { model: ['5', 0], vae: ['5', 2], image: ['2', 0], batch_size: 16, bboxes: ['4', 0] } },
  '7': { class_type: 'SDPoseDrawKeypoints', inputs: { keypoints: ['6', 0], draw_body: true, draw_hands: true, draw_face: true, draw_feet: true, stick_width: 4, face_point_size: 2, score_threshold: 0.4, draw_head: true } },
  '8': { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'darkroom/control/pose' }, _meta: { title: 'DR_OUTPUT' } },
});
const edit = async (model: 'klein' | 'qwen', text: string, image_1: string, image_2: string | null, out: string) => {
  const wf = model === 'klein' ? 'klein_edit' : 'qwen_edit';
  const spec = manifest.workflows[wf];
  const g = buildPrompt(JSON.parse(fs.readFileSync(path.join('workflows', spec.file), 'utf8')) as ApiPrompt, spec, { prompt: composeImagePrompt(T, { model, mode: 'instruct', text }), image_1, ...(image_2 ? { image_2 } : {}), seed: 21 });
  const t0 = Date.now();
  await queue(g, out);
  console.log(path.basename(out), ((Date.now() - t0) / 1000).toFixed(1) + 's');
};

// maps
const carSrc = find(/car|hatchback/i);
const personSrc = find(new RegExp(process.env.POSE_SRC ?? 'astronaut walking', 'i'));
const character = find(/witch|knight|scavenger|character/i);
console.log('sources', carSrc?.prompt?.slice(0, 50), '|', personSrc?.prompt?.slice(0, 50), '|', character?.prompt?.slice(0, 50));
const onlyPose = process.env.ONLY === 'pose';
let t0 = Date.now();
const depth = onlyPose ? '' : await queue(depthGraph(await asInput(carSrc)), path.join(outDir, 'depth_map.png'));
console.log('depth map', ((Date.now() - t0) / 1000).toFixed(1) + 's');
t0 = Date.now();
const pose = await queue(poseGraph(await asInput(personSrc)), path.join(outDir, 'pose_map.png'));
console.log('pose map', ((Date.now() - t0) / 1000).toFixed(1) + 's');
const charIn = await asInput(character);

for (const m of ['klein', 'qwen'] as const) {
  if (!onlyPose) await edit(m, 'Turn this depth map into a photorealistic studio photo of a red sports car. Follow the depth map exactly: the same shapes, positions, layout and camera angle; near is light, far is dark.', depth, null, path.join(outDir, `depth_${m}.png`));
  await edit(m, 'This picture is a pose diagram (coloured lines for the limbs on black). Draw a real person, not the diagram: a photorealistic photo of a knight in silver armour on a castle courtyard, in exactly this pose, with the same body, arm, leg and head positions.', pose, null, path.join(outDir, `pose_${m}.png`));
  await edit(m, `${refToken(T, m, 1)} is a pose diagram (coloured lines for the limbs on black). Draw the character from ${refToken(T, m, 2)} as a full, real figure in exactly the pose of ${refToken(T, m, 1)}: the same body, arm, leg and head positions. Keep the character's look, body, clothing, props and style from ${refToken(T, m, 2)}, on a plain grey background; never draw the diagram itself.`, pose, charIn, path.join(outDir, `posefirst_${m}.png`));
  if (process.env.SKIP_OLD) continue;
  await edit(m, `${refToken(T, m, 2)} is a pose diagram (coloured lines for the limbs on black). Show the character from ${refToken(T, m, 1)} as a full, real figure in exactly that pose: the same body, arm, leg and head positions. Keep the character's look, body, clothing and style from ${refToken(T, m, 1)}; never draw the diagram itself.`, charIn, pose, path.join(outDir, `posechar_${m}.png`));
}
console.log('done');
