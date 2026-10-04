/**
 * Builds presets/edit_presets.json (read-only built-in edit presets, Addendum 1 F + Addendum 2 F).
 *
 * Source: One Node · FLUX.2 [klein] "Discover" prompts (github.com/yanokusnir-ai/one-node-flux-2-klein, config.json
 * discover_prompts.edit), rewritten to Darkroom's preset rules rather than copied:
 *   - start with an imperative verb; always a preservation clause;
 *   - relights: light direction + "source out of frame";
 *   - two-image presets state each image's role;
 *   - [BRACKET] slots for user input;
 *   - no filler tokens ("8k", "hyper-realistic", "masterpiece", "Octane Render", tag lists).
 * Every preset has its own Klein and Qwen-Image 2.1 wording: Klein gets flowing prose and "image 1 / image 2";
 * Qwen gets an explicit instruction on <image1> / <image2> (official reference tokens) and an explicit "unchanged" list.
 * Head swap is left out (needs a third-party Faceswap LoRA; JP's decision).
 *
 * Run: npx tsx scripts/build_presets.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/server/config.js';

export interface EditPreset {
  id: string;
  label: string;
  category: 'Angles' | 'Relight' | 'Styles' | 'Other' | 'Apparel' | 'Footwear' | 'Gaming' | 'Movie' | 'Automotive';
  klein: string;
  qwen: string;
  /** Number of pictures the preset needs (2 = the second picture goes in the reference slot). */
  images?: 2;
  /** The model that did clearly better on this preset in the A/B (docs/qa/addenda/p6, p6b); the picker hints at it. */
  best?: 'klein' | 'qwen';
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---- Industries: JP's five design fields (test suite 2026-10-03). Scores in brackets: Klein / Qwen.
const ind = (category: EditPreset['category'], label: string, best: 'klein' | 'qwen', klein: string, qwen: string, images?: 2): EditPreset => ({
  id: `${slug(category)}-${slug(label)}`, label, category, klein, qwen, best, ...(images ? { images } : {}),
});
const INDUSTRY: EditPreset[] = [
  // Apparel
  ind('Apparel', 'Sketch to render', 'klein', // APP-IMG-01 (4/4)
    'Turn this flat technical sketch into a photorealistic product render of the [GARMENT], front view, on a plain light-grey background with soft studio light. Keep the exact silhouette, seams, panels, pockets, zips and trims from the sketch. Material: [MATERIAL].',
    'Turn the flat sketch in <image1> into a photorealistic product render of the [GARMENT], front view, on a plain light-grey background with soft studio light. Keep the silhouette, seams, panels, pockets, zips and trims of <image1> unchanged. Material: [MATERIAL].'),
  ind('Apparel', 'Fabric swap', 'klein', // APP-IMG-02 (4/3)
    'Change the fabric of the garment to [FABRIC], with its real weight, drape, sheen and surface texture. Keep the cut, the seams, the colour, the pose, the lighting and the background identical.',
    'Change the fabric of the garment in <image1> to [FABRIC], with its real weight, drape, sheen and texture. Keep the cut, seams, colour, pose, lighting and background unchanged.'),
  ind('Apparel', 'Print placement', 'klein', // APP-IMG-03 (4/2)
    'Using image 1 as the garment and image 2 as the print: apply the print from image 2 as an all-over pattern on the [PANEL], following the folds, seams and perspective of the fabric. Keep the garment shape, the other panels, the lighting and the background of image 1 identical.',
    'Apply the print from <image2> as an all-over pattern on the [PANEL] of the garment in <image1>, following its folds, seams and perspective. Keep the garment shape, the other panels, the lighting and the background of <image1> unchanged.', 2),
  ind('Apparel', 'Colourway', 'klein', // APP-IMG-04; one colourway per run (grids miscount)
    'Recolour the garment as the colourway [COLOURS]. Keep the cut, the fabric texture, the stitching, the pose, the lighting and the background identical.',
    'Recolour the garment in <image1> as the colourway [COLOURS]. Keep the cut, fabric texture, stitching, pose, lighting and background unchanged.'),
  ind('Apparel', 'Multi-view sheet', 'qwen', // APP-IMG-06 (3/4)
    'Show this exact garment as a presentation sheet: front, back and side views in a row at the same scale, on a plain light-grey background with even light. Keep every detail, colour and material identical in each view.',
    'Show the garment in <image1> as a presentation sheet: front, back and side views in a row at the same scale, plain light-grey background, even light. Keep every detail, colour and material of <image1> unchanged in each view.'),
  ind('Apparel', 'On a model', 'klein', // APP-VID helpers: a start frame for video
    'Show this exact garment worn by a [MODEL] standing in a bright studio, full body, natural pose. Keep the garment\'s cut, colour, fabric and every detail identical.',
    'Show the garment in <image1> worn by a [MODEL] standing in a bright studio, full body, natural pose. Keep the cut, colour, fabric and every detail of the garment unchanged.'),
  // Footwear
  ind('Footwear', 'Sketch to render', 'qwen', // FTW-IMG-01 (4/5)
    'Turn this side-profile sketch into a photorealistic product render of the shoe, lateral view, on a seamless white background with a soft contact shadow. Keep the exact silhouette: sole stack height, toe spring, heel counter, collar line and all overlay lines. Materials: [MATERIALS].',
    'Turn the side-profile sketch in <image1> into a photorealistic product render of the shoe, lateral view, seamless white background, soft contact shadow. Keep the silhouette, sole stack height, toe spring, heel counter, collar line and every overlay line of <image1> unchanged. Materials: [MATERIALS].'),
  ind('Footwear', 'Material zones', 'klein', // FTW-IMG-02 (4/4)
    'Rework the materials of this shoe by zone: upper in [UPPER], overlays in [OVERLAYS], midsole in [MIDSOLE], outsole in [OUTSOLE], with clean, crisp boundaries between them. Keep the same shoe, view and silhouette identical.',
    'Rework the materials of the shoe in <image1> by zone: upper in [UPPER], overlays in [OVERLAYS], midsole in [MIDSOLE], outsole in [OUTSOLE], with crisp boundaries. Keep the shoe, the view and the silhouette of <image1> unchanged.'),
  ind('Footwear', 'Clay render', 'klein', // FTW-IMG-06 (5/4)
    'Present this shoe as a matte grey clay render with no materials, colour or texture, on a plain studio background. Keep its exact shape, proportions and every line identical.',
    'Present the shoe in <image1> as a matte grey clay render with no materials, colour or texture, plain studio background. Keep its exact shape, proportions and lines unchanged.'),
  ind('Footwear', 'Marker sketch', 'klein', // FTW-IMG-06 (5/4)
    'Present this shoe as a designer marker sketch on white paper, grey marker tones with a single [ACCENT] accent. Keep its exact shape and proportions identical.',
    'Present the shoe in <image1> as a designer marker sketch on white paper, grey marker tones with a single [ACCENT] accent. Keep its exact shape and proportions unchanged.'),
  ind('Footwear', 'Exploded view', 'klein', // FTW-IMG-06 (5/4)
    'Present this shoe as an exploded view: upper, midsole, outsole, insole and laces floating apart in line, on a white background. Keep the shape, colour and material of every part identical.',
    'Present the shoe in <image1> as an exploded view: upper, midsole, outsole, insole and laces floating apart in line, white background. Keep the shape, colour and material of every part unchanged.'),
  ind('Footwear', 'Colourway', 'qwen', // FTW-IMG-04; one colourway per run (grids miscount)
    'Recolour this shoe as the colourway [COLOURS]. Keep the shape, materials, textures, lighting and background identical.',
    'Recolour the shoe in <image1> as the colourway [COLOURS]. Keep the shape, materials, textures, lighting and background unchanged.'),
  ind('Footwear', 'On foot', 'klein', // FTW-VID-02 helper
    'Show this exact shoe worn on a runner\'s foot mid-stride on [SURFACE], low side angle at ground level, natural light. Keep the shoe\'s shape, materials and colours identical.',
    'Show the shoe in <image1> worn on a runner\'s foot mid-stride on [SURFACE], low side angle at ground level, natural light. Keep the shape, materials and colours of the shoe unchanged.'),
  // Gaming
  ind('Gaming', 'Sketch to character art', 'klein', // GAM-IMG-01 (4/3)
    'Render this character sketch as finished game concept art: [CHARACTER]. Full body, the pose and silhouette from the sketch, plain mid-grey background, stylised realism, painterly detail. Keep the proportions and every shape of the sketch identical.',
    'Render the sketch in <image1> as finished game concept art: [CHARACTER]. Full body, plain mid-grey background, stylised realism, painterly detail. Keep the pose, silhouette and proportions of <image1> unchanged.'),
  ind('Gaming', 'Turnaround sheet', 'qwen', // GAM-IMG-02 (4/5)
    'Show this exact character as a turnaround sheet: front, three-quarter, side and back views in one row at identical scale, neutral A-pose, flat mid-grey background, even light. Keep every costume detail and colour identical in each view.',
    'Show the character in <image1> as a turnaround sheet: front, three-quarter, side and back views in one row at identical scale, neutral A-pose, flat mid-grey background, even light. Keep every costume detail and colour unchanged in each view.'),
  ind('Gaming', 'Thumbnail to environment', 'qwen', // GAM-IMG-03 (4/4)
    'Develop this thumbnail into a finished game environment: [ENVIRONMENT]. Keep the composition, the horizon line and the major value shapes identical. Painterly concept art, atmospheric perspective.',
    'Develop the thumbnail in <image1> into a finished game environment: [ENVIRONMENT]. Keep the composition, horizon line and major value shapes of <image1> unchanged. Painterly concept art, atmospheric perspective.'),
  ind('Gaming', 'Genre transform', 'klein', // GAM-IMG-04 (5/4)
    'Transform this landscape into game environment concept art as a [GENRE]. Replace the content and mood completely, but keep the terrain shape, the horizon line and the camera angle identical.',
    'Transform <image1> into game environment concept art as a [GENRE]. Replace the content and mood, but keep the terrain shape, horizon line and camera angle of <image1> unchanged.'),
  ind('Gaming', 'Presentation polish', 'klein', // GAM-IMG-08 (4/2)
    'Refine this concept art to presentation quality: sharper details, cleaner edges, richer texture. Keep the composition, the design and the colours identical.',
    'Refine <image1> to presentation quality: sharper details, cleaner edges, richer texture. Keep the composition, design and colours unchanged.'),
  // Movie
  ind('Movie', 'Sketch to keyframe', 'klein', // MOV-IMG-01 (3/3)
    'Develop this rough composition into a cinematic film keyframe: [SCENE]. Keep the composition and camera framing identical. Anamorphic look, volumetric light, film grain, muted grade.',
    'Develop the rough composition in <image1> into a cinematic film keyframe: [SCENE]. Keep the composition and camera framing of <image1> unchanged. Anamorphic look, volumetric light, film grain, muted grade.'),
  ind('Movie', 'Lighting and time of day', 'qwen', // MOV-IMG-02 (4/5)
    'Change only the lighting and atmosphere to [LIGHTING], cinematic and physically motivated. Keep the scene, the composition, the figures and the camera identical.',
    'Change only the lighting and atmosphere of <image1> to [LIGHTING], cinematic and physically motivated. Keep the scene, composition, figures and camera unchanged.'),
  ind('Movie', 'Location to genre', 'klein', // MOV-IMG-06 (4/2)
    'Reimagine this location as a [GENRE] film set: change the architecture dressing, props, lighting and atmosphere to fit the genre. Keep the layout, the perspective and the camera position identical. Cinematic keyframe, film grain.',
    'Reimagine the location in <image1> as a [GENRE] film set: change the dressing, props, lighting and atmosphere to fit the genre. Keep the layout, perspective and camera position of <image1> unchanged. Cinematic keyframe, film grain.'),
  ind('Movie', 'Re-render as medium', 'qwen', // MOV-IMG-07 (3/4)
    'Re-render this keyframe as a [MEDIUM]. Keep the composition and the lighting design identical.',
    'Re-render <image1> as a [MEDIUM]. Keep the composition and lighting design of <image1> unchanged.'),
  // Automotive
  ind('Automotive', 'Sketch to render', 'qwen', // AUT-IMG-01 (3/4)
    'Turn this side-view car sketch into a photorealistic studio render, exact side profile, seamless white-to-grey background with a soft floor reflection. Keep the proportions exactly: wheelbase, overhangs, greenhouse, beltline, wheel arches and every feature line. Paint: [PAINT].',
    'Turn the car sketch in <image1> into a photorealistic studio render, exact side profile, seamless white-to-grey background, soft floor reflection. Keep the wheelbase, overhangs, greenhouse, beltline, wheel arches and every feature line of <image1> unchanged. Paint: [PAINT].'),
  ind('Automotive', 'Clay model', 'klein', // AUT-IMG-02 (4/4)
    'Show this exact car as a full-size design-studio clay model: matte warm-grey clay, no paint, no glass tint, no badges, the wheels in clay too, long softbox highlights over the surfaces. Keep the proportions and every feature line identical.',
    'Show the car in <image1> as a full-size design-studio clay model: matte warm-grey clay, no paint, no glass tint, no badges, clay wheels, long softbox highlights. Keep its proportions and every feature line unchanged.'),
  ind('Automotive', 'Chrome reflection study', 'qwen', // AUT-IMG-03 (3/5)
    'Show this exact car finished in mirror chrome in a studio with evenly spaced vertical strip lights reflected cleanly across the panels, three-quarter front view. Keep the proportions and every feature line identical.',
    'Show the car in <image1> finished in mirror chrome in a studio with evenly spaced vertical strip lights reflected cleanly across the panels, three-quarter front view. Keep its proportions and every feature line unchanged.'),
  ind('Automotive', 'Paint finish', 'klein', // AUT-IMG-08 (4/2); one finish per run
    'Repaint this car in [FINISH]. Keep the shape, the wheels, the glass, the lighting, the angle and the background identical.',
    'Repaint the car in <image1> in [FINISH]. Keep the shape, wheels, glass, lighting, angle and background unchanged.'),
  ind('Automotive', 'Four-view board', 'klein', // AUT-IMG-06 (4/4)
    'Show this exact car as a design presentation board: front, rear, side profile and top-down plan at consistent scale on a clean white background, studio light. Keep the same paint, wheels and details in every view.',
    'Show the car in <image1> as a design presentation board: front, rear, side profile and top-down plan at consistent scale, clean white background, studio light. Keep the same paint, wheels and details in every view.'),
  ind('Automotive', 'Three-quarter view', 'klein', // AUT-VID-01 helper
    'Show this exact car in a three-quarter front view on a studio turntable, long softbox reflections, seamless light-grey studio. Keep its proportions, paint, wheels and details identical.',
    'Show the car in <image1> in a three-quarter front view on a studio turntable, long softbox reflections, seamless light-grey studio. Keep its proportions, paint, wheels and details unchanged.'),
];

// ---- Relight: [label, light described as a phrase] -------------------------------------------------------------
const RELIGHT: [string, string][] = [
  ['Soft Azure Drift', 'gentle, soft blue light coming from the upper right corner'],
  ['Dramatic Slats', 'a strong directional light from the bottom left that casts distinct, linear shadows across the background'],
  ['Amber Sideglow', 'noticeable warm amber daylight coming from the right side'],
  ['Shadow Fade Mystery', 'soft, warm light from the right side that gradually fades into shadow on the left, creating a dim, mysterious mood'],
  ['High-Top Backlight', 'a strong backlight from above and behind the subject'],
  ['Soft Foggy Bloom', 'a soft, diffused, foggy glow coming from the top left'],
  ['Dim Silver Moon', 'dim silver moonlight coming from the top right'],
  ['Dappled Canopy', 'dappled sunlight filtered through leaves from above, casting leaf shadows'],
  ['Subtle Cool Bloom', 'a subtle cool white glow from the right side'],
  ['Warm Hearth Flicker', 'flickering warm orange light from low in front, like a fire'],
  ['Sharp Cool Burst', 'a sharp burst of cool white light from the upper left'],
  ['Golden Doorway Glow', 'a warm yellow glow falling in from the side as if through an open doorway'],
  ['Faint Moon Hue', 'faint, desaturated blue moonlight from the top left'],
  ['Neutral Studio Soft', 'soft, neutral white studio light from the top left'],
  ['Golden Rim Halo', 'a strong golden-hour backlight that draws a glowing outline around the subject'],
  ['Blue-Magenta Split', 'cool blue light from one side and deep magenta light from the opposite side'],
  ['Low-Key Beam', 'low-key, dramatic lighting with a single narrow beam of light from the side'],
  ['Harsh Top-Down Noir', 'a harsh, cool white light from directly above with heavy shadows'],
  ['Dawn Flare', 'a low, warm orange sunrise light from the horizon with long soft shadows and a hazy morning glow'],
  ['Amber Beams', 'warm volumetric light beams from the top right in a slightly hazy atmosphere'],
  ['Teal-Orange Mix', 'a teal ambient fill and a warm orange key light from the opposite side, like a cinematic colour grade'],
  ['Deep Kicker', 'a strong cool white kicker light from the back left grazing the edges of the subject, with deep shadows in front'],
  ['Cross Light', 'two opposing light sources from the left and the right, high contrast, meeting in a bright central highlight'],
  ['Cold Fill', 'a subtle, desaturated cold blue fill in the shadows while the main light stays warm'],
  ['Vignette Rim', 'a sharp white rim light from the back right that separates the subject from a darker background'],
  ['Velvet Shadow', 'low-intensity soft light from above, with deep velvety shadows and subtle highlights on the top surfaces'],
];

// ---- Styles: [label, the look as a noun phrase] ------------------------------------------------------------------
// Filler removed from One Node's originals: "8k professional photography" (Portrait), "Octane Render" (3D Render).
const STYLES: [string, string][] = [
  ['35mm', 'a grainy 35 mm film photograph shot on Kodak Portra 400, with a vintage look and natural colours'],
  ['Polaroid', 'an authentic 1980s Polaroid photo with faded edges, soft focus and a white border'],
  ['NatGeo', 'a raw documentary photograph with natural sunlight and rich, true-to-life texture'],
  ['3D Render', 'a clean isometric 3D render with soft clay-like materials, a pastel palette and soft studio light'],
  ['Oil Paint', 'a classical oil painting with thick impasto brushstrokes, rich canvas texture and dramatic chiaroscuro'],
  ['VHS', 'a frame from a 1990s VHS recording, with tracking lines, chromatic aberration and soft analog detail'],
  ['Portrait', 'a high-end studio portrait with dramatic Rembrandt lighting, deep shadows and sharp focus on the eyes'],
  ['Sketch', 'a detailed graphite pencil sketch on textured paper, with hand-drawn strokes, cross-hatching and soft shading'],
  ['Digicam', 'a 2000s consumer digital-camera snapshot with harsh on-camera flash, slight motion blur, low dynamic range and a date stamp reading "01-08-2002" in the lower right corner'],
  ['Impressionist', 'an impressionist painting with vibrant dappled light, short thick brushstrokes and a Monet-like palette'],
  ['Double Exp', 'a double-exposure photograph that blends the subject with a lush forest landscape in a dreamlike overlay'],
  ['Gothic', 'a dark, moody gothic image with desaturated colours, mist, sharp contrast and cinematic shadows'],
  ['Ukiyo-e', 'a traditional Japanese ukiyo-e woodblock print with flat colours, bold outlines, decorative patterns and antique paper texture'],
  ['Charcoal', 'a rough charcoal drawing with smudged texture, heavy dark strokes and an expressive hand-drawn feel'],
  ['Marble', 'a classical white marble sculpture with fine chiselled detail under soft museum spotlighting'],
  ['Watercolor', 'a delicate watercolour painting with soft pigment bleeds, wet-on-wet washes and cold-press paper texture'],
  ['Daguerreotype', 'an 1800s daguerreotype with an antique silver-plate sheen, sepia tones, fine scratches and soft edges'],
  ['Embroidery', 'detailed needlepoint embroidery with textured silk threads and hand-stitched patterns on fabric'],
  ['Claymation', 'a stop-motion claymation scene with handmade plasticine textures, thumbprint details and macro studio light'],
  ['Low Poly', 'low-poly geometric art with sharp triangular facets, flat shading and a minimalist 3D look'],
  ['Vector Art', 'a clean flat vector illustration with geometric shapes and bold solid colours'],
  ['16-Bit Pixel', '16-bit retro pixel art with a limited palette and clean sprites, like a SNES game'],
];

const presets: EditPreset[] = [
  // ---- Industries first (DECISIONS 110): the instructions that scored best in the 2026-10-03 test suite, made
  // reusable with [SLOTS]; `best` is the model that won that test (after the seed-7 re-runs, report-2026-10-03.md)
  ...INDUSTRY,
  // ---- Angles (bespoke: each move needs its own preservation wording)
  {
    id: 'close-up', label: 'Close-up', category: 'Angles',
    klein: 'Move the camera in to a tight close-up of the subject, cropping close on the main details. Keep every colour, texture and element of the scene identical and sharp, only seen from much closer.',
    qwen: 'Show <image1> as a tight close-up of the main subject, cropping in close on its details. Keep all colours, textures and elements of the scene unchanged; only the camera distance changes.',
  },
  {
    id: 'wide-angle', label: 'Wide-angle', category: 'Angles',
    klein: 'Switch to a wide-angle lens with the subject still at the centre, revealing more of the surrounding environment. Keep the architecture, the lighting and the background identical to the original scene.',
    qwen: 'Show <image1> through a wide-angle lens with the subject still at the centre, revealing more of its surroundings. Keep the architecture, the lighting and the existing background unchanged.',
  },
  {
    id: 'aerial-view', label: 'Aerial view', category: 'Angles',
    klein: 'Move the camera up to a high aerial view looking down on the scene. Keep every landmark, colour and the lighting consistent with the original picture.',
    qwen: 'Show the scene of <image1> from a high aerial viewpoint looking down. Keep all landmarks, colours and the lighting consistent with the original.',
  },
  {
    id: 'low-angle', label: 'Low-angle', category: 'Angles',
    klein: 'Move the camera down to a low angle near the ground, showing more of the sky or ceiling. Keep the environment identical and keep the subject and background in the same relationship and scale.',
    qwen: 'Show <image1> from a low camera angle near the ground, revealing more of the sky or ceiling. Keep the environment unchanged and keep the subject and background at the same scale and in the same arrangement.',
  },
  // ---- Relight (category template per model)
  ...RELIGHT.map(([label, light]): EditPreset => ({
    id: `relight-${slug(label)}`, label, category: 'Relight',
    klein: `Relight the scene with ${light}, the light source out of frame. Keep the subject, the pose, the composition and the background identical.`,
    qwen: `Relight <image1> with ${light}, with the light source out of frame. Keep the people, their pose, the composition and the background unchanged; only the lighting changes.`,
  })),
  // ---- Styles
  ...STYLES.map(([label, look]): EditPreset => ({
    id: `style-${slug(label)}`, label, category: 'Styles',
    klein: `Change the style to ${look}. Keep the composition, the subject and the pose identical.`,
    qwen: `Restyle <image1> as ${look}. Keep the composition, the subject, the pose and any existing text unchanged.`,
  })),
  // ---- Other
  {
    id: 'enhance', label: 'Enhance', category: 'Other',
    // same wording as Edit > Enhance > Restore (DECISIONS 66)
    klein: 'Restore this photograph: remove the blur, noise and compression artefacts and bring back fine, natural detail and sharp focus. Keep the same composition, the same person and likeness, the original colours, contrast and lighting, and the natural skin and fabric texture. Make it look like a clean, sharp original photograph, not a processed one.',
    qwen: 'Enhance the overall quality of <image1>: restore fine detail and sharp focus, and remove motion blur, lens blur, noise and compression artefacts. Keep the composition, every face and its likeness, the colours, the lighting and every object exactly as they are, and add nothing new.',
  },
  {
    id: 'text-edit', label: 'Text edit', category: 'Other',
    klein: 'Replace the existing text "[OLD TEXT]" with the new text "[NEW TEXT]". Match the original typography exactly: font, letter shapes, colour, effects and texture, in the same position, scale and alignment. Keep everything else identical.',
    qwen: 'In <image1>, replace the text "[OLD TEXT]" with "[NEW TEXT]". Keep the same font, letter shapes, colour, effects, texture, position, size and alignment, and keep everything else unchanged.',
  },
  {
    id: 'try-on', label: 'Try-on', category: 'Other', images: 2,
    klein: 'Using image 1 as the person and image 2 as the outfit: dress the person from image 1 in the exact outfit from image 2, with the same style, materials, textures and colours, fitted naturally to their body and to the lighting of image 1. Keep the face, identity, hair, expression, pose, background and camera framing of image 1 identical.',
    qwen: 'Dress the person in <image1> in the outfit from <image2>, with the same style, materials, textures and colours, fitted naturally to their body and lit like <image1>. Keep the face, identity, hair, expression, pose, background and framing of <image1> unchanged.',
  },
  {
    id: 'texture-transfer', label: 'Texture transfer', category: 'Other', images: 2,
    klein: 'Using image 1 as the subject and shape and image 2 as the material: replace the surface of the subject in image 1 with the exact texture, pattern and material of image 2, following every contour, curve and the lighting of image 1. Keep the shape, the pose and the background of image 1 identical.',
    qwen: 'Replace the surface material of the subject in <image1> with the exact texture, pattern and material shown in <image2>, following its contours and the lighting of <image1>. Keep the shape, the pose and the background of <image1> unchanged.',
  },
];

const FILLER = /\b(8k|4k resolution|hyper-?realistic|masterpiece|octane render|best quality|ultra detailed)\b/i;
for (const p of presets) {
  for (const t of [p.klein, p.qwen]) {
    if (FILLER.test(t)) throw new Error(`${p.id}: filler token in "${t}"`);
    if (!/^[A-Z][a-z]+\b/.test(t)) throw new Error(`${p.id}: must start with an imperative verb: "${t}"`);
    if (!/\b(keep|keeping)\b/i.test(t)) throw new Error(`${p.id}: missing a preservation clause: "${t}"`);
  }
  if (p.category === 'Relight' && !/out of frame/.test(p.klein + p.qwen)) throw new Error(`${p.id}: relight without "out of frame"`);
  if (p.images === 2 && !(/image 1/.test(p.klein) && /image 2/.test(p.klein) && /<image1>/.test(p.qwen) && /<image2>/.test(p.qwen))) throw new Error(`${p.id}: two-image preset must name both images`);
}
if (new Set(presets.map((p) => p.id)).size !== presets.length) throw new Error('duplicate preset id');

// Phase 6 A/B: Qwen-Image 2.1 barely restyles these looks even with stronger wording (p6b), and copies the reference's
// subject in texture transfer; Klein does them properly. Try-on fits better on Qwen.
const BEST: Record<string, 'klein' | 'qwen'> = {
  'style-3d-render': 'klein', 'style-embroidery': 'klein', 'style-claymation': 'klein', 'style-low-poly': 'klein', 'style-16-bit-pixel': 'klein',
  'texture-transfer': 'klein', 'try-on': 'qwen',
};
for (const p of presets) if (BEST[p.id]) p.best = BEST[p.id];
for (const id of Object.keys(BEST)) if (!presets.some((p) => p.id === id)) throw new Error(`best-model entry for unknown preset ${id}`);

const out = {
  _help: 'Built-in edit presets (read-only; regenerated by scripts/build_presets.ts). Adapted from One Node · FLUX.2 [klein] Discover prompts (github.com/yanokusnir-ai/one-node-flux-2-klein) to Darkroom\'s preset rules, with separate Klein and Qwen-Image 2.1 wording. Your own presets live in data/user_presets.json and are merged by label.',
  presets,
};
fs.writeFileSync(path.join(ROOT, 'presets', 'edit_presets.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote presets/edit_presets.json: ${presets.length} presets`);
