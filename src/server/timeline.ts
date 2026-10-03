/**
 * Timeline export (DECISIONS 103): the film is put together by scripts/timeline_export.py, run with Comfy Desktop's
 * own Python (PyAV, numpy and Pillow come with it), frame by frame, straight from the clips' files.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, type DarkroomConfig } from './config.js';

/** Comfy Desktop's Python: DR_PYTHON, else the configured installation's own environment. */
export function desktopPython(cfg: DarkroomConfig): string | null {
  if (process.env.DR_PYTHON && fs.existsSync(process.env.DR_PYTHON)) return process.env.DR_PYTHON;
  try {
    const appData = process.env.APPDATA ?? '';
    const list = JSON.parse(fs.readFileSync(path.join(appData, 'Comfy Desktop', 'installations.json'), 'utf8')) as { id: string; installPath: string }[];
    const inst = list.find((i) => i.id === cfg.desktop.installationId) ?? list[0];
    const py = inst && path.join(inst.installPath, 'ComfyUI', '.venv', 'Scripts', 'python.exe');
    return py && fs.existsSync(py) ? py : null;
  } catch {
    return null;
  }
}

/** ComfyUI's input folder, from its launch arguments (like the output folder in trash.ts). */
export function inputDirFromArgv(argv: string[] | undefined): string | null {
  if (!argv) return null;
  const i = argv.indexOf('--input-directory');
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : null;
}

/** A file inside a folder, or null if the name would leave it. */
export function inside(dir: string, rel: string): string | null {
  const p = path.resolve(dir, rel);
  return p.startsWith(path.resolve(dir) + path.sep) ? p : null;
}

export interface ExportJob {
  out: string;
  poster: string;
  last: string;
  width: number;
  height: number;
  fps: number;
  crf: number;
  duration: number;
  clips: { id: string; path: string; start: number; in: number; out: number; muted?: boolean }[];
  sounds: { id: string; path: string; start: number; in: number; out: number; volume: number }[];
}

/** Run the export; resolves when the film is written, reporting progress 0–1 on the way. */
export function runExport(python: string, job: ExportJob, onProgress: (p: number) => void): Promise<void> {
  const spec = path.join(path.dirname(job.out), `.${path.basename(job.out)}.json`);
  fs.writeFileSync(spec, JSON.stringify(job));
  return new Promise((resolve, reject) => {
    const p = spawn(python, [path.join(ROOT, 'scripts', 'timeline_export.py'), spec], { windowsHide: true });
    let err = '';
    let buf = '';
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) {
        const m = /^progress (\d+) (\d+)/.exec(l);
        if (m) onProgress(Number(m[1]) / Number(m[2]));
      }
    });
    p.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    p.on('error', reject);
    p.on('close', (code) => {
      fs.rmSync(spec, { force: true });
      if (code === 0 && fs.existsSync(job.out)) resolve();
      else reject(new Error(err.trim().split(/\r?\n/).pop() || `The export stopped (code ${code}).`));
    });
  });
}
