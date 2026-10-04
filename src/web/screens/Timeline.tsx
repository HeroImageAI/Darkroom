import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Download, Film, ImagePlus, Loader2, Music, Pause, Play, Plus, Redo2, Scissors, SkipBack, Sparkles, Trash2, Undo2, Upload, Volume2, VolumeX, X } from 'lucide-react';
import { LibraryPicker } from '../components/LibraryPicker';
import { api, fileUrl, inputUrl, thumbUrl, type Item } from '../api';
import { formatDuration, ProgressBar, Segmented, timecode } from '../components/common';
import { openLibrary } from '../lib/remove';
import { go } from '../router';
import { getState, onTimeline, toast, useApp } from '../store';
import {
  clipsAt,
  closeGaps,
  crossfade,
  duration as docDuration,
  emptyTimeline,
  endOf,
  exportSize,
  fadeInOf,
  lengthOf,
  moveTo,
  ordered,
  rippleDelete,
  snap,
  snapPoints,
  split,
  trim,
  GEN_MAX,
  GEN_MIN,
  type GenerateRequest,
  type TimelineClip,
  type TimelineDoc,
  type TimelineSize,
  type TimelineSound,
} from '../../shared/timeline';

/**
 * Timeline (DECISIONS 103): put a film together from Library clips and your own sound, then export one MP4.
 * The AI tools (fill a gap, extend, retake, key moments, sound to picture) build on this screen next.
 */
interface Saved {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
}
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const SIZES: { value: TimelineSize; label: string }[] = [
  { value: 'auto', label: 'Like the first clip' },
  { value: '1280x720', label: '1280×720 (16:9)' },
  { value: '1920x1080', label: '1920×1080 (16:9)' },
  { value: '720x1280', label: '720×1280 (9:16)' },
  { value: '1080x1920', label: '1080×1920 (9:16)' },
  { value: '1024x1024', label: '1024×1024 (1:1)' },
];
const DRAG_ITEM = 'application/x-darkroom-item';

export function Timeline({ id }: { id?: string }) {
  return id ? <TimelineEditor key={id} id={id} /> : <TimelineStart />;
}

async function createTimeline(doc: TimelineDoc = emptyTimeline()): Promise<void> {
  const id = crypto.randomUUID();
  const taken = new Set((await api.get<Saved[]>('/api/timelines')).map((t) => t.name));
  let n = 1;
  while (taken.has(`Film ${n}`)) n++;
  await api.put(`/api/timelines/${id}`, { name: `Film ${n}`, doc });
  go('timeline', id);
}

// ---------------------------------------------------------------------------------------------------------------
// Start: a new film, or one of the saved ones

function TimelineStart() {
  const [list, setList] = useState<Saved[] | null>(null);
  const load = useCallback(() => {
    api
      .get<Saved[]>('/api/timelines')
      .then(setList)
      .catch(() => setList([]));
  }, []);
  useEffect(load, [load]);
  const remove = async (t: Saved) => {
    await api.post(`/api/timelines/${t.id}/delete`);
    load();
    toast(`"${t.name}" deleted.`, 'info', 8000, { label: 'Undo', run: () => void api.post(`/api/timelines/${t.id}/restore`).then(load) });
  };
  return (
    <div className="screen home" style={{ gridTemplateColumns: '1fr', overflowY: 'auto' }}>
      <div className="home-inner">
        <h1 className="home-title">Timeline</h1>
        <p className="note" style={{ fontSize: 14, maxWidth: 720, marginTop: -8 }}>
          Put your takes, your own videos and your own sound together into one film: trim, split, crossfade, add music or a voice, and export an MP4.
        </p>
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={() => void createTimeline().catch((e) => toast((e as Error).message, 'error'))}>
          <Plus size={16} /> New film
        </button>
        <h2 className="section-label" style={{ marginTop: 28 }}>
          Your films {list && <span className="mono">{list.length}</span>}
        </h2>
        {list === null ? (
          <p className="note">Loading…</p>
        ) : !list.length ? (
          <p className="note">Nothing saved yet. Films save themselves as you work.</p>
        ) : (
          <div className="tl-list" role="list">
            {list.map((t) => (
              <div key={t.id} className="tl-list-item" role="listitem">
                <button className="btn ghost" style={{ flex: 1, justifyContent: 'flex-start' }} onClick={() => go('timeline', t.id)} aria-label={`Open ${t.name}`}>
                  <Film size={16} /> {t.name}
                  <small className="note" style={{ marginLeft: 8 }}>
                    {new Date(t.updated_at).toLocaleString()}
                  </small>
                </button>
                <button className="btn ghost sm icon" onClick={() => void remove(t)} aria-label={`Delete ${t.name}`} title="Delete film (your clips stay in the Library)">
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Editor

type Sel = { kind: 'clip' | 'sound' | 'pending'; id: string } | { kind: 'gap'; start: number; end: number } | null;
type Drag =
  | { kind: 'move'; track: 'clip' | 'sound'; id: string; x0: number; start0: number; before: TimelineDoc }
  | { kind: 'trim'; track: 'clip' | 'sound'; id: string; edge: 'left' | 'right'; before: TimelineDoc }
  | { kind: 'scrub' };

function TimelineEditor({ id }: { id: string }) {
  const [name, setName] = useState('');
  const [doc, setDocState] = useState<TimelineDoc | null>(null);
  const [missing, setMissing] = useState(false);
  const [items, setItems] = useState<Record<string, Item>>({});
  const [sel, setSel] = useState<Sel>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(60); // pixels per second
  const [past, setPast] = useState<TimelineDoc[]>([]);
  const [future, setFuture] = useState<TimelineDoc[]>([]);
  const drag = useRef<Drag | null>(null);
  const exp = useApp((s) => s.exports[id]);
  const online = useApp((s) => s.status?.comfy === 'online');

  // ---- load, autosave ---------------------------------------------------------------------------------------
  useEffect(() => {
    api
      .get<Saved & { doc: TimelineDoc }>(`/api/timelines/${id}`)
      .then((r) => {
        setName(r.name);
        setDocState(r.doc);
      })
      .catch(() => setMissing(true));
  }, [id]);
  useEffect(
    () =>
      onTimeline((msg) => {
        if (msg.id !== id) return;
        setDocState(msg.doc as TimelineDoc);
      }),
    [id],
  );
  const need = useMemo(() => [...new Set(doc?.clips.map((c) => c.itemId) ?? [])].filter((x) => !items[x]), [doc, items]);
  useEffect(() => {
    for (const itemId of need)
      api
        .item(itemId)
        .then((r) => setItems((m) => ({ ...m, [itemId]: r.item })))
        .catch(() => undefined);
  }, [need]);
  const saved = useRef('');
  useEffect(() => {
    if (!doc) return;
    const body = JSON.stringify({ name, doc });
    if (body === saved.current) return;
    const h = setTimeout(() => {
      api
        .put(`/api/timelines/${id}`, { name, doc })
        .then(() => (saved.current = body))
        .catch((e) => toast('Could not save the film: ' + (e as Error).message, 'error'));
    }, 600);
    return () => clearTimeout(h);
  }, [doc, name, id]);

  /** Change the document; `history` false for the live steps of a drag (the drag commits once at the end). */
  const setDoc = (next: TimelineDoc, history = true, before?: TimelineDoc) => {
    if (history && doc) {
      setPast((p) => [...p.slice(-80), before ?? doc]);
      setFuture([]);
    }
    setDocState(next);
  };
  const undo = () => {
    if (!past.length || !doc) return;
    setFuture((f) => [doc, ...f]);
    setDocState(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
  };
  const redo = () => {
    if (!future.length || !doc) return;
    setPast((p) => [...p, doc]);
    setDocState(future[0]);
    setFuture((f) => f.slice(1));
  };

  const total = doc ? docDuration(doc) : 0;
  const srcLen = (c: TimelineClip) => items[c.itemId]?.duration ?? c.out;
  const selClip = sel?.kind === 'clip' ? doc?.clips.find((c) => c.id === sel.id) : undefined;
  const selSound = sel?.kind === 'sound' ? doc?.sounds.find((s) => s.id === sel.id) : undefined;
  const selPending = sel?.kind === 'pending' ? doc?.pending?.find((p) => p.id === sel.id) : undefined;
  const selGap = sel?.kind === 'gap' ? sel : undefined;
  const selId = sel && 'id' in sel ? sel.id : null;
  const jobs = useApp((s) => s.jobs);

  /** The empty stretch of the video track around time t (to fill), or null when t is on a clip. */
  const gapAt = (time: number): { start: number; end: number } | null => {
    if (!doc) return null;
    const list = ordered(doc.clips);
    if (list.some((c) => time >= c.start && time < endOf(c)) || (doc.pending ?? []).some((p) => time >= p.start && time < p.start + p.length)) return null;
    const before = Math.max(0, ...list.filter((c) => endOf(c) <= time).map(endOf), ...(doc.pending ?? []).filter((p) => p.start + p.length <= time).map((p) => p.start + p.length));
    const after = Math.min(...list.filter((c) => c.start > time).map((c) => c.start), ...(doc.pending ?? []).filter((p) => p.start > time).map((p) => p.start));
    return { start: before, end: Number.isFinite(after) ? after : before + 5 };
  };

  /** Save the film as it is, then ask the server to make a clip for it (fill, extend, retake). */
  const generate = async (request: GenerateRequest, opts: GenOptions) => {
    if (!doc) return;
    try {
      await api.put(`/api/timelines/${id}`, { name, doc });
      const r = await api.post<{ doc: TimelineDoc }>(`/api/timelines/${id}/generate`, { request, ...opts });
      setDoc(r.doc);
      const p = r.doc.pending?.[r.doc.pending.length - 1];
      if (p) setSel({ kind: 'pending', id: p.id });
      toast('Rendering with LTX 2.5; the clip drops into place when it is done. You can keep editing.', 'info', 7000);
    } catch (e) {
      toast((e as Error).message, 'error', 10000);
    }
  };
  const removePending = (pid: string) => {
    if (!doc) return;
    const p = doc.pending?.find((x) => x.id === pid);
    if (p && ['queued', 'running'].includes(jobs[p.jobId]?.status ?? '')) void api.cancel(p.jobId).catch(() => undefined);
    // a retake you stop puts its clip back whole
    const was = p?.was;
    const clips = was ? [...doc.clips.filter((c) => !(c.itemId === was.itemId && c.start >= was.start - 1e-3 && endOf(c) <= endOf(was) + 1e-3)), was] : doc.clips;
    setDoc({ ...doc, clips, pending: (doc.pending ?? []).filter((x) => x.id !== pid) });
    setSel(null);
  };

  // ---- editing actions --------------------------------------------------------------------------------------
  const addClip = (item: Item, at?: number) => {
    if (!doc) return;
    const len = item.duration ?? 5;
    const start = at ?? Math.max(0, ...doc.clips.map(endOf));
    const c: TimelineClip = { id: uid(), itemId: item.id, start: Math.max(0, start), in: 0, out: Math.round(len * 1000) / 1000 };
    setItems((m) => ({ ...m, [item.id]: item }));
    setDoc({ ...doc, clips: [...doc.clips, c] });
    setSel({ kind: 'clip', id: c.id });
  };
  const addSound = async (file: File) => {
    if (!doc) return;
    if (!online) return toast('Start ComfyUI first (top right): your sound is stored through it.', 'info');
    try {
      const len = await mediaDuration(URL.createObjectURL(file));
      const up = await api.upload(file, file.name);
      const s: TimelineSound = { id: uid(), file: up.name, name: file.name.replace(/\.[^.]+$/, '').slice(0, 60), start: t, in: 0, out: len, duration: len, volume: 1 };
      setDoc({ ...doc, sounds: [...doc.sounds, s] });
      setSel({ kind: 'sound', id: s.id });
    } catch {
      toast(`Could not read ${file.name} as sound. Use MP3, WAV, M4A or a video with sound.`, 'error');
    }
  };
  const removeSel = (ripple = false) => {
    if (!doc || !sel || sel.kind === 'gap') return;
    if (sel.kind === 'pending') return removePending(sel.id);
    if (sel.kind === 'clip') setDoc(ripple ? rippleDelete(doc, sel.id) : { ...doc, clips: doc.clips.filter((c) => c.id !== sel.id) });
    else setDoc({ ...doc, sounds: doc.sounds.filter((s) => s.id !== sel.id) });
    setSel(null);
  };
  const splitAtPlayhead = () => {
    if (!doc) return;
    // the selected clip or sound if the playhead is on it, else the clip under the playhead
    const target: { kind: 'clip' | 'sound'; it: TimelineClip | TimelineSound } | null =
      selClip && t > selClip.start && t < endOf(selClip)
        ? { kind: 'clip', it: selClip }
        : selSound && t > selSound.start && t < endOf(selSound)
          ? { kind: 'sound', it: selSound }
          : (() => {
              const top = clipsAt(doc, t).top;
              return top ? { kind: 'clip' as const, it: top } : null;
            })();
    if (!target) return toast('Put the playhead over a clip to split it.', 'info');
    const parts = split(target.it, t, uid());
    if (!parts) return toast('Too close to the edge of the clip to split there.', 'info');
    if (target.kind === 'clip') setDoc({ ...doc, clips: [...doc.clips.filter((c) => c.id !== target.it.id), ...(parts as TimelineClip[])] });
    else setDoc({ ...doc, sounds: [...doc.sounds.filter((s) => s.id !== target.it.id), ...(parts as TimelineSound[])] });
    setSel({ kind: target.kind, id: parts[1].id });
  };
  const patchClip = (cid: string, p: Partial<TimelineClip>) => doc && setDoc({ ...doc, clips: doc.clips.map((c) => (c.id === cid ? { ...c, ...p } : c)) });
  const patchSound = (sid: string, p: Partial<TimelineSound>) => doc && setDoc({ ...doc, sounds: doc.sounds.map((s) => (s.id === sid ? { ...s, ...p } : s)) });

  // ---- playback ---------------------------------------------------------------------------------------------
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const next = tRef.current + (now - last) / 1000;
      last = now;
      if (next >= total) {
        setT(total);
        setPlaying(false);
        return;
      }
      setT(next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, total]);
  const togglePlay = () => {
    if (!playing && t >= total - 0.01) setT(0);
    setPlaying((p) => !p);
  };

  // ---- keys -------------------------------------------------------------------------------------------------
  const keys = useRef({ togglePlay, splitAtPlayhead, removeSel, undo, redo, setT, total, fps: doc?.fps ?? 24 });
  keys.current = { togglePlay, splitAtPlayhead, removeSel, undo, redo, setT, total, fps: doc?.fps ?? 24 };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // text fields keep their keys; a checkbox or button just clicked does not
      const el = e.target as HTMLElement;
      const typing = el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT' || (el?.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes((el as HTMLInputElement).type));
      if (typing) return;
      const st = keys.current;
      if (e.key === ' ') (e.preventDefault(), st.togglePlay());
      else if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey) st.splitAtPlayhead();
      else if (e.key === 'Delete' || e.key === 'Backspace') (e.preventDefault(), st.removeSel(e.shiftKey));
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') (e.preventDefault(), e.shiftKey ? st.redo() : st.undo());
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') (e.preventDefault(), st.redo());
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const d = (e.shiftKey ? 1 : 1 / st.fps) * (e.key === 'ArrowLeft' ? -1 : 1);
        st.setT((x) => Math.min(st.total, Math.max(0, x + d)));
      } else if (e.key === 'Home') st.setT(0);
      else if (e.key === 'End') st.setT(st.total);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // ---- timeline pointer handling ----------------------------------------------------------------------------
  const lanes = useRef<HTMLDivElement>(null);
  const timeAt = (clientX: number) => {
    const r = lanes.current!.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + lanes.current!.scrollLeft) / zoom);
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || !doc) return;
    if (d.kind === 'scrub') return setT(Math.min(Math.max(total, 0), timeAt(e.clientX)));
    const list = d.track === 'clip' ? d.before.clips : d.before.sounds;
    const it = list.find((x) => x.id === d.id);
    if (!it) return;
    let next: TimelineClip | TimelineSound;
    if (d.kind === 'move') next = { ...it, start: moveTo(d.before, it, d.start0 + (e.clientX - d.x0) / zoom, tRef.current, 10 / zoom) };
    else {
      const to = snap(timeAt(e.clientX), snapPoints(d.before, it.id, tRef.current), 10 / zoom);
      next = trim(it, d.edge, to, d.track === 'clip' ? srcLen(it as TimelineClip) : (it as TimelineSound).duration);
    }
    setDoc(d.track === 'clip' ? { ...d.before, clips: d.before.clips.map((c) => (c.id === d.id ? (next as TimelineClip) : c)) } : { ...d.before, sounds: d.before.sounds.map((s) => (s.id === d.id ? (next as TimelineSound) : s)) }, false);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (d && d.kind !== 'scrub' && doc) setDoc(docRef.current!, true, d.before);
  };
  const docRef = useRef(doc);
  docRef.current = doc;
  const startDrag = (e: React.PointerEvent, d: Drag) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = d;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  const scrubStart = (e: React.PointerEvent) => {
    setPlaying(false);
    setT(Math.min(total, timeAt(e.clientX)));
    startDrag(e, { kind: 'scrub' });
  };

  // ---- export -----------------------------------------------------------------------------------------------
  const exporting = exp && exp.progress >= 0 && exp.progress < 1;
  const doExport = async () => {
    if (!doc?.clips.length) return toast('Put at least one clip on the timeline first.', 'info');
    try {
      // the latest edits first
      await api.put(`/api/timelines/${id}`, { name, doc });
      const item = await api.post<Item>(`/api/timelines/${id}/export`, { boardId: getState().board });
      toast(`"${name}" exported (${formatDuration(item.duration)}). It is in your Library.`, 'ok', 10000, { label: 'Open Library', run: () => openLibrary('videos') });
    } catch (e) {
      toast((e as Error).message, 'error', 12000);
    }
  };

  if (missing)
    return (
      <div className="empty" style={{ margin: 'auto' }}>
        <h2>This film is not here any more</h2>
        <button className="btn" onClick={() => go('timeline')}>
          All films
        </button>
      </div>
    );
  if (!doc) return <div className="empty" style={{ margin: 'auto' }}>Loading the film…</div>;

  const size = exportSize(doc, (itemId) => {
    const it = items[itemId];
    return it?.width && it.height ? { width: it.width, height: it.height } : null;
  });
  const width = Math.max(total + 10, 30) * zoom;
  const tick = zoom >= 80 ? 1 : zoom >= 30 ? 2 : zoom >= 12 ? 5 : 10;

  return (
    <div className="screen tl" style={{ gridTemplateColumns: '280px minmax(0, 1fr) 300px', gridTemplateRows: '1fr' }}>
      <ClipBin onAdd={(it) => addClip(it)} onSound={(f) => void addSound(f)} />

      <section className="tl-main" aria-label="Film">
        <div className="tl-bar">
          <button className="btn ghost sm" onClick={() => go('timeline')}>
            <ArrowLeft size={14} /> All films
          </button>
          <input className="input" aria-label="Film name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: "1 1 140px", maxWidth: 240, minWidth: 120 }} />
          <select className="input" aria-label="Export size" value={doc.size} onChange={(e) => setDoc({ ...doc, size: e.target.value as TimelineSize })} style={{ flex: "0 1 180px", minWidth: 140 }}>
            {SIZES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <span className="mono muted" style={{ fontSize: 12 }}>
            {size.width}×{size.height} · {doc.fps} fps
          </span>
          <div style={{ flex: 1 }} />
          {exporting ? (
            <div style={{ width: 200 }} aria-label="Export progress">
              <ProgressBar value={exp.progress} />
            </div>
          ) : null}
          <button className="btn primary" onClick={() => void doExport()} disabled={!online || !!exporting || !doc.clips.length} title="One MP4 of the whole film (H.264, the clips' sound and your sound mixed), saved to your Library">
            {exporting ? <Loader2 size={15} className="spin" /> : <Download size={15} />} {exporting ? `Exporting ${Math.round(exp.progress * 100)}%` : 'Export MP4'}
          </button>
        </div>

        <Preview doc={doc} t={t} playing={playing} size={size} />

        <div className="tl-transport" role="toolbar" aria-label="Transport">
          <button className="btn sm icon" onClick={() => setT(0)} aria-label="To the start" title="To the start (Home)">
            <SkipBack size={15} />
          </button>
          <button className="btn sm" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} title="Play / pause (Space)">
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <span className="mono" style={{ fontSize: 13 }}>
            {timecode(t)} / {timecode(total)}
          </span>
          <div style={{ flex: 1 }} />
          <button className="btn sm" onClick={splitAtPlayhead} title="Split the clip at the playhead (S)">
            <Scissors size={14} /> Split
          </button>
          <button className="btn sm" onClick={() => setDoc(closeGaps(doc))} disabled={!doc.clips.length} title="Pull every clip together, keeping crossfades">
            Close gaps
          </button>
          <button className="btn sm icon" onClick={undo} disabled={!past.length} aria-label="Undo" title="Undo (Ctrl+Z)">
            <Undo2 size={15} />
          </button>
          <button className="btn sm icon" onClick={redo} disabled={!future.length} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
            <Redo2 size={15} />
          </button>
          <label className="tl-zoom">
            <span className="sr">Zoom</span>
            <input type="range" min={6} max={200} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Zoom" />
          </label>
        </div>

        <div
          className="tl-lanes"
          ref={lanes}
          onDragOver={(e) => [...e.dataTransfer.types].includes(DRAG_ITEM) && e.preventDefault()}
          onDrop={(e) => {
            const raw = e.dataTransfer.getData(DRAG_ITEM);
            if (!raw) return;
            e.preventDefault();
            const itemId = raw.startsWith('{') ? (JSON.parse(raw) as { id: string }).id : raw;
            const at = snap(timeAt(e.clientX), snapPoints(doc, null, t), 10 / zoom);
            const known = items[itemId];
            (known ? Promise.resolve(known) : api.item(itemId).then((r) => r.item))
              .then((it) => (it.kind === 'video' ? addClip(it, at) : toast('Only videos go on the video track. Animate a picture on Video first.', 'info')))
              .catch(() => undefined);
          }}
        >
          <div style={{ width, position: 'relative' }}>
            <div className="tl-ruler" onPointerDown={scrubStart} aria-label="Ruler: click or drag to move the playhead">
              {Array.from({ length: Math.ceil(width / zoom / tick) + 1 }, (_, i) => (
                <span key={i} style={{ left: i * tick * zoom }}>
                  {formatRuler(i * tick)}
                </span>
              ))}
            </div>
            <div
              className="tl-lane"
              aria-label="Video track"
              role="list"
              onPointerDown={(e) => {
                if (e.target !== e.currentTarget) return;
                const g = gapAt(timeAt(e.clientX));
                setSel(g ? { kind: 'gap', ...g } : null);
              }}
            >
              {selGap && <div className="tl-gap" style={{ left: selGap.start * zoom, width: (selGap.end - selGap.start) * zoom }} aria-label="Selected gap" />}
              {(doc.pending ?? []).map((p) => {
                const job = jobs[p.jobId];
                const failed = job && ['failed', 'cancelled', 'lost', 'error'].includes(job.status);
                return (
                  <div
                    key={p.id}
                    role="listitem"
                    className={`tl-pending${failed ? ' failed' : ''}${sel?.kind === 'pending' && sel.id === p.id ? ' selected' : ''}`}
                    aria-label={`${p.label}${failed ? ' (failed)' : ''}`}
                    style={{ left: p.start * zoom, width: Math.max(4, p.length * zoom) }}
                    onPointerDown={(e) => (e.stopPropagation(), setSel({ kind: 'pending', id: p.id }))}
                  >
                    <span className="tl-clip-name">
                      {failed ? 'Failed: select to remove' : `${p.label}… ${job?.status === 'running' ? Math.round((job.progress ?? 0) * 100) + '%' : 'waiting'}`}
                    </span>
                  </div>
                );
              })}
              <span className="tl-lane-label">
                <Film size={12} /> Video
              </span>
              {ordered(doc.clips).map((c) => {
                const it = items[c.itemId];
                const fade = fadeInOf(doc, c.id);
                return (
                  <div
                    key={c.id}
                    role="listitem"
                    className={`tl-clip${selId === c.id ? ' selected' : ''}${c.muted ? ' muted' : ''}`}
                    aria-label={`Clip ${it?.prompt?.slice(0, 40) || ''}`}
                    data-id={c.id}
                    style={{ left: c.start * zoom, width: Math.max(4, lengthOf(c) * zoom), backgroundImage: `url(${thumbUrl(c.itemId)})` }}
                    onPointerDown={(e) => {
                      setSel({ kind: 'clip', id: c.id });
                      startDrag(e, { kind: 'move', track: 'clip', id: c.id, x0: e.clientX, start0: c.start, before: doc });
                    }}
                  >
                    {fade > 0 && <span className="tl-fade" style={{ width: fade * zoom }} title={`Crossfade ${fade.toFixed(2)} s`} />}
                    <span className="tl-clip-name">{it?.prompt?.slice(0, 60) || '…'}</span>
                    {c.muted && <VolumeX size={12} className="tl-clip-mute" />}
                    <span className="tl-edge left" onPointerDown={(e) => (setSel({ kind: 'clip', id: c.id }), startDrag(e, { kind: 'trim', track: 'clip', id: c.id, edge: 'left', before: doc }))} title="Drag to trim the start" />
                    <span className="tl-edge right" onPointerDown={(e) => (setSel({ kind: 'clip', id: c.id }), startDrag(e, { kind: 'trim', track: 'clip', id: c.id, edge: 'right', before: doc }))} title="Drag to trim the end" />
                  </div>
                );
              })}
              {!doc.clips.length && <span className="tl-hint">Drag videos here from the left, or press + on one.</span>}
            </div>
            <div className="tl-lane sound" aria-label="Sound track" role="list">
              <span className="tl-lane-label">
                <Music size={12} /> Sound
              </span>
              {doc.sounds.map((s) => (
                <div
                  key={s.id}
                  role="listitem"
                  className={`tl-sound${selId === s.id ? ' selected' : ''}`}
                  aria-label={`Sound ${s.name}`}
                  style={{ left: s.start * zoom, width: Math.max(4, lengthOf(s) * zoom) }}
                  onPointerDown={(e) => {
                    setSel({ kind: 'sound', id: s.id });
                    startDrag(e, { kind: 'move', track: 'sound', id: s.id, x0: e.clientX, start0: s.start, before: doc });
                  }}
                >
                  <Waveform file={s.file} from={s.in} to={s.out} />
                  <span className="tl-clip-name">{s.name}</span>
                  <span className="tl-edge left" onPointerDown={(e) => (setSel({ kind: 'sound', id: s.id }), startDrag(e, { kind: 'trim', track: 'sound', id: s.id, edge: 'left', before: doc }))} />
                  <span className="tl-edge right" onPointerDown={(e) => (setSel({ kind: 'sound', id: s.id }), startDrag(e, { kind: 'trim', track: 'sound', id: s.id, edge: 'right', before: doc }))} />
                </div>
              ))}
              {!doc.sounds.length && <span className="tl-hint">Your music or voice: Upload sound on the left.</span>}
            </div>
            <div className="tl-playhead" style={{ left: t * zoom }} aria-hidden />
          </div>
        </div>
      </section>

      <aside className="panel right" aria-label="Inspector">
        <div className="panel-scroll">
          {selClip ? (
            <>
              <p className="section-label">Clip</p>
              <p style={{ margin: 0 }}>{items[selClip.itemId]?.prompt?.slice(0, 160) || '…'}</p>
              <p className="mono muted" style={{ fontSize: 12, margin: 0 }}>
                {timecode(selClip.start)} → {timecode(endOf(selClip))} · {lengthOf(selClip).toFixed(2)} s of {(items[selClip.itemId]?.duration ?? 0).toFixed(2)} s
              </p>
              <label className="check">
                <input type="checkbox" checked={!selClip.muted} onChange={(e) => patchClip(selClip.id, { muted: !e.target.checked })} />
                {selClip.muted ? <VolumeX size={14} /> : <Volume2 size={14} />} The clip's own sound
              </label>
              {ordered(doc.clips)[0]?.id !== selClip.id && (
                <div>
                  <p className="section-label">From the clip before</p>
                  <Segmented
                    label="Transition"
                    options={[
                      { value: 0, label: 'Cut' },
                      { value: 0.5, label: 'Fade ½ s' },
                      { value: 1, label: 'Fade 1 s' },
                    ]}
                    value={[0, 0.5, 1].reduce((b, v) => (Math.abs(v - fadeInOf(doc, selClip.id)) < Math.abs(b - fadeInOf(doc, selClip.id)) ? v : b), 0)}
                    onChange={(v) => setDoc(crossfade(doc, selClip.id, v))}
                  />
                </div>
              )}
              <div className="field-row">
                <button className="btn sm" onClick={splitAtPlayhead}>
                  <Scissors size={14} /> Split at playhead
                </button>
                <button className="btn sm" onClick={() => go('video', undefined, { take: selClip.itemId })} title="Open this clip on Video (Extend, Refine, Restore…)">
                  Open on Video
                </button>
              </div>
              <div className="field-row">
                <button className="btn sm danger" onClick={() => removeSel(false)} title="Remove (Delete)">
                  <Trash2 size={14} /> Remove
                </button>
                <button className="btn sm" onClick={() => removeSel(true)} title="Remove and pull the rest in (Shift+Delete)">
                  Remove and close the gap
                </button>
              </div>
              <ClipAi key={selClip.id} clip={selClip} t={t} doc={doc} onGenerate={generate} />
            </>
          ) : selGap ? (
            <>
              <p className="section-label">
                Gap <span className="mono">{(selGap.end - selGap.start).toFixed(1)} s</span>
              </p>
              <p className="note" style={{ margin: 0 }}>
                {timecode(selGap.start)} → {timecode(selGap.end)}
              </p>
              <GenerateForm
                key={`${selGap.start}-${selGap.end}`}
                title="Fill with AI"
                hint="LTX makes a clip that starts on the last frame before the gap and ends on the first frame after it, exactly as long as the gap."
                seconds={Math.min(GEN_MAX, selGap.end - selGap.start)}
                soundAvailable={doc.sounds.some((x) => x.start <= selGap.start + 0.05 && endOf(x) >= Math.min(selGap.end, selGap.start + GEN_MAX) - 0.05)}
                disabled={fillProblem(doc, selGap)}
                onGenerate={(o) => generate({ kind: 'fill', start: selGap.start, end: Math.min(selGap.end, selGap.start + GEN_MAX) }, o)}
              />
            </>
          ) : selPending ? (
            <>
              <p className="section-label">{selPending.label}</p>
              <p className="note" style={{ margin: 0 }}>
                {timecode(selPending.start)} → {timecode(selPending.start + selPending.length)}
              </p>
              {jobs[selPending.jobId] && ['running', 'queued'].includes(jobs[selPending.jobId].status) && <ProgressBar value={jobs[selPending.jobId].progress ?? 0} />}
              <p className="note">{jobs[selPending.jobId]?.error ?? jobs[selPending.jobId]?.stage ?? 'Waiting for ComfyUI'}</p>
              <button className="btn sm danger" onClick={() => removePending(selPending.id)}>
                <X size={14} /> {['running', 'queued'].includes(jobs[selPending.jobId]?.status ?? '') ? 'Stop and remove' : 'Remove'}
              </button>
            </>
          ) : selSound ? (
            <>
              <p className="section-label">Sound</p>
              <p style={{ margin: 0 }}>{selSound.name}</p>
              <p className="mono muted" style={{ fontSize: 12, margin: 0 }}>
                {timecode(selSound.start)} → {timecode(endOf(selSound))} · {lengthOf(selSound).toFixed(2)} s
              </p>
              <label>
                <span className="section-label">Volume {Math.round(selSound.volume * 100)} %</span>
                <input type="range" min={0} max={150} value={Math.round(selSound.volume * 100)} onChange={(e) => patchSound(selSound.id, { volume: Number(e.target.value) / 100 })} aria-label="Sound volume" style={{ width: '100%' }} />
              </label>
              <div className="field-row">
                <button className="btn sm" onClick={splitAtPlayhead}>
                  <Scissors size={14} /> Split at playhead
                </button>
                <button className="btn sm danger" onClick={() => removeSel(false)}>
                  <Trash2 size={14} /> Remove
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="section-label">Film</p>
              <p style={{ margin: 0 }}>
                {doc.clips.length} clip{doc.clips.length === 1 ? '' : 's'}, {doc.sounds.length} sound{doc.sounds.length === 1 ? '' : 's'} · {timecode(total)}
              </p>
              <ul className="note tl-tips">
                <li>Drag a clip to move it; it snaps to the others and to the playhead.</li>
                <li>Drag a clip's edges to trim it.</li>
                <li>Overlap two clips, or pick Fade, for a crossfade.</li>
                <li>Space plays, S splits, Delete removes, Ctrl+Z undoes, ← → step a frame.</li>
              </ul>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function formatRuler(s: number): string {
  const m = Math.floor(s / 60);
  return m ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}

function mediaDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const a = document.createElement('audio');
    a.preload = 'metadata';
    a.onloadedmetadata = () => (Number.isFinite(a.duration) && a.duration > 0 ? resolve(Math.round(a.duration * 1000) / 1000) : reject(new Error('no duration')));
    a.onerror = () => reject(new Error('unreadable'));
    a.src = url;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Preview: the clip(s) at the playhead, crossfades shown, the sound track playing along

function Preview({ doc, t, playing, size }: { doc: TimelineDoc; t: number; playing: boolean; size: { width: number; height: number } }) {
  const { top, under, mix } = clipsAt(doc, t);
  return (
    <div className="tl-preview" style={{ aspectRatio: `${size.width} / ${size.height}` }} aria-label="Preview">
      {under && <Layer key={under.id} clip={under} t={t} playing={playing} opacity={1} />}
      {top && <Layer key={top.id} clip={top} t={t} playing={playing} opacity={under ? mix : 1} />}
      {!top && <span className="tl-preview-gap">{doc.clips.length ? '' : 'Your film plays here'}</span>}
      {doc.sounds.map((s) => (
        <SoundPlayer key={s.id} sound={s} t={t} playing={playing} />
      ))}
    </div>
  );
}

function Layer({ clip, t, playing, opacity }: { clip: TimelineClip; t: number; playing: boolean; opacity: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const local = clip.in + (t - clip.start);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (!playing || Math.abs(v.currentTime - local) > 0.25) v.currentTime = Math.max(0, local);
    if (playing && v.paused) void v.play().catch(() => undefined);
    if (!playing && !v.paused) v.pause();
  });
  return <video ref={ref} src={fileUrl(clip.itemId)} muted={!!clip.muted} playsInline preload="auto" style={{ opacity }} />;
}

function SoundPlayer({ sound, t, playing }: { sound: TimelineSound; t: number; playing: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const on = t >= sound.start && t < endOf(sound);
  const local = sound.in + (t - sound.start);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    a.volume = Math.min(1, sound.volume);
    if (on && playing) {
      if (Math.abs(a.currentTime - local) > 0.25) a.currentTime = local;
      if (a.paused) void a.play().catch(() => undefined);
    } else if (!a.paused) a.pause();
  });
  return <audio ref={ref} src={inputUrl(sound.file)} preload="auto" />;
}

// ---------------------------------------------------------------------------------------------------------------
// Sound waveform (decoded once per file, drawn for the trimmed part)

const peaksCache = new Map<string, Promise<{ peaks: Float32Array; duration: number }>>();
function peaksOf(file: string) {
  let p = peaksCache.get(file);
  if (!p) {
    p = fetch(inputUrl(file))
      .then((r) => r.arrayBuffer())
      .then((b) => new AudioContext().decodeAudioData(b))
      .then((buf) => {
        const ch = buf.getChannelData(0);
        const n = 2000;
        const step = Math.max(1, Math.floor(ch.length / n));
        const peaks = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          let m = 0;
          for (let j = i * step; j < Math.min(ch.length, (i + 1) * step); j++) m = Math.max(m, Math.abs(ch[j]));
          peaks[i] = m;
        }
        return { peaks, duration: buf.duration };
      });
    peaksCache.set(file, p);
  }
  return p;
}

function Waveform({ file, from, to }: { file: string; from: number; to: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    void peaksOf(file)
      .then(({ peaks, duration }) => {
        const c = ref.current;
        if (!live || !c) return;
        const w = (c.width = c.clientWidth || 100);
        const h = (c.height = c.clientHeight || 40);
        const g = c.getContext('2d')!;
        g.clearRect(0, 0, w, h);
        g.fillStyle = 'rgba(240,180,76,.55)';
        for (let x = 0; x < w; x++) {
          const i = Math.floor(((from + ((to - from) * x) / w) / duration) * peaks.length);
          const v = peaks[Math.min(peaks.length - 1, Math.max(0, i))] * h * 0.9;
          g.fillRect(x, (h - v) / 2, 1, Math.max(1, v));
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  });
  return <canvas ref={ref} className="tl-wave" aria-hidden />;
}

// ---------------------------------------------------------------------------------------------------------------
// Clip bin: Library videos to drag in, and your own sound

function ClipBin({ onAdd, onSound }: { onAdd: (it: Item) => void; onSound: (f: File) => void }) {
  const [videos, setVideos] = useState<Item[] | null>(null);
  const [q, setQ] = useState('');
  const rev = useApp((s) => s.libraryRev);
  const soundRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const h = setTimeout(() => {
      api
        .items({ filter: 'videos', q, limit: 80 })
        .then((r) => setVideos(r.items))
        .catch(() => setVideos([]));
    }, 200);
    return () => clearTimeout(h);
  }, [q, rev]);
  return (
    <aside className="panel" aria-label="Clips">
      <div className="panel-scroll" style={{ gap: 12 }}>
        <p className="section-label">Sound</p>
        <button className="btn" onClick={() => soundRef.current?.click()} title="Music, a voice-over or any video's sound: it goes on the sound track at the playhead">
          <Upload size={15} /> Upload sound
        </button>
        <input ref={soundRef} type="file" accept="audio/*,video/mp4,video/quicktime,.mp3,.wav,.m4a,.aac,.ogg,.flac" hidden aria-label="Upload sound" onChange={(e) => (e.target.files?.[0] && onSound(e.target.files[0]), (e.target.value = ''))} />
        <p className="section-label" style={{ marginTop: 8 }}>
          Your videos {videos && <span className="mono">{videos.length}</span>}
        </p>
        <input className="input" placeholder="Search" aria-label="Search videos" value={q} onChange={(e) => setQ(e.target.value)} />
        {videos === null ? (
          <p className="note">Loading…</p>
        ) : !videos.length ? (
          <p className="note">No videos yet. Make takes on Video, or upload your own in the Library.</p>
        ) : (
          <div className="tl-bin" role="list" aria-label="Videos to add">
            {videos.map((v) => (
              <div key={v.id} role="listitem" className="tl-bin-item" draggable onDragStart={(e) => e.dataTransfer.setData(DRAG_ITEM, v.id)} title="Drag onto the video track">
                <img src={thumbUrl(v.id)} alt="" loading="lazy" draggable={false} />
                <span className="tl-bin-name" title={v.title || v.prompt || undefined}>{v.title || v.prompt?.slice(0, 50) || v.mode}</span>
                <span className="mono tl-bin-len">{v.duration ? `${v.duration.toFixed(1)}s` : ''}</span>
                <button className="btn ghost sm icon" onClick={() => onAdd(v)} aria-label={`Add ${v.prompt?.slice(0, 40) || 'video'} to the end`} title="Add to the end of the film">
                  <Plus size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// AI tools (DECISIONS 104)

export interface GenOptions {
  prompt: string;
  quality: 'draft' | 'final' | 'hd';
  keyMoments: { itemId: string; at: number }[];
  soundSync: boolean;
}

/** Why a gap cannot be filled, or null. */
function fillProblem(doc: TimelineDoc, gap: { start: number; end: number }): string | null {
  if (gap.end - gap.start < GEN_MIN) return `A gap must be at least ${GEN_MIN} s to fill.`;
  if (!doc.clips.some((c) => Math.abs(endOf(c) - gap.start) < 0.05)) return 'Fill needs a clip just before the gap. An opening shot is made on Video.';
  return null;
}

/** Prompt, quality, key moments and "animate to my sound": the shared form of Fill, Extend and Retake. */
function GenerateForm({ title, hint, seconds, soundAvailable, disabled, onGenerate }: { title: string; hint: string; seconds: number; soundAvailable: boolean; disabled?: string | null; onGenerate: (o: GenOptions) => Promise<void> | void }) {
  const [prompt, setPrompt] = useState('');
  const [quality, setQuality] = useState<GenOptions['quality']>('draft');
  const [keys, setKeys] = useState<{ item: Item; at: number }[]>([]);
  const [picking, setPicking] = useState(false);
  const [sound, setSound] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <section className="tl-ai" aria-label={title}>
      <p className="section-label">
        <span>
          <Sparkles size={13} style={{ verticalAlign: '-2px' }} /> {title}
        </span>
      </p>
      <p className="note" style={{ margin: 0 }}>
        {hint}
      </p>
      <textarea className="input" rows={3} aria-label={`${title}: what happens`} placeholder="What happens (motion, action, camera)…" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <Segmented
        label="Quality"
        options={[
          { value: 'draft', label: 'Draft' },
          { value: 'final', label: 'Final' },
          { value: 'hd', label: '1080p' },
        ]}
        value={quality}
        onChange={setQuality}
      />
      <div>
        <p className="section-label" style={{ marginBottom: 4 }}>
          Key moments
        </p>
        {keys.map((k, i) => (
          <div key={i} className="tl-key">
            <img src={thumbUrl(k.item.id)} alt="" />
            <input type="range" min={0} max={seconds} step={0.1} value={k.at} aria-label={`Key moment ${i + 1} time`} onChange={(e) => setKeys((ks) => ks.map((x, j) => (j === i ? { ...x, at: Number(e.target.value) } : x)))} />
            <span className="mono" style={{ fontSize: 11 }}>
              {k.at.toFixed(1)}s
            </span>
            <button className="btn ghost sm icon" onClick={() => setKeys((ks) => ks.filter((_, j) => j !== i))} aria-label={`Remove key moment ${i + 1}`}>
              <X size={13} />
            </button>
          </div>
        ))}
        <button className="btn sm" onClick={() => setPicking(true)} disabled={keys.length >= 4} title="A picture the clip passes through at a chosen moment: best for a pose, action, expression or light change seen from the same viewpoint">
          <ImagePlus size={14} /> Add a picture
        </button>
      </div>
      {soundAvailable && (
        <label className="check" title="Your sound under this stretch drives the picture: lip-sync for a voice, movement on the beat for music. The clip uses your sound.">
          <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Animate to my sound here
        </label>
      )}
      <button
        className="btn primary"
        disabled={!!disabled || busy}
        title={disabled ?? undefined}
        onClick={() => {
          setBusy(true);
          void Promise.resolve(onGenerate({ prompt, quality, keyMoments: keys.map((k) => ({ itemId: k.item.id, at: k.at })), soundSync: sound })).finally(() => setBusy(false));
        }}
      >
        {busy ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} {title} ({seconds.toFixed(1)} s)
      </button>
      {disabled && (
        <p className="note" style={{ margin: 0 }}>
          {disabled}
        </p>
      )}
      {picking && (
        <LibraryPicker
          title="Key moment picture"
          onClose={() => setPicking(false)}
          onPick={(it) => {
            setPicking(false);
            if (it.kind !== 'image') return toast('Key moments are pictures.', 'info');
            setKeys((ks) => [...ks, { item: it, at: Math.round(seconds * 5) / 10 }]);
          }}
        />
      )}
    </section>
  );
}

/** Extend a clip, or retake a moment inside it from the playhead. */
function ClipAi({ clip, t, doc, onGenerate }: { clip: TimelineClip; t: number; doc: TimelineDoc; onGenerate: (r: GenerateRequest, o: GenOptions) => Promise<void> | void }) {
  const [tool, setTool] = useState<'extend' | 'retake'>('extend');
  const [secs, setSecs] = useState(3);
  const [len, setLen] = useState(2);
  const inside = t > clip.start + 0.2 && t < endOf(clip) - 0.2;
  const retakeEnd = Math.min(endOf(clip), t + len);
  const coversSound = (a: number, b: number) => doc.sounds.some((x) => x.start <= a + 0.05 && endOf(x) >= b - 0.05);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <Segmented
        label="AI tool"
        options={[
          { value: 'extend', label: 'Extend' },
          { value: 'retake', label: 'Retake a moment' },
        ]}
        value={tool}
        onChange={setTool}
      />
      {tool === 'extend' ? (
        <>
          <Segmented label="Extend by" options={[2, 3, 5, 8].map((n) => ({ value: n, label: `${n} s` }))} value={secs} onChange={setSecs} />
          <GenerateForm
            key={`e${secs}`}
            title="Extend"
            hint="Carries on from this clip's last frame; what comes after it moves later to make room. Big camera moves (an orbit, a turntable) work best this way."
            seconds={secs}
            soundAvailable={coversSound(endOf(clip), endOf(clip) + secs)}
            onGenerate={(o) => onGenerate({ kind: 'extend', clipId: clip.id, seconds: secs }, o)}
          />
        </>
      ) : (
        <>
          <Segmented label="Retake length" options={[1, 2, 3].map((n) => ({ value: n, label: `${n} s` }))} value={len} onChange={setLen} />
          <GenerateForm
            key={`r${len}`}
            title="Retake"
            hint="Redoes the moment from the playhead: the frames either side of it guide the new take, so it joins up."
            seconds={Math.max(0, retakeEnd - t)}
            soundAvailable={inside && coversSound(t, retakeEnd)}
            disabled={!inside ? 'Put the playhead inside this clip where the moment starts.' : retakeEnd - t < GEN_MIN ? 'Too close to the end of the clip.' : null}
            onGenerate={(o) => onGenerate({ kind: 'retake', clipId: clip.id, from: t, to: retakeEnd }, o)}
          />
        </>
      )}
    </div>
  );
}
