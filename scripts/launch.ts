/**
 * One-click start (used by start-darkroom.bat):
 *  1. If Comfy Desktop's ComfyUI server isn't answering, start the Desktop app and wait for it.
 *  2. Build the UI if needed.
 *  3. Start the Darkroom server and open it in the browser.
 */
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/server/config.js';
import { desktopRunning, launchDesktop } from '../src/server/desktop.js';
import { discoverComfy } from '../src/server/discovery.js';

const cfg = loadConfig();
const url = `http://${cfg.server.host}:${cfg.server.port}`;
const log = (s: string) => console.log(`[darkroom] ${s}`);

async function alreadyRunning(): Promise<boolean> {
  try {
    const r = await fetch(url + '/api/status', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function newestMtime(dir: string): number {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return t;
}

function openBrowser(): void {
  execSync(`start "" "${url}"`, { stdio: 'ignore', shell: 'cmd.exe' });
}

if (await alreadyRunning()) {
  log(`Darkroom is already running - opening ${url}`);
  openBrowser();
  process.exit(0);
}

let comfy = await discoverComfy(cfg);
if (!comfy) {
  if (await desktopRunning(cfg.desktop.exe)) {
    log('Comfy Desktop is open but its ComfyUI server is not running yet.');
  } else {
    log('Starting Comfy Desktop...');
    const r = launchDesktop(cfg.desktop.exe);
    if (!r.ok) log(r.error ?? 'Could not start Comfy Desktop.');
  }
  log('Waiting for ComfyUI (if Comfy Desktop shows its dashboard, click your "ComfyUI" install to launch it).');
  const until = Date.now() + cfg.comfy.startTimeoutSec * 1000;
  let hinted = false;
  while (!comfy && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    comfy = await discoverComfy(cfg);
    if (!comfy && !hinted && Date.now() > until - cfg.comfy.startTimeoutSec * 1000 + 45000) {
      log('Still waiting... Tip: Comfy Desktop > Settings > "Auto-launch on startup" starts ComfyUI for you next time.');
      hinted = true;
    }
  }
}
log(comfy ? `ComfyUI ${comfy.stats.system.comfyui_version} is ready at ${comfy.url}` : 'ComfyUI is not up yet - Darkroom will connect as soon as it is.');

const dist = path.join(ROOT, 'dist', 'index.html');
const srcTime = newestMtime(path.join(ROOT, 'src', 'web'));
if (!fs.existsSync(dist) || fs.statSync(dist).mtimeMs < srcTime) {
  log('Building the interface (first run or after an update)...');
  const b = spawnSync('npx vite build', { cwd: ROOT, stdio: 'inherit', shell: true });
  if (b.status !== 0) {
    log('Build failed - see the messages above.');
    process.exit(1);
  }
}

log(`Starting Darkroom at ${url}  (close this window to stop Darkroom; ComfyUI keeps running)`);
await import('../src/server/index.js');
openBrowser();
