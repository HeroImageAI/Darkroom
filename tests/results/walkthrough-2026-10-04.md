# Darkroom walk-through — 2026-10-04 (v3.22.1, clean Library)

Koos asked for a clean Darkroom, presets for the five industries, then a walk through every screen in order —
Generate, Edit, Compose, Video, Timeline — testing each feature on the way. Everything ran in Koos's own Darkroom
through its UI (visible Edge window); results are in the Library on boards **Footwear, Automotive, Apparel, Gaming,
Movie**. Scripts: `tests/run/walk-*.ts` and the plans `tests/results/walk-*.json`; screenshots
`tests/results/screenshots/WALK-*`; contact sheets `tests/results/sheets/WALK-*.jpg`.

## Before: clean Library and presets
- Library: all 257 items moved to **Recently deleted** (with the 183 already there: 440), the six test boards
  removed. *Empty* in Recently deleted, the one old film (Timeline) and the one old composition (Compose) are left
  for Koos — permanent deletes.
- Presets (v3.22.1, DECISIONS 110): **28 industry Edit presets** (Apparel 6, Footwear 7, Gaming 5, Movie 4,
  Automotive 6) first in the Presets menu, each marked with the model that won its test; **5 Generate styles**
  (Apparel flat, Footwear studio, Game concept, Film still, Car studio).

## 1. Generate — 7 of 7
| Feature | Result |
|---|---|
| Five concepts in their industry style (shoe and car on both models) | all on brief; Klein 9–14 s, Qwen ~23 s; Qwen kept the car's full-width light bar |
| Prompt Enhance + Undo | rewrote a short idea into a full prompt; Undo restored it |
| {a\|b} variations | 2 pictures on one seed |
| A History picture as reference | the shoe on a mossy rock in a forest stream |
| Vary | a new seed |
| Upscale 2× | 2688×1536 in place |
| Quality High | 1920×1088 (2.1 MP) |
| Reuse settings | the old prompt came back |

## 2. Edit — 30 of 30
- **21 industry presets**, each on its recommended model, all on brief: shoe clay / marker sketch / exploded view /
  material zones / black-volt colourway / on foot; car clay / chrome / matte sand / four-view board; jacket waxed
  canvas / navy-yellow / on a model / multi-view; scavenger turnaround / polished; lighthouse storm / 1970s sci-fi /
  charcoal panel. The Qwen copy check never fired.
- **Inpaint with Smart select** (orange outsole by "outsole"; glowing goggles by "goggles"), **Outpaint**, **Remove
  BG** (shoe, car), **Enhance › Restore**, **Layers** (2 layers + PSD/ZIP), **Crop**, **Compare with the previous
  version**, **Advanced** (seed 7 locked, shown in the closed summary), the **Outpaint frame tool**.
- Found: Outpaint keeps the original in the middle (a studio car "extended" into a night street kept its white
  studio) — now explained in the panel, pointing to Instruct; Restore cleared the deliberate fog of a dawn scene — now
  explained, pointing to Upscale; the four-view car board drifts one view (known multi-view limit); a Layers run showed
  "v6" twice in the version strip — fixed.

## 3. Compose — 4 of 4
- Backdrops from Generate, then **cut-outs from Edit placed and scaled, Harmonised**: the shoe on a granite boulder at
  sunrise, the car on a wet neon street — both read as one photograph.
- **Rough paint on a blank canvas** switches the suggestion to **Reimagine** and renders.
- Found: layers and the Library picker were named by prompt, not title — fixed. A render goes to the *working* board
  (the shoe composite landed in Automotive because the working board was still Automotive) — worth knowing; the
  working board is shown top right.

## 4. Video — 7 takes, Final 720p, 5 s
| Take | Score | Note |
|---|---|---|
| Trail shoe · clay to colour (start/end) | 5 | clay turns into the finished shoe in place |
| Lighthouse keeper · the storm | 5 | lightning, tilt up to the lit lamp, keeper steps back |
| Trail shoe · turntable | 4 | about a quarter turn |
| Trail shoe · sunrise on the trail | 4 | sun rises, mist moves |
| Rain shell · first raindrops | 4 | she pulls the hood up; no visible rain |
| EV crossover · rain in the city | 2 | the car drives at the camera and becomes another car |
| Desert scavenger · idle | 2 | "shifting weight" becomes a crouch |
Same pattern as the test suite: LTX is strong at in-place change and atmosphere, invents motion for vehicles and
characters. Every take renders in about 2 minutes.

## 5. Timeline — 8 of 8 (after fixing my script's clicks)
New film from five takes found by title, 4 crossfades, **Split at playhead**, remove the tail, **Fill with AI** (2.0 s,
LTX), export twice (23.0 s, 1280×704). Found: clips, the Inspector and the AI fill were labelled with the motion
prompt — fixed (titles; AI clips are now named after the film).

## Fixed in this pass (DECISIONS 111, branch `walk-fixes`)
Titles on Compose layers, the Library picker, Timeline clips, the Inspector and the bin; Timeline AI clips titled after
the film; one version frame per Layers group; Outpaint and Restore explain when to use Instruct or Upscale.
