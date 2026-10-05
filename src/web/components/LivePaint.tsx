import { useEffect, useRef, useState } from 'react';
import { Layers, Loader2, Maximize2, Minimize2, Radio, X } from 'lucide-react';
import { api } from '../api';
import { onJob, toast } from '../store';
import { usePersistent } from '../lib/hooks';
import { composeImagePrompt, type PromptTemplates } from '../../shared/prompts';
import type { CanvasDoc } from '../lib/doc';

/**
 * Live painting (v3.30, DECISIONS 132): while you paint, Klein 9B renders the canvas the way Sketch does ("turn this
 * drawing into …") at 0.25 MP — ~4 s a frame on this PC — and the newest frame is shown beside it. It renders when you
 * pause (0.9 s after the last change); a newer change cancels the frame still rendering. (Refine, img2img at a
 * strength, was tried first: it keeps flat painted shapes flat.) Frames are never Library items; Keep makes a layer.
 */
const WAIT_MS = 900;
const MAX_SIDE = 1024; // the frame renders at ~0.5 MP; a smaller upload is quicker

const outputUrl = (f: { filename: string; subfolder?: string; type?: string }) =>
  `/api/output?${new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output' })}`;

export function LivePanel({ doc, docVer, T, onKeep, onClose }: { doc: CanvasDoc; docVer: number; T: PromptTemplates; onKeep: (url: string) => void; onClose: () => void }) {
  const [prompt, setPrompt] = usePersistent('live.prompt', '');
  const [keepColours, setKeepColours] = usePersistent('live.keepColours', true);
  const [big, setBig] = usePersistent('live.big', false);
  const [frame, setFrame] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'idle' | 'waiting' | 'rendering' | 'done' | 'error'; at?: number; seconds?: number; text?: string }>({ kind: 'idle' });
  const [, tick] = useState(0);
  const job = useRef<string | null>(null);
  const seed = useRef(Math.floor(Math.random() * 2 ** 31)); // one seed while live is on: frames change with your paint, not by chance
  const startedAt = useRef(0);

  // the render loop: wait for a pause, cancel the frame in flight, send the canvas as it is now
  useEffect(() => {
    setStatus((s) => (s.kind === 'rendering' ? s : { kind: 'waiting' }));
    const t = window.setTimeout(() => void render(), WAIT_MS);
    return () => window.clearTimeout(t);
  }, [docVer, prompt, keepColours]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () =>
      onJob((j) => {
        if (j.id !== job.current) return;
        if (j.status === 'done') {
          const f = (j.meta as { files?: { filename: string; subfolder?: string; type?: string }[] }).files?.[0];
          if (f) setFrame(outputUrl(f));
          job.current = null;
          setStatus({ kind: 'done', seconds: Math.round((Date.now() - startedAt.current) / 100) / 10 });
        } else if (j.status === 'error' || j.status === 'lost') {
          job.current = null;
          setStatus({ kind: 'error', text: j.error ?? 'The frame did not render.' });
        }
      }),
    [],
  );
  // a seconds counter while a frame renders
  useEffect(() => {
    if (status.kind !== 'rendering') return;
    const t = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [status.kind]);
  // leaving live (or Edit): the frame in flight is not needed any more
  useEffect(() => () => void (job.current && api.cancel(job.current).catch(() => undefined)), []);

  const render = async () => {
    const stale = job.current;
    job.current = null;
    if (stale) void api.cancel(stale).catch(() => undefined);
    try {
      const flat = doc.flatten();
      const s = Math.min(1, MAX_SIDE / Math.max(flat.width, flat.height));
      const c = document.createElement('canvas');
      c.width = Math.round(flat.width * s);
      c.height = Math.round(flat.height * s);
      c.getContext('2d')!.drawImage(flat, 0, 0, c.width, c.height);
      const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('frame'))), 'image/png'));
      const up = await api.upload(blob, 'live.png');
      const what = prompt.trim().replace(/\.$/, '') || 'a finished, detailed picture with natural light';
      // the Sketch wording (DECISIONS 128): follow the drawing, keep the colours painted on it
      let text = `Turn this drawing into ${what}. Follow the drawing: the same outline, proportions, details and composition.`;
      if (keepColours) text += ' Keep the colours as they are painted on the drawing.';
      const j = await api.submit({
        workflow: 'klein_edit_live',
        params: { prompt: composeImagePrompt(T, { model: 'klein', mode: 'instruct', text }), image_1: up.name, seed: seed.current, output: 'darkroom/live/frame' },
        meta: { mode: 'live', model: 'Klein 9B live', preview: true, prompt: what },
      });
      job.current = j.id;
      startedAt.current = Date.now();
      setStatus({ kind: 'rendering', at: Date.now() });
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message });
    }
  };

  const label =
    status.kind === 'rendering'
      ? `Rendering… ${Math.round((Date.now() - (status.at ?? Date.now())) / 1000)} s`
      : status.kind === 'waiting'
        ? 'Waiting for you to pause…'
        : status.kind === 'done'
          ? `Up to date · ${status.seconds} s`
          : status.kind === 'error'
            ? status.text
            : 'Paint, then pause';

  return (
    <aside className={`live-panel ${big ? 'big' : ''}`} aria-label="Live" onPointerDown={(e) => e.stopPropagation()}>
      <header>
        <Radio size={14} className={status.kind === 'rendering' ? 'live-on' : ''} />
        <strong>Live · Klein 9B</strong>
        <span className="note live-status" role="status">
          {status.kind === 'rendering' && <Loader2 size={12} className="spin" />} {label}
        </span>
        <button className="btn ghost sm icon" onClick={() => setBig(!big)} aria-label={big ? 'Smaller' : 'Bigger'} title={big ? 'Smaller' : 'Bigger'}>
          {big ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button className="btn ghost sm icon" onClick={onClose} aria-label="Stop live" title="Stop live">
          <X size={14} />
        </button>
      </header>
      <div className="live-frame">{frame ? <img src={frame} alt="Live frame" /> : <span className="note">Paint, then pause: the first frame appears a few seconds later.</span>}</div>
      <input className="input" aria-label="Live: what it should look like" placeholder="What it should look like, e.g. a leather sneaker, studio photo" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <label className="check">
        <input type="checkbox" checked={keepColours} onChange={(e) => setKeepColours(e.target.checked)} /> Keep the colours I paint
      </label>
      <button
        className="btn sm"
        disabled={!frame}
        onClick={() => {
          if (!frame) return;
          onKeep(frame);
          toast('The live frame is a layer now. Paint over it and Live carries on from there.', 'ok');
        }}
      >
        <Layers size={14} /> Keep as layer
      </button>
    </aside>
  );
}
