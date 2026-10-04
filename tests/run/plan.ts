/** Run a list of runner steps in order: npx tsx tests/run/plan.ts <plan.json>  (each step: { action, ...spec }). */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const steps = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as ({ action: string; title?: string } & Record<string, unknown>)[];
const SPEC = 'tests/results/.spec.json';
for (const st of steps) {
  const { action, ...spec } = st;
  fs.writeFileSync(SPEC, JSON.stringify(spec));
  const t0 = Date.now();
  const out = spawnSync('npx', ['tsx', 'tests/run/ui.ts', action, SPEC], { encoding: 'utf8', shell: true });
  const line = (out.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('RESULT')) ?? `RESULT {"error":"${(out.stderr ?? '').slice(-200).replace(/\s+/g, ' ').replace(/"/g, "'")}"}`;
  console.log(`${String(st.title ?? action).padEnd(66)} ${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s ${line.slice(7)}`);
}
