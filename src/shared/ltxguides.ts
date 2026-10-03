/**
 * Graph changes for the Timeline's AI tools (DECISIONS 104), applied by the server to the LTX image-to-video graphs
 * (single pass and the two-stage 1080p one) after the manifest has filled them in:
 *  - key moments: more pictures guiding the clip at given frames, chained after the last guide of stage 1
 *    (stage 2 of the 1080p graph refines from there)
 *  - sound to picture: a stretch of your sound, encoded by LTX's audio VAE and frozen, in place of the empty audio
 *    latent, so the picture is made to fit it (lip-sync, cuts on the beat); stage 2 keeps it frozen too
 */
import type { ApiPrompt } from './workflow.js';

type Ref = [string, number];
const isRef = (v: unknown): v is Ref => Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'number';
const byTitle = (g: ApiPrompt, title: string) => Object.keys(g).find((k) => g[k]._meta?.title === title);

export interface KeyMoment {
  /** a picture in ComfyUI's input folder */
  image: string;
  /** pixel frame in the clip */
  frame: number;
  strength: number;
}

/** The guide whose outputs feed stage 1's AV latent (the end guide, or the start guide when there is no end). */
function lastStageOneGuide(g: ApiPrompt): string | null {
  const av = Object.keys(g)
    .filter((k) => g[k].class_type === 'LTXVConcatAVLatent')
    .sort((a, b) => Number(a) - Number(b))[0];
  const v = av ? g[av].inputs.video_latent : null;
  return isRef(v) && g[v[0]]?.class_type === 'LTXVAddGuide' ? v[0] : null;
}

export function addKeyMoments(g: ApiPrompt, moments: KeyMoment[]): ApiPrompt {
  if (!moments.length) return g;
  const last = lastStageOneGuide(g);
  const w = byTitle(g, 'DR_WIDTH');
  const h = byTitle(g, 'DR_HEIGHT');
  const vae = byTitle(g, 'DR_VAE');
  if (!last || !w || !h || !vae) throw new Error('Key moments need an LTX image-to-video graph.');
  const consumers = Object.entries(g).filter(([k]) => k !== last);
  let prev = last;
  moments.forEach((m, i) => {
    const id = `km${i}`;
    g[`${id}_load`] = { class_type: 'LoadImage', inputs: { image: m.image }, _meta: { title: `Key moment ${i + 1}` } };
    g[`${id}_fit`] = { class_type: 'ImageScale', inputs: { image: [`${id}_load`, 0], upscale_method: 'lanczos', width: [w, 0], height: [h, 0], crop: 'center' }, _meta: { title: `Key moment ${i + 1} fit` } };
    g[`${id}_prep`] = { class_type: 'LTXVPreprocess', inputs: { image: [`${id}_fit`, 0], img_compression: 18 }, _meta: { title: `Key moment ${i + 1} prep` } };
    g[id] = {
      class_type: 'LTXVAddGuide',
      inputs: { positive: [prev, 0], negative: [prev, 1], vae: [vae, 0], latent: [prev, 2], image: [`${id}_prep`, 0], frame_idx: Math.max(0, Math.round(m.frame)), strength: Math.min(1, Math.max(0, m.strength)) },
      _meta: { title: `DR_KEY_GUIDE_${i + 1}` },
    };
    prev = id;
  });
  // everything that read the old last guide now reads the last key moment
  for (const [, n] of consumers) for (const [k, v] of Object.entries(n.inputs)) if (isRef(v) && v[0] === last) n.inputs[k] = [prev, v[1]];
  return g;
}

export interface SoundSync {
  /** the sound file in ComfyUI's input folder */
  file: string;
  /** seconds into the file */
  start: number;
  seconds: number;
}

export function addSoundToPicture(g: ApiPrompt, s: SoundSync): ApiPrompt {
  const empty = Object.keys(g).find((k) => g[k].class_type === 'LTXVEmptyLatentAudio');
  const audioVae = empty ? (g[empty].inputs.audio_vae as Ref) : null;
  if (!empty || !isRef(audioVae)) throw new Error('Sound to picture needs an LTX graph with sound.');
  g.snd_load = { class_type: 'LoadAudio', inputs: { audio: s.file }, _meta: { title: 'Your sound' } };
  g.snd_trim = { class_type: 'TrimAudioDuration', inputs: { audio: ['snd_load', 0], start_index: Math.max(0, s.start), duration: Math.max(0.1, s.seconds) }, _meta: { title: 'Your sound, this stretch' } };
  g.snd_enc = { class_type: 'LTXVAudioVAEEncode', inputs: { audio: ['snd_trim', 0], audio_vae: audioVae }, _meta: { title: 'Encode your sound' } };
  g.snd_freeze = { class_type: 'LTXVFreezeLatent', inputs: { latent: ['snd_enc', 0] }, _meta: { title: 'Keep your sound' } };
  let n = 0;
  for (const [k, node] of Object.entries(g)) {
    if (node.class_type !== 'LTXVConcatAVLatent') continue;
    const a = node.inputs.audio_latent;
    if (isRef(a) && a[0] === empty) node.inputs.audio_latent = ['snd_freeze', 0];
    else if (isRef(a)) {
      // a later stage takes the earlier stage's audio: keep it frozen there too
      g[`snd_keep_${k}`] = { class_type: 'LTXVFreezeLatent', inputs: { latent: a }, _meta: { title: 'Keep your sound (stage 2)' } };
      node.inputs.audio_latent = [`snd_keep_${k}`, 0];
    }
    n++;
  }
  if (!n) throw new Error('Sound to picture needs an LTX graph with sound.');
  delete g[empty];
  return g;
}
