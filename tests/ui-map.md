# Darkroom — UI map and test-suite plan (Phase 0)

Prepared 2026-10-03 for the run of `darkroom-test-suite.md` (brief: `darkroom-test-runner-brief.md`).
Darkroom version v3.18, ComfyUI 0.38.2, Comfy Desktop 1.1.6. Screenshots and accessibility trees of every screen:
`tests/results/screenshots/phase0/` (captured by `tests/ui-map-capture.ts`, read-only).

---

## 1. App and automation route

- **What it is:** a **web app** — React/Vite front end (`src/web`) and a Fastify server (`src/server`) that drives
  ComfyUI Desktop. Not Electron.
- **How it is launched:** `start-darkroom.bat` (desktop shortcut) starts the server on **http://127.0.0.1:5178** and
  opens it in the browser. ComfyUI Desktop must be running (the status pill top right starts it).
- **Automation route:** **Playwright, headed, in Microsoft Edge** (`channel: 'msedge'` — Koos's browser, already used
  by Darkroom's own 60-test e2e suite), `slowMo` so it can be watched, against Koos's own Darkroom on port 5178 so
  every result lands in his Library.
- **Selectors:** every control has an accessible name (role + label), e.g. `getByRole('button', { name: 'Apply
  instruction Ctrl+Enter' })`, `getByLabel('Instruction')`. Darkroom's existing e2e suite runs on these names reliably,
  so **no `data-testid` changes are needed**.

## 2. UI map

### Top bar (every screen)
Tabs: Generate · Edit · Compose · Video · Timeline · Library. **Working board** selector (new results go to this
board). ComfyUI status pill, VRAM meter, queue count.

### Generation — Generate tab (`10-generate.png`, `11-generate-advanced.png`)
| Control | How |
|---|---|
| Model | group **Model**: `Klein 9B` / `Qwen-Image 2.1` buttons |
| Prompt | textbox **Prompt**; `{a\|b}` makes one picture per variation on the same seed |
| Seed | **Advanced** → textbox **Seed**; typing a seed locks it (lock button "Seed locked / unlocked"), shuffle button |
| Aspect / size | group **Aspect ratio** (1:1, 4:5, 3:2, 16:9, 9:16); group **Quality** (Klein: Standard ~1 MP / High ~2 MP; Qwen: Draft ~1 MP / Native 2K) |
| Batch | group **Batch size** ×1–×4 |
| Style preset | group **Style preset**: None (default), Photographic, Product shot, Concept art, Ink sketch, Screen print… — adds one style sentence |
| Prompt enhance | buttons **Enhance** (rewrites the prompt with the local Qwen3-VL, manual, off unless clicked) and **From picture** |
| Reference images | "Drop, paste or browse" — up to 3 references (Klein/Qwen reference workflows) |
| Run | button **Generate Ctrl+Enter** |
| Also | LoRA picker, Klein version (fine-tunes), steps slider |

**Internal prompt wrapping (no toggle):** Generate sends `{your prompt} {style sentence}` — with style **None** it is
exactly your prompt. Edit modes wrap: *Instruct* adds "Keep the composition, the people and all other details exactly
as they are." (Klein) / "Keep everything else unchanged." (Qwen) **unless your instruction already says what to keep**
(most suite prompts do: "Keep…", "Same…"); *Inpaint* adds a blending sentence; *Outpaint* uses its canvas template.
Logged per run as `prompt_enhance_state: "enhance off; style none; darkroom template <mode>"`.

### Editing — Edit tab (`20`–`26-edit-*.png`)
Open a picture: Library → double-click, or **Upload your own picture**. Every apply becomes a **new version (v2, v3…)
of the same picture** — the stack.
| Control | How |
|---|---|
| Model | group **Edit model**: Klein 9B (~15 s) / Qwen-Image 2.1 (~25 s) |
| Mode | group **Edit mode**: Instruct · Inpaint · Outpaint · Enhance · Layers · Remove BG · Upscale |
| Instruct | textbox **Instruction**, **Presets** combobox, **Enhance instruction**, checkboxes "Only change the masked area", "Point at it with a red circle"; **Reference (optional)** slot (a second picture); **Apply instruction Ctrl+Enter** |
| Mask tools | **Mask brush (B)**, **Eraser (E)**, **Lasso (L)**, **Smart select (S)** = SAM 3.1 (click the object), Brush size, Feather, Invert, Clear |
| Inpaint | textbox **What should fill the masked area?**, slider **Change strength**, **Seam feather**, **Fill masked area Ctrl+Enter** |
| Outpaint | spinbuttons **left / top / right / bottom** (px), **To 16:9 / To 1:1 / Zoom out 1.5×**, **Outpaint frame (O)** to drag, textbox **Describe the surroundings**, **Extend canvas Ctrl+Enter** |
| Enhance | group **Enhance strength**: Subtle / Restore / Restore + upscale — **no prompt box** |
| Upscale | SeedVR2 2–8× |
| Crop | **Crop (C)** — saved as a version |
| Compare | **Compare** button: slider between this version and **its previous version** only |
| Versions | group **Versions** (v1, v2 …), Undo/Redo |
| Seed | **none — every Edit run uses a random seed** (the seed used is recorded on the item) |

### Library (`60-library.png`, `61-library-details.png`)
- **Boards** (flat collections, no nesting): All boards / No board / each board; New board, Rename, Download ZIP,
  Delete board. Filters: All, Favourites, Klein, Qwen, Edits, Composed, Videos, Recently deleted. Search (prompt,
  seed, tag text).
- **Stacks:** on by default — one tile per picture, its versions listed in Details. **Edits stack automatically**
  under their source; a picture made with **Generate + a reference** is a new picture (not stacked).
- **Naming / notes:** an item's name is its prompt. **No rename, no notes field, no tags in the UI.** Details shows
  prompt, model, seed, size, render time, parent version, board; Caption buttons (local VLM).
- **Marking:** **Favourite** (heart) — usable for `provisional-best`.
- **Select** mode, multi-select, Delete (to Recently deleted), Move to board.

### Compare
Only inside Edit, a version against its parent; not saveable. **No way to put two Library items (e.g. best Klein vs
best Qwen) side by side.**

### Video (LTX 2.5) (`40-video.png`)
| Control | How |
|---|---|
| Image → video | **Start from library** / Add image (step 1), or Library → **Open in Video** / Edit → **Animate** |
| Start / end frames | **End from library** (optional), **Swap start and end frames** |
| Text → video | **not available** — "Add a start frame first" |
| Motion | textbox **Motion prompt**, **Suggest motion** (local VLM), **Describe** |
| Camera | group **Camera**: Static, Slow push-in, Pull back, Orbit, Pan left, Handheld |
| Length | group **Length**: Auto / 3 s / 5 s / 8 s |
| fps | fixed **24 fps** |
| Resolution | group **Quality**: Draft (480p) default / Final (720p) / 1080p; aspect follows the start frame as **16:9, 9:16 or 1:1** (other shapes are cropped, or letterboxed with "fit") |
| Sound / effect | group **Sound** (From the scene / Silent / Describe), group **Effect** (None / Slow motion / Cinemagraph) |
| Run | **Animate Ctrl+Enter** |
| Takes | the takes panel; each take keeps its start/end frames and settings ("Reuse settings") |

### Timeline (`50-timeline.png`)
New film → drag videos onto the video track, trim, split, crossfade, sound track, Fill / Extend / Retake with LTX,
**Export MP4** to the Library. Saves itself. (Used for MOV-VID-03, "cut together".)

### Completion signals (no fixed sleeps)
- **Generate:** the new picture appears in the History rail; Library count +1; toast. Failure: red toast with the
  error text.
- **Edit:** a new version button `v{n+1}` appears in group **Versions** and the canvas shows it; failure toast.
- **Video:** the take in the Takes panel goes from progress bar to playable video ("Show this take"); failure: the take
  shows the error and a Dismiss button.
- **Timeline:** striped placeholder disappears; Export: "exported … It is in your Library." toast.
- Timeouts (from measured times): Klein 90 s, Qwen 180 s, Inpaint/Outpaint 180 s, Enhance/Upscale 300 s,
  video Draft 5 s 240 s, Final 5 s 420 s, 1080p 900 s.

---

## 3. Library structure (adapted to flat boards)

Boards cannot nest, so one board per industry plus inputs:
`TS 2026-10-0x · 00 Inputs`, `TS … · 01 Apparel`, `· 02 Footwear`, `· 03 Gaming`, `· 04 Movie`, `· 05 Automotive`.
Set as the **Working board** before each industry, so every result files itself. Within a board, items stack by
source picture (e.g. the jacket sketch → render → fabrics → colourways → inpaint all sit in one stack).
Naming `{TEST_ID} · {model} · s{seed}` and notes **cannot be applied** without proposal P2 — until then the log
(`tests/results/run-*.jsonl`) maps every Library item id to its test, model, seed and variable.

---

## 4. Test classification

Legend — **S** SUPPORTED · **A** ADAPTED · **U** UNSUPPORTED · input: ✗ = needs a file in `test-inputs` (missing).
Cross-cutting adaptations (apply to every image test until approved changes land):
**[seed]** Edit has no seed control → runs use random seeds (recorded); only Generate tests can use 42/1234/777.
**[name]** no item names/notes → mapped in the log. **[cmp]** Klein vs Qwen compare not possible in the UI.

| Test | Class | How in Darkroom | Input |
|---|---|---|---|
| APP-IMG-01 Sketch → render | S | Upload sketch → Edit · Instruct (Klein, Qwen); render stacks on the sketch | ✗ sketch |
| APP-IMG-02 Fabric ×5 | S | Instruct on IMG-01 best | dep |
| APP-IMG-03 Print placement | S | Edit the shorts sketch, print tile in the **Reference** slot | ✗ tile + sketch |
| APP-IMG-04 Colourway sheet | S | Instruct on IMG-01 best, one image | dep |
| APP-IMG-05 Hood → collar | S | Inpaint, mask by Smart select (SAM) on the hood | dep |
| APP-IMG-06 Multi-view | S | Instruct | dep |
| APP-IMG-07 Enhance photo | A | Enhance mode has no prompt: run **Enhance · Restore** (Darkroom's way) **and** Instruct with the suite prompt | ✗ phone photo |
| APP-IMG-08 Style ×3 | S | Instruct | dep |
| APP-VID-01 Model turn | A | needs an on-model render first (Instruct "worn by a model…", stacked) → Animate 5 s; 360° turns are a known LTX weakness | dep |
| APP-VID-02 Walk & drape | A | on-model render of IMG-02 ripstop (Instruct) → Animate | dep |
| APP-VID-03 Print in water | A | on-model render of IMG-03 (Instruct) → Animate | dep |
| APP-VID-04 Hanger breeze | S | Animate IMG-01 best | dep |
| APP-VID-05 Colourway transition | A | Crop the two cells (Edit · Crop, stacked) → start/end frames | dep |
| FTW-IMG-01 Sketch → render | S | Instruct on uploaded sketch | ✗ sketch |
| FTW-IMG-02 Material zoning | S | Instruct | dep |
| FTW-IMG-03 Outsole tread | S | Inpaint (SAM on the outsole) | ✗ bottom-view render |
| FTW-IMG-04 Colourway sheet | S | Instruct | dep |
| FTW-IMG-05 Multi-view | S | Instruct | dep |
| FTW-IMG-06 Style ×3 | S | Instruct on FTW-IMG-01 best | dep |
| FTW-IMG-07 Reference → concept | S | Generate with the photo as reference (a new picture, not a stack) | ✗ reference photo |
| FTW-IMG-08 Enhance photo | A | as APP-IMG-07 | ✗ phone photo |
| FTW-VID-01 Turntable | S | Animate IMG-02 best (360° weakness) | dep |
| FTW-VID-02 Running close-up | A | on-foot render first (Instruct) → Animate | dep |
| FTW-VID-03 Hero reveal | S | Animate | dep |
| FTW-VID-04 Clay → final | S | start = IMG-06 clay, end = IMG-02 best | dep |
| GAM-IMG-01 Character | S | Instruct on uploaded sketch | ✗ sketch |
| GAM-IMG-02 Turnaround | S | Instruct | dep |
| GAM-IMG-03 Environment thumbnail | S | Instruct on uploaded thumbnail | ✗ thumbnail |
| GAM-IMG-04 Landscape capture ×3 | S | Instruct on uploaded capture | ✗ **Google Earth capture — see question 2** |
| GAM-IMG-05 Prop sheet | S | Generate (seeds 42/1234/777 work) | none ✓ |
| GAM-IMG-06 Style set ×5 | S | Generate, style preset None + the suite's style block | none ✓ |
| GAM-IMG-07 Costume inpaint | S | Inpaint (SAM on the armour) | dep |
| GAM-IMG-08 Enhance | A | as APP-IMG-07 (Restore + Instruct) on IMG-03 output | dep |
| GAM-VID-01 Idle loop | S | Animate | dep |
| GAM-VID-02 Flythrough | S | Animate | dep |
| GAM-VID-03 Establishing | S | Animate IMG-04 citadel | dep |
| GAM-VID-04 Orbit | A | Crop the front view from IMG-02 → Animate | dep |
| GAM-VID-05 Text → video | **U** | Video needs a start frame (proposal P4) | none |
| MOV-IMG-01 Keyframe | S | Instruct on uploaded sketch | ✗ sketch |
| MOV-IMG-02 Lighting ×5 | S | Instruct | dep |
| MOV-IMG-03 Matte extension | S | Outpaint, left + right = ½ width each (2× wide) | dep |
| MOV-IMG-04 Start/end pair | S | A: Generate (seeded); B: Instruct on A (stacked) | none ✓ |
| MOV-IMG-05 Creature | S | Generate | none ✓ |
| MOV-IMG-06 Location ×3 | S | Instruct on uploaded photo | ✗ location photo |
| MOV-IMG-07 Style ×3 | S | Instruct | dep |
| MOV-IMG-08 Storyboard | S | Generate | none ✓ |
| MOV-VID-01 Push-in | A | Animate; a 2.39:1 frame is cropped to 16:9 (or letterboxed) | dep |
| MOV-VID-02 Blue hour → night | S | start A, end B | ✓ (after IMG-04) |
| MOV-VID-03 Continuity ×3 | A | Crop panels 1–3 → three takes → cut together on **Timeline** | ✓ (after IMG-08) |
| MOV-VID-04 Crane over extension | A | the 2×-wide frame must be letterboxed ("fit") to keep the extension | dep |
| MOV-VID-05 Creature motion | S | Animate IMG-05 best | ✓ (after IMG-05) |
| AUT-IMG-01 Sketch → render | S | Instruct on uploaded sketch | ✗ sketch |
| AUT-IMG-02 Clay | S | Instruct | dep |
| AUT-IMG-03 Chrome | S | Instruct | dep |
| AUT-IMG-04 Headlights ×3 | S | Inpaint on a front ¾ render | ✗ front ¾ render (or use AUT-IMG-02/03 best — question 6) |
| AUT-IMG-05 Wheels | S | Inpaint, both wheels in one mask | dep |
| AUT-IMG-06 Multi-view | S | Instruct | dep |
| AUT-IMG-07 Fidelity ×3 steps | S | three Instructs on the sketch → one stack of 4 | ✗ (AUT sketch) |
| AUT-IMG-08 Paint sheet | S | Instruct | dep |
| AUT-VID-01 Turntable | A | source should be ¾ but IMG-01 is a side profile → use a ¾ render (IMG-02/03 or a Instruct step); 360° weakness | dep |
| AUT-VID-02 Drive-by | A | Crop the midnight-blue cell from IMG-08 → Animate | dep |
| AUT-VID-03 Detail reveal | A | Crop a headlight close-up from IMG-04 → Animate | dep |
| AUT-VID-04 Reflection sweep | S | Animate IMG-02 clay | dep |
| AUT-VID-05 Sketch → render | S | start = sketch, end = IMG-01 best | dep |

Totals: 64 tests — **S 48 · A 15 · U 1** (before the cross-cutting [seed]/[name]/[cmp] adaptations).

---

## 5. Run estimate

| | Count | Each (generation + UI) | Total |
|---|---|---|---|
| Image runs (67 test-variants × 2 models × 3 seeds) | 402 | Klein ~15 s + 12 s, Qwen ~28 s + 12 s | ~3 h 45 min |
| Helper steps (on-model / on-foot renders, crops) | ~14 | ~30 s | ~7 min |
| Model switches (Klein ↔ Qwen, ~2 per test) | ~134 | ~20 s | ~45 min |
| Scoring, picks, screenshots | 67 tests | ~1.5 min | ~1 h 40 min |
| Videos (26 clips incl. MOV-VID-03 ×3, 5 s, seed 42) | 26 | Final 720p ~105 s + 40 s | ~1 h 05 min (Draft: ~45 min) |
| **Total** | | | **≈ 7 h 20 min** (≈ 3 h 30 min with one seed) |

Apparel pilot alone: 14 variants (84 images) + 5 videos + 3 helper renders ≈ **1 h 45 min**.

---

## 6. Pre-flight input check

**No `test-inputs` folder exists** (looked in `E:\Darkroom`, `E:\`, `C:\`, Downloads, Desktop). Files needed — put
them in `E:\Darkroom\test-inputs\{TEST_ID}\`:

| Folder | File(s) |
|---|---|
| APP-IMG-01 | flat technical sketch (front) of the zip-front hooded jacket |
| APP-IMG-03 | print artwork tile (e.g. koeksister) + flat sketch of men's swim shorts |
| APP-IMG-07 | low-res phone photo of a real Eduwear sample garment |
| FTW-IMG-01 | lateral side-profile sketch of a running shoe |
| FTW-IMG-03 | bottom-view render of the shoe |
| FTW-IMG-07 | natural/architectural reference photo |
| FTW-IMG-08 | low-res phone photo of a shoe prototype |
| GAM-IMG-01 | rough character sketch |
| GAM-IMG-03 | rough value thumbnail of an environment |
| GAM-IMG-04 | landscape capture (suite says Google Earth — see question 2) |
| MOV-IMG-01 | rough composition sketch |
| MOV-IMG-06 | ordinary location photo |
| AUT-IMG-01 | side-view car design sketch (also feeds AUT-IMG-07 and AUT-VID-05) |
| AUT-IMG-04 | front three-quarter car render |

Without them only these can run: GAM-IMG-05, GAM-IMG-06, MOV-IMG-04, MOV-IMG-05, MOV-IMG-08 and their videos
(MOV-VID-02, MOV-VID-03, MOV-VID-05). The Apparel pilot needs APP-IMG-01 (and APP-IMG-03 / 07) first.

---

## 7. Proposed app changes (need Koos's approval — none made)

| # | Change | Why |
|---|---|---|
| P1 | **Seed** field in Edit (Advanced, like Generate's) | Edit tests can then use seeds 42/1234/777 on both models, as the suite asks |
| P2 | **Title and notes** on Library items (editable in Details, searchable) | naming `{TEST_ID} · {model} · s{seed}` and the metadata block; also useful day to day |
| P3 | **Compare two Library items** (select 2 → Compare, slider/side by side) with **Save as picture** | the Klein-vs-Qwen compare per test, kept in the board |
| P4 | **Text → video** (no start frame) on Video | GAM-VID-05 baseline; LTX can do it |

No `data-testid` changes are needed (see §1).
