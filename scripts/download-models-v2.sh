#!/usr/bin/env bash
# Phase 4 models (SAM 3.1, Qwen-Image-Layered fp8). Resumable, never overwrites a complete file.
set -u
M="${DR_MODELS_DIR:-/e/Comfy-Desktop/ComfyUI-Shared/models}"
get() { # url folder
  local dest="$M/$2/$(basename "$1")"; mkdir -p "$M/$2"
  [ -f "$dest" ] && { echo "SKIP $dest"; return; }
  echo "GET  $dest"
  for i in 1 2 3 4 5; do curl -fL -C - --retry 5 -s -o "$dest.part" "$1" && { mv "$dest.part" "$dest"; echo "DONE $dest"; return; }; echo "retry $i"; done
  echo "FAIL $dest"
}
get https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors checkpoints
get https://huggingface.co/Comfy-Org/Qwen-Image-Layered_ComfyUI/resolve/main/split_files/vae/qwen_image_layered_vae.safetensors vae
get https://huggingface.co/Comfy-Org/Qwen-Image-Layered_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_layered_fp8mixed.safetensors diffusion_models
echo ALL_DONE
