import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  Copy,
  Download,
  Film,
  Heart,
  ImagePlus,
  Layers,
  Lock,
  Maximize2,
  Monitor,
  RefreshCw,
  Shuffle,
  Sparkles,
  Unlock,
  X,
} from 'lucide-react';
import { api, ApiError, downloadUrl, fileUrl, inputUrl, thumbUrl, type Item, type Job } from '../api';
import { Pills, ProgressBar, Segmented, randomSeed, useHotkey } from '../components/common';
import { CropDialog, grabScreenFrame } from '../lib/capture';
import { useItem, usePersistent } from '../lib/hooks';
import { go } from '../router';
import { onJob, toast, useApp } from '../store';
import { ASPECTS, type Aspect } from '../../shared/manifest';
import { composeImagePrompt, refToken, type ImageModelKey } from '../../shared/prompts';

interface Ref {
  name: string; // ComfyUI input name
  preview: string; // URL for display
}

export interface GenSettings {
  prompt: string;
  model: string;
  aspect: Aspect;
  style: string;
  batch: number;
  seed: number;
  seedLocked: boolean;
  steps: number;
  cfg: number;
  refs: Ref[];
  /** Qwen: 'standard' | 'high' */
  quality?: string;
  /** Qwen: transparent background (real alpha) */
  transparent?: boolean;
}

const DEFAULTS: GenSettings = {
  prompt: '',
  model: 'klein',
  aspect: '1:1',
  style: 'none',
  batch: 1,
  seed: randomSeed(),
  seedLocked: false,
  steps: 4,
  cfg: 1,
  refs: [],
};

export function Generate({ query }: { query: URLSearchParams }) {
  const boot = useApp((s) => s.boot);
  const jobs = useApp((s) => s.jobs);
  const previews = useApp((s) => s.previews);
  const online = useApp((s) => s.status?.comfy === 'online');
  const [s, setS] = usePersistent<GenSettings>('generate', DEFAULTS);
  const [history, setHistory] = usePersistent<string[]>('generate.history', []);
  const [selected, setSelected] = usePersistent<string | null>('generate.selected', null);
  const [jobId, setJobId] = usePersistent<string | null>('generate.job', null);
  const [strip, setStrip] = useState<Item[]>([]);
  const [capture, setCapture] = useState<HTMLCanvasElement | null>(null);
  const [busyRef, setBusyRef] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const selectedItem = useItem(selected);

  const m = boot?.manifest;
  const model = m?.models[s.model] ?? m?.models.klein;
  const styles = boot?.styles.styles ?? [];
  const job: Job | undefined = jobId ? jobs[jobId] : undefined;
  const running = !!job && (job.status === 'queued' || job.status === 'running');
  const aspectsFor = (mm: typeof model, quality?: string) => mm?.quality?.[quality ?? 'standard']?.aspects ?? mm?.aspects;
  const [w, h] = model ? aspectsFor(model, s.quality)![s.aspect] : [1024, 1024];
  const T = boot?.prompts;

  const update = (p: Partial<GenSettings>) => setS((prev) => ({ ...prev, ...p }));

  const selectModel = (key: string) => {
    const mm = m!.models[key];
    update({ model: key, steps: mm.defaults.steps, cfg: mm.defaults.cfg });
  };

  // Strip = all outputs of the selected item's job.
  useEffect(() => {
    if (!selectedItem?.job_id) {
      setStrip(selectedItem ? [selectedItem] : []);
      return;
    }
    api
      .get<Item[]>(`/api/jobs/${selectedItem.job_id}/items`)
      .then((items) => setStrip(items.length ? items : [selectedItem]))
      .catch(() => setStrip([selectedItem]));
  }, [selectedItem?.id, selectedItem?.job_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // When our job finishes, show its results.
  useEffect(
    () =>
      onJob((j) => {
        if (j.id !== jobId) return;
        if (j.status === 'done' && j.result_ids.length) {
          setSelected(j.result_ids[0]);
          setHistory((h) => [...j.result_ids, ...h.filter((x) => !j.result_ids.includes(x))].slice(0, 200));
        }
        if (j.status === 'error' || j.status === 'lost') toast(j.error ?? 'Generation failed.', 'error');
      }),
    [jobId], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // "Reuse settings" from Library / elsewhere: #/generate?reuse=<id>
  const reuseId = query.get('reuse');
  useEffect(() => {
    if (!reuseId) return;
    api.item(reuseId).then(({ item }) => {
      applyReuse(item);
      go('generate');
    });
  }, [reuseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyReuse = (item: Item) => {
    const ui = item.ui as Partial<GenSettings>;
    if (ui && ui.model) {
      setS((prev) => ({ ...prev, ...ui, seedLocked: true, refs: ui.refs ?? [] }));
      toast('Settings loaded. Seed is locked so you get the same picture — unlock it to explore.', 'ok');
    } else {
      update({ prompt: item.prompt, seed: item.seed ?? prev().seed, seedLocked: true });
      toast('Prompt and seed loaded.', 'ok');
    }
    promptRef.current?.focus();
  };
  const prev = () => s;

  const addRefBlob = useCallback(
    async (blob: Blob, filename: string) => {
      if (s.refs.length >= (model?.maxRefs ?? 3)) {
        toast(`Up to ${model?.maxRefs ?? 3} reference images.`, 'info');
        return;
      }
      setBusyRef(true);
      try {
        const up = await api.upload(blob, filename);
        setS((p) => ({ ...p, refs: [...p.refs, { name: up.name, preview: inputUrl(up.name) }].slice(0, 3) }));
      } catch (e) {
        toast((e as Error).message, 'error');
      } finally {
        setBusyRef(false);
      }
    },
    [s.refs.length, model?.maxRefs], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const addRefItem = async (id: string) => {
    try {
      const r = await api.asInput(id);
      setS((p) => ({ ...p, refs: [...p.refs, { name: r.name, preview: inputUrl(r.name) }].slice(0, 3) }));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  // Paste an image anywhere on this screen → reference.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (file) {
        e.preventDefault();
        void addRefBlob(file, file.name || 'pasted.png');
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addRefBlob]);

  const workflow = s.refs.length ? model!.ref : model!.t2i;

  const submit = async (overrides: Partial<GenSettings> = {}, parentId: string | null = null) => {
    if (!m || !model) return;
    const cur = { ...s, ...overrides };
    if (!cur.prompt.trim()) {
      toast('Describe what you want to see first.', 'info');
      promptRef.current?.focus();
      return;
    }
    const seed = cur.seedLocked ? cur.seed : randomSeed();
    if (!cur.seedLocked) update({ seed });
    const style = styles.find((x) => x.id === cur.style);
    const mm = m.models[cur.model];
    const fullPrompt = composeImagePrompt(boot!.prompts, {
      model: cur.model as ImageModelKey,
      mode: 'generate',
      text: cur.prompt,
      style: style ?? null,
      transparent: cur.model === 'qwen' && !!cur.transparent,
    });
    const wf = cur.refs.length ? mm.ref : mm.t2i;
    const q = mm.quality?.[cur.quality ?? 'standard'];
    const [ww, hh] = aspectsFor(mm, cur.quality)![cur.aspect];
    const params: Record<string, string | number> = {
      prompt: fullPrompt,
      seed,
      steps: q ? q.steps : cur.steps,
      cfg: mm.ranges.cfg[0] === mm.ranges.cfg[1] ? mm.ranges.cfg[0] : cur.cfg,
      width: ww,
      height: hh,
      batch: cur.batch,
    };
    cur.refs.forEach((r, i) => (params[`image_${i + 1}`] = r.name));
    try {
      const j = await api.submit({
        workflow: wf,
        params,
        meta: {
          mode: 'generate',
          model: cur.refs.length ? `${mm.label} + refs` : mm.label,
          prompt: fullPrompt,
          parentId,
          ui: { ...cur, seed },
        },
      });
      setJobId(j.id);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : (e as Error).message, 'error');
    }
  };

  const cancel = async () => {
    if (job) await api.cancel(job.id);
  };

  useHotkey((e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter', () => (running ? undefined : void submit()), [s, running, m], true);

  const [ar, frameStyle] = useMemo(() => {
    const [aw, ah] = selectedItem?.width && selectedItem.height && !running ? [selectedItem.width, selectedItem.height] : [w, h];
    return [aw / ah, { aspectRatio: `${aw} / ${ah}`, width: aw / ah >= 1 ? 'min(100%, calc((100vh - 290px) * ' + aw / ah + '))' : 'auto', height: aw / ah < 1 ? 'min(100%, calc(100vh - 290px))' : 'auto' }];
  }, [selectedItem, w, h, running]);
  void ar;

  if (!m || !model) return <div className="empty">Loading…</div>;

  const preview = job ? previews[job.id] : undefined;
  const toggleFav = async () => {
    if (!selectedItem) return;
    await api.favourite(selectedItem.id, !selectedItem.favourite);
  };

  const upscale = async () => {
    if (!selectedItem) return;
    try {
      const inp = await api.asInput(selectedItem.id);
      const j = await api.submit({
        workflow: 'upscale',
        params: { image_1: inp.name, scale: 2, seed: randomSeed() },
        meta: { mode: 'upscale', model: 'SeedVR2 7B', prompt: selectedItem.prompt, parentId: selectedItem.id, ui: selectedItem.ui },
      });
      setJobId(j.id);
      toast('Upscaling 2× with SeedVR2…', 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const vary = () => {
    if (!selectedItem) return;
    const ui = selectedItem.ui as Partial<GenSettings>;
    if (ui?.model) void submit({ ...ui, refs: ui.refs ?? [], seedLocked: false, batch: ui.batch ?? 1 } as GenSettings, null);
    else void submit({ seedLocked: false });
  };

  return (
    <div className="screen" style={{ gridTemplateColumns: '380px 1fr 112px' }}>
      <aside className="panel" aria-label="Generate settings">
        <div className="panel-scroll">
          <div>
            <label className="section-label" htmlFor="prompt">
              Prompt
              <button
                type="button"
                className="btn ghost sm"
                title="Rewrite the prompt with more detail (not connected to a language model yet)"
                onClick={async () => {
                  const r = await api.post<{ prompt: string; note?: string }>('/api/enhance', { prompt: s.prompt });
                  update({ prompt: r.prompt });
                  if (r.note) toast(r.note, 'info');
                }}
              >
                <Sparkles size={14} /> Enhance
              </button>
            </label>
            <textarea
              id="prompt"
              ref={promptRef}
              className="input"
              placeholder="Describe the image… e.g. a ceramic teapot on a linen tablecloth, morning light"
              value={s.prompt}
              onChange={(e) => update({ prompt: e.target.value })}
              rows={5}
            />
          </div>

          <div>
            <p className="section-label">Model</p>
            <div className="cards" role="group" aria-label="Model">
              {Object.entries(m.models).map(([key, mm]) => (
                <button key={key} type="button" className="card" aria-pressed={s.model === key} onClick={() => selectModel(key)} title={mm.licence}>
                  <strong>{mm.label}</strong>
                  <small>{mm.tagline}</small>
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="section-label">
              Aspect <span className="mono">{w} × {h}</span>
            </p>
            <Pills label="Aspect ratio" options={ASPECTS.map((a) => ({ value: a, label: a }))} value={s.aspect} onChange={(aspect) => update({ aspect })} />
          </div>

          <div>
            <p className="section-label">Style</p>
            <Pills
              label="Style preset"
              options={styles.map((x) => ({ value: x.id, label: x.label, title: x[s.model as ImageModelKey] || 'No style added' }))}
              value={s.style}
              onChange={(style) => update({ style })}
            />
          </div>

          {model.quality && (
            <div>
              <p className="section-label">
                Quality <span className="mono">{model.quality[s.quality ?? 'standard']?.note}</span>
              </p>
              <Segmented
                label="Quality"
                options={Object.entries(model.quality).map(([k, v]) => ({ value: k, label: v.label, title: v.note }))}
                value={s.quality ?? 'standard'}
                onChange={(quality) => update({ quality })}
              />
              <label className="check" title="Qwen-Image 2.1 can paint a real transparent background (saved as PNG with alpha)">
                <input type="checkbox" checked={!!s.transparent} onChange={(e) => update({ transparent: e.target.checked })} />
                Transparent background
              </label>
            </div>
          )}

          <RefSlots
            refs={s.refs}
            max={model.maxRefs}
            busy={busyRef}
            onAdd={(files) => files.forEach((f) => void addRefBlob(f, f.name))}
            onAddItem={addRefItem}
            onRemove={(i) => setS((p) => ({ ...p, refs: p.refs.filter((_, k) => k !== i) }))}
            hint={T ? T[s.model as ImageModelKey]?.ref_hint : undefined}
            token={(n) => (T ? refToken(T, s.model as ImageModelKey, n) : '')}
            onInsert={(tok) => {
              update({ prompt: (s.prompt.trim() ? s.prompt.trimEnd() + ' ' : '') + tok + ' ' });
              promptRef.current?.focus();
            }}
            onScreen={async () => {
              try {
                setCapture(await grabScreenFrame());
              } catch {
                toast('Screen capture was cancelled or blocked by the browser.', 'info');
              }
            }}
          />

          <div>
            <p className="section-label">Batch</p>
            <Segmented label="Batch size" options={[1, 2, 3, 4].map((n) => ({ value: n, label: `×${n}` }))} value={s.batch} onChange={(batch) => update({ batch })} />
          </div>

          <details className="adv">
            <summary>
              <ChevronRight size={14} /> Advanced
            </summary>
            <div className="adv-body">
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                <span>Seed</span>
                <div className="field-row">
                  <input
                    className="input mono"
                    inputMode="numeric"
                    value={s.seed}
                    onChange={(e) => update({ seed: Number(e.target.value.replace(/\D/g, '')) || 0, seedLocked: true })}
                    aria-label="Seed"
                  />
                  <button
                    type="button"
                    className={`btn icon ${s.seedLocked ? 'on' : ''}`}
                    aria-pressed={s.seedLocked}
                    title={s.seedLocked ? 'Seed locked — every run reuses it' : 'Seed unlocked — a new seed every run'}
                    onClick={() => update({ seedLocked: !s.seedLocked })}
                  >
                    {s.seedLocked ? <Lock size={16} /> : <Unlock size={16} />}
                  </button>
                  <button type="button" className="btn icon" title="New random seed" onClick={() => update({ seed: randomSeed() })}>
                    <Shuffle size={16} />
                  </button>
                </div>
              </label>
              <label className="field">
                <span>
                  Steps <b className="mono">{s.steps}</b>
                </span>
                <input type="range" min={model.ranges.steps[0]} max={model.ranges.steps[1]} value={s.steps} onChange={(e) => update({ steps: Number(e.target.value) })} />
              </label>
              {model.ranges.cfg[0] !== model.ranges.cfg[1] ? (
                <label className="field">
                  <span>
                    Guidance <b className="mono">{s.cfg.toFixed(1)}</b>
                  </span>
                  <input type="range" min={model.ranges.cfg[0]} max={model.ranges.cfg[1]} step={0.5} value={s.cfg} onChange={(e) => update({ cfg: Number(e.target.value) })} />
                </label>
              ) : (
                <div className="field" title="This model is distilled to run at guidance 1; higher values only make results worse.">
                  <span>Guidance</span>
                  <span className="mono" style={{ color: 'var(--text)' }}>
                    1.0 (fixed)
                  </span>
                </div>
              )}
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <span>Workflow</span>
                <span className="mono" style={{ color: 'var(--text)' }}>
                  {workflow}.json
                </span>
              </div>
              <button
                type="button"
                className="btn sm ghost"
                style={{ gridColumn: '1 / -1' }}
                onClick={() => update({ steps: model.defaults.steps, cfg: model.defaults.cfg })}
              >
                <RefreshCw size={14} /> Reset to {model.label} defaults
              </button>
            </div>
          </details>
        </div>
        <div className="panel-foot">
          {running ? (
            <button className="btn big danger" onClick={cancel}>
              <X size={18} /> Cancel
            </button>
          ) : (
            <button className="btn big primary" onClick={() => void submit()} disabled={!online} title={online ? 'Ctrl+Enter' : 'Start ComfyUI first'}>
              Generate <span className="kbd">Ctrl+Enter</span>
            </button>
          )}
        </div>
      </aside>

      <section className="stage" aria-label="Result">
        <div className="stage-main">
          {running ? (
            <div className="frame" style={{ ...frameStyle, aspectRatio: `${w} / ${h}` }}>
              {preview ? <img src={preview} alt="Live preview" /> : <div style={{ width: '100%', height: '100%', background: 'var(--panel)' }} />}
              <div className="progress-overlay">
                <span className="big-status">{job!.status === 'queued' ? 'Waiting in queue' : job!.stage || 'Working'}</span>
                <ProgressBar value={job!.progress} />
                <span className="readout">
                  <b>{job!.workflow}</b> {w}×{h} · seed <b>{String(s.seed)}</b>
                </span>
              </div>
            </div>
          ) : selectedItem ? (
            <div className="frame" style={frameStyle}>
              <img src={fileUrl(selectedItem.id)} alt={selectedItem.prompt} />
            </div>
          ) : (
            <div className="empty">
              <h2>Nothing developed yet</h2>
              <p>Write a prompt on the left and press Generate (Ctrl+Enter). Drop or paste up to three pictures to use as references.</p>
            </div>
          )}
        </div>
        {selectedItem && !running && (
          <>
            <div className="actions" role="toolbar" aria-label="Result actions">
              <button className="btn sm" onClick={() => go('edit', selectedItem.id)}>
                <Layers size={15} /> Edit
              </button>
              <button className="btn sm" onClick={vary} disabled={!online} title="Same settings, new seed">
                <Shuffle size={15} /> Vary
              </button>
              <button className="btn sm" onClick={upscale} disabled={!online}>
                <Maximize2 size={15} /> Upscale 2×
              </button>
              <button className="btn sm" onClick={() => go('video', undefined, { start: selectedItem.id })}>
                <Film size={15} /> Animate
              </button>
              <a className="btn sm" href={downloadUrl(selectedItem.id)} download>
                <Download size={15} /> Download
              </a>
              <button className={`btn sm ${selectedItem.favourite ? 'on' : ''}`} aria-pressed={selectedItem.favourite} onClick={toggleFav}>
                <Heart size={15} fill={selectedItem.favourite ? 'currentColor' : 'none'} /> Favourite
              </button>
              <button className="btn sm" onClick={() => applyReuse(selectedItem)}>
                <Copy size={15} /> Reuse settings
              </button>
            </div>
            <div className="readout" style={{ justifyContent: 'center', paddingBottom: 8 }}>
              <span>
                <b>{selectedItem.model}</b>
              </span>
              <span>
                {selectedItem.width}×{selectedItem.height}
              </span>
              <span>seed {String(selectedItem.seed ?? '–')}</span>
              {selectedItem.render_ms ? <span>{(selectedItem.render_ms / 1000).toFixed(1)}s</span> : null}
            </div>
          </>
        )}
        <div className="strip" aria-label="Variations">
          {strip.length > 1 &&
            strip.map((it) => (
              <button key={it.id} aria-pressed={it.id === selected} onClick={() => setSelected(it.id)} title={`Seed ${it.seed}`}>
                <img src={thumbUrl(it.id)} alt="" />
              </button>
            ))}
        </div>
      </section>

      <aside className="rail" aria-label="Session history">
        <h3>History</h3>
        {history.length === 0 && <p className="note" style={{ textAlign: 'center' }}>Your results appear here.</p>}
        {history.map((id) => (
          <button
            key={id}
            aria-pressed={id === selected}
            onClick={() => setSelected(id)}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('application/x-darkroom-item', id)}
          >
            <img src={thumbUrl(id)} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} />
          </button>
        ))}
      </aside>

      {capture && (
        <CropDialog
          source={capture}
          onCancel={() => setCapture(null)}
          onDone={(b) => {
            setCapture(null);
            void addRefBlob(b, 'screen.png');
          }}
        />
      )}
    </div>
  );
}

function RefSlots({
  refs,
  max,
  busy,
  onAdd,
  onAddItem,
  onRemove,
  onScreen,
  hint,
  token,
  onInsert,
}: {
  refs: Ref[];
  max: number;
  busy: boolean;
  onAdd: (f: File[]) => void;
  onAddItem: (id: string) => void;
  onRemove: (i: number) => void;
  onScreen: () => void;
  hint?: string;
  token: (n: number) => string;
  onInsert: (token: string) => void;
}) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData('application/x-darkroom-item');
        if (id) return onAddItem(id);
        onAdd([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')));
      }}
    >
      <p className="section-label">
        References <span className="mono">{refs.length}/{max}</span>
      </p>
      <div className="slots">
        {Array.from({ length: max }).map((_, i) =>
          refs[i] ? (
            <div key={i} className="slot filled">
              <img src={refs[i].preview || '/favicon.ico'} alt={`Reference ${i + 1}`} />
              <button className="x" aria-label={`Remove reference ${i + 1}`} onClick={() => onRemove(i)}>
                <X size={14} />
              </button>
              <button
                type="button"
                className="mono"
                title="Insert this reference's name into the prompt"
                onClick={() => onInsert(token(i + 1))}
                style={{ position: 'absolute', left: 4, bottom: 4, fontSize: 11, border: 0, borderRadius: 4, padding: '2px 6px', background: 'rgba(18,18,16,.85)', color: 'var(--accent)' }}
              >
                {token(i + 1)}
              </button>
            </div>
          ) : (
            <div key={i} className={`slot ${over ? 'drag' : ''}`}>
              {i === refs.length ? (
                <label>
                  <ImagePlus size={18} />
                  {busy ? 'Uploading…' : 'Drop, paste or browse'}
                  <input
                    ref={inputRef}
                    className="sr"
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(e) => {
                      onAdd([...(e.target.files ?? [])]);
                      e.target.value = '';
                    }}
                  />
                </label>
              ) : null}
            </div>
          ),
        )}
      </div>
      <div className="field-row" style={{ marginTop: 8 }}>
        <button type="button" className="btn sm" onClick={onScreen} disabled={refs.length >= max} title="Capture part of your screen as a reference">
          <Monitor size={15} /> Screen
        </button>
        <span className="note">{refs.length ? 'References steer composition, subject and style.' : 'Optional.'}</span>
      </div>
      {refs.length > 0 && hint && <p className="note" style={{ marginTop: 6 }}>{hint}</p>}
    </div>
  );
}
