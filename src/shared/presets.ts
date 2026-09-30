/**
 * Edit presets (Addendum 1 F). Built-ins ship read-only in presets/edit_presets.json; the user's own presets live in
 * data/user_presets.json and are deep-merged by label, so a Darkroom update never wipes them:
 *   - a user entry with the label of a built-in overrides only the fields it sets (e.g. just the Klein wording);
 *   - `hidden: true` hides a built-in;
 *   - any other label is a new preset.
 */
export interface EditPreset {
  id: string;
  label: string;
  category: string;
  klein: string;
  qwen: string;
  images?: 2;
  /** The model that did clearly better on this preset in the A/B. */
  best?: 'klein' | 'qwen';
  /** Merged result only: where it came from. */
  source?: 'built-in' | 'mine' | 'edited';
}

export type UserPreset = Partial<Omit<EditPreset, 'source'>> & { label: string; hidden?: boolean };

export function mergePresets(builtin: EditPreset[], user: UserPreset[]): EditPreset[] {
  const byLabel = new Map(user.map((u) => [u.label.trim().toLowerCase(), u]));
  const out: EditPreset[] = [];
  for (const b of builtin) {
    const u = byLabel.get(b.label.toLowerCase());
    if (u?.hidden) continue;
    out.push(u ? { ...b, ...stripUndefined(u), id: b.id, label: b.label, source: 'edited' } : { ...b, source: 'built-in' });
  }
  const builtinLabels = new Set(builtin.map((b) => b.label.toLowerCase()));
  for (const u of user) {
    if (builtinLabels.has(u.label.trim().toLowerCase()) || u.hidden) continue;
    const text = u.klein ?? u.qwen ?? '';
    if (!text) continue;
    out.push({
      id: u.id ?? `mine-${u.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      label: u.label.trim(),
      category: u.category ?? 'Mine',
      klein: u.klein ?? text,
      qwen: u.qwen ?? text,
      ...(u.images === 2 ? { images: 2 as const } : {}),
      source: 'mine',
    });
  }
  return out;
}

/** Insert or update a user preset by label (case-insensitive), keeping the rest of the file. */
export function upsertUserPreset(list: UserPreset[], p: UserPreset): UserPreset[] {
  const key = p.label.trim().toLowerCase();
  const i = list.findIndex((u) => u.label.trim().toLowerCase() === key);
  if (i < 0) return [...list, { ...p, label: p.label.trim() }];
  const next = list.slice();
  next[i] = { ...list[i], ...stripUndefined(p), label: list[i].label };
  return next;
}

/** First [BRACKET] slot in a preset text, so the UI can select it for typing. */
export function firstSlot(text: string): { start: number; end: number } | null {
  const m = /\[[A-Z0-9 _-]+\]/.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/** Filler tokens that the T2I style guide says to drop (Addendum 1 F). */
export const FILLER_TOKENS = /\b(8k|4k resolution|hyper-?realistic|masterpiece|octane render|best quality|ultra[- ]detailed|trending on artstation)\b/gi;
export function fillerIn(text: string): string[] {
  return [...new Set((text.match(FILLER_TOKENS) ?? []).map((s) => s.toLowerCase()))];
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
