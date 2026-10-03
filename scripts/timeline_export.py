"""
Timeline export (DECISIONS 103), run by the Darkroom server with Comfy Desktop's Python (it has PyAV).
Streams frame by frame, so a long film never has to fit in memory:
  - each output frame takes the clip(s) live at that moment, fitted to the export size (crop to fill);
    where two clips overlap, the later one crossfades in over the overlap; a gap is black
  - sound: every clip's own sound (unless muted, with the same crossfades) plus the sound track, mixed at 48 kHz
  - H.264 (CRF 18, like Darkroom's renders) + AAC, a poster and a last frame as PNG
Input: a JSON file (argv[1]). Progress: lines "progress <done> <total>" on stdout.
"""
import json
import sys
from fractions import Fraction

import av
import numpy as np
from PIL import Image

SR = 48000


def fit(img: Image.Image, w: int, h: int) -> np.ndarray:
    """Crop to fill w x h (centre), lanczos."""
    s = max(w / img.width, h / img.height)
    nw, nh = max(w, round(img.width * s)), max(h, round(img.height * s))
    img = img.resize((nw, nh), Image.LANCZOS)
    x, y = (nw - w) // 2, (nh - h) // 2
    return np.asarray(img.crop((x, y, x + w, y + h)).convert('RGB'), dtype=np.float32)


class ClipReader:
    """Frames of one clip by source time, decoded forward only (seeks once, at the in point)."""

    def __init__(self, path: str, t_in: float, w: int, h: int):
        self.c = av.open(path)
        self.s = self.c.streams.video[0]
        self.s.thread_type = 'AUTO'
        self.w, self.h = w, h
        if t_in > 0.5:
            self.c.seek(int(max(0, t_in - 1) / self.s.time_base), stream=self.s, backward=True)
        self.frames = self.c.decode(self.s)
        self.cur = None  # (time, array)
        self.nxt = None
        self.done = False

    def _pull(self):
        if self.done:
            return None
        try:
            f = next(self.frames)
        except (StopIteration, av.error.EOFError):
            self.done = True
            return None
        t = float(f.pts * self.s.time_base) if f.pts is not None else 0.0
        return (t, f)

    def at(self, t: float) -> np.ndarray:
        """The frame showing at source time t (the last one that started at or before it)."""
        if self.nxt is None and not self.done:
            self.nxt = self._pull()
        while self.nxt is not None and self.nxt[0] <= t + 1e-4:
            self.cur = self.nxt
            self.nxt = self._pull()
        if self.cur is None:  # t before the first frame
            self.cur = self.nxt
        if self.cur is None:
            return np.zeros((self.h, self.w, 3), np.float32)
        if not isinstance(self.cur[1], np.ndarray):
            self.cur = (self.cur[0], fit(self.cur[1].to_image(), self.w, self.h))
        return self.cur[1]

    def close(self):
        self.c.close()


def read_audio(path: str, t_in: float, t_out: float) -> np.ndarray | None:
    """Stereo float32 samples at 48 kHz for [t_in, t_out) of a file's first audio stream, or None."""
    try:
        c = av.open(path)
    except Exception:
        return None
    try:
        if not c.streams.audio:
            return None
        s = c.streams.audio[0]
        rs = av.AudioResampler(format='fltp', layout='stereo', rate=SR)
        if t_in > 1:
            c.seek(int(max(0, t_in - 1) / s.time_base), stream=s, backward=True)
        chunks, start_t = [], None
        for f in c.decode(s):
            t = float(f.pts * s.time_base) if f.pts is not None else 0.0
            if start_t is None:
                start_t = t
            for r in rs.resample(f):
                chunks.append(r.to_ndarray())
            if t > t_out + 0.5:
                break
        for r in rs.resample(None):
            chunks.append(r.to_ndarray())
        if not chunks:
            return None
        a = np.concatenate(chunks, axis=1).astype(np.float32)
        a0 = int(round((t_in - (start_t or 0)) * SR))
        n = int(round((t_out - t_in) * SR))
        a = a[:, max(0, a0):max(0, a0) + n]
        if a0 < 0:
            a = np.concatenate([np.zeros((2, -a0), np.float32), a], axis=1)[:, :n]
        return a
    finally:
        c.close()


def main():
    job = json.load(open(sys.argv[1], encoding='utf-8'))
    W, H, FPS = job['width'], job['height'], job['fps']
    clips = sorted(job['clips'], key=lambda c: c['start'])
    total = job['duration']
    n = max(1, int(round(total * FPS)))

    # --- picture -----------------------------------------------------------------------------------------------
    out = av.open(job['out'], 'w')
    vs = out.add_stream('libx264', rate=Fraction(FPS).limit_denominator(1001))
    vs.width, vs.height, vs.pix_fmt = W, H, 'yuv420p'
    vs.options = {'crf': str(job.get('crf', 18)), 'preset': 'medium'}
    aus = out.add_stream('aac', rate=SR)
    aus.layout = 'stereo'
    aus.bit_rate = 192000

    readers = {}
    poster = last = None
    for k in range(n):
        t = k / FPS
        live = [c for c in clips if c['start'] <= t < c['start'] + (c['out'] - c['in'])]
        for c in list(readers):  # clips that have finished
            if not any(x['id'] == c for x in live):
                readers.pop(c).close()
        frame = np.zeros((H, W, 3), np.float32)
        if live:
            top = live[-1]
            def img(c):
                if c['id'] not in readers:
                    readers[c['id']] = ClipReader(c['path'], c['in'] + (t - c['start']), W, H)
                return readers[c['id']].at(c['in'] + (t - c['start']))
            frame = img(top)
            if len(live) > 1:
                under = live[-2]
                end_under = under['start'] + (under['out'] - under['in'])
                mix = min(1.0, (t - top['start']) / max(1e-6, end_under - top['start']))
                frame = img(under) * (1 - mix) + frame * mix
        rgb = np.clip(frame, 0, 255).astype(np.uint8)
        if k == 0:
            poster = rgb
        last = rgb
        vf = av.VideoFrame.from_ndarray(rgb, format='rgb24')
        for p in vs.encode(vf):
            out.mux(p)
        if k % 12 == 0 or k == n - 1:
            print(f'progress {k + 1} {n}', flush=True)
    for r in readers.values():
        r.close()
    for p in vs.encode():
        out.mux(p)

    # --- sound -------------------------------------------------------------------------------------------------
    mixbuf = np.zeros((2, int(round(n / FPS * SR)) + 1), np.float32)

    def place(a, start, gain_env=None):
        i = int(round(start * SR))
        if a is None or i >= mixbuf.shape[1]:
            return
        a = a[:, : mixbuf.shape[1] - i]
        if gain_env is not None:
            a = a * gain_env[: a.shape[1]]
        mixbuf[:, i:i + a.shape[1]] += a

    for j, c in enumerate(clips):
        if c.get('muted'):
            continue
        a = read_audio(c['path'], c['in'], c['out'])
        if a is None:
            continue
        env = np.ones(a.shape[1], np.float32)
        # crossfades: fade in over the overlap with the clip before, fade out over the overlap with the clip after
        if j > 0:
            p = clips[j - 1]
            ov = p['start'] + (p['out'] - p['in']) - c['start']
            if ov > 0:
                m = min(a.shape[1], int(ov * SR))
                env[:m] *= np.linspace(0, 1, m, dtype=np.float32)
        if j + 1 < len(clips):
            q = clips[j + 1]
            ov = c['start'] + (c['out'] - c['in']) - q['start']
            if ov > 0:
                m = min(a.shape[1], int(ov * SR))
                env[a.shape[1] - m:] *= np.linspace(1, 0, m, dtype=np.float32)
        place(a, c['start'], env)
    for s in job.get('sounds', []):
        a = read_audio(s['path'], s['in'], s['out'])
        if a is not None:
            place(a * float(s.get('volume', 1)), s['start'])
    peak = float(np.abs(mixbuf).max()) if mixbuf.size else 0
    if peak > 1:  # never clip: bring a loud mix down as a whole
        mixbuf /= peak
    step = 1024
    for i in range(0, mixbuf.shape[1], step):
        af = av.AudioFrame.from_ndarray(np.ascontiguousarray(mixbuf[:, i:i + step]), format='fltp', layout='stereo')
        af.sample_rate = SR
        af.pts = i
        for p in aus.encode(af):
            out.mux(p)
    for p in aus.encode():
        out.mux(p)
    out.close()

    Image.fromarray(poster).save(job['poster'])
    Image.fromarray(last).save(job['last'])
    print('done', flush=True)


if __name__ == '__main__':
    main()
