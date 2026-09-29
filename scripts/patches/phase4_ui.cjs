const fs = require('fs');
const rep = (s, a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 80)); return s.replace(a, b); };

// mask.ts: apply a SAM mask image to the mask layer
let mk = fs.readFileSync('src/web/lib/mask.ts', 'utf8');
mk = rep(mk, `  isEmpty(): boolean {`, `  /** Apply a mask picture (white = selected) with add / subtract / replace. */
  applyMaskImage(img: CanvasImageSource, op: 'add' | 'subtract' | 'replace'): void {
    this.checkpoint();
    const t = document.createElement('canvas');
    t.width = this.width;
    t.height = this.height;
    const tc = t.getContext('2d', { willReadFrequently: true })!;
    tc.drawImage(img, 0, 0, this.width, this.height);
    const d = tc.getImageData(0, 0, this.width, this.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const a = d.data[i];
      d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
      d.data[i + 3] = a;
    }
    tc.putImageData(d, 0, 0);
    if (op === 'replace') this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.save();
    this.ctx.globalCompositeOperation = op === 'subtract' ? 'destination-out' : 'source-over';
    this.ctx.drawImage(t, 0, 0);
    this.ctx.restore();
    this.render();
  }

  isEmpty(): boolean {`);
fs.writeFileSync('src/web/lib/mask.ts', mk);

let e = fs.readFileSync('src/web/screens/Edit.tsx', 'utf8');
e = rep(e, `  { id: 'smart', label: 'Smart select', key: 'S', icon: ScanSearch, disabled: 'Smart select is not available yet — use the brush or lasso.' },`,
`  { id: 'smart', label: 'Smart select', key: 'S', icon: ScanSearch },`);
e = rep(e, `type Mode = 'instruct' | 'inpaint' | 'outpaint' | 'enhance' | 'remove_bg' | 'upscale';`, `type Mode = 'instruct' | 'inpaint' | 'outpaint' | 'enhance' | 'remove_bg' | 'layers' | 'upscale';`);
e = rep(e, `  { id: 'enhance', label: 'Enhance' },`, `  { id: 'enhance', label: 'Enhance' },
  { id: 'layers', label: 'Layers' },`);
e = rep(e, `  const [lasso, setLasso] = useState<{ x: number; y: number }[] | null>(null);`, `  const [lasso, setLasso] = useState<{ x: number; y: number }[] | null>(null);
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
  const layersState = useLayerGroup(layerGroup);`);
e = rep(e, `  const drag = useRef<{ kind: 'pan' | 'paint' | 'lasso' | 'frame' | 'crop';`, `  const drag = useRef<{ kind: 'pan' | 'paint' | 'lasso' | 'frame' | 'crop' | 'sam';`);
e = rep(e, `        if (j.status === 'done' && j.result_ids[0]) {
          sessionStorage.removeItem('dr.edit.job');`, `        if (j.status === 'done' && (j.meta as any).layers) {
          sessionStorage.removeItem('dr.edit.job');
          setLayerGroup(j.id);
          toast(\`\${j.result_ids.length} layers ready. Toggle, reorder, rename and export them on the right.\`, 'ok');
          return;
        }
        if (j.status === 'done' && j.result_ids[0]) {
          sessionStorage.removeItem('dr.edit.job');`);
e = rep(e, `    } else if (tool === 'crop') {
      const q = { x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)) };
      drag.current = { kind: 'crop', ...base, origin: q };
      setCrop({ ...q, w: 0, h: 0 });
    }
  };`, `    } else if (tool === 'crop') {
      const q = { x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)) };
      drag.current = { kind: 'crop', ...base, origin: q };
      setCrop({ ...q, w: 0, h: 0 });
    } else if (tool === 'smart') {
      drag.current = { kind: 'sam', ...base, origin: p };
    }
  };`);
e = rep(e, `    } else if (d.kind === 'crop' && d.origin) {
      const p = toImage(e);`, `    } else if (d.kind === 'sam' && d.origin && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 8) {
      const p = toImage(e);
      setSamBox({ x: Math.min(d.origin.x, p.x), y: Math.min(d.origin.y, p.y), w: Math.abs(p.x - d.origin.x), h: Math.abs(p.y - d.origin.y) });
    } else if (d.kind === 'crop' && d.origin) {
      const p = toImage(e);`);
e = rep(e, `    } else if (d.kind === 'lasso' && lasso) {
      layer.current?.fillPolygon(lasso, e.shiftKey);
      setLasso(null);
      setMaskEmpty(!!layer.current?.isEmpty());
    }
  };`, `    } else if (d.kind === 'lasso' && lasso) {
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
      toast(\`Selection \${samOp === 'subtract' ? 'removed from' : 'added to'} the mask (\${r.seconds}s). Use it with Instruct, Inpaint or Remove BG.\`, 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSamBusy(false);
    }
  };`);
e = rep(e, `    if (mode === 'remove_bg') return submit('remove_bg', {}, 'edit:remove_bg', 'BiRefNet');`, `    if (mode === 'remove_bg') {
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
            model: bgSubject.trim() ? \`SAM 3.1 + \${matteName}\` : matteName,
            prompt: item.prompt,
            parentId: item.id,
            ui: item.ui,
            chain: bgPlate
              ? { kind: 'plate', firstItemId: item.id, prompt: composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: 'the background, continuing the surrounding scene naturally with nothing in the way', caption: plateCaption }) }
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
                ? { kind: 'plate', firstItemId: item.id, prompt: composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: 'the background, continuing the surrounding scene naturally with nothing in the way', caption: caption ?? null }) }
                : undefined,
            },
          });
          setJobId(j.id);
        } else {
          const j = await api.submit({
            workflow: 'qwen_layered',
            params: { image_1: inp.name, layers: layerCount, prompt: caption ?? '', seed: randomSeed() },
            meta: { mode: 'edit:layers', model: 'Qwen-Image-Layered', prompt: caption ?? '', parentId: item.id, ui: item.ui, layers: true },
          });
          setJobId(j.id);
          toast('Qwen-Image-Layered is slow (a few minutes). You can keep working; the layers appear when ready.', 'info', 8000);
        }
      } catch (err) {
        toast((err as Error).message, 'error');
      }
      return;
    }`);
// overlays: SAM points & box; layer stack in place of the image
e = rep(e, `            {crop && tool === 'crop' && (`, `            {tool === 'smart' &&
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
            {crop && tool === 'crop' && (`);
// panel sections
e = rep(e, `          {mode === 'remove_bg' && <p className="note">Cuts out the main subject and saves a PNG with a transparent background as a new version. This is a dedicated cut-out tool (BiRefNet), not an image model, so there is no model choice here.</p>}`,
`          {tool === 'smart' && (
            <div>
              <p className="section-label">
                Smart select (SAM 3.1) {samBusy && <span className="mono">working…</span>}
              </p>
              <p className="note" style={{ marginTop: 0 }}>
                Click the object (Shift-click to exclude a spot) or drag a box, then Select. Or type what to select.
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
          )}`);
e = rep(e, `      : { instruct: 'Apply instruction', inpaint: 'Fill masked area', outpaint: 'Extend canvas', enhance: 'Enhance', remove_bg: 'Remove background', upscale: 'Upscale 2×' }[mode];`,
`      : { instruct: 'Apply instruction', inpaint: 'Fill masked area', outpaint: 'Extend canvas', enhance: 'Enhance', remove_bg: 'Remove background', layers: 'Make layers', upscale: 'Upscale 2×' }[mode];`);
e = rep(e, `import { useItem } from '../lib/hooks';`, `import { useItem } from '../lib/hooks';
import { LayerStack, LayersPanel, useLayerGroup } from '../components/LayersPanel';`);
fs.writeFileSync('src/web/screens/Edit.tsx', e);

// server export endpoint + plate chain group id
let i = fs.readFileSync('src/server/index.ts', 'utf8');
i = rep(i, `app.get('/api/groups/:id', async (req) => store.groupItems((req.params as { id: string }).id).map(slim));`, `app.get('/api/groups/:id', async (req) => store.groupItems((req.params as { id: string }).id).map(slim));

/** Export layers (top-to-bottom) as a layered PSD or a ZIP of PNGs. */
app.post('/api/layers/export', async (req, reply) => {
  const b = (req.body ?? {}) as { format: 'psd' | 'zip'; layers: { id: string; name: string; visible: boolean }[] };
  if (!jobs.comfy) return reply.code(503).send({ error: "ComfyUI isn't running, so the layer files can't be read." });
  if (!b.layers?.length) return reply.code(400).send({ error: 'No layers to export.' });
  const inputs: LayerInput[] = [];
  for (const l of b.layers) {
    const it = store.getItem(l.id);
    if (!it) continue;
    inputs.push({ name: l.name, visible: l.visible, png: new Uint8Array(await sharp(await jobs.comfy.view(it.file)).png().toBuffer()) });
  }
  const buf = b.format === 'psd' ? await layersToPsd(inputs) : layersToZip(inputs);
  reply.header('content-type', b.format === 'psd' ? 'image/vnd.adobe.photoshop' : 'application/zip');
  reply.header('content-disposition', \`attachment; filename="darkroom-layers.\${b.format}"\`);
  return reply.send(buf);
});`);
i = rep(i, `import { buildVlmRequest, type VlmPrompts, type VlmTask } from '../shared/vlm.js';`, `import { buildVlmRequest, type VlmPrompts, type VlmTask } from '../shared/vlm.js';
import { layersToPsd, layersToZip, type LayerInput } from './layers.js';`);
fs.writeFileSync('src/server/index.ts', i);
let j = fs.readFileSync('src/server/jobs.ts', 'utf8');
j = rep(j, `groupId: (c.groupId as string | undefined) ?? undefined },`, `groupId: (c.groupId as string | undefined) ?? (job.meta.layers ? job.id : undefined) },`);
fs.writeFileSync('src/server/jobs.ts', j);
console.log('phase4 ui ok');
