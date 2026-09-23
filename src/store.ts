import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { initialState, type State } from './domain.js';

export class JsonStore {
  private state: State = initialState();
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly filePath: string) {}

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
    let result!: T;
    const next = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      result = await fn(draft);
      await this.persist(draft);
      this.state = draft;
    });
    this.queue = next.catch(() => undefined);
    await next;
    return result;
  }

  private async persist(state: State): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = join(dirname(this.filePath), `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.filePath);
  }
}
