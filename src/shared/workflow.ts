/**
 * Pure helpers for ComfyUI API-format prompts.
 *
 * Nodes are addressed by `_meta.title` (DR_*), never by id, so a workflow can be
 * re-exported from ComfyUI without breaking the app.
 */

export type Link = [string, number];
export type InputValue = string | number | boolean | null | Link | unknown[] | Record<string, unknown>;

export interface ApiNode {
  class_type: string;
  inputs: Record<string, InputValue>;
  _meta?: { title?: string };
}

export type ApiPrompt = Record<string, ApiNode>;

export interface Target {
  title: string;
  input: string;
}

export interface ParamSpec {
  /** One or more node inputs this parameter writes. */
  targets: Target[];
  type: 'string' | 'int' | 'float' | 'bool' | 'image' | 'video' | 'combo';
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  /** For optional image/video params: what to do when no value is given. */
  whenMissing?: MissingPlan;
  label?: string;
}

export interface MissingPlan {
  /** Nodes to delete. Consumers of their outputs lose that link. */
  remove?: string[];
  /** Nodes to bypass: consumers are rewired to the node's given input link. */
  bypass?: { title: string; input: string; outputSlot?: number }[];
  /** Plain values to set instead (e.g. switch a mode off). */
  set?: { title: string; input: string; value: InputValue }[];
}

export interface WorkflowSpec {
  file: string;
  family: string;
  kind: 'image' | 'video' | 'text';
  label?: string;
  params: Record<string, ParamSpec>;
  /** Titles of save nodes whose outputs the app collects, keyed by role. */
  outputs: Record<string, string>;
}

export type ParamValues = Record<string, string | number | boolean | null | undefined>;

export class WorkflowError extends Error {}

export function isLink(v: unknown): v is Link {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number';
}

export function titleOf(node: ApiNode): string {
  return (node._meta?.title ?? '').trim();
}

/** All node ids whose title matches exactly. */
export function findByTitle(prompt: ApiPrompt, title: string): string[] {
  const t = title.trim();
  return Object.keys(prompt).filter((id) => titleOf(prompt[id]) === t);
}

export function clonePrompt(prompt: ApiPrompt): ApiPrompt {
  return JSON.parse(JSON.stringify(prompt)) as ApiPrompt;
}

/** Set an input on every node carrying `title`. Throws if the title is absent. */
export function setInput(prompt: ApiPrompt, target: Target, value: InputValue): void {
  const ids = findByTitle(prompt, target.title);
  if (ids.length === 0) throw new WorkflowError(`No node titled ${target.title}`);
  for (const id of ids) prompt[id].inputs[target.input] = value;
}

/** Delete nodes; any input linking to them is dropped. */
export function removeNodes(prompt: ApiPrompt, ids: string[]): void {
  const gone = new Set(ids);
  for (const id of ids) delete prompt[id];
  for (const node of Object.values(prompt)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (isLink(v) && gone.has(v[0])) delete node.inputs[k];
    }
  }
}

/** Rewire consumers of `id` (output slot `slot`) to whatever feeds `id.inputs[input]`, then delete `id`. */
export function bypassNode(prompt: ApiPrompt, id: string, input: string, slot = 0, remove = true): void {
  const node = prompt[id];
  if (!node) return;
  const upstream = node.inputs[input];
  if (!isLink(upstream)) throw new WorkflowError(`Cannot bypass ${titleOf(node)}: ${input} is not a link`);
  for (const other of Object.values(prompt)) {
    for (const [k, v] of Object.entries(other.inputs)) {
      if (isLink(v) && v[0] === id && v[1] === slot) other.inputs[k] = [upstream[0], upstream[1]];
    }
  }
  if (remove) removeNodes(prompt, [id]);
}

/** Node classes that produce results (kept by prune). */
const OUTPUT_CLASSES = new Set(['PreviewAny', 'SaveImage', 'SaveVideo', 'PreviewImage', 'SaveAnimatedWEBP', 'SaveImageAdvanced', 'SaveAudio']);

export function isOutputNode(node: ApiNode): boolean {
  return OUTPUT_CLASSES.has(node.class_type) || /^Save/.test(node.class_type);
}

/** Remove nodes that no output node depends on. */
export function prune(prompt: ApiPrompt): void {
  const keep = new Set<string>();
  const stack = Object.keys(prompt).filter((id) => isOutputNode(prompt[id]));
  while (stack.length) {
    const id = stack.pop()!;
    if (keep.has(id) || !prompt[id]) continue;
    keep.add(id);
    for (const v of Object.values(prompt[id].inputs)) if (isLink(v)) stack.push(v[0]);
  }
  for (const id of Object.keys(prompt)) if (!keep.has(id)) delete prompt[id];
}

/** Links that point at nodes that no longer exist. */
export function danglingLinks(prompt: ApiPrompt): string[] {
  const out: string[] = [];
  for (const [id, node] of Object.entries(prompt)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (isLink(v) && !prompt[v[0]]) out.push(`${id}.${k} -> ${v[0]}`);
    }
  }
  return out;
}

function coerce(spec: ParamSpec, name: string, raw: unknown): InputValue {
  switch (spec.type) {
    case 'int':
    case 'float': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new WorkflowError(`${name} must be a number`);
      let v = spec.type === 'int' ? Math.round(n) : n;
      if (spec.min !== undefined) v = Math.max(spec.min, v);
      if (spec.max !== undefined) v = Math.min(spec.max, v);
      return v;
    }
    case 'bool':
      return raw === true || raw === 'true' || raw === 1;
    default:
      return String(raw);
  }
}

function applyMissing(prompt: ApiPrompt, plan: MissingPlan): void {
  // Rewire every bypass first (a node may pass several outputs through), then delete.
  const bypassed = new Set<string>();
  for (const b of plan.bypass ?? []) {
    for (const id of findByTitle(prompt, b.title)) {
      bypassNode(prompt, id, b.input, b.outputSlot ?? 0, false);
      bypassed.add(id);
    }
  }
  removeNodes(prompt, [...bypassed]);
  for (const s of plan.set ?? []) {
    for (const id of findByTitle(prompt, s.title)) prompt[id].inputs[s.input] = s.value;
  }
  const ids = (plan.remove ?? []).flatMap((t) => findByTitle(prompt, t));
  removeNodes(prompt, ids);
}

/**
 * Produce a ready-to-queue prompt from a template, its spec and the UI values.
 * Missing values fall back to spec defaults; optional media params without a
 * value apply their `whenMissing` plan. Unused branches are pruned.
 */
export function buildPrompt(template: ApiPrompt, spec: WorkflowSpec, values: ParamValues): ApiPrompt {
  const prompt = clonePrompt(template);
  for (const [name, p] of Object.entries(spec.params)) {
    const given = values[name];
    const empty = given === undefined || given === null || given === '';
    if (empty && p.whenMissing) {
      applyMissing(prompt, p.whenMissing);
      continue;
    }
    const raw = empty ? p.default : given;
    if (raw === undefined) {
      if (p.type === 'image' || p.type === 'video') throw new WorkflowError(`${p.label ?? name} is required`);
      continue;
    }
    const v = coerce(p, name, raw);
    for (const t of p.targets) {
      if (findByTitle(prompt, t.title).length === 0) continue; // node removed by an earlier plan
      setInput(prompt, t, v);
    }
  }
  prune(prompt);
  const dangling = danglingLinks(prompt);
  if (dangling.length) throw new WorkflowError(`Workflow ${spec.file} has broken links: ${dangling.join(', ')}`);
  return prompt;
}

/** Check that every title the spec refers to exists in the template. */
export function validateSpec(template: ApiPrompt, spec: WorkflowSpec): string[] {
  const problems: string[] = [];
  const need = new Set<string>();
  for (const p of Object.values(spec.params)) {
    p.targets.forEach((t) => need.add(t.title));
    p.whenMissing?.remove?.forEach((t) => need.add(t));
    p.whenMissing?.bypass?.forEach((b) => need.add(b.title));
  }
  Object.values(spec.outputs).forEach((t) => need.add(t));
  for (const t of need) if (findByTitle(template, t).length === 0) problems.push(`missing title ${t}`);
  for (const p of Object.values(spec.params)) {
    for (const t of p.targets) {
      for (const id of findByTitle(template, t.title)) {
        if (!(t.input in template[id].inputs)) problems.push(`${t.title} has no input ${t.input}`);
      }
    }
  }
  return problems;
}

/** Ids of the output nodes for a role, after patching. */
export function outputNodeIds(prompt: ApiPrompt, spec: WorkflowSpec): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [role, title] of Object.entries(spec.outputs)) out[role] = findByTitle(prompt, title);
  return out;
}
