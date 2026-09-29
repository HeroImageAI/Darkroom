/** Turn ComfyUI/network errors into plain-language messages with a next step. */
export function friendlyError(raw: string): string {
  const s = raw || '';
  if (/out of memory|OutOfMemory|CUDA error: out of memory|allocat/i.test(s))
    return 'The graphics card ran out of memory. Try Draft quality, a shorter clip or a smaller size, and close other GPU-heavy apps.';
  if (/not in list|value_not_in_list/i.test(s)) {
    const m = /'([^']+\.(?:safetensors|gguf|pth|pt|onnx|ckpt))'/.exec(s);
    return m
      ? `A model file is missing: ${m[1]}. See README → Troubleshooting → Missing models.`
      : 'ComfyUI could not find an input file or model. See README → Troubleshooting.';
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|socket hang up|NetworkError/i.test(s))
    return "ComfyUI isn't answering. Start it from the status pill at the top, then try again.";
  if (/interrupted|Interrupted/i.test(s)) return 'Cancelled.';
  if (/node_errors|failed validation/i.test(s)) return `ComfyUI rejected the workflow: ${s}`;
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}
