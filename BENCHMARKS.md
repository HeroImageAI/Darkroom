# Benchmarks

Measured on this machine: RTX 3090 24 GB, Threadripper 1950X, 64 GB RAM, ComfyUI 0.37.4 (Comfy Desktop), Windows 11.
Times are wall-clock from queueing to the last output, measured through the API by `scripts/run-workflow.ts`
(`bench/results.jsonl` has the raw data). "Peak VRAM" is whole-GPU usage sampled every 0.5 s (it includes Windows and other
apps, ~1.3 GB at idle). ComfyUI's dynamic VRAM keeps models resident while there is room, so peaks near 22-24 GB are normal
and not a sign of trouble.

"Cold" = first run after the models were unloaded (includes loading from disk); "warm" = models already in memory.

| Run | Workflow | Size | Clip | Time | Per second of video | Peak VRAM |
|---|---|---|---|---|---|---|
| klein_t2i cold 1024 | klein_t2i |  |  | 13.7 s |  | 20.6 GB |
| klein_t2i warm 1024 | klein_t2i |  |  | 7.8 s |  | 20.6 GB |
| klein_t2i warm 1024 x4 | klein_t2i |  |  | 24.5 s |  | 22.8 GB |
| klein_ref 1 ref 3:2 | klein_ref | 1248×832 |  | 15.2 s |  | 21.5 GB |
| qwen_t2i cold 4:5 25 steps | qwen_t2i | 1184×1472 |  | 41.4 s |  | 18.0 GB |
| qwen_edit cold no mask | qwen_edit |  |  | 43.4 s |  | 25.0 GB |
| qwen_edit warm masked | qwen_edit |  |  | 48.8 s |  | 25.1 GB |
| inpaint_cold | inpaint |  |  | 21.0 s |  | 20.7 GB |
| outpaint_to_wide | outpaint |  |  | 15.6 s |  | 20.5 GB |
| remove_bg | remove_bg |  |  | 5.1 s |  | 2.6 GB |
| upscale 2x 1024 | upscale |  |  | 17.7 s |  | 14.0 GB |
| outpaint 1024->1536x1024 | outpaint |  |  | 19.0 s |  | 20.9 GB |
| inpaint warm 1024 | inpaint |  |  | 14.8 s |  | 20.5 GB |
| klein 3:2 x2 (queued behind the stalled untiled-decode job; see DECISIONS #16) | klein_t2i | 1248×832 |  | 518.7 s |  | 23.2 GB |
| klein 3:2 x2 tiled decode (sampling cached, decode only) | klein_t2i | 1248×832 |  | 3.1 s |  | 20.5 GB |
| wan draft 480p 5s cold | wan22_i2v | 832×480 | 5.0 s | 154.3 s | 30.9 s/s | 22.9 GB |
| wan draft 480p 5s warm | wan22_i2v | 832×480 | 5.0 s | 153.0 s | 30.6 s/s | 22.6 GB |
| wan final 720p 5s | wan22_i2v | 1280×720 | 5.0 s | 538.0 s | 107.6 s/s | 22.3 GB |
| wan draft 480p 3s end-frame | wan22_i2v | 832×480 | 3.0 s | 81.8 s | 27.3 s/s | 23.7 GB |
| ltx draft 480p 5s cold | ltx25_i2v | 864×480 | 5.0 s | 78.7 s | 15.7 s/s | 25.2 GB |
| ltx draft 480p 3s warm | ltx25_i2v | 864×480 | 3.0 s | 29.1 s | 9.7 s/s | 24.3 GB |
| ltx final 720p 5s | ltx25_i2v | 1280×704 | 5.0 s | 104.5 s | 20.9 s/s | 24.8 GB |
| ltx draft 480p 3s end-frame | ltx25_i2v | 864×480 | 3.0 s | 31.2 s | 10.4 s/s | 24.4 GB |
| qwen21_edit masked 1024 cold | qwen_edit |  |  | 26.8 s |  | 20.9 GB |
| qwen21_edit no mask 1024 warm | qwen_edit |  |  | 25.1 s |  | 18.8 GB |
| qwen21_edit masked 1024 (real latent) | qwen_edit |  |  | 25.2 s |  | 20.0 GB |
| klein_edit no mask | klein_edit |  |  | 16.2 s |  | 21.3 GB |
| klein_edit masked | klein_edit |  |  | 13.1 s |  | 20.7 GB |
| qwen_inpaint | qwen_inpaint |  |  | 26.6 s |  | 20.9 GB |
| qwen_outpaint 1024->1536x1024 | qwen_outpaint |  |  | 26.9 s |  | 19.5 GB |
| qwen_ref 1 ref 3:2 | qwen_ref | 1584×1056 |  | 40.0 s |  | 20.0 GB |
| qwen_outpaint v2 1024->1536x1024 | qwen_outpaint |  |  | 26.5 s |  | 18.8 GB |
| qwen_outpaint blur-feather 1024->1536x1088 | qwen_outpaint |  |  | 23.3 s |  | 18.7 GB |
| outpaint blur-feather 1024->1536x1088 | outpaint |  |  | 17.3 s |  | 20.8 GB |
| qwen_inpaint blur-feather | qwen_inpaint |  |  | 27.6 s |  | 20.9 GB |

## Estimates used by the Video screen

The time shown above the Animate button is `k × seconds^p`, fitted to the runs above (see `workflows/manifest.json`):

| Model | Quality | Formula | 3 s | 5 s | 8 s |
|---|---|---|---|---|---|
| Wan 2.2 A14B + lightx2v (2+2 steps) | Draft 832×480 | 21.3·s^1.225 | ~82 s | ~153 s | ~272 s |
| Wan 2.2 A14B + lightx2v | Final 1280×720 | 74.8·s^1.225 | ~287 s | ~538 s | ~955 s |
| LTX-2.5 22B distilled (8 steps) | Draft 864×480 | 7.0·s^1.3 | ~29 s | ~57 s | ~105 s |
| LTX-2.5 22B distilled | Final 1280×704 | 12.9·s^1.3 | ~54 s | ~105 s | ~193 s |

In seconds of compute per second of video: Wan ≈ 30 s/s at 480p and ≈ 108 s/s at 720p; LTX ≈ 10–16 s/s at 480p and
≈ 21 s/s at 720p. The first video after using image models adds model-load time (~25 s LTX, a few seconds for Wan,
whose experts stream in).

## Images (warm unless noted)

- Edit, Klein 9B: instruct ~13–16 s, inpaint ~15 s, outpaint ~17 s. Edit, Qwen-Image 2.1: instruct / inpaint / outpaint ~25–27 s.
- Qwen-Image 2.1 with 1 reference, 1584×1056: ~40 s.

- Klein 9B 1024², 4 steps: ~8 s (14 s cold). Batch ×4: ~25 s. With 1 reference: ~15 s.
- Qwen-Image 2.1 1184×1472, 25 steps: ~41 s cold.
- Qwen-Image 2.1 instruction edit (25 steps, 1 MP): ~25 s. (The earlier Qwen-Image-Edit-2511 graph took ~45 s.)
- Klein inpaint / outpaint: 15–21 s. Remove BG (BiRefNet): ~5 s. SeedVR2 7B 2× (1 MP → 4 MP): ~18 s.
- RIFE 2× on a 49-frame clip: a few seconds. Join / crop / import / save frame: under 2 s.

## VRAM

Peak whole-GPU usage reaches 20–25 GB for every model family, because ComfyUI's dynamic VRAM keeps as much resident as
fits. That is expected. Darkroom calls `/free` before video jobs and whenever the model family changes, so Klein and Qwen
are never loaded together. All image decodes are tiled, so a busy GPU slows jobs down a little instead of stalling them.
