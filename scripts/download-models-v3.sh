#!/usr/bin/env bash
# Addenda 1+2 models (Qwen-Image 2.1 prompt enhancers + Fun ControlNet Union). Resumable, never overwrites a
# complete file, and checks the byte count published on huggingface.co/Comfy-Org/Qwen-Image-2.1 (2026-09-30).
set -u
M="${DR_MODELS_DIR:-/e/Comfy-Desktop/ComfyUI-Shared/models}"
R=https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main
get() { # path-in-repo folder expected-bytes
  local dest="$M/$2/$(basename "$1")"; mkdir -p "$M/$2"
  [ -f "$dest" ] && { echo "SKIP $dest"; return; }
  echo "GET  $dest"
  for i in 1 2 3 4 5; do
    if curl -fL -C - --retry 5 -s -o "$dest.part" "$R/$1"; then
      local got; got=$(stat -c %s "$dest.part")
      if [ "$got" = "$3" ]; then mv "$dest.part" "$dest"; echo "DONE $dest ($got bytes)"; return; fi
      echo "size $got != $3, resuming"
    fi
    echo "retry $i"
  done
  echo "FAIL $dest"
}
get text_encoders/qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors text_encoders 9471072252
get text_encoders/qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors text_encoders 9471072252
# removed 2026-09-30 after the A/B (DECISIONS 67); uncomment to re-test workflows/experiments/qwen_inpaint_cs.controlnet.json
# get model_patches/qwen_image_2.1_fun_controlnet_union_int8_convrot.safetensors model_patches 3779298944
echo ALL_DONE

# Phase 7 A/B candidate for the general VLM (JP: "A/B first"; the 9B is bf16 19.3 GB and stays optional)
R=https://huggingface.co/Comfy-Org/Qwen3.5/resolve/main
# removed 2026-09-30 after the general-VLM A/B (DECISIONS 74); uncomment to re-run `ab-addenda.ts p7`
# get text_encoders/qwen3.5_4b_bf16.safetensors text_encoders 9319828320
echo ALL_DONE_4B
