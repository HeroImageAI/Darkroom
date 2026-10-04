# Darkroom audit — October 2026 (v3.21)

What the 2026-10-03 test suite taught us (five industries, 40 image tests on two models, 23 videos), a screen-by-screen
UX review, the new LoRAs and workflows for Klein 9B, Qwen-Image 2.1 and LTX 2.5, and the darkroom look.
Screens as they are now: `screens/` · the darkroom look (branch `darkroom-brand`, not merged): `brand/`.

---

## 1. The ten things worth doing

| # | Change | Why (evidence) | Effort |
|---|---|---|---|
| 1 | **Try both models** — one button runs Klein and Qwen on the same instruction and opens the side-by-side; keep the one you like | The suite's whole method, and the winner changed per task: Klein won or tied 30 of 40, Qwen won sketch fidelity, turnarounds, lighting, chrome | M |
| 2 | **Calmer Edit panel** — Seed, LoRAs and Klein version under *Advanced*; mask settings only once a mask exists; "Only change the masked area" off and greyed while the mask is empty | The panel is 7 modes + model + LoRAs + seed + instruction + presets + mask + checkboxes + reference in one scroll; your own screenshots had the mask box ticked with an empty mask | S |
| 3 | **Industry preset packs** — Footwear, Apparel, Automotive, Gaming, Movie: the suite's tested instructions with the winning model chosen for you | We now know which prompt works on which model per task (report §1); a creative should not need to know that | S |
| 4 | **Shape in Instruct** — keep / 16:9 / 1:1 / 4:5 / 9:16 | Edit always keeps the source's shape: the storyboard page made every Movie keyframe *and* every Movie video portrait | S–M |
| 5 | **Sheet maker** — colourway, paint-finish and multi-view sheets built from separate renders, laid out with real typed labels | Both models miscount grids and garble labels (FTW-IMG-04, AUT-IMG-08, APP-IMG-04) | M |
| 6 | **Fast Qwen** — a *Draft* setting with an 8-step (Turbo8) or 4-step (Fun Acc) LoRA | Qwen takes ~25 s against Klein's ~15 s; a draft pass makes "try both" cheap | S + download |
| 7 | **Qwen Consistency LoRA** as the default for Qwen Instruct | Qwen edits drift off the frame and repaint; the LoRA measured 24 px → 1 px drift | S + download |
| 8 | **Video: honest camera and shape** — retune Orbit/Static wording, warn about small start frames, offer Upscale first, let a take be 9:16/16:9 independent of the picture | Orbit gave a pull-back, Static pushed in; 383×214 crops went straight to 720p | S–M |
| 9 | **Titles everywhere** — Takes, Timeline bin, version tooltips (done on the brand branch), compare sheets shown whole in the Library | Takes and the bin show only "LTX 2.5 · Final 1280×704"; compare sheets are cropped square so both sides are cut off | S |
| 10 | **The darkroom look** (branch ready) | §6 | done, needs your OK |

S = an afternoon · M = a day or two · L = more. Nothing here changes how models run except 6–7 (new LoRA files).

---

## 2. What the tests taught (the evidence behind §1)

- **Both models matter.** Klein 3.90, Qwen 3.50 (after the seed fix), LTX 3.13. Klein: material, style, clay/marker/
  exploded, inpaint, outpaint, step-by-step chains. Qwen: keeps a sketch's exact proportions, character turnarounds,
  lighting moods, chrome. → #1, #3.
- **Seeds matter more than settings.** Seed 42 made Qwen copy its input on five tests; seed 7 scored 4–5. Darkroom now
  warns and offers another seed (v3.21). → #1 makes a second opinion one click.
- **Grids and labels are unreliable on both models.** Six asked, nine or eight delivered; labels garbled. → #5.
- **The picture's shape leaks into everything after it.** → #4.
- **LTX does one move well**, struggles with 360° turns (30–270°), named camera moves and keeping a design through a big
  view change; start/end-frame transformations scored 4. → #8, and LTX *Ingredients* in §5.
- **Small crops make soft videos.** → #8.
- **Finding things was the runner's biggest bug source** (compare sheets matched title searches; board-scoped search).
  For a person it is the same friction: long titles cut off on tiles, takes without names. → #9.

---

## 3. Screen by screen

### Home (`screens/00-home.png`)
- The six cards leave **Library alone on a second row**; Recent is cut off below the fold. → Make Home a *light table*:
  the last thing you worked on large ("Continue"), Recent as a full row, the six actions as a compact row of icons.
- The upload box is good; keep it.

### Generate (`10`, `11`)
- Good: plain prompt, model cards with a one-line strength, quality with time estimates, style pills.
- **Model cards describe speed, not purpose.** "Fast · 4 steps" / "Text & layout". → Say what each is best at from the
  tests: *Klein — styles, materials, fast* · *Qwen — exact layouts, text, sketches*.
- **Klein version** (a fine-tune selector) sits in the main flow → Advanced.
- History rail: no titles on hover → add the title/prompt as a tooltip.

### Edit (`20`–`26`)
- The heaviest screen (§1 #2). Proposed order: **Mode → Model → Instruction (+ presets) → Apply**; then a collapsed
  *Advanced* (Seed, LoRAs, Klein version, reference); the Mask block appears with the first brush stroke or Smart select.
- **Seed** is a 15-digit number most people never need → Advanced, with the lock; the copy warning already handles the
  one time it matters.
- **Enhance has no description box** → an optional "What is it?" line (it feeds the caption Darkroom already uses).
- **Compare** only against the previous version → let it pick any version from the strip (and the "Try both" pair).
- **Versions strip** grows to 26–33 frames → film strip (done on the brand branch) plus a ♥-only filter.
- Outpaint: good presets (To 16:9, Zoom out); the Frame tool hint is cut off at 1440×900.

### Compose (`30`)
- Clear. Starting points are good. Little to change.

### Video (`40`)
- **Animate looks disabled** until a start frame exists, with no hint near the button → "Add a start frame" on the
  button itself.
- **Takes show only technical lines** (eight identical "LTX 2.5 · Final 1280×704 · 5.0 s · 24 fps") → title (or the
  first words of the motion), then the tech line small.
- Camera chips: retune from the test results (#8); add *Turntable* (object rotates, camera still) — the most-asked shot
  in footwear and automotive, separate from *Orbit*.
- **Text → video** still missing (P4).

### Timeline (`50`)
- Clean. The bin shows prompts, not titles (#9).

### Library (`60`, `61`)
- **Two rows of chips before any picture**: filters (All, Favourites, Klein, Qwen, Edits, Composed, Videos, Recently
  deleted, Stacks) and boards (each with a long name). → Boards as a left column (like folders), filters as one
  dropdown + Favourites; the grid gets the space.
- **Compare sheets are cropped square** — both halves cut off → show wide pictures whole (contain) on tiles.
- **Titles cut off** at ~20 characters → two lines on hover.
- Details: good (Send to Edit, Animate, Download, Favourite, Title, Notes, Versions). Put **Title** above the buttons.

### Everywhere
- Top bar: VRAM and queue are engineering read-outs; keep them small (done in the brand: a safelight lamp shows that
  something is developing).
- Errors and the copy warning use the toast; good.

---

## 4. Simplifying without losing power

One rule for every panel: **what you do every time is visible; what you set once is under Advanced.**

| Always visible | Under Advanced |
|---|---|
| Mode, model, the instruction or prompt, presets, Apply | Seed + lock, LoRAs, Klein version, steps/quality detail |
| Mask tools (once you start masking) | Brush size, feather, seam feather |
| Video: frames, motion, camera, length, quality | Effect LoRAs, sound description, fps |

Plus **one recommended choice** wherever a choice exists: the model the tests found better for this kind of edit,
marked "Recommended", with the other one a click away.

---

## 5. New LoRAs and workflows (checked 2026-10-04)

Installed today: Klein — BFS head, RefControl lineart, Consistency V2, Restore V1, RefControl poses · Qwen — none ·
LTX — Cinemagraph, Slow-motion, Alpha-Gen, Pixel upscaler, Refine details, Restore.

| Model | Release | What it does | For your industries | Size / access | Verdict |
|---|---|---|---|---|---|
| Qwen-Image 2.1 | **Consistency LoRA** (ausboss, 1 Oct) | keeps an edit on the source's frame; drift 24.3 px → 0.9 px | every Qwen Instruct (product, car, shoe edits) | 152 MB, HF | **Try first** (#7) |
| Qwen-Image 2.1 | **Turbo8** (27 Sep) | 8 steps at CFG 1; t2i, edit, RGBA | Draft Qwen (#6) | HF | **Try** |
| Qwen-Image 2.1 | **Fun Acc** (Alibaba PAI, 24 Sep) | 4 steps (custom sigma schedule); a bit softer/darker on edits | fastest drafts | 346 MB, HF; ComfyUI support experimental | Later, after Turbo8 |
| Qwen-Image 2.1 | Fix LoRA (community) | texture and colour fix; needs its own sampler/guidance settings | — | 112 MB | Skip (unclear benefit) |
| Qwen-Image 2.1 | AnyAngle | new camera angle via a 3D reconstruction (splat / Trellis + Blender) | multi-views — but needs a 3D step | 120 MB | Skip for now |
| Klein 9B | **LCS Consistency** (dx8152, Apr) | colour-stable edits at strength 1.0, no tuning | successor to the installed Consistency V2 | HF | **Try** against V2 |
| Klein 9B | **Enhanced Details** | detail / realism | product renders | HF | Try |
| Klein 9B | **RefControl depth** | reference image + depth map → same identity, new pose/structure | turnarounds, product angles | Civitai | Try (Generate with references) |
| LTX 2.5 | **Ingredients** IC-LoRA | keeps characters, props and a location consistent from one reference sheet | turntables, character idles, product films — LTX's weak spot in the tests | gated (you download) | **Try** — strongest video gain |
| LTX 2.5 | **Layout-To-Render** (new) | clay/blocky 3D playblast + styled first frame → finished shot with the same camera path | automotive and footwear turntables from a 3D layout | gated | Try if you use 3D |
| LTX 2.5 | **Clean Plate** | removes people/vehicles from a shot | movie location plates | gated | Optional |
| LTX 2.5 | **Day-To-Night** | relights a day shot as night, same motion | movie (MOV-VID-02 did this by prompt) | gated | Optional |
| LTX 2.5 | Colorization · Deblur · Decompression · SDR-to-HDR | restoration | adds to Restore | gated | Optional |
| ComfyUI | official Qwen-Image 2.1 templates (t2i, edit with two refs, remove background) | Darkroom already follows them | — | — | nothing to do |

Downloads are yours to approve (file, source, size) and the gated LTX ones need your Hugging Face sign-in. Each new
LoRA gets an A/B like the suite before it becomes a default.

Sources: [Qwen Consistency](https://comfyui-wiki.com/en/news/2026-10-01-qwen-image-2-1-consistency-lora) ·
[Turbo8](https://comfyui-wiki.com/en/news/2026-09-27-qwen-image-2-1-turbo8-lora) ·
[Fun Acc](https://comfyui-wiki.com/en/news/2026-09-24-qwen-image-2-1-fun-acc-lora) ·
[Fix LoRA](https://comfyui-wiki.com/en/news/2026-09-23-qwen-image-2-1-fix) ·
[AnyAngle](https://comfyui-wiki.com/en/news/2026-09-28-qwen-image-2-1-anyangle-lora) ·
[Klein LCS](https://www.pixelsham.com/2026/04/20/flux-2-klein-9b-lcs-consistency-lora-20260415-maximum-color-stability-without-sacrificing-editing-capability/) ·
[Klein Enhanced Details](https://civitai.com/articles/27526/flux2-klein-9b-realistic-enhanced-details-lora) ·
[RefControl depth](https://civitai.com/models/2655430/refcontrol-flux2-klein-9b-reference-depth-lora) ·
[LTX 2.5 Creative Lab](https://huggingface.co/collections/Lightricks/ltx-25-creative-lab) ·
[Ingredients](https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Ingredients) ·
[Layout-To-Render](https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render)

---

## 6. The darkroom look (branch `darkroom-brand`, screenshots in `brand/`)

**Idea:** Darkroom is where a picture is developed: you expose (prompt), develop (render), print versions, choose the
best from the contact sheet. The look carries that; the words stay plain so nobody has to learn a metaphor.

Done on the branch:
- **Palette** — warm blacks (the room), fibre-paper white text, **amber safelight** accent (the OC filter used for
  black-and-white paper); a **red safelight** used *only* while something develops.
- **Safelight lamp** beside the queue count, glowing red while a job runs; a red glow rises on the stage while
  developing (`brand/70-developing.png`).
- **Prints develop into view** — a new result fades up from pale and flat to the picture in 1.1 s
  (`brand/71`, `72`); off with "reduce motion".
- **Versions as a strip of negatives** — sprocket holes, black frames, amber edge numbers; the version's title in its
  tooltip (`brand/20-edit-instruct.png`).
- **Film grain** — a faint grain over the whole app.
- **Square corners** like prints; **logo** — an enlarger lens iris.
- Home: "What are we developing today?"

Next steps for the look (with your OK):
- **Library as a contact sheet** — an optional view: black frames with frame numbers and the title as edge print,
  ♥ shown as a grease-pencil circle (the way photographers mark contact sheets).
- **Loupe** — hold Z over any tile or picture for a 2× magnifier.
- **Compare as a proof** — the side-by-side drawn as two prints on the light table, the winner marked.
- **Takes as reels** — the Takes column as a strip of film with the motion text as its label.

---

## 7. Suggested order

1. **v3.22 Quick wins** (#2, #9, Library chips → column, compare tiles whole, model cards say what they are best at,
   Animate hint) — no new files.
2. **v3.23 Creative speed** — #1 Try both, #3 preset packs, #4 shape in Instruct.
3. **v3.24 Model upgrades** — download + A/B Qwen Consistency, Turbo8, Klein LCS; then LTX Ingredients (gated).
4. **v3.25 Sheets and video** — #5 Sheet maker, #8 camera retune + Turntable chip, text → video.
5. The darkroom look merges whenever you like it; the contact-sheet view rides with v3.22's Library change.
