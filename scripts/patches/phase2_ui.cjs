// Phase 2 UI: VLM enhance / reverse prompt / caption / suggest motion.
const fs = require('fs');
const rep = (s, a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 80)); return s.replace(a, b); };

// api.ts
let a = fs.readFileSync('src/web/api.ts', 'utf8');
a = rep(a, `  favourite: (id: string, favourite: boolean) => api.patch<Item>(\`/api/items/\${id}\`, { favourite }),`,
`  favourite: (id: string, favourite: boolean) => api.patch<Item>(\`/api/items/\${id}\`, { favourite }),
  vlm: (body: { task: 'caption' | 'reverse' | 'enhance' | 'motion'; variant: string; text?: string; itemId?: string; input?: string; which?: 'main' | 'poster' | 'last'; save?: boolean }) =>
    api.post<{ text: string; seconds: number }>('/api/vlm', body),`);
fs.writeFileSync('src/web/api.ts', a);

// ---------------------------------------------------------------- Generate
let g = fs.readFileSync('src/web/screens/Generate.tsx', 'utf8');
g = rep(g, `  const [busyRef, setBusyRef] = useState(false);`, `  const [busyRef, setBusyRef] = useState(false);
  const [vlmBusy, setVlmBusy] = useState<null | 'enhance' | 'reverse'>(null);
  const [promptUndo, setPromptUndo] = useState<string[]>([]);
  const reverseInput = useRef<HTMLInputElement>(null);`);
g = rep(g, `  const reuseId = query.get('reuse');`, `  // #/generate?prompt=...&model=...  (from Library "Reverse prompt")
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
    setVlmBusy('enhance');
    try {
      const r = await api.vlm({ task: 'enhance', variant: s.model, text: s.prompt });
      replacePrompt(r.text);
      toast(\`Prompt enhanced for \${m?.models[s.model]?.label} in \${r.seconds}s. Edit it freely; Undo brings back yours.\`, 'ok');
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
      toast(\`Prompt written from the picture for \${m?.models[s.model]?.label} in \${r.seconds}s.\`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setVlmBusy(null);
    }
  };

  const reuseId = query.get('reuse');`);
g = rep(g, `            <label className="section-label" htmlFor="prompt">
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
            </label>`, `            <div className="section-label">
              <label htmlFor="prompt">Prompt</label>
              <span style={{ display: 'flex', gap: 2 }}>
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
                  title={\`Write a prompt from a picture for \${model.label} (uses reference 1 if present, otherwise asks for a picture)\`}
                  onClick={() => (s.refs[0] ? void reverseFrom({ input: s.refs[0].name }) : reverseInput.current?.click())}
                >
                  {vlmBusy === 'reverse' ? <Loader2 size={14} className="spin" /> : <ScanText size={14} />} From picture
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
                  disabled={!!vlmBusy || !online}
                  title={\`Expand your idea into a detailed \${model.label} prompt (local Qwen3-VL). You can edit the result before generating.\`}
                  onClick={() => void enhance()}
                >
                  {vlmBusy === 'enhance' ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Enhance
                </button>
              </span>
            </div>`);
g = rep(g, `  Unlock,
  X,
} from 'lucide-react';`, `  Unlock,
  Undo2,
  Loader2,
  ScanText,
  X,
} from 'lucide-react';`);
fs.writeFileSync('src/web/screens/Generate.tsx', g);

// ---------------------------------------------------------------- Library
let l = fs.readFileSync('src/web/screens/Library.tsx', 'utf8');
l = rep(l, `function Detail({ item, comfyUrl }: { item: Item; comfyUrl: string | null }) {
  const [fav, setFav] = useState(item.favourite);`, `function Detail({ item, comfyUrl }: { item: Item; comfyUrl: string | null }) {
  const [fav, setFav] = useState(item.favourite);
  const [vlm, setVlm] = useState<{ busy: string | null; text: string | null; label: string }>({ busy: null, text: (item.ui as any)?.caption ?? null, label: 'Caption' });
  useEffect(() => setVlm({ busy: null, text: (item.ui as any)?.caption ?? null, label: 'Caption' }), [item.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const runVlm = async (task: 'caption' | 'reverse', variant: string, label: string) => {
    setVlm((v) => ({ ...v, busy: label }));
    try {
      const r = await api.vlm({ task, variant, itemId: item.id, save: task === 'caption' });
      setVlm({ busy: null, text: r.text, label });
    } catch (e) {
      toast((e as Error).message, 'error');
      setVlm((v) => ({ ...v, busy: null }));
    }
  };`);
l = rep(l, `        <div>
          <p className="section-label">Prompt</p>`, `        <div>
          <p className="section-label">Describe with Qwen3-VL {vlm.busy && <span className="mono">{vlm.busy}…</span>}</p>
          <div className="pills">
            <button className="pill" disabled={!!vlm.busy} onClick={() => runVlm('caption', 'short', 'Short caption')}>Caption: short</button>
            <button className="pill" disabled={!!vlm.busy} onClick={() => runVlm('caption', 'detailed', 'Detailed caption')}>Detailed</button>
            <button className="pill" disabled={!!vlm.busy} onClick={() => runVlm('caption', 'klein', 'Klein-style caption')}>Klein-style</button>
            <button className="pill" disabled={!!vlm.busy} onClick={() => runVlm('reverse', 'klein', 'Prompt for Klein 9B')}>Prompt → Klein</button>
            <button className="pill" disabled={!!vlm.busy} onClick={() => runVlm('reverse', 'qwen', 'Prompt for Qwen-Image 2.1')}>Prompt → Qwen</button>
          </div>
          {vlm.text && (
            <div style={{ marginTop: 8, background: 'var(--bg)', border: '1px solid var(--input)', borderRadius: 8, padding: 10 }}>
              <p className="note" style={{ margin: '0 0 4px' }}>{vlm.label}</p>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 13 }}>{vlm.text}</p>
              <div className="field-row" style={{ marginTop: 8 }}>
                <button className="btn sm" onClick={() => { void navigator.clipboard.writeText(vlm.text!); toast('Copied.', 'ok'); }}>
                  <Copy size={14} /> Copy
                </button>
                <button
                  className="btn sm"
                  onClick={() => go('generate', undefined, { prompt: vlm.text!, model: /Qwen/.test(vlm.label) ? 'qwen' : 'klein' })}
                >
                  Use as prompt
                </button>
              </div>
            </div>
          )}
        </div>
        <div>
          <p className="section-label">Prompt</p>`);
fs.writeFileSync('src/web/screens/Library.tsx', l);

// ---------------------------------------------------------------- Video
let v = fs.readFileSync('src/web/screens/Video.tsx', 'utf8');
v = rep(v, `  const [warning, setWarning] = useState<{ text: string; body: Parameters<typeof api.submit>[0] } | null>(null);`,
`  const [warning, setWarning] = useState<{ text: string; body: Parameters<typeof api.submit>[0] } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [motionUndo, setMotionUndo] = useState<string[]>([]);`);
v = rep(v, `            <p className={\`note \${words > T[vKey].max_words ? 'warn' : ''}\`} style={{ margin: '4px 0 0' }}>`,
`            <div className="field-row" style={{ marginTop: 6 }}>
              <button
                type="button"
                className="btn sm"
                disabled={!s.start || suggesting || !online}
                title={s.start ? \`Let the local Qwen3-VL write a \${vm.label} motion prompt from the start frame (and your text, if any)\` : 'Add a start frame first'}
                onClick={async () => {
                  setSuggesting(true);
                  try {
                    const r = await api.vlm({ task: 'motion', variant: vKey, text: s.motion, input: s.start!.name });
                    setMotionUndo((u) => [...u.slice(-19), s.motion]);
                    update({ motion: r.text });
                    toast(\`Motion prompt written for \${vm.label} in \${r.seconds}s.\`, 'ok');
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  } finally {
                    setSuggesting(false);
                  }
                }}
              >
                {suggesting ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} {s.motion.trim() ? 'Improve motion' : 'Suggest motion'}
              </button>
              {motionUndo.length > 0 && (
                <button type="button" className="btn sm ghost" onClick={() => { update({ motion: motionUndo[motionUndo.length - 1] }); setMotionUndo((u) => u.slice(0, -1)); }}>
                  <Undo2 size={14} /> Undo
                </button>
              )}
            </div>
            <p className={\`note \${words > T[vKey].max_words ? 'warn' : ''}\`} style={{ margin: '4px 0 0' }}>`);
v = rep(v, `import { Bell, Camera, Clapperboard, Download, FastForward, ImagePlus, Pause, Play, Repeat, Sparkles, Waves, X } from 'lucide-react';`,
`import { Bell, Camera, Clapperboard, Download, FastForward, ImagePlus, Loader2, Pause, Play, Repeat, Sparkles, Undo2, Waves, X } from 'lucide-react';`);
fs.writeFileSync('src/web/screens/Video.tsx', v);

// ---------------------------------------------------------------- Edit: auto-caption for Qwen fills when none is known
let e = fs.readFileSync('src/web/screens/Edit.tsx', 'utf8');
e = rep(e, `    const caption = captionFromLineage(lineage as unknown as CaptionSource[], item.id);`,
`    let caption = captionFromLineage(lineage as unknown as CaptionSource[], item.id);
    if (!caption && em === 'qwen' && (mode === 'inpaint' || mode === 'outpaint')) {
      // Qwen's official fill templates want a caption of the original; describe the picture once and remember it.
      toast('Describing the picture first (local Qwen3-VL)…', 'info');
      try {
        caption = (await api.vlm({ task: 'caption', variant: 'short', itemId: item.id, save: true })).text;
      } catch {
        caption = null;
      }
    }`);
fs.writeFileSync('src/web/screens/Edit.tsx', e);
console.log('phase2 ui patched');
