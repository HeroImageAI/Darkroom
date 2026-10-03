/** Apparel pilot videos (LTX 2.5, Final 720p, 5 s, 24 fps) through the Video screen (tests/run/ui.ts video). */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const SPEC = 'tests/results/.spec.json';
const B = 'TS 2026-10-03 · 01 Apparel';
const vids = [
  { testId: 'APP-VID-01', start: 'db0d75c8-5747-4639-aefa-8459dc0a53ac', sourceTitle: 'APP-VID-01 · helper · on-model render', sourceTest: 'APP-IMG-01', adapted: true, camera: 'Static', prompt: "A model wearing the charcoal fleece jacket stands in a bright studio against a light grey backdrop. She slowly turns a full 360 degrees on the spot, arms relaxed, the jacket's fabric shifting and folding naturally with the movement. The camera stays locked at chest height. Soft, even studio lighting." },
  { testId: 'APP-VID-02', start: '2d1a22d3-84eb-441f-be1d-6fd426a146fd', sourceTitle: 'APP-VID-02 · helper · on-model render', sourceTest: 'APP-IMG-02', adapted: true, camera: 'Pull back', prompt: 'A model walks toward the camera on a concrete runway in an industrial space wearing the ripstop nylon jacket. The fabric swings and creases with each step, catching soft highlights. The camera slowly tracks backward to keep her framed from the knees up. Cool overcast daylight from large windows.' },
  { testId: 'APP-VID-03', start: '8f1f8055-af1f-418d-a96f-30349193cea0', sourceTitle: 'APP-VID-03 · helper · on-model render', sourceTest: 'APP-IMG-03', adapted: true, prompt: 'A man in the printed swim shorts steps off the edge of a pool and walks through waist-deep clear water, then climbs out. The wet fabric darkens and clings slightly, water running off it. Bright midday sun, blue water caustics on the pool floor, the camera at water level following him.' },
  { testId: 'APP-VID-04', start: '036a01ae-d4d5-48a7-b26b-2c488a7f4838', sourceTitle: 'APP-IMG-01 · Klein · s42', sourceTest: 'APP-IMG-01', camera: 'Static', prompt: 'The jacket hangs on a wooden hanger from a rail near an open window. A gentle breeze moves the hem and sleeves; the drawcords sway. Static camera, warm late-afternoon light falling across the fabric.' },
  { testId: 'APP-VID-05', start: '30217e02-f4c4-4336-b249-f41ef1cc27e9', sourceTitle: 'APP-VID-05 · helper · crop black-orange', end: 'ca089503-ce5d-443b-b6d9-5ca8a2d74aa9', endTitle: 'APP-VID-05 · helper · crop navy-white', sourceTest: 'APP-IMG-04', adapted: true, camera: 'Static', prompt: 'The jacket stays perfectly still while a band of light sweeps slowly across it from left to right; as the light passes, the colourway changes smoothly. Static camera, clean studio background.' },
];
for (const v of vids) {
  fs.writeFileSync(SPEC, JSON.stringify({ ...v, seconds: 5, board: B, title: `${v.testId} · LTX · Final 720p` }));
  const t0 = Date.now();
  const out = spawnSync('npx', ['tsx', 'tests/run/ui.ts', 'video', SPEC], { encoding: 'utf8', shell: true });
  const line = (out.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('RESULT')) ?? 'RESULT ' + (out.stderr ?? '').slice(-300);
  console.log(v.testId, Math.round((Date.now() - t0) / 1000) + 's', line);
}
