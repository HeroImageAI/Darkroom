# Compose — feasibility A/B (DECISIONS 87)

Before any UI was built: can Qwen-Image 2.1 or Klein 9B turn a rough collage into one coherent picture? Four kinds of
rough input, each through `qwen_edit` and `klein_edit` on seed 42 with a "blend into one coherent photograph, keep the
layout" instruction (about 30 s Qwen, 20 s Klein at ~1 MP). Grid: [compose/feasibility.jpg](compose/feasibility.jpg)
(rows: car, car seams-only, sketch, blob, portrait, portrait seams-only; columns: collage, Qwen, Klein).

| Collage | Qwen-Image 2.1 | Klein 9B |
|---|---|---|
| Cut-out car pasted over harbour water, too big | Very good: builds a stone quay under it, car unchanged | Very good: quay too, car almost unchanged |
| Child-like paint sketch (sky, hill, house, sun) | Too literal: the painted sun and bird stay paint | Excellent: a real photo with the same layout |
| Red paint blob on a sofa, "becomes a tulip" | Tulip in a vase, but the green stroke stays | Tulips, plus a stray one on the lamp |
| Head-only portrait cut-out, giant, in a room | Barely changed: still a floating head | Redraws a whole woman on the sofa — a different person |

**Seams only** (a band round each piece's edge plus a contact-shadow strip, as a mask, the rest untouched): hair and
outline edges blend and the piece is pixel-identical, but it can't fix a piece at the wrong place or size (the car
still sits over the water; the head keeps its hard bottom edge).

## What it decided

- Three render modes, not one: **Blend edges** (Qwen, seam mask, feather 12), **Harmonise** (Qwen, whole picture,
  keeps faces and objects), **Reimagine** (Klein, paint → photo).
- Suggested mode follows the canvas: paint on ≥ 20 % of it (or no pictures) → Reimagine, otherwise Harmonise. Blend
  edges is never suggested.
- Placement is the artist's job: scale handles that keep the shape, and a dashed **ground line** while dragging.

## Found while building

Reimagine on bare rough paint, with no scene description, read the strokes literally: a wooden toy house on a lawn
(left in [compose/reimagine-describe.jpg](compose/reimagine-describe.jpg)). In the A/B the description was what made
the sketch a real cottage. So Reimagine with an empty description first asks the local Qwen3-VL to describe the real
scene the canvas stands for (`scene` task in `presets/vlm_prompts.json`: flat areas are the real things at full size,
keep the layout and colours, never call it a drawing). Same strokes, same model: a real house on a field (right).
The **Describe** button runs the same thing on demand, so the text can be edited before rendering.

## Describe again (v3.2)

Reported by JP: after erasing a sketch and painting a new one, Describe kept the old description. Three causes:
the text already in the box was sent back as "the artist's idea" (which the model follows), a stroke on a selected
but hidden paint layer went into that hidden layer (so the visible canvas stayed empty), and on an empty canvas the
model invented a scene out of the prompt's own examples (sun, bird, red-roofed house). Now Describe knows its own
text (`described` in the composition) and only passes words you typed or edited; painting on a hidden layer starts a
new one; Describe refuses an empty canvas; the prompt has general rules instead of copyable examples and asks for
only what is on the canvas (temperature 0.3). Checked: cottage sketch, sailboat sketch and car collage each get their
own accurate description (~5 s). A note says when the canvas has changed since it was described, and Reimagine
describes again by itself in that case.
