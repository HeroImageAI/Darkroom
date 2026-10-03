/** Apparel pilot: scores, provisional-best picks and Klein-vs-Qwen compares, written through the UI (tests/run/ui.ts). */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const ids: Record<string, string> = JSON.parse(fs.readFileSync('tests/results/.ids.json', 'utf8'));
const SPEC = 'tests/results/.spec.json';
const B = 'TS 2026-10-03 · 01 Apparel';
const ui = (action: string, spec: object) => {
  fs.writeFileSync(SPEC, JSON.stringify(spec));
  const out = spawnSync('npx', ['tsx', 'tests/run/ui.ts', action, SPEC], { encoding: 'utf8', shell: true });
  return (out.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('RESULT')) ?? 'RESULT ' + (out.stderr ?? '').slice(-200);
};
const id = (title: string) => {
  const v = ids[title];
  if (!v) throw new Error('no id for ' + title);
  return v;
};

type Score = { test: string; model: 'Klein' | 'Qwen'; titles: string[]; score: number; why: string; best?: string };
const scores: Score[] = [
  { test: 'APP-IMG-02', model: 'Klein', titles: ['heavyweight cotton fleece', 'technical ripstop nylon', 'raw indigo denim', 'open-weave knitted mesh', 'brushed wool melton'].map((v) => `APP-IMG-02 · Klein · s42 · ${v}`), score: 4, why: 'every fabric reads clearly (melton, mesh, denim, ripstop sheen) and the form holds, but the colour drifts away from charcoal (brown melton, olive fleece) although only the material was to change', best: 'APP-IMG-02 · Klein · s42 · technical ripstop nylon' },
  { test: 'APP-IMG-02', model: 'Qwen', titles: ['heavyweight cotton fleece', 'technical ripstop nylon', 'raw indigo denim', 'open-weave knitted mesh', 'brushed wool melton'].map((v) => `APP-IMG-02 · Qwen · s42 · ${v}`), score: 3, why: 'colour and form perfectly kept, but fabrics are subtle: melton and fleece look alike; denim, ripstop and mesh read' },
  { test: 'APP-IMG-03', model: 'Klein', titles: ['APP-IMG-03 · Klein · s42'], score: 4, why: 'all-over print front and back, the tile kept faithfully at ~4–5 motifs per leg, continuous across seams; keeps the sketch\'s two views rather than one flat-lay', best: 'APP-IMG-03 · Klein · s42' },
  { test: 'APP-IMG-03', model: 'Qwen', titles: ['APP-IMG-03 · Qwen · s42'], score: 2, why: 'half done: back printed, front left as the white line sketch with print only on the side panels' },
  { test: 'APP-IMG-04', model: 'Klein', titles: ['APP-IMG-04 · Klein · s42'], score: 4, why: 'six colourways correct, design locked; labels partly garbled and some under the wrong jacket', best: 'APP-IMG-04 · Klein · s42' },
  { test: 'APP-IMG-04', model: 'Qwen', titles: ['APP-IMG-04 · Qwen · s42'], score: 3, why: 'colours and design right, but every label is gibberish (the suite expected Qwen to win on labels)' },
  { test: 'APP-IMG-06', model: 'Klein', titles: ['APP-IMG-06 · Klein · s42'], score: 3, why: 'consistent views, but a flat side view and a stray cord down the back; yoke seam yes, hanging loop no' },
  { test: 'APP-IMG-06', model: 'Qwen', titles: ['APP-IMG-06 · Qwen · s42'], score: 4, why: 'consistent, believable front/side/back with the yoke seam; mannequins show arms (not invisible), no hanging loop', best: 'APP-IMG-06 · Qwen · s42' },
  { test: 'APP-IMG-07', model: 'Klein', titles: ['APP-IMG-07 · Klein · s42 · Enhance Restore', 'APP-IMG-07 · Klein · s42 · Instruct'], score: 4, why: 'garment, colour, stitching and the TZ logo kept, nothing invented; the input was already a clean 800×1200 shot, so sharpening cannot really be judged', best: 'APP-IMG-07 · Klein · s42 · Enhance Restore' },
  { test: 'APP-IMG-07', model: 'Qwen', titles: ['APP-IMG-07 · Qwen · s42 · Enhance Restore', 'APP-IMG-07 · Qwen · s42 · Instruct'], score: 4, why: 'same as Klein: faithful, logo intact, nothing invented; input too clean to show sharpening' },
  { test: 'APP-IMG-08', model: 'Klein', titles: ['loose fashion illustration', 'watercolour fashion sketch', 'clean vector flat'].map((v) => `APP-IMG-08 · Klein · s42 · ${v}`), score: 4, why: 'three convincing styles with the jacket details kept; marker and watercolour drift the charcoal to brown/mauve', best: 'APP-IMG-08 · Klein · s42 · loose fashion illustration' },
  { test: 'APP-IMG-08', model: 'Qwen', titles: ['loose fashion illustration', 'watercolour fashion sketch', 'clean vector flat'].map((v) => `APP-IMG-08 · Qwen · s42 · ${v}`), score: 3, why: '"alcohol marker" came out as grey pencil, watercolour faint, details simplified, the vector figure faceless and cropped' },
];

for (const s of scores) {
  for (const t of s.titles) {
    const best = s.best === t;
    console.log(t, ui('annotate', { id: id(t), board: B, appendNotes: `score: ${s.score}/5 — ${s.why}${best ? '\nprovisional-best' : ''}`, ...(best ? { favourite: true } : {}), log: { test_id: s.test, model: s.model, seed: 42, library_item_id: id(t), library_item_name: t, status: t.includes('APP-IMG-07') ? 'ADAPTED' : 'OK', score: s.score, provisional_best: best, notes: s.why } }));
  }
}
const compares: [string, string, string][] = [
  ['APP-IMG-02', 'APP-IMG-02 · Klein · s42 · technical ripstop nylon', 'APP-IMG-02 · Qwen · s42 · technical ripstop nylon'],
  ['APP-IMG-03', 'APP-IMG-03 · Klein · s42', 'APP-IMG-03 · Qwen · s42'],
  ['APP-IMG-04', 'APP-IMG-04 · Klein · s42', 'APP-IMG-04 · Qwen · s42'],
  ['APP-IMG-06', 'APP-IMG-06 · Klein · s42', 'APP-IMG-06 · Qwen · s42'],
  ['APP-IMG-07', 'APP-IMG-07 · Klein · s42 · Enhance Restore', 'APP-IMG-07 · Qwen · s42 · Enhance Restore'],
  ['APP-IMG-08', 'APP-IMG-08 · Klein · s42 · loose fashion illustration', 'APP-IMG-08 · Qwen · s42 · loose fashion illustration'],
];
for (const [t, a, b] of compares) console.log(t, ui('compare', { testId: t, a: id(a), b: id(b), labelA: a, labelB: b, title: `${t} · Compare Klein vs Qwen`, board: B }));
