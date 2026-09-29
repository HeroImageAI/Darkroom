# Decisions

Each choice made while building Darkroom, and why. Newest decisions are appended at the bottom.

## Environment

1. **Target the new Comfy Desktop (v1.1.3), not the layout in the brief.** The machine runs the "installations"-based
   Comfy Desktop. ComfyUI lives at `E:\ComfyUI\Desktop ComfyUI\ComfyUI\ComfyUI`, settings in `%APPDATA%\Comfy Desktop\`,
   and the default models folder is `E:\Comfy-Desktop\ComfyUI-Shared\models`. All paths are in `config.json`/`.env`.
2. **Port is discovered, never hard-coded.** Desktop defaults to 8188 and moves to the next free port on conflict. Darkroom
   probes the ports listed in `config.json` and only accepts the server whose `/system_stats` argv contains
   `instance-model-paths` (Desktop-launched). That avoids talking to other ComfyUI servers on this machine (e.g. Forma's).
3. **No custom nodes installed.** ComfyUI 0.37.4 has native nodes for everything: Klein (`ReferenceLatent`,
   `Flux2Scheduler`), Qwen-Image 2.1, Qwen-Image-Edit-Plus, Wan 2.2, LTX-2.5, SeedVR2, BiRefNet (`RemoveBackground`),
   RIFE/FILM (`FrameInterpolate`) and MP4 (`SaveVideo`). Fewer packs means nothing to break on a Desktop update, and no
   Python packages were added to the `.venv`.
4. **New models go to `E:\Comfy-Desktop\ComfyUI-Shared\models`.** It is Desktop's registered default folder, so no model
   YAML needed editing, and E: has 1.2 TB free.
5. **Desktop auto-launch is left to the user.** Changing `autoLaunchOnStartup` in Desktop's settings was blocked by
   this session's sandbox as a persistence change. `start-darkroom.bat` opens Desktop and waits; if Desktop shows its
   dashboard, one click on the "ComfyUI" install starts the server. README explains the one-time setting that removes
   that click.

## Models and precision (RTX 3090, 24 GB)

6. **Klein 9B: `flux-2-klein-9b-fp8mixed` (9 GB) + `qwen_3_8b_fp8mixed` text encoder.** It was already installed, so
   it is ~2× smaller than bf16 and fits with room for batch ×4. It's the distilled model (4 steps, CFG 1, euler), per the
   official template. The bf16 KV variant (17 GB) was not used: the speed-up only matters for multi-reference edits, and
   bf16 + 8 GB encoder crowds 24 GB.
7. **Qwen-Image 2.1: `int8_convrot` weights and text encoder (already present).** 25 steps, CFG 1, euler/simple (template
   default; the official 40–50 steps is available under Advanced). Native sizes around 1.76 MP (e.g. 1328², 1664×928).
8. **Qwen-Image-Edit-2511 FP8 + Lightning 4-step LoRA** for Instruct mode, as the brief asks. It runs at ~45 s because
   19.5 GB of weights plus the 7B encoder exceed 24 GB and are partly offloaded. Note: Qwen-Image 2.1 can also edit
   natively and would be faster; it is a candidate if speed matters more than 2511's edit consistency.
9. **Inpaint and outpaint use Klein 9B, not Qwen-Edit.** Klein is ~3× faster (15 s vs 45 s) and is usually already loaded
   from Generate, so no model swap is needed. It fills masked latents while seeing the whole picture as a `ReferenceLatent`,
   which gives coherent fills (see the bench/inpaint and proof screenshots). The result is composited back at the
   source's full resolution, so pixels outside the mask are bit-exact.
10. **Masks are uploaded as a plain black/white PNG (`/upload/image`) and read with `LoadImageMask` (red channel).**
    `/upload/mask` merges the mask into the original's alpha and needs `original_ref`. A standalone mask is simpler, works
    for any source (library item, upload), and is easy to inspect.
11. **Upscale = SeedVR2 7B "sharp" int8 (already installed) with its EMA VAE, 1 step, LAB colour match.** Real 2× detail
    in ~18 s at 1 MP → 2 MP.
12. **Background removal = core `RemoveBackground` + BiRefNet**, which was already installed. The output is an RGBA PNG.
13. **Wan 2.2 I2V A14B fp8_scaled (high + low noise experts) + lightx2v 4-step LoRAs, shift 5, 2+2 steps.** This is the
    official template's fast path. It fits a 3090 with ComfyUI's dynamic VRAM, so no GGUF or block-swap node is needed.
    It uses `WanFirstLastFrameToVideo`, so one graph covers start-only and start+end. 16 fps, frame counts 4n+1.
14. **LTX-2.5: 22B distilled `comfy-int8-convrot` + Gemma-4 12B int8 encoder**, from the gated Lightricks repo (the
    cached HF token already had access). NVFP4 needs Blackwell; bf16 is 42 GB. 24 fps, frame counts 8n+1.
15. **Frame interpolation = RIFE 4.26** (23 MB, core node). It's fast and good for 2×; FILM was also downloaded.
16. **Tiled VAE decode (1024 px tiles, 128 overlap) for all image workflows.** A plain decode of a ×2 batch stalled for
    12 minutes when other apps held VRAM: the NVIDIA driver's "sysmem fallback" silently spilled to system RAM instead of
    raising OOM. Tiled decode bounds memory; no seams were visible in tests.
17. **Live previews use `latent2rgb`**, sent per prompt via `extra_data.preview_method`. It's cheap and needs no extra
    model, and it doesn't change ComfyUI's global setting.

## App

18. **Stack as proposed:** Vite + React + TypeScript (strict) UI and a Fastify server. **SQLite via Node 24's built-in
    `node:sqlite`**, which avoids native builds (better-sqlite3) on Windows. `sharp` makes thumbnails (prebuilt binaries).
19. **Jobs are owned by the server, not the page.** The server holds the ComfyUI WebSocket (its own client id), tracks
    every job in SQLite and ingests outputs into the library on success. Reloading the page, or closing it during a
    30-minute render, loses nothing; on reconnect the server reconciles with `/queue` and `/history`.
20. **Every output is a real ComfyUI output.** Imports, crops and saved video frames go through tiny workflows
    (`import.json`, `crop.json`, `video_frame.json`), so the Library only ever points at files ComfyUI wrote. Darkroom
    reads them via `/view`, never by guessing paths.
21. **Extend +5 s is chained on the server:** it renders the continuation from the last frame, then automatically
    queues `video_join.json`, which drops the duplicated first frame of clip B.
22. **Workflows are generated by `workflows/build_workflows.py`** (API format) rather than hand-exported, so model file
    names live in one place. The app only addresses nodes by `DR_*` title through `workflows/manifest.json`. Re-exported
    or hand-edited graphs work as long as the titles stay. Unit tests check every manifest title exists in every
    workflow.
23. **Optional inputs are handled by graph surgery, not placeholder images.** A missing optional image removes its
    loader, bypasses its `ReferenceLatent`/mask nodes (rewiring consumers), and prunes whatever no output needs.
24. **PNG metadata:** each job passes `extra_data.extra_pnginfo.darkroom` (workflow, mode, model, prompt, params,
    parent). ComfyUI writes it into the PNG next to the API `prompt`, so images are self-describing and can be dropped
    back into ComfyUI.
25. **"Open graph in ComfyUI"** downloads the exact API graph and opens ComfyUI in a new tab; you drop the file on the
    canvas. The ComfyUI frontend has no URL parameter for loading a graph, so a one-drop step is the most reliable
    method.
26. **Prompt "Enhance" is a stub** (`POST /api/enhance`) that returns the prompt unchanged and says so. It's one function
    to replace later.
27. **Fonts are bundled (@fontsource)**, so the UI looks right offline. Icons: lucide-react.
28. **Playwright drives the installed Microsoft Edge (`channel: 'msedge'`).** The Playwright Chromium download timed out
    while 78 GB of models were downloading, and Edge is the browser actually used on this machine.
29. **VRAM guard for video:** before queueing a video, Darkroom calls `/free` and checks free VRAM. Below the model's
    need, it shows a plain-language warning with "Queue anyway" instead of letting ComfyUI hit OOM. `/free` is applied
    by ComfyUI between prompts, so it never interrupts a running job.
30. **No design files were supplied** (confirmed with the user). The UI follows the written spec: tokens, fonts, and the
    380/112, 68/392, 380/300 and 5-col/420 layouts.
31. **LTX-2.5 graph = single stage at full resolution, derived from the official first/last-frame template** (8
    manual sigmas, euler-ancestral, guides at frame 0 and −1). It supports an optional end frame with the same graph.
    The official I2V template's two-stage path (half-res plus the ×2 latent upscaler) wasn't needed: single-stage 720p
    5 s already renders in ~105 s on the 3090. The upscaler file is downloaded in case you want to try it.
32. **Time estimates use `k·seconds^p`** fitted per model and quality (see BENCHMARKS.md). A linear fit under-estimated
    long clips, because attention cost grows faster than frame count.
33. **Video items get a "Reuse settings" action too** (found during the e2e run): it loads frames, motion prompt, model,
    length and quality back into the Video screen.
34. **Instruct edits now use Qwen-Image 2.1's native edit, not Qwen-Image-Edit-2511** (the user's choice, 2026-09-29).
    Graph from the official 2.1 edit template (`TextEncodeQwenImage21` + `QwenImage21Cache`, 25 steps, CFG 1). It is
    also faster: ~25 s vs ~45 s. The 2511 graph is kept as `qwen_edit_2511.json` and is not used by the UI.
35. **Masked Instruct edits leave every pixel outside the mask untouched.** The old graph composited at the model's
    resized working resolution, so the whole picture was resampled (the "slight changes" the user saw). Now the result is
    scaled back to the source size and composited onto the original pixels, and the sampler starts from the encoded
    picture rather than an empty canvas, so the masked area blends with its real surroundings. Verified: 0 of 690k pixels
    changed outside the (grown + feathered) mask.
36. **Darkroom uses exactly two image models: FLUX.2 Klein 9B and Qwen-Image 2.1** (user's choice, 2026-09-29). Edit has a
    model picker for Instruct, Inpaint and Outpaint (`manifest.edit` maps mode → model → workflow). Generate with references
    now uses the chosen model (`qwen_ref.json` uses Qwen 2.1's native multi-image input) instead of always Klein.
    Remove BG (BiRefNet) and Upscale (SeedVR2) are dedicated tools, not image models, so they have no picker.
    Qwen-Image-Edit-2511 is no longer used anywhere (`qwen_edit_2511.json` is kept, unreferenced).
37. **Qwen outpaint shows the model the original picture, not the grey-padded canvas.** An edit model copies what it is
    shown, so with the padded canvas it kept the grey borders.
38. **Mask edges are softened with a real blur (MaskToImage → ImageBlur → ImageToMask), not FeatherMask.** FeatherMask
    fades the mask toward the canvas border, which left a thin grey frame around outpainted pictures. Pixels further than
    grow + blur from the mask are bit-exact (verified); outpaint blends up to ~90 px into the original edge by design.

## v2 expansion (2026-09-29, approved plan in docs/PLAN.md)

39. **Git from here on.** `v1.0-baseline` tag, one branch per phase (`phase-1-prompts` … `phase-6-qa`), stacked.
40. **All prompt text is composed in one pure module** (`src/shared/prompts.ts`) from `presets/prompts.json`,
    `styles.json` and `camera.json`, keyed by model. Unit tests forbid Qwen-only wording (`<imageN>`, `Style:`,
    "Ultra HD", the official fill templates) in Klein prompts and vice versa. Rules and sources: docs/PROMPT_AUDIT.md.
41. **Styles are per-model sentences, not keyword suffixes.** Klein gets prose appended after the subject (FLUX.2:
    subject → action → style → context; no negations). Qwen gets a `Style:` description plus the official quality tail
    for photographic and cinematic looks.
42. **Qwen inpaint and outpaint use Qwen's official fixed templates** ("Perform inpainting on this image…", "Extend
    the image beyond its boundaries using outpainting…") with a caption of the original. The caption is never taken from
    an edit instruction (`captionFromLineage`). Without one, the local VLM describes the picture once and it is stored on
    the item. Fixes the v1 bug where Qwen outpaint sent raw text.
43. **Klein's instruct preservation clause doesn't mention lighting.** Caught in the dry run: "keep … lighting"
    contradicts relighting instructions ("make it night").
44. **Negative prompts removed from Wan and LTX** (`*.v2.json`). At CFG 1 ComfyUI skips the unconditional pass
    (`comfy/samplers.py:610`), and the LTX-2.5 card says the distilled model runs at CFG=1. v1 graphs are kept.
45. **Klein guidance is fixed at 1** (distilled); the UI shows it as fixed instead of a slider. Qwen gets a visible
    Quality choice: Standard (25 steps, ~1.8 MP) or High (40 steps, model-card ~4 MP sizes).
46. **Qwen "Transparent background"** uses the model card's RGBA wording. Verified: the saved PNG has a real alpha
    channel (44 % fully transparent pixels on the test sticker).
47. **VLM = the installed Qwen3-VL 8B int8** (user's choice), which is Qwen-Image 2.1's own text encoder. It has the
    LM head and vision tower (checked from the file header). It's loaded through core `TextGenerate` with the generic
    CLIP type, which makes ComfyUI build the plain Qwen3-VL chat model. No custom nodes and no download. Sampling follows
    the Qwen card's instruct defaults (T 0.7, top-p 0.8, top-k 20); thinking is off.
48. **VLM system prompts live in one file** (`presets/vlm_prompts.json`), adapted from the official Qwen-Image
    rewriters, Wan 2.2's I2V system prompts, the BFL FLUX.2 guide and the LTX guide. TextGenerate has no system slot, so
    instructions are prefixed to the user turn.
49. **VLM auto-unload:** after a text job, if nothing else is queued, Darkroom calls `/free` so the next image or video
    job gets the whole GPU. `vlm`, `sam` and `layered` are their own families, so the existing free-on-family-change
    applies to them too.
50. **Enhance = low-denoise re-render, never a new composition.** Klein: source as ReferenceLatent + source latent,
    `SplitSigmasDenoise` on a ~4/denoise-step schedule, so ~4 real steps run at any strength. Qwen: 2.1 edit conditioning,
    KSampler denoise < 1. The working size is the source clamped to 1–2 MP, so low-res inputs are upscaled into the model's
    range first. Upscale + enhance = subtle enhance, then SeedVR2 2× (a server chain).
51. **Background removal v2:** SAM 3.1 decides *which* object (text, optional); BiRefNet (or Lucida) supplies the soft
    alpha. Final alpha = matting alpha × feathered, dilated SAM mask. Output is always a real RGBA PNG from
    `JoinImageWithAlpha`; Qwen is only used for the optional *background plate* (official inpaint template on the dilated
    subject mask), never for the cutout itself.
52. **Layers:** Mode A = SAM `individual_masks` → one RGBA layer per object via a single `JoinImageWithAlpha` (it
    repeats the image to the mask batch), plus an optional Qwen background plate. Mode B = Qwen-Image-Layered fp8mixed
    (20.5 GB, official template settings: 640 px, 20 steps, CFG 2.5). Layers are library items sharing a `group_id`.
    Export offers **both** a layered PSD (`ag-psd`, MIT) and a ZIP of PNGs (`fflate`, MIT); the PSD writer is
    round-trip tested.
53. **Compare** follows the cursor using direct DOM writes in `requestAnimationFrame` (no React state per mouse move).
    Both images sit in the same transformed box, so they stay aligned at any zoom. A before image with a different aspect
    is letterboxed, not stretched. Hold Space to see the original.
54. **Video frame fitting:** "Crop to fill" is the graph's existing centred crop. "Fit with bars" letterboxes the frame
    on a canvas and uploads it at submit time, so no graph change was needed. Both Wan (`WanFirstLastFrameToVideo`) and
    LTX (`LTXVAddGuide` frame −1) support end frames, so the slot stays enabled.

### Phase 6 (QA on the golden set)

55. **Enhance pre-upscales small pictures.** QA showed Klein and Qwen img2img at enhance strengths keep the blur and JPEG
    blocking of a lanczos-enlarged source; even Strong (0.6 / 0.65) returned a soft enlargement of a 320 px JPEG. A source
    under half the working size is now upscaled with SeedVR2 first (2–4×, rounded up to a half step; `planEnhance`),
    and the enhance pass runs on that as a server chain. Edit follows the chain (`followOf`) to the final picture. The
    enhance denoise defaults stay (Klein 0.3 / 0.6, Qwen 0.35 / 0.65): on a clean input Subtle stays faithful and Strong
    is where invented detail starts (Klein Strong added a person at the frame edge of the low-res harbour).
56. **SAM 3 text finds every match.** The SAM 3 tokenizer keeps only the best detection per comma-separated category
    unless the text says `name:N`. Manifest string params can declare `samMaxPerCategory`: smart select 20, Remove BG
    subject 10, SAM layers 3 (each match becomes a layer). A count the user types (`car:2`) is kept.
57. **A single SAM click is sent twice.** With exactly one point SAM switches to multi-mask ambiguity mode and returns its
    most confident candidate, which QA showed can be empty or a sliver. Two identical points switch that off. One click
    can still legitimately select a part (the laces of a boot); the UI hint says to click two or three spots.
58. **VLM output hygiene.** Qwen3-VL overshoots word limits by about 30 %, so token caps were raised, an unfinished last
    sentence is dropped, and a stray closing quote is removed. The Klein-style caption/reverse prompts now forbid naming
    real places, brands or people not written in the image, and allow one lens/look mention (QA saw "Taipei's Raohe
    Street" and "50mm … 85mm f/1.4" in one caption).
59. **Qwen-Image-Layered always gets a caption.** With an empty prompt its layers came out as noise (a smeared fake
    background, a pink wash). With a one-sentence caption the same seed gives a clean inpainted background plate plus
    one layer per element. Edit now auto-captions (Qwen3-VL, saved to the item) when the picture has no lineage caption.
    The ComfyUI template settings (20 steps, CFG 2.5, about 115 s) match the reference pipeline's 50 steps / CFG 4
    (about 215 s) in quality, so they stay. Asking for more layers than the picture has elements yields a near-empty
    layer, which the Layers panel shows and the user can hide or delete.
