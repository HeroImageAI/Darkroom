import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { framesFor, orientationOf, planVideo, type VideoModel } from '../src/shared/manifest';

const wan: VideoModel = {
  label: 'Wan',
  tagline: '',
  workflow: 'wan22_i2v',
  supportsEndFrame: true,
  fps: 16,
  framesFor: 'fps*s+1',
  maxSeconds: 8,
  quality: {
    draft: { label: 'Draft', short: '480p', landscape: [832, 480], portrait: [480, 832], square: [640, 640] },
    final: { label: 'Final', short: '720p', landscape: [1280, 720], portrait: [720, 1280], square: [960, 960] },
  },
  secondsPerSecond: { draft: 10, final: 30 },
  overheadSec: { draft: 20, final: 30 },
};
const ltx: VideoModel = { ...wan, workflow: 'ltx25_i2v', fps: 24 };

describe('video planning', () => {
  it('uses 4n+1 frames for Wan and 8n+1 for LTX', () => {
    expect(framesFor(wan, 5)).toBe(81);
    expect(framesFor(wan, 3)).toBe(49);
    expect(framesFor(ltx, 5)).toBe(121);
    expect(framesFor(ltx, 3)).toBe(73);
    expect((framesFor(ltx, 8) - 1) % 8).toBe(0);
  });
  it('clamps to the model maximum', () => {
    expect(framesFor(wan, 20)).toBe(framesFor(wan, 8));
  });
  it('picks orientation from the start frame', () => {
    expect(orientationOf(1920, 1080)).toBe('landscape');
    expect(orientationOf(1080, 1350)).toBe('portrait');
    expect(orientationOf(1024, 1024)).toBe('square');
  });
  it('estimates time from measured rates', () => {
    const p = planVideo(wan, 'draft', 5, 1600, 900);
    expect(p).toMatchObject({ width: 832, height: 480, fps: 16, frames: 81, seconds: 5 });
    expect(p.estimateSec).toBe(70);
  });
});

describe('LTX 1080p tier (DECISIONS 96)', () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'manifest.json'), 'utf8'));
  const ltx = real.video.ltx;
  it('Wan is gone; LTX has Draft, Final and 1080p', () => {
    expect(Object.keys(real.video)).toEqual(['ltx']);
    expect(Object.keys(ltx.quality)).toEqual(['draft', 'final', 'hd']);
  });
  it('1080p runs the two-stage graph at full HD with its own (linear) time estimate', () => {
    const p = planVideo(ltx, 'hd', 5, 1920, 1080);
    expect([p.width, p.height, p.workflow]).toEqual([1920, 1088, 'ltx25_i2v_hd']);
    expect(p.estimateSec).toBe(195);
    expect(planVideo(ltx, 'hd', 8, 1080, 1920).estimateSec).toBe(312);
    expect(planVideo(ltx, 'final', 5, 1920, 1080).workflow).toBe('ltx25_i2v');
    expect(real.workflows.ltx25_i2v_hd.file).toBe('ltx25_i2v_hd.json');
  });
});
