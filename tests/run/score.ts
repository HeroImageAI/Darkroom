/**
 * Write scores, provisional-best picks and Klein-vs-Qwen compares through the UI.
 *   npx tsx tests/run/score.ts <scores.json>
 * scores.json: { entries: [{ test, model, board, titles: [], score, why, best?: title, status? }],
 *                compares: [{ test, board, a: title, b: title }] }
 * Item ids come from the run log (library_item_name → library_item_id).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const LOG = 'tests/results/run-2026-10-03.jsonl';
const ids: Record<string, string> = {};
for (const l of fs.readFileSync(LOG, 'utf8').split(/\r?\n/)) {
  if (!l.trim()) continue;
  const d = JSON.parse(l);
  if (d.library_item_name && d.library_item_id) ids[d.library_item_name] = d.library_item_id;
}
const id = (t: string) => ids[t] ?? (() => { throw new Error('no id for ' + t); })();
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const SPEC = 'tests/results/.spec.json';
const ui = (action: string, spec: object) => {
  fs.writeFileSync(SPEC, JSON.stringify(spec));
  const out = spawnSync('npx', ['tsx', 'tests/run/ui.ts', action, SPEC], { encoding: 'utf8', shell: true });
  return (out.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('RESULT')) ?? 'RESULT ?';
};
for (const e of plan.entries ?? []) {
  for (const t of e.titles as string[]) {
    const best = e.best === t;
    console.log(t, ui('annotate', { id: id(t), board: e.board, appendNotes: `score: ${e.score}/5 — ${e.why}${best ? '\nprovisional-best' : ''}`, ...(best ? { favourite: true } : {}), log: { test_id: e.test, model: e.model, seed: 42, library_item_id: id(t), library_item_name: t, status: e.status ?? 'OK', score: e.score, provisional_best: best, notes: e.why } }));
  }
}
for (const c of plan.compares ?? []) console.log(c.test, ui('compare', { testId: c.test, a: id(c.a), b: id(c.b), labelA: c.a, labelB: c.b, title: `${c.test} · Compare Klein vs Qwen`, board: c.board }));
