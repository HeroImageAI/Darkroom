import { describe, expect, it, vi } from 'vitest';
import {
  ComfyClient,
  describePromptError,
  filesFromHistory,
  historyError,
  inputName,
  isDesktopServer,
  parseWsMessage,
  viewQuery,
} from '../src/shared/comfy';

describe('parseWsMessage', () => {
  it('parses progress', () => {
    const ev = parseWsMessage(JSON.stringify({ type: 'progress', data: { prompt_id: 'p', node: 12, value: 2, max: 4 } }));
    expect(ev).toEqual({ type: 'progress', promptId: 'p', node: '12', value: 2, max: 4 });
  });
  it('parses executing end (node null)', () => {
    expect(parseWsMessage(JSON.stringify({ type: 'executing', data: { prompt_id: 'p', node: null } }))).toEqual({
      type: 'executing',
      promptId: 'p',
      node: null,
    });
  });
  it('parses execution_error', () => {
    const ev = parseWsMessage(
      JSON.stringify({ type: 'execution_error', data: { prompt_id: 'p', node_id: '3', node_type: 'KSampler', exception_message: 'CUDA out of memory', exception_type: 'OutOfMemoryError' } }),
    );
    expect(ev).toMatchObject({ type: 'execution_error', node: '3', message: 'CUDA out of memory' });
  });
  it('parses status queue size', () => {
    expect(parseWsMessage(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: 3 } } } }))).toMatchObject({
      type: 'status',
      queueRemaining: 3,
    });
  });
  it('decodes binary preview frames', () => {
    const buf = new Uint8Array(12);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 1);
    dv.setUint32(4, 2);
    buf.set([9, 8, 7, 6], 8);
    const ev = parseWsMessage(buf);
    expect(ev.type).toBe('preview');
    if (ev.type === 'preview') {
      expect(ev.mime).toBe('image/png');
      expect([...ev.image]).toEqual([9, 8, 7, 6]);
    }
  });
  it('tolerates junk', () => {
    expect(parseWsMessage('not json').type).toBe('unknown');
  });
});

describe('history helpers', () => {
  const entry = {
    outputs: {
      '9': { images: [{ filename: 'a.png', subfolder: 'darkroom', type: 'output' }] },
      '12': { images: [{ filename: 'clip.mp4', subfolder: 'darkroom/video', type: 'output' }], animated: [true] },
    },
    status: { status_str: 'success', completed: true },
  };
  it('collects images and videos', () => {
    const files = filesFromHistory(entry);
    expect(files.map((f) => [f.filename, f.kind, f.nodeId])).toEqual([
      ['a.png', 'image', '9'],
      ['clip.mp4', 'video', '12'],
    ]);
  });
  it('filters by node', () => {
    expect(filesFromHistory(entry, ['12'])).toHaveLength(1);
  });
  it('reports errors', () => {
    expect(historyError(entry)).toBeNull();
    expect(
      historyError({ status: { status_str: 'error', messages: [['execution_error', { node_type: 'VAEDecode', exception_message: 'boom' }]] } }),
    ).toBe('VAEDecode: boom');
  });
});

describe('misc', () => {
  it('builds view queries', () => {
    expect(viewQuery({ filename: 'a b.png', subfolder: 'x', type: 'output' })).toBe('/view?filename=a+b.png&subfolder=x&type=output');
  });
  it('recognises the Desktop server', () => {
    const stats = { system: { argv: ['main.py', '--extra-model-paths-config', 'C:\\x\\instance-model-paths\\i.yaml'] }, devices: [] } as any;
    expect(isDesktopServer(stats)).toBe(true);
    expect(isDesktopServer({ ...stats, system: { argv: ['main.py', '--port', '8188'] } })).toBe(false);
  });
  it('names uploaded inputs', () => {
    expect(inputName({ name: 'a.png', subfolder: 'darkroom' })).toBe('darkroom/a.png');
    expect(inputName({ name: 'a.png', subfolder: '' })).toBe('a.png');
  });
  it('describes validation errors in one line', () => {
    const msg = describePromptError({
      error: { message: 'Prompt outputs failed validation' },
      node_errors: { '2': { class_type: 'UNETLoader', errors: [{ message: 'Value not in list', details: "unet_name: 'x' not in list" }] } },
    });
    expect(msg).toBe("Prompt outputs failed validation — UNETLoader: unet_name: 'x' not in list");
  });
});

describe('ComfyClient', () => {
  it('queues with client id and png info', async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ prompt_id: 'abc' }), { status: 200 }));
    const c = new ComfyClient('http://h:1/', fetchMock);
    const id = await c.queuePrompt({ '1': { class_type: 'X', inputs: {} } }, 'cid', { darkroom: { a: 1 } });
    expect(id).toBe('abc');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://h:1/prompt');
    expect(JSON.parse(String(init!.body))).toEqual({
      prompt: { '1': { class_type: 'X', inputs: {} } },
      client_id: 'cid',
      extra_data: { extra_pnginfo: { darkroom: { a: 1 } } },
    });
  });
  it('turns a 400 into a readable error', async () => {
    const c = new ComfyClient('http://h', async () =>
      new Response(JSON.stringify({ error: { message: 'bad' }, node_errors: {} }), { status: 400 }),
    );
    await expect(c.queuePrompt({}, 'c')).rejects.toThrow('bad');
  });
  it('sends /free with both flags', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    await new ComfyClient('http://h', fetchMock).free();
    expect(JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body))).toEqual({ unload_models: true, free_memory: true });
  });
});
