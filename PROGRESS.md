# Darkroom — progress

## v2 expansion (approved 2026-09-29; plan in docs/PLAN.md)

| Phase | Branch | Status |
|---|---|---|
| 0 Git baseline | `main` @ `v1.0-baseline` | ✔ |
| 1 Prompt system | `phase-1-prompts` | ✔ code + 192 unit tests; A/B done (grids in `docs/qa/phase1/`): new ≥ old on every row |
| 2 Local VLM (Qwen3-VL 8B) | `phase-2-vlm` | ✔ verified on the golden set (15 captions/reverse prompts, 6 enhances); truncation + invented-place fixes in Phase 6 |
| 3 Enhance | `phase-3-enhance` | ✔ defaults confirmed on the golden set; SeedVR2 pre-upscale added for small sources (Phase 6) |
| 4 SAM 3.1 / BG v2 / Layers | `phase-4-segment-layers` | ✔ live-verified in Phase 6 (multi-match text, click fix, Layered caption fix); PSD/ZIP unit-tested |
| 5 UI (compare, video frames) | `phase-5-ui` | ✔ code; Playwright spec `e2e/features-v2.spec.ts` |
| 6 QA | `phase-6-qa` | ✔ 61 feature runs on the golden set, 6 defects found and fixed, stress 25/25 with no OOM → `docs/QA_REPORT.md` |

### Log
- 2026-09-30 — Phase 6 QA. Golden set (10 synthetic images) + every feature on both models. Found and fixed: SAM text
  kept only one match; single SAM click could be empty; VLM text cut mid-sentence and invented places; Enhance could not
  restore small JPEGs (now SeedVR2 first); Qwen-Image-Layered produced noise without a caption (now auto-captioned).
  Swap-stress: 3 rounds across all 9 model families, 25/25 jobs, identical timings per round (no leak). DECISIONS 55–60.
- 23:40 — A/B closed. Product style re-render: softboxes/light stands gone, clean studio look on both models. LTX "slowdown" in the video A/B was a harness artifact (no `/free` between runs); with `/free` 48–50 s, same as v1. Raw renders kept on disk, untracked (grids + runs.json committed).
- 23:10 — A/B review: Qwen "Perform inpainting" template worse for *adding* content → reverted to plain text (kept for background-plate removal). Product style named softboxes → Klein painted them → rewritten to describe the look. Ink sketch clearly better; others equal.
- 22:58 — ComfyUI hung during a Wan A/B render (HTTP dead 8+ min, VRAM full at 24.0 GB — sysmem-fallback pattern). Restarted from Comfy Desktop; the same job then ran in 83 s. Added: discovery grace period (heavy steps no longer flip Darkroom to "offline"), stall watchdog message after 3 min, per-run harness timeouts. RAM ruled out (`/free` returns RAM to ~48 GB after every family).
- 22:20 — Phases 2–5 implemented on stacked branches while A/B renders ran.
- 21:50 — Plan approved: Qwen3-VL 8B (installed) as VLM; SAM 3.1 + Qwen-Image-Layered fp8 downloaded (22 GB).

## v1 (2026-09-29, earlier)
All four screens, 15 workflows, 67 unit + 7 e2e tests — see git tag `v1.0-baseline`.
