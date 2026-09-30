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
  category: 'Angles' | 'Relight' | 'Styles' | 'Other';
  klein: string;
  qwen: string;
  /** Number of pictures the preset needs (2 = the second picture goes in the reference slot). */
  images?: 2;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

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

const out = {
  _help: 'Built-in edit presets (read-only; regenerated by scripts/build_presets.ts). Adapted from One Node · FLUX.2 [klein] Discover prompts (github.com/yanokusnir-ai/one-node-flux-2-klein) to Darkroom\'s preset rules, with separate Klein and Qwen-Image 2.1 wording. Your own presets live in data/user_presets.json and are merged by label.',
  presets,
};
fs.writeFileSync(path.join(ROOT, 'presets', 'edit_presets.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote presets/edit_presets.json: ${presets.length} presets`);
