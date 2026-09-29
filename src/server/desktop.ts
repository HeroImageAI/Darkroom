import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Is the Comfy Desktop app process running? */
export function desktopRunning(exe: string): Promise<boolean> {
  const image = path.basename(exe);
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], { windowsHide: true }, (err, stdout) => {
      resolve(!err && stdout.toLowerCase().includes(image.toLowerCase()));
    });
  });
}

/** Start the Comfy Desktop app (never a second ComfyUI server). */
export function launchDesktop(exe: string): { ok: boolean; error?: string } {
  if (!fs.existsSync(exe)) return { ok: false, error: `Comfy Desktop was not found at ${exe}. Set DR_DESKTOP_EXE in .env.` };
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { ok: true };
}

/** Last lines of the newest Desktop log (ComfyUI server output is included there). */
export function tailDesktopLog(logsDir: string, lines = 80): string {
  try {
    const file = path.join(logsDir, 'app.log');
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}
