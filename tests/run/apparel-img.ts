/**
 * Apparel pilot, image tests after APP-IMG-01 (prompts as written in darkroom-test-suite.md), seed 42 on Klein then
 * Qwen. Each run goes through tests/run/ui.ts (the UI) and is skipped if its titled result already exists.
 *   npx tsx tests/run/apparel-img.ts <best APP-IMG-01 id> <shorts sketch id> <sample photo id> [only=APP-IMG-02,…]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const [best01, shorts, sample, onlyArg] = process.argv.slice(2);
const only = onlyArg ? onlyArg.replace(/^only=/, '').split(',') : null;
const SPEC = 'tests/results/.spec.json';
const FABRICS = ['heavyweight cotton fleece', 'technical ripstop nylon with a slight sheen', 'raw indigo denim', 'open-weave knitted mesh', 'brushed wool melton'];
const STYLES = ['loose fashion illustration in alcohol marker with fineliner outlines', 'watercolour fashion sketch on cream paper', 'clean vector flat with flat colour fills'];
const short = (v: string) => v.split(' ').slice(0, 3).join(' ').replace(/,$/, '');

type Run = { action: string; testId: string; source: string; prompt?: string; variable?: string; refFile?: string; strength?: string; adapted?: boolean; note?: string; inputFiles?: string[]; sourceTest?: string; titleExtra?: string };
const runs: Run[] = [
  ...FABRICS.map((f) => ({ action: 'instruct', testId: 'APP-IMG-02', source: best01, sourceTest: 'APP-IMG-01', variable: f, prompt: `Same jacket, same design, same pose and framing. Change only the material to ${f}. Show realistic fabric thickness, drape, fold behaviour and surface texture. Seams and trims adapt naturally to the new fabric. Light grey studio background, soft even lighting.` })),
  {
    action: 'instruct',
    testId: 'APP-IMG-03',
    source: shorts,
    refFile: fs.readdirSync('test-inputs/APP-IMG-03').map((f) => `test-inputs/APP-IMG-03/${f}`).find((f) => f.includes('ac3336'))!,
    inputFiles: ['test-inputs/APP-IMG-03 (shorts sketch + print tile)'],
    note: 'shorts sketch edited, print tile in the Reference slot',
    prompt: "Men's swim shorts photographed flat-lay from above on a white background, made from the sketch shape, with the provided illustration repeated as an all-over print. The print wraps continuously across the side seams and waistband, scaled so roughly 4–5 motifs sit across one leg. Quick-dry polyester with a slight sheen, mesh-lined, contrast drawcord, small back pocket with a velcro flap.",
  },
  { action: 'instruct', testId: 'APP-IMG-04', source: best01, sourceTest: 'APP-IMG-01', prompt: 'A product colourway sheet showing the same jacket six times in a 3×2 grid, identical design, pose and lighting in every cell. Colourways: black with orange zip; navy with white drawcord; olive with tan trims; stone with black trims; burgundy tonal; heather grey with neon yellow zip. Clean white background, small colour label under each jacket.' },
  { action: 'instruct', testId: 'APP-IMG-06', source: best01, sourceTest: 'APP-IMG-01', prompt: 'Technical presentation board of this exact jacket shown in three views side by side: front, side and back, on invisible mannequins at identical scale. Same colour, fabric, and details in every view; the back shows a yoke seam and a hanging loop. White background, even lighting.' },
  { action: 'enhance', testId: 'APP-IMG-07', source: sample, strength: 'Restore', adapted: true, titleExtra: 'Enhance Restore', note: 'ADAPTED: Enhance has no prompt box; Darkroom Restore', inputFiles: ['test-inputs/APP-IMG-07'] },
  { action: 'instruct', testId: 'APP-IMG-07', source: sample, adapted: true, titleExtra: 'Instruct', note: 'ADAPTED: the suite prompt run as an Instruct', inputFiles: ['test-inputs/APP-IMG-07'], prompt: 'Enhance this photo into a clean high-resolution product image. Keep the garment exactly as it is — same design, colour, logos, stitching and proportions. Improve sharpness, fabric texture and lighting; remove noise; clean white background.' },
  ...STYLES.map((st) => ({ action: 'instruct', testId: 'APP-IMG-08', source: best01, sourceTest: 'APP-IMG-01', variable: st, prompt: `Redraw this jacket as a ${st}, worn by a fashion croquis figure in a relaxed pose. Keep the design, proportions and details of the jacket exactly the same.` })),
];

for (const model of ['klein', 'qwen']) {
  for (const r of runs) {
    if (only && !only.includes(r.testId)) continue;
    const name = model === 'klein' ? 'Klein' : 'Qwen';
    const title = [r.testId, name, 's42', r.titleExtra, r.variable ? short(r.variable) : null].filter(Boolean).join(' · ');
    fs.writeFileSync(SPEC, JSON.stringify({ ...r, model, seed: 42, title }));
    const t0 = Date.now();
    const out = spawnSync('npx', ['tsx', 'tests/run/ui.ts', r.action, SPEC], { encoding: 'utf8', shell: true });
    const line = (out.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('RESULT')) ?? `RESULT {"error":"no result: ${(out.stderr ?? '').slice(-300).replace(/\s+/g, ' ')}"}`;
    console.log(`${title.padEnd(60)} ${Math.round((Date.now() - t0) / 1000)}s ${line.slice(7)}`);
  }
}
