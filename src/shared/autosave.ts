/** Debounced saves are serialised; leaving a screen flushes the latest pending edit. */
export class Autosave {
  private saved = '';
  private pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  constructor(private write: (body: string) => Promise<unknown>, private state: (s: 'saving' | 'saved' | 'error') => void) {}
  markSaved(body: string) { this.saved = body; }
  schedule(body: string) {
    clearTimeout(this.timer);
    this.pending = body === this.saved && !this.queued ? null : body;
    if (!this.pending) return;
    this.state('saving');
    this.timer = setTimeout(() => { void this.flush(); }, 600);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    const body = this.pending;
    this.pending = null;
    if (!body) return this.chain;
    this.queued++;
    this.chain = this.chain.then(async () => {
      try {
        await this.write(body);
        this.saved = body;
        if (!this.pending && this.queued === 1) this.state('saved');
      } catch {
        // Retain failed edits for a later flush/retry rather than treating them as saved.
        if (!this.pending && this.queued === 1) this.pending = body;
        this.state('error');
      } finally {
        this.queued--;
      }
    });
    return this.chain;
  }
}
