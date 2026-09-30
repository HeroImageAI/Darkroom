/**
 * Local vision-language model (Qwen3-VL 8B via ComfyUI TextGenerate): request building and output cleanup.
 * System prompts live in presets/vlm_prompts.json.
 */

export type VlmTask = 'caption' | 'reverse' | 'enhance' | 'motion';

export interface VlmEntry {
  system: string;
  user: string;
  max_tokens: number;
  empty_system?: string;
  empty_user?: string;
}

export type VlmPrompts = Record<VlmTask, Record<string, VlmEntry>>;

export const VLM_VARIANTS: Record<VlmTask, string[]> = {
  caption: ['short', 'detailed', 'klein'],
  reverse: ['klein', 'qwen'],
  enhance: ['klein', 'qwen'],
  motion: ['wan', 'ltx'],
};

/** Which tasks need an image. Motion uses the start frame; enhance is text-only. */
export function needsImage(task: VlmTask): boolean {
  return task !== 'enhance';
}

export interface VlmRequest {
  workflow: 'vlm_image' | 'vlm_text';
  prompt: string;
  maxTokens: number;
}

export function buildVlmRequest(p: VlmPrompts, task: VlmTask, variant: string, text = ''): VlmRequest {
  const entry = p[task]?.[variant];
  if (!entry) throw new Error(`Unknown VLM task ${task}/${variant}`);
  const t = text.trim();
  if (task === 'enhance' && !t) throw new Error('Type a prompt first, then press Enhance.');
  const useEmpty = !t && entry.empty_system && entry.empty_user;
  const system = useEmpty ? entry.empty_system! : entry.system;
  const user = (useEmpty ? entry.empty_user! : entry.user).replace(/\{text\}/g, t);
  // TextGenerate has no separate system slot; the chat template wraps this as the user turn.
  return {
    workflow: needsImage(task) ? 'vlm_image' : 'vlm_text',
    prompt: `${system}\n\n${user}`,
    maxTokens: entry.max_tokens,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// v2 (Addenda Phase 7): per-task engine routing, real system prompts, official Qwen-Image 2.1 prompt enhancers.

export type VlmEngine = 'general' | 'pe_t2i' | 'pe_i2i';
export type Vlm2Task = VlmTask | 'edit_enhance' | 'compose';

export interface Vlm2Entry extends Partial<VlmEntry> {
  /** Which model answers (vlm_prompts.json "models"); default "general". */
  engine?: VlmEngine;
  /** System prompt kept in its own file under presets/ (the official PE prompts are ~10 k characters). */
  system_file?: string;
  /** "json_ratio": the answer is {"rewritten_prompt", "wh_ratio"} (PE-T2I). */
  output?: 'text' | 'json_ratio';
  image?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  thinking?: boolean;
}

export interface VlmModelRef {
  file: string;
  label: string;
  /** CLIPLoader type; "stable_diffusion" builds the plain chat model. */
  loader?: string;
}

export interface Vlm2Prompts {
  models: Record<VlmEngine, VlmModelRef>;
  [task: string]: Record<string, Vlm2Entry> | Record<VlmEngine, VlmModelRef>;
}

export interface Vlm2Request {
  workflow: 'vlm2_image' | 'vlm2_text';
  params: Record<string, string | number | boolean>;
  modelLabel: string;
  output: 'text' | 'json_ratio';
}

export function buildVlm2Request(p: Vlm2Prompts, task: Vlm2Task, variant: string, text = '', readFile: (rel: string) => string = () => ''): Vlm2Request {
  const entry = (p[task] as Record<string, Vlm2Entry> | undefined)?.[variant];
  if (!entry) throw new Error(`Unknown VLM task ${task}/${variant}`);
  const t = text.trim();
  if ((task === 'enhance' || task === 'edit_enhance') && !t) throw new Error(task === 'enhance' ? 'Type a prompt first, then press Enhance.' : 'Type an instruction first, then press Enhance.');
  const useEmpty = !t && !!entry.empty_system && !!entry.empty_user;
  const system = entry.system_file ? readFile(entry.system_file) : (useEmpty ? entry.empty_system : entry.system) ?? '';
  // PE engines take the user's words as they are; the general engine wraps them in the task's user template
  const user = entry.system_file ? t : ((useEmpty ? entry.empty_user : entry.user) ?? '{text}').replace(/\{text\}/g, t);
  const model = p.models[(entry.engine ?? 'general') as VlmEngine];
  if (!model) throw new Error(`No model configured for ${entry.engine}`);
  const image = entry.image ?? (task !== 'enhance');
  return {
    workflow: image ? 'vlm2_image' : 'vlm2_text',
    params: {
      model: model.file,
      loader: model.loader ?? 'stable_diffusion',
      system,
      prompt: user,
      max_tokens: entry.max_tokens ?? 512,
      temperature: entry.temperature ?? 0.7,
      top_p: entry.top_p ?? 0.8,
      top_k: entry.top_k ?? 20,
      thinking: entry.thinking ?? false,
    },
    modelLabel: model.label,
    output: entry.output ?? 'text',
  };
}

const ASPECT_LIST = ['1:1', '4:5', '3:2', '16:9', '9:16'] as const;
/** Snap a PE "wh_ratio" (e.g. "2:3", "21:9") to the nearest Darkroom aspect (log-ratio distance). */
export function nearestAspect(ratio: string): (typeof ASPECT_LIST)[number] | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/.exec(ratio ?? '');
  if (!m || !Number(m[2])) return null;
  const r = Math.log(Number(m[1]) / Number(m[2]));
  // nearest in log space; near-ties (within 0.02) go to the squarer aspect, the gentler crop
  // (2:3, the PE's default portrait, sits 0.17 from 9:16 and 0.18 from 4:5: a poster reads better at 4:5)
  const scored = ASPECT_LIST.map((a) => {
    const [w, h] = a.split(':').map(Number);
    return { a, d: Math.abs(Math.log(w / h) - r), sq: Math.abs(Math.log(w / h)) };
  }).sort((x, y) => (Math.abs(x.d - y.d) <= 0.02 ? x.sq - y.sq : x.d - y.d));
  return scored[0].a;
}

/** Parse a PE-T2I JSON answer; falls back to cleaned plain text when the model did not answer in JSON. */
export function parsePeJson(raw: string): { text: string; ratio: string | null } {
  const s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const j = JSON.parse(s.slice(a, b + 1));
      if (typeof j.rewritten_prompt === 'string' && j.rewritten_prompt.trim()) return { text: j.rewritten_prompt.trim(), ratio: typeof j.wh_ratio === 'string' ? j.wh_ratio : null };
    } catch {
      /* fall through */
    }
  }
  return { text: cleanVlmOutput(s), ratio: null };
}

const FINAL_MARKER = /(?:^|\n)\s*\**(?:final (?:version|answer|instruction|rewrite|prompt)|rewritten (?:instruction|prompt))\**\s*:\**\s*/gi;
const REASONING_START = /^(?:the user'?s? (?:instruction|request|prompt)|intent\s*:|step 1|let me|okay[,.]|we need|first,|i need|analy[sz]ing)/i;

/**
 * PE-I2I sometimes reasons in the open even with thinking off ("The user's instruction is …", checks, "Final version:").
 * Keep only the answer: the text after the last "Final version:"-style marker, else the last paragraph.
 */
export function stripLeakedReasoning(s: string): string {
  const marks = [...s.matchAll(FINAL_MARKER)];
  if (marks.length) {
    const last = marks[marks.length - 1];
    const after = s.slice(last.index! + last[0].length).trim();
    if (after) return after;
  }
  if (!REASONING_START.test(s.trim())) return s;
  const paras = s.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  return paras.length > 1 ? paras[paras.length - 1] : s;
}

/** Strip reasoning blocks, labels, fences and wrapping quotes from model output. */
export function cleanVlmOutput(raw: string): string {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '');
  s = stripLeakedReasoning(s.trim());
  s = s.replace(/^```[a-z]*\s*|\s*```$/gi, '').trim();
  s = s.replace(/^(rewritten prompt|video prompt|prompt|caption|description|output)\s*:\s*/i, '');
  s = s.replace(/^\*\*[^*]+\*\*\s*:?\s*/, '');
  const q = s.match(/^["“](.*)["”]$/s);
  if (q && !q[1].includes('"')) s = q[1];
  s = s.trim();
  // a lone closing quote left over after the answer (odd quote count, quote at the very end)
  if (/["”]$/.test(s) && (s.match(/["“”]/g) ?? []).length % 2 === 1) s = s.slice(0, -1).trim();
  // ...or a lone opening one (PE-I2I without thinking wraps its answer in a quote it never closes)
  else if (/^["“]/.test(s) && (s.match(/["“”]/g) ?? []).length % 2 === 1) s = s.slice(1).trim();
  return completeSentences(s).replace(/\n{3,}/g, '\n\n').trim();
}

/** If generation stopped at the token limit mid-sentence, drop the unfinished sentence. */
export function completeSentences(s: string): string {
  if (!s || /[.!?]["”')\]]?$/.test(s)) return s;
  let cut = -1;
  for (const m of s.matchAll(/[.!?]["”')\]]?(?=\s)/g)) cut = m.index! + m[0].length;
  // keep the fragment if cutting would throw away most of the answer
  return cut >= s.length * 0.5 ? s.slice(0, cut) : s;
}
