# Darkroom: progress

## Status: done (2026-09-29 20:05)

- [x] **Step 1: Audit** (AUDIT.md). New Comfy Desktop v1.1.3, ComfyUI 0.37.4, port 8188 (discovered at runtime).
- [x] **Backups** in `./backup/` (pip freeze, custom_nodes listing, Desktop settings/installations/model-path YAMLs, commit).
- [x] **Step 2: Models.** Wan 2.2 I2V (fp8 + lightx2v), LTX-2.5 (int8 + Gemma int8), RIFE/FILM downloaded. Everything else
  was already present. No custom nodes needed; `.venv` untouched.
- [x] **Workflows**: all 15 tested through the API, with outputs checked by eye (images opened, video frames sampled):

  | Workflow | Result |
  |---|---|
  | klein_t2i / klein_ref | ✔ 8 s warm / 15 s with a reference |
  | qwen_t2i | ✔ typography rendered correctly |
  | qwen_edit | ✔ relight; masked recolour leaves the rest untouched |
  | inpaint / outpaint | ✔ coherent fills, full-resolution composite |
  | remove_bg | ✔ RGBA PNG |
  | upscale | ✔ SeedVR2 2× |
  | wan22_i2v | ✔ 480p 3 s / 5 s, 720p 5 s, with end frame |
  | ltx25_i2v | ✔ 480p 3 s / 5 s, 720p 5 s, with end frame, with audio |
  | video_interp | ✔ 49 → 97 frames at 32 fps |
  | video_join | ✔ 49 + 81 − 1 = 129 frames, no visible seam |
  | crop, video_frame, import | ✔ |

- [x] **Step 3: App.** Fastify + `node:sqlite` server, React UI with all four screens.
  - [x] Phase A Generate (proof/A*, E1–E3)
  - [x] Phase B Edit (proof/B*, E4–E6)
  - [x] Phase C Video: survives reload; Smooth, Extend, Render final (proof/C*, E7–E9)
  - [x] Phase D Library (proof/D*, E10–E11)
- [x] **Tests:** 67 unit tests passing; strict typecheck clean; **Playwright e2e 7/7 passing** against real ComfyUI.
- [x] **UX pass:** empty states, offline state (proof/X-*), plain-language errors, visible shortcuts, unsaved-mask guard,
  VRAM warning dialog.
- [x] **One-click start:** `start-darkroom.bat` + desktop shortcut tested (proof/F1-production-5178.png).
- [x] Library holds at least one real output from every workflow (33 items).

## Log
- 20:00: Production launch via start-darkroom.bat verified; e2e 7/7 green.
- 19:45: LTX-2.5 measured: 480p 3 s 29 s, 5 s 79 s cold; 720p 5 s 105 s.
- 19:25: Extend +5 s (server-side chain) and Smooth 2× verified.
- 19:20: Wan draft via UI: estimate 1m22s, actual 1m22s.
- 19:10: Wan measured: 480p 3 s 82 s, 5 s 153 s; 720p 5 s 538 s.
- 18:45: Fixed a 12-minute VAE-decode stall (driver sysmem fallback); all image decodes are now tiled.
- 18:15: Server pipeline verified end to end.
- 16:15: Klein 9B t2i verified through the API.
- 16:00: Desktop auto-launch setting could not be changed from here (sandbox: persistence); the launcher waits instead.
- 15:45: Forma's private ComfyUI server closed by user; Desktop server started.
