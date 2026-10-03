import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addKeyMoments, addSoundToPicture } from '../src/shared/ltxguides';
import type { ApiPrompt } from '../src/shared/workflow';

const load = (f: string) => JSON.parse(fs.readFileSync(`workflows/${f}`, 'utf8')) as ApiPrompt;
const refsTo = (g: ApiPrompt, id: string) => Object.entries(g).flatMap(([k, n]) => Object.entries(n.inputs).filter(([, v]) => Array.isArray(v) && v[0] === id).map(([i]) => `${k}.${i}`));

describe.each(['ltx25_i2v.v2.json', 'ltx25_i2v_hd.json'])('%s', (file) => {
  it('key moments chain after the end guide and everything downstream reads the last one', () => {
    const g = addKeyMoments(load(file), [
      { image: 'a.png', frame: 40, strength: 0.9 },
      { image: 'b.png', frame: 80, strength: 2 },
    ]);
    expect(g.km0.inputs).toMatchObject({ positive: ['20', 0], latent: ['20', 2], frame_idx: 40 });
    expect(g.km1.inputs).toMatchObject({ positive: ['km0', 0], frame_idx: 80, strength: 1 });
    // the old end guide now only feeds the first key moment
    expect(refsTo(g, '20').sort()).toEqual(['km0.latent', 'km0.negative', 'km0.positive']);
    expect(g['22'].inputs.video_latent).toEqual(['km1', 2]);
    expect(g['29'].inputs.positive).toEqual(['km1', 0]);
  });

  it('sound to picture replaces the empty audio latent with your sound, frozen, in every stage', () => {
    const g = addSoundToPicture(load(file), { file: 'darkroom/voice.mp3', start: 2, seconds: 4.5 });
    expect(Object.values(g).some((n) => n.class_type === 'LTXVEmptyLatentAudio')).toBe(false);
    expect(g['22'].inputs.audio_latent).toEqual(['snd_freeze', 0]);
    expect(g.snd_trim.inputs).toMatchObject({ start_index: 2, duration: 4.5 });
    if (file.includes('hd')) expect(g[(g['47'].inputs.audio_latent as [string, number])[0]].class_type).toBe('LTXVFreezeLatent');
  });
});
