# Darkroom — progress

## v2 expansion (approved 2026-09-29; plan in docs/PLAN.md)

| Phase | Branch | Status |
|---|---|---|
| 0 Git baseline | `main` @ `v1.0-baseline` | ✔ |
| 1 Prompt system | `phase-1-prompts` | ✔ code + 192 unit tests; A/B done (grids in `docs/qa/phase1/`): new ≥ old on every row |
| 2 Local VLM (Qwen3-VL 8B) | `phase-2-vlm` | ✔ code; caption verified live (fisherman test, accurate); full QA in Phase 6 |
| 3 Enhance | `phase-3-enhance` | ✔ code; defaults to be confirmed on the golden set |
| 4 SAM 3.1 / BG v2 / Layers | `phase-4-segment-layers` | ✔ code; PSD/ZIP export unit-tested; SAM + Layered first live runs in Phase 6 |
| 5 UI (compare, video frames) | `phase-5-ui` | ✔ code; Playwright spec `e2e/features-v2.spec.ts` |
| 6 QA | `phase-6-qa` | ⏳ golden set → feature runs → stress test → QA_REPORT.md |

### Log
- 23:40 — A/B closed. Product style re-render: softboxes/light stands gone, clean studio look on both models. LTX "slowdown" in the video A/B was a harness artifact (no `/free` between runs); with `/free` 48–50 s, same as v1. Raw renders kept on disk, untracked (grids + runs.json committed).
- 23:10 — A/B review: Qwen "Perform inpainting" template worse for *adding* content → reverted to plain text (kept for background-plate removal). Product style named softboxes → Klein painted them → rewritten to describe the look. Ink sketch clearly better; others equal.
- 22:58 — ComfyUI hung during a Wan A/B render (HTTP dead 8+ min, VRAM full at 24.0 GB — sysmem-fallback pattern). Restarted from Comfy Desktop; the same job then ran in 83 s. Added: discovery grace period (heavy steps no longer flip Darkroom to "offline"), stall watchdog message after 3 min, per-run harness timeouts. RAM ruled out (`/free` returns RAM to ~48 GB after every family).
- 22:20 — Phases 2–5 implemented on stacked branches while A/B renders ran.
- 21:50 — Plan approved: Qwen3-VL 8B (installed) as VLM; SAM 3.1 + Qwen-Image-Layered fp8 downloaded (22 GB).

## v1 (2026-09-29, earlier)
All four screens, 15 workflows, 67 unit + 7 e2e tests — see git tag `v1.0-baseline`.
