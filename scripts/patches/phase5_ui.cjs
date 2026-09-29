const fs = require('fs');
const rep = (s, a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 80)); return s.replace(a, b); };

// ---------------- Edit: hover compare
let e = fs.readFileSync('src/web/screens/Edit.tsx', 'utf8');
const start = e.indexOf('function CompareView(');
const end = e.indexOf('function RefSlot(');
e = e.slice(0, start) + e.slice(end);
e = rep(e, `              <CompareView before={fileUrl(parent.id)} after={fileUrl(item.id)} split={split} />`, `              <CompareView before={fileUrl(parent.id)} after={fileUrl(item.id)} />`);
e = rep(e, `          {compare && <input type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} aria-label="Before/after split" style={{ width: 160 }} />}`,
`          {compare && <span className="note">Hover the picture to compare · hold Space for the original</span>}`);
e = rep(e, `  const [split, setSplit] = useState(50);\n`, '');
e = rep(e, `import { useItem } from '../lib/hooks';`, `import { useItem } from '../lib/hooks';
import { CompareView } from '../components/Compare';`);
fs.writeFileSync('src/web/screens/Edit.tsx', e);

// ---------------- Video: picker, swap, aspect handling
let v = fs.readFileSync('src/web/screens/Video.tsx', 'utf8');
v = rep(v, `  seed: number;
}`, `  seed: number;
  /** How frames with a different aspect are fitted: crop to fill (default) or letterbox with bars. */
  frameFit?: 'crop' | 'fit';
}`);
v = rep(v, `  const [suggesting, setSuggesting] = useState(false);`, `  const [suggesting, setSuggesting] = useState(false);
  const [picker, setPicker] = useState<null | 'start' | 'end'>(null);`);
v = rep(v, `  const uploadFrame = async (f: File, which: 'start' | 'end') => {`, `  /** Letterbox a frame to the video's aspect (bars), upload it, return the new input name. */
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

  const uploadFrame = async (f: File, which: 'start' | 'end') => {`);
// fit at submit time
v = rep(v, `    const params: Record<string, string | number> = {
      start_image: cur.start.name,`, `    const fit = cur.frameFit === 'fit';
    const mismatch = (fr: Frame | null) => !!fr && Math.abs(fr.width / fr.height / (p.width / p.height) - 1) > 0.03;
    const startName = fit && mismatch(cur.start) ? await letterbox(cur.start, p.width, p.height) : cur.start.name;
    const endName = cur.end && model.supportsEndFrame ? (fit && mismatch(cur.end) ? await letterbox(cur.end, p.width, p.height) : cur.end.name) : null;
    const params: Record<string, string | number> = {
      start_image: startName,`);
v = rep(v, `    if (cur.end && model.supportsEndFrame) params.end_image = cur.end.name;`, `    if (endName) params.end_image = endName;`);
v = rep(v, `  const animate = (override: Partial<VideoSettings> = {}, parentId: string | null = null, chain?: Record<string, unknown>) => {`, `  const animate = async (override: Partial<VideoSettings> = {}, parentId: string | null = null, chain?: Record<string, unknown>) => {`);
// frames section UI
v = rep(v, `            <p className="note" style={{ marginTop: 6 }}>
              Drop, paste or browse — or use “Animate” on any picture.
            </p>`, `            <div className="field-row" style={{ marginTop: 6 }}>
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
                    {bad.map(([n, f]) => \`\${n} frame is \${f.width}×\${f.height}\`).join(', ')}, but the video will be {plan.width}×{plan.height}.
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
            })()}`);
v = rep(v, `      {warning && (`, `      {picker && (
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
      {warning && (`);
v = rep(v, `import { Bell, Camera, Clapperboard, Download, FastForward, ImagePlus, Loader2, Pause, Play, Repeat, Sparkles, Undo2, Waves, X } from 'lucide-react';`,
`import { ArrowLeftRight, Bell, Camera, Clapperboard, Download, FastForward, ImagePlus, Loader2, Pause, Play, Repeat, Sparkles, Undo2, Waves, X } from 'lucide-react';
import { LibraryPicker } from '../components/LibraryPicker';`);
fs.writeFileSync('src/web/screens/Video.tsx', v);
console.log('phase5 ui ok');
