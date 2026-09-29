const fs = require('fs');
const rep = (s, a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 70)); return s.replace(a, b); };
let d = fs.readFileSync('src/server/discovery.ts', 'utf8');
d = rep(d, `async function probe(url: string, timeoutMs = 1500)`, `async function probe(url: string, timeoutMs = 4000)`);
fs.writeFileSync('src/server/discovery.ts', d);
let i = fs.readFileSync('src/server/index.ts', 'utf8');
i = rep(i, `  startRequestedAt: 0,
  message: '',
};`, `  startRequestedAt: 0,
  message: '',
  /** consecutive failed polls while we believed ComfyUI was online */
  misses: 0,
  unresponsiveSince: 0,
};
const GRACE_POLLS = 4; // ~12-16 s: heavy VAE/model-load steps can pause ComfyUI's HTTP for a few seconds
const STALL_SEC = 180;`);
i = rep(i, `  const found = await discoverComfy(cfg).catch(() => null);
  const before = JSON.stringify([status.comfy, status.url]);
  if (found) {`, `  const found = await discoverComfy(cfg).catch(() => null);
  const before = JSON.stringify([status.comfy, status.url]);
  if (!found && status.comfy === 'online' && status.url) {
    // Don't declare ComfyUI offline on a short hiccup; keep the WebSocket and the job state.
    status.misses++;
    if (!status.unresponsiveSince) status.unresponsiveSince = Date.now();
    const busy = store.activeJobs().some((j) => j.status === 'running');
    const secs = (Date.now() - status.unresponsiveSince) / 1000;
    if (busy && secs > STALL_SEC) {
      status.message = \`ComfyUI has not responded for \${Math.round(secs / 60)} min while rendering. It may be stuck (often when graphics memory is completely full). Open the Comfy Desktop window; if it doesn't recover, use Restart there - Darkroom reconnects on its own and keeps your library.\`;
      broadcast({ type: 'status', status: publicStatus() });
      return;
    }
    if (status.misses < GRACE_POLLS || busy) return;
  }
  if (found) {
    status.misses = 0;
    status.unresponsiveSince = 0;`);
i = rep(i, `function publicStatus() {
  const { startRequestedAt: _s, ...rest } = status;`, `function publicStatus() {
  const { startRequestedAt: _s, misses: _m, unresponsiveSince: _u, ...rest } = status;`);
fs.writeFileSync('src/server/index.ts', i);
// harness timeouts
for (const f of ['scripts/ab-phase1.ts', 'scripts/qa-phase6.ts']) {
  let s = fs.readFileSync(f, 'utf8');
  s = s.replace("{ cwd: ROOT, encoding: 'utf8' }", "{ cwd: ROOT, encoding: 'utf8', timeout: 20 * 60 * 1000 }");
  s = s.replace("{ cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }", "{ cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000 }");
  fs.writeFileSync(f, s);
}
console.log('watchdog ok');
