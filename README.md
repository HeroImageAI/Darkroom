# Darkroom

Current release: **v3.35.0** — [reliability and Library improvements](docs/releases/v3.35.0.md).

A simple, fast studio for **image generation, image editing and image-to-video** on your own RTX 3090. ComfyUI Desktop does the
work; Darkroom is the only window you use day to day.

| Screen | What it does |
|---|---|
| **Home** | Where Darkroom opens: pick Generate, Edit, Compose, Video or Library, **upload your own pictures** to edit or **your own videos** (they open on Video) — drop, paste or browse, several at once, continue where you left off, or open recent work. The logo brings you back here. |
| **Generate** | Prompt → Klein 9B (fast, 4 steps; Standard ~1 MP or High ~2 MP for finer detail and text; **Klein version** offers your own Klein 9B fine-tunes, found by their layers) or Qwen-Image 2.1 (text & layout; Draft ~1 MP or Native 2K, transparent background). Aspect pills, per-model style presets, up to 3 reference images (drop, paste, or capture part of your screen), batch ×1–4. **Enhance** expands a short idea into a model-specific prompt, written for the style you picked and **From picture** writes a prompt from an image (local Qwen3-VL); Undo puts your text back. |
| **Edit** | Mask brush / eraser / lasso on a zoomable canvas. Pick **Klein 9B or Qwen-Image 2.1** for Instruct (with 56 presets), Inpaint (crop and stitch), Outpaint and Enhance (Restore); a red-circle quick edit (Qwen); Remove BG (fast or Qwen best quality); Layers; Upscale 2–8× (SeedVR2, keeps transparency); Crop. Every apply is a new version (v1, v2…), with a before/after slider and undo/redo. |
| **Compose** | Arrange pictures, cut-outs (one-click background removal) and rough paint on a canvas — move, scale on a ground line, flip, order — then **Render**: *Blend edges* (keeps your pieces exactly, redraws only the joins and shadows), *Harmonise* (Qwen: one coherent photo, faces and objects kept) or *Reimagine* (Klein: paint becomes the real thing; the local Qwen3-VL describes the scene first if you leave it empty). Compositions save themselves; renders go to the Library. Evidence: docs/qa/COMPOSE_AB.md. |
| **Video** | Start frame (+ optional end frame) → **LTX 2.5**, with sound: from the scene, your own description (sounds, music, a spoken line), or silent; Extend keeps it. **Auto** length (LTX reads your prompt and picks 2–8 s) or 3/5/8 s; Draft 480p, Final 720p, or **1080p** (rendered in two stages for full-HD detail, about 3 minutes for 5 s); camera chips (Suggest / Improve motion write for them); Effect: Slow motion or Cinemagraph (Lightricks LoRAs); your own LTX LoRAs; **Refine details** sharpens a take at 720p keeping its motion and sound; **Cut out** puts a take's subject over a new background (Alpha-Gen matte, also saved for editors); **Restore** repairs old or damaged footage you bring in (scratches, grain, flicker, faded colour → clean colour at up to 1280 px, in 4-second parts joined seamlessly, its own sound kept); measured time estimate. Takes panel, Extend +5 s, Smooth 2×, Save frame. Jobs keep running if you close or reload the page. |
| **Timeline** | Put a film together: drag your takes and your own videos onto the video track, move them (they snap to each other and the playhead), trim the edges, split at the playhead, crossfade (overlap two clips or pick Fade), mute a clip's own sound, add your music or voice on the sound track, undo / redo, and **Export MP4** (H.264 + mixed sound, at the first clip's size or 720p / 1080p / vertical / square) into the Library. **AI tools** (LTX 2.5): click an empty stretch to **Fill** it (from the frame before to the frame after, exactly as long as the gap), **Extend** a clip (what follows makes room), **Retake a moment** from the playhead; add **key moments** (pictures the clip passes through) and **animate to my sound** (lip-sync / on the beat from your sound track). A striped placeholder holds the place until the render drops in, crossfaded into its neighbours. Films save themselves. |
| **Library** | Everything you make or bring in (**Upload** takes pictures and MP4/MOV videos), **one tile per picture** (its versions stacked under the newest, all listed in the details; Stacks turns it off) (each item can have your own **title and notes**; tick two pictures → **Compare** side by side or on a slider, **Save as picture**; **Select** puts a tick box on every tile — tick, click, or drag a box over several — then Delete, Favourite or Move to board together; Ctrl/Shift-click work too; Recently deleted keeps them until you delete them for good, which sends the files to the Recycle Bin), with the full settings (prompt, model, seed, size, render time, parent version). Search, filters, favourites, Reuse settings, Send to Edit, Enhance, Animate, Open graph in ComfyUI, and **Caption / Prompt → Klein / Prompt → Qwen** with the local Qwen3-VL. |

## What's new in the addenda (One Node patterns + Qwen-Image 2.1 parity)

- **Sharper Klein** with One Node's sampler (er_sde, shift 3, 4 steps); **Qwen tiers**: Draft (~1 MP, 25 steps) to iterate, Native 2K (40 steps) for finals.
- **Enhance = Restore**: rebuilds a blurred, noisy or small picture as an edit on both models (the old img2img is kept as *Subtle*). Restore + upscale runs SeedVR2 2× afterwards.
- **Inpaint with crop and stitch**: only the masked area and its surroundings are re-rendered at high resolution, then stitched back — small objects and text now work. Change strength 50–100 %, Seam feather Auto.
- **Point at it with a red circle** (Edit → Instruct, Qwen): paint over an object, tick the option, and describe the change — no mask precision needed.
- **Outpaint** on a prepared canvas (Klein) that stays seamless round after round.
- **Upscale 2/4/6/8×** keeps transparency; pixelated pictures are detected and shrunk to their real size first.
- **Background removal: Best quality** uses Qwen-Image 2.1's own transparent output (glass, hair); **Layers → Objects (Qwen 2.1)** gives full-resolution transparent layers.
- **56 edit presets** (Angles, Relight, Styles, Enhance, Text edit, Try-on, Texture transfer), worded separately for each model, with a hint when the other model does it better. Save your own; they live in `data/user_presets.json` and survive updates.
- **Prompt rewriters**: Qwen's Enhance uses the official Qwen-Image 2.1 prompt enhancer and also suggests the aspect ratio; Edit → **Enhance instruction** rewrites an edit instruction for the selected model.
- **Reproducible**: every PNG carries its settings — **Restore** on Generate rebuilds them from any Darkroom file; Library right-click **Use as…**; Ctrl+V into the Edit reference slot.

Which model to pick for each feature, with the evidence: docs/qa/ADDENDA_REPORT.md. The choices and A/B results: DECISIONS 62–75.

## What's new in v2

- **Model-aware prompts.** Everything Darkroom adds to your text (styles, edit wording, video camera phrases) is written separately for Klein, Qwen, Wan and LTX, following each model's official guidance — see docs/PROMPT_AUDIT.md. Templates are editable in `presets/prompts.json`, `styles.json`, `camera.json`.
- **Local vision model** (Qwen3-VL 8B — the text encoder Qwen-Image 2.1 already uses, so nothing extra was downloaded): caption, reverse prompt, prompt enhance, video motion suggestions. System prompts: `presets/vlm_prompts.json`.
- **Enhance** (Edit → Enhance, or the Enhance buttons in Generate/Library): now Restore / Restore + upscale / Subtle — see the addenda above.
- **Smart select** (Edit, **S**): click the object (Shift-click to exclude), drag a box, or type "the red car" — typing finds every match ("person" selects everyone; "person:2" the two clearest). One click may pick just a part (a boot's laces); click two or three spots to get the whole object. SAM 3.1 adds, subtracts or replaces the mask.
- **Remove BG v2**: name the subject for SAM 3.1; BiRefNet or Lucida gives the soft edge; real transparent PNG; optional clean background plate (Qwen-Image 2.1).
- **Layers** (Edit → Layers): one layer per named object (SAM 3.1, background filled by Qwen) or automatic layers (Qwen-Image-Layered, about 2 minutes; it describes the picture first with Qwen3-VL). Toggle, reorder, rename, export a layered **PSD** or a **ZIP** of PNGs.
- **Compare**: hover the picture — the split follows the cursor; hold **Space** for the original.
- **Video frames**: Start/End from the Library (drag or picker), swap, and Crop-to-fill / Fit-with-bars when the aspect differs.

See docs/QA_REPORT.md for how every feature performed on the test pictures, with timings and memory use.

## Daily use

1. Double-click **Darkroom** on the desktop (or `E:\Darkroom\start-darkroom.bat`).
   - If ComfyUI isn't running, it opens **Comfy Desktop** and waits for the server.
   - If Comfy Desktop shows its dashboard instead of starting ComfyUI, click your **ComfyUI** install once.
     To skip this click in future: *Comfy Desktop → Settings → Auto-launch on startup → ComfyUI*.
2. Your browser opens at <http://127.0.0.1:5178>. Keep the black Darkroom window open while you work; closing it stops Darkroom
   (ComfyUI keeps running).

### Shortcuts

| Where | Keys |
|---|---|
| Everywhere | **Ctrl+Enter** Generate / Apply / Animate |
| Edit | **V** move · **B** brush · **E** eraser · **L** lasso (hold Shift on release to subtract) · **S** smart select (Shift-click excludes) · **O** outpaint frame · **C** crop · **[ ]** brush size · **Ctrl+Z / Ctrl+Y** undo/redo · wheel zoom · Alt-drag pan · hold **Space** in Compare for the original |
| Video player | **Space** play/pause · **← / →** one frame |
| Library | **/** search |

### Tips

- Paste an image (Ctrl+V) on Generate to add it as a reference, or on Home / Edit to bring it in for editing. **Upload** on Home, Edit and the Library adds your own photos (JPEG, PNG, WebP; iPhone HEIC needs saving as JPEG first).
- Drag a thumbnail from the history rail or the Library onto any image slot.
- Video: start with **Draft**. When the motion looks right, click **Render final** to render 720p with the same seed and settings.
- Turn on **Notify when done** to get a desktop notification when a video finishes (allow notifications when the browser asks).
- Style presets live in `presets/styles.json`, camera phrases in `presets/camera.json`. Edit them freely; changes appear on
  the next page load.
- **Each launch starts clean.** Generate and Video keep your prompt, references and frames while you work (also across reloads) and start empty the next time you open Darkroom; your choices of model, aspect, style and quality are remembered. **New** clears them at any time (with Undo).
- **Boards** keep projects apart: pick a board in the top bar and everything new goes into it (new versions of a picture stay with that picture). In the Library: New board, Rename, Download ZIP, Delete board (pictures stay), and "Move to board…" for a selection.
- **Your own LoRAs:** Generate and Edit have a LoRA picker that only lists LoRAs made for the selected model (Darkroom checks each file's layers). Up to three, each with a strength. Add .safetensors files to ComfyUI's modelsloras folder and press Refresh.
- **Prompt variations:** write `a {red|blue} car at {dawn|night}` to get every combination in one click, all on the same seed so only the wording changes (up to 16 pictures per click).
- **History (Generate) and Takes (Video)** show the newest work from your Library. Hover and click ✕ to delete (it goes to Recently deleted, with Undo); failed video renders have **Dismiss** and **Clear failed**.
- **Big photos:** Klein and Qwen work at about 1–2 MP. Masked edits (Inpaint, Instruct with "Only change the masked area") and fast Remove BG leave the rest of your photo pixel-for-pixel untouched. Enhance → Restore with Klein redraws a large photo at up to 4 MP with a dedicated restore LoRA and brings it back to its full size automatically, and after a whole-picture edit a **Sharpen to full resolution** button rebuilds the detail (SeedVR2, about 20 s).
- Licences: FLUX.2 [klein] 9B and Qwen-Image 2.1 are both **non-commercial** licences — fine for personal use. See docs/AUDIT.md §7.

## Setup (already done on this PC)

**New PC or a reinstalled Windows:** follow [docs/NEW-PC.md](docs/NEW-PC.md) — Comfy Desktop, ComfyUI's settings, this
code from GitHub, then Darkroom downloads the models itself (Home › **Models and setup**; list in `scripts/models.json`) and
you restore your Library.

Requirements: Windows, Node.js 22+ (24 recommended), Comfy Desktop with ComfyUI ≥ 0.37 and the models listed in AUDIT.md.

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` starts the API server (port 5178) and the Vite dev UI (<http://127.0.0.1:5173>, hot reload). `start-darkroom.bat`
builds the UI and serves everything from port 5178.

Configuration lives in `config.json` (ComfyUI host and ports, Comfy Desktop exe path, Darkroom ports). `.env` can override it
(`DR_COMFY_URL`, `DR_DESKTOP_EXE`, `DR_SERVER_PORT`, `DR_DATA_DIR`). The library database and thumbnails are in `data/`.
Images and videos stay in ComfyUI's output folder (`E:\Comfy-Desktop\ComfyUI-Shared\output\darkroom\`); Darkroom reads them
through ComfyUI's `/view` API.

Models: `bash scripts/download-models.sh` fetches the Wan 2.2 / LTX-2.5 files again (resumable; it skips files that already
exist). LTX-2.5 is gated: accept the licence on huggingface.co/Lightricks/LTX-2.5 and log in with `hf auth login`.

### Tests

```bash
npm test
```

```bash
npm run e2e
```

`npm test` runs the unit tests (workflow patching, ComfyUI client, manifest, planning). `npm run e2e` drives the real UI in
Microsoft Edge against the real ComfyUI (Generate → Edit → Animate → Library) and saves screenshots to `proof/`. It takes 3–4 minutes and needs `npm run dev` running (or set `DR_E2E_URL=http://127.0.0.1:5178` to use the started app).

## Adding or changing a workflow

Darkroom never refers to ComfyUI node ids, only to **node titles that start with `DR_`**.

1. Build the graph in ComfyUI and check that it runs.
2. Give every node the app should control a title such as `DR_PROMPT`, `DR_SEED`, `DR_WIDTH`, `DR_IMAGE_1`, `DR_MASK` or
   `DR_OUTPUT` (right-click the node → Title).
3. **Workflow → Export (API)** and save it as `workflows/<name>.json`.
4. Add an entry to `workflows/manifest.json`: for each UI parameter, list `{title, input}` targets with a default and range.
   Optional images get a `whenMissing` plan (`remove` loaders, `bypass` the nodes they feed). List output nodes under
   `outputs`.
5. Run `npm test`. It fails if any title in the manifest is missing from the workflow.

The shipped workflows are generated by `workflows/build_workflows.py` (model file names are at the top). Run it with any
Python 3 to rebuild them; re-exporting from ComfyUI works too, as long as the titles survive.

| File | Purpose |
|---|---|
| klein_t2i / klein_ref | Klein 9B text-to-image / with 1–3 references |
| qwen_ref | Qwen-Image 2.1 with 1–3 references (mention them as <image1>, <image2>…) |
| klein_edit | Klein 9B instruction edit, optional mask |
| qwen_t2i | Qwen-Image 2.1 text-to-image |
| qwen_edit | Qwen-Image 2.1 instruction edit, optional reference and mask (pixels outside the mask are untouched) |
| qwen_edit_2511 | Qwen-Image-Edit-2511 + Lightning (alternate, not used by the UI) |
| inpaint / outpaint | Klein 9B masked fill / canvas extension, composited at full resolution |
| qwen_inpaint / qwen_outpaint | the same with Qwen-Image 2.1 |
| remove_bg | BiRefNet cut-out → RGBA PNG |
| upscale | SeedVR2 7B 2× |
| wan22_i2v | Wan 2.2 A14B (high + low noise, lightx2v 4-step), start and optional end frame |
| ltx25_i2v | LTX-2.5 22B distilled, start and optional end frame, with audio |
| video_interp | RIFE 4.26 frame interpolation (Smooth 2×) |
| video_join, video_frame, crop, import | helpers for Extend, Save frame, Crop and importing pictures |

### Changing the built-in prompts

All wording Darkroom adds is in `presets/prompts.json` (per model), `styles.json`, `camera.json` and `vlm_prompts.json`. Edit and reload the page. Run `npm test` afterwards: it checks every template exists and that no model-specific wording leaks into another model's prompts.

## Troubleshooting

**"ComfyUI isn't running" / red status pill.** Click *Start ComfyUI* in the top bar. If Comfy Desktop opens its dashboard, click
your *ComfyUI* install. *Log* in the status pill shows the last lines of the Comfy Desktop log
(`%APPDATA%\Comfy Desktop\logs\app.log`).

**Darkroom connects to the wrong ComfyUI.** Darkroom only accepts the server started by Comfy Desktop. If another tool runs its
own ComfyUI on 8188, Desktop moves to the next free port and Darkroom finds it (ports are listed in `config.json`). To force
one, set `DR_COMFY_URL=http://127.0.0.1:8189` in `.env`.

**Out of memory / "The graphics card ran out of memory".** Close other GPU-heavy apps: games, other ComfyUI windows, and browser
tabs using WebGPU. Use Draft or a shorter clip. Darkroom already unloads image models before videos (`/free`), and warns when
free VRAM is too low. If a job gets *very* slow rather than failing, the NVIDIA driver is spilling into system RAM. You can
change that in *NVIDIA Control Panel → Manage 3D settings → CUDA - Sysmem Fallback Policy → Prefer No Sysmem Fallback* for
ComfyUI's `python.exe` (Darkroom does not change driver settings).

**The Library says pictures have lost their files.** Their file is gone from ComfyUI's output folder (a disk cleaner,
or a Library brought to a new PC without the output folder; see docs/NEW-PC.md). Copy the output folder back if you have
a backup, then reload; otherwise press *Move to Recently deleted* (DECISIONS 137).

**A video takes 5–15 minutes instead of about one (it says "Slow: graphics memory full").** Measured on this PC
(DECISIONS 136): LTX 2.5 needs about 21.5 GB of the RTX 3090's 24 GB while it renders. Windows, the browser, Comfy Desktop's
window and chat apps already use 2–3 GB of the same card. When they use a little more than usual (2.8 GB instead of 2.2), the
render no longer fits and the NVIDIA driver quietly lends the card normal RAM over PCIe: the GPU shows 100 % busy, nothing is
read from disk, and the render crawls. Clearing ComfyUI's memory first does not help (Darkroom already does it before every
video). What helps: close GPU-heavy apps before long renders, and either (1) set *CUDA - Sysmem Fallback Policy → Prefer No
Sysmem Fallback* for ComfyUI's `python.exe` (above), so ComfyUI offloads part of the model itself, which is far faster than the
driver's spill, or (2) start ComfyUI with `--reserve-vram 3` (Comfy Desktop → Settings → Server config), so it leaves 3 GB for
the desktop. Darkroom changes neither: they are your settings.

**"A model file is missing: …".** The file is not in any model folder ComfyUI knows about. Run `bash scripts/download-models.sh`
or check the file names at the top of `workflows/build_workflows.py`. Folders: `E:\Comfy-Desktop\ComfyUI-Shared\models\…` and
`E:\ComfyUI\Desktop ComfyUI\ComfyUI\ComfyUI\models\…`.

**"ComfyUI rejected the workflow" after a ComfyUI update.** A core node changed its inputs. Open the workflow in ComfyUI
(Library → *Open graph in ComfyUI*), fix it, re-export in API format with the same `DR_` titles, and run `npm test`.

**A video job disappeared after restarting ComfyUI.** ComfyUI forgets its queue when it restarts. The take is marked *lost*;
render it again (settings are kept).

**Port 5178 is in use.** Set `DR_SERVER_PORT` in `.env`.

**Start over with an empty library.** Stop Darkroom and rename `data/`. Your images and videos are not touched; they stay
in ComfyUI's output folder.
