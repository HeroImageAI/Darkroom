import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Lock,
  Shuffle,
  Unlock,
  Redo2,
  Sparkles,
  ScanSearch,
  Trash2,
  Undo2,
  Wand2,
  X,
  ChevronRight,
  RotateCw,
  Check,
  LayoutGrid,
  Paintbrush,
  PaintBucket,
  Shapes,
  RotateCcw,
  SquareDashed,
  Wand,
  Move,
  Layers as LayersIcon,
  SlidersHorizontal,
} from 'lucide-react';
import { api, downloadUrl, fileUrl, inputUrl, thumbUrl, type Item, type Job } from '../api';
import { deleteWithUndo } from '../lib/remove';
import { SHAPES, type Shape } from '../../shared/shape';
import { ORBIT_LORA, orbitLabel, type OrbitAngle, type OrbitHeight, type OrbitMove, type OrbitSide } from '../../shared/orbit';
import { ProgressBar, randomSeed, useHotkey } from '../components/common';
import { useItemLoad, usePersistent, useSessionState } from '../lib/hooks';
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
import { placeOnCanvas, type DocJson } from '../../shared/doc';
import { CanvasDoc, loadImage } from '../lib/doc';
import { DEFAULT_BRUSH, settingsOf, type BrushSettings } from '../lib/brush';
import { floodMask } from '../../shared/flood';
import { brushById, penGamma } from '../../shared/brushes';
import { FillBar, NewCanvasButton, PaintBar, SelectBar, ShapeBar, type ColourState, type SelOpUi, type ShapeKind, type Symmetry } from '../components/CanvasTools';
import { border as selBorder, combine as selCombine, growShrink } from '../../shared/selection';
import { drawTransform, startTransform, TransformBar, TransformOverlay, type TransformState } from '../components/TransformTool';
import { CanvasLayers } from '../components/CanvasLayers';
import { AdjustPanel } from '../components/AdjustPanel';
import { LOOKS } from '../../shared/adjust';
import { autoMode, MODES as RENDERS, renderPlan, type RenderMode } from '../../shared/compose';

/** Edits that run Klein / Qwen on the picture, so your LoRAs apply (not crop, upscale, background removal…). */
const LORA_MODES = new Set(['edit:instruct', 'edit:inpaint', 'edit:outpaint']);
import { MASK_OUTLINE_FILTER, MaskOutlineDefs } from '../components/MaskOutline';
import { onJob, toast, useApp } from '../store';
import { createCanvas } from '../lib/canvasStart';
import { OldCompositions } from '../components/OldCompositions';

type Tool = 'move' | 'transform' | 'paint' | 'fill' | 'shape' | 'brush' | 'eraser' | 'marquee' | 'lasso' | 'wand' | 'smart' | 'frame' | 'crop';
/** tools that make a selection with Shift = add, Alt = subtract (DECISIONS 124) */
const SEL_TOOLS = new Set<Tool>(['marquee', 'lasso', 'wand']);
/** tools that work on the canvas layers (DECISIONS 122, 123) */
type CanvasTool = 'paint' | 'fill' | 'shape';
const isCanvasTool = (t: Tool): t is CanvasTool => t === 'paint' || t === 'fill' || t === 'shape';
type Mode = 'instruct' | 'inpaint' | 'outpaint' | 'refine' | 'compose' | 'turn' | 'enhance' | 'remove_bg' | 'layers' | 'upscale';
/** Fill (DECISIONS 125): what the selection should become */
type FillKind = 'replace' | 'add' | 'remove' | 'background';
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
  { id: 'transform', label: 'Transform the layer', key: 'T', icon: Move },
  { id: 'paint', label: 'Paint on a layer', key: 'P', icon: Paintbrush },
  { id: 'fill', label: 'Fill bucket', key: 'G', icon: PaintBucket },
  { id: 'shape', label: 'Shapes', key: 'U', icon: Shapes },
  { id: 'brush', label: 'Mask brush', key: 'B', icon: Brush },
  { id: 'eraser', label: 'Eraser', key: 'E', icon: Eraser },
  { id: 'marquee', label: 'Marquee select', key: 'M', icon: SquareDashed },
  { id: 'lasso', label: 'Lasso', key: 'L', icon: Lasso },
  { id: 'wand', label: 'Magic wand', key: 'W', icon: Wand },
  { id: 'smart', label: 'Smart select', key: 'S', icon: ScanSearch },
  { id: 'frame', label: 'Outpaint frame', key: 'O', icon: Expand },
  { id: 'crop', label: 'Crop', key: 'C', icon: Crop },
];

/** The AI on the canvas first (Krita AI's fill modes, DECISIONS 125), then the other picture tools. */
const MODES: { id: Mode; label: string; group: 'canvas' | 'more'; tip: string }[] = [
  { id: 'instruct', label: 'Instruct', group: 'canvas', tip: 'Change the picture (or the selection) by saying what to do' },
  { id: 'inpaint', label: 'Fill', group: 'canvas', tip: 'Replace, add to or remove what is in the selection, or replace the background' },
  { id: 'outpaint', label: 'Expand', group: 'canvas', tip: 'Add new space around the picture' },
  { id: 'refine', label: 'Refine', group: 'canvas', tip: 'Redraw what is there at a strength you choose: paintovers and sketches become finished, the layout stays' },
  { id: 'compose', label: 'Compose', group: 'canvas', tip: 'Turn pieces placed on a background, and paint, into one picture: Blend edges, Harmonise or Reimagine' },
  { id: 'turn', label: 'Turn it', group: 'more', tip: 'See the object from another angle' },
  { id: 'enhance', label: 'Enhance', group: 'more', tip: 'Restore blur, noise and low resolution' },
  { id: 'layers', label: 'Separate', group: 'more', tip: 'Split the picture into layers, one per object' },
  { id: 'remove_bg', label: 'Cut-out', group: 'more', tip: 'Remove the background (real transparency)' },
  { id: 'upscale', label: 'Upscale', group: 'more', tip: 'More pixels with SeedVR2' },
];

/** AI results that land on the canvas as a layer when layers are on (DECISIONS 122); others open as a version. */
const LAYERABLE: Record<string, string> = { 'edit:instruct': 'Instruct', 'edit:inpaint': 'Fill', 'edit:enhance': 'Refine', 'edit:remove_bg': 'Cut-out', compose: 'Compose' };
/** Pen pressure; a mouse or finger paints at full pressure. */
const pressureOf = (e: { pointerType: string; pressure: number }) => (e.pointerType === 'pen' ? e.pressure : 1);

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
  /** One frame per Layers group in the version strip: the picture on screen when it is one of them, else the first. */
  const groupFrame = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of lineage) if (v.group_id && !m.has(v.group_id)) m.set(v.group_id, v.id);
    if (item.group_id) m.set(item.group_id, item.id);
    return m;
  }, [lineage, item.id, item.group_id]);
  const [tool, setTool] = useState<Tool>('brush');
  const [mode, setMode] = useState<Mode>(() => (sessionStorage.getItem('dr.edit.mode') as Mode) || 'instruct');
  const boot = useApp((s) => s.boot);
  const [editModel, setEditModel] = useState<string>(() => localStorage.getItem('dr.edit.model') || 'qwen');
  // your own LoRAs per model (DECISIONS 86), used by Instruct, Inpaint, Outpaint and Enhance
  const [editLoras, setEditLoras] = usePersistent<Record<string, LoraUse[]>>('edit.loras', {});
  const lorasNow = (): LoraUse[] => (editModel === 'klein' || editModel === 'qwen' ? (editLoras[editModel] ?? []) : []);
  // your Klein 9B fine-tune (DECISIONS 91), a preference like the LoRAs
  const [kleinWeights, setKleinWeights] = usePersistent<string>('edit.kleinWeights', '');
  // Seed (P1, test-suite run 2026-10-03): like Generate's — type one to lock it; unlocked, every run takes a new
  // random seed and shows it, so a result you like can be repeated
  // kept for the session, so a locked seed stays locked when Edit moves on to the new version (test-suite finding 1)
  const [editSeed, setEditSeed] = useSessionState<{ seed: number; locked: boolean }>('edit.seed', { seed: randomSeed(), locked: false });
  const [advOpen, setAdvOpen] = useSessionState('edit.advanced', false);
  // Qwen helpers (DECISIONS 119): Fast = Turbo8 at 8 steps; keep the frame = the Consistency LoRA on a whole-picture edit
  const [qwenFast, setQwenFast] = usePersistent('edit.qwenFast', false);
  const [keepFrame, setKeepFrame] = usePersistent('edit.keepFrame', true);
  const qwenExtras = (m: string): Record<string, number> => (m === 'qwen' ? { ...(qwenFast ? { fast: 1 } : {}), ...(keepFrame ? {} : { keep_frame: 0 }) } : {});
  // Turn it (DECISIONS 114)
  const [turnMove, setTurnMove] = useSessionState<OrbitMove>('edit.turn', { angle: 45, side: 'right', height: 'eye' });
  const [orbitReady, setOrbitReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (mode !== 'turn' || orbitReady !== null) return;
    api
      .get<{ qwen: { name: string }[] }>('/api/loras')
      .then((c) => setOrbitReady(c.qwen.some((l) => ORBIT_LORA.test(l.name))))
      .catch(() => setOrbitReady(false));
  }, [mode, orbitReady]);
  // Shape in Instruct (DECISIONS 117): keep the picture's shape, or redraw it in another
  const [shape, setShape] = useSessionState<'keep' | Shape>('edit.shape', 'keep');
  // Sheet maker (DECISIONS 118): a [SLOT] in the instruction + one value per line = one picture each, one labelled grid
  const [sheetLines, setSheetLines] = useSessionState('edit.sheet', '');
  const slotOf = () => /\[([A-Z][A-Z ]{1,30})\]/.exec(prompt);
  const sheetValues = sheetLines.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 9);
  const makeSheet = async () => {
    const slotMatch = slotOf();
    if (!slotMatch || sheetValues.length < 2) return;
    try {
      const T = boot!.prompts;
      const em = editModel as ImageModelKey;
      const prompts = sheetValues.map((v) => composeImagePrompt(T, { model: em, mode: 'instruct', text: prompt.split(slotMatch[0]).join(v) }));
      const extra: Record<string, string | number> = { ...weightsNow(), ...(lorasNow().length ? { loras: JSON.stringify(lorasNow()) } : {}), ...(shape !== 'keep' ? { shape } : {}), ...qwenExtras(em) };
      const sid = await savedPictureId('the sheet');
      if (!sid) return;
      const r = await api.post<{ jobs: Job[] }>(`/api/items/${sid}/sheet`, { workflow: wfFor('instruct'), model: em, prompts, labels: sheetValues, seed: nextSeed(), name: `${slotMatch[1].toLowerCase()} sheet`, extra });
      toast(`Making ${r.jobs.length} pictures for the sheet (about ${Math.round((r.jobs.length * (em === 'klein' ? 15 : 25)) / 60) || 1} min). Each one lands as a version; the labelled sheet goes to the Library when the last is in.`, 'info', 9000);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  // Try both models (DECISIONS 116): one instruction to Klein and Qwen on the same seed, then pick
  const [both, setBoth] = useState<{ jobs: Record<'klein' | 'qwen', string>; done: Partial<Record<'klein' | 'qwen', string>>; failed: string[] } | null>(null);
  const [bothPick, setBothPick] = useState<{ klein: Item; qwen: Item } | null>(null);
  useEffect(
    () =>
      onJob((j) => {
        setBoth((b) => {
          if (!b) return b;
          const m = (Object.keys(b.jobs) as ('klein' | 'qwen')[]).find((k) => b.jobs[k] === j.id);
          if (!m) return b;
          if (j.status === 'done' && j.result_ids[0]) return { ...b, done: { ...b.done, [m]: j.result_ids[0] } };
          if (j.status === 'error' || j.status === 'lost' || j.status === 'cancelled') return { ...b, failed: [...b.failed, m] };
          return b;
        });
      }),
    [],
  );
  useEffect(() => {
    if (!both) return;
    if (both.failed.length) {
      toast(`${both.failed.map((m) => (m === 'klein' ? 'Klein 9B' : 'Qwen-Image 2.1')).join(' and ')} could not finish; the other result is in the versions.`, 'error');
      setBoth(null);
      return;
    }
    if (both.done.klein && both.done.qwen) {
      const ids = both.done as Record<'klein' | 'qwen', string>;
      setBoth(null);
      void Promise.all([api.item(ids.klein), api.item(ids.qwen)]).then(([k, q]) => setBothPick({ klein: k.item, qwen: q.item }));
    }
  }, [both]);
  const tryBoth = async () => {
    if (running || both) return;
    if (!prompt.trim()) return toast('Type an instruction first, e.g. “make it night time”.', 'info');
    try {
      const T = boot!.prompts;
      const masked = onlyMasked && !maskEmpty;
      const inp = await inputFor();
      const mask = masked ? await uploadMask() : undefined;
      const seed = nextSeed();
      const jobs = {} as Record<'klein' | 'qwen', string>;
      for (const m of ['klein', 'qwen'] as const) {
        const workflow = boot?.manifest.edit?.instruct?.[m] ?? (m === 'qwen' ? 'qwen_edit' : 'klein_edit');
        const params: Record<string, string | number> = {
          image_1: inp.name,
          seed,
          prompt: composeImagePrompt(T, { model: m, mode: 'instruct', text: prompt, masked }),
          ...(ref ? { image_2: ref.name } : {}),
          ...(mask ? { mask } : { ...(shape !== 'keep' ? { shape } : {}) }),
          ...(m === 'klein' && kleinWeights ? { klein_weights: kleinWeights } : {}),
          ...((editLoras[m] ?? []).length ? { loras: JSON.stringify(editLoras[m]) } : {}),
          ...qwenExtras(m),
        };
        const j = await api.submit({ workflow, params, meta: { mode: 'edit:instruct', model: m === 'klein' ? 'Klein 9B edit' : 'Qwen-Image 2.1 edit', prompt: prompt.trim(), parentId: item.id, ui: item.ui } });
        jobs[m] = j.id;
      }
      setBoth({ jobs, done: {}, failed: [] });
      toast('Both models are on it — Klein first (~15 s), then Qwen (~25 s). You choose when both are in.', 'info', 6000);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const keepFromBoth = async (keep: 'klein' | 'qwen' | 'both') => {
    const pick = bothPick;
    setBothPick(null);
    if (!pick) return;
    if (keep !== 'both') await deleteWithUndo([pick[keep === 'klein' ? 'qwen' : 'klein'].id], 'version');
    go('edit', keep === 'qwen' ? pick.qwen.id : pick.klein.id);
  };
  const turnaround = async () => {
    try {
      const sid = await savedPictureId('the turnaround');
      if (!sid) return;
      const r = await api.post<{ jobs: Job[] }>(`/api/items/${sid}/turnaround`);
      if (r.jobs[0]) setJobId(r.jobs[0].id);
      toast('Turnaround: three new views are on their way; the sheet of all four sides lands in the Library when they are done.', 'info', 9000);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const seedRef = useRef(editSeed);
  seedRef.current = editSeed;
  const nextSeed = () => {
    const cur = seedRef.current;
    if (cur.locked) return cur.seed;
    const seed = randomSeed();
    setEditSeed({ seed, locked: false });
    return seed;
  };
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
  // Edit canvas layers (DECISIONS 122): null until you start layers or open a picture that has them
  const docRef = useRef<CanvasDoc | null>(null);
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [docVer, setDocVer] = useState(0);
  const [docStarting, setDocStarting] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved' | 'error' | 'none'>('none');
  const [flattening, setFlattening] = useState(false);
  const [panel, setPanel] = useSessionState<'ai' | 'layers' | 'adjust'>('edit.panel', 'ai');
  // brushes (DECISIONS 123): each preset keeps its own size, opacity… as you leave them; the colour is shared
  const [brushId, setBrushId] = usePersistent<string>('edit.brushId', 'round');
  const [brushPrefs, setBrushPrefs] = usePersistent<Record<string, Partial<BrushSettings>>>('edit.brushes', {});
  const [colour, setColour] = usePersistent<string>('edit.colour', DEFAULT_BRUSH.color);
  const preset = brushById(brushId);
  const paint: BrushSettings = { ...settingsOf(preset), ...brushPrefs[preset.id], engine: preset.engine, filter: preset.filter, color: colour };
  const setPaint = (fn: (s: BrushSettings) => BrushSettings) => {
    const n = fn(paint);
    if (n.color !== colour) setColour(n.color);
    const { color: _c, engine: _e, filter: _f, ...rest } = n;
    setBrushPrefs((p) => ({ ...p, [preset.id]: rest }));
  };
  const [paintErase, setPaintErase] = useState(false);
  const [recentColours, setRecentColours] = usePersistent<string[]>('edit.colours', []);
  const [swatches, setSwatches] = usePersistent<string[]>('edit.swatches', []);
  const [penFeel, setPenFeel] = usePersistent<number>('edit.penFeel', 0);
  const [symmetry, setSymmetry] = useSessionState<Symmetry>('edit.symmetry', 'off');
  const [fillOpts, setFillOpts] = usePersistent('edit.fillTool', { tolerance: 32, contiguous: true, merged: false, opacity: 1 });
  const [shapeOpts, setShapeOpts] = usePersistent('edit.shapeTool', { kind: 'rect' as ShapeKind, filled: false, size: 6, opacity: 1 });
  // view only: turn and mirror the canvas to draw at a comfortable angle (the picture is not changed)
  const [rot, setRot] = useState(0);
  const [flipView, setFlipView] = useState(false);
  const pushRecent = (c: string) => setRecentColours((r) => [c, ...r.filter((x) => x !== c)].slice(0, 8));
  const colourState: ColourState = { colour, setColour: (c) => setColour(c), recent: recentColours, swatches, setSwatches };
  const shapeBrush = (): BrushSettings => ({ ...paint, size: shapeOpts.size, opacity: shapeOpts.opacity });
  // selections (DECISIONS 124)
  const [selOp, setSelOp] = useSessionState<SelOpUi>('edit.selOp', 'add');
  const [marqueeKind, setMarqueeKind] = useSessionState<'rect' | 'ellipse'>('edit.marquee', 'rect');
  const [wandOpts, setWandOpts] = usePersistent('edit.wand', { tolerance: 32, contiguous: true, merged: true });
  const [selPx, setSelPx] = usePersistent('edit.selPx', 8);
  const [marq, setMarq] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // the AI on the canvas (DECISIONS 125)
  const [fillKind, setFillKind] = useSessionState<FillKind>('edit.fillKind', 'replace');
  const [refineStrength, setRefineStrength] = useSessionState('edit.refine', 0.35);
  const [composeMode, setComposeMode] = useSessionState<'auto' | RenderMode>('edit.composeMode', 'auto');
  const [describing, setDescribing] = useState(false);
  const [cStats, setCStats] = useState<{ paintCoverage: number; pictures: number }>({ paintCoverage: 0, pictures: 0 });
  // cut-outs of single layers on their way back (job id → layer id)
  const cutJobs = useRef(new Map<string, string>());
  const [cutting, setCutting] = useState<string[]>([]);
  const cutOutLayer = async (layerId: string) => {
    const d = docRef.current;
    const l = d?.layers.find((x) => x.id === layerId);
    if (!d || !l) return;
    try {
      const up = await api.upload(await d.layerBlob(layerId), 'layer.png');
      const j = await api.submit({ workflow: 'remove_bg', params: { image_1: up.name, matte: 'birefnet.safetensors', edge: 0 }, meta: { mode: 'edit:remove_bg', model: 'BiRefNet', prompt: l.name, title: `${l.name} · cut-out` } });
      cutJobs.current.set(j.id, layerId);
      setCutting((c) => [...c, layerId]);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  useEffect(
    () =>
      onJob((j) => {
        const layerId = cutJobs.current.get(j.id);
        if (!layerId) return;
        if (j.status === 'done' || j.status === 'error' || j.status === 'lost' || j.status === 'cancelled') {
          cutJobs.current.delete(j.id);
          setCutting((c) => c.filter((x) => x !== layerId));
        }
        if (j.status === 'done' && j.result_ids[0])
          void loadImage(fileUrl(j.result_ids[0]))
            .then((img) => docRef.current?.replacePixels(layerId, img, 'Cut out'))
            .catch(() => toast('The cut-out could not be loaded.', 'error'));
        else if (j.status === 'error' || j.status === 'lost') toast(j.error ?? 'The cut-out failed.', 'error');
      }),
    [],
  );
  // Clone brush: where it copies from (Alt-click), and the offset it keeps once you start painting
  const [cloneSrc, setCloneSrc] = useState<{ x: number; y: number } | null>(null);
  const [cloneOff, setCloneOff] = useState<{ dx: number; dy: number } | null>(null);
  const [cloneMerged, setCloneMerged] = usePersistent('edit.cloneMerged', true);
  // Transform (DECISIONS 124): the lifted pixels and where the handles put them
  const [tf, setTf] = useState<TransformState | null>(null);
  const tfRef = useRef<TransformState | null>(null);
  tfRef.current = tf;
  /** the op for this click: Shift adds, Alt subtracts, both keep the overlap, else the chosen mode */
  const opFor = (e: { shiftKey: boolean; altKey: boolean }): SelOpUi => (e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : selOp);
  const compCanvas = useRef<HTMLCanvasElement>(null);
  const strokePt = useRef<{ x: number; y: number } | null>(null);
  /** the selection a running edit used, to mask its result layer */
  const jobMask = useRef<HTMLCanvasElement | null>(null);
  /** one undo order across the AI mask and the canvas layers */
  const order = useRef<{ undo: ('mask' | 'doc')[]; redo: ('mask' | 'doc')[] }>({ undo: [], redo: [] });
  const pushOrder = (k: 'mask' | 'doc') => {
    order.current.undo.push(k);
    if (order.current.undo.length > 200) order.current.undo.shift();
    order.current.redo = [];
  };
  const drag = useRef<{ op?: SelOpUi; kind: 'pan' | 'paint' | 'stroke' | 'shape' | 'marquee' | 'lasso' | 'frame' | 'crop' | 'sam'; sx: number; sy: number; vx: number; vy: number; side?: keyof Pad; start?: Pad; origin?: { x: number; y: number } } | null>(null);

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
    layer.current.onCheckpoint = () => pushOrder('mask');
  }, [W, H]);

  // ---- Edit canvas layers (DECISIONS 122)
  const attachDoc = (d: CanvasDoc) => {
    docRef.current = d;
    d.onPush = () => pushOrder('doc');
    setDoc(d);
    setDocVer(d.version);
    setSaveState(d.isProject ? 'saved' : 'none');
  };
  useEffect(() => {
    if (!item.layered) return;
    let off = false;
    setDocStarting(true);
    api
      .get<DocJson>(`/api/items/${item.id}/project`)
      .then((j) => CanvasDoc.fromJson(j))
      .then((d) => {
        if (!off) attachDoc(d);
      })
      .catch(() => toast('Could not open the layers of this picture.', 'error'))
      .finally(() => !off && setDocStarting(false));
    return () => {
      off = true;
    };
  }, [item.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!doc) return;
    let raf = 0;
    const draw = () => {
      raf = 0;
      const c = compCanvas.current;
      if (c) doc.renderChanges(c);
    };
    const offPaint = doc.onPaint(() => {
      if (!raf) raf = requestAnimationFrame(draw);
    });
    let timer: number | undefined;
    const offChange = doc.subscribe(() => {
      setDocVer(doc.version);
      if (!doc.isProject) return;
      setSaveState('unsaved');
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        setSaveState('saving');
        doc
          .save()
          .then(() => setSaveState('saved'))
          .catch(() => setSaveState('error'));
      }, 1200);
    });
    draw();
    return () => {
      offPaint();
      offChange();
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      if (doc.unsaved) void doc.save().catch(() => undefined);
    };
  }, [doc]);
  // Adjust tab (DECISIONS 124): the active adjustment layer and the histogram of what is below it
  const adjLayer = doc?.activeLayer?.kind === 'adjust' ? doc.activeLayer : null;
  const [hist, setHist] = useState<ReturnType<CanvasDoc['histogramBelow']> | null>(null);
  useEffect(() => {
    if (panel !== 'adjust' || !adjLayer || !doc) return setHist(null);
    const t = setTimeout(() => setHist(doc.histogramBelow(adjLayer.id)), 50);
    return () => clearTimeout(t);
  }, [panel, adjLayer?.id, doc]); // eslint-disable-line react-hooks/exhaustive-deps
  // the transform preview follows the handles; leaving the tool puts the pixels down
  useEffect(() => {
    if (tf) docRef.current?.updateTransform((g) => drawTransform(g, tf));
  }, [tf]);
  useEffect(() => {
    if (tool !== 'transform' && tfRef.current) applyTf();
  }, [tool]); // eslint-disable-line react-hooks/exhaustive-deps
  useHotkey((e) => !!tfRef.current && (e.key === 'Enter' || e.key === 'Escape') && !e.ctrlKey && !e.metaKey, (e) => (e.key === 'Enter' ? applyTf() : cancelTf()), [maskEmpty]);
  // paint, fill and shapes stay inside the selection (DECISIONS 124)
  useEffect(() => {
    if (doc) doc.clip = !maskEmpty && layer.current ? layer.current.mask : null;
  }, [doc, maskEmpty]);
  /** Selection menu: all, none, invert, grow, shrink, feather, border, from the layer's pixels. */
  const selAction = (a: 'all' | 'none' | 'invert' | 'grow' | 'shrink' | 'feather' | 'border' | 'layer') => {
    const m = layer.current;
    if (!m) return;
    if (a === 'all') m.selectAll();
    else if (a === 'none') m.clear();
    else if (a === 'invert') m.invert();
    else if (a === 'feather') m.feather(selPx);
    else if (a === 'grow' || a === 'shrink') m.setAlpha(growShrink(m.alpha(), W, H, a === 'grow' ? selPx : -selPx));
    else if (a === 'border') m.setAlpha(selBorder(m.alpha(), W, H, selPx));
    else if (a === 'layer') {
      const d = docRef.current;
      const al = d?.activeLayer ? d.layerAlpha(d.activeLayer.id) : null;
      if (!al) return toast('Pick a picture or paint layer to select what is on it.', 'info');
      m.setAlpha(selCombine(m.alpha(), al, selOp));
    }
    setMaskEmpty(m.isEmpty());
  };
  /** Lift the selected layer (or its selected part) for the Transform tool. */
  const startTf = async () => {
    const d = await ensureDoc();
    if (!d || d.transforming) return;
    // read the selection now (this can run from a hotkey bound at first render)
    const r = d.beginTransform(layer.current && !layer.current.isEmpty() ? layer.current.mask : null);
    if (typeof r === 'string') return toast(r, 'info');
    setTf(startTransform(r.src, r.box));
  };
  const applyTf = () => {
    const d = docRef.current;
    const s = tfRef.current;
    if (!d || !s) return;
    d.commitTransform(s.mode === 'free' ? 'Transform' : s.mode === 'perspective' ? 'Perspective' : 'Warp');
    setTf(null);
    // the selected part has moved: its old outline no longer fits
    if (layer.current && !layer.current.isEmpty()) {
      layer.current.clear();
      setMaskEmpty(true);
    }
  };
  const cancelTf = () => {
    docRef.current?.cancelTransform();
    setTf(null);
  };
  /** Magic wand at a picture point: the area of similar colour, combined into the selection. */
  const wandAt = (p: { x: number; y: number }, op: SelOpUi) => {
    const m = layer.current;
    if (!m) return;
    const d = docRef.current;
    let src: HTMLCanvasElement;
    if (d && !wandOpts.merged && d.activeLayer && d.activeLayer.kind !== 'adjust') src = d.activeLayer.canvas;
    else if (d) src = d.flatten();
    else {
      src = document.createElement('canvas');
      src.width = W;
      src.height = H;
      src.getContext('2d')!.drawImage(imgRef.current!, 0, 0, W, H);
    }
    const data = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H).data;
    const res = floodMask(data, W, H, p.x, p.y, wandOpts.tolerance, wandOpts.contiguous);
    if (!res) return;
    m.setAlpha(selCombine(m.alpha(), res.mask, op));
    setMaskEmpty(m.isEmpty());
  };
  useEffect(() => {
    if (mode !== 'compose' || !doc) return;
    const t = setTimeout(() => setCStats(doc.composeStats()), 300);
    return () => clearTimeout(t);
  }, [mode, doc, docVer]);
  // one picture with nothing placed on it yet: Harmonise is the sensible render (it is not "only paint")
  const composeAuto = !doc || (cStats.pictures === 0 && cStats.paintCoverage === 0) ? { mode: 'harmonise' as RenderMode, why: 'one picture' } : autoMode(cStats.paintCoverage, cStats.pictures);
  const renderMode: RenderMode = composeMode === 'auto' ? composeAuto.mode : composeMode;
  /** The local vision model reads the canvas as a plan for a real photo and writes the scene. */
  const describeScene = async (): Promise<string | null> => {
    setDescribing(true);
    try {
      const inp = await inputFor();
      const r = await api.vlm({ task: 'scene', variant: 'default', input: inp.name, text: prompt });
      setPrompt(r.text.trim());
      return r.text.trim();
    } catch (e) {
      toast(`Could not describe the scene: ${(e as Error).message}`, 'error');
      return null;
    } finally {
      setDescribing(false);
    }
  };
  // Library "Use as… › Layer in Edit"
  useEffect(() => {
    const add = sessionStorage.getItem('dr.edit.addLayer');
    if (!add) return;
    sessionStorage.removeItem('dr.edit.addLayer');
    void api
      .item(add)
      .then((r) => addItemLayer(r.item))
      .catch(() => toast('Could not add that picture as a layer.', 'error'));
  }, [item.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (sessionStorage.getItem('dr.edit.startLayers') !== item.id) return;
    sessionStorage.removeItem('dr.edit.startLayers');
    void ensureDoc().then((d) => {
      if (d && d.layers.length === 1) d.addPaintLayer();
    });
  }, [item.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // a fresh on-screen canvas (back from Compare) needs the whole picture once
  useEffect(() => {
    if (doc && compCanvas.current) doc.render(compCanvas.current);
  }, [doc, compare]);
  // don't lose layers that are still being saved by closing the tab
  useEffect(() => {
    if (saveState !== 'unsaved' && saveState !== 'saving') return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [saveState]);
  const starting = useRef<Promise<CanvasDoc | null> | null>(null);
  const ensureDoc = (): Promise<CanvasDoc | null> => {
    if (docRef.current) return Promise.resolve(docRef.current);
    if (starting.current) return starting.current;
    setDocStarting(true);
    starting.current = CanvasDoc.fromItem(item.id, W, H, item.mode === 'canvas' ? 'Paper' : 'Picture')
      .then((d) => (attachDoc(d), d))
      .catch(() => (toast('Could not open the picture for painting.', 'error'), null))
      .finally(() => {
        starting.current = null;
        setDocStarting(false);
      });
    return starting.current;
  };
  /** The picture the AI works on: the merged layers when there are any, else the picture itself. */
  const inputFor = async (): Promise<{ name: string }> => {
    const d = docRef.current;
    if (d?.isProject) return api.upload(await d.flattenBlob(), 'canvas.png');
    return api.asInput(item.id);
  };
  const addItemLayer = async (it: Item, kind: 'picture' | 'result' = 'picture', name?: string, where: 'top' | 'above' = 'above') => {
    const d = await ensureDoc();
    if (!d) return;
    try {
      const img = await loadImage(fileUrl(it.id));
      d.addImageLayer(img, { name: name ?? (it.title || `v${it.version} · ${it.mode.replace(/^edit:/, '')}`), kind, source: it.id, where, fit: name ? 1 : 0.6 });
      setPanel('layers');
    } catch {
      toast('Could not add that picture as a layer.', 'error');
    }
  };
  /** Pictures from your computer (pasted or dropped) as layers, placed for a scene. */
  const addFileLayers = async (files: File[]) => {
    const d = await ensureDoc();
    if (!d) return;
    for (const file of files.filter((x) => x.type.startsWith('image/'))) {
      const url = URL.createObjectURL(file);
      try {
        const img = await loadImage(url);
        d.addImageLayer(img, { name: file.name.replace(/\.[a-z0-9]+$/i, '') || 'Pasted', kind: 'picture', fit: 0.6 });
      } catch {
        toast(`Could not read ${file.name}.`, 'error');
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    setPanel('layers');
  };
  /** A finished AI result on top of the canvas, masked to the selection it used; anything that doesn't fit opens as a version. */
  const addResultLayer = async (d: CanvasDoc, id: string, mode: string, model: string) => {
    try {
      const { item: r } = await api.item(id);
      const fits = !!r.width && !!r.height && placeOnCanvas(r.width, r.height, d.width, d.height).exact && r.width <= d.width * 1.05;
      if (!fits) {
        const back = item.id;
        toast(`This result has another size, so it is a new version. Your layers stay with v${item.version}.`, 'info', 10000, { label: 'Back to the layers', run: () => go('edit', back) });
        return go('edit', id);
      }
      const img = await loadImage(fileUrl(id));
      const mask = jobMask.current;
      jobMask.current = null;
      d.addImageLayer(img, { name: `${LAYERABLE[mode] ?? 'Result'} · ${model.replace(/ (edit|fill|extraction)$/, '')}`, kind: 'result', source: id, mask, where: 'top' });
      // the selection now lives on as the layer's mask
      if (mask && layer.current) {
        layer.current.clear();
        setMaskEmpty(true);
      }
      // stay in the AI panel: the next step is often another AI step
      toast(`The result is on a new layer at the top${mask ? ', masked to your selection' : ''}. It is kept as v${r.version} too.`, 'ok', 9000, { label: 'Open the version', run: () => go('edit', id) });
    } catch {
      go('edit', id);
    }
  };
  /** The merged layers as the next version of the picture (the layers stay with this one). */
  const flattenNow = async (): Promise<Item> => {
    const d = docRef.current!;
    await d.save().catch(() => undefined);
    const r = await fetch(`/api/items/${item.id}/flatten?layers=${d.layers.length}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await d.flattenBlob() });
    const j = (await r.json()) as Item & { error?: string };
    if (!r.ok) throw new Error(j.error ?? 'Could not save the version.');
    return j;
  };
  const flattenToVersion = async () => {
    if (!docRef.current) return;
    setFlattening(true);
    try {
      const j = await flattenNow();
      toast(`Saved as v${j.version}. Your layers stay with v${item.version}.`, 'ok', 9000, { label: `Back to the layers`, run: () => go('edit', item.id) });
      go('edit', j.id);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setFlattening(false);
    }
  };
  /**
   * Steps that read the saved picture on the server (Turn it, Turnaround, the Sheet maker, a video, a download): with
   * layers on, the merged layers become a new version first, so they see what you see.
   */
  const savedPictureId = async (what: string): Promise<string | null> => {
    if (!docRef.current?.isProject) return item.id;
    try {
      const j = await flattenNow();
      toast(`Your layers were saved as v${j.version} first, so ${what} uses them. The layers stay with v${item.version}.`, 'info', 9000);
      return j.id;
    } catch (e) {
      toast((e as Error).message, 'error');
      return null;
    }
  };
  const exportPng = async () => {
    const d = docRef.current;
    if (!d) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await d.flattenBlob());
    a.download = `darkroom-${(item.title || item.prompt || 'canvas').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '') || 'canvas'}-layers.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const pickColour = (e: { clientX: number; clientY: number }) => {
    const p = toImage(e);
    let c = docRef.current ? compCanvas.current : null;
    if (!c) {
      c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      c.getContext('2d')!.drawImage(imgRef.current!, 0, 0, W, H);
    }
    const px = c.getContext('2d', { willReadFrequently: true })!.getImageData(Math.min(W - 1, Math.max(0, Math.floor(p.x))), Math.min(H - 1, Math.max(0, Math.floor(p.y))), 1, 1).data;
    const hex = '#' + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    setPaint((s) => ({ ...s, color: hex }));
  };
  const chooseCanvasTool = (t: CanvasTool) => {
    setTool(t);
    setPanel('layers');
    // painting or drawing shapes on a plain picture goes on a layer of its own, so the photo stays as it is
    void ensureDoc().then((d) => {
      if (d && (t === 'paint' || t === 'shape') && d.layers.length === 1 && !d.layers[0].painted) d.addPaintLayer();
    });
  };
  const chooseTransform = () => {
    setTool('transform');
    setPanel('layers');
    void startTf();
  };

  const fit = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    const tw = W + pad.left + pad.right;
    const th = H + pad.top + pad.bottom;
    // room at the top for the Upload / view buttons that float over the canvas
    const top = 56;
    const s = Math.min((el.clientWidth - 64) / tw, (el.clientHeight - top - 32) / th, 2);
    setView({ scale: s, x: (el.clientWidth - tw * s) / 2 + pad.left * s, y: top + (el.clientHeight - top - th * s) / 2 + pad.top * s });
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
        if (j.status === 'done' && (chainKind === 'upscale' || chainKind === 'enhance' || chainKind === 'turn_pre')) return; // wait for the follow-up (Turn it: the cut-out comes first)
        if (j.status === 'done' && (j.meta as any).layers) {
          sessionStorage.removeItem('dr.edit.job');
          setLayerGroup(((j.meta as any).groupId as string | undefined) ?? j.id);
          toast('Layers ready. Toggle, reorder, rename and export them on the right.', 'ok');
          return;
        }
        if (j.status === 'done' && j.result_ids[0]) {
          sessionStorage.removeItem('dr.edit.job');
          // layers on: the result comes in as a layer (it is a version too)
          const d = docRef.current;
          const jm = j.meta as any;
          if (d?.isProject && LAYERABLE[jm.mode] && !jm.copied) return void addResultLayer(d, j.result_ids[0], jm.mode, String(jm.model ?? ''));
          if (d?.isProject) {
            const back = item.id;
            toast(`This result has another size, so it is a new version. Your layers stay with v${item.version}.`, 'info', 10000, { label: 'Back to the layers', run: () => go('edit', back) });
          }
          go('edit', j.result_ids[0]);
          const parentId = (j.meta as any).parentId as string | undefined;
          // Qwen sometimes returns the picture almost unchanged for a given seed (DECISIONS 107)
          if ((j.meta as any).copied && parentId)
            toast('Qwen returned almost the same picture — this happens with some seeds. Try another seed.', 'info', 15000, {
              label: 'Try another seed',
              run: () => {
                // stored directly too: by now Edit may show the copy in a new instance of this screen
                const next = { seed: randomSeed(), locked: false };
                sessionStorage.setItem('dr.edit.seed', JSON.stringify(next));
                setEditSeed(next);
                go('edit', parentId);
              },
            });
          else toast('New version saved. Earlier versions are untouched.', 'ok');
        }
        if (j.status === 'error' || j.status === 'lost') toast(j.error ?? 'That edit failed.', 'error');
      }),
    [jobId],
  );

  /** Screen point → picture pixels, through the view's zoom, pan, turn and mirror. */
  const toImage = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect();
    const s = view.scale;
    const dx = e.clientX - (r.left + view.x + (W * s) / 2);
    const dy = e.clientY - (r.top + view.y + (H * s) / 2);
    const a = (-rot * Math.PI) / 180;
    let ux = dx * Math.cos(a) - dy * Math.sin(a);
    const uy = dx * Math.sin(a) + dy * Math.cos(a);
    if (flipView) ux = -ux;
    return { x: ux / s + W / 2, y: uy / s + H / 2 };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (compare || e.button === 2) return;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* a pointer the browser no longer tracks */
    }
    const base = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    if (isCanvasTool(tool) && e.button === 0 && e.altKey) {
      if (tool === 'paint' && paint.engine === 'clone') {
        setCloneSrc(toImage(e));
        setCloneOff(null);
        return;
      }
      return pickColour(e);
    }
    if (tool === 'move' || e.button === 1 || (e.altKey && !SEL_TOOLS.has(tool))) {
      drag.current = { kind: 'pan', ...base };
      return;
    }
    const p = toImage(e);
    // Transform: the handles take the pointer; a click elsewhere lifts the layer again after an Apply
    if (tool === 'transform') {
      if (!tfRef.current) void startTf();
      return;
    }
    if (tool === 'marquee') {
      drag.current = { kind: 'marquee', ...base, origin: p, op: opFor(e) };
      setMarq({ x: p.x, y: p.y, w: 0, h: 0 });
      return;
    }
    if (tool === 'wand') return wandAt(p, opFor(e));
    if (isCanvasTool(tool)) {
      const d = docRef.current;
      if (!d) {
        void ensureDoc();
        return toast('Getting the canvas ready: try again in a moment.', 'info');
      }
      // Ctrl-click picks the layer under the pen
      if (e.ctrlKey || e.metaKey) {
        const id = d.layerAt(p.x, p.y);
        if (id) d.select(id);
        return;
      }
      const why = d.paintBlocker();
      if (why) return toast(why, 'info');
      if (tool === 'fill') {
        const err = d.fill(p.x, p.y, colour, fillOpts);
        if (err) toast(err, 'info');
        else pushRecent(colour);
        return;
      }
      if (tool === 'shape') {
        if (d.previewShape(shapeOpts.kind, p, p, shapeBrush(), shapeOpts.filled, e.shiftKey)) drag.current = { kind: 'shape', ...base, origin: p };
        return;
      }
      // the pen's eraser end erases
      const erase = paintErase || (e.pointerType === 'pen' && (e.buttons & 32) !== 0);
      const mirror = { mirrorX: symmetry === 'v' || symmetry === 'both' ? W / 2 : undefined, mirrorY: symmetry === 'h' || symmetry === 'both' ? H / 2 : undefined };
      let clone: { dx: number; dy: number; merged: boolean } | undefined;
      if (paint.engine === 'clone' && !erase) {
        if (!cloneSrc) return toast('Alt-click where to copy from first, then paint where it should go.', 'info');
        // aligned: the first stroke fixes the offset; later strokes keep it until you Alt-click again
        const off = cloneOff ?? { dx: cloneSrc.x - p.x, dy: cloneSrc.y - p.y };
        setCloneOff(off);
        clone = { ...off, merged: cloneMerged };
      }
      if (d.beginStroke(paint, erase, p.x, p.y, pressureOf(e), { ...mirror, gamma: penGamma(penFeel), clone })) {
        strokePt.current = p;
        drag.current = { kind: 'stroke', ...base };
      }
      return;
    }
    if (tool === 'brush' || tool === 'eraser') {
      layer.current?.beginStroke(p.x, p.y, brush, tool === 'eraser');
      drag.current = { kind: 'paint', ...base };
    } else if (tool === 'lasso') {
      setLasso([p]);
      drag.current = { kind: 'lasso', ...base, op: e.shiftKey || e.altKey ? opFor(e) : undefined };
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
    } else if (d.kind === 'stroke') {
      // every pen sample, not just one per frame: smooth curves with a Wacom
      const ne = e.nativeEvent as PointerEvent;
      const evs = ne.getCoalescedEvents?.() ?? [];
      for (const ev of evs.length ? evs : [ne]) {
        const q = toImage(ev);
        docRef.current?.strokeTo(q.x, q.y, pressureOf(ev));
        strokePt.current = q;
      }
    } else if (d.kind === 'shape' && d.origin) docRef.current?.previewShape(shapeOpts.kind, d.origin, toImage(e), shapeBrush(), shapeOpts.filled, e.shiftKey);
    else if (d.kind === 'marquee' && d.origin) {
      const q = toImage(e);
      setMarq({ x: Math.min(d.origin.x, q.x), y: Math.min(d.origin.y, q.y), w: Math.abs(q.x - d.origin.x), h: Math.abs(q.y - d.origin.y) });
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
    } else if (d.kind === 'stroke') {
      docRef.current?.endStroke(strokePt.current?.x ?? null, strokePt.current?.y ?? null);
      strokePt.current = null;
      if (!paintErase && paint.engine === 'paint') pushRecent(colour);
    } else if (d.kind === 'shape') {
      docRef.current?.endStroke(null, null);
      pushRecent(colour);
    } else if (d.kind === 'marquee') {
      const m = layer.current;
      const r = marq;
      setMarq(null);
      if (m && r && r.w >= 3 && r.h >= 3) m.applyShape(m.shape(marqueeKind, r.x, r.y, r.w, r.h), d.op ?? selOp);
      // a click without a drag deselects, as in other painting apps
      else if (m && (d.op ?? selOp) === 'replace') m.clear();
      setMaskEmpty(!!m?.isEmpty());
    } else if (d.kind === 'lasso' && lasso) {
      // Shift on release still takes away (as before); Shift/Alt at the start choose the mode; else the bar's mode
      if (d.op) layer.current?.fillPolygon(lasso, false, d.op);
      else if (e.shiftKey) layer.current?.fillPolygon(lasso, true);
      else layer.current?.fillPolygon(lasso, false, selOp === 'add' ? undefined : selOp);
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
      toast(`${samOp === 'subtract' ? 'Taken away from' : 'Added to'} the selection (${r.seconds}s). Use it with Instruct, Fill, Refine or Cut-out, or to paint inside.`, 'ok');
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
  // With layers on, Undo walks the mask and layer steps in the order you made them and never leaves the picture.
  const undo = () => {
    if (tfRef.current) return cancelTf();
    const o = order.current;
    for (let k = o.undo.pop(); k; k = o.undo.pop()) {
      if (k === 'mask' && layer.current?.undo()) {
        o.redo.push(k);
        return setMaskEmpty(layer.current.isEmpty());
      }
      if (k === 'doc' && docRef.current?.undo()) return void o.redo.push(k);
    }
    if (docRef.current?.isProject) return toast('Nothing more to undo here. Earlier versions are in the strip below.', 'info');
    if (versionIndex > 0) go('edit', lineage[versionIndex - 1].id);
  };
  const redo = () => {
    const o = order.current;
    for (let k = o.redo.pop(); k; k = o.redo.pop()) {
      if (k === 'mask' && layer.current?.redo()) {
        o.undo.push(k);
        return setMaskEmpty(layer.current.isEmpty());
      }
      if (k === 'doc' && docRef.current?.redo()) return void o.undo.push(k);
    }
    if (docRef.current?.isProject) return;
    if (versionIndex >= 0 && versionIndex < lineage.length - 1) go('edit', lineage[versionIndex + 1].id);
  };
  /** History panel: undo `n` layer steps. */
  const undoDocSteps = (n: number) => {
    for (let i = 0; i < n; i++) {
      const at = order.current.undo.lastIndexOf('doc');
      if (at < 0 || !docRef.current?.undo()) break;
      order.current.undo.splice(at, 1);
      order.current.redo.push('doc');
    }
  };

  useHotkey((e) => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey, (e) => (e.preventDefault(), undo()), [lineage, item.id]);
  useHotkey((e) => (e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)), (e) => (e.preventDefault(), redo()), [lineage, item.id]);
  useHotkey(
    (e) => !e.ctrlKey && !e.metaKey && !e.altKey && TOOLS.some((t) => t.key.toLowerCase() === e.key.toLowerCase() && !t.disabled),
    (e) => {
      const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase())!.id;
      if (isCanvasTool(t)) return chooseCanvasTool(t);
      if (t === 'transform') return chooseTransform();
      setTool(t);
      if (t === 'frame') setMode('outpaint');
    },
    [],
  );
  useHotkey(
    (e) => e.key === '[' || e.key === ']',
    (e) => {
      const up = e.key === ']';
      if (tool === 'paint') setPaint((s) => ({ ...s, size: Math.max(1, Math.min(500, Math.round(s.size * (up ? 1.15 : 1 / 1.15)) + (up ? 1 : -1))) }));
      else setBrush((b) => Math.max(4, Math.min(400, b + (up ? 8 : -8))));
    },
    [tool, brushId, brushPrefs, colour],
  );
  // view: 4 / 6 turn it, 5 straightens it, H mirrors it (only the view)
  useHotkey(
    (e) => !e.ctrlKey && !e.metaKey && !e.altKey && ['4', '5', '6', 'h', 'H'].includes(e.key),
    (e) => {
      if (e.key === '4') setRot((r) => r - 15);
      else if (e.key === '6') setRot((r) => r + 15);
      else if (e.key === '5') (setRot(0), setFlipView(false));
      else setFlipView((x) => !x);
    },
    [],
  );
  // selections: Ctrl+A all, Ctrl+D none, Ctrl+Shift+I invert
  useHotkey(
    (e) => (e.ctrlKey || e.metaKey) && !e.altKey && (e.key.toLowerCase() === 'a' || e.key.toLowerCase() === 'd' || (e.shiftKey && e.key.toLowerCase() === 'i')),
    (e) => {
      e.preventDefault();
      selAction(e.key.toLowerCase() === 'a' ? 'all' : e.key.toLowerCase() === 'd' ? 'none' : 'invert');
    },
    [selPx, selOp],
  );
  // X: paint / erase with the Paint tool
  useHotkey((e) => tool === 'paint' && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'x', () => setPaintErase((x) => !x), [tool]);

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
    const img: HTMLCanvasElement | HTMLImageElement = docRef.current?.isProject ? docRef.current.flatten() : await loadImage(fileUrl(item.id));
    const c = document.createElement('canvas');
    c.width = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
    c.height = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
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

  /**
   * `layerMask`: what masks the result when it comes back as a layer — the selection the edit changed, the outside of
   * it (a new background), or nothing (a whole-picture render such as Compose, whose mask is its own seams).
   */
  const submit = async (workflow: string, params: Record<string, string | number>, modeKey: string, model: string, promptText = '', layerMask?: 'selection' | 'inverse' | 'none') => {
    try {
      const inp = await inputFor();
      const mc = layer.current?.mask;
      const lm = layerMask ?? (params.mask ? 'selection' : 'none');
      if (lm !== 'none' && mc && !layer.current!.isEmpty()) {
        const c = document.createElement('canvas');
        c.width = mc.width;
        c.height = mc.height;
        const g = c.getContext('2d')!;
        if (lm === 'inverse') {
          g.fillStyle = '#fff';
          g.fillRect(0, 0, c.width, c.height);
          g.globalCompositeOperation = 'destination-out';
        }
        g.filter = 'blur(3px)';
        g.drawImage(mc, 0, 0);
        jobMask.current = c;
      } else jobMask.current = null;
      const j = await api.submit({
        workflow,
        params: { image_1: inp.name, seed: nextSeed(), ...params, ...(LORA_MODES.has(modeKey) && lorasNow().length ? { loras: JSON.stringify(lorasNow()) } : {}), ...(LORA_MODES.has(modeKey) ? weightsNow() : {}), ...(LORA_MODES.has(modeKey) ? qwenExtras(editModel) : {}) },
        meta: { mode: modeKey, model, prompt: promptText || item.prompt, parentId: item.id, ui: item.ui },
      });
      setJobId(j.id);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const apply = async () => {
    if (running) return;
    if (mode === 'turn' && tool !== 'crop') {
      try {
        const sid = await savedPictureId('Turn it');
        if (!sid) return;
        const j = await api.post<Job>(`/api/items/${sid}/turn`, turnMove);
        setJobId(j.id);
      } catch (e) {
        toast((e as Error).message, 'error');
      }
      return;
    }
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
      if (shape !== 'keep' && !masked && !circle) params.shape = shape;
      if (circle) {
        const name = await uploadCircled();
        if (!name) return toast('Select the object to circle first (B to paint a selection, or M, L, W, S).', 'info');
        params.image_1 = name;
      }
      return submit(wfFor('instruct'), params, 'edit:instruct', `${modelLabel} edit`, prompt.trim());
    }
    /** Fill the selection (or everything outside it): crop-and-stitch around it, at a strength. */
    const fillSelection = async (o: { text: string; remove?: boolean; invert?: boolean; denoise: number; label: string }) => {
      // Crop and stitch (Addenda Phase 3): sample only the mask's surroundings at a higher resolution, then composite
      // back. The plan comes from the painted mask (src/shared/cropstitch.ts).
      let mc = layer.current!.mask;
      if (o.invert) {
        const inv = document.createElement('canvas');
        inv.width = mc.width;
        inv.height = mc.height;
        const g = inv.getContext('2d')!;
        g.fillStyle = '#fff';
        g.fillRect(0, 0, inv.width, inv.height);
        g.globalCompositeOperation = 'destination-out';
        g.drawImage(mc, 0, 0);
        mc = inv;
      }
      const bb = maskBBox(mc.getContext('2d')!.getImageData(0, 0, mc.width, mc.height).data, mc.width, mc.height);
      if (!bb) return toast('Select the area first (B to paint a selection, or M, L, W, S).', 'info');
      const plan = planCrop(bb, mc.width, mc.height);
      const maskName = o.invert
        ? (
            await api.upload(
              await new Promise<Blob>((res, rej) => {
                const out = document.createElement('canvas');
                out.width = mc.width;
                out.height = mc.height;
                const g = out.getContext('2d')!;
                g.fillStyle = '#000';
                g.fillRect(0, 0, out.width, out.height);
                g.drawImage(mc, 0, 0);
                out.toBlob((b) => (b ? res(b) : rej(new Error('Could not export the mask'))), 'image/png');
              }),
              'mask.png',
            )
          ).name
        : await uploadMask(0);
      const params: Record<string, string | number> = {
        prompt: composeImagePrompt(T, { model: em, mode: 'inpaint', text: o.text, caption, maskShown: em === 'qwen' && !o.remove, remove: o.remove }),
        mask: maskName,
        denoise: o.denoise,
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
      return submit(wfFor('inpaint'), params, 'edit:inpaint', `${modelLabel} ${o.label}`, o.text.trim() || o.label, o.invert ? 'inverse' : 'selection');
    };
    if (mode === 'refine') {
      // a selection: redraw it at the strength; none: the whole picture, with the low-strength touch-up graph
      if (!maskEmpty) return fillSelection({ text: prompt.trim() || caption || 'the same subject, finished and detailed', denoise: refineStrength, label: 'refine' });
      const cap = prompt.trim() || (await ensureCaption(em === 'klein' ? 'klein' : 'short'));
      const plan = planEnhance(W, H);
      const params: Record<string, string | number> = {
        prompt: composeImagePrompt(T, { model: em, mode: 'enhance', text: '', caption: cap, strength: 'subtle' }),
        megapixels: plan.megapixels,
        denoise: refineStrength,
      };
      if (em === 'klein') params.schedule_steps = Math.max(4, Math.round(4 / refineStrength));
      return submit(wfFor('enhance_subtle'), params, 'edit:enhance', `${modelLabel} refine ${Math.round(refineStrength * 100)}%`, prompt.trim() || 'Refine');
    }
    if (mode === 'compose') {
      let scene = prompt.trim();
      if (renderMode === 'reimagine' && !scene) {
        toast('Describing the scene first, so the paint becomes the real thing…', 'info');
        scene = (await describeScene()) ?? '';
      }
      const plan = renderPlan(renderMode, scene);
      const params: Record<string, string | number> = { prompt: plan.prompt };
      if (plan.mask) {
        const m = docRef.current?.seamMask();
        if (!m) return toast('Blend edges needs a background layer with pieces on top of it (add pictures as layers).', 'info');
        params.mask = (await api.upload(await new Promise<Blob>((res, rej) => m.toBlob((b) => (b ? res(b) : rej(new Error('mask'))), 'image/png')), 'seams.png')).name;
        if (plan.feather) params.feather = plan.feather;
      }
      const label = RENDERS.find((x) => x.id === renderMode)!.label;
      return submit(plan.workflow, params, 'compose', `${plan.model} · ${label}`, scene || label, 'none');
    }
    if (mode === 'inpaint') {
      if (fillKind === 'background') {
        if (!prompt.trim()) return toast('Describe the new background, e.g. “a concrete loading dock at dusk”.', 'info');
        // a selection of the subject: everything outside it is redrawn
        if (!maskEmpty) return fillSelection({ text: prompt.trim(), invert: true, denoise: 1, label: 'new background' });
        // no selection: the instruction does it (Qwen keeps the subject best)
        const text = `Replace the background with ${prompt.trim().replace(/\.$/, '')}. Keep the main subject exactly as it is: same shape, colours, details and position.`;
        return submit(wfFor('instruct'), { prompt: composeImagePrompt(T, { model: em, mode: 'instruct', text }) }, 'edit:instruct', `${modelLabel} edit`, text);
      }
      if (maskEmpty) return toast('Select the area first (B to paint a selection, or M, L, W, S).', 'info');
      if (fillKind === 'remove') return fillSelection({ text: prompt.trim() || 'what is behind it, continuing the surrounding scene naturally', remove: true, denoise: 1, label: 'remove' });
      if (!prompt.trim()) return toast(fillKind === 'add' ? 'Say what to add, e.g. “a coffee cup”.' : 'Describe what should appear in the selection.', 'info');
      if (fillKind === 'add') return fillSelection({ text: `${prompt.trim().replace(/\.$/, '')}, placed naturally in the scene with its own shadow`, denoise: 1, label: 'add' });
      return fillSelection({ text: prompt, denoise: strength, label: 'fill' });
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
        const inp = await inputFor();
        const j = preScale
          ? // small source: SeedVR2 first, then the touch-up runs on its result (server chain)
            await api.submit({
              workflow: 'upscale',
              params: { image_1: inp.name, scale: preScale, seed: randomSeed() },
              meta: { mode: 'upscale', model: 'SeedVR2 7B', prompt: item.prompt, parentId: item.id, ui, chain: { kind: 'enhance', workflow, params, meta: enhanceMeta } },
            })
          : await api.submit({ workflow, params: { image_1: inp.name, seed: nextSeed(), ...params }, meta: { ...enhanceMeta, parentId: item.id } });
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
        const inp = await inputFor();
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
              params: { image_1: inp.name, prompt: l.prompt, seed: nextSeed(), output: 'darkroom/layers/qwen21' },
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
            params: { image_1: inp.name, layers: layerCount, prompt: cap ?? '', seed: nextSeed() },
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
      // with layers on (and not in the AI panel), a pasted picture is a new layer
      if (docRef.current?.isProject && panel !== 'ai') return void addFileLayers([f]);
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
      : {
          instruct: 'Apply instruction',
          inpaint: { replace: 'Fill the selection', add: 'Add to the selection', remove: 'Remove the selection', background: 'Replace the background' }[fillKind],
          outpaint: 'Extend canvas',
          refine: `Refine at ${Math.round(refineStrength * 100)}%`,
          compose: `Render · ${RENDERS.find((x) => x.id === renderMode)!.label}`,
          turn: 'Turn it',
          enhance: 'Enhance',
          remove_bg: 'Remove background',
          layers: 'Make layers',
          upscale: `Upscale ${upScale}×`,
        }[mode];

  return (
    <div className="screen" style={{ gridTemplateColumns: '68px 1fr 392px' }}>
      <nav className="panel edit-tools" aria-label="Tools">
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
              if (isCanvasTool(t.id)) return chooseCanvasTool(t.id);
              if (t.id === 'transform') return chooseTransform();
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
      </nav>

      <section
        className={`stage ${fileOver ? 'file-over' : ''}`}
        aria-label="Canvas"
        // dropping a picture file from your computer opens it (library drags keep their own targets)
        onDragOver={(e) => {
          const types = [...e.dataTransfer.types];
          if (!types.includes('Files') && !types.includes('application/x-darkroom-item')) return;
          e.preventDefault();
          setFileOver(true);
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setFileOver(false)}
        onDrop={(e) => {
          // a Library picture dragged in becomes a layer (DECISIONS 127)
          const libId = e.dataTransfer.getData('application/x-darkroom-item');
          if (libId) {
            e.preventDefault();
            setFileOver(false);
            void api.item(libId).then((r) => addItemLayer(r.item)).catch(() => toast('Could not add that picture.', 'error'));
            return;
          }
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setFileOver(false);
          // with layers on, your own files become layers; otherwise they open (as before)
          if (docRef.current?.isProject) return void addFileLayers([...e.dataTransfer.files]);
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
        {item.mode === 'edit:canvas' && typeof (item.params as any)?.project === 'string' && !running ? (
          <div className="banner" role="status">
            <span>This version was flattened from layers. The layers are still there to keep working on.</span>
            <button className="btn sm" onClick={() => go('edit', (item.params as any).project)}>
              <LayersIcon size={14} /> Open the layers
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
            cursor: tool === 'move' ? 'grab' : tool === 'brush' || tool === 'eraser' || tool === 'paint' ? 'none' : 'crosshair',
            touchAction: 'none',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setCursor(null)}
          onWheel={onWheel}
        >
          <div style={{ position: 'absolute', left: view.x, top: view.y, width: W * view.scale, height: H * view.scale, transform: rot || flipView ? `rotate(${rot}deg) scaleX(${flipView ? -1 : 1})` : undefined, transformOrigin: 'center' }}>
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
                key={item.id}
                className="develop"
                src={fileUrl(item.id)}
                alt="Picture being edited"
                draggable={false}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', userSelect: 'none', background: CHECKER, visibility: doc ? 'hidden' : undefined }}
              />
            )}
            {doc && !compare && (
              <canvas
                ref={compCanvas}
                data-testid="layers-canvas"
                width={doc.width}
                height={doc.height}
                aria-label="Layers"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', background: CHECKER, pointerEvents: 'none' }}
              />
            )}
            {tool === 'paint' && !compare && (symmetry === 'v' || symmetry === 'both') && <div className="sym-axis v" aria-hidden="true" />}
            {tool === 'paint' && !compare && (symmetry === 'h' || symmetry === 'both') && <div className="sym-axis h" aria-hidden="true" />}
            <MaskOutlineDefs />
            <canvas
              ref={viewCanvas}
              data-testid="mask-overlay"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', display: compare ? 'none' : 'block', filter: MASK_OUTLINE_FILTER }}
            />
            {tool === 'paint' && paint.engine === 'clone' && cloneSrc && !compare && (() => {
              // where the clone copies from: the spot you chose, then following the brush at the same distance
              let at = cloneSrc;
              if (cloneOff && cursor && stageRef.current) {
                const r = stageRef.current.getBoundingClientRect();
                const q = toImage({ clientX: r.left + cursor.x, clientY: r.top + cursor.y });
                at = { x: q.x + cloneOff.dx, y: q.y + cloneOff.dy };
              }
              return <div className="clone-src" aria-hidden="true" style={{ left: at.x * view.scale - 9, top: at.y * view.scale - 9 }} />;
            })()}
            {tf && tool === 'transform' && !compare && <TransformOverlay s={tf} set={setTf} W={W} H={H} scale={view.scale} toImage={toImage} />}
            {marq && tool === 'marquee' && (
              <div className={`marquee-box ${marqueeKind === 'ellipse' ? 'ellipse' : ''}`} style={{ left: marq.x * view.scale, top: marq.y * view.scale, width: marq.w * view.scale, height: marq.h * view.scale }} />
            )}
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
          {(tool === 'brush' || tool === 'eraser' || tool === 'paint') && cursor && !compare && (() => {
            const size = Math.max(4, (tool === 'paint' ? paint.size : brush) * view.scale);
            return (
              <div
                aria-hidden="true"
                className={tool === 'paint' ? 'paint-cursor' : undefined}
                style={{
                  position: 'absolute',
                  left: cursor.x - size / 2,
                  top: cursor.y - size / 2,
                  width: size,
                  height: size,
                  pointerEvents: 'none',
                  border: `1.5px solid ${tool === 'eraser' || (tool === 'paint' && paintErase) ? '#EDEBE5' : tool === 'paint' ? paint.color : '#F0B44C'}`,
                  borderRadius: '50%',
                }}
              />
            );
          })()}
          {both && (
            <div className="both-strip" role="status" aria-label="Both models">
              {(['klein', 'qwen'] as const).map((m) => (
                <span key={m} className={both.done[m] ? 'done' : ''}>
                  {both.done[m] ? <Check size={13} /> : <Loader2 size={13} className="spin" />} {m === 'klein' ? 'Klein 9B' : 'Qwen-Image 2.1'}
                </span>
              ))}
            </div>
          )}
          {running && (
            <div className="progress-overlay" style={{ zIndex: 2 }}>
              <span className="big-status">{job!.status === 'queued' ? 'Waiting in queue' : job!.stage}</span>
              <ProgressBar value={job!.progress} />
            </div>
          )}
          <div style={{ position: 'absolute', left: 12, top: 12, display: 'flex', gap: 6, zIndex: 3 }} onPointerDown={(e) => e.stopPropagation()}>
            <NewCanvasButton onCreate={(w, h, bg) => void createCanvas(w, h, bg)} />
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
            {/* Undo / Redo up here: the tool column is full (14 tools) */}
            <button className="btn sm" onClick={undo} title="Undo (Ctrl+Z)" aria-label="Undo (Ctrl+Z)">
              <Undo2 size={14} />
            </button>
            <button className="btn sm" onClick={redo} title="Redo (Ctrl+Y)" aria-label="Redo (Ctrl+Y)">
              <Redo2 size={14} />
            </button>
            <span className="view-sep" aria-hidden="true" />
            <button className="btn sm" onClick={() => setRot((r) => r - 15)} title="Turn the view left (4)" aria-label="Turn view left">
              <RotateCcw size={14} />
            </button>
            <button className="btn sm" onClick={() => setRot((r) => r + 15)} title="Turn the view right (6)" aria-label="Turn view right">
              <RotateCw size={14} />
            </button>
            <button className={`btn sm ${flipView ? 'on' : ''}`} aria-pressed={flipView} onClick={() => setFlipView((x) => !x)} title="Mirror the view (H) to check proportions. The picture is not changed." aria-label="Mirror view">
              <FlipHorizontal2 size={14} />
            </button>
            {(rot % 360 !== 0 || flipView) && (
              <button className="btn sm" onClick={() => (setRot(0), setFlipView(false))} title="Straighten the view (5)">
                Straighten
              </button>
            )}
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

        {/* the canvas tools' options: a row of their own, so they never cover the picture */}
        {tool === 'transform' && tf && !compare && <TransformBar s={tf} set={setTf} onApply={applyTf} onCancel={cancelTf} />}
        {tool === 'transform' && !tf && !compare && (
          <div className="paint-bar" role="toolbar" aria-label="Transform">
            <span className="note">Click the picture to transform the selected layer{!maskEmpty ? ' (the part inside the selection)' : ''}.</span>
          </div>
        )}
        {SEL_TOOLS.has(tool) && !compare && (
          <SelectBar
            tool={tool as 'marquee' | 'wand' | 'lasso'}
            op={selOp}
            setOp={setSelOp}
            marquee={marqueeKind}
            setMarquee={setMarqueeKind}
            wand={wandOpts}
            setWand={(w) => setWandOpts((o) => ({ ...o, ...w }))}
            amount={selPx}
            setAmount={setSelPx}
            has={!maskEmpty}
            hasLayers={!!doc}
            act={selAction}
          />
        )}
          {tool === 'paint' && !compare && (
            <PaintBar
              brushId={brushId}
              onBrush={setBrushId}
              s={paint}
              set={(patch) => setPaint((x) => ({ ...x, ...patch }))}
              c={colourState}
              erase={paintErase}
              setErase={setPaintErase}
              symmetry={symmetry}
              setSymmetry={setSymmetry}
              penFeel={penFeel}
              setPenFeel={setPenFeel}
              target={doc?.activeLayer ? { layer: doc.activeLayer.name, mask: doc.target === 'mask' } : null}
              clipped={!maskEmpty}
              onDeselect={() => selAction('none')}
              clone={{ set: !!cloneSrc, merged: cloneMerged, setMerged: setCloneMerged }}
            />
          )}
          {tool === 'fill' && !compare && (
            <FillBar
              c={colourState}
              tolerance={fillOpts.tolerance}
              setTolerance={(v) => setFillOpts((o) => ({ ...o, tolerance: v }))}
              contiguous={fillOpts.contiguous}
              setContiguous={(v) => setFillOpts((o) => ({ ...o, contiguous: v }))}
              merged={fillOpts.merged}
              setMerged={(v) => setFillOpts((o) => ({ ...o, merged: v }))}
              opacity={fillOpts.opacity}
              setOpacity={(v) => setFillOpts((o) => ({ ...o, opacity: v }))}
            />
          )}
          {tool === 'shape' && !compare && (
            <ShapeBar
              c={colourState}
              kind={shapeOpts.kind}
              setKind={(k) => setShapeOpts((o) => ({ ...o, kind: k }))}
              filled={shapeOpts.filled}
              setFilled={(v) => setShapeOpts((o) => ({ ...o, filled: v }))}
              size={shapeOpts.size}
              setSize={(v) => setShapeOpts((o) => ({ ...o, size: v }))}
              opacity={shapeOpts.opacity}
              setOpacity={(v) => setShapeOpts((o) => ({ ...o, opacity: v }))}
            />
          )}
        <div className="filmstrip-bar">
          <span className="section-label" style={{ margin: 0 }}>
            Versions
          </span>
          <div className="filmstrip" role="group" aria-label="Versions">
            {/* the pictures of one Layers run share a version: one frame for the group (walk-through 2026-10-04) */}
            {lineage.filter((v) => !v.group_id || groupFrame.get(v.group_id) === v.id).map((v) => (
              <button
                key={v.id}
                className="btn sm film-frame"
                aria-pressed={v.id === item.id}
                style={{ padding: 3, gap: 6 }}
                onClick={() => go('edit', v.id)}
                title={`${v.title ? `${v.title} · ` : ''}${v.mode} · ${v.model}`}
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
      {bothPick && (
        <div className="compare-overlay" role="dialog" aria-label="Both models">
          <div className="compare-bar">
            <strong>Klein 9B or Qwen-Image 2.1?</strong>
            <span className="muted">{prompt.trim().slice(0, 90)}</span>
            <div style={{ flex: 1 }} />
            <button className="btn sm" onClick={() => void keepFromBoth('both')}>
              Keep both
            </button>
          </div>
          <div className="compare-side">
            {(['klein', 'qwen'] as const).map((m) => (
              <figure key={m}>
                <img src={fileUrl(bothPick[m].id)} alt={m === 'klein' ? 'Klein 9B' : 'Qwen-Image 2.1'} />
                <figcaption>
                  <button className="btn primary" onClick={() => void keepFromBoth(m)}>
                    Keep {m === 'klein' ? 'Klein 9B' : 'Qwen-Image 2.1'}
                  </button>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}

      <aside className="panel right" aria-label="Edit settings">
        <div className="panel-scroll">
          <div className="readout">
            <b>v{item.version}</b>
            <span>
              {W}×{H}
            </span>
            <span title="The model that made the version you are looking at">made with {item.model}</span>
          </div>
          <div className="segmented panel-tabs" role="tablist" aria-label="Edit panels">
            <button type="button" role="tab" aria-selected={panel === 'ai'} aria-pressed={panel === 'ai'} onClick={() => setPanel('ai')}>
              <Wand2 size={14} /> AI
            </button>
            <button type="button" role="tab" aria-selected={panel === 'layers'} aria-pressed={panel === 'layers'} onClick={() => setPanel('layers')}>
              <LayersIcon size={14} /> Layers {doc && doc.layers.length > 1 ? <span className="mono">{doc.layers.length}</span> : null}
            </button>
            <button type="button" role="tab" aria-selected={panel === 'adjust'} aria-pressed={panel === 'adjust'} onClick={() => setPanel('adjust')}>
              <SlidersHorizontal size={14} /> Adjust
            </button>
          </div>
          {panel === 'adjust' ? (
            <div className="canvas-layers">
              {adjLayer && doc ? (
                <>
                  <div className="layers-head">
                    <p className="section-label" style={{ margin: 0 }}>
                      {adjLayer.name} <span className="mono">adjustment</span>
                    </p>
                    <span className={`save-state ${saveState}`} role="status" aria-label="Layers saved">
                      {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved' : saveState === 'unsaved' ? 'Unsaved' : ''}
                    </span>
                  </div>
                  <AdjustPanel adjust={adjLayer.adjust ?? {}} hist={hist ?? undefined} onChange={(p, label, key) => doc.setAdjust(adjLayer.id, p, label, key)} />
                  <p className="note">
                    Changes everything below this layer; the pixels stay as they are. To limit it to part of the picture, give it a mask (Layers › Add mask, or Mask from selection) and paint on the mask. Lower its opacity to soften it.
                  </p>
                </>
              ) : (
                <>
                  <p className="section-label">Adjust</p>
                  <p className="note" style={{ marginTop: 0 }}>
                    An adjustment layer changes the light and colour of everything below it: exposure, levels, curves, colour, black &amp; white, split tone and grain. The picture itself stays untouched, and you can change the adjustment again at any time.
                  </p>
                  <button
                    className="btn"
                    onClick={async () => {
                      const d = await ensureDoc();
                      d?.addAdjustLayer();
                    }}
                  >
                    <SlidersHorizontal size={15} /> New adjustment layer
                  </button>
                  <p className="section-label" style={{ marginTop: 6 }}>
                    Or start from a look
                  </p>
                  <div className="looks" role="group" aria-label="Start from a look">
                    {LOOKS.map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        className="pill"
                        onClick={async () => {
                          const d = await ensureDoc();
                          d?.addAdjustLayer(l.adjust, l.label);
                        }}
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                  {doc?.layers.some((l) => l.kind === 'adjust') && <p className="note">To change an adjustment layer, select it in Layers.</p>}
                </>
              )}
            </div>
          ) : panel === 'layers' ? (
            <CanvasLayers
              doc={doc}
              version={docVer}
              starting={docStarting}
              onStart={() => void ensureDoc()}
              lineage={lineage}
              itemId={item.id}
              onAddItem={(it) => void addItemLayer(it)}
              onMaskFromSelection={(id) => layer.current && docRef.current?.addMask(id, layer.current.mask, 'Mask from selection')}
              hasSelection={!maskEmpty}
              onFlatten={() => void flattenToVersion()}
              flattening={flattening}
              onExport={() => void exportPng()}
              onUndoTo={undoDocSteps}
              saveState={saveState}
              onOpenAdjust={() => setPanel('adjust')}
              onCutOut={(id) => void cutOutLayer(id)}
              cutting={cutting}
            />
          ) : (
          <>
          <div>
            <p className="section-label">Mode</p>
            <div className="mode-groups" role="group" aria-label="Edit mode">
              {(['canvas', 'more'] as const).map((grp) => (
                <div key={grp} className="pills">
                  <span className="mode-group-label">{grp === 'canvas' ? 'On the canvas' : 'More'}</span>
                  {MODES.filter((m) => m.group === grp).map((m) => (
                    <button
                      key={m.id}
                      className="pill accent"
                      aria-pressed={mode === m.id}
                      title={m.tip}
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
              ))}
            </div>
          </div>

          {(mode === 'instruct' || mode === 'inpaint' || mode === 'outpaint' || mode === 'enhance' || mode === 'refine') && boot && (
            <div>
              <p className="section-label">Model</p>
              <div className="cards" role="group" aria-label="Edit model">
                {Object.entries(boot.manifest.models).map(([key, mm]) => (
                  <button key={key} type="button" className="card" aria-pressed={editModel === key} onClick={() => setEditModel(key)} title={mm.licence}>
                    <strong>{mm.label}</strong>
                    {/* what each is best at, from the 2026-10-03 test suite (audit #2) */}
                    <small>{key === 'klein' ? 'Styles, materials · ~15 s' : (qwenFast ? 'Exact shapes · Fast ~10 s' : 'Exact shapes · ~25 s')}</small>
                  </button>
                ))}
              </div>
            </div>
          )}

          {mode === 'inpaint' && (
            <div className="segmented" role="group" aria-label="Fill">
              {(
                [
                  ['replace', 'Replace', 'Paint new content into the selection'],
                  ['add', 'Add', 'Put something new into the selection, fitted into the scene'],
                  ['remove', 'Remove', 'Take away what is in the selection; the surroundings fill in'],
                  ['background', 'Background', 'Keep the selected subject, replace everything else (or, with no selection, the background)'],
                ] as [FillKind, string, string][]
              ).map(([k, l, t]) => (
                <button key={k} type="button" aria-pressed={fillKind === k} title={t} onClick={() => setFillKind(k)}>
                  {l}
                </button>
              ))}
            </div>
          )}
          {mode === 'compose' && (
            <div className="compose-panel">
              <p className="section-label">
                Render <span className="mono">{composeMode === 'auto' ? `auto · ${composeAuto.why}` : ''}</span>
              </p>
              <div className="cards" role="group" aria-label="Render mode">
                {RENDERS.map((m) => (
                  <button key={m.id} type="button" className="card" aria-pressed={renderMode === m.id} title={m.text} onClick={() => setComposeMode(composeMode === m.id ? 'auto' : m.id)}>
                    <strong>{m.label}</strong>
                    <small>{composeMode === 'auto' && composeAuto.mode === m.id ? 'Suggested' : m.model}</small>
                  </button>
                ))}
              </div>
              <p className="note">
                {RENDERS.find((m) => m.id === renderMode)!.text} {doc ? '' : 'Tip: build the scene in Layers first (a background, pictures placed on it, paint), or start a New canvas.'}
              </p>
            </div>
          )}
          {(mode === 'instruct' || (mode === 'inpaint' && fillKind !== 'remove') || mode === 'outpaint' || mode === 'refine' || mode === 'compose') && (
            <label className="field">
              <span>
                {mode === 'instruct'
                  ? 'Instruction'
                  : mode === 'inpaint'
                    ? { replace: 'What should fill the selection?', add: 'What to add?', remove: '', background: 'The new background' }[fillKind]
                    : mode === 'refine'
                      ? 'What it should look like (optional)'
                      : mode === 'compose'
                        ? 'Scene (optional)'
                        : 'Describe the surroundings (optional)'}
              </span>
              <textarea
                ref={promptBox}
                className="input"
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={
                  mode === 'instruct'
                    ? 'e.g. Replace the sky with a stormy sunset. Keep everything else unchanged.'
                    : mode === 'inpaint'
                      ? { replace: 'e.g. a stack of old books', add: 'e.g. a coffee cup', remove: '', background: 'e.g. a concrete loading dock at dusk' }[fillKind]
                      : mode === 'refine'
                        ? 'e.g. a leather sneaker, studio photo — or leave empty to keep the subject and finish it'
                        : mode === 'compose'
                          ? 'e.g. a runner on a wet city street at dawn'
                          : 'e.g. a wide misty lake with pine trees'
                }
              />
            </label>
          )}
          {mode === 'refine' && (
            <div>
              <label className="field" title="How much the AI may change: low keeps your picture and paintover and finishes them, high redraws more freely">
                <span>
                  Strength <b className="mono">{Math.round(refineStrength * 100)}%</b>
                </span>
                <input type="range" min={10} max={90} step={5} value={Math.round(refineStrength * 100)} aria-label="Refine strength" onChange={(e) => setRefineStrength(Number(e.target.value) / 100)} />
              </label>
              <p className="note">
                {maskEmpty ? 'The whole picture is redrawn at this strength.' : 'Only the selection is redrawn at this strength.'} About 25–40% keeps the shapes and colours of a paintover and makes them real; 60% and up reinterprets them.
              </p>
              {maskEmpty && isBig(W, H) && (
                <p className="note warn">
                  Large picture ({W}×{H}): the whole-picture Refine works at about 2 MP, so its layer is enlarged back and fine detail softens. Select the part to refine to keep full detail, or Upscale afterwards.
                </p>
              )}
            </div>
          )}
          {mode === 'compose' && (
            <div className="field-row" style={{ gap: 6 }}>
              <button type="button" className="btn sm ghost" disabled={describing || !online} onClick={() => void describeScene()} title="The local vision model reads the canvas as a plan for a real photo and writes the scene">
                {describing ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Describe the scene
              </button>
            </div>
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
                <button
                  className="btn sm ghost"
                  disabled={!prompt.trim() || running || !!both || !online || circled}
                  title="Run this instruction on Klein 9B and Qwen-Image 2.1 at once (same seed), then keep the one you like"
                  onClick={() => void tryBoth()}
                >
                  <Columns2 size={14} /> Try both models
                </button>
                {instrUndo !== null && (
                  <button className="btn sm ghost" onClick={() => (setPrompt(instrUndo), setInstrUndo(null))}>
                    Undo
                  </button>
                )}
              </div>
            </>
          )}

          {mode === 'instruct' && slotOf() && (
            <div className="sheet-maker">
              <p className="section-label">
                Sheet <span className="mono">{sheetValues.length ? `${sheetValues.length} pictures` : ''}</span>
              </p>
              <label className="field">
                <span>One {slotOf()![1].toLowerCase()} per line — each becomes its own picture, then one labelled sheet</span>
                <textarea className="input" rows={4} value={sheetLines} onChange={(e) => setSheetLines(e.target.value)} placeholder={'e.g.\nblack with a volt-green sole\nnavy with a red heel\nsand and terracotta'} aria-label="Sheet values" />
              </label>
              <button type="button" className="btn sm" style={{ marginTop: 6 }} disabled={sheetValues.length < 2 || running || !online} onClick={() => void makeSheet()}>
                <LayoutGrid size={14} /> Make a sheet of {sheetValues.length || '…'}
              </button>
            </div>
          )}
          {mode === 'instruct' && (
            <div>
              <p className="section-label">Shape</p>
              <div className="pills" role="group" aria-label="Result shape">
                {(['keep', ...SHAPES] as const).map((x) => (
                  <button key={x} type="button" className="pill accent" aria-pressed={shape === x} disabled={x !== 'keep' && !maskEmpty && onlyMasked} onClick={() => setShape(x)}>
                    {x === 'keep' ? 'Keep' : x}
                  </button>
                ))}
              </div>
              {shape !== 'keep' && (
                <p className="note" style={{ marginTop: 6 }}>
                  The picture is redrawn to fill a {shape} frame: the model may add to the sides or the top and bottom to make it fit.
                  {!maskEmpty && onlyMasked ? ' Not with “Only change the selection”.' : ''}
                </p>
              )}
            </div>
          )}
          {/* Instruct changes the whole picture until you paint: the mask settings appear with the first stroke (audit #2) */}
          {mode === 'instruct' && maskEmpty && (
            <p className="note mask-hint">
              To change only part of the picture, select it first: paint it (B), or use the marquee (M), lasso (L), wand (W) or Smart select (S).
            </p>
          )}
          {((mode === 'inpaint' && fillKind !== 'background') || (mode === 'instruct' && !maskEmpty) || (mode === 'refine' && !maskEmpty)) && (
            <div>
              <p className="section-label">
                Selection <span className="mono">{maskEmpty ? 'none' : 'made'}</span>
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
              {mode === 'inpaint' && fillKind === 'replace' && (
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
                B paints the selection · E erases it · M marquee · L lasso · W wand · S smart select · Shift adds, Alt takes away · [ ] size · V or the middle button pans · wheel zooms
              </p>
              {mode === 'instruct' && (
                <>
                  <label className="check">
                    <input type="checkbox" checked={onlyMasked && !(circled && editModel === 'qwen')} onChange={(e) => setOnlyMasked(e.target.checked)} disabled={maskEmpty || (circled && editModel === 'qwen')} />
                    Only change the selection {maskEmpty && <span className="muted">(select an area first)</span>}
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
              <p className="note" style={{ marginTop: 4 }}>
                Outpaint adds new space around the picture and leaves the picture itself as it is. To change its background, use Instruct (e.g. “Replace the background with a city street at night”).
              </p>
            </div>
          )}

          {(mode === 'instruct' || mode === 'inpaint' || mode === 'outpaint') && (
            <div>
              <p className="section-label">Reference (optional)</p>
              <RefSlot name={ref?.name ?? null} onFile={(f) => addRef(f)} onItem={(itemId) => addRef(undefined, itemId)} onClear={() => setRef(null)} />
            </div>
          )}

          {/* set once, not every time: Seed, LoRAs and the Klein version (audit #2) */}
          {(mode === 'instruct' || mode === 'inpaint' || mode === 'outpaint' || mode === 'enhance') && boot && (
            <details className="adv edit-adv" open={advOpen} onToggle={(e) => setAdvOpen((e.currentTarget as HTMLDetailsElement).open)}>
              <summary>
                <ChevronRight size={14} /> Advanced
                <span className="muted adv-summary">
                  {[editModel === 'qwen' && qwenFast ? 'Fast' : '', editSeed.locked ? `seed ${editSeed.seed} locked` : '', (editLoras[editModel] ?? []).length ? `${(editLoras[editModel] ?? []).length} LoRA` : ''].filter(Boolean).join(' · ')}
                </span>
              </summary>
              {editModel === 'qwen' && (
                <div>
                  <label className="check" title="Turbo8 LoRA: 8 steps instead of 25, about 2.5× faster. As good on product edits; a little looser on painterly restyles.">
                    <input type="checkbox" checked={qwenFast} onChange={(e) => setQwenFast(e.target.checked)} />
                    Fast — 8 steps (~10 s)
                  </label>
                  <label className="check" title="Consistency LoRA: a whole-picture instruction stays on the picture's frame instead of drifting (a restyle moved 11 px without it, 0 with it). Not used by Turn it or a new Shape.">
                    <input type="checkbox" checked={keepFrame} onChange={(e) => setKeepFrame(e.target.checked)} />
                    Keep edits on the frame
                  </label>
                </div>
              )}
              {editModel === 'klein' && <KleinWeights value={kleinWeights} onChange={setKleinWeights} />}
              {(editModel === 'klein' || editModel === 'qwen') && (
                <div style={{ marginTop: 4 }}>
                  <LoraPicker family={editModel} value={editLoras[editModel] ?? []} onChange={(v) => setEditLoras((prev) => ({ ...prev, [editModel]: v }))} />
                </div>
              )}
              <label className="field" style={{ marginTop: 12 }}>
                <span>Seed</span>
                <div className="field-row">
                  <input className="input mono" inputMode="numeric" value={editSeed.seed} onChange={(e) => setEditSeed({ seed: Number(e.target.value.replace(/\D/g, '')) || 0, locked: true })} aria-label="Seed" />
                  <button type="button" className={`btn icon ${editSeed.locked ? 'on' : ''}`} aria-pressed={editSeed.locked} title={editSeed.locked ? 'Seed locked — every run reuses it' : 'Seed unlocked — a new seed every run'} onClick={() => setEditSeed((x) => ({ ...x, locked: !x.locked }))}>
                    {editSeed.locked ? <Lock size={16} /> : <Unlock size={16} />}
                  </button>
                  <button type="button" className="btn icon" title="New random seed" onClick={() => setEditSeed((x) => ({ ...x, seed: randomSeed() }))}>
                    <Shuffle size={16} />
                  </button>
                </div>
              </label>
            </details>
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
                  : 'Redraws the picture from itself as an edit: fixes motion blur, lens blur, noise and low resolution while keeping the composition, faces and colours. It treats haze, fog and soft focus as damage too: for a clean picture with that mood, use Upscale instead.'}
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
              {layersState.rows.length > 0 && (
                <button
                  type="button"
                  className="btn sm"
                  style={{ marginTop: 8 }}
                  title="Put these layers on the canvas to paint, mask and blend them"
                  onClick={async () => {
                    for (const r of [...layersState.rows].reverse().filter((x) => x.visible)) {
                      const it = layersState.items[r.id];
                      if (it) await addItemLayer(it, 'picture', r.name, 'top');
                    }
                  }}
                >
                  <LayersIcon size={14} /> Open as canvas layers
                </button>
              )}
            </div>
          )}
          {mode === 'turn' && (
            <div className="turn-panel">
              <p className="section-label">Turn the camera</p>
              <div className="pills" role="group" aria-label="Turn angle">
                {([45, 90, 135, 180, 0] as OrbitAngle[]).map((a) => (
                  <button key={a} type="button" className="pill accent" aria-pressed={turnMove.angle === a} onClick={() => setTurnMove((m) => ({ ...m, angle: a, height: a === 0 && m.height === 'eye' ? 'elevated' : m.height }))}>
                    {a === 0 ? 'Height only' : `${a}°`}
                  </button>
                ))}
              </div>
              {turnMove.angle !== 0 && turnMove.angle !== 180 && (
                <div className="segmented" role="group" aria-label="Turn direction" style={{ marginTop: 8 }}>
                  {(['left', 'right'] as OrbitSide[]).map((d) => (
                    <button key={d} type="button" aria-pressed={turnMove.side === d} onClick={() => setTurnMove((m) => ({ ...m, side: d }))}>
                      {d === 'left' ? 'To the left' : 'To the right'}
                    </button>
                  ))}
                </div>
              )}
              <div className="segmented" role="group" aria-label="Camera height" style={{ marginTop: 8 }}>
                {(['low', 'eye', 'elevated'] as OrbitHeight[]).map((h) => (
                  <button key={h} type="button" aria-pressed={turnMove.height === h} disabled={turnMove.angle === 0 && h === 'eye'} onClick={() => setTurnMove((m) => ({ ...m, height: h }))}>
                    {h === 'low' ? 'Low' : h === 'eye' ? 'Eye level' : 'From above'}
                  </button>
                ))}
              </div>
              <p className="note" style={{ marginTop: 8 }}>
                {orbitLabel(turnMove)}. Qwen-Image 2.1 with the viewpoint-orbit LoRA draws the same object from there. It works on a cut-out: a picture with a background is cut out first. Best on products, garments and shoes; 90° has to invent the hidden side.
              </p>
              {orbitReady === false && <p className="note warn">The viewpoint-orbit LoRA is not in your ComfyUI loras folder, so Turn it cannot run.</p>}
              <button type="button" className="btn" style={{ marginTop: 8 }} disabled={!online || running || orbitReady === false} onClick={() => void turnaround()} title="Three turns (90° right, 180°, 90° left) and one sheet of all four sides in the Library">
                <RotateCw size={15} /> Make a turnaround (4 sides)
              </button>
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
          <p className="note">
            {doc?.isProject ? 'Layers are on: the AI works on the merged layers, and a result that fits comes back as a new layer (and a version).' : 'Every apply saves a new version; nothing is overwritten.'}
          </p>
          </>
          )}
        </div>
        {panel === 'ai' && (
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
            {doc?.isProject ? (
              <button className="btn sm" style={{ flex: 1 }} onClick={() => void exportPng()} title="The merged layers as a PNG">
                <Download size={14} /> Download
              </button>
            ) : (
              <a className="btn sm" href={downloadUrl(item.id)} download style={{ flex: 1 }}>
                <Download size={14} /> Download
              </a>
            )}
            <button
              className="btn sm"
              style={{ flex: 1 }}
              onClick={async () => {
                const sid = await savedPictureId('the video');
                if (sid) go('video', undefined, { start: sid });
              }}
            >
              <Film size={14} /> Animate
            </button>
          </div>
        </div>
        )}
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
    <div className="screen" style={{ placeItems: 'start center', overflowY: 'auto' }}>
      <div className="empty" style={{ maxWidth: 760, margin: '32px auto' }}>
        <h2>Open a picture to edit, or start a canvas</h2>
        <p>Drop an image here, paste one (Ctrl+V), pick a recent result, or start from a blank canvas to paint or build a scene. Edits are always saved as new versions.</p>
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
        <div className="field-row" style={{ gap: 8, justifyContent: 'center' }}>
          <NewCanvasButton label="Start from a blank canvas" onCreate={(w, h, bg) => void createCanvas(w, h, bg)} />
        </div>
        <p className="note scene-steps">
          To build a scene: a canvas (or a picture as the background) · Layers › Picture… to add pieces · the scissors to cut them out · Transform (T) to place them · paint · AI › Compose to render one picture.
        </p>
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
        <OldCompositions />
      </div>
    </div>
  );
}
