import { afterEach, expect, it, vi } from 'vitest';
import { Autosave } from '../src/shared/autosave';
afterEach(() => vi.useRealTimers());
it('flushes an edit when leaving before the debounce expires', async () => {
  vi.useFakeTimers(); const writes: string[] = [];
  const save = new Autosave(async (body) => { writes.push(body); }, () => {});
  save.markSaved('original'); save.schedule('edited');
  await save.flush(); await vi.advanceTimersByTimeAsync(700);
  expect(writes).toEqual(['edited']);
});
it('serialises edits and a revert while an older save is in flight', async () => {
  const writes: string[] = []; let finish!: () => void;
  const save = new Autosave(async (body) => { writes.push(body); if (body === 'edited') await new Promise<void>((r) => { finish = r; }); }, () => {});
  save.markSaved('original'); save.schedule('edited'); const first = save.flush();
  await Promise.resolve(); save.schedule('original'); const last = save.flush();
  finish(); await first; await last;
  expect(writes).toEqual(['edited', 'original']);
});
it('retains a failed edit for retry', async () => {
  const write = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
  const state = vi.fn(); const save = new Autosave(write, state);
  save.schedule('edited'); await save.flush(); expect(state).toHaveBeenLastCalledWith('error');
  await save.flush(); expect(write).toHaveBeenCalledTimes(2); expect(state).toHaveBeenLastCalledWith('saved');
});
it('does not retry an older failure over a newer queued edit', async () => {
  const writes: string[] = []; let fail!: () => void;
  const save = new Autosave(async (body) => { writes.push(body); if (body === 'old') await new Promise<void>((_, reject) => { fail = () => reject(new Error('offline')); }); }, () => {});
  save.schedule('old'); const first = save.flush(); await Promise.resolve();
  save.schedule('new'); const last = save.flush(); fail(); await first; await last; await save.flush();
  expect(writes).toEqual(['old', 'new']);
});
