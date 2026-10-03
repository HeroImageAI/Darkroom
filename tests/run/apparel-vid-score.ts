/** Apparel pilot: video scores written through the UI (notes + log). */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const SPEC = 'tests/results/.spec.json';
const B = 'TS 2026-10-03 · 01 Apparel';
const v: [string, string, number, string][] = [
  ['APP-VID-01', '1e82adce-ff18-4a63-9806-e023c17e6fe9', 3, 'smooth turn and the jacket holds through side and back views without morphing, but she only turns about 180°, not 360°'],
  ['APP-VID-02', 'a73b76ed-9ea2-4feb-86af-e86d7be75510', 4, 'natural walk, camera tracks back; the ripstop creases and catches light like nylon; consistent throughout'],
  ['APP-VID-03', 'da0596d9-a56b-4d90-9fcc-9a5c51f42257', 2, 'print stays stable, but he walks along the pool edge instead of stepping into the water, and the shot ends on an odd close-up of the shorts'],
  ['APP-VID-04', 'aa54786e-392a-4f15-9f20-8cfc4c1be206', 2, 'no hanger; a window frame appears around the jacket and at 4 s it twists and a sleeve flaps unnaturally (the garment deforms)'],
  ['APP-VID-05', 'd1f5400c-388d-4f0e-895d-eea80133447e', 4, 'black/orange changes smoothly to navy/white sweeping left to right, the shape never changes; the light band itself is barely visible'],
];
for (const [t, id, score, why] of v) {
  fs.writeFileSync(SPEC, JSON.stringify({ id, board: B, appendNotes: `score: ${score}/5 — ${why}`, log: { test_id: t, model: 'LTX', library_item_id: id, library_item_name: `${t} · LTX · Final 720p`, duration: 5, fps: 24, resolution: '1280x704 (Final)', status: ['APP-VID-04'].includes(t) ? 'OK' : t === 'APP-VID-01' || t === 'APP-VID-02' || t === 'APP-VID-03' || t === 'APP-VID-05' ? 'ADAPTED' : 'OK', score, notes: why } }));
  const out = spawnSync('npx', ['tsx', 'tests/run/ui.ts', 'annotate', SPEC], { encoding: 'utf8', shell: true });
  console.log(t, (out.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('RESULT')));
}
