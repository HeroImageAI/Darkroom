import { ComfyClient, isDesktopServer, type SystemStats } from '../shared/comfy.js';
import type { DarkroomConfig } from './config.js';

export interface FoundServer {
  url: string;
  stats: SystemStats;
  desktop: boolean;
}

async function probe(url: string, timeoutMs = 1500): Promise<SystemStats | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url + '/system_stats', { signal: ctl.signal });
    if (!r.ok) return null;
    return (await r.json()) as SystemStats;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Find the ComfyUI server started by Comfy Desktop. An explicit DR_COMFY_URL wins.
 * Other ComfyUI servers (e.g. another app's private instance) are reported but
 * not preferred.
 */
export async function discoverComfy(cfg: DarkroomConfig): Promise<FoundServer | null> {
  if (cfg.comfy.url) {
    const stats = await probe(cfg.comfy.url);
    return stats ? { url: cfg.comfy.url.replace(/\/$/, ''), stats, desktop: isDesktopServer(stats, cfg.comfy.desktopMarker) } : null;
  }
  const found = await Promise.all(
    cfg.comfy.ports.map(async (port) => {
      const url = `http://${cfg.comfy.host}:${port}`;
      const stats = await probe(url);
      return stats ? { url, stats, desktop: isDesktopServer(stats, cfg.comfy.desktopMarker) } : null;
    }),
  );
  const list = found.filter((x): x is FoundServer => x !== null);
  return list.find((s) => s.desktop) ?? null;
}

export function clientFor(s: FoundServer): ComfyClient {
  return new ComfyClient(s.url);
}
