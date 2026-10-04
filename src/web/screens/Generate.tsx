import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  Copy,
  Download,
  Film,
  Heart,
  History,
  ImagePlus,
  Layers,
  Lock,
  Maximize2,
  Monitor,
  RefreshCw,
  Shuffle,
  Sparkles,
  Unlock,
  Undo2,
  Loader2,
  ScanText,
  X,
  Plus,
} from 'lucide-react';
import { api, ApiError, downloadUrl, fileUrl, inputUrl, thumbUrl, type Item, type Job } from '../api';
import { deleteWithUndo, openLibrary } from '../lib/remove';
import { expandVariations } from '../../shared/variations';
import type { LoraUse } from '../../shared/loras';
import { LoraPicker } from '../components/LoraPicker';
import { KleinWeights, kleinLabel, useFinetunes } from '../components/KleinWeights';

/** Prompt variations: at most this many prompts, and this many pictures per click (variations × batch). */
const MAX_VARIATIONS = 16;
const MAX_PICTURES = 16;
import { Pills, ProgressBar, Segmented, randomSeed, useHotkey } from '../components/common';
import { CropDialog, grabScreenFrame } from '../lib/capture';
import { useItemLoad, useSessionState, useWorkspace } from '../lib/hooks';
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
  /** Qwen: 'standard' (Draft) | 'high' (Native 2K) */
  quality?: string;
  /** Klein: 'standard' (~1 MP) | 'high' (~2 MP). Its own setting, so Native 2K for Qwen never makes Klein High. */
  kleinQuality?: string;
  /** Klein: your fine-tune's file (DECISIONS 91); '' = official Klein 9B. */
  kleinWeights?: string;
  /** Qwen: transparent background (real alpha) */
  transparent?: boolean;
  /** Your LoRAs, per model (a preference, like the style). */
  loras?: Record<string, LoraUse[]>;
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
  // prompt, references and seed are work in progress (this launch only); model, aspect, style… are preferences
  const [s, setS] = useWorkspace<GenSettings>('generate', DEFAULTS, ['prompt', 'refs', 'seed', 'seedLocked']);
  // History = your latest Generate pictures in the Library (deleting anywhere removes them here too)
  const rev = useApp((s) => s.libraryRev);
  const [history, setHistory] = useState<Item[]>([]);
  useEffect(() => {
    api
      .items({ filter: 'generated', limit: 30 })
      .then((r) => setHistory(r.items))
      .catch(() => undefined);
  }, [rev]);
  const removeFromHistory = async (id: string) => {
    const at = history.findIndex((h) => h.id === id);
    const gone = await deleteWithUndo([id], 'picture');
    if (gone.length && id === selected) setSelected(history[at + 1]?.id ?? history[at - 1]?.id ?? null);
  };
  const [selected, setSelected] = useSessionState<string | null>('generate.selected', null);
  const [jobId, setJobId] = useSessionState<string | null>('generate.job', null);
  // all jobs of the last click: one per prompt variation; the strip shows their results together
  const [runJobs, setRunJobs] = useSessionState<string[]>('generate.run', []);
  const [runTick, setRunTick] = useState(0);
  const [strip, setStrip] = useState<Item[]>([]);
  const [capture, setCapture] = useState<HTMLCanvasElement | null>(null);
  const [busyRef, setBusyRef] = useState(false);
  const [vlmBusy, setVlmBusy] = useState<null | 'enhance' | 'reverse'>(null);
  const [promptUndo, setPromptUndo] = useState<string[]>([]);
  const reverseInput = useRef<HTMLInputElement>(null);
  const restoreInput = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const selectedLoad = useItemLoad(selected);
  // a picture deleted anywhere (Library, History) leaves the screen at once
  const selectedItem = selectedLoad.item && !selectedLoad.item.deleted_at ? selectedLoad.item : null;
  useEffect(() => {
    if (selected && (selectedLoad.missing || selectedLoad.item?.deleted_at)) setSelected(null);
  }, [selected, selectedLoad.missing, selectedLoad.item?.deleted_at]); // eslint-disable-line react-hooks/exhaustive-deps

  /** New: an empty workspace (prompt, references, picture on screen); preferences stay. Undo puts it back. */
  const startNew = () => {
    const before = { s, selected };
    setS((p) => ({ ...p, prompt: '', refs: [], seedLocked: false, seed: randomSeed() }));
    setSelected(null);
    setPromptUndo([]);
    toast('New picture: prompt, references and the picture on screen cleared. Your results stay in History.', 'ok', 8000, {
      label: 'Undo',
      run: () => {
        setS(before.s);
        setSelected(before.selected);
      },
    });
    promptRef.current?.focus();
  };

  const finetunes = useFinetunes();
  const m = boot?.manifest;
  const model = m?.models[s.model] ?? m?.models.klein;
  const styles = boot?.styles.styles ?? [];
  const job: Job | undefined = jobId ? jobs[jobId] : undefined;
  const running = !!job && (job.status === 'queued' || job.status === 'running');
  const aspectsFor = (mm: typeof model, quality?: string) => mm?.quality?.[quality ?? 'standard']?.aspects ?? mm?.aspects;
  /** Each model keeps its own quality choice. */
  const qualityOf = (st: Pick<GenSettings, 'model' | 'quality' | 'kleinQuality'>) => (st.model === 'klein' ? st.kleinQuality : st.quality) ?? 'standard';
  const [w, h] = model ? aspectsFor(model, qualityOf(s))![s.aspect] : [1024, 1024];
  const T = boot?.prompts;

  const update = (p: Partial<GenSettings>) => setS((prev) => ({ ...prev, ...p }));
  const promptVariations = useMemo(() => expandVariations(s.prompt, MAX_VARIATIONS), [s.prompt]);

  const selectModel = (key: string) => {
    const mm = m!.models[key];
    update({ model: key, steps: mm.defaults.steps, cfg: mm.defaults.cfg });
  };

  // Strip = all outputs of the selected item's job, or of every variation of the last click when it belongs to that run.
  useEffect(() => {
    if (!selectedItem?.job_id) {
      setStrip(selectedItem ? [selectedItem] : []);
      return;
    }
    const jobsToShow = runJobs.includes(selectedItem.job_id) ? runJobs : [selectedItem.job_id];
    Promise.all(jobsToShow.map((id) => api.get<Item[]>(`/api/jobs/${id}/items`).catch(() => [] as Item[])))
      .then((lists) => {
        const live = lists.flat().filter((i) => !i.deleted_at);
        setStrip(live.length ? live : [selectedItem]);
      })
      .catch(() => setStrip([selectedItem]));
  }, [selectedItem?.id, selectedItem?.job_id, runTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // When our job finishes, show its results.
  useEffect(
    () =>
      onJob((j) => {
        if (runJobs.includes(j.id) && j.id !== jobId && (j.status === 'done' || j.status === 'error')) setRunTick((t) => t + 1);
        if (j.id !== jobId) return;
        if (j.status === 'done' && j.result_ids.length) {
          setSelected(j.result_ids[0]);
        }
        if (j.status === 'error' || j.status === 'lost') toast(j.error ?? 'Generation failed.', 'error');
      }),
    [jobId, runJobs], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // "Reuse settings" from Library / elsewhere: #/generate?reuse=<id>
  // #/generate?prompt=...&model=...  (from Library "Reverse prompt")
  const promptParam = query.get('prompt');
  useEffect(() => {
    if (!promptParam) return;
    const model = query.get('model');
    setS((p) => ({ ...p, prompt: promptParam, ...(model && m?.models[model] ? { model } : {}) }));
    go('generate');
  }, [promptParam]); // eslint-disable-line react-hooks/exhaustive-deps

  const replacePrompt = (text: string) => {
    setPromptUndo((u) => [...u.slice(-19), s.prompt]);
    update({ prompt: text });
    promptRef.current?.focus();
  };

  const enhance = async () => {
    if (!s.prompt.trim()) return toast('Type a short idea first, then press Enhance.', 'info');
    const styleName = s.style !== 'none' ? styles.find((x) => x.id === s.style)?.label : undefined;
    setVlmBusy('enhance');
    try {
      // the chosen style shapes the enhanced prompt (DECISIONS 93); Generate still adds the style's own sentence
      const r = await api.vlm({ task: 'enhance', variant: s.model, text: s.prompt, style: s.style });
      replacePrompt(r.text);
      // Qwen: the official PE-T2I also picks the frame (wh_ratio); follow it, snapped to Darkroom's aspects
      const aspect = r.aspect as Aspect | null | undefined;
      if (aspect && aspect !== s.aspect && ASPECTS.includes(aspect)) update({ aspect });
      toast(
        `Prompt enhanced${styleName ? ` for ${styleName}` : ''} by ${r.model ?? 'the local model'} in ${r.seconds}s${aspect && r.ratio ? `; frame set to ${aspect} (suggested ${r.ratio})` : ''}. Edit it freely; Undo brings back yours.`,
        'ok',
        8000,
      );
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setVlmBusy(null);
    }
  };

  const reverseFrom = async (src: { input?: string; itemId?: string }) => {
    setVlmBusy('reverse');
    try {
      const r = await api.vlm({ task: 'reverse', variant: s.model, ...src });
      replacePrompt(r.text);
      toast(`Prompt written from the picture for ${m?.models[s.model]?.label} in ${r.seconds}s.`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setVlmBusy(null);
    }
  };

  /** "From references": a prompt that combines every reference (with your text as the idea), using the model's tokens. */
  const composeFromRefs = async () => {
    setVlmBusy('reverse');
    try {
      const r = await api.vlm({ task: 'compose', variant: s.model, text: s.prompt, inputs: s.refs.map((x) => x.name) });
      replacePrompt(r.text);
      toast(`Prompt written from ${s.refs.length === 1 ? 'the reference' : `${s.refs.length} references`} for ${m?.models[s.model]?.label} in ${r.seconds}s. Undo puts your text back.`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setVlmBusy(null);
    }
  };

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

  // ?ref=<item> from the Library's "Use as… > Generate reference"
  const refParam = query.get('ref');
  useEffect(() => {
    if (!refParam) return;
    void addRefItem(refParam).then(() => go('generate'));
  }, [refParam]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // prompt variations: {a|b} groups expand to one job each, all on the same seed so only the wording differs
    const variations = expandVariations(cur.prompt, MAX_VARIATIONS);
    if (variations.prompts.length * cur.batch > MAX_PICTURES) {
      toast(
        `That is ${variations.prompts.length} variations × batch ${cur.batch} = ${variations.prompts.length * cur.batch} pictures. Keep it to ${MAX_PICTURES} at most: lower the batch or remove an option.`,
        'info',
        9000,
      );
      return;
    }
    if (variations.total > MAX_VARIATIONS) toast(`Your prompt describes ${variations.total} variations; rendering the first ${MAX_VARIATIONS}.`, 'info', 8000);
    const seed = cur.seedLocked ? cur.seed : randomSeed();
    if (!cur.seedLocked) update({ seed });
    const style = styles.find((x) => x.id === cur.style);
    const mm = m.models[cur.model];
    const compose = (text: string) =>
      composeImagePrompt(boot!.prompts, {
        model: cur.model as ImageModelKey,
        mode: 'generate',
        text,
        style: style ?? null,
        transparent: cur.model === 'qwen' && !!cur.transparent,
      });
    const wf = cur.refs.length ? mm.ref : mm.t2i;
    const q = mm.quality?.[qualityOf(cur)];
    const [ww, hh] = aspectsFor(mm, qualityOf(cur))![cur.aspect];
    const params: Record<string, string | number> = {
      seed,
      steps: q?.steps ?? cur.steps,
      cfg: mm.ranges.cfg[0] === mm.ranges.cfg[1] ? mm.ranges.cfg[0] : cur.cfg,
      width: ww,
      height: hh,
      batch: cur.batch,
    };
    cur.refs.forEach((r, i) => (params[`image_${i + 1}`] = r.name));
    const loras = cur.loras?.[cur.model] ?? [];
    if (loras.length) params.loras = JSON.stringify(loras);
    if (cur.model === 'klein' && cur.kleinWeights) params.klein_weights = cur.kleinWeights;
    const modelLabel = cur.model === 'klein' ? kleinLabel(cur.kleinWeights, finetunes) : mm.label;
    try {
      const ids: string[] = [];
      for (const text of variations.prompts) {
        const fullPrompt = compose(text);
        const j = await api.submit({
          workflow: wf,
          params: { ...params, prompt: fullPrompt },
          meta: {
            mode: 'generate',
            model: cur.refs.length ? `${modelLabel} + refs` : modelLabel,
            prompt: fullPrompt,
            parentId,
            // the settings keep the prompt as typed (with its {a|b} groups), so Reuse / Restore bring the template back
            ui: { ...cur, seed },
          },
        });
        ids.push(j.id);
      }
      setRunJobs(ids);
      setJobId(ids[0]);
      if (ids.length > 1) toast(`${ids.length} variations queued on the same seed; they appear together under the picture.`, 'info', 6000);
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
            {/* label on its own line, prompt tools in a wrapping row below it (they overflowed the 380 px panel) */}
            <div className="section-label" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
              <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label htmlFor="prompt">Prompt</label>
                <button
                  type="button"
                  className="btn ghost sm new-btn"
                  onClick={startNew}
                  disabled={!s.prompt && !s.refs.length && !selected}
                  title="Start a new picture: clears the prompt, references and the picture on screen (your results stay in History). Undo in the notice."
                >
                  <Plus size={14} /> New
                </button>
              </span>
              <span className="prompt-tools" style={{ display: 'flex', gap: 2, flexWrap: 'wrap', marginLeft: -8, textTransform: 'none', letterSpacing: 'normal' }}>
                {promptUndo.length > 0 && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    title="Put back the prompt from before the last Enhance / From picture"
                    onClick={() => {
                      update({ prompt: promptUndo[promptUndo.length - 1] });
                      setPromptUndo((u) => u.slice(0, -1));
                    }}
                  >
                    <Undo2 size={14} /> Undo
                  </button>
                )}
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={!!vlmBusy || !online}
                  title={
                    s.refs.length
                      ? `Write a ${model.label} prompt that combines your references (and your text, if any), naming what to take from each`
                      : `Write a ${model.label} prompt that recreates a picture you pick`
                  }
                  onClick={() => (s.refs.length ? void composeFromRefs() : reverseInput.current?.click())}
                >
                  {vlmBusy === 'reverse' ? <Loader2 size={14} className="spin" /> : <ScanText size={14} />} {s.refs.length ? 'From references' : 'From picture'}
                </button>
                <input
                  ref={reverseInput}
                  className="sr"
                  type="file"
                  accept="image/*"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    const up = await api.upload(f, f.name);
                    void reverseFrom({ input: up.name });
                  }}
                />
                <button
                  type="button"
                  className="btn ghost sm"
                  title="Load the exact settings from a picture Darkroom saved (or its settings JSON), even one that is no longer in the Library"
                  onClick={() => restoreInput.current?.click()}
                >
                  <History size={14} /> Restore
                </button>
                <input
                  ref={restoreInput}
                  className="sr"
                  type="file"
                  accept="image/png,application/json,.json"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    try {
                      const fd = new FormData();
                      fd.append('file', f, f.name);
                      const r = await fetch('/api/restore', { method: 'POST', body: fd });
                      const meta = await r.json();
                      if (!r.ok) return toast(meta.error ?? 'Could not read that file.', 'error');
                      const ui = meta.ui as Partial<GenSettings> | null;
                      if (meta.mode === 'generate' && ui?.model) {
                        setS((p) => ({ ...p, ...ui, seedLocked: true, refs: ui.refs ?? [] }));
                        toast('Settings restored from the file. Seed is locked so you get the same picture.', 'ok');
                      } else {
                        const seed = Number((meta.params as Record<string, unknown> | undefined)?.seed ?? NaN);
                        update({ prompt: String(meta.prompt ?? ''), ...(Number.isFinite(seed) ? { seed, seedLocked: true } : {}) });
                        toast(meta.mode && meta.mode !== 'generate' ? `That picture was made in ${meta.mode.replace('edit:', 'Edit › ')}; its prompt${Number.isFinite(seed) ? ' and seed were' : ' was'} loaded.` : 'Prompt and seed restored.', 'ok');
                      }
                      promptRef.current?.focus();
                    } catch (err) {
                      toast((err as Error).message, 'error');
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={!!vlmBusy || !online}
                  title={`Expand your idea into a detailed ${model.label} prompt (local Qwen3-VL). You can edit the result before generating.`}
                  onClick={() => void enhance()}
                >
                  {vlmBusy === 'enhance' ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Enhance
                </button>
              </span>
            </div>
            <textarea
              id="prompt"
              ref={promptRef}
              className="input"
              placeholder="Describe the image… e.g. a ceramic teapot on a linen tablecloth, morning light"
              value={s.prompt}
              onChange={(e) => update({ prompt: e.target.value })}
              rows={5}
            />
            {promptVariations.total > 1 ? (
              <details className="variations">
                <summary>
                  {promptVariations.prompts.length} variations
                  {s.batch > 1 ? ` × batch ${s.batch} = ${promptVariations.prompts.length * s.batch} pictures` : ''}
                  {promptVariations.total > MAX_VARIATIONS ? ` (of ${promptVariations.total}; the first ${MAX_VARIATIONS} are rendered)` : ''}
                </summary>
                <ol>
                  {promptVariations.prompts.map((v, i) => (
                    <li key={i}>{v}</li>
                  ))}
                </ol>
              </details>
            ) : (
              <p className="note variations-hint">Tip: {'{red|green|blue}'} in the prompt makes one picture per option.</p>
            )}
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

          {s.model === 'klein' && <KleinWeights value={s.kleinWeights ?? ''} onChange={(v) => update({ kleinWeights: v })} />}

          {/* quality sits with the model: it is the biggest quality choice after the model itself */}
          {model.quality && (
            <div>
              <p className="section-label">
                Quality <span className="mono">{model.quality[qualityOf(s)]?.note}</span>
              </p>
              <Segmented
                label="Quality"
                options={Object.entries(model.quality).map(([k, v]) => ({ value: k, label: v.label, title: v.note }))}
                value={qualityOf(s)}
                onChange={(q) => update(s.model === 'klein' ? { kleinQuality: q } : { quality: q })}
              />
              {s.model === 'qwen' && (
                <label className="check" title="Qwen-Image 2.1 can paint a real transparent background (saved as PNG with alpha)">
                  <input type="checkbox" checked={!!s.transparent} onChange={(e) => update({ transparent: e.target.checked })} />
                  Transparent background
                </label>
              )}
            </div>
          )}

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

          {(s.model === 'klein' || s.model === 'qwen') && (
            <LoraPicker family={s.model} value={s.loras?.[s.model] ?? []} onChange={(v) => update({ loras: { ...(s.loras ?? {}), [s.model]: v } })} />
          )}

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
              <img key={selectedItem.id} className="develop" src={fileUrl(selectedItem.id)} alt={selectedItem.prompt} />
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
              <button
                className="btn sm"
                onClick={() => {
                  sessionStorage.setItem('dr.edit.mode', 'enhance');
                  go('edit', selectedItem.id);
                }}
              >
                <Sparkles size={15} /> Enhance
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
              <button key={it.id} aria-pressed={it.id === selected} onClick={() => setSelected(it.id)} title={strip.length > 1 && strip.some((x) => x.prompt !== it.prompt) ? it.prompt : `Seed ${it.seed}`}>
                <img src={thumbUrl(it.id)} alt="" />
              </button>
            ))}
        </div>
      </section>

      <aside className="rail" aria-label="History">
        <h3>History</h3>
        {history.length === 0 && <p className="note" style={{ textAlign: 'center' }}>Your results appear here.</p>}
        {history.map((it) => (
          <div key={it.id} className="rail-item">
            <button
              aria-pressed={it.id === selected}
              aria-label={`Show: ${it.prompt || 'picture'}`}
              title={`${it.title || it.prompt || 'Picture'}
Delete key removes it (Undo in the notice)`}
              onClick={() => setSelected(it.id)}
              onKeyDown={(e) => e.key === 'Delete' && (e.preventDefault(), void removeFromHistory(it.id))}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('application/x-darkroom-item', it.id)}
            >
              <img src={thumbUrl(it.id)} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} />
            </button>
            <button className="rail-delete" aria-label="Delete this picture" title="Delete (moves it to Recently deleted)" onClick={() => void removeFromHistory(it.id)}>
              <X size={13} />
            </button>
          </div>
        ))}
        {history.length > 0 && (
          <button className="btn ghost sm rail-more" onClick={() => openLibrary('all')}>
            See all in Library
          </button>
        )}
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
