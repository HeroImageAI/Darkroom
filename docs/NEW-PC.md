# Darkroom on a new PC (or after reinstalling Windows)

Darkroom is the code in this repository. Everything else it needs lives outside it and comes back separately:

| What | Where it lives on this PC | How it comes back |
|---|---|---|
| Darkroom (this code) | `E:\Darkroom` | `git clone` from GitHub (step 3) |
| Comfy Desktop + ComfyUI | `E:\ComfyUI\Desktop ComfyUI` | Comfy Desktop's installer (step 2) |
| AI models (~190 GB) | `E:\Comfy-Desktop\ComfyUI-Shared\models` and `E:\ComfyUI\Desktop ComfyUI\ComfyUI\ComfyUI\models` | your drive backup, or `scripts\get-models.py` (step 5) |
| Your Library (database, layered canvases) | `E:\Darkroom\data` | your backup (step 6) — **not on GitHub** |
| Your pictures and videos | `E:\Comfy-Desktop\ComfyUI-Shared\output` (and `input`) | your backup (step 6) — **not on GitHub** |

**Back up regularly** (an external drive is enough): `E:\Darkroom\data`, `E:\Comfy-Desktop\ComfyUI-Shared\output` and
`input`, and both models folders. GitHub keeps the code; it cannot hold your models (too large) or your private pictures.

## 1. Tools

- **Node.js** (LTS, 24 or newer): https://nodejs.org — tick "Add to PATH".
- **Git for Windows**: https://git-scm.com — it includes the GitHub sign-in (Git Credential Manager).
- An **NVIDIA driver** for the RTX card (NVIDIA App or nvidia.com).

## 2. Comfy Desktop and ComfyUI

1. Install **Comfy Desktop** from https://www.comfy.org/download.
2. In Comfy Desktop, create a **local (standalone) ComfyUI instance**. Keep the folders the same as before if you can
   (`E:\ComfyUI\Desktop ComfyUI\ComfyUI` for the install, `E:\Comfy-Desktop\ComfyUI-Shared` for models, input and output);
   then nothing in Darkroom's `config.json` needs changing.
3. Comfy Desktop › the instance › **Manage › Startup Args**: add `--reserve-vram 3` (keeps 3 GB of the 24 GB card free for
   Windows, so long videos don't slow to a crawl — DECISIONS 136).
4. NVIDIA Control Panel › Manage 3D settings › Program Settings › add ComfyUI's
   `…\ComfyUI\ComfyUI\.venv\Scripts\python.exe` › **CUDA – Sysmem Fallback Policy: Prefer No Sysmem Fallback**.
5. Start the instance once, so Comfy Desktop finishes setting it up.

Darkroom needs **no custom nodes**: everything runs on ComfyUI's own nodes.

## 3. Darkroom

```powershell
cd E:\
git clone https://github.com/HeroImageAI/Darkroom.git
cd Darkroom
npm ci
```

`git clone` asks you to sign in to GitHub in the browser the first time (the repository is private).

If your folders differ from before, edit `config.json` (Comfy Desktop's exe and log folder, the ports) — see the README's
Setup section. `.env.example` lists the optional overrides (`DR_COMFY_URL`, `DR_DESKTOP_EXE`, …); copy it to `.env` if you
need any.

## 4. Start it

Double-click **`start-darkroom.bat`** (or the "Darkroom" desktop shortcut you make to it). It builds the app the first time
and opens http://127.0.0.1:5178. The status pill at the top shows when ComfyUI is connected.

## 5. Models

Fastest: copy both models folders back from your drive backup.

Otherwise, download what is missing (≈190 GB in total from Hugging Face; the script skips files you already have):

```powershell
& "E:\ComfyUI\Desktop ComfyUI\ComfyUI\ComfyUI\.venv\Scripts\python.exe" scripts\get-models.py --dry-run
& "E:\ComfyUI\Desktop ComfyUI\ComfyUI\ComfyUI\.venv\Scripts\python.exe" scripts\get-models.py
```

`scripts\models.json` lists every model with its folder, size and source. A few have **no public download** (Klein 9B is
gated behind the FLUX.2 [klein] licence on Hugging Face; some LoRAs came from elsewhere): the dry run lists them — copy those
from your backup, or for Klein 9B sign in to Hugging Face (`hf auth login`), accept the licence, and download it there.

## 6. Your Library

Copy your backup of `E:\Darkroom\data` back into place **before** starting Darkroom, and your
`E:\Comfy-Desktop\ComfyUI-Shared\output` and `input` folders. The Library's entries point at those files by name, so the
folder names must stay the same.

## 7. Check

- Darkroom's top bar: **ComfyUI 0.39 (or newer) — online**, VRAM shown.
- Generate a picture with Klein and one with Qwen; animate one Draft video.
- Developers: `npm test` (unit tests) and the end-to-end suite (`npx playwright test` against the test stack — README).

## If a cleaner or antivirus ever deletes files again

Exclude `E:\ComfyUI`, `E:\Comfy-Desktop`, `E:\Darkroom` and `%LOCALAPPDATA%\uv` from it. If ComfyUI then fails with
`ModuleNotFoundError`, its Python packages lost files: reinstall them at their current versions with Comfy Desktop's `uv`
(what was done on 2026-10-10 is in the project's memory notes), restore ComfyUI's own files with
`git checkout HEAD -- $(git ls-files --deleted)` in the ComfyUI folder, and Darkroom's libraries with `npm ci`.
