/** Build docs/QA_REPORT.md from docs/qa/phase1 + phase6 run records. Prose sections come from docs/qa/notes.md. */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/server/config.js';

const read = <T>(p: string, d: T): T => (fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as T) : d);
const p1 = read<any[]>(path.join(ROOT, 'docs/qa/phase1/runs.json'), []);
const p6 = read<any[]>(path.join(ROOT, 'docs/qa/phase6/runs.json'), []);
const st = read<any[]>(path.join(ROOT, 'docs/qa/phase6/stress.json'), []);
const notes = fs.existsSync(path.join(ROOT, 'docs/qa/notes.md')) ? fs.readFileSync(path.join(ROOT, 'docs/qa/notes.md'), 'utf8') : '';

const byFeature = new Map<string, any[]>();
for (const r of p6) byFeature.set(r.feature, [...(byFeature.get(r.feature) ?? []), r]);

let md = `# QA report — Darkroom v2

Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} from the fixed-seed runs in \`docs/qa/\`
(\`scripts/ab-phase1.ts\`, \`scripts/qa-phase6.ts\`). Machine: RTX 3090 24 GB, ComfyUI 0.37.4. Golden set: \`tests/golden/\`
(synthetic, no real people, no Google Earth captures). Peak VRAM is whole-GPU usage sampled every 0.5 s.

${notes}

## Phase 1 — old vs new prompts (A/B)

Grids (left: v1.0 prompt, right: new model-specific prompt, same seed):
${[...new Set(p1.map((r) => r.group))].map((g) => `- [${g}](qa/phase1/${g}.png)`).join('\n')}

| Group | Cases | Old median s | New median s |
|---|---|---|---|
`;
const med = (a: number[]) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
for (const g of [...new Set(p1.map((r) => r.group))]) {
  const rows = p1.filter((r) => r.group === g && r.ok);
  md += `| ${g} | ${new Set(rows.map((r) => r.key)).size} | ${med(rows.filter((r) => r.variant === 'old').map((r) => r.seconds ?? NaN)).toFixed(1)} | ${med(rows.filter((r) => r.variant === 'new').map((r) => r.seconds ?? NaN)).toFixed(1)} |\n`;
}

md += `\n## Phase 6 — every feature on the golden set\n\n| Feature | Cases | OK | Median time | Max peak VRAM | Grid |\n|---|---|---|---|---|---|\n`;
for (const [f, rows] of byFeature) {
  const ok = rows.filter((r) => r.ok);
  const grid = fs.existsSync(path.join(ROOT, `docs/qa/phase6/${f}.jpg`)) ? `[view](qa/phase6/${f}.jpg)` : '—';
  md += `| ${f} | ${rows.length} | ${ok.length} | ${med(ok.map((r) => r.seconds ?? NaN)).toFixed(1)} s | ${Math.max(...ok.map((r) => r.peak ?? 0)).toFixed(1)} GB | ${grid} |\n`;
}

const texts = p6.filter((r) => r.ok && r.text?.length);
if (texts.length) {
  md += `\n## VLM outputs (Qwen3-VL 8B)\n\n`;
  for (const r of texts) md += `**${r.feature} / ${r.id}** (${r.seconds}s)\n\n> ${String(r.text[0]).replace(/\n+/g, '\n> ')}\n\n`;
}

const fails = [...p6.filter((r) => !r.ok), ...st.filter((r) => !r.ok)];
md += `\n## Failures\n\n${fails.length ? fails.map((r) => `- **${r.feature}/${r.id}**: ${String(r.error ?? 'failed').slice(0, 300)}`).join('\n') : 'None in the final runs.'}\n`;

if (st.length) {
  md += `\n## Swap-stress test (rapid switching between all model families)\n\n${st.filter((r) => r.ok).length} of ${st.length} jobs succeeded; max peak VRAM ${Math.max(...st.map((r) => r.peak ?? 0)).toFixed(1)} GB.\n\n| Step | Family | Time | Peak VRAM | OK |\n|---|---|---|---|---|\n`;
  for (const r of st) md += `| ${r.id} | ${r.family} | ${r.seconds ?? '–'} s | ${r.peak ?? '–'} GB | ${r.ok ? 'yes' : '**no**'} |\n`;
}

fs.writeFileSync(path.join(ROOT, 'docs', 'QA_REPORT.md'), md);
console.log('wrote docs/QA_REPORT.md');
