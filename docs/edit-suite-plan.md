# Edit suite upgrade: from mask editor to a sketch, paint and photo darkroom

*Plan, 2026-10-05. Based on a review of Krita 5.3/6.0 and Krita AI Diffusion (Acly), including the "Generative AI for Krita – With ControlNet" and "AI Live Painting in Krita" videos. Nothing here is built yet.*

## 1. What Krita AI gets right

Krita AI Diffusion isn't a separate AI screen. **The AI is a brush on a real painting canvas.** Five ideas make it work:

1. **Selection = where, prompt = what, strength = how much.**
   - One Generate button respects the selection.
   - With no selection, it works on the whole picture.
   - At 100% strength it makes something new. Below 100% it *refines* what is there (img2img).
2. **Results never overwrite.**
   - Every result goes into a history strip.
   - **Apply** adds it as a new layer, masked to the selection, so you can paint over it, erase parts or lower its opacity.
3. **Fill modes say what a selection means.** Fill, Expand, Add content, Remove content, Replace background and Custom.
   - Context comes from automatic padding, the selection bounds or the entire image.
   - **Feather** and **Blend** control how the result meets the original.
4. **Control layers turn a quick sketch into a render.**
   - Structure: scribble, line art, depth, pose, canny.
   - Reference: style, composition, face.
   - **From image** makes the control image from a picture. Strength and range set how strongly it is followed.
5. **Live painting.**
   - A fast model re-renders the canvas about once a second while you paint, with a fixed seed so the result doesn't jump.
   - You copy the result back to the canvas when it looks right.

Two smaller points:

- **Regions** (a prompt per area) are there to keep the prompt clear, not to compose the picture. Acly advises five regions or fewer.
- **Edit models work best one change at a time, at about 1 MP and 100% strength.** This matches our own Klein and Qwen tests.

Krita core supplies the painting half:

- layers with blend modes, opacity and masks
- pressure brushes, a smudge brush and stabilisers
- selections with add, subtract and intersect, plus grow, shrink and feather
- transform: free, perspective, warp and liquify
- filters and adjustment layers: levels, curves, HSV, dodge/burn, clone

## 2. Where Darkroom's Edit is today

| Area | Today |
|---|---|
| Canvas | One picture plus one mask (`lib/mask.ts`). The tools are a mask brush and eraser, lasso, Smart select (SAM 3.1), frame and crop. |
| AI | Separate modes: Instruct, Inpaint, Outpaint, Turn it, Enhance, Layers, Remove BG and Upscale. There is also Try both, Shape, Sheet maker and Presets. |
| Results | Each result **replaces** the picture as a new version in the filmstrip. Compare is before/after. |
| Layers | A read-only panel for Qwen decompositions. There are no blend modes and no painting on layers. |
| Paint | None in Edit. Compose has a simple brush and eraser. |
| Photo tools | Crop only. |
| Control | None. No line art, depth, pose or reference control. |

**The gap:** Darkroom can *change* a picture, but you can't *work* on one. You can't paint, adjust, combine or keep partial results.

## 3. The shape of the new Edit

The new Edit is one canvas with a darkroom feel. The current modes move into an **AI panel** instead of being the whole screen.

```
┌ tool options bar (brush size · hardness · opacity · flow · stabiliser · colour) ─────────────┐
│ T │                                                         │ Layers   (blend · opacity · mask)│
│ o │                     canvas (layers)                     │ AI       (prompt · fill mode ·   │
│ o │                                                         │           strength · Generate)   │
│ l │                                                         │ Adjust   (levels · curves · HSV) │
│ s │                                                         │ Colour   (wheel · swatches)      │
└───┴─ results strip: AI results ➜ Apply as layer · versions filmstrip ─────────────────────────┘
```

- **Tools:**

  | Key | Tool |
  |---|---|
  | V | Move / transform |
  | M | Marquee |
  | L | Lasso |
  | W | Magic wand |
  | S | Smart select |
  | B | Brush |
  | E | Eraser |
  | R | Smudge |
  | O | Dodge / burn |
  | K | Clone |
  | G | Fill |
  | U | Shapes and line |
  | I | Eyedropper |
  | C | Crop |

  The mask brush is gone: **the selection is the mask.** Painting a selection uses Quick-mask (Q), as in Krita and Photoshop.
- **Nothing is destructive.** An Edit session is a **project**: its layers, masks and adjustment layers are saved with the Library item. **Flatten to version** writes a normal Library picture, so the filmstrip, Compare, Video and Compose all keep working.
- **The darkroom brand fits:**
  - Dodge and burn are the actual darkroom tools.
  - Adjustments read as "the enlarger": exposure, contrast grade, split tone.
  - The results strip is the contact sheet.

## 4. Phases

Each phase is its own branch and release, with e2e tests built on JP's five industries.

### Phase 1 · v3.25: Canvas and layers (the foundation)

- **A layer stack.** Layer types:
  - picture layers
  - paint layers
  - AI-result layers
  - Library pictures dropped in as layers

  For each layer:
  - visibility, lock, opacity and reorder
  - rename and duplicate, merge down
  - **16 blend modes**: Normal, Multiply, Screen, Overlay, Soft/Hard light, Colour dodge/burn, Darken/Lighten, Difference, Exclusion, Hue, Saturation, Colour, Luminosity. The browser gives us these for free.
- **Layer masks.** Paint black or white to hide or show. **Alpha lock.**
- **History panel.** Undo and redo for every action, Ctrl+Z / Ctrl+Shift+Z, about 60 steps.
- **AI results become layers.**
  - Today's modes keep working, but their results land in the results strip.
  - **Apply** adds a result as a masked layer. **Replace** keeps today's behaviour.
- **Saving.**
  - The server stores the project as JSON plus layer PNGs under `data/projects/<id>/`, beside the item.
  - **Flatten to version** makes a normal picture from the project.
  - Old items open exactly as they do now.
- **Under the hood.** A `Document` model in `src/web/lib/doc/` replaces the single `MaskLayer`. It renders with Canvas 2D at native resolution and works in tiles if a picture is over 4 MP.

*Effort:* the largest phase, about 2–3 working sessions.

*Example:* a footwear render is the base layer. JP Applies a Qwen colourway on the upper as its own layer, sets it to Colour blend at 80%, and masks it off the sole.

### Phase 2 · v3.26: Sketch and paint

- **A real brush engine.**
  - Pointer Events pressure and tilt, so a Wacom or other pen works in the browser.
  - Pressure controls size and opacity.
  - Brush settings: hardness, flow and spacing.
  - **A stabiliser** (lazy-mouse smoothing) for clean lines.
- **Brush presets:**
  - Pencil, Ink pen, Marker, Soft airbrush, Chalk/texture, Flat fill
  - Smudge, Blur, Eraser (hard and soft)
  - **Dodge and Burn** (shadows, midtones or highlights) and Sponge (saturate or desaturate)
- **Colour.**
  - HSV wheel and square, hex entry
  - recent colours and a swatch row
  - Alt+click eyedropper, which samples the merged picture or the current layer
- **Fill bucket** with a tolerance setting. **Shapes:** line, rectangle and ellipse, with a stroke or a fill.
- **Symmetry painting** across the vertical or horizontal axis. Useful for garments, shoe tops, car fronts and game characters.
- **Canvas.** Rotate (R+drag), flip view (H) and zoom. Ctrl+click picks the layer under the cursor.

*Effort:* about 2 sessions.

### Phase 3 · v3.27: Selections, transform and photo adjustments

- **Selections as a real tool.**
  - Tools: marquee (rectangle and ellipse), lasso and polygonal lasso, **magic wand** (by colour, contiguous or global), **select by colour range**, and Smart select (SAM).
  - SAM also gives **Select subject** in one click.
  - Combine: Shift adds, Alt subtracts, Shift+Alt intersects.
  - Change: grow, shrink, feather, invert, border, and select from a layer's alpha.
  - Marching ants. The selection is saved with the project.
- **Transform** (layer or selection):
  - move, scale, rotate, flip
  - **perspective**, for decals on a car door or a print on a hoodie
  - **warp** with a mesh, for wrapping a graphic round a curve
  - *later:* liquify
- **Adjustment layers** (non-destructive, maskable):
  - Exposure/brightness, Contrast, **Levels**, **Curves** (RGB and per channel)
  - **Hue/Saturation/Lightness** (all colours or one range)
  - Colour balance, Temperature/Tint, Vibrance
  - Black & white with a filter colour, **Split tone**
  - Sharpen (unsharp mask), Blur (Gaussian), **Grain**
- **Retouch.**
  - A classic **Clone stamp** and **Heal** brush, done in the browser.
  - **AI Remove**, which is today's Remove done as a fill mode. See Phase 4.

*Effort:* about 2–3 sessions. Curves and Levels run on the GPU through WebGL lookup tables, so they stay live on 4 MP pictures.

*Example:* on a car shot JP selects the body by colour range, applies a Hue layer for a new paint colour, dodges the highlights and burns the arches, then applies a Grain adjustment. No AI is needed.

### Phase 4 · v3.28: AI on the canvas (the Krita AI core)

- **One AI panel** replaces the mode tabs: prompt, model (Klein / Qwen / Try both), **Fill mode** and **Strength**, then Generate.
- **Fill modes:**

  | Mode | What it does | What it uses today |
  |---|---|---|
  | Fill | Paints the selection with something new | Inpaint |
  | Expand | Extends the picture past its edge | Outpaint |
  | Add content | Adds the prompt into the selection | Inpaint with a context hint |
  | Remove | Takes something out | Inpaint for removal |
  | Replace background | Keeps the subject and changes everything else | Inverse of the subject selection, plus the Qwen background workflow |
  | Instruct | Changes the selection or the whole picture by instruction | Instruct |
  | Custom | Free prompt | – |
- **Strength.**
  - 100% makes something new.
  - Below 100% **refines** what is there: the canvas is encoded as the starting latent, with denoise set to the strength. This works for Klein; Qwen needs a latent img2img path, which is to be built.
- **Context:**
  - Auto (padding around the selection, today's crop-and-stitch)
  - Selection bounds
  - Whole picture
  - A chosen layer
- **Feather** and **Blend (px)** apply to the selection; today's seam feather becomes the default.
- **The AI sees the merged canvas**, so JP's paintover is part of what it renders. This is what makes paint plus AI work.
- **Results strip.** Results show as previews with a seed, prompt and model badge. Apply as a layer, Replace, or Try another seed.
- **Turn it, Sheet maker, Upscale, Remove BG, Layers (decompose) and Enhance** stay as **AI actions** in the panel's More menu.

*Effort:* about 2 sessions. It is mostly re-plumbing the jobs Darkroom already runs.

### Phase 5 · v3.29: Control and sketch to render

This phase brings Krita's ControlNet video to Darkroom.

- **Control layers.** Any paint layer can be marked as a control layer. Types:
  - **Sketch / line art.** Render this drawing.
  - **Edges (canny).** Keep the exact outlines.
  - **Depth.** Keep the shapes and space.
  - **Pose.** Keep a character's pose.
  - **Reference.** Style, composition or character from another picture. Darkroom already does this through Klein multi-reference and Qwen Picture 2/3.

  Each control layer has a **Strength** setting and a **From image** button (the preprocessor).
- **How it runs on our models. This needs A/B testing before we commit:**
  - **Klein 9B** has no ControlNet. Its reference conditioning does follow a drawing ("render the sketch in image 2 as a photo of…"). The first test is sketch to render on a shoe, a hoodie and a car.
  - **Qwen-Image Edit 2.1** follows sketches, depth and pose natively from Picture 2 by instruction. A dedicated Qwen-Image ControlNet Union (canny, depth, pose, soft edge) may exist for 2.1. **I will check compatibility before asking to download anything.**
  - **Preprocessors.**
    - Canny is already in ComfyUI core.
    - Line art, depth and pose need **comfyui_controlnet_aux** (a custom node, so it only adds) and its small models (about 0.5–1.5 GB in total). **This needs your OK to download.**
    - In the meantime, Darkroom can do canny and line art in the browser.
- **The draw-a-pose tool.** A simple stick-figure skeleton you drag. It is useful for gaming and film characters.

*Effort:* about 2 sessions, plus an A/B round like the one we ran for Orbit.

*Example (gaming):* JP scribbles a creature silhouette on a paint layer and marks it as a Sketch control. Klein renders it in the Game concept style. JP Applies the result, paints over the horns and refines the area at 40%.

### Phase 6 · v3.30: Live painting

- A **Live** toggle. While JP paints, Darkroom re-renders the selection or canvas with **Klein 9B's 4-step** model:
  - at about 768 px
  - with a fixed seed
  - at the Strength set in the panel (about 35–60%)
  - debounced at about 400 ms after the last stroke
  - showing the newest result only
- The live view sits **side by side or as an overlay** at 50%. **Copy to layer** keeps the current frame.
- **First, measure it on JP's GPU.** It is only worth shipping if a frame takes **2 s or less**. If not, a "Live-ish" mode re-renders when a stroke ends.
- The prompt and control layers apply live too, so sketch to render becomes interactive.

*Effort:* about 1–2 sessions, mostly queue handling: cancel the stale job, keep the models warm.

### Phase 7 (optional) · Regions

- A prompt for each region, set with a selection or a layer mask, on top of a root prompt. Five regions or fewer.
- **The reliable way first:** run the regions as a sequence of masked fills with shared context.
- True single-pass regional conditioning for Klein and Qwen still needs research. Only worth it if Phase 4's sequential fills feel too slow.

## 5. What we won't copy from Krita

- vector layers
- animation
- HDR / OpenEXR
- a full colour-management pipeline
- 70+ blend modes
- brush-engine depth: Krita has ten engines; we need one good one
- a hundred dockers

**Darkroom stays simple.** We keep about 14 tools, 4 panels, 16 blend modes, and AI that behaves like a brush.

## 6. Risks and how we handle them

| Risk | How we handle it |
|---|---|
| Big pictures make the browser slow when painting | Native-resolution layers up to 4 MP. Tiles above that. Each stroke paints into a scratch canvas and is committed when the stroke ends. |
| Project files take a lot of space | Layer PNGs are saved only when they change. Flattening to a version keeps a project optional. **Nothing is ever deleted automatically.** |
| Live painting is too slow on Klein 9B | Measure in Phase 6 before building it. Fall back to rendering when a stroke ends. |
| Control quality on Klein without ControlNet | A/B against Qwen Picture 2. Pick the model per control type, as we did with Try both. |
| Regressions in today's Edit e2e | Today's modes stay reachable through every phase, and each phase updates its tests. |

## 7. Decisions for JP

1. **Order.** The recommendation is 1 → 2 → 3 → 4 → 5 → 6, with Regions last or not at all. If you'd rather have AI first, Phases 1 and 4 can swap with Phases 2 and 3.
2. **Pen tablet.** Do you use one? If so, Phase 2 tunes pressure curves for it.
3. **comfyui_controlnet_aux** plus preprocessor models, at about 0.5–1.5 GB. **You approve this in Phase 5**, after the browser-only sketch test.
4. **Project storage** goes under `data/projects/` next to the Library. Is that OK?
