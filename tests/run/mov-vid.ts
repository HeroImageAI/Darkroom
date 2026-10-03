/** Movie videos that need no input file (MOV-VID-02, -03 ×3, -05), LTX Final 720p 5 s, through the Video screen. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const SPEC = 'tests/results/.spec.json';
const M = 'TS 2026-10-03 · 04 Movie';
const vids = [
  { testId: 'MOV-VID-02', title: 'MOV-VID-02 · LTX · Final 720p', start: 'aa2a9816-0856-41d0-a986-646c6238abe8', sourceTitle: 'MOV-IMG-04 · Klein · s42 · A start', end: '0714066c-cb59-45f1-a82c-9bb21d20d221', endTitle: 'MOV-IMG-04 · Klein · s42 · B end', sourceTest: 'MOV-IMG-04', camera: 'Static', prompt: "Static wide shot. Time passes: the figure walks out of frame, the sky darkens from blue hour to a star-filled night, the truck's headlights switch on and the windmill begins turning." },
  { testId: 'MOV-VID-05', title: 'MOV-VID-05 · LTX · Final 720p', start: '6bab4038-2540-4cd3-a74a-240e0fd2886f', sourceTitle: 'MOV-IMG-05 · Qwen · s42', sourceTest: 'MOV-IMG-05', prompt: 'The armoured creature prowls slowly across the cracked salt flats, its scales shifting and overlapping as its body flexes, head low and sweeping side to side. The camera tracks with it at a low angle. Overcast, flat light, wind lifting fine salt dust.' },
  { testId: 'MOV-VID-03', title: 'MOV-VID-03 · LTX · Final 720p · clip 1', start: 'd7c163ff-ea46-4ce6-bd61-46ebb28a5042', sourceTitle: 'MOV-VID-03 · helper · panel 1', sourceTest: 'MOV-IMG-08', adapted: true, camera: 'Static', prompt: 'A wide shot: the figure walks slowly toward the farmhouse across dry grass at dawn, the camera static.' },
  { testId: 'MOV-VID-03', title: 'MOV-VID-03 · LTX · Final 720p · clip 2', start: 'c00a4dc0-d6c9-4dd8-818e-734b83b3a224', sourceTitle: 'MOV-VID-03 · helper · panel 2', sourceTest: 'MOV-IMG-08', adapted: true, prompt: 'A close-up: a weathered hand pushes the wooden door open, and dust falls from the frame.' },
  { testId: 'MOV-VID-03', title: 'MOV-VID-03 · LTX · Final 720p · clip 3', start: '44581c37-9477-4a9f-94b9-275c80c07b96', sourceTitle: 'MOV-VID-03 · helper · panel 3', sourceTest: 'MOV-IMG-08', adapted: true, prompt: 'An interior reverse shot: the figure steps into the doorway, backlit, and pauses.' },
];
for (const v of vids) {
  fs.writeFileSync(SPEC, JSON.stringify({ ...v, seconds: 5, board: M }));
  const t0 = Date.now();
  const out = spawnSync('npx', ['tsx', 'tests/run/ui.ts', 'video', SPEC], { encoding: 'utf8', shell: true });
  console.log(v.title, Math.round((Date.now() - t0) / 1000) + 's', (out.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('RESULT')) ?? (out.stderr ?? '').slice(-200));
}
