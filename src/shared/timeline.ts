/**
 * Timeline (DECISIONS 103): compile your own film from Library clips and your own sound.
 * One video track (clips placed in seconds; where two clips overlap the later one crossfades in over the overlap,
 * a gap plays black) and one sound track (your music or voice, mixed under the clips' own sound).
 * Times are seconds on the timeline; `in` / `out` are seconds inside the source clip.
 */
export interface TimelineClip {
  id: string;
  itemId: string;
  start: number;
  in: number;
  out: number;
  /** the clip's own sound left out of the mix */
  muted?: boolean;
}

export interface TimelineSound {
  id: string;
  /** the file in ComfyUI's input folder */
  file: string;
  name: string;
  start: number;
  in: number;
  out: number;
  /** length of the whole file, for trimming */
  duration: number;
  /** 0–1.5 */
  volume: number;
}

export type TimelineSize = 'auto' | '1280x720' | '1920x1080' | '720x1280' | '1080x1920' | '1024x1024';

export interface TimelineDoc {
  v: 1;
  clips: TimelineClip[];
  sounds: TimelineSound[];
  size: TimelineSize;
  fps: number;
}

export const emptyTimeline = (): TimelineDoc => ({ v: 1, clips: [], sounds: [], size: 'auto', fps: 24 });

/** Shortest piece a trim or split may leave. */
export const MIN_LENGTH = 0.25;
/** Snapping distance in seconds (the screen converts its pixel tolerance to this). */
export const SNAP = 0.15;

const r3 = (v: number) => Math.round(v * 1000) / 1000;
export const lengthOf = (c: { in: number; out: number }) => Math.max(0, c.out - c.in);
export const endOf = (c: { start: number; in: number; out: number }) => c.start + lengthOf(c);

/** Total length: the end of whatever ends last. */
export function duration(doc: TimelineDoc): number {
  return r3(Math.max(0, ...doc.clips.map(endOf), ...doc.sounds.map(endOf)));
}

/** Clips in play order. */
export const ordered = (clips: TimelineClip[]) => [...clips].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));

/** What the video track shows at time t: the top clip (the later start wins) and, inside a crossfade, the one under it. */
export function clipsAt(doc: TimelineDoc, t: number): { top: TimelineClip | null; under: TimelineClip | null; mix: number } {
  const live = ordered(doc.clips).filter((c) => t >= c.start && t < endOf(c));
  const top = live[live.length - 1] ?? null;
  const under = live.length > 1 ? live[live.length - 2] : null;
  // how far the crossfade has got: 0 at the start of the overlap, 1 at its end
  const mix = top && under ? Math.min(1, (t - top.start) / Math.max(1e-6, endOf(under) - top.start)) : 1;
  return { top, under, mix };
}

/** Where the dragged edge or clip may snap: 0, the playhead and every other clip's edges. */
export function snapPoints(doc: TimelineDoc, exceptId: string | null, playhead: number): number[] {
  const pts = [0, playhead];
  for (const c of [...doc.clips, ...doc.sounds]) if (c.id !== exceptId) pts.push(c.start, endOf(c));
  return pts;
}

export function snap(t: number, points: number[], within = SNAP): number {
  let best = t;
  let d = within;
  for (const p of points) if (Math.abs(p - t) < d) (best = p), (d = Math.abs(p - t));
  return best;
}

/** Move a clip (or sound) so it starts at `start`, snapping either of its edges. */
export function moveTo<T extends TimelineClip | TimelineSound>(doc: TimelineDoc, item: T, start: number, playhead = 0, within = SNAP): number {
  const pts = snapPoints(doc, item.id, playhead);
  const len = lengthOf(item);
  const a = snap(start, pts, within);
  const b = snap(start + len, pts, within) - len;
  const best = Math.abs(a - start) <= Math.abs(b - start) ? a : b;
  return r3(Math.max(0, a !== start ? a : b !== start ? b : best));
}

/** Trim one edge. `left` moves the start and the in point together, so the rest of the clip stays where it is. */
export function trim<T extends TimelineClip | TimelineSound>(item: T, edge: 'left' | 'right', to: number, sourceLength: number): T {
  if (edge === 'left') {
    const delta = Math.min(Math.max(to - item.start, -item.in, -item.start), lengthOf(item) - MIN_LENGTH);
    return { ...item, start: r3(item.start + delta), in: r3(item.in + delta) };
  }
  const out = Math.max(item.in + MIN_LENGTH, Math.min(sourceLength, item.out + (to - endOf(item))));
  return { ...item, out: r3(out) };
}

/** Split the clip or sound under time t into two; null when t is too close to an edge. */
export function split<T extends TimelineClip | TimelineSound>(item: T, t: number, newId: string): [T, T] | null {
  const at = t - item.start;
  if (at < MIN_LENGTH || lengthOf(item) - at < MIN_LENGTH) return null;
  const cut = r3(item.in + at);
  return [
    { ...item, out: cut },
    { ...item, id: newId, start: r3(t), in: cut },
  ];
}

/**
 * Crossfade a clip into the one before it: it and everything after it move earlier by `seconds`, so the two overlap
 * by that much (any gap before it is closed first).
 */
export function crossfade(doc: TimelineDoc, id: string, seconds: number): TimelineDoc {
  const list = ordered(doc.clips);
  const i = list.findIndex((c) => c.id === id);
  if (i <= 0) return doc;
  const prev = list[i - 1];
  const want = Math.min(seconds, lengthOf(prev) - MIN_LENGTH, lengthOf(list[i]) - MIN_LENGTH);
  const shift = list[i].start - (endOf(prev) - Math.max(0, want));
  if (Math.abs(shift) < 1e-6) return doc;
  const moved = new Set(list.slice(i).map((c) => c.id));
  return { ...doc, clips: doc.clips.map((c) => (moved.has(c.id) ? { ...c, start: r3(c.start - shift) } : c)) };
}

/** How long a clip crossfades in from the one before it (0 = a cut). */
export function fadeInOf(doc: TimelineDoc, id: string): number {
  const list = ordered(doc.clips);
  const i = list.findIndex((c) => c.id === id);
  return i > 0 ? r3(Math.max(0, endOf(list[i - 1]) - list[i].start)) : 0;
}

/** Close every gap on the video track (clips keep their order and crossfades). */
export function closeGaps(doc: TimelineDoc): TimelineDoc {
  const starts = new Map<string, number>();
  let prevOldEnd = 0;
  let prevNewEnd = 0;
  for (const c of ordered(doc.clips)) {
    const overlap = starts.size ? Math.max(0, prevOldEnd - c.start) : 0; // a crossfade stays a crossfade
    const start = r3(Math.max(0, prevNewEnd - overlap));
    starts.set(c.id, start);
    prevOldEnd = Math.max(prevOldEnd, endOf(c));
    prevNewEnd = Math.max(prevNewEnd, start + lengthOf(c));
  }
  return { ...doc, clips: doc.clips.map((c) => ({ ...c, start: starts.get(c.id)! })) };
}

/** Remove a clip and pull everything after it earlier by its length ("ripple delete"). */
export function rippleDelete(doc: TimelineDoc, id: string): TimelineDoc {
  const c = doc.clips.find((x) => x.id === id);
  if (!c) return doc;
  const len = lengthOf(c);
  return { ...doc, clips: doc.clips.filter((x) => x.id !== id).map((x) => (x.start >= endOf(c) - 1e-6 ? { ...x, start: r3(Math.max(0, x.start - len)) } : x)) };
}

/** The export size: a fixed one, or the first clip's (rounded to even numbers for H.264). */
export function exportSize(doc: TimelineDoc, sizeOf: (itemId: string) => { width: number; height: number } | null): { width: number; height: number } {
  if (doc.size !== 'auto') {
    const [w, h] = doc.size.split('x').map(Number);
    return { width: w, height: h };
  }
  const first = ordered(doc.clips)[0];
  const s = first ? sizeOf(first.itemId) : null;
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return s ? { width: even(s.width), height: even(s.height) } : { width: 1280, height: 720 };
}

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const idOk = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const SIZES: TimelineSize[] = ['auto', '1280x720', '1920x1080', '720x1280', '1080x1920', '1024x1024'];

/** Accept only a well-formed document (the server stores what the browser sends). */
export function sanitiseTimeline(raw: unknown): TimelineDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (!Array.isArray(d.clips) || !Array.isArray(d.sounds) || d.clips.length > 500 || d.sounds.length > 100) return null;
  const clips: TimelineClip[] = [];
  for (const c of d.clips as Record<string, unknown>[]) {
    if (!idOk(c?.id) || typeof c.itemId !== 'string' || !/^[0-9a-f-]{36}$/.test(c.itemId)) return null;
    const inn = num(c.in, 0, 36000, 0);
    clips.push({ id: c.id as string, itemId: c.itemId, start: num(c.start, 0, 36000, 0), in: inn, out: Math.max(inn + 0.01, num(c.out, 0, 36000, inn + 1)), ...(c.muted ? { muted: true } : {}) });
  }
  const sounds: TimelineSound[] = [];
  for (const s of d.sounds as Record<string, unknown>[]) {
    if (!idOk(s?.id) || typeof s.file !== 'string' || /\.\.|\\/.test(s.file) || !s.file) return null;
    const inn = num(s.in, 0, 36000, 0);
    sounds.push({
      id: s.id as string,
      file: s.file,
      name: typeof s.name === 'string' ? s.name.slice(0, 120) : 'Sound',
      start: num(s.start, 0, 36000, 0),
      in: inn,
      out: Math.max(inn + 0.01, num(s.out, 0, 36000, inn + 1)),
      duration: num(s.duration, 0, 36000, 0),
      volume: num(s.volume, 0, 1.5, 1),
    });
  }
  return { v: 1, clips, sounds, size: SIZES.includes(d.size as TimelineSize) ? (d.size as TimelineSize) : 'auto', fps: num(d.fps, 8, 60, 24) };
}
