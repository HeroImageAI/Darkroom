import { useState } from 'react';
import { Clapperboard, Film, Image as ImageIcon, Layers, Library, ListOrdered, Loader2, Wand2 } from 'lucide-react';
import { api } from '../api';
import { go, type Screen } from '../router';
import { toast, useApp } from '../store';
import { Dialog } from './common';
import { WorkingBoardPicker } from './Boards';
import { ShortcutsButton } from './Shortcuts';

const TABS: { id: Screen; label: string; icon: typeof ImageIcon }[] = [
  { id: 'generate', label: 'Generate', icon: Wand2 },
  { id: 'edit', label: 'Edit', icon: Layers },
  { id: 'video', label: 'Video', icon: Film },
  { id: 'timeline', label: 'Timeline', icon: Clapperboard },
  { id: 'library', label: 'Library', icon: Library },
];

export function Logo() {
  return (
    <button type="button" className="logo" onClick={() => go('home')} title="Home" aria-label="Darkroom — Home">
      {/* an enlarger lens: the iris of six blades (DECISIONS 108) */}
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2l3.2 6.6M20.66 7l-7.3.6M20.66 17l-4.1-6M12 22l-3.2-6.6M3.34 17l7.3-.6M3.34 7l4.1 6" />
        <polygon points="13.4,9.2 15,12 13.6,14.8 10.6,14.8 9,12 10.4,9.2" fill="currentColor" stroke="none" opacity=".35" />
      </svg>
      Darkroom
    </button>
  );
}

export async function startComfy(): Promise<void> {
  try {
    const r = await api.post<{ ok: boolean; error?: string; desktopWasRunning?: boolean }>('/api/comfy/start');
    if (!r.ok) toast(r.error ?? 'Could not start Comfy Desktop.', 'error');
    else if (r.desktopWasRunning) toast('Comfy Desktop is already open — click your "ComfyUI" install in its window to start the server.', 'info', 9000);
    else toast('Starting Comfy Desktop… this can take up to a minute.', 'info');
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

export function TopBar({ screen }: { screen: Screen }) {
  const status = useApp((s) => s.status);
  const socket = useApp((s) => s.socket);
  const jobs = useApp((s) => s.jobs);
  const [log, setLog] = useState<string | null>(null);
  const active = Object.values(jobs).filter((j) => j.status === 'queued' || j.status === 'running');
  const videoActive = active.filter((j) => j.kind === 'video').length;

  const state = socket !== 'open' ? 'offline' : (status?.comfy ?? 'offline');
  const label =
    socket !== 'open'
      ? 'Darkroom server offline'
      : state === 'online'
        ? `ComfyUI ${status?.version ?? ''}`
        : state === 'starting'
          ? 'Starting ComfyUI…'
          : state === 'desktop-open'
            ? 'ComfyUI not launched'
            : 'ComfyUI offline';
  const used = status?.vram ? (status.vram.total - status.vram.free) / 1e9 : null;
  const total = status?.vram ? status.vram.total / 1e9 : null;

  return (
    <header className="topbar">
      <Logo />
      <nav className="tabs" aria-label="Screens">
        {TABS.map((t) => (
          <button key={t.id} className="tab" aria-current={screen === t.id ? 'page' : undefined} onClick={() => go(t.id)}>
            <t.icon size={16} />
            {t.label}
            {t.id === 'video' && videoActive > 0 && <span className="badge">{videoActive}</span>}
          </button>
        ))}
      </nav>
      <div className="topbar-right">
        <WorkingBoardPicker />
        <div className={`status-pill ${state}`} title={status?.message || status?.url || ''}>
          <span className="dot" aria-hidden="true" />
          {state === 'starting' && <Loader2 size={14} className="spin" />}
          <span>{state === 'online' && socket === 'open' ? (<><span className="status-name">ComfyUI </span>{status?.version ?? ''}</>) : label}</span>
          {socket === 'open' && (state === 'offline' || state === 'desktop-open') && <button onClick={startComfy}>Start ComfyUI</button>}
          {socket === 'open' && state !== 'online' && (
            <button
              onClick={async () => setLog((await api.get<{ log: string }>('/api/comfy/log')).log || 'No log yet.')}
              title="Show the Comfy Desktop log"
            >
              Log
            </button>
          )}
        </div>
        <div className="vram" title={`Graphics memory in use${used !== null && total ? `: ${used.toFixed(1)} of ${total.toFixed(0)} GB` : ""}`}>
          <span className="vram-label">VRAM</span>
          <div className="vram-bar">
            <div style={{ width: used && total ? `${(used / total) * 100}%` : '0%' }} />
          </div>
          <span className="mono vram-text">{used !== null && total ? `${used.toFixed(1)}/${total.toFixed(0)} GB` : '–'}</span>
        </div>
        <div className="queue-count" title={`${status?.queue ?? 0} jobs waiting or running in ComfyUI`}>
          {/* the darkroom's safelight: on while something is developing */}
          <span className={`safelight ${active.length || status?.queue ? 'on' : ''}`} aria-hidden="true" />
          <ListOrdered size={15} />
          {status?.queue ?? 0}<span className="queue-word"> queued</span>
        </div>
        <ShortcutsButton />
      </div>
      {log !== null && (
        <Dialog title="Comfy Desktop log" onClose={() => setLog(null)}>
          <pre>{log}</pre>
          <div className="row">
            <button className="btn" onClick={() => setLog(null)}>
              Close
            </button>
          </div>
        </Dialog>
      )}
    </header>
  );
}

export function OfflineBanner() {
  const status = useApp((s) => s.status);
  const socket = useApp((s) => s.socket);
  if (socket !== 'open')
    return (
      <div className="offline-banner" role="alert">
        <Loader2 size={16} className="spin" /> Reconnecting to the Darkroom server… If this persists, run start-darkroom.bat again.
      </div>
    );
  if (!status || status.comfy === 'online') return null;
  return (
    <div className="offline-banner" role="alert">
      <span style={{ flex: 1 }}>
        {status.comfy === 'starting'
          ? 'Starting ComfyUI — Darkroom will connect automatically when it is ready.'
          : status.message || "ComfyUI isn't running. Your library is safe; generating needs ComfyUI."}
      </span>
      {status.comfy !== 'starting' && (
        <button className="btn sm primary" onClick={startComfy}>
          Start ComfyUI
        </button>
      )}
    </div>
  );
}
