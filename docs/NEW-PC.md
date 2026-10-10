# Darkroom on a new PC (or after reinstalling Windows)

Darkroom is the code in this repository. Everything else it needs lives outside it and comes back separately:

| What | Where it lives on this PC | How it comes back |
|---|---|---|
| Darkroom (this code) | `E:\Darkroom` | `git clone` from GitHub (step 3) |
| Comfy Desktop + ComfyUI | `E:\ComfyUI\Desktop ComfyUI` | Comfy Desktop's installer (step 2) |
| AI models (~150 GB) | `E:\Comfy-Desktop\ComfyUI-Shared\models` (and ComfyUI's own `models` folder) | **Darkroom downloads them** (step 5) |
| Your Library (database, layered canvases) | `E:\Darkroom\data` | your backup (step 6) — **not on GitHub** |
| Your pictures and videos | `E:\Comfy-Desktop\ComfyUI-Shared\output` (and `input`) | your backup (step 6) — **not on GitHub** |

**Back up regularly** (an external drive is enough): `E:\Darkroom\data`, `E:\Comfy-Desktop\ComfyUI-Shared\output` and
`input`. GitHub keeps the code and the models come back by download; your pictures and Library only come back from a backup.

## 1. Tools

- **Node.js** (LTS, 24 or newer): https://nodejs.org — tick "Add to PATH".
- **Git for Windows**: https://git-scm.com — it includes the GitHub sign-in (Git Credential Manager).
- An **NVIDIA driver** for the RTX card (NVIDIA App or nvidia.com).

## 2. Comfy Desktop and ComfyUI

1. Install **Comfy Desktop** from https://www.comfy.org/download.
2. In Comfy Desktop, create a **local (standalone) ComfyUI instance**. Any folders work: Darkroom finds Comfy Desktop
   through Windows' list of installed programs, and asks ComfyUI where its models folder is.
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

Nothing to configure: Darkroom finds Comfy Desktop by itself. `.env.example` lists optional overrides (`DR_COMFY_URL`,
`DR_DESKTOP_EXE`, …) for unusual setups.

## 4. Start it

Double-click **`start-darkroom.bat`** (or the "Darkroom" desktop shortcut you make to it). It builds the app the first time,
starts ComfyUI through Comfy Desktop and opens http://127.0.0.1:5178. The status pill at the top shows when ComfyUI is
connected.

## 5. Models: Darkroom downloads them

With models missing, Darkroom says **"Darkroom needs … more models"** at the top of every screen. Press **Set up models**
(or Home › **Models and setup**), then **Download**. About 150 GB comes from Hugging Face into ComfyUI's models folder:
Darkroom checks the free space first, shows each file's progress, and resumes a download that stopped. You can keep
working meanwhile; each tool works as soon as its models are in.

**Klein 9B and the LTX video models** need a free Hugging Face account (their makers ask you to agree to their licence).
The Setup screen walks you through it: sign in at huggingface.co, press **Agree** on the two pages it links, make a *Read*
token under Settings › Access tokens, and paste it into Setup. The token stays in Darkroom's `data` folder on your PC and
is only sent to huggingface.co.

Optional **extras** (Wan 2.2, the older video model; the Lucida background remover) download when you tick *Include
extras*. One small LoRA (Klein Image Restore V1, used by Enhance on large pictures) has no public download: copy it from a
backup if you have it; Enhance works without it.

Terminal alternative: `scripts\get-models.py` (`--dry-run` to list, `--all` for the extras), run with ComfyUI's Python.
`scripts\models.json` lists every model with its folder, size and source.

## 6. Your Library

Copy your backup of `E:\Darkroom\data` back into place **before** starting Darkroom, and your
`E:\Comfy-Desktop\ComfyUI-Shared\output` and `input` folders. The Library's entries point at those files by name, so the
folder names must stay the same. (Without the output folder the Library shows which pictures lost their files and can put
them in Recently deleted — DECISIONS 137.)

## 7. Check

- Darkroom's top bar: **ComfyUI 0.39 (or newer) — online**, VRAM shown; Home › Models and setup: everything installed.
- Generate a picture with Klein and one with Qwen; animate one Draft video.
- Developers: `npm test` (unit tests) and the end-to-end suite (`npx playwright test` against the test stack — README).

## If a cleaner or antivirus ever deletes files again

Exclude `E:\ComfyUI`, `E:\Comfy-Desktop`, `E:\Darkroom` and `%LOCALAPPDATA%\uv` from it. If ComfyUI then fails with
`ModuleNotFoundError`, its Python packages lost files: reinstall them at their current versions with Comfy Desktop's `uv`
(what was done on 2026-10-10 is in the project's memory notes), restore ComfyUI's own files with
`git checkout HEAD -- $(git ls-files --deleted)` in the ComfyUI folder, and Darkroom's libraries with `npm ci`. Missing
models: Home › Models and setup.
