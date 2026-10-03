/** Gaming / Movie input-free tests: scores, provisional-best picks and compares through the UI. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const SPEC = 'tests/results/.spec.json';
const G = 'TS 2026-10-03 · 03 Gaming';
const M = 'TS 2026-10-03 · 04 Movie';
const ui = (action: string, spec: object) => {
  fs.writeFileSync(SPEC, JSON.stringify(spec));
  const out = spawnSync('npx', ['tsx', 'tests/run/ui.ts', action, SPEC], { encoding: 'utf8', shell: true });
  return (out.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('RESULT')) ?? 'RESULT ?';
};
const GAM06K = ['63b42940-1c70-4192-a1c3-49d3fd14aa66', '3d8c561f-364f-4d4a-bcd3-6c28aaffd58a', '6b32198d-0880-4674-9c58-3e3e46670fcf', 'fdabf938-a1b6-4ad0-84ea-ddbe9e25dcb2', '55c18353-2a41-4369-abf2-a625cc3283cc'];
const GAM06Q = ['50310518-2982-4992-a5a0-69d232517ecd', '71145776-0555-416c-b46e-01e3581ab3bb', 'd372f0f9-5bec-443b-901a-ed0b5e8eef42', 'efecbebc-a99c-4359-9148-3442bbe060c9', '2350f46a-ec6d-42d1-9b32-241b0ef2fff7'];
type S = [string, string, 'Klein' | 'Qwen', string[], number, string, string | null];
const s: S[] = [
  ['GAM-IMG-05', G, 'Klein', ['317b96db-ba8e-4390-9142-d3256e2723c6'], 4, 'all 8 items in one consistent painterly style, but two read poorly (a feathered grappling hook, an odd flare gun) and there are stray numbers', null],
  ['GAM-IMG-05', G, 'Qwen', ['e4bf3466-9cd8-46ca-8c27-1f9df14f5a0c'], 4, 'cleaner and more readable, a good firing flare gun, but only 7 items (the pipe-wrench club is missing)', 'e4bf3466-9cd8-46ca-8c27-1f9df14f5a0c'],
  ['GAM-IMG-06', G, 'Klein', GAM06K, 5, 'the five sit together as one art direction: ochre + dusty teal, rim light, brushwork', GAM06K[0]],
  ['GAM-IMG-06', G, 'Qwen', GAM06Q, 4, 'cohesive, but leans golden-sepia with little of the teal', null],
  ['MOV-IMG-04', M, 'Klein', ['aa2a9816-0856-41d0-a986-646c6238abe8', '0714066c-cb59-45f1-a82c-9bb21d20d221'], 5, 'B is exactly A at night: stars, headlights on, figure gone, same truck, windmill and framing', 'aa2a9816-0856-41d0-a986-646c6238abe8'],
  ['MOV-IMG-04', M, 'Qwen', ['5baedb95-9e61-43c8-8eb3-01b5f3841b54', '401723aa-4ce3-4218-91dc-d2868b42f918'], 2, 'A is good, but B is over-processed into a crunchy HDR look and the figure is still there', null],
  ['MOV-IMG-05', M, 'Klein', ['b3302bba-0bd0-4d1f-afc6-b629f5164617'], 4, 'believable armoured anatomy with amber eyes, but reads almost entirely as pangolin', null],
  ['MOV-IMG-05', M, 'Qwen', ['6bab4038-2540-4cd3-a74a-240e0fd2886f'], 5, 'a convincing pangolin–hyena hybrid: hyena head and stance, overlapping scales, grounded on the salt flat', '6bab4038-2540-4cd3-a74a-240e0fd2886f'],
  ['MOV-IMG-08', M, 'Klein', ['ce329a8c-8d3a-4a18-919b-88ca3817b639'], 4, 'polished, right shots in order, consistent character, but the panels are numbered 1, 3, 4, 5', null],
  ['MOV-IMG-08', M, 'Qwen', ['deaf8684-ee7a-423d-acf8-db47d087612d'], 4, 'numbers 1–4 right, sequence and continuity good; the eyes panel covers the face', 'deaf8684-ee7a-423d-acf8-db47d087612d'],
];
for (const [t, board, model, ids, score, why, best] of s)
  for (const id of ids) console.log(t, model, ui('annotate', { id, board, appendNotes: `score: ${score}/5 — ${why}${best === id ? '\nprovisional-best' : ''}`, ...(best === id ? { favourite: true } : {}), log: { test_id: t, model, seed: 42, library_item_id: id, status: 'OK', score, provisional_best: best === id, notes: why } }));
const cmp: [string, string, string, string][] = [
  ['GAM-IMG-05', G, '317b96db-ba8e-4390-9142-d3256e2723c6', 'e4bf3466-9cd8-46ca-8c27-1f9df14f5a0c'],
  ['GAM-IMG-06', G, GAM06K[0], GAM06Q[0]],
  ['MOV-IMG-04', M, '0714066c-cb59-45f1-a82c-9bb21d20d221', '401723aa-4ce3-4218-91dc-d2868b42f918'],
  ['MOV-IMG-05', M, 'b3302bba-0bd0-4d1f-afc6-b629f5164617', '6bab4038-2540-4cd3-a74a-240e0fd2886f'],
  ['MOV-IMG-08', M, 'ce329a8c-8d3a-4a18-919b-88ca3817b639', 'deaf8684-ee7a-423d-acf8-db47d087612d'],
];
for (const [t, board, a, b] of cmp) console.log(t, ui('compare', { testId: t, a, b, labelA: 'Klein', labelB: 'Qwen', title: `${t} · Compare Klein vs Qwen`, board }));
// GAM-VID-05 cannot be made: Video needs a start frame
fs.appendFileSync('tests/results/run-2026-10-03.jsonl', JSON.stringify({ test_id: 'GAM-VID-05', model: 'LTX', status: 'UNSUPPORTED', notes: 'text → video: the Video screen needs a start frame', timestamp: new Date().toISOString() }) + '\n');
