import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Brush,
  Eraser,
  Eye,
  EyeOff,
  FlipHorizontal2,
  ImagePlus,
  Loader2,
  Maximize,
  MousePointer2,
  Paintbrush,
  Plus,
  Redo2,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react';
import { api, fileUrl, inputUrl, thumbUrl, type Item, type Job } from '../api';
import { Pills, ProgressBar, randomSeed, useHotkey } from '../components/common';
import { LibraryPicker } from '../components/LibraryPicker';
import { importFailedMessage, importPictures, waitForItem } from '../lib/importer';
import { alphaBox, flatten, layerUrl, loadImg, makeCanvas, paintCoverage, PAPER, seamMask, toBlob, hitsLayer, backgroundIndex } from '../lib/composeCanvas';
import { go } from '../router';
import { onJob, toast, useApp } from '../store';
import { ASPECTS, autoMode, canvasKey, canvasSizeFor, coverLayer, emptyDoc, isDescribedText, MODES, placeLayer, renderPlan, type ComposeDoc, type ComposeLayer, type Composition, type RenderMode } from '../../shared/compose';

type Tool = 'move' | 'brush' | 'eraser';
const SWATCHES = ['#1d1d1b', '#ffffff', '#b8352b', '#e5892f', '#ffd23f', '#5fae4f', '#2f7d32', '#7fb8e8', '#2b5aa8', '#8a5a3b', '#a89c86', '#d58fb0'];
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const SECONDS: Record<RenderMode, number> = { blend: 30, harmonise: 30, reimagine: 20 };

export function Compose({ id }: { id?: string }) {
  return id ? <ComposeEditor key={id} id={id} /> : <ComposeStart />;
}

/** Create a composition on the server and open it. */
async function createComposition(doc: ComposeDoc, name?: string): Promise<void> {
  const id = crypto.randomUUID();
  if (!name) {
    const taken = new Set((await api.get<{ name: string }[]>('/api/compositions')).map((c) => c.name));
    let n = 1;
    while (taken.has(`Composition ${n}`)) n++;
    name = `Composition ${n}`;
  }
  await api.put(`/api/compositions/${id}`, { name, doc });
  go('compose', id);
}

/** Picture layer for a library item, at its file's real size. */
async function pictureFor(item: Pick<Item, 'id' | 'prompt'>): Promise<{ layer: Omit<ComposeLayer, 'x' | 'y' | 'w' | 'h'>; w: number; h: number }> {
  const inp = await api.asInput(item.id);
  let w = inp.width ?? 0;
  let h = inp.height ?? 0;
  if (!w || !h) {
    const img = await loadImg(inputUrl(inp.name));
    w = img.naturalWidth;
    h = img.naturalHeight;
  }
  const name = (item.prompt || 'Picture').replace(/\s+/g, ' ').slice(0, 40);
  return { layer: { id: uid(), kind: 'picture', name, src: inp.name, itemId: item.id, cutout: false }, w, h };
}

// ---------------------------------------------------------------------------------------------------------------
// Start: new composition, or one of the saved ones

function ComposeStart() {
  const [list, setList] = useState<Omit<Composition, 'doc'>[] | null>(null);
  const [aspect, setAspect] = useState(ASPECTS[0].label);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const online = useApp((s) => s.status?.comfy === 'online');
  const upload = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api
      .get<Omit<Composition, 'doc'>[]>('/api/compositions')
      .then(setList)
      .catch(() => setList([]));
  }, []);
  useEffect(load, [load]);

  const blank = () => {
    const a = ASPECTS.find((x) => x.label === aspect)!;
    void createComposition(emptyDoc(a.w, a.h)).catch((e) => toast((e as Error).message, 'error'));
  };
  const fromItem = async (item: Pick<Item, 'id' | 'prompt'>) => {
    setBusy(true);
    try {
      const p = await pictureFor(item);
      const { width, height } = canvasSizeFor(p.w, p.h);
      const doc = emptyDoc(width, height);
      doc.layers.push({ ...p.layer, name: 'Background', ...coverLayer(p.w, p.h, width, height) });
      await createComposition(doc);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const fromFile = async (files: File[]) => {
    if (!online) return toast('Start ComfyUI first (top right): your picture is saved into the Library through it.', 'info');
    setBusy(true);
    const { ids, failed } = await importPictures(files.slice(0, 1));
    setBusy(false);
    if (failed.length) toast(importFailedMessage(failed), 'error', 12000);
    if (ids[0]) await fromItem({ id: ids[0], prompt: 'Background' });
  };
  const remove = async (c: Omit<Composition, 'doc'>) => {
    await api.post(`/api/compositions/${c.id}/delete`);
    load();
    toast(`"${c.name}" deleted.`, 'info', 8000, {
      label: 'Undo',
      run: () => void api.post(`/api/compositions/${c.id}/restore`).then(load),
    });
  };

  return (
    <div className="screen home" style={{ gridTemplateColumns: '1fr', overflowY: 'auto' }}>
      <div className="home-inner">
        <h1 className="home-title">Compose</h1>
        <p className="note" style={{ fontSize: 14, maxWidth: 720, marginTop: -8 }}>
          Arrange pictures, cut-outs and rough paint on a canvas, then let Darkroom turn the collage into one coherent picture.
        </p>
        <div className="compose-new">
          <section className="compose-new-card" aria-label="Blank canvas">
            <h2>Blank canvas</h2>
            <Pills label="Canvas shape" options={ASPECTS.map((a) => ({ value: a.label, label: a.label }))} value={aspect} onChange={setAspect} />
            <button className="btn primary" onClick={blank}>
              <Plus size={16} /> New composition
            </button>
          </section>
          <section className="compose-new-card" aria-label="Start from a picture">
            <h2>Start from a picture</h2>
            <p className="note">It becomes the background; the canvas takes its shape.</p>
            <div className="compose-row" style={{ gap: 8 }}>
              <button className="btn" onClick={() => setPicking(true)} disabled={busy}>
                <ImagePlus size={16} /> From Library
              </button>
              <button className="btn" onClick={() => upload.current?.click()} disabled={busy}>
                <Upload size={16} /> Upload
              </button>
              {busy && <Loader2 size={16} className="spin" aria-label="Working" />}
            </div>
            <input ref={upload} type="file" accept="image/*" hidden aria-label="Upload a background picture" onChange={(e) => (void fromFile([...(e.target.files ?? [])]), (e.target.value = ''))} />
          </section>
        </div>

        <h2 className="section-label" style={{ marginTop: 28 }}>
          Your compositions {list && <span className="mono">{list.length}</span>}
        </h2>
        {list === null ? (
          <p className="note">Loading…</p>
        ) : !list.length ? (
          <p className="note">Nothing saved yet. Compositions save themselves as you work.</p>
        ) : (
          <div className="compose-list" role="list">
            {list.map((c) => (
              <div key={c.id} className="compose-item" role="listitem">
                <button className="compose-thumb" onClick={() => go('compose', c.id)} aria-label={`Open ${c.name}`}>
                  {c.thumb ? <img src={c.thumb} alt="" /> : <span className="note">No preview</span>}
                </button>
                <div className="compose-row" style={{ justifyContent: 'space-between', gap: 6 }}>
                  <span className="compose-name" title={c.name}>
                    {c.name}
                    <small className="note">{new Date(c.updated_at).toLocaleString()}</small>
                  </span>
                  <button className="btn ghost sm icon" onClick={() => void remove(c)} aria-label={`Delete ${c.name}`} title="Delete composition (your pictures stay in the Library)">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {picking && <LibraryPicker title="Start from a picture" onClose={() => setPicking(false)} onPick={(it) => (setPicking(false), void fromItem(it))} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Editor

type Drag =
  | { kind: 'move'; id: string; sx: number; sy: number; ox: number; oy: number; before: ComposeDoc }
  | { kind: 'scale'; id: string; ax: number; ay: number; w0: number; h0: number; before: ComposeDoc }
  | { kind: 'paint'; id: string | null; erase: boolean; picture?: boolean; last: { x: number; y: number }; before: ComposeDoc };

function ComposeEditor({ id }: { id: string }) {
  const [name, setName] = useState('');
  const [doc, setDocState] = useState<ComposeDoc | null>(null);
  const [missing, setMissing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('move');
  const [colour, setColour] = useState(SWATCHES[2]);
  const [size, setSize] = useState(40);
  const [scale, setScale] = useState(0.5);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [saved, setSaved] = useState<'saved' | 'saving' | 'error'>('saved');
  const [coverage, setCoverage] = useState(0);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [view, setView] = useState<string | null>(null);
  const [busyLayer, setBusyLayer] = useState<string | null>(null);
  /** Erasing a picture: it is drawn on a working canvas at full resolution (shown in its place) until saved. */
  const [erasingId, setErasingId] = useState<string | null>(null);
  const eraseWork = useRef<{ id: string; canvas: HTMLCanvasElement } | null>(null);
  const [picking, setPicking] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [fileOver, setFileOver] = useState(false);
  const jobs = useApp((s) => s.jobs);
  const previews = useApp((s) => s.previews);
  const online = useApp((s) => s.status?.comfy === 'online');

  const docRef = useRef<ComposeDoc | null>(null);
  docRef.current = doc;
  const past = useRef<ComposeDoc[]>([]);
  const future = useRef<ComposeDoc[]>([]);
  const paintEls = useRef(new Map<string, HTMLCanvasElement>());
  const stroke = useRef<HTMLCanvasElement>(null);
  const stageBox = useRef<HTMLDivElement>(null);
  const canvasEl = useRef<HTMLDivElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const loaded = useRef(false);
  const savedKey = useRef('');
  const paint = useCallback((lid: string) => paintEls.current.get(lid), []);

  // ---- load and save
  useEffect(() => {
    api
      .get<Composition>(`/api/compositions/${id}`)
      .then((c) => {
        savedKey.current = JSON.stringify([c.name, c.doc]);
        setName(c.name);
        setDocState(c.doc);
        loaded.current = true;
      })
      .catch(() => setMissing(true));
  }, [id]);

  useEffect(() => {
    if (!doc || !loaded.current) return;
    // opening (or undoing back to what is saved) doesn't save again, so it doesn't move up the list
    const key = JSON.stringify([name, doc]);
    if (key === savedKey.current) return setSaved('saved');
    setSaved('saving');
    const t = setTimeout(async () => {
      try {
        const small = await flatten(doc, paint, 360 / Math.max(doc.width, doc.height)).catch(() => null);
        await api.put(`/api/compositions/${id}`, { name, doc, thumb: small?.toDataURL('image/jpeg', 0.75) });
        savedKey.current = key;
        setSaved('saved');
      } catch {
        setSaved('error');
      }
    }, 700);
    return () => clearTimeout(t);
  }, [doc, name, id, paint]);

  // ---- history
  /** Change the document; `before` (default: the current one) goes on the undo stack. */
  const commit = useCallback((next: ComposeDoc, before: ComposeDoc | null = docRef.current) => {
    if (before) past.current = [...past.current.slice(-49), before];
    future.current = [];
    setDocState(next);
  }, []);
  const update = (fn: (d: ComposeDoc) => ComposeDoc) => docRef.current && commit(fn(docRef.current));
  const setLayer = (lid: string, patch: Partial<ComposeLayer>) => update((d) => ({ ...d, layers: d.layers.map((l) => (l.id === lid ? { ...l, ...patch } : l)) }));
  const undo = () => {
    const prev = past.current.pop();
    if (!prev || !docRef.current) return;
    future.current.push(docRef.current);
    setDocState(prev);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next || !docRef.current) return;
    past.current.push(docRef.current);
    setDocState(next);
  };

  // ---- fit the canvas into the stage
  useLayoutEffect(() => {
    const el = stageBox.current;
    if (!el || !doc) return;
    const fit = () => setScale(Math.max(0.05, Math.min((el.clientWidth - 48) / doc.width, (el.clientHeight - 48) / doc.height)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc?.width, doc?.height, !!doc, view]);

  // ---- how much is painted (for the suggested mode)
  useEffect(() => {
    if (!doc) return;
    const t = setTimeout(() => void paintCoverage(doc, paint).then(setCoverage), 250);
    return () => clearTimeout(t);
  }, [doc, paint]);

  // ---- renders finishing
  const jobIdsRef = useRef<string[]>([]);
  jobIdsRef.current = jobIds;
  useEffect(
    () =>
      onJob((j) => {
        if (!jobIdsRef.current.includes(j.id)) return;
        if (j.status === 'done' && j.result_ids.length) {
          setDocState((d) => (d ? { ...d, renders: [...j.result_ids, ...(d.renders ?? []).filter((r) => !j.result_ids.includes(r))] } : d));
          setView(j.result_ids[0]);
          setJobIds((ids) => ids.filter((x) => x !== j.id));
        } else if (j.status === 'error' || j.status === 'lost') {
          toast(`Render failed: ${j.error ?? 'unknown error'}`, 'error');
          setJobIds((ids) => ids.filter((x) => x !== j.id));
        } else if (j.status === 'cancelled') setJobIds((ids) => ids.filter((x) => x !== j.id));
      }),
    [],
  );

  // ---- adding pieces
  const addPicture = async (item: Pick<Item, 'id' | 'prompt'>) => {
    try {
      const p = await pictureFor(item);
      const d = docRef.current!;
      const first = !d.layers.length;
      // the first picture on a blank canvas becomes the background and gives the canvas its shape
      const size = first ? canvasSizeFor(p.w, p.h) : { width: d.width, height: d.height };
      const box = first ? coverLayer(p.w, p.h, size.width, size.height) : placeLayer(p.w, p.h, d.width, d.height, 0.45);
      const layer: ComposeLayer = { ...p.layer, ...(first ? { name: 'Background' } : {}), ...box };
      commit({ ...d, ...size, layers: [...d.layers, layer] });
      setSelected(layer.id);
      setTool('move');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const addFiles = async (files: File[]) => {
    const pics = files.filter((f) => f.type.startsWith('image/'));
    if (!pics.length) return;
    if (!online) return toast('Start ComfyUI first (top right): pictures are saved into the Library through it.', 'info');
    const { ids, failed } = await importPictures(pics);
    if (failed.length) toast(importFailedMessage(failed), 'error', 12000);
    for (const [i, itemId] of ids.entries()) await addPicture({ id: itemId, prompt: pics[i]?.name.replace(/\.[a-z0-9]+$/i, '') ?? 'Picture' });
  };
  const addPaintLayer = () => {
    const d = docRef.current!;
    const n = d.layers.filter((l) => l.kind === 'paint').length + 1;
    const layer: ComposeLayer = { id: uid(), kind: 'paint', name: `Paint ${n}`, paint: '', x: 0, y: 0, w: d.width, h: d.height };
    commit({ ...d, layers: [...d.layers, layer] });
    setSelected(layer.id);
    setTool('brush');
    return layer.id;
  };

  // ---- layer actions
  const sel = doc?.layers.find((l) => l.id === selected) ?? null;
  const removeLayer = (lid: string) => {
    update((d) => ({ ...d, layers: d.layers.filter((l) => l.id !== lid) }));
    if (selected === lid) setSelected(null);
  };
  const moveLayer = (lid: string, dir: 1 | -1) =>
    update((d) => {
      const i = d.layers.findIndex((l) => l.id === lid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.layers.length) return d;
      const layers = [...d.layers];
      [layers[i], layers[j]] = [layers[j], layers[i]];
      return { ...d, layers };
    });
  const fillCanvas = (l: ComposeLayer) => {
    void loadImg(layerUrl(l)).then((img) => setLayer(l.id, coverLayer(img.naturalWidth, img.naturalHeight, docRef.current!.width, docRef.current!.height)));
  };
  /** Cut the subject out (background removal), trim to it and keep it where it was. */
  const cutOut = async (l: ComposeLayer) => {
    if (!online) return toast('Start ComfyUI first (top right).', 'info');
    setBusyLayer(l.id);
    try {
      const j = await api.submit({ workflow: 'remove_bg', params: { image_1: l.src! }, meta: { mode: 'edit:remove_bg', model: 'BiRefNet', prompt: l.name, parentId: l.itemId ?? null } });
      const itemId = await waitForItem(j.id);
      const inp = await api.asInput(itemId);
      const img = await loadImg(inputUrl(inp.name));
      const box = alphaBox(img);
      if (!box) throw new Error('No subject found to cut out.');
      const c = makeCanvas(box.w, box.h);
      c.getContext('2d')!.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
      const up = await api.upload(await toBlob(c), 'cutout.png');
      const sx = l.w / img.naturalWidth;
      const sy = l.h / img.naturalHeight;
      const left = l.flip ? img.naturalWidth - box.x - box.w : box.x;
      setLayer(l.id, { src: up.name, itemId, cutout: true, x: l.x + left * sx, y: l.y + box.y * sy, w: box.w * sx, h: box.h * sy });
    } catch (e) {
      toast(`Cut-out failed: ${(e as Error).message}`, 'error');
    } finally {
      setBusyLayer(null);
    }
  };

  // ---- pointer work on the canvas
  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const r = canvasEl.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };
  const strokeTo = (from: { x: number; y: number }, to: { x: number; y: number }, erase: boolean, target: HTMLCanvasElement | null) => {
    const c = erase ? target : stroke.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.save();
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = colour;
    ctx.lineWidth = size;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x + 0.01, to.y);
    ctx.stroke();
    ctx.restore();
  };

  const erasePicture = (l: ComposeLayer, from: { x: number; y: number }, to: { x: number; y: number }) => {
    const c = eraseWork.current?.canvas;
    if (!c) return;
    const map = (q: { x: number; y: number }) => {
      const u = (q.x - l.x) / l.w;
      return { x: (l.flip ? 1 - u : u) * c.width, y: ((q.y - l.y) / l.h) * c.height };
    };
    const a = map(from);
    const b = map(to);
    const ctx = c.getContext('2d')!;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = (size * c.width) / l.w;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x + 0.01, b.y);
    ctx.stroke();
    ctx.restore();
  };

  const onPointerDown = async (e: React.PointerEvent) => {
    if (!doc || e.button !== 0) return;
    const p = toCanvas(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (tool === 'brush' || tool === 'eraser') {
      const erase = tool === 'eraser';
      if (erase && sel?.kind === 'picture' && !sel.hidden) {
        if (busyLayer) return;
        const img = await loadImg(layerUrl(sel));
        const c = makeCanvas(img.naturalWidth, img.naturalHeight);
        c.getContext('2d')!.drawImage(img, 0, 0);
        c.style.width = c.style.height = '100%';
        c.style.display = 'block';
        eraseWork.current = { id: sel.id, canvas: c };
        setErasingId(sel.id);
        setDrag({ kind: 'paint', id: sel.id, erase: true, picture: true, last: p, before: doc });
        erasePicture(sel, p, p);
        return;
      }
      // a hidden paint layer is never painted on blind: the stroke starts a new layer instead
      const target = sel?.kind === 'paint' && !sel.hidden ? sel.id : null;
      if (erase && !target) return toast('Select a picture, cut-out or paint layer to erase from.', 'info');
      setDrag({ kind: 'paint', id: target, erase, last: p, before: doc });
      strokeTo(p, p, erase, target ? paint(target)! : null);
      return;
    }
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (l.hidden || l.kind === 'paint' || !(await hitsLayer(l, p.x, p.y, doc, paint))) continue;
      setSelected(l.id);
      // the background stays put (select it in the list to move it on purpose)
      if (i === backgroundIndex(doc) && selected !== l.id) return;
      setDrag({ kind: 'move', id: l.id, sx: p.x, sy: p.y, ox: l.x, oy: l.y, before: doc });
      return;
    }
    setSelected(null);
  };
  const onHandleDown = (e: React.PointerEvent, l: ComposeLayer, corner: 'nw' | 'ne' | 'sw' | 'se') => {
    e.stopPropagation();
    (canvasEl.current as HTMLElement).setPointerCapture(e.pointerId);
    const ax = corner.includes('w') ? l.x + l.w : l.x;
    const ay = corner.includes('n') ? l.y + l.h : l.y;
    setDrag({ kind: 'scale', id: l.id, ax, ay, w0: l.w, h0: l.h, before: doc! });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || !doc) return;
    const p = toCanvas(e);
    if (drag.kind === 'paint' && drag.picture) {
      const l = doc.layers.find((x) => x.id === drag.id);
      if (l) erasePicture(l, drag.last, p);
      setDrag({ ...drag, last: p });
    } else if (drag.kind === 'paint') {
      strokeTo(drag.last, p, drag.erase, drag.id ? paint(drag.id)! : null);
      setDrag({ ...drag, last: p });
    } else if (drag.kind === 'move') {
      const patch = { x: Math.round(drag.ox + p.x - drag.sx), y: Math.round(drag.oy + p.y - drag.sy) };
      setDocState({ ...doc, layers: doc.layers.map((l) => (l.id === drag.id ? { ...l, ...patch } : l)) });
    } else {
      const s = Math.max(12 / drag.w0, Math.abs(p.x - drag.ax) / drag.w0, Math.abs(p.y - drag.ay) / drag.h0);
      const w = Math.round(drag.w0 * s);
      const h = Math.round(drag.h0 * s);
      const x = p.x < drag.ax ? drag.ax - w : drag.ax;
      const y = p.y < drag.ay ? drag.ay - h : drag.ay;
      setDocState({ ...doc, layers: doc.layers.map((l) => (l.id === drag.id ? { ...l, x, y, w, h } : l)) });
    }
  };
  const onPointerUp = () => {
    if (!drag || !doc) return setDrag(null);
    const d = drag;
    setDrag(null);
    if (d.kind !== 'paint') {
      if (d.before !== doc) commit(doc, d.before);
      return;
    }
    if (d.picture) {
      // the erased picture is saved as a new file; the old one stays, so Undo brings it back
      const work = eraseWork.current;
      const lid = d.id!;
      if (!work) return setErasingId(null);
      setBusyLayer(lid);
      void (async () => {
        try {
          const up = await api.upload(await toBlob(work.canvas), 'erased.png');
          await loadImg(inputUrl(up.name)); // loaded before it replaces the working canvas: no flicker
          const cur = docRef.current!;
          const isBg = cur.layers.findIndex((l) => l.id === lid) === backgroundIndex(cur);
          commit({ ...cur, layers: cur.layers.map((l) => (l.id === lid ? { ...l, src: up.name, cutout: l.cutout || !isBg } : l)) }, d.before);
        } catch (err) {
          toast(`Could not save the erased picture: ${(err as Error).message}`, 'error');
        } finally {
          eraseWork.current = null;
          setErasingId(null);
          setBusyLayer(null);
        }
      })();
      return;
    }
    if (d.erase) {
      const url = paint(d.id!)!.toDataURL('image/png');
      return commit({ ...doc, layers: doc.layers.map((l) => (l.id === d.id ? { ...l, paint: url } : l)) }, d.before);
    }
    // brush: merge the stroke into the selected paint layer, or start a new one on top
    const existing = d.id ? paint(d.id) : undefined;
    const merged = existing ?? makeCanvas(doc.width, doc.height);
    merged.getContext('2d')!.drawImage(stroke.current!, 0, 0);
    stroke.current!.getContext('2d')!.clearRect(0, 0, doc.width, doc.height);
    const url = merged.toDataURL('image/png');
    if (d.id) commit({ ...doc, layers: doc.layers.map((l) => (l.id === d.id ? { ...l, paint: url } : l)) }, d.before);
    else {
      const n = doc.layers.filter((l) => l.kind === 'paint').length + 1;
      const layer: ComposeLayer = { id: uid(), kind: 'paint', name: `Paint ${n}`, paint: url, x: 0, y: 0, w: doc.width, h: doc.height };
      commit({ ...doc, layers: [...doc.layers, layer] }, d.before);
      setSelected(layer.id);
    }
  };

  // ---- keys
  useHotkey((e) => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey, (e) => (e.preventDefault(), undo()), []);
  useHotkey((e) => (e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)), (e) => (e.preventDefault(), redo()), []);
  useHotkey(
    (e) => !e.ctrlKey && !e.metaKey && !e.altKey && ['v', 'b', 'e'].includes(e.key.toLowerCase()),
    (e) => setTool(({ v: 'move', b: 'brush', e: 'eraser' } as const)[e.key.toLowerCase() as 'v' | 'b' | 'e']),
    [],
  );
  useHotkey((e) => e.key === '[' || e.key === ']', (e) => setSize((s) => Math.max(2, Math.min(400, s + (e.key === ']' ? 6 : -6)))), []);
  useHotkey((e) => (e.key === 'Delete' || e.key === 'Backspace') && !!selected, () => selected && removeLayer(selected), [selected]);
  useHotkey(
    (e) => e.key.startsWith('Arrow') && !!sel && sel.kind === 'picture',
    (e) => {
      e.preventDefault();
      const n = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0;
      const dy = e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0;
      setLayer(sel!.id, { x: sel!.x + dx, y: sel!.y + dy });
    },
    [sel],
  );

  // ---- render
  const auto = autoMode(coverage, doc?.layers.filter((l) => l.kind === 'picture' && !l.hidden).length ?? 0);
  const mode: RenderMode = !doc || doc.mode === 'auto' ? auto.mode : doc.mode;
  const render = async () => {
    if (!doc) return;
    if (!doc.layers.some((l) => !l.hidden)) return toast('Add a picture or paint something first.', 'info');
    if (!online) return toast('Start ComfyUI first (top right).', 'info');
    setRendering(true);
    try {
      let description = doc.description;
      // Reimagine needs words for the scene: none yet, or Describe's text is for a canvas that has changed since
      if (mode === 'reimagine' && (!description.trim() || (isDescribedText(doc) && doc.described!.canvas !== canvasKey(doc)))) {
        toast('Describing the scene first, so the paint becomes the real thing…', 'info');
        description = (await describe()) ?? '';
      }
      const plan = renderPlan(mode, description);
      const params: Record<string, string | number> = { seed: randomSeed(), prompt: plan.prompt };
      if (plan.mask) {
        const m = await seamMask(doc, paint);
        if (!m) throw new Error('Blend edges needs a background picture that fills the canvas, with pieces on top of it.');
        params.mask = (await api.upload(await toBlob(m), 'seams.png')).name;
        if (plan.feather) params.feather = plan.feather;
      }
      params.image_1 = (await api.upload(await toBlob(await flatten(doc, paint)), 'composition.png')).name;
      const label = MODES.find((m) => m.id === mode)!.label;
      const j: Job = await api.submit({
        workflow: plan.workflow,
        params,
        meta: { mode: 'compose', model: `${plan.model} · ${label}`, prompt: description.trim() || `${name} (${label})`, ui: { compositionId: id, composeMode: mode }, estimateSec: SECONDS[mode] },
      });
      setJobIds((ids) => [j.id, ...ids]);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setRendering(false);
    }
  };
  /** The local vision model reads the canvas as a plan for a real photo and writes the scene (the box is filled in). */
  const describe = async (): Promise<string | null> => {
    const d = docRef.current!;
    // an empty canvas would only get an invented scene back
    if (!d.layers.some((l) => !l.hidden && (l.kind === 'picture' || l.paint))) {
      toast('Nothing visible on the canvas to describe.', 'info');
      return null;
    }
    setDescribing(true);
    try {
      const input = (await api.upload(await toBlob(await flatten(d, paint)), 'composition.png')).name;
      // text Describe wrote earlier is not your idea: describe the canvas afresh (otherwise it repeats the old scene)
      const idea = isDescribedText(d) ? '' : d.description;
      const r = await api.vlm({ task: 'scene', variant: 'default', input, text: idea });
      const text = r.text.trim();
      const canvas = canvasKey(d);
      setDocState((cur) => (cur ? { ...cur, description: text, described: { text, canvas } } : cur));
      return text;
    } catch (e) {
      toast(`Could not describe the scene: ${(e as Error).message}`, 'error');
      return null;
    } finally {
      setDescribing(false);
    }
  };
  /** A render becomes the new background; what was under it is hidden (not deleted), so you can keep adding pieces. */
  const continueFrom = async (itemId: string) => {
    const d = docRef.current!;
    try {
      const p = await pictureFor({ id: itemId, prompt: 'Render' });
      const layer: ComposeLayer = { ...p.layer, name: 'Render', ...coverLayer(p.w, p.h, d.width, d.height) };
      commit({ ...d, layers: [...d.layers.map((l) => ({ ...l, hidden: true })), layer] });
      setSelected(layer.id);
      setView(null);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  if (missing)
    return (
      <div className="screen" style={{ placeItems: 'center' }}>
        <div className="empty">
          <p>This composition no longer exists.</p>
          <button className="btn" onClick={() => go('compose')}>
            All compositions
          </button>
        </div>
      </div>
    );
  if (!doc)
    return (
      <div className="screen" style={{ placeItems: 'center' }}>
        <div className="empty">Opening…</div>
      </div>
    );

  const bg = backgroundIndex(doc);
  const renders = doc.renders ?? [];
  const busyJobs = jobIds.map((j) => jobs[j]).filter(Boolean);
  const TOOLS: { id: Tool; label: string; key: string; icon: typeof Brush }[] = [
    { id: 'move', label: 'Move and scale', key: 'V', icon: MousePointer2 },
    { id: 'brush', label: 'Paint', key: 'B', icon: Brush },
    { id: 'eraser', label: 'Erase', key: 'E', icon: Eraser },
  ];

  return (
    <div className="screen" style={{ gridTemplateColumns: '68px 1fr 380px' }}>
      <nav className="panel" aria-label="Tools" style={{ alignItems: 'center', padding: '12px 0', gap: 6 }}>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`btn icon ${tool === t.id ? 'on' : 'ghost'}`}
            aria-pressed={tool === t.id}
            title={`${t.label} (${t.key})`}
            aria-label={`${t.label} (${t.key})`}
            onClick={() => (setTool(t.id), setView(null))}
            style={{ position: 'relative' }}
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
        aria-label="Composition"
        onDragOver={(e) => (e.preventDefault(), setFileOver(true))}
        onDragLeave={() => setFileOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setFileOver(false);
          const itemId = e.dataTransfer.getData('application/x-darkroom-item');
          if (itemId) void api.item(itemId).then((r) => addPicture(r.item));
          else void addFiles([...e.dataTransfer.files]);
        }}
      >
        <div className="stage-main" ref={stageBox} style={{ padding: 0 }}>
          {view ? (
            <div className="compose-view">
              <img src={fileUrl(view)} alt="Render" onError={() => setView(null)} />
              <div className="compose-row compose-view-bar">
                <button className="btn sm" onClick={() => setView(null)}>
                  Back to canvas
                </button>
                <button className="btn sm" onClick={() => void continueFrom(view)} title="Use this render as the new background and keep composing on it">
                  Continue from this
                </button>
                <button className="btn sm" onClick={() => go('edit', view)}>
                  Open in Edit
                </button>
              </div>
            </div>
          ) : (
            <div
              ref={canvasEl}
              className={`compose-canvas tool-${tool}`}
              style={{ width: doc.width * scale, height: doc.height * scale, background: PAPER }}
              onPointerDown={(e) => void onPointerDown(e)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              aria-label="Canvas"
              role="application"
            >
              {doc.layers.map((l) =>
                l.kind === 'paint' ? (
                  <PaintLayer key={l.id} layer={l} doc={doc} hidden={!!l.hidden} register={(el) => (el ? paintEls.current.set(l.id, el) : paintEls.current.delete(l.id))} />
                ) : l.id === erasingId ? (
                  <div
                    key={l.id}
                    className="compose-piece"
                    ref={(el) => {
                      const c = eraseWork.current?.canvas;
                      if (el && c && c.parentElement !== el) el.replaceChildren(c);
                    }}
                    style={{ left: l.x * scale, top: l.y * scale, width: l.w * scale, height: l.h * scale, transform: l.flip ? 'scaleX(-1)' : undefined }}
                  />
                ) : (
                  <img
                    key={l.id}
                    src={layerUrl(l)}
                    alt=""
                    draggable={false}
                    className="compose-piece"
                    style={{
                      left: l.x * scale,
                      top: l.y * scale,
                      width: l.w * scale,
                      height: l.h * scale,
                      transform: l.flip ? 'scaleX(-1)' : undefined,
                      display: l.hidden ? 'none' : undefined,
                    }}
                  />
                ),
              )}
              <canvas ref={stroke} width={doc.width} height={doc.height} className="compose-stroke" />
              {sel && sel.kind === 'picture' && !sel.hidden && tool === 'move' && (
                <div className="compose-select" style={{ left: sel.x * scale, top: sel.y * scale, width: sel.w * scale, height: sel.h * scale }}>
                  {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
                    <span key={c} className={`compose-handle ${c}`} onPointerDown={(e) => onHandleDown(e, sel, c)} aria-hidden />
                  ))}
                </div>
              )}
              {drag && drag.kind !== 'paint' && sel && (
                <div className="compose-ground" style={{ top: (sel.y + sel.h) * scale }}>
                  <span>ground</span>
                </div>
              )}
              {!doc.layers.length && (
                <div className="compose-empty">
                  <p>Add a picture to start (it becomes the background), or just paint.</p>
                  <p className="note">Drop pictures from your computer or the Library here.</p>
                </div>
              )}
            </div>
          )}
        </div>

        {(renders.length > 0 || busyJobs.length > 0) && (
          <div className="compose-strip" role="list" aria-label="Renders">
            {busyJobs.map((j) => (
              <div key={j.id} className="compose-render busy" role="listitem" title={j.stage || 'Rendering…'}>
                {previews[j.id] ? <img src={previews[j.id]} alt="" /> : <Loader2 size={18} className="spin" />}
                <ProgressBar value={j.progress} />
              </div>
            ))}
            {renders.map((r) => (
              <button key={r} className={`compose-render ${view === r ? 'on' : ''}`} role="listitem" onClick={() => setView(view === r ? null : r)} aria-label="Show render">
                <img src={thumbUrl(r)} alt="" onError={(e) => ((e.currentTarget.parentElement as HTMLElement).style.display = 'none')} />
              </button>
            ))}
          </div>
        )}
      </section>

      <aside className="panel right" aria-label="Composition settings">
        <div className="panel-scroll">
          <div>
            <div className="compose-row" style={{ justifyContent: 'space-between' }}>
              <button className="btn ghost sm" onClick={() => go('compose')}>
                ← All compositions
              </button>
              <span className="note" aria-live="polite">
                {saved === 'saving' ? 'Saving…' : saved === 'error' ? 'Not saved' : 'Saved'}
              </span>
            </div>
            <input className="input" aria-label="Composition name" value={name} onChange={(e) => setName(e.target.value)} style={{ marginTop: 8 }} />
            <p className="note mono" style={{ marginTop: 6 }}>
              {doc.width} × {doc.height}
            </p>
          </div>

          <div>
            <h3 className="section-label">Add</h3>
            <div className="compose-row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button className="btn sm" onClick={() => setPicking(true)}>
                <ImagePlus size={15} /> From Library
              </button>
              <button className="btn sm" onClick={() => upload.current?.click()}>
                <Upload size={15} /> Upload
              </button>
              <button className="btn sm" onClick={addPaintLayer}>
                <Paintbrush size={15} /> Paint layer
              </button>
            </div>
            <input ref={upload} type="file" accept="image/*" multiple hidden aria-label="Upload pictures to the canvas" onChange={(e) => (void addFiles([...(e.target.files ?? [])]), (e.target.value = ''))} />
          </div>

          {(tool === 'brush' || tool === 'eraser') && (
            <div>
              <h3 className="section-label">
                {tool === 'brush' ? 'Brush' : 'Eraser'} <span className="mono">{size}px</span>
              </h3>
              {tool === 'brush' && (
                <div className="compose-swatches" role="group" aria-label="Paint colour">
                  {SWATCHES.map((c) => (
                    <button key={c} className="compose-swatch" style={{ background: c }} aria-pressed={colour === c} aria-label={`Colour ${c}`} onClick={() => setColour(c)} />
                  ))}
                  <input type="color" value={colour} onChange={(e) => setColour(e.target.value)} aria-label="Any colour" />
                </div>
              )}
              <input type="range" min={2} max={400} value={size} onChange={(e) => setSize(+e.target.value)} aria-label="Brush size" style={{ width: '100%', marginTop: 8 }} />
              <p className="note">
                {tool === 'brush' ? 'Rough shapes are fine: Reimagine turns them into the real thing. Paints on the selected paint layer, or starts a new one.' : 'Erases from the selected layer: a picture, a cut-out or paint. Ctrl+Z brings it back.'} [ and ] change the size.
              </p>
            </div>
          )}

          <div>
            <h3 className="section-label">
              Layers <span className="mono">{doc.layers.length}</span>
            </h3>
            {!doc.layers.length && <p className="note">Nothing on the canvas yet.</p>}
            <ul className="compose-layers" aria-label="Layers, top first">
              {[...doc.layers].reverse().map((l) => {
                const i = doc.layers.indexOf(l);
                return (
                  <li key={l.id} className={selected === l.id ? 'on' : ''}>
                    <button className="compose-layer" onClick={() => (setSelected(l.id), setTool(l.kind === 'paint' ? 'brush' : 'move'), setView(null))} aria-pressed={selected === l.id} aria-label={`Select ${l.name}`}>
                      <span className="compose-layer-thumb">{(l.kind === 'picture' || l.paint) && <img src={layerUrl(l)} alt="" />}</span>
                      <span className="compose-layer-name">
                        {l.name}
                        <small className="note">{i === bg ? 'background' : l.kind === 'paint' ? 'paint' : l.cutout ? 'cut-out' : 'picture'}</small>
                      </span>
                      {busyLayer === l.id && <Loader2 size={14} className="spin" aria-label="Working" />}
                    </button>
                    <button className="btn ghost sm icon" onClick={() => setLayer(l.id, { hidden: !l.hidden })} aria-label={l.hidden ? `Show ${l.name}` : `Hide ${l.name}`} title={l.hidden ? 'Show' : 'Hide'}>
                      {l.hidden ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </li>
                );
              })}
            </ul>
            {sel && (
              <div className="compose-layer-actions" role="group" aria-label={`${sel.name} actions`}>
                <input className="input" aria-label="Layer name" value={sel.name} onChange={(e) => setDocState({ ...doc, layers: doc.layers.map((l) => (l.id === sel.id ? { ...l, name: e.target.value } : l)) })} />
                <div className="compose-row" style={{ gap: 4, flexWrap: 'wrap' }}>
                  {sel.kind === 'picture' && !sel.cutout && (
                    <button className="btn sm" onClick={() => void cutOut(sel)} disabled={!!busyLayer} title="Remove its background (about 2 s); the cut-out also goes into your Library">
                      <Scissors size={15} /> Cut out
                    </button>
                  )}
                  {sel.kind === 'picture' && (
                    <>
                      <button className="btn sm icon" onClick={() => setLayer(sel.id, { flip: !sel.flip })} aria-label="Flip" title="Flip left–right (match the light direction)">
                        <FlipHorizontal2 size={15} />
                      </button>
                      <button className="btn sm icon" onClick={() => fillCanvas(sel)} aria-label="Fill the canvas" title="Fill the canvas (use as background)">
                        <Maximize size={15} />
                      </button>
                    </>
                  )}
                  <button className="btn sm icon" onClick={() => moveLayer(sel.id, 1)} aria-label="Bring forward" title="Bring forward">
                    <ArrowUp size={15} />
                  </button>
                  <button className="btn sm icon" onClick={() => moveLayer(sel.id, -1)} aria-label="Send backward" title="Send backward">
                    <ArrowDown size={15} />
                  </button>
                  <button className="btn sm icon ghost danger-text" onClick={() => removeLayer(sel.id)} aria-label="Remove layer" title="Remove from the canvas (Delete)">
                    <Trash2 size={15} />
                  </button>
                </div>
                {sel.kind === 'picture' && <p className="note">Drag to move, corners to scale. The dashed line shows where it meets the ground: set people and objects on it at a believable size.</p>}
              </div>
            )}
          </div>
        </div>

        <div className="panel-foot">
          <h3 className="section-label" style={{ margin: 0 }}>Render</h3>
          <div className="compose-modes" role="group" aria-label="Render mode">
            {MODES.map((m) => (
              <button key={m.id} className="card" aria-pressed={mode === m.id} onClick={() => setDocState({ ...doc, mode: doc.mode === m.id ? 'auto' : m.id })} title={m.text}>
                <strong>{m.label}</strong>
                <small>{doc.mode === 'auto' && auto.mode === m.id ? 'Suggested' : m.model}</small>
              </button>
            ))}
          </div>
          <p className="note">
            {MODES.find((m) => m.id === mode)!.text}
            {doc.mode === 'auto' ? ` Suggested because ${auto.why}.` : ''}
          </p>
          <div className="compose-row" style={{ justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <span className="note">Scene (optional)</span>
            <button className="btn sm" onClick={() => void describe()} disabled={describing || !doc.layers.length} title="Let the local vision model describe the real scene your canvas stands for">
              {describing ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Describe
            </button>
          </div>
          <textarea
            className="input"
            rows={2}
            placeholder="e.g. a quiet harbour at dusk. Empty: Reimagine describes it for you."
            aria-label="Scene description"
            value={doc.description}
            onChange={(e) => setDocState({ ...doc, description: e.target.value })}
          />
          {isDescribedText(doc) && doc.described!.canvas !== canvasKey(doc) && (
            <p className="note warn">The canvas changed since this was described. Press Describe again{mode === 'reimagine' ? ' (Reimagine will do it for you)' : ''}.</p>
          )}
          <button className="btn primary big" onClick={() => void render()} disabled={rendering || describing || !doc.layers.length}>
            {rendering ? <Loader2 size={18} className="spin" /> : null} Render · ~{SECONDS[mode]} s
          </button>
        </div>
      </aside>
      {picking && <LibraryPicker title="Add a picture" onClose={() => setPicking(false)} onPick={(it) => (setPicking(false), void addPicture(it))} />}
    </div>
  );
}

/** A paint layer: a canvas the size of the composition, drawn from its saved PNG whenever that changes (undo, load). */
function PaintLayer({ layer, doc, hidden, register }: { layer: ComposeLayer; doc: ComposeDoc; hidden: boolean; register: (el: HTMLCanvasElement | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawn = useRef<string | null>(null);
  useEffect(() => {
    register(ref.current);
    return () => register(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const c = ref.current;
    if (!c || drawn.current === (layer.paint ?? '')) return;
    const url = layer.paint ?? '';
    drawn.current = url;
    const ctx = c.getContext('2d')!;
    if (!url) return ctx.clearRect(0, 0, c.width, c.height);
    void loadImg(url).then((img) => {
      if (drawn.current !== url) return;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
    });
  }, [layer.paint]);
  return <canvas ref={ref} width={doc.width} height={doc.height} className="compose-paint" style={{ display: hidden ? 'none' : undefined }} />;
}

