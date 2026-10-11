import { describe, expect, it } from 'vitest';
import { clipsAt, closeGaps, crossfade, duration, emptyTimeline, exactFrames, exportSize, fadeInOf, moveTo, ordered, planGeneration, rippleDelete, sanitiseTimeline, split, trim, type TimelineClip, type TimelineDoc } from '../src/shared/timeline';

const ID = '00000000-0000-4000-8000-000000000001';
const clip = (id: string, start: number, inn: number, out: number): TimelineClip => ({ id, itemId: ID, start, in: inn, out });
const doc = (...clips: TimelineClip[]): TimelineDoc => ({ ...emptyTimeline(), clips });

describe('timeline', () => {
  it('length runs to whatever ends last, sounds included', () => {
    const d = doc(clip('a', 0, 0, 5), clip('b', 6, 1, 3));
    expect(duration(d)).toBe(8);
    expect(duration({ ...d, sounds: [{ id: 's', file: 'x.mp3', name: 'x', start: 2, in: 0, out: 9, duration: 9, volume: 1 }] })).toBe(11);
  });

  it('a gap shows nothing; an overlap is a crossfade from the earlier clip into the later one', () => {
    const d = doc(clip('a', 0, 0, 5), clip('b', 4, 0, 5), clip('c', 10, 0, 2));
    expect(clipsAt(d, 9.5).top).toBeNull();
    const x = clipsAt(d, 4.5);
    expect([x.top?.id, x.under?.id, x.mix]).toEqual(['b', 'a', 0.5]);
    expect(clipsAt(d, 2).under).toBeNull();
  });

  it('moving snaps either edge to a neighbour or the playhead', () => {
    const d = doc(clip('a', 0, 0, 5), clip('b', 7, 0, 3));
    expect(moveTo(d, d.clips[1], 5.1)).toBe(5); // start onto a's end
    expect(moveTo(d, d.clips[1], 2.05, 0)).toBe(2); // end onto a's end (5)
    expect(moveTo(d, d.clips[1], 3.9, 7)).toBe(4); // end onto the playhead
    expect(moveTo(d, d.clips[1], -2)).toBe(0);
  });

  it('trimming the left edge keeps the rest in place; neither edge goes past the source or below the minimum', () => {
    const c = clip('a', 10, 2, 6);
    expect(trim(c, 'left', 11, 8)).toMatchObject({ start: 11, in: 3, out: 6 });
    expect(trim(c, 'left', 5, 8)).toMatchObject({ start: 8, in: 0 }); // only 2 s of source before the in point
    expect(trim(c, 'right', 30, 8)).toMatchObject({ out: 8 });
    expect(trim(c, 'right', 0, 8).out).toBeCloseTo(2.25);
  });

  it('split cuts at the playhead and refuses slivers', () => {
    const [a, b] = split(clip('a', 10, 2, 6), 11.5, 'b')!;
    expect(a).toMatchObject({ start: 10, in: 2, out: 3.5 });
    expect(b).toMatchObject({ id: 'b', start: 11.5, in: 3.5, out: 6 });
    expect(split(clip('a', 10, 2, 6), 10.1, 'b')).toBeNull();
  });

  it('crossfade pulls the clip and everything after it under the previous clip', () => {
    const d = crossfade(doc(clip('a', 0, 0, 5), clip('b', 6, 0, 4), clip('c', 10, 0, 2)), 'b', 0.5);
    expect(d.clips.map((c) => c.start)).toEqual([0, 4.5, 8.5]);
    expect(fadeInOf(d, 'b')).toBe(0.5);
    expect(fadeInOf(crossfade(d, 'b', 0), 'b')).toBe(0); // back to a cut
  });

  it('close gaps keeps order and crossfades', () => {
    const d = closeGaps(doc(clip('a', 1, 0, 5), clip('b', 6.5, 0, 4), clip('c', 10, 0, 2), clip('d', 20, 0, 1)));
    expect(d.clips.map((c) => c.start)).toEqual([0, 5, 8.5, 10.5]); // c overlapped b by 0.5 and still does
  });

  it('ripple delete pulls later clips back', () => {
    const d = rippleDelete(doc(clip('a', 0, 0, 5), clip('b', 5, 0, 3), clip('c', 8, 0, 2)), 'b');
    expect(d.clips.map((c) => [c.id, c.start])).toEqual([['a', 0], ['c', 5]]);
  });
  it('ripple deletion closes a gap when the following clip overlapped the deleted segment', () => {
    const d = rippleDelete(doc(clip('a', 0, 0, 1), clip('b', 1, 1, 3), clip('c', 2.5, 0, 3)), 'b');
    expect(d.clips.map((c) => [c.id, c.start])).toEqual([['a', 0], ['c', 1]]);
    expect(clipsAt(d, 1.5).top?.id).toBe('c');
  });

  it('export size: the first clip, even-sided, or a fixed size', () => {
    const d = doc(clip('a', 3, 0, 1), clip('b', 0, 0, 1));
    expect(exportSize(d, () => ({ width: 1281, height: 703 }))).toEqual({ width: 1282, height: 704 });
    expect(exportSize({ ...d, size: '1080x1920' }, () => null)).toEqual({ width: 1080, height: 1920 });
  });

  it('sanitise keeps a good document and refuses a bad one', () => {
    const good = { ...doc(clip('a', 0, 0, 5)), sounds: [{ id: 's', file: 'darkroom/a.mp3', name: 'a', start: 0, in: 0, out: 3, duration: 3, volume: 2 }] };
    expect(sanitiseTimeline(good)?.sounds[0].volume).toBe(1.5);
    expect(sanitiseTimeline({ ...good, sounds: [{ ...good.sounds[0], file: '../x.mp3' }] })).toBeNull();
    expect(sanitiseTimeline({ ...good, clips: [{ ...good.clips[0], itemId: 'nope' }] })).toBeNull();
  });
});

describe('timeline AI tools: planning', () => {
  const ids = (() => {
    let n = 0;
    return () => `n${++n}`;
  })();
  const H = 4 / 24;
  it('fill: guided by frames a handle inside each neighbour, overlapping both by it; refuses a gap that is not empty or too long', () => {
    const d = doc(clip('a', 0, 1, 5), clip('b', 7, 2, 6));
    const p = planGeneration(d, { kind: 'fill', start: 4, end: 7 }, ids);
    expect(p.start).toBeCloseTo(4 - H, 2);
    expect(p.seconds).toBeCloseTo(3 + 2 * H, 2);
    expect(p.first).toMatchObject({ clipId: 'a' });
    expect(p.first!.t).toBeCloseTo(5 - 1 / 24 - H, 2);
    expect(p.last!.t).toBeCloseTo(2 + H, 2);
    expect(() => planGeneration(d, { kind: 'fill', start: 3, end: 7 }, ids)).toThrow(/not empty/);
    expect(() => planGeneration(doc(clip('a', 0, 0, 2), clip('b', 20, 0, 2)), { kind: 'fill', start: 2, end: 20 }, ids)).toThrow(/1 to 9.5 seconds/);
  });
  it('extend: from a handle before the end of the clip, later clips make room for the stretch asked for', () => {
    const p = planGeneration(doc(clip('a', 0, 0, 4), clip('b', 4, 0, 2), clip('c', 9, 0, 1)), { kind: 'extend', clipId: 'a', seconds: 3 }, ids);
    expect(p.start).toBeCloseTo(4 - H, 2);
    expect(p.seconds).toBeCloseTo(3 + H, 2);
    expect(p.last).toBeNull();
    expect(p.doc.clips.map((c) => c.start)).toEqual([0, 7, 12]);
  });
  it('retake: the moment is cut out of the clip; the new take overlaps both sides by a handle', () => {
    const p = planGeneration(doc(clip('a', 10, 2, 8)), { kind: 'retake', clipId: 'a', from: 11, to: 13.5 }, ids);
    expect(p.start).toBeCloseTo(11 - H, 2);
    expect(p.seconds).toBeCloseTo(2.5 + 2 * H, 2);
    expect(p.first!.t).toBeCloseTo(3 - 1 / 24 - H, 2);
    expect(p.last!.t).toBeCloseTo(5.5 + H, 2);
    expect(ordered(p.doc.clips).map((c) => [c.start, c.in, c.out])).toEqual([
      [10, 2, 3],
      [13.5, 5.5, 8],
    ]);
  });
  it('exact frames: 8n+1 frames with the rate nudged to fill the time', () => {
    expect(exactFrames(3)).toEqual({ frames: 73, fps: 24 });
    const e = exactFrames(2.3);
    expect((e.frames - 1) % 8).toBe(0);
    expect((e.frames - 1) / e.fps).toBeCloseTo(2.3, 2);
  });
});
