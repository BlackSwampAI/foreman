import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initialState, type Event } from '../src/domain.js';
import { JsonStore } from '../src/store.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const dataFile = async () => { const dir = await mkdtemp(join(tmpdir(), 'foreman-store-events-')); dirs.push(dir); return join(dir, 'state.json'); };
const evt = (name: string, seq?: number): Event => ({ id: `evt_${name}`, type: `test.${name}`, entityType: 'service', entityId: 'svc', at: new Date().toISOString(), data: {}, ...(seq === undefined ? {} : { seq }) });

describe('store event sequencing', () => {
  it('assigns increasing seqs and emits exactly the newly sequenced events', async () => {
    const store = new JsonStore(await dataFile());
    const emitted: Event[][] = [];
    store.on('mutation', (events: Event[]) => emitted.push(events));
    await store.mutate(s => { s.events.push(evt('a'), evt('b')); });
    await store.mutate(s => { s.events.push(evt('c')); });
    expect(emitted.map(batch => batch.map(e => [e.id, e.seq]))).toEqual([[['evt_a', 1], ['evt_b', 2]], [['evt_c', 3]]]);
    const state = await store.load();
    expect(state.events.map(e => e.seq)).toEqual([1, 2, 3]);
    expect(state.eventSeq).toBe(3);
  });

  it('keeps sequencing and emitting when a mutation deletes more events than it adds', async () => {
    const store = new JsonStore(await dataFile());
    await store.mutate(s => { s.events.push(evt('a'), evt('b'), evt('c'), evt('d'), evt('e')); });
    const emitted: Event[][] = [];
    store.on('mutation', (events: Event[]) => emitted.push(events));
    await store.mutate(s => { s.events = s.events.filter(e => e.id === 'evt_e'); s.events.push(evt('deleted')); });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.map(e => [e.id, e.seq])).toEqual([['evt_deleted', 6]]);
    await store.mutate(s => { s.events.push(evt('f')); });
    expect(emitted.at(-1)!.map(e => [e.id, e.seq])).toEqual([['evt_f', 7]]);
    const state = await store.load();
    expect(state.events.map(e => e.seq)).toEqual([5, 6, 7]);
    expect(state.eventSeq).toBe(7);
  });

  it('never reuses or rewinds a seq when every event is deleted', async () => {
    const store = new JsonStore(await dataFile());
    await store.mutate(s => { s.events.push(evt('a'), evt('b'), evt('c')); });
    await store.mutate(s => { s.events = []; });
    expect((await store.load()).eventSeq).toBe(3);
    const emitted: Event[][] = [];
    store.on('mutation', (events: Event[]) => emitted.push(events));
    await store.mutate(s => { s.events.push(evt('d')); });
    expect(emitted[0]!.map(e => e.seq)).toEqual([4]);
  });

  it('does not emit or renumber when a mutation leaves events unchanged', async () => {
    const store = new JsonStore(await dataFile());
    await store.mutate(s => { s.events.push(evt('a')); });
    const emitted: Event[][] = [];
    store.on('mutation', (events: Event[]) => emitted.push(events));
    await store.mutate(s => { s.events[0]!.data = { touched: true }; });
    expect(emitted).toHaveLength(0);
    expect((await store.load()).events[0]!.seq).toBe(1);
  });

  it('sequences events from queued mutations in submission order', async () => {
    const store = new JsonStore(await dataFile());
    await store.load();
    const emitted: number[] = [];
    store.on('mutation', (events: Event[]) => emitted.push(...events.map(e => e.seq!)));
    await Promise.all([1, 2, 3, 4].map(n => store.mutate(s => { s.events.push(evt(`q${n}`)); })));
    expect(emitted).toEqual([1, 2, 3, 4]);
  });

  it('migrates legacy events without a seq in array order on load', async () => {
    const file = await dataFile();
    const legacy = { ...initialState(), events: [evt('old1'), evt('old2'), evt('old3')] };
    await writeFile(file, JSON.stringify(legacy));
    const store = new JsonStore(file);
    const state = await store.load();
    expect(state.events.map(e => [e.id, e.seq])).toEqual([['evt_old1', 1], ['evt_old2', 2], ['evt_old3', 3]]);
    expect(state.eventSeq).toBe(3);
    const emitted: Event[][] = [];
    store.on('mutation', (events: Event[]) => emitted.push(events));
    await store.mutate(s => { s.events.push(evt('new')); });
    expect(emitted[0]!.map(e => e.seq)).toEqual([4]);
  });

  it('continues past existing seqs when only some events are sequenced', async () => {
    const file = await dataFile();
    await writeFile(file, JSON.stringify({ ...initialState(), eventSeq: 2, events: [evt('kept', 9), evt('unsequenced')] }));
    const state = await new JsonStore(file).load();
    expect(state.events.map(e => e.seq)).toEqual([9, 10]);
    expect(state.eventSeq).toBe(10);
  });

  it('persists the counter so it survives a reload from disk', async () => {
    const file = await dataFile();
    const first = new JsonStore(file);
    await first.mutate(s => { s.events.push(evt('a'), evt('b'), evt('c')); });
    await first.mutate(s => { s.events = s.events.slice(2); });
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { eventSeq: number; events: Event[] };
    expect(onDisk.eventSeq).toBe(3);
    expect(onDisk.events.map(e => e.seq)).toEqual([3]);
    const reloaded = new JsonStore(file);
    const emitted: Event[][] = [];
    reloaded.on('mutation', (events: Event[]) => emitted.push(events));
    await reloaded.mutate(s => { s.events = []; s.events.push(evt('d')); });
    expect(emitted[0]!.map(e => e.seq)).toEqual([4]);
    expect((await reloaded.load()).eventSeq).toBe(4);
  });
});
