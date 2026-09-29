import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, Camera, Clapperboard, Download, FastForward, ImagePlus, Pause, Play, Repeat, Sparkles, Waves, X } from 'lucide-react';
import { api, ApiError, downloadUrl, fileUrl, inputUrl, thumbUrl, type Item, type Job } from '../api';
import { Dialog, formatDuration, ProgressBar, randomSeed, Segmented, timecode, useHotkey } from '../components/common';
import { ensureNotifyPermission, notifyDesktop, useItem, usePersistent } from '../lib/hooks';
import { go } from '../router';
import { onJob, toast, useApp } from '../store';
import { planVideo, type VideoQuality } from '../../shared/manifest';

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
}

const DEFAULTS: VideoSettings = { start: null, end: null, motion: '', camera: [], model: 'wan', seconds: 5, quality: 'draft', notify: true, seed: 0 };

export function Video({ query }: { query: URLSearchParams }) {
  const boot = useApp((s) => s.boot);
  const jobs = useApp((s) => s.jobs);
  const online = useApp((s) => s.status?.comfy === 'online');
  const rev = useApp((s) => s.libraryRev);
  const [s, setS] = usePersistent<VideoSettings>('video', DEFAULTS);
  const [selected, setSelected] = usePersistent<string | null>('video.selected', null);
  const [takes, setTakes] = useState<Job[]>([]);
  const [warning, setWarning] = useState<{ text: string; body: Parameters<typeof api.submit>[0] } | null>(null);
  const selectedItem = useItem(selected);
  const update = (p: Partial<VideoSettings>) => setS((prev) => ({ ...prev, ...p }));
  const animateRef = useRef<() => void>(() => undefined);
  useHotkey((e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter', () => animateRef.current(), [], true);

  const m = boot?.manifest;
  const vm = m?.video[s.model] ?? m?.video.wan;
  const cams = boot?.camera.camera ?? [];

  // Takes = video jobs from the server (survive reloads), live-updated.
  useEffect(() => {
    api.get<Job[]>('/api/jobs?kind=video&limit=40').then(setTakes).catch(() => undefined);
  }, [rev]);
  const liveTakes = useMemo(() => {
    const map = new Map(takes.map((t) => [t.id, t]));
    Object.values(jobs)
      .filter((j) => j.kind === 'video')
      .forEach((j) => map.set(j.id, j));
    return [...map.values()].sort((a, b) => b.created_at - a.created_at);
  }, [takes, jobs]);
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

  const motionPrompt = (motion: string, camera: string[]) => {
    const phrases = camera.map((c) => cams.find((x) => x.id === c)?.phrase).filter(Boolean);
    return [motion.trim(), ...phrases].filter(Boolean).join(' ');
  };

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

  const animate = (override: Partial<VideoSettings> = {}, parentId: string | null = null, chain?: Record<string, unknown>) => {
    const cur = { ...s, ...override };
    if (!cur.start) return toast('Add a start frame first (step 1).', 'info');
    const model = m.video[cur.model];
    if (model.unavailable) return toast(model.unavailable, 'error');
    const p = planVideo(model, cur.quality, cur.seconds, cur.start.width, cur.start.height);
    const seed = override.seed ?? randomSeed();
    const prompt = motionPrompt(cur.motion, cur.camera) || 'Natural, subtle motion.';
    const params: Record<string, string | number> = {
      start_image: cur.start.name,
      motion_prompt: prompt,
      seed,
      frames: p.frames,
      fps: p.fps,
      width: p.width,
      height: p.height,
    };
    if (cur.end && model.supportsEndFrame) params.end_image = cur.end.name;
    void queue({
      workflow: model.workflow,
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
        params: { video: inp.name, multiplier: 2, fps: (sel.fps ?? 16) * 2 },
        meta: { mode: 'smooth', model: `${sel.model} · RIFE 2×`, prompt: sel.prompt, parentId: sel.id, ui: sel.ui, notify: s.notify, durationSec: sel.duration ?? undefined },
      });
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
            <p className="note" style={{ marginTop: 6 }}>
              Drop, paste or browse — or use “Animate” on any picture.
            </p>
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
            <div className="pills" role="group" aria-label="Camera" style={{ marginTop: 8 }}>
              {cams.map((c) => (
                <button key={c.id} type="button" className="pill" aria-pressed={s.camera.includes(c.id)} title={c.phrase} onClick={() => toggleCam(c.id)}>
                  {c.label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h2 className="step-title">
              <span className="step-num">3</span> Model
            </h2>
            <div className="cards" role="group" aria-label="Video model">
              {Object.entries(m.video).map(([key, v]) => (
                <button key={key} type="button" className="card" aria-pressed={s.model === key} onClick={() => update({ model: key })} title={v.unavailable ?? v.tagline} disabled={!!v.unavailable}>
                  <strong>{v.label}</strong>
                  <small>{v.unavailable ? 'Unavailable' : v.tagline}</small>
                </button>
              ))}
            </div>
            <p className="section-label" style={{ marginTop: 14 }}>
              Length
            </p>
            <Segmented label="Length" options={[3, 5, 8].map((n) => ({ value: n, label: `${n} s`, disabled: n > vm.maxSeconds }))} value={s.seconds} onChange={(seconds) => update({ seconds })} />
            <p className="section-label" style={{ marginTop: 14 }}>
              Quality
            </p>
            <Segmented
              label="Quality"
              options={(['draft', 'final'] as const).map((q) => ({ value: q, label: `${vm.quality[q].label} (${vm.quality[q].short})` }))}
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
          <Player key={sel.id} item={sel} onSaveFrame={saveFrame} onExtend={extend} onSmooth={smooth} online={online} />
        ) : (
          <div className="stage-main">
            <div className="empty">
              <h2>No take selected</h2>
              <p>Pick a start frame, describe the motion, then press Animate. Start with Draft to check the motion quickly, then render the final at 720p.</p>
            </div>
          </div>
        )}
        {showFinalBar && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', borderTop: '1px solid var(--line)', background: 'var(--panel)' }}>
            <Sparkles size={16} color="var(--accent)" />
            <span style={{ flex: 1 }}>Happy with the motion? Render final at 720p with the same seed and settings.</span>
            <button
              className="btn primary"
              disabled={!online}
              onClick={async () => {
                const ui = { ...DEFAULTS, ...selUi } as VideoSettings;
                animate({ ...ui, quality: 'final', seed: sel!.seed ?? ui.seed }, sel!.id);
              }}
            >
              Render final
            </button>
          </div>
        )}
      </section>

      <aside className="panel right" aria-label="Takes">
        <div className="panel-scroll" style={{ gap: 10, padding: '16px 14px' }}>
          <p className="section-label" style={{ margin: 0 }}>
            Takes <span className="mono">{liveTakes.filter((t) => t.status === 'done').length}</span>
          </p>
          {liveTakes.length === 0 && <p className="note">Every render appears here as a take. Running jobs show progress and time left.</p>}
          {liveTakes.map((t) => (
            <Take key={t.id} job={t} selected={!!sel && t.result_ids.includes(sel.id)} onSelect={() => t.result_ids[0] && setSelected(t.result_ids[0])} />
          ))}
        </div>
      </aside>

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

function Take({ job, selected, onSelect }: { job: Job; selected: boolean; onSelect: () => void }) {
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
      data-status={job.status}
      style={{ display: 'grid', gridTemplateColumns: '84px 1fr', gap: 10, padding: 8, borderRadius: 10, border: `1px solid ${selected ? 'var(--accent)' : 'var(--input)'}`, background: 'var(--raised)' }}
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
          {meta.mode === 'extend' ? 'Extended' : meta.mode === 'smooth' ? 'Smoothed' : meta.model ?? job.workflow}
          {meta.ui?.quality ? ` · ${meta.ui.quality === 'final' ? 'Final' : 'Draft'}` : ''}
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
    </div>
  );
}

function Player({ item, onSaveFrame, onExtend, onSmooth, online }: { item: Item; onSaveFrame: (t: number) => void; onExtend: () => void; onSmooth: () => void; online: boolean }) {
  const vid = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(item.duration ?? 0);
  const [loop, setLoop] = useState(true);
  const [strip, setStrip] = useState<string[]>([]);
  const fps = item.fps ?? 16;
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
          <div style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => onSaveFrame(t)} disabled={!online} title="Save the current frame to the Library as an image">
            <Camera size={14} /> Save frame
          </button>
          <button className="btn sm" onClick={onExtend} disabled={!online || !item.last_frame} title="Continue from the last frame and join the clips">
            <FastForward size={14} /> Extend +5 s
          </button>
          <button className="btn sm" onClick={onSmooth} disabled={!online} title="Double the frame rate with RIFE interpolation">
            <Waves size={14} /> Smooth 2×
          </button>
          <a className="btn sm" href={downloadUrl(item.id)} download>
            <Download size={14} /> MP4
          </a>
        </div>
      </div>
    </>
  );
}
