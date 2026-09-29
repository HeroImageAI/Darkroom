import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface DarkroomConfig {
  comfy: { host: string; ports: number[]; desktopMarker: string; startTimeoutSec: number; url?: string };
  desktop: { exe: string; logsDir: string; installationId: string };
  server: { host: string; port: number };
  web: { port: number };
  paths: { data: string; workflows: string; presets: string };
  vram: { reserveGB: number };
}

/** Parse a .env file (KEY=value, quotes optional, # comments). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

function expandWinEnv(p: string): string {
  return p.replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? `%${k}%`);
}

export function loadConfig(root = ROOT): DarkroomConfig {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')) as DarkroomConfig;
  const envFile = path.join(root, '.env');
  const env = { ...(fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {}), ...process.env };
  if (env.DR_COMFY_URL) cfg.comfy.url = env.DR_COMFY_URL;
  if (env.DR_DESKTOP_EXE) cfg.desktop.exe = env.DR_DESKTOP_EXE;
  if (env.DR_SERVER_PORT) cfg.server.port = Number(env.DR_SERVER_PORT);
  if (env.DR_DATA_DIR) cfg.paths.data = env.DR_DATA_DIR;
  cfg.desktop.logsDir = expandWinEnv(cfg.desktop.logsDir);
  for (const k of ['data', 'workflows', 'presets'] as const) cfg.paths[k] = path.resolve(root, cfg.paths[k]);
  return cfg;
}
