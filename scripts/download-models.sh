#!/usr/bin/env bash
# Resumable downloads of Darkroom's missing models into the Desktop shared models dir.
# Never overwrites an existing complete file.
set -u
M="${DR_MODELS_DIR:-/e/Comfy-Desktop/ComfyUI-Shared/models}"
T=$(cat ~/.cache/huggingface/token 2>/dev/null)
get() { # repo path folder
  local url="https://huggingface.co/$1/resolve/main/$2" dest="$M/$3/$(basename "$2")"
  mkdir -p "$M/$3"
  if [ -f "$dest" ]; then echo "SKIP $dest"; return; fi
  echo "GET  $dest"
  for i in 1 2 3 4 5; do
    curl -fL -C - --retry 5 -s -H "Authorization: Bearer $T" -o "$dest.part" "$url" && { mv "$dest.part" "$dest"; echo "DONE $dest"; return; }
    echo "retry $i $dest"; done
  echo "FAIL $dest"
}
W=Comfy-Org/Wan_2.2_ComfyUI_Repackaged; L=Lightricks/LTX-2.5
get $W split_files/vae/wan_2.1_vae.safetensors vae
get $W split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors loras
get $W split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors loras
get $W split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors text_encoders
get $W split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors diffusion_models
get $W split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors diffusion_models
get $L vae/ltx-2.5-video-vae-bf16.safetensors vae
get $L vae/ltx-2.5-audio-vae-bf16.safetensors vae
get $L latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors latent_upscale_models
get $L model_patches/ltx-2.5-duration-head-bf16.safetensors model_patches
get $L text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors text_encoders
get $L diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors diffusion_models
echo ALL_DONE
