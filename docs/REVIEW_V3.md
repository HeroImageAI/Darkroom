# Darkroom v3 review — UX, UI and model quality (2026-10-01)

Method: every screen captured at 1440×900 and 1280×720 with an automatic overflow check; every main workflow's
settings compared with ComfyUI's official templates (0.11.73); quality/speed candidates tested on the real models with
the A/B harness (`npx tsx scripts/ab-addenda.ts rv`, grids in `docs/qa/addenda/rv/`). Quality first, then time.

## Fixed in this review (branch `review-v33`)

| Problem | Fix |
|---|---|
| At 1280 px every screen was 8 px too wide (the top bar, since the Compose tab) — the whole app scrolled sideways | Below 1400 px the top bar drops the words "ComfyUI", "VRAM", "queued" and the GB numbers (all kept in tooltips) and tightens the tabs |
| Generate (Klein): the "Add a LoRA" list was 14 px wider than the panel, so the panel scrolled sideways | The list shrinks to its panel |
| "No Qwen-Image 2.1 LoRAs found…" filled a paragraph on every Qwen visit (Generate and Edit) | One quiet line, "LoRAs  none for Qwen-Image 2.1", with the how-to in its tooltip |
| Generate: Quality (Draft / Native 2K), the biggest quality choice after the model, sat at the bottom under the LoRAs | Quality now sits directly under Model; LoRAs move below the references |
| Compose at 720 px high: the Render area took over half the panel, the layer list scrolled out of sight | On short screens the mode explanation hides (it is in the card tooltips) and the cards are compact |
| Compose: the "any colour" picker looked like a duplicate red swatch | A rainbow swatch |

## Model and workflow findings (A/B, same seeds)

| Question | Result | Decision |
|---|---|---|
| Klein 9B full **bf16** (installed, 18 GB) instead of fp8mixed (9 GB)? Ampere has no fp8 maths, so bf16 could be sharper and no slower | Visually identical at 100 % (mean difference 3–4 / 255 on 4 of 6 pictures, larger only where tiny crowd details moved); **+35 % time** (10 s vs 7.5 s), peak 24.7 GB of 26 | **Keep fp8mixed** — [grid](qa/addenda/rv/klein-precision.jpg) |
| Klein at **~2 MP** instead of ~1 MP | Clearly better: text right (sign *and* chalkboard), finer fur, skin and crowds; 13–14 s vs 7.5 s, same memory | **Recommend a Klein Quality choice: Standard 1 MP / High 2 MP** — [grid](qa/addenda/rv/klein-2mp.jpg) |
| Klein 6 steps instead of 4 | Mixed: one sign fixed, another word doubled; a little more detail; +35 % time | Keep 4 (One Node's tuned default, decision 62) — [grid](qa/addenda/rv/klein-steps.jpg) |
| Whole-picture VAE decode instead of tiles (Qwen Native 2K) | Tile seam invisible (faint only at ×8 amplification); 6 % faster, +3–4 GB peak | Keep tiled (decision 16) — [crops](qa/addenda/rv/qwen-decode-seams.jpg) |
| Edits at a bigger working size (Klein 2 MP, Qwen 1.76 MP) for large photos | Marginally crisper at 100 %, less consistent (Klein turned a window into a picture), 1.6–2.2× time | Keep 1 MP + "Sharpen to full resolution" — [Klein](qa/addenda/rv/edit-klein.jpg), [Qwen](qa/addenda/rv/edit-qwen.jpg) |
| Qwen-Image 2.1 settings vs the official template | Same: no shift node, CFG 1, euler/simple 25 steps (40 for Native 2K, the official 40–50) | Nothing to change |

Also found on disk: `nsfwKlein.safetensors` is a Klein 9B fine-tune (DarkBeast-Klein9b-V2, same 8+24 blocks, 4096
wide) — it would run in every Klein graph. `qwreal.safetensors` is an original Qwen-Image (3072 wide) model and does
not fit Qwen-Image 2.1. ComfyUI's templates now use `flux-2-klein-9b-kv-fp8` (not on this PC), the fp8 KV model that
decision 63 was waiting for (faster edits with references).

## Recommendations, in order of value

1. **Klein Quality: Standard / High (2 MP).** The clearest quality gain found; small change (manifest sizes + the same
   Quality control Qwen has). ~13 s a picture.
2. **Library: version stacks.** The grid is mostly v2…v5 of the same pictures. Show the newest version of each picture
   with a "v5" badge; open the stack to see the rest. Also: hide the empty Details panel until something is selected
   (the grid gains a column), and add a "Composed" filter.
3. **Your own Klein 9B fine-tunes as a model choice.** Header-checked like LoRAs (only files with Klein 9B's layout are
   offered); today that would offer DarkBeast-Klein9b-V2. Pictures record which fine-tune made them.
4. **Klein KV fp8 for edits with references** — needs a ~9 GB download (your OK first); test first, as decision 63 did
   with the bf16 KV model.
5. Smaller: Edit's tool rail shows the brush as selected in modes that don't use it (Enhance, Upscale); Generate's History
   rail could show the model on hover.
