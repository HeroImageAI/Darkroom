import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Bell, Brush, Camera, Clapperboard, Download, FastForward, ImagePlus, Loader2, Pause, Play, Plus, Repeat, Sparkles, Scissors, Undo2, Volume2, VolumeX, Waves, X } from 'lucide-react';
import { LibraryPicker } from '../components/LibraryPicker';
import { api, ApiError, downloadUrl, fileUrl, inputUrl, thumbUrl, type Item, type Job } from '../api';
import { deleteWithUndo, openLibrary } from '../lib/remove';
import { Dialog, formatDuration, Pills, ProgressBar, randomSeed, Segmented, timecode, useHotkey } from '../components/common';
import { ensureNotifyPermission, notifyDesktop, useItemLoad, usePersistent, useSessionState, useWorkspace } from '../lib/hooks';
import { go } from '../router';
import { onJob, toast, useApp } from '../store';
import { orientationOf, planVideo, type VideoQuality } from '../../shared/manifest';
import { LoraPicker, useLoraCatalogue, type Catalogue } from '../components/LoraPicker';
import type { LoraUse } from '../../shared/loras';
import { composeMotionPrompt, wordCount, type VideoModelKey } from '../../shared/prompts';
import { restoreCanvas, restoredFrames, restoreWindows } from '../../shared/restore';

interface Frame {
  name: string;
  width: number;
  height: number;
  itemId?: string;
}

interface VideoSettings {
  start: Frame | null;
  end: Frame | null;
  motion: string;
  camera: string[];
  model: string;
  seconds: number;
  quality: VideoQuality;
  notify: boolean;
  seed: number;
  /** How frames with a different aspect are fitted: crop to fill (default) or letterbox with bars. */
  frameFit?: 'crop' | 'fit';
  /** Sound (DECISIONS 97): from the scene (LTX's own), your description, or silent. A preference. */
  sound?: 'scene' | 'describe' | 'off';
  /** Your sound description (work in progress, like the motion). */
  soundText?: string;
  /** Effect (DECISIONS 98): slow motion (LoRA + speed) or cinemagraph (LoRA + trigger, locked camera). A preference. */
  effect?: 'none' | 'slowmo' | 'cinemagraph';
  /** Slow-motion speed: 0.5 = half speed, 0.25, 0.1. */
  speed?: number;
  /** Your own LTX 2.5 LoRAs (a preference). */
  loras?: LoraUse[];
}

const DEFAULTS: VideoSettings = { start: null, end: null, motion: '', camera: [], model: 'ltx', seconds: 5, quality: 'draft', notify: true, seed: 0 };

export function Video({ query }: { query: URLSearchParams }) {
  const boot = useApp((s) => s.boot);
  const jobs = useApp((s) => s.jobs);
  const online = useApp((s) => s.status?.comfy === 'online');
  const rev = useApp((s) => s.libraryRev);
  // frames, motion and camera are work in progress (this launch only); model, length, quality… are preferences
  const [s, setS] = useWorkspace<VideoSettings>('video', DEFAULTS, ['start', 'end', 'motion', 'camera', 'seed', 'frameFit', 'soundText']);
  const [selected, setSelected] = useSessionState<string | null>('video.selected', null);
  const [takes, setTakes] = useState<Job[]>([]);
  const [warning, setWarning] = useState<{ text: string; body: Parameters<typeof api.submit>[0] } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [picker, setPicker] = useState<null | 'start' | 'end'>(null);
  const [motionUndo, setMotionUndo] = useState<string[]>([]);
  const selectedLoad = useItemLoad(selected);
  // a take deleted anywhere leaves the screen at once
  const selectedItem = selectedLoad.item && !selectedLoad.item.deleted_at ? selectedLoad.item : null;
  useEffect(() => {
    if (selected && (selectedLoad.missing || selectedLoad.item?.deleted_at)) setSelected(null);
  }, [selected, selectedLoad.missing, selectedLoad.item?.deleted_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (p: Partial<VideoSettings>) => setS((prev) => ({ ...prev, ...p }));
  // a start / end frame picked from the Library goes away when that picture is deleted (it is a copy, so check it)
  const startSrc = useItemLoad(s.start?.itemId ?? null);
  const endSrc = useItemLoad(s.end?.itemId ?? null);
  useEffect(() => {
    const gone = (l: { item: { deleted_at?: number | null } | null; missing: boolean }) => l.missing || !!l.item?.deleted_at;
    if (s.start?.itemId && gone(startSrc)) update({ start: null });
    if (s.end?.itemId && gone(endSrc)) update({ end: null });
  }, [startSrc.missing, startSrc.item?.deleted_at, endSrc.missing, endSrc.item?.deleted_at]); // eslint-disable-line react-hooks/exhaustive-deps

  /** New: an empty workspace (frames, motion, camera, take on screen); preferences stay. Undo puts it back. */
  const startNew = () => {
    const before = { s, selected };
    setS((p) => ({ ...p, start: null, end: null, motion: '', camera: [], seed: 0, frameFit: undefined }));
    setSelected(null);
    toast('New video: frames, motion and the take on screen cleared. Your takes stay in the panel.', 'ok', 8000, {
      label: 'Undo',
      run: () => {
        setS(before.s);
        setSelected(before.selected);
      },
    });
  };
  const animateRef = useRef<() => void>(() => undefined);
  useHotkey((e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter', () => animateRef.current(), [], true);

  const m = boot?.manifest;
  // LTX 2.5 is Darkroom's video model (DECISIONS 95); an older "wan" preference falls back to it
  const vm = m?.video[s.model] ?? m?.video.ltx;
  useEffect(() => {
    if (m && !m.video[s.model]) update({ model: 'ltx' });
  }, [m, s.model]); // eslint-disable-line react-hooks/exhaustive-deps
  const cams = boot?.camera.camera ?? [];
  // Lightricks' LTX 2.5 LoRAs on this PC (header-checked): the effects and the Refine tool appear only when present
  const { cat: loraCat } = useLoraCatalogue();
  const ltxCat = ltxFiles(loraCat);

  // Takes = a view of the Library: running and failed renders plus finished ones whose video is still in the Library
  // (deleting the video anywhere removes its take; dismissed failures stay hidden). Refreshed on every library change.
  const [fetchedAt, setFetchedAt] = useState(0);
  useEffect(() => {
    const t = Date.now();
    api
      .get<Job[]>('/api/jobs?kind=video&limit=30&live=1')
      .then((r) => (setTakes(r), setFetchedAt(t)))
      .catch(() => undefined);
  }, [rev]);
  const liveTakes = useMemo(() => {
    const map = new Map(takes.map((t) => [t.id, t]));
    // live updates from this session: progress for listed takes, and renders started since the last refresh
    Object.values(jobs)
      .filter((j) => j.kind === 'video' && (map.has(j.id) || j.status === 'queued' || j.status === 'running' || j.created_at > fetchedAt))
      .forEach((j) => map.set(j.id, j));
    return [...map.values()].sort((a, b) => b.created_at - a.created_at);
  }, [takes, jobs, fetchedAt]);
  const failedTakes = liveTakes.filter((t) => t.status === 'error' || t.status === 'cancelled' || t.status === 'lost');
  const removeTake = async (t: Job) => {
    const at = liveTakes.findIndex((x) => x.id === t.id);
    const gone = await deleteWithUndo(t.result_ids, 'video');
    if (gone.length && selected && t.result_ids.includes(selected)) {
      const next = liveTakes.slice(at + 1).concat(liveTakes.slice(0, at).reverse()).find((x) => x.status === 'done' && x.id !== t.id);
      setSelected(next?.result_ids[0] ?? null);
    }
  };
  const dismissTakes = async (body: { ids: string[] } | { failedOfKind: string }) => {
    try {
      const r = await api.dismissJobs(body);
      setTakes((ts) => ts.filter((x) => !r.dismissed.includes(x.id)));
      setFetchedAt(Date.now());
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const activeVideo = liveTakes.filter((j) => j.status === 'queued' || j.status === 'running');

  // Arrive with ?start=<item> from Generate / Edit / Library.
  const startParam = query.get('start');
  useEffect(() => {
    if (!startParam) return;
    api
      .asInput(startParam)
      .then((r) => {
        update({ start: { name: r.name, width: r.width ?? 1024, height: r.height ?? 1024, itemId: startParam } });
        go('video');
      })
      .catch((e) => toast((e as Error).message, 'error'));
  }, [startParam]); // eslint-disable-line react-hooks/exhaustive-deps

  // ?end=<item> from the Library's "Use as… > Video end frame"
  const endParam = query.get('end');
  useEffect(() => {
    if (!endParam) return;
    api
      .asInput(endParam)
      .then((r) => {
        update({ end: { name: r.name, width: r.width ?? 1024, height: r.height ?? 1024, itemId: endParam } });
        go('video');
      })
      .catch((e) => toast((e as Error).message, 'error'));
  }, [endParam]); // eslint-disable-line react-hooks/exhaustive-deps

  const reuseParam = query.get('reuse');
  useEffect(() => {
    if (!reuseParam) return;
    api.item(reuseParam).then(({ item }) => {
      const ui = item.ui as Partial<VideoSettings>;
      if (ui?.model) {
        setS({ ...DEFAULTS, ...ui });
        toast('Video settings loaded. Press Animate for a new take.', 'ok');
      }
      setSelected(item.id);
      go('video');
    });
  }, [reuseParam]); // eslint-disable-line react-hooks/exhaustive-deps

  const takeParam = query.get('take');
  useEffect(() => {
    if (!takeParam) return;
    setSelected(takeParam);
    go('video');
  }, [takeParam]); // eslint-disable-line react-hooks/exhaustive-deps

  // Finished jobs: select + notify.
  useEffect(
    () =>
      onJob((j) => {
        if (j.kind !== 'video') return;
        if (j.status === 'done' && j.result_ids[0]) {
          setSelected(j.result_ids[0]);
          if ((j.meta as any).notify) notifyDesktop('Darkroom: video ready', `${(j.meta as any).model ?? 'Video'} · ${(j.meta as any).prompt ?? ''}`.slice(0, 120));
        }
        if (j.status === 'error' || j.status === 'lost') {
          toast(j.error ?? 'The video failed.', 'error');
          if ((j.meta as any).notify) notifyDesktop('Darkroom: video failed', j.error ?? '');
        }
      }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /** Letterbox a frame to the video's aspect (bars), upload it, return the new input name. */
  const letterbox = async (fr: Frame, w: number, h: number): Promise<string> => {
    const img = new Image();
    img.src = inputUrl(fr.name);
    await img.decode();
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const k = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * k;
    const dh = img.naturalHeight * k;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not prepare the frame'))), 'image/png'));
    return (await api.upload(blob, 'frame_fit.png')).name;
  };

  const uploadFrame = async (f: File, which: 'start' | 'end') => {
    try {
      const up = await api.upload(f, f.name);
      update({ [which]: { name: up.name, width: up.width ?? 1024, height: up.height ?? 1024 } } as Partial<VideoSettings>);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const itemFrame = async (id: string, which: 'start' | 'end') => {
    const r = await api.asInput(id);
    update({ [which]: { name: r.name, width: r.width ?? 1024, height: r.height ?? 1024, itemId: id } } as Partial<VideoSettings>);
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return;
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
      if (f) void uploadFrame(f, s.start ? 'end' : 'start');
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  if (!m || !vm) return <div className="empty">Loading…</div>;
  const plan = planVideo(vm, s.quality, s.seconds, s.start?.width ?? 16, s.start?.height ?? 9);
  const endAllowed = vm.supportsEndFrame;

  const T = boot!.prompts;
  const vKey = (m?.video[s.model] ? s.model : 'ltx') as VideoModelKey;
  const words = wordCount(s.motion);

  const queue = async (body: Parameters<typeof api.submit>[0]) => {
    try {
      await api.submit(body);
      if (s.notify) void ensureNotifyPermission();
      toast(activeVideo.length ? 'Added to the queue.' : 'Rendering — you can keep working; it also survives a page reload.', 'ok');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setWarning({ text: e.body.warning, body: body });
      else toast((e as Error).message, 'error');
    }
  };

  const animate = async (override: Partial<VideoSettings> = {}, parentId: string | null = null, chain?: Record<string, unknown>) => {
    const cur = { ...s, ...override };
    if (!cur.start) return toast('Add a start frame first (step 1).', 'info');
    const model = m.video[cur.model] ?? m.video.ltx;
    if (model.unavailable) return toast(model.unavailable, 'error');
    const p = planVideo(model, cur.quality, cur.seconds, cur.start.width, cur.start.height);
    const seed = override.seed ?? randomSeed();
    const fx = effectOf(cur, ltxCat);
    const composed = composeMotionPrompt(T, cams, { model: (m.video[cur.model] ? cur.model : 'ltx') as VideoModelKey, motion: cur.motion, camera: fx === 'cinemagraph' ? ['static'] : cur.camera, sound: cur.sound === 'describe' ? cur.soundText : '' });
    // Cinemagraph: its trigger word first and a seamless loop asked for (model card)
    const prompt = fx === 'cinemagraph' ? `CINEMAGRAPH_MOTION, ${composed} Seamless natural loop.` : composed;
    const fit = cur.frameFit === 'fit';
    const mismatch = (fr: Frame | null) => !!fr && Math.abs(fr.width / fr.height / (p.width / p.height) - 1) > 0.03;
    const startName = fit && mismatch(cur.start) ? await letterbox(cur.start, p.width, p.height) : cur.start.name;
    const endName = cur.end && model.supportsEndFrame ? (fit && mismatch(cur.end) ? await letterbox(cur.end, p.width, p.height) : cur.end.name) : null;
    const params: Record<string, string | number> = {
      start_image: startName,
      motion_prompt: prompt,
      seed,
      frames: p.frames,
      fps: p.fps,
      width: p.width,
      height: p.height,
    };
    if (endName) params.end_image = endName;
    if (cur.sound === 'off') params.silent = 1;
    const loras: LoraUse[] = [...(cur.loras ?? [])];
    if (fx === 'slowmo') {
      loras.push({ name: ltxCat!.slowmo!, strength: 1 });
      params.motion_speed = cur.speed ?? 0.5;
    }
    if (fx === 'cinemagraph') loras.push({ name: ltxCat!.cinemagraph!, strength: 1.1 });
    if (loras.length) params.loras = JSON.stringify(loras);
    void queue({
      workflow: p.workflow,
      params,
      meta: {
        mode: 'video',
        model: model.label,
        prompt,
        parentId: parentId ?? cur.start.itemId ?? null,
        estimateSec: p.estimateSec,
        notify: cur.notify,
        ui: { ...cur, seed },
        chain,
      },
    });
  };

  animateRef.current = () => animate();

  const toggleCam = (id: string) => {
    const c = cams.find((x) => x.id === id)!;
    if (s.camera.includes(id)) return update({ camera: s.camera.filter((x) => x !== id) });
    if (c.exclusive) return update({ camera: [id] });
    update({ camera: [...s.camera.filter((x) => !cams.find((k) => k.id === x)?.exclusive), id] });
  };

  const sel = selectedItem?.kind === 'video' ? selectedItem : null;
  const selUi = (sel?.ui ?? {}) as Partial<VideoSettings>;
  const showFinalBar = !!sel && selUi.quality === 'draft' && sel.mode === 'video';

  const extend = async () => {
    if (!sel) return;
    try {
      const last = await api.asInput(sel.id, 'last');
      const ui = { ...DEFAULTS, ...selUi } as VideoSettings;
      animate({ ...ui, start: { name: last.name, width: sel.width ?? 832, height: sel.height ?? 480 }, end: null, seconds: 5, seed: randomSeed() }, sel.id, { kind: 'join', firstItemId: sel.id });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const smooth = async () => {
    if (!sel) return;
    try {
      const inp = await api.asInput(sel.id);
      await queue({
        workflow: 'video_interp',
        params: { video: inp.name, multiplier: 2, fps: (sel.fps ?? 24) * 2 },
        meta: { mode: 'smooth', model: `${sel.model} · RIFE 2×`, prompt: sel.prompt, parentId: sel.id, ui: sel.ui, notify: s.notify, durationSec: sel.duration ?? undefined },
      });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  /** Refine details (DECISIONS 98): the take itself, redrawn sharp by the IC-LoRA at 720p; motion and sound stay. */
  const refine = async () => {
    if (!sel || !ltxCat?.refine) return;
    try {
      const inp = await api.asInput(sel.id);
      const final = vm.quality.final!;
      const [width, height] = final[orientationOf(sel.width ?? 16, sel.height ?? 9)];
      await queue({
        workflow: 'ltx25_v2v_refine',
        params: { video: inp.name, motion_prompt: sel.prompt, seed: randomSeed(), width, height, loras: '' },
        meta: { mode: 'refine', model: 'LTX 2.5 · Refined', prompt: sel.prompt, parentId: sel.id, ui: { ...(sel.ui ?? {}), quality: 'final' }, notify: s.notify, durationSec: sel.duration ?? undefined, estimateSec: Math.round(41 * (sel.duration ?? 5)) },
      });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  /**
   * Cut out (DECISIONS 99): Alpha-Gen makes the take's matte (saved in the Library too), then the server puts the
   * take over the chosen background with it, keeping the sound. Background: a Library picture or a plain colour.
   */
  const [cutoutFor, setCutoutFor] = useState<Item | null>(null);
  const [cutoutPick, setCutoutPick] = useState(false);
  const cutOut = async (bg: { itemId: string } | { colour: string }) => {
    const take = cutoutFor;
    setCutoutFor(null);
    setCutoutPick(false);
    if (!take) return;
    try {
      let background: string;
      if ('itemId' in bg) background = (await api.asInput(bg.itemId)).name;
      else {
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const g = c.getContext('2d')!;
        g.fillStyle = bg.colour;
        g.fillRect(0, 0, 64, 64);
        const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
        background = (await api.upload(blob, 'background.png')).name;
      }
      const inp = await api.asInput(take.id);
      await queue({
        workflow: 'ltx25_v2v_alpha',
        params: { video: inp.name, motion_prompt: '', seed: randomSeed(), width: take.width ?? 864, height: take.height ?? 480, loras: '' },
        meta: { mode: 'matte', model: 'LTX 2.5 · Alpha-Gen matte', prompt: take.prompt, parentId: take.id, ui: take.ui, notify: s.notify, durationSec: take.duration ?? undefined, estimateSec: Math.round(42 * (take.duration ?? 5)), chain: { kind: 'composite', firstItemId: take.id, background } },
      });
      toast('Cutting out: first the matte (it goes to your Library too), then the take over your background.', 'info', 7000);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  /**
   * Restore (DECISIONS 100): Lightricks' Restore IC-LoRA repairs old or damaged footage (scratches, grain, flicker,
   * faded colour) at up to 1280 px, in 4-second parts that continue from each other; the server joins them and puts
   * the clip's own sound back.
   */
  const [restoreFor, setRestoreFor] = useState<Item | null>(null);
  const [restoreText, setRestoreText] = useState('');
  const restorePlan = (it: Item) => {
    const frames = it.frames ?? Math.round((it.duration ?? 5) * (it.fps ?? 24)) + 1;
    const windows = restoreWindows(frames);
    return { frames, windows, covered: restoredFrames(windows), canvas: restoreCanvas(it.width ?? 1280, it.height ?? 720) };
  };
  const restore = async () => {
    const take = restoreFor;
    setRestoreFor(null);
    if (!take || !ltxCat?.restore) return;
    const { windows, canvas } = restorePlan(take);
    if (!windows.length) return toast('This clip is too short to restore (it needs at least 9 frames).', 'error');
    try {
      const inp = await api.asInput(take.id);
      const what = restoreText.trim();
      await queue({
        workflow: 'ltx25_v2v_restore',
        params: {
          video: inp.name,
          start: windows[0].start,
          length: windows[0].length,
          motion_prompt: (what ? what.replace(/[.\s]+$/, '') + '. ' : '') + 'Restored film footage in natural colour: clean and sharp, no scratches, no grain, no flicker, steady exposure.',
          seed: randomSeed(),
          width: canvas.width,
          height: canvas.height,
        },
        meta: {
          mode: 'restore_part',
          model: windows.length > 1 ? `LTX 2.5 · Restore, part 1 of ${windows.length}` : 'LTX 2.5 · Restore',
          prompt: take.prompt,
          ui: take.ui,
          notify: s.notify,
          durationSec: take.duration ?? undefined,
          estimateSec: 190,
          chain: { kind: 'restore', firstItemId: take.id, windows },
        },
      });
      toast(windows.length > 1 ? `Restoring in ${windows.length} parts; Darkroom joins them when the last is done.` : 'Restoring…', 'info', 7000);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const saveFrame = async (t: number) => {
    if (!sel) return;
    try {
      const inp = await api.asInput(sel.id);
      const frame = Math.min(Math.round(t * (sel.fps ?? 16)), (sel.frames ?? 1) - 1);
      await api.submit({
        workflow: 'video_frame',
        params: { video: inp.name, frame },
        meta: { mode: 'frame', model: sel.model, prompt: sel.prompt, parentId: sel.id, ui: {} },
      });
      toast(`Saving frame ${frame} to the Library…`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="screen" style={{ gridTemplateColumns: '380px 1fr 300px' }}>
      <aside className="panel" aria-label="Video settings">
        <div className="panel-scroll">
          <section>
            <h2 className="step-title">
              <span className="step-num">1</span> Frames
              <button
                type="button"
                className="btn ghost sm new-btn"
                style={{ marginLeft: 'auto' }}
                onClick={startNew}
                disabled={!s.start && !s.end && !s.motion && !s.camera.length && !selected}
                title="Start a new video: clears the frames, motion, camera moves and the take on screen (your takes stay in the panel). Undo in the notice."
              >
                <Plus size={14} /> New
              </button>
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <FrameSlot label="Start frame" frame={s.start} onFile={(f) => uploadFrame(f, 'start')} onItem={(id) => itemFrame(id, 'start')} onClear={() => update({ start: null })} />
              <FrameSlot
                label="End frame (optional)"
                frame={endAllowed ? s.end : null}
                disabled={!endAllowed}
                disabledReason={vm.endFrameNote ?? `${vm.label} can only start from an image; it can't aim for an end frame.`}
                onFile={(f) => uploadFrame(f, 'end')}
                onItem={(id) => itemFrame(id, 'end')}
                onClear={() => update({ end: null })}
              />
            </div>
            <div className="field-row" style={{ marginTop: 6 }}>
              <button type="button" className="btn sm" onClick={() => setPicker('start')}>
                <ImagePlus size={14} /> Start from library
              </button>
              <button
                type="button"
                className="btn sm icon"
                title="Swap start and end frames"
                aria-label="Swap start and end frames"
                disabled={!endAllowed || (!s.start && !s.end)}
                onClick={() => update({ start: s.end, end: s.start })}
              >
                <ArrowLeftRight size={15} />
              </button>
              <button type="button" className="btn sm" disabled={!endAllowed} onClick={() => setPicker('end')}>
                <ImagePlus size={14} /> End from library
              </button>
            </div>
            {(() => {
              const planA = plan.width / plan.height;
              const bad = [s.start && ['Start', s.start] as const, endAllowed && s.end && ['End', s.end] as const]
                .filter(Boolean)
                .filter((x) => Math.abs((x as any)[1].width / (x as any)[1].height / planA - 1) > 0.03) as (readonly [string, Frame])[];
              if (!bad.length) return <p className="note" style={{ marginTop: 6 }}>Drag from the Library, drop a file, paste — or use “Animate” on any picture.</p>;
              return (
                <div style={{ marginTop: 8, padding: 10, border: '1px solid var(--accent)', borderRadius: 8 }}>
                  <p className="note warn" style={{ margin: '0 0 6px' }}>
                    {bad.map(([n, f]) => `${n} frame is ${f.width}×${f.height}`).join(', ')}, but the video will be {plan.width}×{plan.height}.
                  </p>
                  <div className="segmented" role="group" aria-label="Fit frames">
                    <button type="button" aria-pressed={(s.frameFit ?? 'crop') === 'crop'} onClick={() => update({ frameFit: 'crop' })} title="Scale to fill the video and crop the overflow (centred)">
                      Crop to fill
                    </button>
                    <button type="button" aria-pressed={s.frameFit === 'fit'} onClick={() => update({ frameFit: 'fit' })} title="Keep the whole frame and add black bars">
                      Fit with bars
                    </button>
                  </div>
                </div>
              );
            })()}
          </section>

          <section>
            <h2 className="step-title">
              <span className="step-num">2</span> What should move?
            </h2>
            <textarea
              className="input"
              rows={4}
              aria-label="Motion prompt"
              value={s.motion}
              onChange={(e) => update({ motion: e.target.value })}
              placeholder="e.g. She turns her head towards the window and smiles; curtains sway in the breeze."
            />
            <div className="field-row" style={{ marginTop: 6 }}>
              <button
                type="button"
                className="btn sm"
                disabled={!s.start || suggesting || !online}
                title={s.start ? `Let the local Qwen3-VL write a ${vm.label} motion prompt from the start frame${s.end ? ' to the end frame' : ''} (and your text, if any)` : 'Add a start frame first'}
                onClick={async () => {
                  setSuggesting(true);
                  try {
                    // the camera chips decide the camera; the writer describes the scene's motion to fit them (DECISIONS 94)
                    const r = await api.vlm({ task: 'motion', variant: vKey, text: s.motion, input: s.start!.name, ...(s.end ? { input2: s.end.name } : {}), camera: effectOf(s, ltxCat) === 'cinemagraph' ? ['static'] : s.camera, sound: { mode: s.sound ?? 'scene', text: s.soundText ?? '' } });
                    setMotionUndo((u) => [...u.slice(-19), s.motion]);
                    update({ motion: r.text });
                    const camNames = s.camera.map((id) => cams.find((c) => c.id === id)?.label).filter(Boolean);
                    toast(`Motion prompt written for ${vm.label}${camNames.length ? ` to suit ${camNames.join(' + ')}` : ''} in ${r.seconds}s.`, 'ok');
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  } finally {
                    setSuggesting(false);
                  }
                }}
              >
                {suggesting ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} {s.motion.trim() ? 'Improve motion' : 'Suggest motion'}
              </button>
              {motionUndo.length > 0 && (
                <button type="button" className="btn sm ghost" onClick={() => { update({ motion: motionUndo[motionUndo.length - 1] }); setMotionUndo((u) => u.slice(0, -1)); }}>
                  <Undo2 size={14} /> Undo
                </button>
              )}
            </div>
            <p className={`note ${words > T[vKey].max_words ? 'warn' : ''}`} style={{ margin: '4px 0 0' }}>
              {T[vKey].hint} <span className="mono">{words} words</span>
            </p>
            <div className="pills" role="group" aria-label="Camera" style={{ marginTop: 8 }}>
              {cams.map((c) => (
                <button key={c.id} type="button" className="pill" aria-pressed={s.camera.includes(c.id)} title={c[vKey]} onClick={() => toggleCam(c.id)}>
                  {c.label}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 14 }}>
              <p className="section-label">Sound</p>
              <Segmented
                label="Sound"
                options={[
                  { value: 'scene', label: 'From the scene', title: 'LTX makes sound that fits what happens (and anything your motion text says about sound)' },
                  { value: 'describe', label: 'Describe', title: 'Say what it should sound like: sounds, music, a line of speech in "double quotes"' },
                  { value: 'off', label: 'Silent', title: 'No audio track' },
                ]}
                value={s.sound ?? 'scene'}
                onChange={(sound) => update({ sound })}
              />
              {s.sound === 'describe' && (
                <textarea
                  className="input"
                  rows={2}
                  style={{ marginTop: 8 }}
                  aria-label="Sound description"
                  placeholder={'e.g. Rain on the window, a distant train. She whispers "Not yet."'}
                  value={s.soundText ?? ''}
                  onChange={(e) => update({ soundText: e.target.value })}
                />
              )}
            </div>
            {(ltxCat?.slowmo || ltxCat?.cinemagraph) && (
              <div style={{ marginTop: 14 }}>
                <p className="section-label">Effect</p>
                <Segmented
                  label="Effect"
                  options={[
                    { value: 'none', label: 'None' },
                    ...(ltxCat.slowmo ? [{ value: 'slowmo' as const, label: 'Slow motion', title: "Lightricks' slow-motion LoRA: the same action, played slower and smoother" }] : []),
                    ...(ltxCat.cinemagraph ? [{ value: 'cinemagraph' as const, label: 'Cinemagraph', title: 'Everything still except what you say moves; a locked camera and a seamless loop' }] : []),
                  ]}
                  value={effectOf(s, ltxCat)}
                  onChange={(effect) => update({ effect })}
                />
                {effectOf(s, ltxCat) === 'slowmo' && (
                  <div style={{ marginTop: 8 }}>
                    <Pills label="Slow-motion speed" options={[0.5, 0.25, 0.1].map((v) => ({ value: v, label: v === 0.5 ? '½ speed' : v === 0.25 ? '¼ speed' : '⅒ speed' }))} value={s.speed ?? 0.5} onChange={(speed) => update({ speed })} />
                  </div>
                )}
                {effectOf(s, ltxCat) === 'cinemagraph' && <p className="note">Say what moves and what stays still; the camera is locked (camera moves are ignored) and the clip loops.</p>}
              </div>
            )}
            <div style={{ marginTop: 14 }}>
              <LoraPicker family="ltx" value={s.loras ?? []} onChange={(loras) => update({ loras })} exclude={/slow-motion-control|cinemagraph/i} />
            </div>
          </section>

          <section>
            <h2 className="step-title">
              <span className="step-num">3</span> {Object.keys(m.video).length > 1 ? 'Model' : `${vm.label} · length and quality`}
            </h2>
            {Object.keys(m.video).length > 1 && (
            <div className="cards" role="group" aria-label="Video model">
              {Object.entries(m.video).map(([key, v]) => (
                <button key={key} type="button" className="card" aria-pressed={s.model === key} onClick={() => update({ model: key })} title={v.unavailable ?? v.tagline} disabled={!!v.unavailable}>
                  <strong>{v.label}</strong>
                  <small>{v.unavailable ? 'Unavailable' : v.tagline}</small>
                </button>
              ))}
            </div>
            )}
            <p className="section-label" style={{ marginTop: 14 }}>
              Length
            </p>
            <Segmented label="Length" options={[3, 5, 8].map((n) => ({ value: n, label: `${n} s`, disabled: n > vm.maxSeconds }))} value={s.seconds} onChange={(seconds) => update({ seconds })} />
            <p className="section-label" style={{ marginTop: 14 }}>
              Quality
            </p>
            <Segmented
              label="Quality"
              options={(['draft', 'final', 'hd'] as const).filter((q) => vm.quality[q]).map((q) => ({ value: q, label: q === 'hd' ? vm.quality[q]!.label : `${vm.quality[q]!.label} (${vm.quality[q]!.short})`, title: q === 'hd' ? 'Full HD, rendered in two stages (half size, then upscaled and refined): much finer detail, about 3 minutes for 5 s' : undefined }))}
              value={s.quality}
              onChange={(quality) => update({ quality })}
            />
          </section>
        </div>
        <div className="panel-foot">
          <div className="readout" aria-live="polite">
            <b>
              {plan.width}×{plan.height}
            </b>
            <span>{plan.fps} fps</span>
            <span>{plan.seconds.toFixed(1)} s</span>
            <span>{plan.frames} frames</span>
            <span>≈ {plan.estimateSec ? formatDuration(plan.estimateSec) : 'unmeasured'}</span>
          </div>
          <label className="check">
            <input type="checkbox" checked={s.notify} onChange={(e) => (update({ notify: e.target.checked }), e.target.checked && void ensureNotifyPermission())} />
            <Bell size={14} /> Notify when done
          </label>
          <button className="btn big primary" disabled={!online || !s.start} onClick={() => animate()} title={s.start ? 'Ctrl+Enter' : 'Add a start frame first'}>
            <Clapperboard size={18} /> {activeVideo.length ? 'Add to queue' : 'Animate'} <span className="kbd">Ctrl+Enter</span>
          </button>
        </div>
      </aside>

      <section className="stage" aria-label="Player">
        {sel ? (
          <Player key={sel.id} item={sel} onSaveFrame={saveFrame} onExtend={sel.workflow.startsWith('wan') ? undefined : extend} onSmooth={smooth} onRefine={ltxCat?.refine && Math.max(sel.width ?? 0, sel.height ?? 0) <= 1280 && !sel.workflow.startsWith('wan') ? refine : undefined} onCutOut={ltxCat?.alpha && Math.max(sel.width ?? 0, sel.height ?? 0) <= 1280 && (sel.frames ?? 0) <= 145 && !sel.workflow.startsWith('wan') && sel.mode !== 'matte' ? () => setCutoutFor(sel) : undefined} onRestore={ltxCat?.restore && sel.mode !== 'matte' ? () => setRestoreFor(sel) : undefined} online={online} />
        ) : (
          <div className="stage-main">
            <div className="empty">
              <h2>No take selected</h2>
              <p>Pick a start frame, describe the motion, then press Animate. Start with Draft to check the motion quickly, then render it at 720p or 1080p.</p>
            </div>
          </div>
        )}
        {showFinalBar && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', borderTop: '1px solid var(--line)', background: 'var(--panel)' }}>
            <Sparkles size={16} color="var(--accent)" />
            <span style={{ flex: 1 }}>Happy with the motion? Render it again with the same seed and settings: 720p, or 1080p for the finest detail (about 3 minutes for 5 s).</span>
            <button
              className="btn"
              disabled={!online}
              onClick={async () => {
                const ui = { ...DEFAULTS, ...selUi } as VideoSettings;
                animate({ ...ui, quality: 'final', seed: sel!.seed ?? ui.seed }, sel!.id);
              }}
            >
              Final 720p
            </button>
            {vm.quality.hd && (
              <button
                className="btn primary"
                disabled={!online}
                onClick={async () => {
                  const ui = { ...DEFAULTS, ...selUi } as VideoSettings;
                  animate({ ...ui, quality: 'hd', seed: sel!.seed ?? ui.seed }, sel!.id);
                }}
              >
                1080p
              </button>
            )}
          </div>
        )}
      </section>

      <aside className="panel right" aria-label="Takes">
        <div className="panel-scroll" style={{ gap: 10, padding: '16px 14px' }}>
          <p className="section-label" style={{ margin: 0 }}>
            Takes <span className="mono">{liveTakes.filter((t) => t.status === 'done').length}</span>
          </p>
          {failedTakes.length > 0 && (
            <button className="btn sm ghost" onClick={() => void dismissTakes({ failedOfKind: 'video' })} title="Hide every failed, cancelled or lost render (they have no video to keep)">
              Clear failed ({failedTakes.length})
            </button>
          )}
          {liveTakes.length === 0 && <p className="note">Every render appears here as a take. Running jobs show progress and time left.</p>}
          {liveTakes.map((t) => (
            <Take
              key={t.id}
              job={t}
              selected={!!sel && t.result_ids.includes(sel.id)}
              onSelect={() => t.result_ids[0] && setSelected(t.result_ids[0])}
              onDelete={() => void removeTake(t)}
              onDismiss={() => void dismissTakes({ ids: [t.id] })}
            />
          ))}
          {liveTakes.length > 0 && (
            <button className="btn ghost sm" onClick={() => openLibrary('videos')}>
              See all videos in the Library
            </button>
          )}
        </div>
      </aside>

      {cutoutFor && !cutoutPick && (
        <Dialog title="Cut out: the new background" onClose={() => setCutoutFor(null)}>
          <p style={{ marginTop: 0 }}>The subject is cut out of this take and put over your background, with the take's sound. Its matte is saved to the Library as well, for video editors.</p>
          <div className="compose-swatches" role="group" aria-label="Background colour">
            {['#2fa45a', '#1f6feb', '#000000', '#ffffff', '#808080', '#f2f0ea'].map((c) => (
              <button key={c} className="compose-swatch" style={{ background: c, width: 34, height: 34 }} aria-label={`Background ${c}`} onClick={() => void cutOut({ colour: c })} />
            ))}
          </div>
          <div className="field-row" style={{ justifyContent: 'space-between' }}>
            <button className="btn" onClick={() => setCutoutPick(true)}>
              <ImagePlus size={14} /> A picture from the Library…
            </button>
            <button className="btn ghost" onClick={() => setCutoutFor(null)}>
              Cancel
            </button>
          </div>
        </Dialog>
      )}
      {restoreFor &&
        (() => {
          const p = restorePlan(restoreFor);
          const fps = restoreFor.fps ?? 24;
          return (
            <Dialog title="Restore old footage" onClose={() => setRestoreFor(null)}>
              <p style={{ marginTop: 0 }}>
                Lightricks' Restore removes scratches, grain, flicker and blur and brings back colour, at {p.canvas.width}×{p.canvas.height}. The colours and fine detail are its best guess, not the original's.
              </p>
              <label htmlFor="restore-what" style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
                What's in the clip (optional)
              </label>
              <textarea id="restore-what" className="input" rows={2} value={restoreText} onChange={(e) => setRestoreText(e.target.value)} placeholder="e.g. A fishing harbour in the 1950s, boats at the quay, a sunny day" />
              <p className="muted" style={{ fontSize: 13 }}>
                {p.windows.length > 1 ? `${p.windows.length} parts of 4 seconds, joined at the end` : 'One part'} · about {Math.max(1, Math.round((p.windows.length * 190) / 60))} min
                {p.covered < p.frames - 7 ? ` · only the first ${(p.covered / fps).toFixed(0)} s of ${(p.frames / fps).toFixed(0)} s are restored` : ''}
              </p>
              <div className="field-row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn ghost" onClick={() => setRestoreFor(null)}>
                  Cancel
                </button>
                <button className="btn primary" onClick={() => void restore()} disabled={!online || !p.windows.length}>
                  <Brush size={14} /> Restore
                </button>
              </div>
            </Dialog>
          );
        })()}
      {cutoutFor && cutoutPick && <LibraryPicker title="Background picture" onClose={() => setCutoutPick(false)} onPick={(it) => void cutOut({ itemId: it.id })} />}
      {picker && (
        <LibraryPicker
          title={picker === 'start' ? 'Choose the start frame' : 'Choose the end frame'}
          onClose={() => setPicker(null)}
          onPick={(it) => {
            const which = picker;
            setPicker(null);
            void itemFrame(it.id, which);
          }}
        />
      )}
      {warning && (
        <Dialog title="Not enough graphics memory" onClose={() => setWarning(null)}>
          <p>{warning.text}</p>
          <div className="row">
            <button className="btn" onClick={() => setWarning(null)}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={() => {
                const b = warning.body;
                setWarning(null);
                void queue({ ...b, force: true });
              }}
            >
              Queue anyway
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function FrameSlot({
  label,
  frame,
  onFile,
  onItem,
  onClear,
  disabled,
  disabledReason,
}: {
  label: string;
  frame: Frame | null;
  onFile: (f: File) => void;
  onItem: (id: string) => void;
  onClear: () => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [over, setOver] = useState(false);
  return (
    <div title={disabled ? disabledReason : undefined}>
      <p className="note" style={{ margin: '0 0 4px' }}>
        {label}
      </p>
      <div
        className={`drop ${frame ? 'filled' : ''} ${over ? 'drag' : ''}`}
        style={{ aspectRatio: '4 / 3', opacity: disabled ? 0.45 : 1, padding: frame ? 0 : 8 }}
        onDragOver={(e) => (e.preventDefault(), !disabled && setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (disabled) return;
          const id = e.dataTransfer.getData('application/x-darkroom-item');
          if (id) return onItem(id);
          const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
          if (f) onFile(f);
        }}
      >
        {frame ? (
          <>
            <img src={inputUrl(frame.name)} alt={label} />
            <button className="slot x" style={{ position: 'absolute', top: 4, right: 4, width: 28, height: 28, border: 0, aspectRatio: 'auto', padding: 0 }} aria-label={`Remove ${label}`} onClick={onClear}>
              <X size={14} />
            </button>
          </>
        ) : (
          <label style={{ cursor: disabled ? 'not-allowed' : 'pointer', display: 'grid', placeItems: 'center', gap: 4, fontSize: 12 }}>
            <ImagePlus size={18} />
            {disabled ? 'Not supported' : 'Add image'}
            <input className="sr" type="file" accept="image/*" disabled={disabled} onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          </label>
        )}
      </div>
    </div>
  );
}

function Take({ job, selected, onSelect, onDelete, onDismiss }: { job: Job; selected: boolean; onSelect: () => void; onDelete: () => void; onDismiss: () => void }) {
  const [now, setNow] = useState(Date.now());
  const running = job.status === 'queued' || job.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const p = job.params as Record<string, number>;
  const meta = job.meta as Record<string, any>;
  const elapsed = job.started_at ? (now - job.started_at) / 1000 : 0;
  const eta = job.estimate_sec && job.status === 'running' ? Math.max(0, job.estimate_sec - elapsed) : null;
  const dur = p.frames && p.fps ? (p.frames - 1) / p.fps : meta.durationSec;
  return (
    <div
      className="take"
      data-testid="take"
      data-job={job.id}
      data-status={job.status}
      style={{ position: 'relative', display: 'grid', gridTemplateColumns: '84px 1fr', gap: 10, padding: 8, borderRadius: 10, border: `1px solid ${selected ? 'var(--accent)' : 'var(--input)'}`, background: 'var(--raised)' }}
    >
      <button
        onClick={onSelect}
        disabled={job.status !== 'done'}
        aria-pressed={selected}
        aria-label={job.status === 'done' ? 'Show this take' : 'Take not ready'}
        style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '84px 1fr', gap: 10, padding: 0, border: 0, background: 'none', textAlign: 'left', opacity: 1, cursor: job.status === 'done' ? 'pointer' : 'default' }}
      >
      <div style={{ width: 84, height: 56, borderRadius: 6, overflow: 'hidden', background: 'var(--bg)', display: 'grid', placeItems: 'center' }}>
        {job.result_ids[0] ? <img src={thumbUrl(job.result_ids[0])} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Camera size={16} color="var(--muted)" />}
      </div>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {({ extend: 'Extended', smooth: 'Smoothed', refine: 'Refined', matte: 'Matte', cutout: 'Cut out', restore: 'Restored', restore_part: 'Restoring' } as Record<string, string>)[meta.mode] ?? meta.model ?? job.workflow}
          {meta.ui?.quality ? ` · ${({ final: 'Final', hd: '1080p', draft: 'Draft' } as Record<string, string>)[meta.ui.quality] ?? 'Draft'}` : ''}{meta.ui?.sound === 'off' ? ' · Silent' : ''}
        </span>
        <span className="mono muted" style={{ fontSize: 11 }}>
          {p.width ? `${p.width}×${p.height} · ` : ''}
          {dur ? `${Number(dur).toFixed(1)} s` : ''}
          {p.fps ? ` · ${p.fps} fps` : ''}
        </span>
        {running ? (
          <>
            <ProgressBar value={job.progress} />
            <span className="mono" style={{ fontSize: 11, color: 'var(--accent)' }}>
              {job.status === 'queued' ? 'Queued' : `${job.stage}${eta !== null ? ` · ${formatDuration(eta)} left` : ` · ${formatDuration(elapsed)}`}`}
            </span>
          </>
        ) : job.status === 'done' ? (
          <span className="mono muted" style={{ fontSize: 11 }}>
            rendered in {formatDuration(job.finished_at && job.started_at ? (job.finished_at - job.started_at) / 1000 : null)}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--danger)', whiteSpace: 'normal' }}>{job.status === 'cancelled' ? 'Cancelled' : (job.error ?? job.status)}</span>
        )}
      </div>
      </button>
      {running && (
        <button className="btn sm ghost" style={{ gridColumn: '1 / -1', minHeight: 32 }} onClick={() => void api.cancel(job.id)}>
          Cancel
        </button>
      )}
      {job.status === 'done' && (
        <button className="take-delete" aria-label="Delete this take" title="Delete the video (moves it to Recently deleted)" onClick={onDelete}>
          <X size={13} />
        </button>
      )}
      {(job.status === 'error' || job.status === 'cancelled' || job.status === 'lost') && (
        <button className="btn sm ghost" style={{ gridColumn: '1 / -1', minHeight: 32 }} onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}

function Player({ item, onSaveFrame, onExtend, onSmooth, onRefine, onCutOut, onRestore, online }: { item: Item; onSaveFrame: (t: number) => void; onExtend?: () => void; onSmooth: () => void; onRefine?: () => void; onCutOut?: () => void; onRestore?: () => void; online: boolean }) {
  const vid = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(item.duration ?? 0);
  const [loop, setLoop] = useState(true);
  // remembered across takes and launches
  const [muted, setMuted] = usePersistent<boolean>('video.muted', false);
  const [strip, setStrip] = useState<string[]>([]);
  const fps = item.fps ?? 24;
  const src = fileUrl(item.id);

  // Filmstrip: sample frames from a hidden video element.
  useEffect(() => {
    let dead = false;
    const v = document.createElement('video');
    v.src = src;
    v.muted = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    const out: string[] = [];
    v.addEventListener('loadedmetadata', async () => {
      const n = 12;
      const c = document.createElement('canvas');
      c.height = 60;
      c.width = Math.round((60 * v.videoWidth) / v.videoHeight);
      for (let i = 0; i < n && !dead; i++) {
        v.currentTime = Math.min(v.duration - 0.01, (v.duration * (i + 0.5)) / n);
        await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
        c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
        out.push(c.toDataURL('image/jpeg', 0.7));
      }
      if (!dead) setStrip(out);
    });
    return () => {
      dead = true;
      v.src = '';
    };
  }, [src]);

  const toggle = useCallback(() => {
    const v = vid.current!;
    if (v.paused) void v.play();
    else v.pause();
  }, []);
  const step = (dir: number) => {
    const v = vid.current!;
    v.pause();
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + dir / fps));
  };
  useHotkey((e) => e.key === ' ', (e) => (e.preventDefault(), toggle()), []);
  useHotkey((e) => e.key === 'ArrowLeft' || e.key === 'ArrowRight', (e) => (e.preventDefault(), step(e.key === 'ArrowRight' ? 1 : -1)), [fps]);

  const frameNo = Math.round(t * fps);
  return (
    <>
      <div className="stage-main">
        <div className="frame" style={{ aspectRatio: `${item.width ?? 16} / ${item.height ?? 9}`, width: (item.width ?? 16) >= (item.height ?? 9) ? 'min(100%, calc((100vh - 330px) * ' + (item.width ?? 16) / (item.height ?? 9) + '))' : 'auto', height: (item.width ?? 16) < (item.height ?? 9) ? 'min(100%, calc(100vh - 330px))' : 'auto' }}>
          <video
            ref={vid}
            src={src}
            poster={item.poster ? fileUrl(item.id, 'poster') : undefined}
            loop={loop}
            muted={muted}
            playsInline
            onClick={toggle}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
            aria-label="Video preview"
          />
        </div>
      </div>
      <div style={{ padding: '0 24px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ position: 'relative', height: 60, borderRadius: 8, overflow: 'hidden', background: 'var(--panel)', display: 'flex' }}>
          {strip.map((s, i) => (
            <img key={i} src={s} alt="" style={{ flex: 1, minWidth: 0, height: 60, objectFit: 'cover', opacity: 0.85 }} />
          ))}
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${dur ? (t / dur) * 100 : 0}%`, width: 2, background: 'var(--accent)' }} />
          <input
            type="range"
            min={0}
            max={dur || 1}
            step={1 / fps}
            value={t}
            aria-label="Scrub"
            onChange={(e) => {
              const v = vid.current!;
              v.pause();
              v.currentTime = Number(e.target.value);
            }}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'ew-resize', margin: 0 }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', rowGap: 6 }}>
          <button className="btn icon" onClick={toggle} aria-label={playing ? 'Pause (Space)' : 'Play (Space)'} title="Space">
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <span className="mono" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
            {timecode(t)} / {timecode(dur)}
          </span>
          <span className="mono muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }} title="← / → steps one frame">
            f{frameNo}
          </span>
          <button className={`btn sm ${loop ? 'on' : ''}`} aria-pressed={loop} onClick={() => setLoop((l) => !l)}>
            <Repeat size={14} /> Loop
          </button>
          {hasSound(item) && (
            <button className="btn sm icon" onClick={() => setMuted((x) => !x)} aria-label={muted ? 'Sound on' : 'Mute'} title={muted ? 'Sound on' : 'Mute'} aria-pressed={!muted}>
              {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => onSaveFrame(t)} disabled={!online} title="Save the current frame to the Library as an image">
            <Camera size={14} /> Save frame
          </button>
          <button className="btn sm" onClick={onExtend} disabled={!online || !item.last_frame || !onExtend} title={onExtend ? 'Continue from the last frame and join the clips' : 'Made with Wan 2.2, which Darkroom no longer uses: start a new LTX take from its last frame instead (Save frame, then use it as the start frame)'}>
            <FastForward size={14} /> Extend +5 s
          </button>
          <button className="btn sm" onClick={onSmooth} disabled={!online} title="Double the frame rate with RIFE interpolation">
            <Waves size={14} /> Smooth 2×
          </button>
          {onRefine && (
            <button className="btn sm" onClick={onRefine} disabled={!online} title="Redraw this take with sharp detail at 720p (Lightricks' Refine Details IC-LoRA): the motion and sound stay exactly as they are. About 3–4 minutes for 5 s.">
              <Sparkles size={14} /> Refine details
            </button>
          )}
          {onCutOut && (
            <button className="btn sm" onClick={onCutOut} disabled={!online} title="Cut the subject out (Lightricks' Alpha-Gen) and put it over a new background; the matte is saved too. Works best with a clear subject. About 3–4 minutes for 5 s.">
              <Scissors size={14} /> Cut out
            </button>
          )}
          {onRestore && (
            <button className="btn sm" onClick={onRestore} disabled={!online} title="Repair old or damaged footage: scratches, grain, flicker, blur and faded colour (Lightricks' Restore IC-LoRA). About 3 minutes per 4 seconds.">
              <Brush size={14} /> Restore
            </button>
          )}
          <a className="btn sm" href={downloadUrl(item.id)} download>
            <Download size={14} /> MP4
          </a>
        </div>
      </div>
    </>
  );
}

/** Does this take have a sound track? LTX takes do, unless made Silent; Wan takes never did. */
function hasSound(item: Item): boolean {
  const ui = (item.ui ?? {}) as Partial<VideoSettings>;
  return item.kind === 'video' && ui.model !== 'wan' && ui.sound !== 'off' && !item.workflow.startsWith('wan');
}

interface LtxFiles {
  slowmo?: string;
  cinemagraph?: string;
  refine?: string;
  alpha?: string;
  restore?: string;
}
function ltxFiles(cat: Catalogue | null): LtxFiles | null {
  if (!cat) return null;
  const find = (list: { name: string }[] | undefined, re: RegExp) => list?.find((l) => re.test(l.name))?.name;
  return { slowmo: find(cat.ltx, /slow-motion-control/i), cinemagraph: find(cat.ltx, /cinemagraph/i), refine: find(cat.ltxTools, /refine-details/i), alpha: find(cat.ltxTools, /alpha-gen/i), restore: find(cat.ltxTools, /ic-lora-restore/i) };
}
/** The effect in use: the chosen one, if its LoRA is on this PC. */
function effectOf(st: Pick<VideoSettings, 'effect'>, f: LtxFiles | null): 'none' | 'slowmo' | 'cinemagraph' {
  const e = st.effect ?? 'none';
  if (e === 'slowmo' && f?.slowmo) return 'slowmo';
  if (e === 'cinemagraph' && f?.cinemagraph) return 'cinemagraph';
  return 'none';
}
