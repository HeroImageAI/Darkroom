import { useEffect, useState } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import { api } from '../api';
import { MAX_LORAS, type LoraUse } from '../../shared/loras';
import { useApp } from '../store';

interface LoraInfo {
  name: string;
  label: string;
  sizeMB: number;
  declared: string | null;
}
export interface Catalogue {
  klein: LoraInfo[];
  qwen: LoraInfo[];
  ltx: LoraInfo[];
  /** LTX IC-LoRAs (video tools) */
  ltxTools: (LoraInfo & { downscale: number })[];
  other: { name: string; reason: string }[];
}

let cache: Catalogue | null = null;

/** Your LoRAs, sorted by the model they fit (read once per launch; Refresh after adding files). */
export function useLoraCatalogue(): { cat: Catalogue | null; refresh: () => void; error: string | null } {
  const online = useApp((s) => s.status?.comfy === 'online');
  const [cat, setCat] = useState<Catalogue | null>(cache);
  const [error, setError] = useState<string | null>(null);
  const load = (force = false) => {
    if (cache && !force) return setCat(cache);
    api
      .get<Catalogue>('/api/loras')
      .then((c) => {
        cache = c;
        setCat(c);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  };
  useEffect(() => {
    if (online) load();
  }, [online]); // eslint-disable-line react-hooks/exhaustive-deps
  return { cat, refresh: () => load(true), error };
}

const MODEL_NAME = { klein: 'Klein 9B', qwen: 'Qwen-Image 2.1', ltx: 'LTX 2.5' } as const;

/**
 * Your own LoRAs for the selected model (DECISIONS 86): only files whose layers match the model are offered, up to
 * three, each with a strength. Used on Generate and Edit.
 */
export function LoraPicker({ family, value, onChange, exclude }: { family: 'klein' | 'qwen' | 'ltx'; value: LoraUse[]; onChange: (v: LoraUse[]) => void; exclude?: RegExp }) {
  const { cat, refresh, error } = useLoraCatalogue();
  // LoRAs Darkroom drives itself (e.g. LTX's slow-motion, which needs its speed knob) stay out of the list
  const fits = (cat?.[family] ?? []).filter((l) => !exclude?.test(l.name));
  // a LoRA chosen earlier that is no longer installed (or no longer fits) is dropped
  useEffect(() => {
    if (!cat) return;
    const ok = value.filter((v) => fits.some((f) => f.name === v.name));
    if (ok.length !== value.length) onChange(ok);
  }, [cat, family]); // eslint-disable-line react-hooks/exhaustive-deps
  const free = fits.filter((f) => !value.some((v) => v.name === f.name));
  const label = (name: string) => fits.find((f) => f.name === name)?.label ?? name;
  const others = cat ? cat.other.length + (['klein', 'qwen', 'ltx'] as const).filter((f) => f !== family).reduce((n, f) => n + (cat[f]?.length ?? 0), 0) : 0;
  // none made for this model: one quiet line (the how-to is in its tooltip), not a paragraph on every visit
  if (cat && fits.length === 0 && !error)
    return (
      <div className="lora-picker">
        <p
          className="section-label"
          title={`Put .safetensors files made for ${MODEL_NAME[family]} in ComfyUI's models\\loras folder, then press Refresh.${others ? ` Your other ${others} LoRAs are for other models.` : ''}`}
        >
          <span>
            LoRAs <span className="lora-none">none for {MODEL_NAME[family]}</span>
          </span>
          <button type="button" className="btn ghost sm icon" title="Look for new LoRA files" aria-label="Refresh LoRAs" onClick={refresh}>
            <RefreshCw size={13} />
          </button>
        </p>
      </div>
    );
  return (
    <div className="lora-picker">
      <p className="section-label">
        LoRAs
        <button type="button" className="btn ghost sm icon" title="Look for new LoRA files" aria-label="Refresh LoRAs" onClick={refresh}>
          <RefreshCw size={13} />
        </button>
      </p>
      {value.map((v, i) => (
        <div key={v.name} className="lora-row">
          <span className="lora-name" title={v.name}>
            {label(v.name)}
          </span>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.05}
            value={v.strength}
            aria-label={`Strength of ${label(v.name)}`}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, strength: Number(e.target.value) } : x)))}
          />
          <span className="mono lora-strength">{v.strength.toFixed(2)}</span>
          <button type="button" className="btn ghost sm icon" aria-label={`Remove ${label(v.name)}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <X size={14} />
          </button>
        </div>
      ))}
      {value.length < MAX_LORAS && free.length > 0 && (
        <label className="lora-add">
          <Plus size={14} aria-hidden />
          <select aria-label="Add a LoRA" value="" onChange={(e) => e.target.value && onChange([...value, { name: e.target.value, strength: 1 }])}>
            <option value="">Add a {MODEL_NAME[family]} LoRA…</option>
            {free.map((f) => (
              <option key={f.name} value={f.name}>
                {f.label} ({f.sizeMB} MB)
              </option>
            ))}
          </select>
        </label>
      )}
      {cat && fits.length === 0 && (
        <p className="note">
          No {MODEL_NAME[family]} LoRAs found{others ? ` (your other ${others} are for other models)` : ''}. Put .safetensors files made for {MODEL_NAME[family]} in ComfyUI's
          models\loras folder, then press Refresh.
        </p>
      )}
      {cat && fits.length > 0 && value.length === 0 && others > 0 && <p className="note">Only LoRAs made for {MODEL_NAME[family]} are listed; {others} others are for other models.</p>}
      {error && <p className="note">Could not read your LoRAs: {error}</p>}
    </div>
  );
}
