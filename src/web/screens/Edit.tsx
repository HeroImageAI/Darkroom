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
  Loader2,
  Redo2,
  Sparkles,
  ScanSearch,
  Trash2,
  Undo2,
  Wand2,
  X,
} from 'lucide-react';
import { api, downloadUrl, fileUrl, inputUrl, thumbUrl, type Item, type Job } from '../api';
import { ProgressBar, randomSeed, useHotkey } from '../components/common';
import { useItemLoad, usePersistent } from '../lib/hooks';
import { CompareView } from '../components/Compare';
import { LayerStack, LayersPanel, useLayerGroup } from '../components/LayersPanel';
import { CropDialog, grabScreenFrame } from '../lib/capture';
import { MaskLayer, padToAspect, zoomOut } from '../lib/mask';
import { go } from '../router';
import { captionFromLineage, composeImagePrompt, type CaptionSource, type ImageModelKey } from '../../shared/prompts';
import { planEnhance } from '../../shared/enhance';
import { doubledTarget, isBig, planLargeRestore, sharpenPlan } from '../../shared/fullsize';
import { maskBBox, planCrop } from '../../shared/cropstitch';
import { snapPad } from '../../shared/outpaint';
import { detectPixelBlock } from '../../shared/pixelblock';
import { CIRCLE_COLOUR, circleFor } from '../../shared/annotate';
import { PresetPicker } from '../components/PresetPicker';
import { importFailedMessage, importPictures } from '../lib/importer';
import { LoraPicker } from '../components/LoraPicker';
import { KleinWeights, kleinLabel, useFinetunes } from '../components/KleinWeights';
import type { LoraUse } from '../../shared/loras';

/** Edits that run Klein / Qwen on the picture, so your LoRAs apply (not crop, upscale, background removal…). */
const LORA_MODES = new Set(['edit:instruct', 'edit:inpaint', 'edit:outpaint']);
import { MASK_OUTLINE_FILTER, MaskOutlineDefs } from '../components/MaskOutline';
import { onJob, toast, useApp } from '../store';

type Tool = 'move' | 'brush' | 'eraser' | 'lasso' | 'smart' | 'frame' | 'crop';
type Mode = 'instruct' | 'inpaint' | 'outpaint' | 'enhance' | 'remove_bg' | 'layers' | 'upscale';
/** restore = edit-style (default; fixes blur and low resolution), restore_upscale = restore then SeedVR2 2x,
 *  subtle = low-denoise img2img touch-up for pictures that are already clean (Addenda Phase 2, DECISIONS 66). */
type EnhanceKind = 'restore' | 'restore_upscale' | 'subtle';
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
  const { item, missing } = useItemLoad(id);
  if (!id) return <EditEmpty />;
  if (missing)
    return (
      <div className="empty" style={{ margin: 'auto' }}>
        <h2>Picture not found</h2>
        <p>It was deleted from the Library. Pick another picture to edit.</p>
        <button className="btn primary" onClick={() => go('library')}>
          Open the Library
        </button>
      </div>
    );
  if (!item) return <div className="empty" style={{ margin: 'auto' }}>Opening…</div>;
  return <Editor key={item.id} item={item} />;
}

/** Bring your own pictures in and open the first in Edit (the rest wait in the Library). */
async function openOwnPictures(files: File[], online: boolean, setBusy: (b: boolean) => void) {
  const pics = files.filter((f) => f.type.startsWith('image/'));
  if (!pics.length) return;
  if (!online) return toast('Start ComfyUI first (top right): it saves the pictures into your library.', 'info');
  setBusy(true);
  const { ids, failed } = await importPictures(pics);
  setBusy(false);
  if (failed.length) toast(importFailedMessage(failed), 'error', 12000);
  if (ids.length > 1) toast(`${ids.length} pictures added to your Library. Opening the first one.`, 'ok', 6000);
  if (ids[0]) go('edit', ids[0]);
}

function Editor({ item }: { item: Item }) {
  const jobs = useApp((s) => s.jobs);
  const comfyOnline = useApp((s) => s.status?.comfy === 'online');
  const uploadRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [fileOver, setFileOver] = useState(false);
  const online = useApp((s) => s.status?.comfy === 'online');
  const rev = useApp((s) => s.libraryRev);
  const [lineage, setLineage] = useState<Item[]>([]);
  const [tool, setTool] = useState<Tool>('brush');
  const [mode, setMode] = useState<Mode>(() => (sessionStorage.getItem('dr.edit.mode') as Mode) || 'instruct');
  const boot = useApp((s) => s.boot);
  const [editModel, setEditModel] = useState<string>(() => localStorage.getItem('dr.edit.model') || 'qwen');
  // your own LoRAs per model (DECISIONS 86), used by Instruct, Inpaint, Outpaint and Enhance
  const [editLoras, setEditLoras] = usePersistent<Record<string, LoraUse[]>>('edit.loras', {});
  const lorasNow = (): LoraUse[] => (editModel === 'klein' || editModel === 'qwen' ? (editLoras[editModel] ?? []) : []);
  // your Klein 9B fine-tune (DECISIONS 91), a preference like the LoRAs
  const [kleinWeights, setKleinWeights] = usePersistent<string>('edit.kleinWeights', '');
  const finetunes = useFinetunes();
  const weightsNow = (): Record<string, string> => (editModel === 'klein' && kleinWeights ? { klein_weights: kleinWeights } : {});
  const [enhanceKind, setEnhanceKind] = useState<EnhanceKind>('restore');
  const [enhanceAdv, setEnhanceAdv] = useState(false);
  const [denoise, setDenoise] = useState<number | null>(null); // null = model default for the chosen strength
  useEffect(() => {
    try {
      localStorage.setItem('dr.edit.model', editModel);
    } catch {
      /* storage blocked */
    }
  }, [editModel]);
  const modelLabel = editModel === 'klein' ? kleinLabel(kleinWeights, finetunes) : (boot?.manifest.models[editModel]?.label ?? editModel);
  const wfFor = (m: 'instruct' | 'inpaint' | 'outpaint' | 'enhance' | 'enhance_subtle') =>
    boot?.manifest.edit?.[m]?.[editModel] ??
    { instruct: 'qwen_edit', inpaint: 'inpaint', outpaint: 'outpaint', enhance: 'qwen_enhance_edit', enhance_subtle: 'qwen_enhance' }[m];
  const enhanceDefaults = (boot?.manifest as any)?.enhance?.[editModel] as { subtle: number; strong: number } | undefined;
  const effDenoise = denoise ?? enhanceDefaults?.subtle ?? 0.3;
  const [brush, setBrush] = useState(64);
  const [feather, setFeather] = useState(8);
  const [strength, setStrength] = useState(1); // inpaint "Change strength" (denoise)
  const [seam, setSeam] = useState(0); // inpaint "Seam feather": 0 = Auto (the A/B-tested grow 8 / blur 6)
  const [opFeather, setOpFeather] = useState(0); // outpaint "Seam feather" into the original: 0 = Auto
  const [upScale, setUpScale] = useState(2);
  const [upShrink, setUpShrink] = useState(0); // "Scale by longer side" first: 0 = off, else the target long side
  const [upTile, setUpTile] = useState(512);
  const [upBlock, setUpBlock] = useState(1); // detected pixel-block size of the current picture
  const promptBox = useRef<HTMLTextAreaElement>(null);
  const [instrBusy, setInstrBusy] = useState(false);
  const [instrUndo, setInstrUndo] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(() => sessionStorage.getItem('dr.edit.prompt') ?? '');
  const [onlyMasked, setOnlyMasked] = useState(true);
  /** Circle quick edit (Qwen): send the picture with a red circle round the masked object instead of a mask. */
  const [circled, setCircled] = useState(false);
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
  const [bgMethod, setBgMethod] = useState<'matte' | 'qwen'>('matte'); // Fast (BiRefNet/SAM) or Best quality (Qwen 2.1)
  // Layers
  const [layerMode, setLayerMode] = useState<'sam' | 'qwen21' | 'qwen'>('sam');
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
  /** A whole-picture result on a large photo (drawn at ~1 MP, enlarged back) that has not been sharpened yet. */
  const softWhole =
    isBig(W, H) &&
    ((item.mode === 'edit:instruct' && !(item.params as Record<string, unknown>)?.mask) || item.workflow === 'qwen_remove_bg') &&
    !lineage.some((v) => v.parent_id === item.id && v.mode === 'upscale');

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
          setLayerGroup(((j.meta as any).groupId as string | undefined) ?? j.id);
          toast('Layers ready. Toggle, reorder, rename and export them on the right.', 'ok');
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

  /** Mask PNG; `blur` defaults to the Feather slider (crop-and-stitch passes 0 and feathers in the graph). */
  const uploadMask = async (blur = feather) => {
    const blob = await layer.current!.exportPng(blur);
    return (await api.upload(blob, 'mask.png')).name;
  };

  /** The picture with a red circle round the painted mask (circle quick edit, DECISIONS 73); null when nothing is painted. */
  const uploadCircled = async () => {
    const mc = layer.current!.mask;
    const bb = maskBBox(mc.getContext('2d')!.getImageData(0, 0, mc.width, mc.height).data, mc.width, mc.height);
    if (!bb) return null;
    const img = new Image();
    img.src = fileUrl(item.id);
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const sx = c.width / mc.width;
    const sy = c.height / mc.height;
    const e = circleFor({ x: bb.x * sx, y: bb.y * sy, w: bb.w * sx, h: bb.h * sy }, c.width, c.height);
    g.strokeStyle = CIRCLE_COLOUR;
    g.lineWidth = e.stroke;
    g.beginPath();
    g.ellipse(e.cx, e.cy, e.rx, e.ry, 0, 0, Math.PI * 2);
    g.stroke();
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the circle'))), 'image/png'));
    return (await api.upload(blob, 'circled.png')).name;
  };

  const submit = async (workflow: string, params: Record<string, string | number>, modeKey: string, model: string, promptText = '') => {
    try {
      const inp = await api.asInput(item.id);
      const j = await api.submit({
        workflow,
        params: { image_1: inp.name, seed: randomSeed(), ...params, ...(LORA_MODES.has(modeKey) && lorasNow().length ? { loras: JSON.stringify(lorasNow()) } : {}), ...(LORA_MODES.has(modeKey) ? weightsNow() : {}) },
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
      const circle = circled && em === 'qwen' && !maskEmpty;
      const masked = onlyMasked && !maskEmpty && !circle;
      const params: Record<string, string | number> = { prompt: composeImagePrompt(T, { model: em, mode: 'instruct', text: prompt, masked, circled: circle }) };
      if (ref) params.image_2 = ref.name;
      if (masked) params.mask = await uploadMask();
      if (circle) {
        const name = await uploadCircled();
        if (!name) return toast('Paint over the object to circle first (B for brush).', 'info');
        params.image_1 = name;
      }
      return submit(wfFor('instruct'), params, 'edit:instruct', `${modelLabel} edit`, prompt.trim());
    }
    if (mode === 'inpaint') {
      if (maskEmpty) return toast('Paint over the area to replace first (B for brush).', 'info');
      if (!prompt.trim()) return toast('Describe what should appear in the masked area.', 'info');
      // Crop and stitch (Addenda Phase 3): sample only the mask's surroundings at a higher resolution, then composite
      // back. The plan comes from the painted mask (src/shared/cropstitch.ts).
      const mc = layer.current!.mask;
      const bb = maskBBox(mc.getContext('2d')!.getImageData(0, 0, mc.width, mc.height).data, mc.width, mc.height);
      if (!bb) return toast('Paint over the area to replace first (B for brush).', 'info');
      const plan = planCrop(bb, mc.width, mc.height);
      // seam 0 = Auto: the A/B defaults (grow 8, blur 6); otherwise split between grow and blur (ImageBlur caps at 31)
      const params: Record<string, string | number> = {
        prompt: composeImagePrompt(T, { model: em, mode: 'inpaint', text: prompt, caption, maskShown: em === 'qwen' }),
        mask: await uploadMask(0),
        denoise: strength,
        grow: seam ? Math.round(seam / 4) : 8,
        feather: seam ? Math.min(31, Math.max(1, Math.round(seam / 2))) : 6,
        crop_x: plan.crop.x,
        crop_y: plan.crop.y,
        crop_w: plan.crop.w,
        crop_h: plan.crop.h,
        target_w: plan.target.w,
        target_h: plan.target.h,
      };
      if (ref) params.image_2 = ref.name;
      return submit(wfFor('inpaint'), params, 'edit:inpaint', `${modelLabel} fill`, prompt.trim());
    }
    if (mode === 'outpaint') {
      if (!pad.left && !pad.right && !pad.top && !pad.bottom) return toast('Choose how far to extend: drag an edge with the frame tool (O) or use a preset.', 'info');
      const text = prompt.trim();
      if (em === 'qwen') {
        // Qwen keeps its v2 route (it sees the original and samples the padded canvas): in the Phase 4 A/B the shared
        // black-canvas prep made Qwen paint the "marked" area white or leave the black bars (DECISIONS 68).
        const p = snapPad(W, H, pad, 32);
        const params: Record<string, string | number> = {
          prompt: composeImagePrompt(T, { model: em, mode: 'outpaint', text, caption }),
          pad_left: p.left,
          pad_top: p.top,
          pad_right: p.right,
          pad_bottom: p.bottom,
        };
        if (ref) params.image_2 = ref.name;
        return submit(wfFor('outpaint'), params, 'edit:outpaint', `${modelLabel} outpaint`, text || 'Outpaint');
      }
      // Klein (Addenda Phase 4): the server pads the picture on black and builds the mask (gradient into the original,
      // leftover black at the extended edges); the whole canvas is sampled through crop-and-stitch at full strength.
      let prep;
      try {
        prep = await api.outpaintPrepare({ itemId: item.id, pad, feather: opFeather, step: 8 });
      } catch (e) {
        return toast((e as Error).message, 'error');
      }
      const plan = planCrop({ x: 0, y: 0, w: prep.width, h: prep.height }, prep.width, prep.height);
      const params: Record<string, string | number> = {
        prompt: composeImagePrompt(T, { model: em, mode: 'outpaint', text, caption, canvas: true }),
        image_1: prep.image,
        mask: prep.mask,
        denoise: 1, // never less: the new area starts as black padding
        grow: 0, // the prepared mask already reaches into the original
        feather: 6,
        crop_x: 0,
        crop_y: 0,
        crop_w: prep.width,
        crop_h: prep.height,
        target_w: plan.target.w,
        target_h: plan.target.h,
        output: 'darkroom/outpaint',
      };
      if (ref) params.image_2 = ref.name;
      return submit(wfFor('outpaint'), params, 'edit:outpaint', `${modelLabel} outpaint`, text || 'Outpaint');
    }
    if (mode === 'enhance') {
      const restore = enhanceKind !== 'subtle';
      // Qwen's Restore prompt ignores the caption (no measurable effect in the A/B), so skip the VLM call for it
      const cap = restore && em === 'qwen' ? null : await ensureCaption(em === 'klein' ? 'klein' : 'short');
      const plan = planEnhance(W, H);
      const params: Record<string, string | number> = {
        prompt: composeImagePrompt(T, { model: em, mode: 'enhance', text: '', caption: cap, strength: restore ? 'restore' : 'subtle' }),
        megapixels: plan.megapixels,
      };
      if (lorasNow().length) params.loras = JSON.stringify(lorasNow());
      Object.assign(params, weightsNow());
      if (!restore) {
        params.denoise = effDenoise;
        if (em === 'klein') params.schedule_steps = Math.max(4, Math.round(4 / effDenoise));
      }
      // Klein Restore of a large photo: Klein + the restore LoRA at up to 4 MP (DECISIONS 83). Small pictures,
      // Subtle and Qwen keep their own path.
      const large = restore && em === 'klein' ? planLargeRestore(W, H, enhanceKind === 'restore_upscale') : null;
      if (large) {
        params.megapixels = large.megapixels;
        if (large.exact) {
          params.target_w = large.exact.w;
          params.target_h = large.exact.h;
        }
      }
      const workflow = large ? 'klein_enhance_large' : wfFor(restore ? 'enhance' : 'enhance_subtle');
      // Restore rebuilds detail itself; only the img2img touch-up needs a SeedVR2 pre-upscale for small sources
      const preScale = restore ? null : plan.preScale;
      const label = `${modelLabel} ${{ restore: 'restore', restore_upscale: 'restore + upscale', subtle: 'subtle enhance' }[enhanceKind]}`;
      const ui = { ...item.ui, caption: cap ?? (item.ui as any)?.caption };
      // large photo: Enhance draws at ~1-2 MP, so SeedVR2 brings the result back to the photo's own size (or double
      // it for Restore + upscale) instead of handing back a smaller picture (DECISIONS 79)
      const big = isBig(W, H);
      const chain = large
        ? large.chainTo
          ? { kind: 'upscale', to: large.chainTo }
          : undefined
        : big
          ? { kind: 'upscale', to: enhanceKind === 'restore_upscale' ? doubledTarget(W, H) : { w: W, h: H } }
          : enhanceKind === 'restore_upscale'
            ? { kind: 'upscale' }
            : undefined;
      const enhanceMeta = { mode: 'edit:enhance', model: label, prompt: item.prompt, ui, chain };
      try {
        const inp = await api.asInput(item.id);
        const j = preScale
          ? // small source: SeedVR2 first, then the touch-up runs on its result (server chain)
            await api.submit({
              workflow: 'upscale',
              params: { image_1: inp.name, scale: preScale, seed: randomSeed() },
              meta: { mode: 'upscale', model: 'SeedVR2 7B', prompt: item.prompt, parentId: item.id, ui, chain: { kind: 'enhance', workflow, params, meta: enhanceMeta } },
            })
          : await api.submit({ workflow, params: { image_1: inp.name, seed: randomSeed(), ...params }, meta: { ...enhanceMeta, parentId: item.id } });
        setJobId(j.id);
        if (preScale) toast(`Small picture: upscaling ${preScale}× with SeedVR2 first, then enhancing — the enhanced version opens when it is ready.`, 'info', 7000);
        else if (large?.exact) toast(`Large picture: restoring at full size (${W}×${H}) with the restore LoRA, about a minute.`, 'info', 8000);
        else if (large?.chainTo)
          toast(`Large picture: restoring at 4 MP with the restore LoRA, then SeedVR2 takes it to ${large.chainTo.w}×${large.chainTo.h}. The full-size version opens when it is ready.`, 'info', 8000);
        else if (big) {
          const t = enhanceKind === 'restore_upscale' ? doubledTarget(W, H) : { w: W, h: H };
          toast(`Large picture: enhancing at about 2 MP, then SeedVR2 rebuilds it at ${t.w}×${t.h}. The full-size version opens when it is ready.`, 'info', 8000);
        }
        else if (enhanceKind === 'restore_upscale') toast('Restoring, then upscaling 2× with SeedVR2 — the upscaled version opens when it is ready.', 'info', 7000);
      } catch (err) {
        toast((err as Error).message, 'error');
      }
      return;
    }
    if (mode === 'remove_bg' && bgMethod === 'qwen') {
      // Addenda Phase 5: Qwen-Image 2.1 native extraction (official template wording), scaled back to the source size
      return submit('qwen_remove_bg', {}, 'edit:remove_bg', 'Qwen-Image 2.1 extraction');
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
        if (layerMode === 'qwen21') {
          // Addenda Phase 5: Qwen-Image 2.1 extracts each object as a transparent layer (full resolution) and paints the
          // background without them; beat Qwen-Image-Layered (640 px) in the A/B. Jobs share a group; ComfyUI runs them in
          // order, so the last one finishing means the whole group is ready.
          const objects = layerText.split(',').map((s) => s.replace(/:\s*\d+\s*$/, '').trim()).filter(Boolean);
          if (!objects.length) return toast('List the objects to separate, e.g. "the red car, the potted palm".', 'info');
          const groupId = `qwen21-${Date.now().toString(36)}`;
          const list = objects.length === 1 ? objects[0] : `${objects.slice(0, -1).join(', ')} and ${objects[objects.length - 1]}`;
          const layers = [
            { name: 'Background', prompt: `Remove ${list} from <image1> and fill in what is behind them naturally. Keep everything else exactly as it is.` },
            ...objects.map((o) => ({ name: o, prompt: `Extract ${o} from <image1> onto a transparent background, and output a PNG image` })),
          ];
          let last = '';
          for (const l of layers) {
            const j = await api.submit({
              workflow: 'qwen_remove_bg',
              params: { image_1: inp.name, prompt: l.prompt, seed: randomSeed(), output: 'darkroom/layers/qwen21' },
              // the background is tagged as a plate so the Layers panel keeps it at the bottom of the stack
              meta: { mode: l.name === 'Background' ? 'edit:plate' : 'edit:layers', model: 'Qwen-Image 2.1 layer', prompt: l.name, parentId: item.id, ui: item.ui, groupId, layers: true },
            });
            last = j.id;
          }
          setJobId(last);
          toast(`Making ${layers.length} layers with Qwen-Image 2.1 (about ${layers.length * 25} s). You can keep working.`, 'info', 8000);
          return;
        }
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
    // Addenda Phase 5: 2-8x, optional "scale by longer side" pre-shrink, tile size as the VRAM setting (overlap = tile/4)
    const up: Record<string, string | number> = { scale: upScale, tile: upTile, tile_overlap: upTile / 4 };
    if (upShrink) up.preshrink = upShrink;
    return submit('upscale', up, 'upscale', `SeedVR2 7B ${upScale}×`);
  };

  useHotkey((e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter', () => void apply(), [mode, prompt, pad, onlyMasked, circled, editModel, ref, maskEmpty, crop, tool, running, feather], true);

  const addRef = async (file?: File, itemId?: string) => {
    try {
      if (itemId) setRef({ name: (await api.asInput(itemId)).name });
      else if (file) setRef({ name: (await api.upload(file, file.name)).name });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  // Ctrl+V with a picture open: the first empty slot is the Reference slot (Addendum 1 H)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return;
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
      if (!f) return;
      if (ref) return toast('The Reference slot is already filled. Clear it first to paste a new one.', 'info');
      void addRef(f).then(() => toast('Pasted into the Reference slot.', 'ok'));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  // Library "Use as… > Edit reference": remember which picture is open, and pick up a reference sent over from there
  useEffect(() => {
    try {
      sessionStorage.setItem('dr.edit.last', item.id);
      const pending = sessionStorage.getItem('dr.edit.ref');
      if (pending) {
        sessionStorage.removeItem('dr.edit.ref');
        void addRef(undefined, pending).then(() => toast('Added as the reference picture.', 'ok'));
      }
    } catch {
      /* storage blocked */
    }
  }, [item.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const parent = lineage.find((x) => x.id === item.parent_id) ?? null;
  const hasPad = pad.left + pad.right + pad.top + pad.bottom > 0;
  const applyLabel =
    tool === 'crop'
      ? 'Apply crop'
      : { instruct: 'Apply instruction', inpaint: 'Fill masked area', outpaint: 'Extend canvas', enhance: 'Enhance', remove_bg: 'Remove background', layers: 'Make layers', upscale: `Upscale ${upScale}×` }[mode];

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

      <section
        className={`stage ${fileOver ? 'file-over' : ''}`}
        aria-label="Canvas"
        // dropping a picture file from your computer opens it (library drags keep their own targets)
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes('Files')) return;
          e.preventDefault();
          setFileOver(true);
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setFileOver(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setFileOver(false);
          void openOwnPictures([...e.dataTransfer.files], comfyOnline, setImporting);
        }}
      >
        {softWhole && !running ? (
          <div className="banner" role="status">
            <span>
              This edit was drawn at about 1 MP and enlarged to {W}×{H}, so fine detail is soft. SeedVR2 can rebuild it at full resolution.
            </span>
            <button
              className="btn sm primary"
              onClick={() => {
                const plan = sharpenPlan(W, H);
                void submit('upscale', { scale: plan.scale, preshrink: plan.preshrink!, target_w: plan.target_w, target_h: plan.target_h }, 'upscale', 'SeedVR2 7B → full resolution');
              }}
            >
              Sharpen to full resolution
            </button>
          </div>
        ) : null}
        {item.deleted_at ? (
          <div className="banner" role="status">
            <span>This picture is in Recently deleted.</span>
            <button className="btn sm" onClick={() => void api.restoreItems([item.id]).then(() => toast('Restored to the Library.', 'ok'))}>
              Restore
            </button>
          </div>
        ) : null}
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
            <MaskOutlineDefs />
            <canvas
              ref={viewCanvas}
              data-testid="mask-overlay"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', display: compare ? 'none' : 'block', filter: MASK_OUTLINE_FILTER }}
            />
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
          <div style={{ position: 'absolute', left: 12, top: 12, display: 'flex', gap: 6, zIndex: 3 }} onPointerDown={(e) => e.stopPropagation()}>
            <button className="btn sm" disabled={importing} onClick={() => uploadRef.current?.click()} title="Open one of your own pictures (or drop it on the canvas). Several at once go to the Library.">
              {importing ? <Loader2 size={14} className="spin" /> : <ImagePlus size={14} />} {importing ? 'Bringing in…' : 'Upload'}
            </button>
            <input
              ref={uploadRef}
              className="sr"
              type="file"
              accept="image/*"
              multiple
              aria-label="Upload your own picture"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                void openOwnPictures(files, comfyOnline, setImporting);
              }}
            />
          </div>
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
              {editModel === 'klein' && <KleinWeights value={kleinWeights} onChange={setKleinWeights} />}
              {(editModel === 'klein' || editModel === 'qwen') && (
                <div style={{ marginTop: 12 }}>
                  <LoraPicker family={editModel} value={editLoras[editModel] ?? []} onChange={(v) => setEditLoras((prev) => ({ ...prev, [editModel]: v }))} />
                </div>
              )}
            </div>
          )}

          {(mode === 'instruct' || mode === 'inpaint' || mode === 'outpaint') && (
            <label className="field">
              <span>{mode === 'instruct' ? 'Instruction' : mode === 'inpaint' ? 'What should fill the masked area?' : 'Describe the surroundings (optional)'}</span>
              <textarea
                ref={promptBox}
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
          {mode === 'instruct' && (
            <>
              <PresetPicker model={editModel as 'klein' | 'qwen'} textarea={promptBox} value={prompt} onApply={setPrompt} hasReference={!!ref} />
              <div className="field-row" style={{ marginTop: 6, gap: 6 }}>
                <button
                  className="btn sm ghost"
                  disabled={!prompt.trim() || !!instrBusy || !online}
                  title={editModel === 'qwen' ? 'Rewrite the instruction with the official Qwen-Image 2.1 edit prompt enhancer (looks at the picture)' : 'Rewrite the instruction for Klein: exact change + what stays identical (looks at the picture)'}
                  onClick={async () => {
                    setInstrBusy(true);
                    try {
                      const r = await api.vlm({ task: 'edit_enhance', variant: editModel, text: prompt, itemId: item.id });
                      setInstrUndo(prompt);
                      setPrompt(r.text);
                      toast(`Instruction rewritten by ${r.model ?? 'the local model'} in ${r.seconds}s. Edit it freely; Undo brings yours back.`, 'ok', 7000);
                    } catch (e) {
                      toast((e as Error).message, 'error');
                    } finally {
                      setInstrBusy(false);
                    }
                  }}
                >
                  {instrBusy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Enhance instruction
                </button>
                {instrUndo !== null && (
                  <button className="btn sm ghost" onClick={() => (setPrompt(instrUndo), setInstrUndo(null))}>
                    Undo
                  </button>
                )}
              </div>
            </>
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
              {mode === 'inpaint' ? (
                <label className="field" title="How far the new content blends into the original around the mask. Auto suits most edits.">
                  <span>
                    Seam feather <b className="mono">{seam === 0 ? 'Auto' : `${seam}px`}</b>
                  </span>
                  <input type="range" min={0} max={64} step={4} value={seam} onChange={(e) => setSeam(Number(e.target.value))} />
                </label>
              ) : (
                <label className="field">
                  <span>
                    Feather <b className="mono">{feather}px</b>
                  </span>
                  <input type="range" min={0} max={64} value={feather} onChange={(e) => setFeather(Number(e.target.value))} />
                </label>
              )}
              {mode === 'inpaint' && (
                <label className="field" title="100% repaints the masked area completely. Lower keeps more of what is there; below about 80% colour and shape changes may not take.">
                  <span>
                    Change strength <b className="mono">{Math.round(strength * 100)}%</b>
                  </span>
                  <input type="range" min={50} max={100} step={5} value={Math.round(strength * 100)} onChange={(e) => setStrength(Number(e.target.value) / 100)} />
                </label>
              )}
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
                <>
                  <label className="check">
                    <input type="checkbox" checked={onlyMasked && !(circled && editModel === 'qwen')} onChange={(e) => setOnlyMasked(e.target.checked)} disabled={maskEmpty || (circled && editModel === 'qwen')} />
                    Only change the masked area {maskEmpty && <span className="muted">(paint a mask first)</span>}
                  </label>
                  <label
                    className="check"
                    title="Qwen sees the picture with a red circle round what you painted, edits that object and removes the circle. Won 5 of 5 in the A/B; Klein is not reliable with circles."
                  >
                    <input type="checkbox" checked={circled && editModel === 'qwen'} onChange={(e) => setCircled(e.target.checked)} disabled={maskEmpty || editModel !== 'qwen'} />
                    Point at it with a red circle {editModel !== 'qwen' ? <span className="muted">(Qwen only)</span> : maskEmpty && <span className="muted">(paint over the object first)</span>}
                  </label>
                </>
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
              {editModel === 'klein' && (
                <label className="field" style={{ marginTop: 8 }} title="How far the new area blends back into the original picture. Auto = the smaller of 48 px and a sixth of the short side.">
                  <span>
                    Seam feather <b className="mono">{opFeather === 0 ? 'Auto' : `${opFeather}px`}</b>
                  </span>
                  <input type="range" min={0} max={256} step={8} value={opFeather} onChange={(e) => setOpFeather(Number(e.target.value))} />
                </label>
              )}
              <p className="note" style={{ marginTop: 6 }}>
                Frame tool (O): drag any edge of the picture outwards. Press Fit to see the whole frame. Extending again later works: any black left at the edges is filled too.
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
                    ['restore', 'Restore', 'Removes blur, noise and compression, rebuilds fine detail; keeps the picture as it is'],
                    ['restore_upscale', 'Restore + upscale', 'Restore, then SeedVR2 2x'],
                    ['subtle', 'Subtle', 'Light touch-up for pictures that are already sharp'],
                  ] as [EnhanceKind, string, string][]
                ).map(([k, l, t]) => (
                  <button key={k} type="button" aria-pressed={enhanceKind === k} title={t} onClick={() => { setEnhanceKind(k); setDenoise(null); }}>
                    {l}
                  </button>
                ))}
              </div>
              <p className="note" style={{ marginTop: 6 }}>
                {enhanceKind === 'subtle'
                  ? 'Re-renders the picture at low strength. Best on pictures that are already sharp; it does not fix blur.'
                  : 'Redraws the picture from itself as an edit: fixes motion blur, lens blur, noise and low resolution while keeping the composition, faces and colours.'}
              </p>
              {isBig(W, H) && (
                <p className="note" style={{ marginTop: 6 }}>
                  {(() => {
                    const mp = ((W * H) / 1e6).toFixed(0);
                    const lp = enhanceKind !== 'subtle' && editModel === 'klein' ? planLargeRestore(W, H, enhanceKind === 'restore_upscale') : null;
                    if (lp?.exact) return `Large picture (${mp} MP): Klein restores it at its full ${W}×${H} with the restore LoRA (about a minute).`;
                    if (lp?.chainTo)
                      return `Large picture (${mp} MP): Klein restores it at 4 MP with the restore LoRA, then SeedVR2 takes it to ${lp.chainTo.w}×${lp.chainTo.h}. Fine detail beyond 4 MP is re-created, not copied from the original.`;
                    return `Large picture (${mp} MP): the models work at about 2 MP, so SeedVR2 then rebuilds the result at ${enhanceKind === 'restore_upscale' ? `${doubledTarget(W, H).w}×${doubledTarget(W, H).h}` : `the full ${W}×${H}`}. Fine detail is re-created, not copied from the original.`;
                  })()}
                </p>
              )}
              {enhanceKind === 'subtle' && (
                <label className="check">
                  <input type="checkbox" checked={enhanceAdv} onChange={(ev) => setEnhanceAdv(ev.target.checked)} /> Advanced
                </label>
              )}
              {enhanceKind === 'subtle' && enhanceAdv && (
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
              <div className="segmented" role="group" aria-label="Background removal method">
                <button type="button" aria-pressed={bgMethod === 'matte'} onClick={() => setBgMethod('matte')} title="BiRefNet or Lucida matting, optionally SAM 3.1 to pick the subject. About 1-5 s.">
                  Fast
                </button>
                <button type="button" aria-pressed={bgMethod === 'qwen'} onClick={() => setBgMethod('qwen')} title="Qwen-Image 2.1 extracts the subject itself. About 25 s. Best on glass, smoke and fine hair.">
                  Best quality (Qwen)
                </button>
              </div>
              {bgMethod === 'qwen' ? (
                <p className="note">
                  Qwen-Image 2.1 draws the subject again with real transparency: see-through glass stays see-through and stray hairs keep their soft edges. About 25 seconds.
                </p>
              ) : (
                <>
              <p className="note" style={{ marginTop: 6 }}>
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
                </>
              )}
            </div>
          )}
          {mode === 'layers' && (
            <div>
              <p className="section-label">Decompose into layers</p>
              <div className="segmented" role="group" aria-label="Layer method">
                <button type="button" aria-pressed={layerMode === 'sam'} onClick={() => setLayerMode('sam')} title="One layer per named object, cut with SAM 3.1">
                  Objects (SAM)
                </button>
                <button type="button" aria-pressed={layerMode === 'qwen21'} onClick={() => setLayerMode('qwen21')} title="Qwen-Image 2.1 extracts each named object as a transparent layer at full resolution, plus a clean background. About 25 s per layer.">
                  Objects (Qwen 2.1)
                </button>
                <button type="button" aria-pressed={layerMode === 'qwen'} onClick={() => setLayerMode('qwen')} title="Native RGBA layers from Qwen-Image-Layered: no names needed, but 640 px and slow">
                  Automatic (Qwen-Layered)
                </button>
              </div>
              {layerMode === 'qwen21' && (
                <>
                  <label className="field" style={{ marginTop: 8 }}>
                    <span>Objects</span>
                    <input className="input" placeholder='e.g. "the red car, the potted palm"' value={layerText} onChange={(ev) => setLayerText(ev.target.value)} />
                  </label>
                  <p className="note">One transparent layer per object at full resolution, plus the background with them removed. Best quality; about 25 seconds per layer.</p>
                </>
              )}
              {layerMode === 'qwen21' ? null : layerMode === 'sam' ? (
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
          {mode === 'upscale' && (
            <div>
              <p className="section-label">
                Upscale <span className="mono">{Math.round((upShrink ? Math.min(1, upShrink / Math.max(W, H)) : 1) * W * upScale)} × {Math.round((upShrink ? Math.min(1, upShrink / Math.max(W, H)) : 1) * H * upScale)}</span>
              </p>
              <div className="segmented" role="group" aria-label="Upscale factor">
                {[2, 4, 6, 8].map((f) => (
                  <button key={f} type="button" aria-pressed={upScale === f} onClick={() => setUpScale(f)}>
                    {f}×
                  </button>
                ))}
              </div>
              <label className="check" title="Shrinks the picture before upscaling. Sounds backwards, but SeedVR2 restores small and pixelated pictures best, so this often gives cleaner results on them.">
                <input
                  type="checkbox"
                  checked={upShrink > 0}
                  onChange={(e) => {
                    if (!e.target.checked) return (setUpShrink(0), setUpBlock(1));
                    // a blown-up pixelated picture only de-pixelates when shrunk back to its real size (Phase 5 A/B)
                    let block = 1;
                    try {
                      const im = imgRef.current;
                      if (im && im.naturalWidth) {
                        const cv = document.createElement('canvas');
                        cv.width = im.naturalWidth;
                        cv.height = im.naturalHeight;
                        const cx = cv.getContext('2d', { willReadFrequently: true })!;
                        cx.drawImage(im, 0, 0);
                        block = detectPixelBlock(cx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height);
                      }
                    } catch {
                      /* keep the default */
                    }
                    setUpBlock(block);
                    setUpShrink(block > 1 ? Math.max(64, Math.round(Math.max(W, H) / block)) : 512);
                  }}
                />{' '}
                Scale by longer side first
              </label>
              {upShrink > 0 && upBlock > 1 && <p className="note">Pixelated picture: blocks of {upBlock} px, so its real size is about {Math.round(Math.max(W, H) / upBlock)} px. Shrinking to that lets SeedVR2 rebuild real detail.</p>}
              {upShrink > 0 && (
                <label className="field">
                  <span>
                    Longer side <b className="mono">{upShrink}px</b>
                  </span>
                  <input type="range" min={64} max={1024} step={16} value={upShrink} onChange={(e) => setUpShrink(Number(e.target.value))} />
                </label>
              )}
              <label className="field" title="Smaller tiles use less graphics memory and take a little longer. Lower it if a large upscale runs out of memory.">
                <span>Tile size (graphics memory)</span>
                <select className="input" value={upTile} onChange={(e) => setUpTile(Number(e.target.value))}>
                  <option value={256}>256 - least memory</option>
                  <option value={512}>512 - default</option>
                  <option value={1024}>1024 - fastest, most memory</option>
                </select>
              </label>
              <p className="note">Adds real detail with SeedVR2, a dedicated upscaler. Transparent pictures keep their transparency.</p>
            </div>
          )}
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
            void openOwnPictures([...e.dataTransfer.files], online, setBusy);
          }}
        >
          <label style={{ cursor: 'pointer', display: 'grid', gap: 6, placeItems: 'center' }}>
            <ImagePlus size={22} />
            {busy ? 'Bringing in…' : online ? 'Drop, paste or browse your own pictures' : 'Start ComfyUI to bring pictures in'}
            <input
              className="sr"
              type="file"
              accept="image/*"
              multiple
              disabled={!online}
              aria-label="Upload your own picture"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                void openOwnPictures(files, online, setBusy);
              }}
            />
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
