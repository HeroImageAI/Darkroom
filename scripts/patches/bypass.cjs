// one-off source patch: multi-output bypass support
const fs = require('fs');
let s = fs.readFileSync('src/shared/workflow.ts', 'utf8');
s = s.replace(
  'export function bypassNode(prompt: ApiPrompt, id: string, input: string, slot = 0): void {',
  'export function bypassNode(prompt: ApiPrompt, id: string, input: string, slot = 0, remove = true): void {',
);
s = s.replace(
  `      if (isLink(v) && v[0] === id && v[1] === slot) other.inputs[k] = [upstream[0], upstream[1]];
    }
  }
  removeNodes(prompt, [id]);`,
  `      if (isLink(v) && v[0] === id && v[1] === slot) other.inputs[k] = [upstream[0], upstream[1]];
    }
  }
  if (remove) removeNodes(prompt, [id]);`,
);
s = s.replace(
  `function applyMissing(prompt: ApiPrompt, plan: MissingPlan): void {
  for (const b of plan.bypass ?? []) {
    for (const id of findByTitle(prompt, b.title)) bypassNode(prompt, id, b.input, b.outputSlot ?? 0);
  }`,
  `function applyMissing(prompt: ApiPrompt, plan: MissingPlan): void {
  // Rewire every bypass first (a node may pass several outputs through), then delete.
  const bypassed = new Set<string>();
  for (const b of plan.bypass ?? []) {
    for (const id of findByTitle(prompt, b.title)) {
      bypassNode(prompt, id, b.input, b.outputSlot ?? 0, false);
      bypassed.add(id);
    }
  }
  removeNodes(prompt, [...bypassed]);`,
);
fs.writeFileSync('src/shared/workflow.ts', s);

let t = fs.readFileSync('tests/workflow.test.ts', 'utf8');
t = t.replace(
  `  it('prunes nodes no output depends on', () => {`,
  `  it('bypasses a multi-output node slot by slot', () => {
    const p: ApiPrompt = {
      '1': { class_type: 'Cond', inputs: {}, _meta: { title: 'c' } },
      '2': { class_type: 'Guide', inputs: { positive: ['1', 0], negative: ['1', 1], latent: ['1', 2] }, _meta: { title: 'DR_END' } },
      '3': { class_type: 'SaveImage', inputs: { a: ['2', 0], b: ['2', 1], c: ['2', 2] }, _meta: { title: 'out' } },
    };
    const spec: WorkflowSpec = {
      file: 'x',
      family: 'f',
      kind: 'video',
      outputs: { v: 'out' },
      params: {
        end: {
          type: 'image',
          targets: [{ title: 'DR_END', input: 'image' }],
          whenMissing: {
            bypass: [
              { title: 'DR_END', input: 'positive', outputSlot: 0 },
              { title: 'DR_END', input: 'negative', outputSlot: 1 },
              { title: 'DR_END', input: 'latent', outputSlot: 2 },
            ],
          },
        },
      },
    };
    const out = buildPrompt(p, spec, {});
    expect(out['3'].inputs).toEqual({ a: ['1', 0], b: ['1', 1], c: ['1', 2] });
    expect(out['2']).toBeUndefined();
  });

  it('prunes nodes no output depends on', () => {`,
);
fs.writeFileSync('tests/workflow.test.ts', t);
console.log('patched');
