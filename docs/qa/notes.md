## Summary

Every v2 feature ran on the 10-image golden set with fixed seeds, on both image models where the feature has a model
choice. The first pass found **six real defects**, all fixed and re-run (DECISIONS 55–59):

| # | Defect found by QA | Fix |
|---|---|---|
| 1 | Smart select by text found only **one** match ("person" on a crowded street = one person) | SAM 3 `name:N` syntax via manifest `samMaxPerCategory` |
| 2 | A **single click** could return an empty mask | Lone click sent twice, so SAM returns its whole-object mask |
| 3 | Qwen3-VL text **cut off mid-word** at the token limit | Higher caps; unfinished sentence dropped |
| 4 | Klein-style captions **invented** a city and stacked two lenses | Prompt rule: no names unless written in the image; one lens mention |
| 5 | **Enhance on a small picture** gave a soft enlargement with JPEG blocks, even at Strong | SeedVR2 pre-upscale when the source is under half the working size |
| 6 | **Qwen-Image-Layered** returned noise layers when the picture had no caption | Always captioned (auto via Qwen3-VL) |

Rows re-run after a fix replace the failing ones in `runs.json`; the Enhance "before" rows are kept with the suffix
`-lanczos` so the difference is visible in the grid.

## Findings per feature

- **VLM (Qwen3-VL 8B):** captions are accurate on people, text and busy scenes; sign text ("SUNRISE BAKERY",
  "Fresh bread daily") is transcribed exactly. 2–5 s per request in this run, model load included. On the busy street it sometimes reads a partly hidden shop sign wrongly ("PAC", "Pacific Café") — small,
  distant text is the weakest case.
- **Prompt enhance:** keeps quoted text exactly ("Blue Hour") on both models; Klein output stays within 40–80 words,
  Qwen within 200.
- **SAM 3.1:** text, box and multi-click selections are clean; 1–7 s. One click may select a *part* (the laces of a
  boot) — that is SAM's normal behaviour, and the UI hint now says to click two or three spots.
- **Remove BG v2:** hair strands and cat fur survive on both edge models. On glass, **Lucida keeps real translucency**
  while BiRefNet makes the carafe opaque — Lucida is the better choice for glass and smoke; BiRefNet is slightly
  cleaner on solid objects. Naming the subject stops the matte from keeping the bench under the boots.
- **Layers:** SAM layers are fast (5–7 s) and exact but occluded areas stay empty (enable the background plate).
  Qwen-Image-Layered (about 115 s at 640 px) *does* fill the background behind removed objects, at lower resolution.
- **Instruct:** both models recolour the scarf without touching the face and rewrite "MOONLIGHT BAKERY" letter-perfect.
- **Outpaint:** both extend the street believably; Klein invents more (a new wooden door), Qwen continues more
  conservatively.
- **Enhance (clean 1 MP portrait):** Subtle is faithful on both; Klein pushes saturation slightly (the green scarf);
  Qwen is the more neutral of the two. **Strong** starts inventing content (Klein added a person at the frame edge
  of the low-res harbour) — use it for restoration of damaged pictures, not for faithful sharpening.
- **Enhance (320 px JPEG):** after the fix, SeedVR2 does the restoration and the diffusion pass adds texture; without
  it no strength setting removed the JPEG blocks.
- **Video:** Wan 2.2 (77 s) and LTX 2.5 (60 s) both honour start and end frames; the requested slow push-in is gentle
  on both.

## Recommended defaults (kept as shipped)

- Enhance denoise: Klein Subtle 0.3 / Strong 0.6; Qwen Subtle 0.35 / Strong 0.65 — Subtle for photos you want kept as
  they are, Strong for damaged or very soft sources.
- Remove BG edge model: BiRefNet by default; switch to Lucida for glass, smoke, veils and fine hair on busy backgrounds.
- Layers: SAM mode for exact object cut-outs at full resolution; Qwen mode when you need the background filled in.

## Incidents during testing

- **ComfyUI stall (Phase 1 A/B):** during a Wan render ComfyUI stopped answering HTTP for more than 8 minutes with
  VRAM full at 24 GB — the NVIDIA "system memory fallback" pattern. It was restarted from Comfy Desktop and the same
  job then ran in 83 s. Darkroom now waits through heavy steps without flipping to "offline" and shows a stall message
  after 3 minutes (DECISIONS 60).
- **LTX timing artefact:** the Phase 1 video A/B showed LTX 3–4× slower for the new prompts. It was the harness running
  back to back without `/free`; with `/free` (which the app always does before video) LTX is 48–50 s either way.
- **Shared GPU during QA:** one Qwen enhance case and the first stress round were contaminated by an extra test job on
  the same GPU; both were re-run on an idle GPU and only the clean numbers are reported.

## Remaining issues, ranked

1. **Qwen-Image-Layered is slow and low-resolution** (about 115 s, 640 px long edge, 24 GB peak). Its layers need an
   upscale for print use. Mitigation: use SAM layers + background plate for full-resolution work.
2. **Single-click selection is ambiguous** (part vs. whole object). Mitigated by the multi-click hint; a future option
   is to show SAM's three candidate masks and let the user pick, which needs a node that exposes them.
3. **Small, distant text** in captions is sometimes misread by Qwen3-VL 8B.
4. **Klein Strong enhance invents content** at frame edges; the Strong tooltip now says so; default stays Subtle.
5. **Video end frame equal to start frame** gives a gentle, almost static clip on both models — expected, but worth a
   hint in the UI when both slots hold the same picture.
6. ~~**The amber mask overlay is hard to see on yellow or orange subjects.**~~ **Fixed:** the overlay now has a
   two-tone outline (white inside, dark outside) at a constant on-screen width (DECISIONS 61).
