"""Download the models Darkroom needs that are missing on this PC (scripts/models.json).

Uses Hugging Face's fast (Xet) client, stages each file in a temporary folder and moves it into place when it is
complete, and never overwrites a file that is already there. Files without a public download are listed at the end:
copy those from your own backup.

    "<ComfyUI>\\.venv\\Scripts\\python.exe" scripts\\get-models.py [models folder] [--dry-run]

The models folder defaults to E:\\Comfy-Desktop\\ComfyUI-Shared\\models (Comfy Desktop's shared models folder).
Gated repos need `hf auth login` first (a free Hugging Face account, and the licence accepted on the model's page).
"""
import json
import os
import shutil
import sys
import time

here = os.path.dirname(os.path.abspath(__file__))
args = [a for a in sys.argv[1:] if not a.startswith('--')]
dry = '--dry-run' in sys.argv
root = args[0] if args else r'E:\Comfy-Desktop\ComfyUI-Shared\models'
# where ComfyUI also looks for models (a file in either one is present)
look = [root, r'E:\ComfyUI\Desktop ComfyUI\ComfyUI\ComfyUI\models']
spec = json.load(open(os.path.join(here, 'models.json'), encoding='utf-8'))['models']


def present(name):
    for r in look:
        for dirpath, _dirs, files in os.walk(r):
            if name in files:
                return os.path.join(dirpath, name)
    return None


todo, manual = [], []
for m in spec:
    if present(m['file']):
        continue
    (todo if m.get('repo') else manual).append(m)

print(f'models folder: {root}')
print(f'missing and downloadable: {len(todo)} ({sum(m.get("gb") or 0 for m in todo):.1f} GB)')
for m in todo:
    print(f'  {m["gb"]:>6} GB  {m["folder"]}/{m["file"]}  <- {m["repo"]}')
if manual:
    print(f'missing, copy from your own backup: {len(manual)}')
    for m in manual:
        print(f'  {m["folder"]}/{m["file"]}: {m["source"]}')
if dry or not todo:
    sys.exit(0)

stage = os.path.join(root, '.dr-download')
os.environ.setdefault('HF_XET_CACHE', os.path.join(stage, '.xet'))
from huggingface_hub import hf_hub_download  # noqa: E402  (after HF_XET_CACHE)

for m in todo:
    target = os.path.join(root, m['folder'], m['file'])
    if os.path.exists(target):
        continue
    t0 = time.time()
    try:
        p = hf_hub_download(repo_id=m['repo'], filename=m['path'], local_dir=stage)
    except Exception as e:  # gated or moved: say so and go on
        print(f'FAILED {m["file"]}: {e}')
        continue
    os.makedirs(os.path.dirname(target), exist_ok=True)
    shutil.move(p, target)
    print(f'ok {m["folder"]}/{m["file"]} in {time.time() - t0:.0f}s', flush=True)
shutil.rmtree(stage, ignore_errors=True)
print('done')
