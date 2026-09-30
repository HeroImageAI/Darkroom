import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../store';
import { firstSlot, type EditPreset } from '../../shared/presets';

/**
 * Edit presets (Addendum 1 F): built-ins from presets/edit_presets.json merged with the user's own. Applying one writes
 * the wording for the selected model into the instruction box and selects the first [BRACKET] slot for typing.
 */
export function PresetPicker({
  model,
  textarea,
  value,
  onApply,
  hasReference,
}: {
  model: 'klein' | 'qwen';
  textarea: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onApply: (text: string) => void;
  hasReference: boolean;
}) {
  const [presets, setPresets] = useState<EditPreset[]>([]);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const load = () =>
    api
      .get<{ presets: EditPreset[] }>('/api/presets')
      .then((r) => setPresets(r.presets))
      .catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);

  // switching model after applying a preset swaps in that model's wording, unless the user has edited the text
  const [applied, setApplied] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => {
    if (!applied || value !== applied.text) return;
    const p = presets.find((x) => x.id === applied.id);
    if (p && p[model] !== applied.text) {
      setApplied({ id: p.id, text: p[model] });
      onApply(p[model]);
    }
  }, [model]); // eslint-disable-line react-hooks/exhaustive-deps

  const categories = [...new Set(presets.map((p) => p.category))];
  const apply = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    const text = p[model];
    setApplied({ id: p.id, text });
    onApply(text);
    if (p.images === 2 && !hasReference) toast(`"${p.label}" uses two pictures: add the second one in the Reference slot.`, 'info', 7000);
    else if (p.best && p.best !== model) toast(`"${p.label}" works best with ${p.best === 'klein' ? 'Klein 9B' : 'Qwen-Image 2.1'} (A/B tested).`, 'info', 7000);
    // select the first [BRACKET] slot once React has written the text
    requestAnimationFrame(() => {
      const s = firstSlot(text);
      const ta = textarea.current;
      if (!ta) return;
      ta.focus();
      if (s) ta.setSelectionRange(s.start, s.end);
    });
  };
  const save = async () => {
    if (!name.trim() || !value.trim()) return;
    try {
      await api.put('/api/presets/mine', { label: name.trim(), category: 'Mine', [model]: value.trim() });
      toast(`Saved "${name.trim()}" to your presets.`, 'ok');
      setSaving(false);
      setName('');
      void load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="field-row" style={{ marginTop: 6, gap: 6, flexWrap: 'wrap' }}>
      <select className="input" aria-label="Presets" value="" onChange={(e) => apply(e.target.value)} style={{ flex: 1, minWidth: 160 }}>
        <option value="">Presets…</option>
        {categories.map((c) => (
          <optgroup key={c} label={c}>
            {presets
              .filter((p) => p.category === c)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.images === 2 ? ' (2 pictures)' : ''}
                  {p.best && p.best !== model ? ` · best on ${p.best === 'klein' ? 'Klein' : 'Qwen'}` : ''}
                  {p.source === 'edited' ? ' *' : ''}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      {saving ? (
        <>
          <input className="input" aria-label="Preset name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} style={{ width: 130 }} />
          <button className="btn sm" onClick={() => void save()} disabled={!name.trim() || !value.trim()}>
            Save
          </button>
        </>
      ) : (
        <button className="btn sm ghost" onClick={() => setSaving(true)} disabled={!value.trim()} title="Keep this instruction as your own preset (stored in data/user_presets.json)">
          Save as my preset
        </button>
      )}
    </div>
  );
}
