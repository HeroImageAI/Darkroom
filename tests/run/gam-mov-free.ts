/**
 * Gaming and Movie tests that need no input file (prompts as written in darkroom-test-suite.md), seed 42, Klein then
 * Qwen, through the UI (tests/run/ui.ts generate / instruct). Skips anything already titled.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const SPEC = 'tests/results/.spec.json';
const G = 'TS 2026-10-03 · 03 Gaming';
const M = 'TS 2026-10-03 · 04 Movie';
const STYLE = 'Stylised painterly game concept art, warm ochre and dusty teal palette, soft rim lighting, visible brushwork, slightly exaggerated proportions.';
const SET = ['A desert market street at dusk.', 'A faction leader seated on a throne of salvaged car seats.', 'A rusted armoured truck converted into a mobile home.', 'A sandstorm approaching a canyon village.', 'An interior workshop full of half-repaired machines.'];
const ui = (action: string, spec: object) => {
  fs.writeFileSync(SPEC, JSON.stringify(spec));
  const out = spawnSync('npx', ['tsx', 'tests/run/ui.ts', action, SPEC], { encoding: 'utf8', shell: true });
  return JSON.parse(((out.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('RESULT')) ?? 'RESULT {"error":"no result"}').slice(7));
};
const name = (m: string) => (m === 'klein' ? 'Klein' : 'Qwen');

for (const model of ['klein', 'qwen']) {
  const N = name(model);
  const gen = (testId: string, board: string, prompt: string, aspect: string, variable?: string) => {
    const title = [testId, N, 's42', variable].filter(Boolean).join(' · ');
    const r = ui('generate', { testId, board, model, seed: 42, prompt, aspect, variable, title });
    console.log(title.padEnd(64), JSON.stringify(r));
    return r.id as string | undefined;
  };
  gen('GAM-IMG-05', G, 'A game prop design sheet of eight scavenged weapons and tools for the desert scavenger faction: a crossbow from car parts, a pipe-wrench club, a solar-cell lantern, a water-filter canteen, a grappling hook, a signal flare gun, a machete with a leaf-spring blade, a hand-cranked radio. Each item isolated, consistent scale indicator, flat grey background, consistent painterly style.', '16:9');
  SET.forEach((p, i) => gen('GAM-IMG-06', G, `${p} ${STYLE}`, '16:9', `${i + 1} ${p.replace(/^An? /, '').split(' ').slice(0, 3).join(' ').replace(/\.$/, '')}`));
  const a = gen('MOV-IMG-04', M, 'Wide shot: a vintage pickup truck parked beside a windmill in an empty field at blue hour. The headlights are off and a single figure leans against the bumper. Cinematic, anamorphic, muted grade.', '16:9', 'A start');
  if (a) {
    const title = `MOV-IMG-04 · ${N} · s42 · B end`;
    const r = ui('instruct', { testId: 'MOV-IMG-04', source: a, sourceTest: 'MOV-IMG-04 A', model, seed: 42, title, variable: 'B end', note: 'B run on the A output (Edit · Instruct, stacked)', prompt: "The same scene, the same camera, the same truck and windmill: now night has fallen, the truck's headlights are on, the figure has gone, and the windmill turns against a sky full of stars." });
    console.log(title.padEnd(64), JSON.stringify(r));
  }
  gen('MOV-IMG-05', M, 'Film creature concept: a large desert predator, a hybrid of a pangolin and a hyena, with overlapping armoured scales, a long low body and glowing amber eyes. Three-quarter view, standing on cracked salt flats, overcast light. Highly detailed, grounded, believable anatomy, cinematic concept art.', '16:9');
  gen('MOV-IMG-08', M, "A four-panel film storyboard in a 2×2 grid, showing a continuous sequence: 1) wide shot of a figure approaching the farmhouse at dawn, 2) close-up of a hand pushing the door open, 3) interior reverse shot of the figure in the doorway, 4) extreme close-up of the figure's eyes reacting. Consistent character, costume and lighting across panels. Charcoal and grey-wash storyboard style, panel numbers in the corners.", '1:1');
}
