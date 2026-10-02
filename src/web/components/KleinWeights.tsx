import { useEffect, useState } from 'react';
import { api } from '../api';

export interface Finetune {
  name: string;
  label: string;
  sizeGB: number;
}

let cache: Promise<Finetune[]> | null = null;
/** Your Klein 9B fine-tunes (DECISIONS 91), read once per launch (Refresh in the LoRA picker re-reads LoRAs only). */
export function loadFinetunes(): Promise<Finetune[]> {
  cache ??= api
    .get<{ finetunes: Finetune[] }>('/api/models/klein')
    .then((r) => r.finetunes)
    .catch(() => {
      cache = null;
      return [];
    });
  return cache;
}

export function useFinetunes(): Finetune[] {
  const [list, setList] = useState<Finetune[]>([]);
  useEffect(() => {
    let live = true;
    void loadFinetunes().then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, []);
  return list;
}

/** Label for the picture's model line: "Klein 9B" or "Klein 9B · <fine-tune>". */
export const kleinLabel = (weights: string | undefined, list: Finetune[]) => {
  const f = weights ? list.find((x) => x.name === weights) : undefined;
  return f ? `Klein 9B · ${f.label}` : 'Klein 9B';
};

/**
 * "Klein version": official Klein 9B or one of your fine-tunes of it. Hidden when you have none. A choice whose file
 * has gone falls back to the official model.
 */
export function KleinWeights({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const list = useFinetunes();
  useEffect(() => {
    if (value && list.length && !list.some((f) => f.name === value)) onChange('');
  }, [list, value]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list.length) return null;
  return (
    <label className="field" style={{ marginTop: 10 }} title="Your own fine-tunes of Klein 9B: files on this PC with exactly Klein 9B's layers. Your Klein LoRAs work with them too.">
      <span>Klein version</span>
      <select className="input" aria-label="Klein version" value={list.some((f) => f.name === value) ? value : ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Official Klein 9B</option>
        {list.map((f) => (
          <option key={f.name} value={f.name}>
            {f.label} ({f.sizeGB} GB)
          </option>
        ))}
      </select>
    </label>
  );
}
