const fs = require('fs');
const rep = (s, a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 80)); return s.replace(a, b); };

let e = fs.readFileSync('src/web/screens/Edit.tsx', 'utf8');
e = rep(e, `type Mode = 'instruct' | 'inpaint' | 'outpaint' | 'remove_bg' | 'upscale';`, `type Mode = 'instruct' | 'inpaint' | 'outpaint' | 'enhance' | 'remove_bg' | 'upscale';
type EnhanceKind = 'subtle' | 'strong' | 'upscale';`);
e = rep(e, `  { id: 'outpaint', label: 'Outpaint' },`, `  { id: 'outpaint', label: 'Outpaint' },
  { id: 'enhance', label: 'Enhance' },`);
e = rep(e, `  const [editModel, setEditModel] = useState<string>(() => localStorage.getItem('dr.edit.model') || 'qwen');`, `  const [editModel, setEditModel] = useState<string>(() => localStorage.getItem('dr.edit.model') || 'qwen');
  const [enhanceKind, setEnhanceKind] = useState<EnhanceKind>('subtle');
  const [enhanceAdv, setEnhanceAdv] = useState(false);
  const [denoise, setDenoise] = useState<number | null>(null); // null = model default for the chosen strength`);
e = rep(e, `  const wfFor = (m: 'instruct' | 'inpaint' | 'outpaint') => boot?.manifest.edit?.[m]?.[editModel] ?? { instruct: 'qwen_edit', inpaint: 'inpaint', outpaint: 'outpaint' }[m];`,
`  const wfFor = (m: 'instruct' | 'inpaint' | 'outpaint' | 'enhance') =>
    boot?.manifest.edit?.[m]?.[editModel] ?? { instruct: 'qwen_edit', inpaint: 'inpaint', outpaint: 'outpaint', enhance: 'qwen_enhance' }[m];
  const enhanceDefaults = (boot?.manifest as any)?.enhance?.[editModel] as { subtle: number; strong: number } | undefined;
  const effDenoise = denoise ?? (enhanceKind === 'strong' ? enhanceDefaults?.strong : enhanceDefaults?.subtle) ?? 0.3;`);
e = rep(e, `    if (mode === 'remove_bg') return submit('remove_bg', {}, 'edit:remove_bg', 'BiRefNet');`, `    if (mode === 'enhance') {
      let cap = caption ?? ((item.ui as any)?.caption as string | undefined) ?? null;
      if (!cap) {
        toast('Describing the picture first (local Qwen3-VL)…', 'info');
        try {
          cap = (await api.vlm({ task: 'caption', variant: em === 'klein' ? 'klein' : 'short', itemId: item.id, save: true })).text;
        } catch {
          cap = null;
        }
      }
      const strength = enhanceKind === 'strong' ? 'strong' : 'subtle';
      const srcMP = (W * H) / 1e6;
      const params: Record<string, string | number> = {
        prompt: composeImagePrompt(T, { model: em, mode: 'enhance', text: '', caption: cap, strength }),
        denoise: effDenoise,
        megapixels: Math.round(Math.min(2, Math.max(1, srcMP)) * 100) / 100,
      };
      if (em === 'klein') params.schedule_steps = Math.max(4, Math.round(4 / effDenoise));
      const label = \`\${modelLabel} enhance (\${enhanceKind === 'upscale' ? 'upscale + enhance' : strength})\`;
      try {
        const inp = await api.asInput(item.id);
        const j = await api.submit({
          workflow: wfFor('enhance'),
          params: { image_1: inp.name, seed: randomSeed(), ...params },
          meta: { mode: 'edit:enhance', model: label, prompt: item.prompt, parentId: item.id, ui: { ...item.ui, caption: cap ?? undefined }, chain: enhanceKind === 'upscale' ? { kind: 'upscale' } : undefined },
        });
        setJobId(j.id);
        if (enhanceKind === 'upscale') toast('Enhancing, then upscaling 2× with SeedVR2 — the upscaled version opens when it is ready.', 'info', 7000);
      } catch (err) {
        toast((err as Error).message, 'error');
      }
      return;
    }
    if (mode === 'remove_bg') return submit('remove_bg', {}, 'edit:remove_bg', 'BiRefNet');`);
e = rep(e, `          {(mode === 'instruct' || mode === 'inpaint' || mode === 'outpaint') && boot && (`, `          {(mode === 'instruct' || mode === 'inpaint' || mode === 'outpaint' || mode === 'enhance') && boot && (`);
e = rep(e, `          {mode === 'remove_bg' && <p className="note">`, `          {mode === 'enhance' && (
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
          {mode === 'remove_bg' && <p className="note">`);
e = rep(e, `      : { instruct: 'Apply instruction', inpaint: 'Fill masked area', outpaint: 'Extend canvas', remove_bg: 'Remove background', upscale: 'Upscale 2×' }[mode];`,
`      : { instruct: 'Apply instruction', inpaint: 'Fill masked area', outpaint: 'Extend canvas', enhance: 'Enhance', remove_bg: 'Remove background', upscale: 'Upscale 2×' }[mode];`);
// Edit empty state: screen capture import
e = rep(e, `        {recent.length > 0 && (
          <>
            <p className="section-label" style={{ marginTop: 16 }}>`, `        <button
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
            <p className="section-label" style={{ marginTop: 16 }}>`);
e = rep(e, `  const [jobId, setJobId] = useState<string | null>(null);
  useEffect(() => {
    api.items({ filter: 'all', limit: 24 })`, `  const [jobId, setJobId] = useState<string | null>(null);
  const [capture, setCapture] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    api.items({ filter: 'all', limit: 24 })`);
e = rep(e, `import { useItem } from '../lib/hooks';`, `import { useItem } from '../lib/hooks';
import { CropDialog, grabScreenFrame } from '../lib/capture';`);
e = rep(e, `  Maximize,`, `  Maximize,
  Monitor,`);
fs.writeFileSync('src/web/screens/Edit.tsx', e);

// Generate + Library: Enhance shortcuts (open Edit in Enhance mode)
let g = fs.readFileSync('src/web/screens/Generate.tsx', 'utf8');
g = rep(g, `              <button className="btn sm" onClick={() => go('edit', selectedItem.id)}>
                <Layers size={15} /> Edit
              </button>`, `              <button className="btn sm" onClick={() => go('edit', selectedItem.id)}>
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
              </button>`);
fs.writeFileSync('src/web/screens/Generate.tsx', g);
let l = fs.readFileSync('src/web/screens/Library.tsx', 'utf8');
l = rep(l, `            <button className="btn sm" onClick={() => go('edit', item.id)}>
              <Layers size={14} /> Send to Edit
            </button>
          )}`, `            <button className="btn sm" onClick={() => go('edit', item.id)}>
              <Layers size={14} /> Send to Edit
            </button>
          )}
          {item.kind === 'image' && (
            <button
              className="btn sm"
              onClick={() => {
                sessionStorage.setItem('dr.edit.mode', 'enhance');
                go('edit', item.id);
              }}
            >
              <Sparkles size={14} /> Enhance
            </button>
          )}`);
l = rep(l, `import { Copy, Download, ExternalLink, Film, Heart, Layers, Search, Share2 } from 'lucide-react';`, `import { Copy, Download, ExternalLink, Film, Heart, Layers, Search, Share2, Sparkles } from 'lucide-react';`);
fs.writeFileSync('src/web/screens/Library.tsx', l);
console.log('phase3 ui ok');
