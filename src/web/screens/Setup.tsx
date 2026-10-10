import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Download, ExternalLink, KeyRound, Loader2, Square } from 'lucide-react';
import { api, type SetupModel, type SetupModels } from '../api';
import { toast, useApp } from '../store';

/**
 * Setup (DECISIONS 138): the models Darkroom needs, which ones this PC has, and one button that downloads the rest
 * from Hugging Face into ComfyUI's models folder. Made for a fresh Windows install: nothing to copy by hand.
 */
const gb = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));
const LICENCE_PAGES = [
  { repo: 'black-forest-labs/FLUX.2-klein-9b-fp8', label: 'Klein 9B (Black Forest Labs)' },
  { repo: 'Lightricks/LTX-2.5', label: 'LTX 2.5 video (Lightricks)' },
];

export function Setup() {
  const online = useApp((s) => s.status?.comfy === 'online');
  const live = useApp((s) => s.setupFiles);
  const rev = useApp((s) => s.setupRev);
  const [data, setData] = useState<SetupModels | null>(null);
  const [extras, setExtras] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .setupModels()
      .then(setData)
      .catch((e) => toast((e as Error).message, 'error'));
  useEffect(() => {
    void load();
  }, [online, rev]);
  // a file that finishes changes what is missing: read the list again
  const done = Object.values(live).filter((f) => f.status === 'present').length;
  useEffect(() => {
    if (done) void load();
  }, [done]);

  const models = useMemo(() => (data?.models ?? []).map((m) => ({ ...m, ...(live[m.file] ?? {}) }) as SetupModel), [data, live]);
  const missing = models.filter((m) => m.status !== 'present' && m.status !== 'manual' && (extras || !m.optional));
  const missingGB = missing.reduce((a, m) => a + (m.gb ?? 0), 0);
  const needsSignIn = missing.some((m) => m.signIn);
  const running = !!data?.running || models.some((m) => m.status === 'downloading' || m.status === 'queued');
  const required = models.filter((m) => !m.optional);
  const ready = data?.models && required.every((m) => m.status === 'present' || m.status === 'manual');
  const blocked = models.filter((m) => m.status === 'sign-in' || m.status === 'licence');

  const start = async () => {
    setBusy(true);
    try {
      const r = await api.downloadModels(missing.map((m) => m.file));
      if (r.error) toast(r.error, 'error', 12000);
      else if (r.queued.length) toast(`Downloading ${r.queued.length} model${r.queued.length === 1 ? '' : 's'}. You can keep using Darkroom; this page shows the progress.`, 'ok');
      await load();
    } finally {
      setBusy(false);
    }
  };
  const saveToken = async () => {
    try {
      await api.setHfToken(token.trim());
      setToken('');
      toast('Hugging Face token saved on this PC (in Darkroom’s data folder).', 'ok');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="setup-screen">
      <div className="setup-inner">
        <h1 className="home-title">Models</h1>
        <p className="muted setup-lede">
          Darkroom runs on open models that live in ComfyUI&rsquo;s models folder. On a new PC press <strong>Download</strong>: Darkroom fetches what is missing from Hugging Face and puts each file where ComfyUI looks for it. A download that stops resumes where it left off.
        </p>

        {!online ? (
          <div className="banner setup-note" role="status">
            <Loader2 size={14} className="spin" /> Waiting for ComfyUI: Darkroom asks it which models it already has and where its models folder is.
          </div>
        ) : !data?.models ? (
          <div className="banner setup-note">
            <Loader2 size={14} className="spin" /> Checking your models…
          </div>
        ) : (
          <>
            <div className="setup-summary" role="status" aria-label="Setup summary">
              {ready ? (
                <span className="setup-ok">
                  <Check size={16} /> Everything Darkroom needs is installed.
                </span>
              ) : (
                <span>
                  <strong>{missing.length}</strong> model{missing.length === 1 ? '' : 's'} to download, <strong>{gb(missingGB)} GB</strong>
                  {data.freeGB !== null && (
                    <span className={data.freeGB < missingGB + 2 ? 'setup-warn' : 'muted'}>
                      {' '}
                      · {gb(data.freeGB)} GB free on the models drive
                    </span>
                  )}
                </span>
              )}
              <span style={{ flex: 1 }} />
              <label className="setup-extras" title="Wan 2.2 (the older video model) and the Lucida background remover: not needed for Darkroom's main features">
                <input type="checkbox" checked={extras} onChange={(e) => setExtras(e.target.checked)} /> Include extras
              </label>
              {running ? (
                <button className="btn" onClick={() => void api.cancelModels().then(load)} title="Stop after saving what has arrived; Download resumes it">
                  <Square size={14} /> Stop
                </button>
              ) : (
                <button className={missing.length ? 'btn primary' : 'btn'} disabled={!missing.length || busy} onClick={() => void start()}>
                  <Download size={15} /> {missing.length ? `Download ${gb(missingGB)} GB` : 'Nothing to download'}
                </button>
              )}
            </div>
            {data.dir && <p className="muted mono setup-dir">Models folder: {data.dir}</p>}

            {(needsSignIn || blocked.length > 0) && (
              <section className="setup-hf" aria-label="Hugging Face sign-in">
                <h2>
                  <KeyRound size={16} /> Klein and the video models need a free Hugging Face account
                </h2>
                <ol>
                  <li>
                    Create an account (or sign in) at{' '}
                    <a href="https://huggingface.co/join" target="_blank" rel="noreferrer">
                      huggingface.co <ExternalLink size={12} />
                    </a>
                    .
                  </li>
                  <li>
                    Open each page and press <strong>Agree and access repository</strong> (it is approved at once):
                    <ul>
                      {LICENCE_PAGES.map((p) => (
                        <li key={p.repo}>
                          <a href={`https://huggingface.co/${p.repo}`} target="_blank" rel="noreferrer">
                            {p.label} <ExternalLink size={12} />
                          </a>
                        </li>
                      ))}
                      {[...new Set(blocked.filter((m) => m.status === 'licence' && m.repo && !LICENCE_PAGES.some((p) => p.repo === m.repo)).map((m) => m.repo!))].map((r) => (
                        <li key={r}>
                          <a href={`https://huggingface.co/${r}`} target="_blank" rel="noreferrer">
                            {r} <ExternalLink size={12} />
                          </a>
                        </li>
                      ))}
                    </ul>
                  </li>
                  <li>
                    Make a token with <em>Read</em> access at{' '}
                    <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer">
                      Settings › Access tokens <ExternalLink size={12} />
                    </a>{' '}
                    and paste it here. It stays on this PC and is only sent to huggingface.co.
                  </li>
                </ol>
                <div className="setup-token">
                  {data.signedIn ? (
                    <span className="setup-ok">
                      <Check size={14} /> Token saved.
                    </span>
                  ) : null}
                  <input className="input" type="password" placeholder={data.signedIn ? 'Replace the token (hf_…)' : 'hf_…'} value={token} onChange={(e) => setToken(e.target.value)} aria-label="Hugging Face token" autoComplete="off" />
                  <button className="btn" disabled={!token.trim()} onClick={() => void saveToken()}>
                    Save token
                  </button>
                  {data.signedIn && (
                    <button className="btn ghost sm" onClick={() => void api.setHfToken(null).then(load)}>
                      Forget token
                    </button>
                  )}
                </div>
              </section>
            )}

            {Object.entries(data.groups).map(([g, label]) => {
              const rows = models.filter((m) => m.group === g && (extras || !m.optional || m.status === 'present'));
              if (!rows.length) return null;
              const have = rows.filter((m) => m.status === 'present').length;
              return (
                <section key={g} className="setup-group" aria-label={label}>
                  <h2>
                    {label} <span className="muted mono">{have === rows.length ? 'installed' : `${have} of ${rows.length}`}</span>
                  </h2>
                  <ul>
                    {rows.map((m) => (
                      <ModelRow key={m.file} m={m} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

function ModelRow({ m }: { m: SetupModel }) {
  const pct = m.total ? Math.min(100, Math.round(((m.received ?? 0) / m.total) * 100)) : 0;
  return (
    <li className="setup-row" data-status={m.status}>
      <span className="setup-file" title={m.presentAs ? `Installed as ${m.presentAs}` : m.file}>
        {m.file}
        {m.presentAs && <span className="muted"> · as {m.presentAs}</span>}
        {m.optional && <span className="muted"> · optional</span>}
      </span>
      <span className="mono muted setup-size">{m.gb ? `${gb(m.gb)} GB` : ''}</span>
      <span className="setup-state">
        {m.status === 'present' ? (
          <span className="setup-ok">
            <Check size={14} /> Installed
          </span>
        ) : m.status === 'downloading' ? (
          <span className="setup-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Downloading ${m.file}`}>
            <span style={{ width: `${pct}%` }} />
            <em>{pct}%</em>
          </span>
        ) : m.status === 'queued' ? (
          <span className="muted">Waiting</span>
        ) : m.status === 'sign-in' ? (
          <span className="setup-warn">Needs your Hugging Face token</span>
        ) : m.status === 'licence' ? (
          <a className="setup-warn" href={`https://huggingface.co/${m.repo}`} target="_blank" rel="noreferrer">
            Press Agree on its page <ExternalLink size={12} />
          </a>
        ) : m.status === 'failed' ? (
          <span className="setup-warn" title={m.error}>
            <AlertTriangle size={13} /> {m.error ?? 'Failed'}
          </span>
        ) : m.status === 'manual' ? (
          <span className="muted" title={m.source}>
            {m.source ?? 'Copy from your own backup'}
          </span>
        ) : (
          <span className="muted">Missing</span>
        )}
      </span>
    </li>
  );
}

/** Shown on every screen while models Darkroom needs are missing (a fresh install), with a way to Setup. */
export function SetupBanner({ screen }: { screen: string }) {
  const online = useApp((s) => s.status?.comfy === 'online');
  const rev = useApp((s) => s.setupRev);
  const [sum, setSum] = useState<{ missing: number; missingGB: number } | null>(null);
  useEffect(() => {
    if (!online) return;
    api
      .setupSummary()
      .then((r) => setSum(r.checked ? r : null))
      .catch(() => setSum(null));
  }, [online, rev]);
  if (!online || !sum?.missing || screen === 'setup') return null;
  return (
    <div className="offline-banner" role="alert" aria-label="Models missing">
      <span style={{ flex: 1 }}>
        Darkroom needs {sum.missing} more model{sum.missing === 1 ? '' : 's'} ({gb(sum.missingGB)} GB) before every tool works. Setup downloads them for you.
      </span>
      <button className="btn sm primary" onClick={() => (location.hash = '#/setup')}>
        Set up models
      </button>
    </div>
  );
}
