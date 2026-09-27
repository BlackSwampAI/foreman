import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { initialState, type Event, type State } from './domain.js';

export class JsonStore extends EventEmitter {
  private state: State = initialState();
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();
  // pendingCount: mutations submitted but not yet processed (for burst coalescing).
  // dirty: a successful mutation updated this.state but skipped persist because more were queued.
  private pendingCount = 0;
  private dirty = false;
  constructor(readonly filePath: string) { super(); }

  async load(): Promise<State> {
    if (this.loaded) return this.snapshot();
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as State;
      if (parsed.version !== 1 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.roles) || !Array.isArray(parsed.events)) throw new Error('Unsupported or corrupt Foreman data file');
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.persist(this.state);
    }
    this.loaded = true;
    return this.snapshot();
  }

  snapshot(): State { return structuredClone(this.state); }

  async mutate<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
    await this.load();
    this.pendingCount++;
    let result!: T;
    const next = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const prevLen = this.state.events.length;
      let succeeded = false;
      try {
        result = await fn(draft);
        succeeded = true;
      } finally {
        this.pendingCount--;
        if (succeeded) {
          // Apply draft; persist now if we are the last queued mutation, otherwise mark dirty.
          this.state = draft;
          if (this.pendingCount === 0) {
            await this.persist(this.state);
            this.dirty = false;
          } else {
            this.dirty = true;
          }
          if (this.state.events.length > prevLen) {
            this.emit('mutation', this.state.events.slice(prevLen) as Event[]);
          }
        } else if (this.pendingCount === 0 && this.dirty) {
          // This mutation failed but it is the last queued; flush prior successful mutations' state.
          await this.persist(this.state).catch(() => undefined);
          this.dirty = false;
        }
      }
    });
    this.queue = next.catch(() => undefined);
    await next;
    return result;
  }

  /** Flush any in-memory state not yet written to disk. Call during graceful shutdown. */
  async flush(): Promise<void> {
    await this.queue;
    if (this.dirty) {
      await this.persist(this.state);
      this.dirty = false;
    }
  }

  protected async persist(state: State): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = join(dirname(this.filePath), `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    // Compact JSON (no pretty-print) keeps files small and writes fast.
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, this.filePath);
  }
}
