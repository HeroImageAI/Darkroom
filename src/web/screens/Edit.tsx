import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Brush,
  Columns2,
  Crop,
  Download,
  Eraser,
  Expand,
  Film,
  FlipHorizontal2,
  Hand,
  ImagePlus,
  Lasso,
  Maximize,
  Monitor,
  Redo2,
  ScanSearch,
  Trash2,
  Undo2,
  Wand2,
  X,
} from 'lucide-react';
import { api, downloadUrl, fileUrl, inputUrl, thumbUrl, type Item, type Job } from '../api';
import { ProgressBar, randomSeed, useHotkey } from '../components/common';
import { useItem } from '../lib/hooks';
import { CompareView } from '../components/Compare';
import { LayerStack, LayersPanel, useLayerGroup } from '../components/LayersPanel';
import { CropDialog, grabScreenFrame } from '../lib/capture';
import { MaskLayer, padToAspect, zoomOut } from '../lib/mask';
import { go } from '../router';
import { captionFromLineage, composeImagePrompt, type CaptionSource, type ImageModelKey } from '../../shared/prompts';
import { planEnhance } from '../../shared/enhance';
import { onJob, toast, useApp } from '../store';

type Tool = 'move' | 'brush' | 'eraser' | 'lasso' | 'smart' | 'frame' | 'crop';
type Mode = 'instruct' | 'inpaint' | 'outpaint' | 'enhance' | 'remove_bg' | 'layers' | 'upscale';
type EnhanceKind = 'subtle' | 'strong' | 'upscale';
interface Pad {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const TOOLS: { id: Tool; label: string; key: string; icon: typeof Brush; disabled?: string }[] = [
  { id: 'move', label: 'Move', key: 'V', icon: Hand },
  { id: 'brush', label: 'Mask brush', key: 'B', icon: Brush },
  { id: 'eraser', label: 'Eraser', key: 'E', icon: Eraser },
  { id: 'lasso', label: 'Lasso', key: 'L', icon: Lasso },
  { id: 'smart', label: 'Smart select', key: 'S', icon: ScanSearch },
  { id: 'frame', label: 'Outpaint frame', key: 'O', icon: Expand },
  { id: 'crop', label: 'Crop', key: 'C', icon: Crop },
];

const MODES: { id: Mode; label: string }[] = [
  { id: 'instruct', label: 'Instruct' },
  { id: 'inpaint', label: 'Inpaint' },
  { id: 'outpaint', label: 'Outpaint' },
  { id: 'enhance', label: 'Enhance' },
  { id: 'layers', label: 'Layers' },
  { id: 'remove_bg', label: 'Remove BG' },
  { id: 'upscale', label: 'Upscale' },
];

const CHECKER = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16' fill='%23222'/%3E%3Crect width='8' height='8' fill='%232b2b2b'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%232b2b2b'/%3E%3C/svg%3E\")";
const ZERO_PAD: Pad = { left: 0, top: 0, right: 0, bottom: 0 };

export function Edit({ id }: { id?: string }) {
  const item = useItem(id);
  if (!id) return <EditEmpty />;
  if (!item) return <div className="empty" style={{ margin: 'auto' }}>Opening…</div>;
  return <Editor key={item.id} item={item} />;
}

function Editor({ item }: { item: Item }) {
  const jobs = useApp((s) => s.jobs);
  const online = useApp((s) => s.status?.comfy === 'online');
  const rev = useApp((s) => s.libraryRev);
  const [lineage, setLineage] = useState<Item[]>([]);
  const [tool, setTool] = useState<Tool>('brush');
  const [mode, setMode] = useState<Mode>(() => (sessionStorage.getItem('dr.edit.mode') as Mode) || 'instruct');
  const boot = useApp((s) => s.boot);
  const [editModel, setEditModel] = useState<string>(() => localStorage.getItem('dr.edit.model') || 'qwen');
  const [enhanceKind, setEnhanceKind] = useState<EnhanceKind>('subtle');
  const [enhanceAdv, setEnhanceAdv] = useState(false);
  const [denoise, setDenoise] = useState<number | null>(null); // null = model default for the chosen strength
  useEffect(() => {
    try {
      localStorage.setItem('dr.edit.model', editModel);
    } catch {
      /* storage blocked */
    }
  }, [editModel]);
  const modelLabel = boot?.manifest.models[editModel]?.label ?? editModel;
  const wfFor = (m: 'instruct' | 'inpaint' | 'outpaint' | 'enhance') =>
    boot?.manifest.edit?.[m]?.[editModel] ?? { instruct: 'qwen_edit', inpaint: 'inpaint', outpaint: 'outpaint', enhance: 'qwen_enhance' }[m];
  const enhanceDefaults = (boot?.manifest as any)?.enhance?.[editModel] as { subtle: number; strong: number } | undefined;
  const effDenoise = denoise ?? (enhanceKind === 'strong' ? enhanceDefaults?.strong : enhanceDefaults?.subtle) ?? 0.3;
  const [brush, setBrush] = useState(64);
  const [feather, setFeather] = useState(8);
  const [prompt, setPrompt] = useState(() => sessionStorage.getItem('dr.edit.prompt') ?? '');
  const [onlyMasked, setOnlyMasked] = useState(true);
  const [ref, setRef] = useState<{ name: string } | null>(null);
  const [pad, setPad] = useState<Pad>(ZERO_PAD);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [compare, setCompare] = useState(false);
  const [jobId, setJobId] = useState<string | null>(() => sessionStorage.getItem('dr.edit.job'));
  const [maskEmpty, setMaskEmpty] = useState(true);
  const [lasso, setLasso] = useState<{ x: number; y: number }[] | null>(null);
  // Smart select (SAM 3.1)
  const [samPts, setSamPts] = useState<{ x: number; y: number; neg: boolean }[]>([]);
  const [samBox, setSamBox] = useState<Rect | null>(null);
  const [samText, setSamText] = useState('');
  const [samOp, setSamOp] = useState<'add' | 'subtract' | 'replace'>('add');
  const [samBusy, setSamBusy] = useState(false);
  // Remove BG v2
  const [bgSubject, setBgSubject] = useState('');
  const [bgMatte, setBgMatte] = useState('birefnet.safetensors');
  const [bgEdge, setBgEdge] = useState(0);
  const [bgPlate, setBgPlate] = useState(false);
  // Layers
  const [layerMode, setLayerMode] = useState<'sam' | 'qwen'>('sam');
  const [layerText, setLayerText] = useState('');
  const [layerCount, setLayerCount] = useState(4);
  const [layerFill, setLayerFill] = useState(true);
  const [layerGroup, setLayerGroup] = useState<string | null>(null);
  const layersState = useLayerGroup(layerGroup);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const viewCanvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<MaskLayer | null>(null);
  const drag = useRef<{ kind: 'pan' | 'paint' | 'lasso' | 'frame' | 'crop' | 'sam'; sx: number; sy: number; vx: number; vy: number; side?: keyof Pad; start?: Pad; origin?: { x: number; y: number } } | null>(null);

  const job: Job | undefined = jobId ? jobs[jobId] : undefined;
  const running = !!job && (job.status === 'queued' || job.status === 'running');
  const W = item.width ?? 1;
  const H = item.height ?? 1;

  useEffect(() => sessionStorage.setItem('dr.edit.prompt', prompt), [prompt]);
  // Don't lose a painted mask by closing the tab.
  useEffect(() => {
    if (maskEmpty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [maskEmpty]);
  useEffect(() => sessionStorage.setItem('dr.edit.mode', mode), [mode]);
  useEffect(() => {
    if (jobId) sessionStorage.setItem('dr.edit.job', jobId);
  }, [jobId]);

  useEffect(() => {
    api.item(item.id).then((r) => setLineage(r.lineage));
  }, [item.id, rev]);

  useEffect(() => {
    if (!viewCanvas.current) return;
    layer.current = new MaskLayer(W, H, viewCanvas.current);
  }, [W, H]);

  const fit = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    const tw = W + pad.left + pad.right;
    const th = H + pad.top + pad.bottom;
    const s = Math.min((el.clientWidth - 64) / tw, (el.clientHeight - 64) / th, 2);
    setView({ scale: s, x: (el.clientWidth - tw * s) / 2 + pad.left * s, y: (el.clientHeight - th * s) / 2 + pad.top * s });
  }, [W, H, pad]);

  useEffect(() => {
    fit();
    const r = () => fit();
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () =>
      onJob((j) => {
        // a server-side follow-up of the job we're waiting on (pre-upscale -> enhance, enhance -> upscale): track that instead
        if (jobId && (j.meta as any).followOf === jobId) return setJobId(j.id);
        if (j.id !== jobId) return;
        const chainKind = (j.meta as any).chain?.kind as string | undefined;
        if (j.status === 'done' && (chainKind === 'upscale' || chainKind === 'enhance')) return; // wait for the follow-up
        if (j.status === 'done' && (j.meta as any).layers) {
          sessionStorage.removeItem('dr.edit.job');
          setLayerGroup(j.id);
          toast(`${j.result_ids.length} layers ready. Toggle, reorder, rename and export them on the right.`, 'ok');
          return;
        }
        if (j.status === 'done' && j.result_ids[0]) {
          sessionStorage.removeItem('dr.edit.job');
          go('edit', j.result_ids[0]);
          toast('New version saved. Earlier versions are untouched.', 'ok');
        }
        if (j.status === 'error' || j.status === 'lost') toast(j.error ?? 'That edit failed.', 'error');
      }),
    [jobId],
  );

  const toImage = (e: { clientX: number; clientY: number }) => {
    const r = imgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (compare || e.button === 2) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const base = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    if (tool === 'move' || e.button === 1 || e.altKey) {
      drag.current = { kind: 'pan', ...base };
      return;
    }
    const p = toImage(e);
    if (tool === 'brush' || tool === 'eraser') {
      layer.current?.beginStroke(p.x, p.y, brush, tool === 'eraser');
      drag.current = { kind: 'paint', ...base };
    } else if (tool === 'lasso') {
      setLasso([p]);
      drag.current = { kind: 'lasso', ...base };
    } else if (tool === 'frame') {
      const d = { left: Math.abs(p.x), right: Math.abs(W - p.x), top: Math.abs(p.y), bottom: Math.abs(H - p.y) };
      const side = (Object.keys(d) as (keyof Pad)[]).sort((a, b) => d[a] - d[b])[0];
      drag.current = { kind: 'frame', ...base, side, start: pad };
      setMode('outpaint');
    } else if (tool === 'crop') {
      const q = { x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)) };
      drag.current = { kind: 'crop', ...base, origin: q };
      setCrop({ ...q, w: 0, h: 0 });
    } else if (tool === 'smart') {
      drag.current = { kind: 'sam', ...base, origin: p };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const r = stageRef.current!.getBoundingClientRect();
    setCursor({ x: e.clientX - r.left, y: e.clientY - r.top });
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pan') setView((v) => ({ ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy }));
    else if (d.kind === 'paint') {
      const p = toImage(e);
      layer.current?.strokeTo(p.x, p.y, brush, tool === 'eraser');
    } else if (d.kind === 'lasso') setLasso((pts) => [...(pts ?? []), toImage(e)]);
    else if (d.kind === 'frame' && d.side && d.start) {
      const dx = (e.clientX - d.sx) / view.scale;
      const dy = (e.clientY - d.sy) / view.scale;
      const delta = d.side === 'left' ? -dx : d.side === 'right' ? dx : d.side === 'top' ? -dy : dy;
      const v = Math.max(0, Math.min(2048, Math.round((d.start[d.side] + delta) / 8) * 8));
      setPad((p) => ({ ...p, [d.side!]: v }));
    } else if (d.kind === 'sam' && d.origin && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 8) {
      const p = toImage(e);
      setSamBox({ x: Math.min(d.origin.x, p.x), y: Math.min(d.origin.y, p.y), w: Math.abs(p.x - d.origin.x), h: Math.abs(p.y - d.origin.y) });
    } else if (d.kind === 'crop' && d.origin) {
      const p = toImage(e);
      const q = { x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)) };
      setCrop({ x: Math.min(d.origin.x, q.x), y: Math.min(d.origin.y, q.y), w: Math.abs(q.x - d.origin.x), h: Math.abs(q.y - d.origin.y) });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'paint') {
      layer.current?.endStroke();
      setMaskEmpty(!!layer.current?.isEmpty());
    } else if (d.kind === 'lasso' && lasso) {
      layer.current?.fillPolygon(lasso, e.shiftKey);
      setLasso(null);
      setMaskEmpty(!!layer.current?.isEmpty());
    } else if (d.kind === 'sam' && d.origin) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) <= 8) {
        setSamBox(null);
        setSamPts((pts) => [...pts, { x: d.origin!.x, y: d.origin!.y, neg: e.shiftKey }]);
      }
    }
  };

  const runSam = async (useText: boolean) => {
    if (samBusy) return;
    const pos = samPts.filter((p) => !p.neg);
    const neg = samPts.filter((p) => p.neg);
    if (useText && !samText.trim()) return toast('Type what to select, e.g. "the dog" or "person:2".', 'info');
    if (!useText && !pos.length && !samBox) return toast('Click on the object (Shift-click to exclude) or drag a box around it.', 'info');
    setSamBusy(true);
    try {
      const r = await api.post<{ masks: string[]; seconds: number }>('/api/segment', {
        itemId: item.id,
        text: useText ? samText : undefined,
        points: useText ? undefined : pos,
        negPoints: useText ? undefined : neg,
        box: !useText && samBox ? { x: samBox.x, y: samBox.y, width: samBox.w, height: samBox.h } : undefined,
      });
      if (!r.masks.length) return toast('Nothing was found there. Try another click, a box, or different words.', 'info');
      const img = new Image();
      img.src = r.masks[0];
      await img.decode();
      layer.current?.applyMaskImage(img, samOp);
      setMaskEmpty(!!layer.current?.isEmpty());
      setSamPts([]);
      setSamBox(null);
      toast(`Selection ${samOp === 'subtract' ? 'removed from' : 'added to'} the mask (${r.seconds}s). Use it with Instruct, Inpaint or Remove BG.`, 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSamBusy(false);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const r = stageRef.current!.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    setView((v) => {
      const s = Math.min(8, Math.max(0.05, v.scale * factor));
      const k = s / v.scale;
      return { scale: s, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
    });
  };

  // Undo/redo: mask strokes first; otherwise step through saved versions (never deletes anything).
  const versionIndex = lineage.findIndex((v) => v.id === item.id);
  const undo = () => {
    if (layer.current?.undo()) return setMaskEmpty(layer.current.isEmpty());
    if (versionIndex > 0) go('edit', lineage[versionIndex - 1].id);
  };
  const redo = () => {
    if (layer.current?.redo()) return setMaskEmpty(layer.current.isEmpty());
    if (versionIndex >= 0 && versionIndex < lineage.length - 1) go('edit', lineage[versionIndex + 1].id);
  };

  useHotkey((e) => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey, (e) => (e.preventDefault(), undo()), [lineage, item.id]);
  useHotkey((e) => (e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)), (e) => (e.preventDefault(), redo()), [lineage, item.id]);
  useHotkey(
    (e) => !e.ctrlKey && !e.metaKey && !e.altKey && TOOLS.some((t) => t.key.toLowerCase() === e.key.toLowerCase() && !t.disabled),
    (e) => {
      const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase())!.id;
      setTool(t);
      if (t === 'frame') setMode('outpaint');
    },
    [],
  );
  useHotkey((e) => e.key === '[' || e.key === ']', (e) => setBrush((b) => Math.max(4, Math.min(400, b + (e.key === ']' ? 8 : -8)))), []);

  const uploadMask = async () => {
    const blob = await layer.current!.exportPng(feather);
    return (await api.upload(blob, 'mask.png')).name;
  };

  const submit = async (workflow: string, params: Record<string, string | number>, modeKey: string, model: string, promptText = '') => {
    try {
      const inp = await api.asInput(item.id);
      const j = await api.submit({
        workflow,
        params: { image_1: inp.name, seed: randomSeed(), ...params },
        meta: { mode: modeKey, model, prompt: promptText || item.prompt, parentId: item.id, ui: item.ui },
      });
      setJobId(j.id);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const apply = async () => {
    if (running) return;
    if (tool === 'crop') {
      if (!crop || crop.w < 16 || crop.h < 16) return toast('Drag a crop box on the picture first.', 'info');
      return submit('crop', { width: Math.round(crop.w), height: Math.round(crop.h), x: Math.round(crop.x), y: Math.round(crop.y) }, 'edit:crop', 'Crop');
    }
    const T = boot!.prompts;
    const em = editModel as ImageModelKey;
    let caption = captionFromLineage(lineage as unknown as CaptionSource[], item.id);
    if (!caption && em === 'qwen' && (mode === 'inpaint' || mode === 'outpaint')) {
      // Qwen's official fill templates want a caption of the original; describe the picture once and remember it.
      toast('Describing the picture first (local Qwen3-VL)…', 'info');
      try {
        caption = (await api.vlm({ task: 'caption', variant: 'short', itemId: item.id, save: true })).text;
      } catch {
        caption = null;
      }
    }
    /** Lineage / saved caption, or describe the picture now with the local VLM (saved to the item). */
    const ensureCaption = async (variant: 'short' | 'klein'): Promise<string | null> => {
      const known = caption ?? ((item.ui as any)?.caption as string | undefined) ?? null;
      if (known) return known;
      toast('Describing the picture first (local Qwen3-VL)…', 'info');
      try {
        return (await api.vlm({ task: 'caption', variant, itemId: item.id, save: true })).text;
      } catch {
        return null;
      }
    };
    if (mode === 'instruct') {
      if (!prompt.trim()) return toast('Type an instruction first, e.g. “make it night time”.', 'info');
      const masked = onlyMasked && !maskEmpty;
      const params: Record<string, string | number> = { prompt: composeImagePrompt(T, { model: em, mode: 'instruct', text: prompt, masked }) };
      if (ref) params.image_2 = ref.name;
      if (masked) params.mask = await uploadMask();
      return submit(wfFor('instruct'), params, 'edit:instruct', `${modelLabel} edit`, prompt.trim());
    }
    if (mode === 'inpaint') {
      if (maskEmpty) return toast('Paint over the area to replace first (B for brush).', 'info');
      if (!prompt.trim()) return toast('Describe what should appear in the masked area.', 'info');
      const params: Record<string, string | number> = {
        prompt: composeImagePrompt(T, { model: em, mode: 'inpaint', text: prompt, caption }),
        mask: await uploadMask(),
        feather: Math.round(feather),
      };
      if (ref) params.image_2 = ref.name;
      return submit(wfFor('inpaint'), params, 'edit:inpaint', `${modelLabel} fill`, prompt.trim());
    }
    if (mode === 'outpaint') {
      if (!pad.left && !pad.right && !pad.top && !pad.bottom) return toast('Choose how far to extend: drag an edge with the frame tool (O) or use a preset.', 'info');
      const text = prompt.trim();
      const params: Record<string, string | number> = {
        prompt: composeImagePrompt(T, { model: em, mode: 'outpaint', text, caption }),
        pad_left: pad.left,
        pad_top: pad.top,
        pad_right: pad.right,
        pad_bottom: pad.bottom,
      };
      if (ref) params.image_2 = ref.name;
      return submit(wfFor('outpaint'), params, 'edit:outpaint', `${modelLabel} outpaint`, text || 'Outpaint');
    }
    if (mode === 'enhance') {
      const cap = await ensureCaption(em === 'klein' ? 'klein' : 'short');
      const strength = enhanceKind === 'strong' ? 'strong' : 'subtle';
      const plan = planEnhance(W, H);
      const params: Record<string, string | number> = {
        prompt: composeImagePrompt(T, { model: em, mode: 'enhance', text: '', caption: cap, strength }),
        denoise: effDenoise,
        megapixels: plan.megapixels,
      };
      if (em === 'klein') params.schedule_steps = Math.max(4, Math.round(4 / effDenoise));
      const label = `${modelLabel} enhance (${enhanceKind === 'upscale' ? 'upscale + enhance' : strength})`;
      const ui = { ...item.ui, caption: cap ?? undefined };
      const enhanceMeta = { mode: 'edit:enhance', model: label, prompt: item.prompt, ui, chain: enhanceKind === 'upscale' ? { kind: 'upscale' } : undefined };
      try {
        const inp = await api.asInput(item.id);
        const j = plan.preScale
          ? // small source: SeedVR2 first, then the enhance pass runs on its result (server chain)
            await api.submit({
              workflow: 'upscale',
              params: { image_1: inp.name, scale: plan.preScale, seed: randomSeed() },
              meta: { mode: 'upscale', model: 'SeedVR2 7B', prompt: item.prompt, parentId: item.id, ui, chain: { kind: 'enhance', workflow: wfFor('enhance'), params, meta: enhanceMeta } },
            })
          : await api.submit({ workflow: wfFor('enhance'), params: { image_1: inp.name, seed: randomSeed(), ...params }, meta: { ...enhanceMeta, parentId: item.id } });
        setJobId(j.id);
        if (plan.preScale) toast(`Small picture: upscaling ${plan.preScale}× with SeedVR2 first, then enhancing — the enhanced version opens when it is ready.`, 'info', 7000);
        else if (enhanceKind === 'upscale') toast('Enhancing, then upscaling 2× with SeedVR2 — the upscaled version opens when it is ready.', 'info', 7000);
      } catch (err) {
        toast((err as Error).message, 'error');
      }
      return;
    }
    if (mode === 'remove_bg') {
      const params: Record<string, string | number> = { matte: bgMatte, edge: bgEdge };
      if (bgSubject.trim()) params.subject = bgSubject.trim();
      const matteName = bgMatte.startsWith('lucida') ? 'Lucida' : 'BiRefNet';
      const plateCaption = caption ?? ((item.ui as any)?.caption as string | undefined) ?? null;
      try {
        const inp = await api.asInput(item.id);
        const j = await api.submit({
          workflow: 'remove_bg',
          params: { image_1: inp.name, ...params },
          meta: {
            mode: 'edit:remove_bg',
            model: bgSubject.trim() ? `SAM 3.1 + ${matteName}` : matteName,
            prompt: item.prompt,
            parentId: item.id,
            ui: item.ui,
            chain: bgPlate
              ? { kind: 'plate', firstItemId: item.id, prompt: composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: 'the background, continuing the surrounding scene naturally with nothing in the way', caption: plateCaption, remove: true }) }
              : undefined,
          },
        });
        setJobId(j.id);
        if (bgPlate) toast('Cutting out; the background plate (Qwen-Image 2.1) follows and appears in the Library.', 'info', 7000);
      } catch (err) {
        toast((err as Error).message, 'error');
      }
      return;
    }
    if (mode === 'layers') {
      try {
        const inp = await api.asInput(item.id);
        if (layerMode === 'sam') {
          if (!layerText.trim()) return toast('List the objects to separate, e.g. "person, dog, car:2".', 'info');
          const j = await api.submit({
            workflow: 'sam_layers',
            params: { image_1: inp.name, text: layerText.trim() },
            meta: {
              mode: 'edit:layers',
              model: 'SAM 3.1 layers',
              prompt: layerText.trim(),
              parentId: item.id,
              ui: item.ui,
              layers: true,
              chain: layerFill
                ? { kind: 'plate', firstItemId: item.id, prompt: composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: 'the background, continuing the surrounding scene naturally with nothing in the way', caption: caption ?? null, remove: true }) }
                : undefined,
            },
          });
          setJobId(j.id);
        } else {
          // Qwen-Image-Layered needs a caption of the whole picture; with an empty prompt its layers come out as noise (Phase 6 QA)
          const cap = await ensureCaption('short');
          const j = await api.submit({
            workflow: 'qwen_layered',
            params: { image_1: inp.name, layers: layerCount, prompt: cap ?? '', seed: randomSeed() },
            meta: { mode: 'edit:layers', model: 'Qwen-Image-Layered', prompt: cap ?? '', parentId: item.id, ui: { ...item.ui, caption: cap ?? undefined }, layers: true },
          });
          setJobId(j.id);
          toast('Qwen-Image-Layered is slow (a few minutes). You can keep working; the layers appear when ready.', 'info', 8000);
        }
      } catch (err) {
        toast((err as Error).message, 'error');
      }
      return;
    }
    return submit('upscale', { scale: 2 }, 'upscale', 'SeedVR2 7B');
  };

  useHotkey((e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter', () => void apply(), [mode, prompt, pad, onlyMasked, ref, maskEmpty, crop, tool, running, feather], true);

  const addRef = async (file?: File, itemId?: string) => {
    try {
      if (itemId) setRef({ name: (await api.asInput(itemId)).name });
      else if (file) setRef({ name: (await api.upload(file, file.name)).name });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const parent = lineage.find((x) => x.id === item.parent_id) ?? null;
  const hasPad = pad.left + pad.right + pad.top + pad.bottom > 0;
  const applyLabel =
    tool === 'crop'
      ? 'Apply crop'
      : { instruct: 'Apply instruction', inpaint: 'Fill masked area', outpaint: 'Extend canvas', enhance: 'Enhance', remove_bg: 'Remove background', layers: 'Make layers', upscale: 'Upscale 2×' }[mode];

  return (
    <div className="screen" style={{ gridTemplateColumns: '68px 1fr 392px' }}>
      <nav className="panel" aria-label="Tools" style={{ alignItems: 'center', padding: '12px 0', gap: 6 }}>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`btn icon ${tool === t.id ? 'on' : 'ghost'}`}
            style={{ position: 'relative' }}
            aria-pressed={tool === t.id}
            title={t.disabled ?? `${t.label} (${t.key})`}
            aria-label={`${t.label} (${t.key})`}
            disabled={!!t.disabled}
            onClick={() => {
              setTool(t.id);
              if (t.id === 'frame') setMode('outpaint');
            }}
          >
            <t.icon size={18} />
            <span className="mono" aria-hidden="true" style={{ position: 'absolute', right: 3, bottom: 1, fontSize: 9, opacity: 0.6 }}>
              {t.key}
            </span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="btn icon ghost" onClick={undo} title="Undo (Ctrl+Z)" aria-label="Undo (Ctrl+Z)">
          <Undo2 size={18} />
        </button>
        <button className="btn icon ghost" onClick={redo} title="Redo (Ctrl+Y)" aria-label="Redo (Ctrl+Y)">
          <Redo2 size={18} />
        </button>
      </nav>

      <section className="stage" aria-label="Canvas">
        <div
          ref={stageRef}
          data-testid="edit-canvas"
          style={{
            flex: 1,
            minHeight: 0,
            position: 'relative',
            overflow: 'hidden',
            cursor: tool === 'move' ? 'grab' : tool === 'brush' || tool === 'eraser' ? 'none' : 'crosshair',
            touchAction: 'none',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setCursor(null)}
          onWheel={onWheel}
        >
          <div style={{ position: 'absolute', left: view.x, top: view.y, width: W * view.scale, height: H * view.scale }}>
            {hasPad && (
              <div
                aria-label="Outpaint frame"
                style={{
                  position: 'absolute',
                  left: -pad.left * view.scale,
                  top: -pad.top * view.scale,
                  width: (W + pad.left + pad.right) * view.scale,
                  height: (H + pad.top + pad.bottom) * view.scale,
                  border: '2px dashed var(--accent)',
                  background: 'rgba(240,180,76,0.07)',
                }}
              />
            )}
            {compare && parent ? (
              <CompareView before={fileUrl(parent.id)} after={fileUrl(item.id)} />
            ) : (
              <img
                ref={imgRef}
                src={fileUrl(item.id)}
                alt="Picture being edited"
                draggable={false}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', userSelect: 'none', background: CHECKER }}
              />
            )}
            <canvas ref={viewCanvas} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', display: compare ? 'none' : 'block' }} />
            {lasso && (
              <svg viewBox={`0 0 ${W} ${H}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
                <polyline points={lasso.map((p) => `${p.x},${p.y}`).join(' ')} fill="rgba(240,180,76,.2)" stroke="#F0B44C" strokeWidth={2 / view.scale} />
              </svg>
            )}
            {tool === 'smart' &&
              samPts.map((p, k) => (
                <div
                  key={k}
                  aria-hidden="true"
                  style={{ position: 'absolute', left: p.x * view.scale - 7, top: p.y * view.scale - 7, width: 14, height: 14, borderRadius: '50%', border: '2px solid #121210', background: p.neg ? '#E8765F' : '#6FCF8E', pointerEvents: 'none' }}
                />
              ))}
            {tool === 'smart' && samBox && (
              <div style={{ position: 'absolute', left: samBox.x * view.scale, top: samBox.y * view.scale, width: samBox.w * view.scale, height: samBox.h * view.scale, border: '2px dashed #6FCF8E', pointerEvents: 'none' }} />
            )}
            {mode === 'layers' && layersState.rows.length > 0 && <LayerStack rows={layersState.rows} />}
            {crop && tool === 'crop' && (
              <div style={{ position: 'absolute', left: crop.x * view.scale, top: crop.y * view.scale, width: crop.w * view.scale, height: crop.h * view.scale, border: '2px solid var(--accent)', boxShadow: '0 0 0 9999px rgba(0,0,0,.5)', pointerEvents: 'none' }} />
            )}
          </div>
          {(tool === 'brush' || tool === 'eraser') && cursor && !compare && (
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: cursor.x - (brush * view.scale) / 2,
                top: cursor.y - (brush * view.scale) / 2,
                width: brush * view.scale,
                height: brush * view.scale,
                pointerEvents: 'none',
                border: `1.5px solid ${tool === 'eraser' ? '#EDEBE5' : '#F0B44C'}`,
                borderRadius: '50%',
              }}
            />
          )}
          {running && (
            <div className="progress-overlay" style={{ zIndex: 2 }}>
              <span className="big-status">{job!.status === 'queued' ? 'Waiting in queue' : job!.stage}</span>
              <ProgressBar value={job!.progress} />
            </div>
          )}
          <div style={{ position: 'absolute', right: 12, top: 12, display: 'flex', gap: 6 }} onPointerDown={(e) => e.stopPropagation()}>
            <button className="btn sm" onClick={fit} title="Fit to screen">
              <Maximize size={14} /> Fit
            </button>
            <button className="btn sm" onClick={() => setView((v) => ({ ...v, scale: 1 }))} title="Actual pixels">
              100%
            </button>
            <span className="btn sm mono" style={{ pointerEvents: 'none' }}>
              {Math.round(view.scale * 100)}%
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderTop: '1px solid var(--line)', background: 'var(--panel)' }}>
          <span className="section-label" style={{ margin: 0 }}>
            Versions
          </span>
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', flex: 1 }} role="group" aria-label="Versions">
            {lineage.map((v) => (
              <button
                key={v.id}
                className="btn sm"
                aria-pressed={v.id === item.id}
                style={{ padding: 3, gap: 6, borderColor: v.id === item.id ? 'var(--accent)' : undefined }}
                onClick={() => go('edit', v.id)}
                title={`${v.mode} · ${v.model}`}
              >
                <img src={thumbUrl(v.id)} alt="" style={{ width: 30, height: 30, objectFit: 'cover', borderRadius: 4 }} />
                <span className="mono" style={{ paddingRight: 6 }}>
                  v{v.version}
                </span>
              </button>
            ))}
          </div>
          <button className={`btn sm ${compare ? 'on' : ''}`} disabled={!parent} onClick={() => setCompare((c) => !c)} title={parent ? 'Compare with the previous version' : 'This is the first version'}>
            <Columns2 size={15} /> Compare
          </button>
          {compare && <span className="note">Hover the picture to compare · hold Space for the original</span>}
        </div>
      </section>

      <aside className="panel right" aria-label="Edit settings">
        <div className="panel-scroll">
          <div className="readout">
            <b>v{item.version}</b>
            <span>
              {W}×{H}
            </span>
            <span title="The model that made the version you are looking at">made with {item.model}</span>
          </div>
          <div>
            <p className="section-label">Mode</p>
            <div className="pills" role="group" aria-label="Edit mode">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  className="pill accent"
                  aria-pressed={mode === m.id}
                  onClick={() => {
                    setMode(m.id);
                    if (m.id === 'outpaint') setTool('frame');
                    else if (tool === 'frame' || tool === 'crop') setTool('brush');
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {(mode === 'instruct' || mode === 'inpaint' || mode === 'outpaint' || mode === 'enhance') && boot && (
            <div>
              <p className="section-label">Model</p>
              <div className="cards" role="group" aria-label="Edit model">
                {Object.entries(boot.manifest.models).map(([key, mm]) => (
                  <button key={key} type="button" className="card" aria-pressed={editModel === key} onClick={() => setEditModel(key)} title={mm.licence}>
                    <strong>{mm.label}</strong>
                    <small>{key === 'klein' ? 'Fast · ~15 s' : 'Precise · ~25 s'}</small>
                  </button>
                ))}
              </div>
            </div>
          )}

          {(mode === 'instruct' || mode === 'inpaint' || mode === 'outpaint') && (
            <label className="field">
              <span>{mode === 'instruct' ? 'Instruction' : mode === 'inpaint' ? 'What should fill the masked area?' : 'Describe the surroundings (optional)'}</span>
              <textarea
                className="input"
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={
                  mode === 'instruct' ? 'e.g. Replace the sky with a stormy sunset. Keep everything else unchanged.' : mode === 'inpaint' ? 'e.g. a stack of old books' : 'e.g. a wide misty lake with pine trees'
                }
              />
            </label>
          )}

          {(mode === 'instruct' || mode === 'inpaint') && (
            <div>
              <p className="section-label">
                Mask <span className="mono">{maskEmpty ? 'empty' : 'painted'}</span>
              </p>
              <label className="field">
                <span>
                  Brush size <b className="mono">{brush}px</b>
                </span>
                <input type="range" min={4} max={400} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
              </label>
              <label className="field">
                <span>
                  Feather <b className="mono">{feather}px</b>
                </span>
                <input type="range" min={0} max={64} value={feather} onChange={(e) => setFeather(Number(e.target.value))} />
              </label>
              <div className="field-row" style={{ marginTop: 6 }}>
                <button className="btn sm" onClick={() => (layer.current?.invert(), setMaskEmpty(!!layer.current?.isEmpty()))}>
                  <FlipHorizontal2 size={14} /> Invert
                </button>
                <button className="btn sm" onClick={() => (layer.current?.clear(), setMaskEmpty(true))}>
                  <Trash2 size={14} /> Clear
                </button>
              </div>
              <p className="note" style={{ marginTop: 6 }}>
                B brush · E eraser · L lasso (hold Shift on release to subtract) · [ ] size · V or Alt-drag pans · wheel zooms
              </p>
              {mode === 'instruct' && (
                <label className="check">
                  <input type="checkbox" checked={onlyMasked} onChange={(e) => setOnlyMasked(e.target.checked)} disabled={maskEmpty} />
                  Only change the masked area {maskEmpty && <span className="muted">(paint a mask first)</span>}
                </label>
              )}
            </div>
          )}

          {mode === 'outpaint' && (
            <div>
              <p className="section-label">
                New size <span className="mono">{W + pad.left + pad.right} × {H + pad.top + pad.bottom}</span>
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                {(['left', 'top', 'right', 'bottom'] as const).map((side) => (
                  <label key={side} className="field">
                    <span style={{ textTransform: 'capitalize' }}>{side}</span>
                    <input
                      className="input mono"
                      type="number"
                      step={8}
                      min={0}
                      max={2048}
                      value={pad[side]}
                      onChange={(e) => setPad((p) => ({ ...p, [side]: Math.max(0, Math.min(2048, Math.round(Number(e.target.value) / 8) * 8)) }))}
                    />
                  </label>
                ))}
              </div>
              <div className="pills" style={{ marginTop: 8 }}>
                <button className="pill" onClick={() => setPad(padToAspect(W, H, 16 / 9))}>
                  To 16:9
                </button>
                <button className="pill" onClick={() => setPad(padToAspect(W, H, 1))}>
                  To 1:1
                </button>
                <button className="pill" onClick={() => setPad(zoomOut(W, H, 1.5))}>
                  Zoom out 1.5×
                </button>
                <button className="pill" onClick={() => setPad(ZERO_PAD)}>
                  Reset
                </button>
              </div>
              <p className="note" style={{ marginTop: 6 }}>
                Frame tool (O): drag any edge of the picture outwards. Press Fit to see the whole frame.
              </p>
            </div>
          )}

          {(mode === 'instruct' || mode === 'inpaint' || mode === 'outpaint') && (
            <div>
              <p className="section-label">Reference (optional)</p>
              <RefSlot name={ref?.name ?? null} onFile={(f) => addRef(f)} onItem={(itemId) => addRef(undefined, itemId)} onClear={() => setRef(null)} />
            </div>
          )}

          {mode === 'enhance' && (
            <div>
              <p className="section-label">Enhance</p>
              <div className="segmented" role="group" aria-label="Enhance strength">
                {(
                  [
                    ['subtle', 'Subtle', 'More detail and clarity, same picture'],
                    ['strong', 'Strong', 'Re-render with much more detail; small changes possible'],
                    ['upscale', 'Upscale + enhance', 'Subtle enhance, then SeedVR2 2x'],
                  ] as [EnhanceKind, string, string][]
                ).map(([k, l, t]) => (
                  <button key={k} type="button" aria-pressed={enhanceKind === k} title={t} onClick={() => { setEnhanceKind(k); setDenoise(null); }}>
                    {l}
                  </button>
                ))}
              </div>
              <p className="note" style={{ marginTop: 6 }}>
                The picture is described by the local Qwen3-VL, then re-rendered at low strength. Composition, faces and text are kept.
              </p>
              <label className="check">
                <input type="checkbox" checked={enhanceAdv} onChange={(ev) => setEnhanceAdv(ev.target.checked)} /> Advanced
              </label>
              {enhanceAdv && (
                <label className="field">
                  <span>
                    Strength (denoise) <b className="mono">{effDenoise.toFixed(2)}</b>
                  </span>
                  <input type="range" min={0.1} max={0.9} step={0.05} value={effDenoise} onChange={(ev) => setDenoise(Number(ev.target.value))} />
                </label>
              )}
            </div>
          )}
          {tool === 'smart' && (
            <div>
              <p className="section-label">
                Smart select (SAM 3.1) {samBusy && <span className="mono">working…</span>}
              </p>
              <p className="note" style={{ marginTop: 0 }}>
                Click the object (Shift-click to exclude a spot) or drag a box, then Select. One click may pick just a part (the laces of a boot), so click two or three spots across the object to get all of it. Or type what to select; typing finds every match (&ldquo;person&rdquo; selects everyone).
              </p>
              <div className="segmented" role="group" aria-label="Selection mode">
                {(['add', 'subtract', 'replace'] as const).map((o) => (
                  <button key={o} type="button" aria-pressed={samOp === o} onClick={() => setSamOp(o)} style={{ textTransform: 'capitalize' }}>
                    {o}
                  </button>
                ))}
              </div>
              <div className="field-row" style={{ marginTop: 8 }}>
                <button className="btn sm" disabled={samBusy || !online} onClick={() => void runSam(false)}>
                  Select ({samPts.length} {samPts.length === 1 ? 'point' : 'points'}
                  {samBox ? ' + box' : ''})
                </button>
                <button className="btn sm ghost" onClick={() => { setSamPts([]); setSamBox(null); }}>
                  Clear points
                </button>
              </div>
              <div className="field-row" style={{ marginTop: 8 }}>
                <input className="input" placeholder='e.g. "the red car" or "person:2"' value={samText} onChange={(ev) => setSamText(ev.target.value)} onKeyDown={(ev) => ev.key === 'Enter' && void runSam(true)} aria-label="Select by text" />
                <button className="btn sm" disabled={samBusy || !online} onClick={() => void runSam(true)}>
                  Find
                </button>
              </div>
            </div>
          )}
          {mode === 'remove_bg' && (
            <div>
              <p className="note" style={{ marginTop: 0 }}>
                Real transparency (PNG with alpha). The soft edge comes from a matting model (good on hair and fur); naming the subject lets SAM 3.1 pick which object to keep.
              </p>
              <label className="field">
                <span>Subject (optional)</span>
                <input className="input" placeholder='e.g. "the woman" or "the bottle"' value={bgSubject} onChange={(ev) => setBgSubject(ev.target.value)} />
              </label>
              <label className="field" style={{ marginTop: 8 }}>
                <span>Edge model</span>
                <select className="input" value={bgMatte} onChange={(ev) => setBgMatte(ev.target.value)}>
                  <option value="birefnet.safetensors">BiRefNet (default)</option>
                  <option value="lucida.safetensors">Lucida (alternative)</option>
                </select>
              </label>
              <label className="field" style={{ marginTop: 8 }}>
                <span>
                  Edge <b className="mono">{bgEdge > 0 ? '+' : ''}{bgEdge}px</b>
                </span>
                <input type="range" min={-8} max={8} value={bgEdge} onChange={(ev) => setBgEdge(Number(ev.target.value))} aria-label="Grow or shrink the edge" />
              </label>
              <label className="check">
                <input type="checkbox" checked={bgPlate} onChange={(ev) => setBgPlate(ev.target.checked)} />
                Also make a clean background plate (Qwen-Image 2.1)
              </label>
            </div>
          )}
          {mode === 'layers' && (
            <div>
              <p className="section-label">Decompose into layers</p>
              <div className="segmented" role="group" aria-label="Layer method">
                <button type="button" aria-pressed={layerMode === 'sam'} onClick={() => setLayerMode('sam')} title="One layer per named object, cut with SAM 3.1">
                  Objects (SAM)
                </button>
                <button type="button" aria-pressed={layerMode === 'qwen'} onClick={() => setLayerMode('qwen')} title="Native RGBA layers from Qwen-Image-Layered (slow)">
                  Automatic (Qwen-Layered)
                </button>
              </div>
              {layerMode === 'sam' ? (
                <>
                  <label className="field" style={{ marginTop: 8 }}>
                    <span>Objects</span>
                    <input className="input" placeholder='e.g. "person, dog, car:2"' value={layerText} onChange={(ev) => setLayerText(ev.target.value)} />
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={layerFill} onChange={(ev) => setLayerFill(ev.target.checked)} />
                    Fill the background behind them (Qwen-Image 2.1)
                  </label>
                </>
              ) : (
                <label className="field" style={{ marginTop: 8 }}>
                  <span>
                    Layers <b className="mono">{layerCount}</b>
                  </span>
                  <input type="range" min={2} max={8} value={layerCount} onChange={(ev) => setLayerCount(Number(ev.target.value))} />
                </label>
              )}
              <div style={{ marginTop: 10 }}>
                <LayersPanel rows={layersState.rows} setRows={layersState.setRows} />
              </div>
            </div>
          )}
          {mode === 'upscale' && <p className="note">Doubles the resolution, adding real detail (SeedVR2, a dedicated upscaler, not an image model). About 20 seconds for a 1 MP picture.</p>}
          {tool === 'crop' && <p className="note warn">Crop: drag a box on the picture. {crop ? `${Math.round(crop.w)} × ${Math.round(crop.h)} at ${Math.round(crop.x)}, ${Math.round(crop.y)}` : ''}</p>}
          <p className="note">Every apply saves a new version; nothing is overwritten.</p>
        </div>
        <div className="panel-foot">
          {running ? (
            <button className="btn big danger" onClick={() => api.cancel(job!.id)}>
              <X size={18} /> Cancel
            </button>
          ) : (
            <button className="btn big primary" disabled={!online} onClick={() => void apply()} title="Ctrl+Enter">
              <Wand2 size={18} /> {applyLabel} <span className="kbd">Ctrl+Enter</span>
            </button>
          )}
          <div className="field-row">
            <a className="btn sm" href={downloadUrl(item.id)} download style={{ flex: 1 }}>
              <Download size={14} /> Download
            </a>
            <button className="btn sm" style={{ flex: 1 }} onClick={() => go('video', undefined, { start: item.id })}>
              <Film size={14} /> Animate
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function RefSlot({ name, onFile, onItem, onClear }: { name: string | null; onFile: (f: File) => void; onItem: (id: string) => void; onClear: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`slot ${name ? 'filled' : ''} ${over ? 'drag' : ''}`}
      style={{ width: 120 }}
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData('application/x-darkroom-item');
        if (id) return onItem(id);
        const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
        if (f) onFile(f);
      }}
    >
      {name ? (
        <>
          <img src={inputUrl(name)} alt="Reference" />
          <button className="x" onClick={onClear} aria-label="Remove reference">
            <X size={14} />
          </button>
        </>
      ) : (
        <label>
          <ImagePlus size={18} />
          Drop or browse
          <input className="sr" type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </label>
      )}
    </div>
  );
}

/** No picture open: import one or pick a recent result. */
function EditEmpty() {
  const [recent, setRecent] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const online = useApp((s) => s.status?.comfy === 'online');
  const [jobId, setJobId] = useState<string | null>(null);
  const [capture, setCapture] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    api.items({ filter: 'all', limit: 24 }).then((r) => setRecent(r.items.filter((i) => i.kind === 'image').slice(0, 12)));
  }, []);
  useEffect(
    () =>
      onJob((j) => {
        if (j.id === jobId && j.status === 'done' && j.result_ids[0]) go('edit', j.result_ids[0]);
        if (j.id === jobId && (j.status === 'error' || j.status === 'lost')) {
          toast(j.error ?? 'Import failed', 'error');
          setBusy(false);
        }
      }),
    [jobId],
  );
  const importFile = async (f: File) => {
    setBusy(true);
    try {
      const up = await api.upload(f, f.name);
      const j = await api.submit({ workflow: 'import', params: { image_1: up.name }, meta: { mode: 'import', model: 'Imported', prompt: f.name } });
      setJobId(j.id);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
      if (f) void importFile(f);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });
  return (
    <div className="screen" style={{ placeItems: 'center', overflowY: 'auto' }}>
      <div className="empty" style={{ maxWidth: 760 }}>
        <h2>Open a picture to edit</h2>
        <p>Drop an image here, paste one (Ctrl+V), or pick a recent result. Edits are always saved as new versions.</p>
        <div
          className={`drop ${over ? 'drag' : ''}`}
          style={{ width: 420, height: 150 }}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const id = e.dataTransfer.getData('application/x-darkroom-item');
            if (id) return go('edit', id);
            const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
            if (f) void importFile(f);
          }}
        >
          <label style={{ cursor: 'pointer', display: 'grid', gap: 6, placeItems: 'center' }}>
            <ImagePlus size={22} />
            {busy ? 'Importing…' : online ? 'Drop, paste or browse' : 'Start ComfyUI to import pictures'}
            <input className="sr" type="file" accept="image/*" disabled={!online} onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
          </label>
        </div>
        <button
          className="btn sm"
          disabled={!online || busy}
          onClick={async () => {
            try {
              setCapture(await grabScreenFrame());
            } catch {
              toast('Screen capture was cancelled or blocked by the browser.', 'info');
            }
          }}
        >
          <Monitor size={14} /> Capture part of the screen
        </button>
        {capture && (
          <CropDialog
            source={capture}
            onCancel={() => setCapture(null)}
            onDone={(b) => {
              setCapture(null);
              void importFile(new File([b], 'screen.png', { type: 'image/png' }));
            }}
          />
        )}
        {recent.length > 0 && (
          <>
            <p className="section-label" style={{ marginTop: 16 }}>
              Recent
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 96px)', gap: 8 }}>
              {recent.map((i) => (
                <button key={i.id} className="btn" style={{ padding: 0, width: 96, height: 96, overflow: 'hidden' }} onClick={() => go('edit', i.id)} aria-label={`Edit ${i.prompt || 'picture'}`}>
                  <img src={thumbUrl(i.id)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
