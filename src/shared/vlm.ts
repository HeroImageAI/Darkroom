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

/** Strip reasoning blocks, labels, fences and wrapping quotes from model output. */
export function cleanVlmOutput(raw: string): string {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '');
  s = s.replace(/^```[a-z]*\s*|\s*```$/gi, '').trim();
  s = s.replace(/^(rewritten prompt|video prompt|prompt|caption|description|output)\s*:\s*/i, '');
  s = s.replace(/^\*\*[^*]+\*\*\s*:?\s*/, '');
  const q = s.match(/^["“](.*)["”]$/s);
  if (q && !q[1].includes('"')) s = q[1];
  return s.replace(/\n{3,}/g, '\n\n').trim();
}
