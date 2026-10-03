"""
One frame of a video as PNG (Timeline AI tools, DECISIONS 104): the frame showing at a given time.
Run with Comfy Desktop's Python: video_frame.py <video> <seconds> <out.png>
"""
import sys

import av


def main():
    path, t, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
    with av.open(path) as c:
        s = c.streams.video[0]
        if t > 1:
            c.seek(int(max(0, t - 1) / s.time_base), stream=s, backward=True)
        best = None
        for f in c.decode(s):
            ft = float(f.pts * s.time_base) if f.pts is not None else 0.0
            if ft <= t + 1e-4 or best is None:
                best = f
            if ft > t:
                break
        if best is None:
            raise SystemExit('no frame')
        best.to_image().save(out)
    print('ok')


if __name__ == '__main__':
    main()
