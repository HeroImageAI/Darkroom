/**
 * Step lists for Footwear, Gaming, Movie and Automotive (prompts as written in darkroom-test-suite.md), in phases:
 *   A  inputs + root tests (nothing depends on a pick yet)
 *   B  tests built on the provisional-best picks of A          (needs tests/results/picks.json)
 *   C  videos                                                   (needs picks of A and B)
 * Usage: npx tsx tests/run/plans.ts <A|B|C> > tests/results/plan-<x>.json, then tests/run/plan.ts runs it.
 */
import fs from 'node:fs';

const phase = process.argv[2];
const picks: Record<string, string> = fs.existsSync('tests/results/picks.json') ? JSON.parse(fs.readFileSync('tests/results/picks.json', 'utf8')) : {};
const pick = (k: string) => {
  if (!picks[k]) throw new Error(`pick for ${k} missing in tests/results/picks.json`);
  return picks[k];
};
const BOARD = { FTW: 'TS 2026-10-03 · 02 Footwear', GAM: 'TS 2026-10-03 · 03 Gaming', MOV: 'TS 2026-10-03 · 04 Movie', AUT: 'TS 2026-10-03 · 05 Automotive' } as const;
const file = (t: string) => {
  const f = fs.readdirSync(`test-inputs/${t}`).find((x) => !x.startsWith('PUT'))!;
  return `test-inputs/${t}/${f}`;
};
const steps: Record<string, unknown>[] = [];
const MODELS = [['klein', 'Klein'], ['qwen', 'Qwen']] as const;
const short = (v: string) => v.split(' ').slice(0, 3).join(' ').replace(/[,.]$/, '');
const input = (t: string, what: string, ind: keyof typeof BOARD) => {
  steps.push({ action: 'upload', testId: t, file: file(t), title: `${t} · input · ${what}`, board: BOARD[ind] });
  return `${t} · input · ${what}`;
};
/** one edit per model (Instruct / Inpaint / Enhance), named {test} · {model} · s42 · {variable} */
const edit = (action: string, t: string, sourceTitle: string | ((m: string) => string), prompt: string | undefined, extra: Record<string, unknown> = {}, variable?: string, note?: string) => {
  for (const [m, N] of MODELS) {
    const title = [t, N, 's42', extra.titleExtra, variable ? short(variable) : null].filter(Boolean).join(' · ');
    steps.push({ action, testId: t, sourceTitle: typeof sourceTitle === 'function' ? sourceTitle(N) : sourceTitle, model: m, seed: 42, prompt, variable, title, note, ...extra });
  }
};
const video = (t: string, ind: keyof typeof BOARD, startTitle: string, prompt: string, extra: Record<string, unknown> = {}) =>
  steps.push({ action: 'video', testId: t, board: BOARD[ind], startTitle, sourceTitle: startTitle, prompt, seconds: 5, title: `${t} · LTX · Final 720p`, ...extra });

if (phase === 'A') {
  // ---------------- Footwear
  const ftwSketch = input('FTW-IMG-01', 'side sketch', 'FTW');
  const ftwSole = input('FTW-IMG-03', 'sole sketch', 'FTW');
  const ftwRef = input('FTW-IMG-07', 'reference photo', 'FTW');
  const ftwProto = input('FTW-IMG-08', 'prototype photo', 'FTW');
  edit('instruct', 'FTW-IMG-01', ftwSketch, 'Turn this side-profile sketch into a photorealistic product render of the shoe, lateral view, on a seamless white background with a soft contact shadow. Preserve the exact silhouette: sole stack height, toe spring, heel counter shape, collar line and all overlay lines. Engineered mesh upper in white, grey suede overlays, a sculpted foam midsole in off-white, a black rubber outsole. Studio lighting, sharp focus.');
  edit('inpaint', 'FTW-IMG-03', ftwSole, 'Replace the outsole pattern with an aggressive trail tread: multi-directional 5 mm lugs, a deeper heel brake zone, and a flex groove across the forefoot. Black rubber, matching the existing lighting and perspective.', { selectText: 'outsole' }, undefined, 'input is a sole sketch, not a render; mask by Smart select "outsole"');
  edit('instruct', 'FTW-IMG-07', ftwRef, "Design a new lifestyle sneaker inspired by the forms, textures and colours of this reference image — don't copy it literally; translate its character into the sole shape, panel lines and materials. Lateral view, photorealistic product render, white background.", {}, undefined, 'input is a shoe photo, not a natural/architectural reference; run as an Instruct on it');
  edit('enhance', 'FTW-IMG-08', ftwProto, undefined, { strength: 'Restore', adapted: true, titleExtra: 'Enhance Restore' }, undefined, 'ADAPTED: Enhance has no prompt box; input is a clean render, not a low-res photo');
  edit('instruct', 'FTW-IMG-08', ftwProto, 'Enhance into a clean high-resolution product photo. Keep the shoe exactly as it is: same shape, stitching, materials and colours. Remove noise; sharpen textures; white background with a soft shadow.', { adapted: true, titleExtra: 'Instruct' }, undefined, 'ADAPTED: the suite prompt as an Instruct');
  // ---------------- Gaming
  const gamSketch = input('GAM-IMG-01', 'character sketch', 'GAM');
  const gamThumb = input('GAM-IMG-03', 'environment', 'GAM');
  const gamLand = input('GAM-IMG-04', 'landscape', 'GAM');
  edit('instruct', 'GAM-IMG-01', gamSketch, 'Render this character sketch as finished game concept art: a desert scavenger in layered sun-bleached cloth, scavenged armour plates, goggles, and a backpack of salvaged tools. Full body, neutral standing pose matching the sketch, plain mid-grey background. Stylised realism, painterly detail, clear readable silhouette.', {}, undefined, 'input sketch is a mech/cyborg, not a desert scavenger');
  edit('instruct', 'GAM-IMG-03', gamThumb, 'Develop this thumbnail into a finished game environment concept: an abandoned desert outpost built into a canyon wall, rope bridges, wind turbines made from scrap, late-afternoon sun with long shadows and a dusty haze. Keep the composition, horizon line and major value shapes from the thumbnail. Wide cinematic aspect ratio.', {}, undefined, 'input is already a painted environment, not a rough thumbnail');
  for (const st of ['post-apocalyptic overgrown ruin', 'high-fantasy mountain citadel', 'cyberpunk megacity at night'])
    edit('instruct', 'GAM-IMG-04', gamLand, `Transform this landscape capture into game environment concept art as a ${st}. Keep the terrain shape, horizon line and camera angle from the capture, and replace the content and mood completely. Painterly concept art, strong atmospheric perspective.`, {}, st, 'input is a painted sci-fi landscape (no Google Earth capture)');
  // ---------------- Movie
  const movSketch = input('MOV-IMG-01', 'composition sketch', 'MOV');
  const movLoc = input('MOV-IMG-06', 'location photo', 'MOV');
  edit('instruct', 'MOV-IMG-01', movSketch, 'Develop this rough composition into a cinematic film keyframe: a lone figure stands silhouetted in the doorway of a derelict farmhouse as harsh dawn light floods the dusty interior. Keep the composition and camera framing from the sketch exactly. Anamorphic widescreen, volumetric light beams, film grain, muted colour grade.', {}, undefined, 'input is a three-panel storyboard page, not one composition');
  for (const g of ['1970s sci-fi', 'gothic horror', 'post-flood dystopia'])
    edit('instruct', 'MOV-IMG-06', movLoc, `Reimagine this location as a ${g} film set. Keep the layout, perspective and camera position of the photo; change the architecture dressing, props, lighting and atmosphere to fit the genre. Cinematic keyframe, film grain.`, {}, g);
  // ---------------- Automotive
  const autSketch = input('AUT-IMG-01', 'side sketch', 'AUT');
  const autRender = input('AUT-IMG-04', 'front three-quarter render', 'AUT');
  edit('instruct', 'AUT-IMG-01', autSketch, 'Turn this side-view car sketch into a photorealistic studio render, exact side profile, on a seamless white-to-grey studio background with a soft floor reflection. Preserve the proportions exactly: wheelbase, front and rear overhangs, greenhouse shape, beltline, wheel arch positions and all feature lines from the sketch. Gloss metallic silver paint, dark tinted glass, multi-spoke alloy wheels.');
  for (const l of ['a thin horizontal LED blade with a vertical daytime-running-light signature', 'four stacked rectangular projector modules', 'a hidden light behind a smoked full-width light bar'])
    edit('inpaint', 'AUT-IMG-04', autRender, `Replace the headlight with ${l}. Match the body surfaces, paint, perspective and studio lighting exactly.`, { selectText: 'headlight' }, l, 'mask by Smart select "headlight"');
  // fidelity progression: three Instructs in a row on the sketch, per model (one stack of 4)
  const steps7 = ['Develop this sketch into a refined designer\'s marker rendering on grey paper: confident lines, grey marker tones, white highlights, a touch of colour in the lights.', 'Develop this marker rendering into a polished digital rendering with accurate reflections, still showing a slight illustrative quality.', 'Develop this into a production-ready photoreal studio image of the car in metallic deep green paint.'];
  for (const [m, N] of MODELS)
    steps7.forEach((p, i) => steps.push({ action: 'instruct', testId: 'AUT-IMG-07', model: m, seed: 42, prompt: p, sourceTitle: i === 0 ? autSketch : `AUT-IMG-07 · ${N} · s42 · step ${i}`, title: `AUT-IMG-07 · ${N} · s42 · step ${i + 1}`, variable: `step ${i + 1}`, note: i ? `on step ${i}` : 'on the sketch' }));
} else if (phase === 'B') {
  edit('instruct', 'FTW-IMG-02', pick('FTW-IMG-01'), 'Same shoe, same view and silhouette. Rework the materials by zone: upper in a coarse recycled knit with visible yarn texture; toe and heel overlays in smooth full-grain leather; the eyestay in matte TPU film; midsole in a translucent blue-tinted foam; outsole in gum rubber. Clean, crisp boundaries between every material zone.');
  edit('instruct', 'FTW-IMG-04', pick('FTW-IMG-01'), 'Colourway sheet of the same running shoe shown six times in lateral view, in a 3×2 grid, identical shape and lighting. Colourways: triple white; black and volt green; sand and terracotta; navy with a red heel; grey gradient fading to white; all black with a reflective silver accent. White background, small label under each shoe.');
  edit('instruct', 'FTW-IMG-05', pick('FTW-IMG-01'), 'Footwear presentation board of this exact shoe in four views at identical scale: lateral, medial, top-down and rear heel. Same materials and colours in every view. White background, even studio lighting.');
  for (const st of ['grey clay render with no materials or colour', 'designer marker sketch with grey tones and a single colour accent', 'exploded view showing each component floating apart'])
    edit('instruct', 'FTW-IMG-06', pick('FTW-IMG-01'), `Present this shoe as a ${st}. Keep its exact shape and proportions.`, {}, st);
  edit('instruct', 'GAM-IMG-02', pick('GAM-IMG-01'), 'Character turnaround sheet of this exact character: front, three-quarter, side and back views in a row at identical scale, neutral A-pose, flat mid-grey background, even lighting. Every costume detail and colour is consistent across all views.');
  edit('inpaint', 'GAM-IMG-07', pick('GAM-IMG-01'), 'Replace the torso armour with a padded leather harness carrying three glass vials of glowing blue liquid. Match the existing painting style, lighting and colour palette.', { selectText: 'chest armor' }, undefined, 'mask by Smart select "chest armor"');
  edit('enhance', 'GAM-IMG-08', pick('GAM-IMG-03'), undefined, { strength: 'Restore', adapted: true, titleExtra: 'Enhance Restore' }, undefined, 'ADAPTED: Enhance has no prompt box');
  edit('instruct', 'GAM-IMG-08', pick('GAM-IMG-03'), "Refine this concept art to presentation quality: sharper details, cleaner edges, richer texture. Don't change the composition, design or colours.", { adapted: true, titleExtra: 'Instruct' });
  for (const l of ['blue pre-dawn twilight', 'harsh noon sun', 'deep orange sunset', 'moonlight with a single lantern', 'a violent thunderstorm with lightning'])
    edit('instruct', 'MOV-IMG-02', pick('MOV-IMG-01'), `Same scene, composition, figure and camera. Change only the lighting and atmosphere to ${l}. Cinematic, physically motivated light.`, {}, l);
  edit('outpaint', 'MOV-IMG-03', pick('MOV-IMG-01'), 'Extend the scene outward to reveal the farmhouse exterior and a vast empty Karoo-like landscape stretching to a distant mountain range under a wide sky. Match the lighting, perspective, grain and colour grade of the original image seamlessly.', { padFrac: { left: 0.5, right: 0.5 } }, undefined, 'canvas 2× wide: half the width added on each side');
  for (const st of ['loose digital speed-paint', 'photoreal VFX previs frame', 'charcoal storyboard panel'])
    edit('instruct', 'MOV-IMG-07', pick('MOV-IMG-01'), `Re-render this keyframe as a ${st}. Keep the composition and lighting design.`, {}, st);
  edit('instruct', 'AUT-IMG-02', pick('AUT-IMG-01'), 'The same car rendered as a full-size design-studio clay model: matte warm-grey clay, no paint, no glass tint, no badges, the wheels as clay too. Three-quarter front view, studio lighting with long softbox highlights so the surface transitions and feature lines are clearly visible.');
  edit('instruct', 'AUT-IMG-03', pick('AUT-IMG-01'), 'The same car, three-quarter front view, finished in mirror chrome, in a studio with evenly spaced vertical strip lights reflected in the surfaces. The reflection lines run cleanly and continuously across the panels.');
  edit('inpaint', 'AUT-IMG-05', pick('AUT-IMG-01'), 'Replace both wheels with 21-inch aero-cover wheels in gloss black with a thin machined silver edge, low-profile tyres. Same perspective as the existing wheels, sitting correctly in the arches.', { selectText: 'wheel' }, undefined, 'mask by Smart select "wheel" (both wheels)');
  edit('instruct', 'AUT-IMG-06', pick('AUT-IMG-01'), 'Automotive design presentation board of this exact car in four views at consistent scale: front, rear, side profile and top-down plan. Same paint, wheels and details in every view. Clean white background, studio lighting.');
  edit('instruct', 'AUT-IMG-08', pick('AUT-IMG-01'), 'Paint and finish study: the same car shown six times in side profile in a 3×2 grid. Finishes: gloss solid red; metallic midnight blue; matte satin grey; pearl white; two-tone black roof over copper; liquid-metal silver. Identical lighting and angle; small label under each.');
} else if (phase === 'C') {
  for (const s of (picks['C:helpers'] ? JSON.parse(picks['C:helpers']) : []) as Record<string, unknown>[]) steps.push(s);
  video('FTW-VID-01', 'FTW', pick('FTW-IMG-02'), 'The shoe sits on a slowly rotating white plinth and turns a full 360 degrees. Static camera at sole height, slightly below eye line. Soft studio lighting with a gentle rim light tracing the silhouette.');
  video('FTW-VID-02', 'FTW', 'FTW-VID-02 · helper · on-foot render', "A close-up, low-angle shot of a runner's foot in the shoe striking a wet asphalt road. The midsole compresses visibly on landing, the forefoot flexes at toe-off, and a fine spray of water lifts from the surface. Slow motion, the camera tracking alongside at ground level, early-morning golden light.", { adapted: true });
  video('FTW-VID-03', 'FTW', pick('FTW-IMG-01'), 'A dark studio. A thin strip of light slowly sweeps along the shoe from toe to heel, revealing the silhouette and material textures as it passes, while the camera drifts slowly forward. Moody, high-contrast product reveal.');
  video('FTW-VID-04', 'FTW', pick('FTW-IMG-06:clay'), 'The grey clay model of the shoe slowly transforms into the finished product as materials and colour spread across the surface from heel to toe. Static camera, studio lighting.', { endTitle: pick('FTW-IMG-02'), camera: 'Static' });
  video('GAM-VID-01', 'GAM', pick('GAM-IMG-01'), 'The desert scavenger stands in place breathing slowly, shifting weight from one leg to the other. Cloth wraps flutter lightly in a warm wind, and fine dust drifts past. He glances to the side and back. Static camera, full body, warm side lighting.', { camera: 'Static' });
  video('GAM-VID-02', 'GAM', pick('GAM-IMG-03'), 'The camera glides slowly forward through the canyon outpost, passing under a rope bridge as the wind turbines spin. Dust haze hangs in the late-afternoon light, and small figures move along the walkways. Smooth, steady drone-like movement.', { camera: 'Slow push-in' });
  video('GAM-VID-03', 'GAM', pick('GAM-IMG-04:citadel'), 'A slow crane up from below the ridgeline reveals the mountain citadel rising above drifting clouds. Banners stir on the towers, and birds circle the spires. Golden-hour light, epic and calm.');
  video('GAM-VID-04', 'GAM', 'GAM-VID-04 · helper · crop front view', 'The camera orbits a full 360 degrees around the desert scavenger standing still in a neutral pose on a plain grey background. Even studio lighting.', { camera: 'Orbit', adapted: true });
  video('MOV-VID-01', 'MOV', pick('MOV-IMG-01'), 'A slow dolly push-in toward the silhouetted figure in the doorway as dust motes drift through the beams of dawn light. The figure stays still, then turns their head slightly. Cinematic, anamorphic, film grain.', { camera: 'Slow push-in' });
  video('MOV-VID-04', 'MOV', pick('MOV-IMG-03'), 'A slow crane up and back from the farmhouse, revealing the vast empty landscape and distant mountains. Clouds drift slowly across the sky; long dawn shadows. Epic and lonely.', { fit: true, adapted: true });
  video('AUT-VID-01', 'AUT', 'AUT-VID-01 · helper · three-quarter render', "The silver car sits on a slowly rotating studio turntable, turning a full 360 degrees. Static camera at headlight height. Long softbox reflections slide smoothly across the body panels as it turns.", { camera: 'Static', adapted: true });
  video('AUT-VID-02', 'AUT', 'AUT-VID-02 · helper · crop midnight blue', 'The car drives along a coastal road at sunset; the camera tracks alongside from a parallel vehicle, then slowly overtakes toward the front three-quarter view. The wheels turn at the correct speed, reflections of the sky run along the doors, and there\'s slight motion blur on the road.', { adapted: true });
  video('AUT-VID-03', 'AUT', 'AUT-VID-03 · helper · crop headlight', 'Dark studio, extreme close-up on the headlight. The daytime-running-light signature switches on segment by segment, then the main beam illuminates. The camera drifts slowly across the lamp, revealing the surface detail.', { adapted: true });
  video('AUT-VID-04', 'AUT', pick('AUT-IMG-02'), 'Static camera on the clay model in three-quarter front view. A single long horizontal light bar moves slowly from the roof down to the sills, its highlight sweeping across every surface. Calm, clinical design-review lighting.', { camera: 'Static' });
  video('AUT-VID-05', 'AUT', 'AUT-IMG-01 · input · side sketch', 'The design sketch on paper transforms into the finished photoreal car: line work fills with paint, reflections and glass from front to back. Static camera.', { endTitle: pick('AUT-IMG-01'), camera: 'Static' });
}
console.log(JSON.stringify(steps, null, 1));
