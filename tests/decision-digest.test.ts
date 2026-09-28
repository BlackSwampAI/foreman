import { describe, expect, it, vi } from 'vitest';
import {
  DecisionDigestStore, EVIDENCE_CHANGED_MESSAGE, decisionKey, deriveDigestView, postDecision,
  type DecisionSnapshot, type EvidenceIdentity,
} from '../ui/decision-digest.js';

// ── Test helpers: a mocked fetch and a settle tick (no DOM needed) ─────────

const hex = (char: string) => char.repeat(64);
const identity = (over: Partial<EvidenceIdentity> = {}): EvidenceIdentity => ({
  runId: 'run-1', workerResponseId: 'resp-1', validationId: 'val-1', recommendationId: 'rec-1', controllerActive: false, ...over,
});
/** Body of GET /api/runs/:id/decision for the evidence in `identity`. */
const checkpoint = (over: Record<string, unknown> = {}) => ({
  runId: 'run-1', evidenceDigest: hex('a'), pinnedBaseCommit: 'c'.repeat(40),
  workerResponseId: 'resp-1', validationId: 'val-1', recommendationId: 'rec-1', ...over,
});
const reply = (status: number, body: unknown, statusText = ''): Response =>
  ({ ok: status >= 200 && status < 300, status, statusText, json: async () => body }) as unknown as Response;
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

interface Call { method: string; url: string; body?: Record<string, unknown> }
/** A fetch mock that records every call; `handler` answers it. */
function mockFetch(handler: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined };
    calls.push(call);
    return handler(call);
  });
  return { fetchImpl, calls, gets: () => calls.filter(c => c.method === 'GET'), posts: () => calls.filter(c => c.method === 'POST') };
}
const snap = (store: DecisionDigestStore): DecisionSnapshot => store.getSnapshot();

describe('decision digest: fetch on render, send on click', () => {
  it('fetches GET /api/runs/:id/decision when the panel renders and a click sends that digest with no extra GET', async () => {
    const api = mockFetch(call => call.method === 'GET' ? reply(200, checkpoint()) : reply(200, { id: 'approval-1' }));
    const store = new DecisionDigestStore(api.fetchImpl);

    store.sync(identity());
    expect(api.calls).toEqual([{ method: 'GET', url: '/api/runs/run-1/decision', body: undefined }]);
    expect(snap(store).status).toBe('loading');
    await flush();
    expect(snap(store)).toMatchObject({ status: 'ready', digest: { evidenceDigest: hex('a'), pinnedBaseCommit: 'c'.repeat(40) } });

    await store.decide(digest => postDecision('run-1', { approved: true, evidenceDigest: digest }, api.fetchImpl));
    expect(api.gets()).toHaveLength(1);
    expect(api.posts()).toEqual([{ method: 'POST', url: '/api/runs/run-1/approve', body: { approved: true, evidenceDigest: hex('a') } }]);
  });

  it('sends the same digest for Reject, with the optional rationale', async () => {
    const api = mockFetch(call => call.method === 'GET' ? reply(200, checkpoint()) : reply(200, {}));
    const store = new DecisionDigestStore(api.fetchImpl);
    store.sync(identity());
    await flush();

    await store.decide(digest => postDecision('run-1', { approved: false, evidenceDigest: digest, rationale: 'Out of scope' }, api.fetchImpl));
    expect(api.gets()).toHaveLength(1);
    expect(api.posts()[0]?.body).toEqual({ approved: false, evidenceDigest: hex('a'), rationale: 'Out of scope' });
  });

  it('does nothing on a click before the digest is ready, or while it failed', async () => {
    const pendingGet = deferred<Response>();
    const api = mockFetch(() => pendingGet.promise);
    const store = new DecisionDigestStore(api.fetchImpl);
    const submit = vi.fn(async () => ({}));

    store.sync(identity());
    await store.decide(submit);
    expect(submit).not.toHaveBeenCalled();

    pendingGet.resolve(reply(500, { error: 'boom' }));
    await flush();
    expect(snap(store).status).toBe('error');
    await store.decide(submit);
    expect(submit).not.toHaveBeenCalled();
    expect(api.gets()).toHaveLength(1);
  });

  it('ignores a second click while a decision is in flight', async () => {
    const api = mockFetch(() => reply(200, checkpoint()));
    const store = new DecisionDigestStore(api.fetchImpl);
    store.sync(identity());
    await flush();
    const gate = deferred<void>();
    const submit = vi.fn(async () => { await gate.promise; return {}; });

    const first = store.decide(submit);
    await store.decide(submit);
    gate.resolve();
    await first;
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('decision digest: keyed on the evidence identity', () => {
  it('does not refetch for the same evidence (unrelated re-renders)', async () => {
    const api = mockFetch(() => reply(200, checkpoint()));
    const store = new DecisionDigestStore(api.fetchImpl);
    store.sync(identity());
    await flush();
    store.sync(identity());
    store.sync({ ...identity() });
    await flush();
    expect(api.gets()).toHaveLength(1);
    expect(snap(store).status).toBe('ready');
  });

  it.each([
    ['Worker response', { workerResponseId: 'resp-2' }],
    ['validation', { validationId: 'val-2' }],
    ['Reviewer recommendation', { recommendationId: 'rec-2' }],
  ])('refetches when the %s changes', async (_name, change) => {
    // Each GET is answered for the evidence it was requested for.
    let requests = 0;
    const api = mockFetch(() => reply(200, ++requests === 1 ? checkpoint({ evidenceDigest: hex('1') }) : checkpoint({ evidenceDigest: hex('2'), ...change })));
    const store = new DecisionDigestStore(api.fetchImpl);
    store.sync(identity());
    await flush();
    expect(snap(store).digest?.evidenceDigest).toBe(hex('1'));

    store.sync(identity(change));
    expect(snap(store).status).toBe('loading');
    await flush();
    expect(api.gets()).toHaveLength(2);
    expect(snap(store)).toMatchObject({ status: 'ready', digest: { evidenceDigest: hex('2') } });
  });

  it('refetches for a different run', async () => {
    const api = mockFetch(call => reply(200, checkpoint({ runId: call.url.includes('run-2') ? 'run-2' : 'run-1' })));
    const store = new DecisionDigestStore(api.fetchImpl);
    store.sync(identity());
    await flush();
    store.sync(identity({ runId: 'run-2' }));
    await flush();
    expect(api.gets().map(c => c.url)).toEqual(['/api/runs/run-1/decision', '/api/runs/run-2/decision']);
    expect(snap(store).digest?.runId).toBe('run-2');
  });

  it('does not fetch while the controller is active, and fetches again once it stops', async () => {
    const api = mockFetch(() => reply(200, checkpoint()));
    const store = new DecisionDigestStore(api.fetchImpl);
    store.sync(identity({ controllerActive: true }));
    await flush();
    expect(api.calls).toHaveLength(0);
    expect(snap(store).status).toBe('idle');

    store.sync(identity());
    await flush();
    expect(api.gets()).toHaveLength(1);
    expect(snap(store).status).toBe('ready');

    // A new controller cycle with the very same evidence ids still refetches afterwards.
    store.sync(identity({ controllerActive: true }));
    expect(snap(store).status).toBe('idle');
    store.sync(identity());
    await flush();
    expect(api.gets()).toHaveLength(2);
  });

  it('derives the key from the three evidence ids plus the controller being inactive', () => {
    expect(decisionKey(undefined)).toBeUndefined();
    expect(decisionKey(identity({ controllerActive: true }))).toBeUndefined();
    expect(decisionKey(identity())).toBe(decisionKey(identity()));
    expect(decisionKey(identity())).not.toBe(decisionKey(identity({ validationId: 'val-2' })));
    expect(decisionKey(identity({ recommendationId: undefined }))).not.toBe(decisionKey(identity()));
  });

  it('never shows the previous digest for new evidence, even before the refetch starts', () => {
    const ready: DecisionSnapshot = { status: 'ready', key: decisionKey(identity()), digest: checkpoint() };
    expect(deriveDigestView(ready, decisionKey(identity()))).toMatchObject({ status: 'ready', digest: { evidenceDigest: hex('a') } });
    const next = deriveDigestView(ready, decisionKey(identity({ validationId: 'val-2' })));
    expect(next.status).toBe('loading');
    expect(next.digest).toBeUndefined();
    expect(deriveDigestView(ready, undefined).status).toBe('idle');
  });
});

describe('decision digest: out-of-order responses', () => {
  it('ignores a stale response that arrives after the newer one', async () => {
    const first = deferred<Response>(), second = deferred<Response>();
    let requests = 0;
    const api = mockFetch(() => (++requests === 1 ? first : second).promise);
    const store = new DecisionDigestStore(api.fetchImpl);

    store.sync(identity());
    store.sync(identity({ validationId: 'val-2' }));
    second.resolve(reply(200, checkpoint({ validationId: 'val-2', evidenceDigest: hex('b') })));
    await flush();
    expect(snap(store)).toMatchObject({ status: 'ready', digest: { evidenceDigest: hex('b') } });

    first.resolve(reply(200, checkpoint({ evidenceDigest: hex('a') })));
    await flush();
    expect(snap(store)).toMatchObject({ status: 'ready', digest: { evidenceDigest: hex('b') } });
  });

  it('ignores a stale response that arrives before the newer one, and a stale failure too', async () => {
    const first = deferred<Response>(), second = deferred<Response>();
    let requests = 0;
    const api = mockFetch(() => (++requests === 1 ? first : second).promise);
    const store = new DecisionDigestStore(api.fetchImpl);

    store.sync(identity());
    store.sync(identity({ validationId: 'val-2' }));
    first.resolve(reply(500, { error: 'stale failure' }));
    await flush();
    expect(snap(store).status).toBe('loading');

    second.resolve(reply(200, checkpoint({ validationId: 'val-2', evidenceDigest: hex('b') })));
    await flush();
    expect(snap(store)).toMatchObject({ status: 'ready', digest: { evidenceDigest: hex('b') } });
  });

  it('drops an in-flight response once the run stops being decidable', async () => {
    const pendingGet = deferred<Response>();
    const api = mockFetch(() => pendingGet.promise);
    const store = new DecisionDigestStore(api.fetchImpl);
    store.sync(identity());
    store.sync(undefined);
    pendingGet.resolve(reply(200, checkpoint()));
    await flush();
    expect(snap(store).status).toBe('idle');
    expect(snap(store).digest).toBeUndefined();
  });

  it('notifies subscribers on every state change', async () => {
    const api = mockFetch(() => reply(200, checkpoint()));
    const store = new DecisionDigestStore(api.fetchImpl);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.sync(identity());
    await flush();
    expect(listener).toHaveBeenCalledTimes(2); // loading, ready
    unsubscribe();
    store.sync(identity({ validationId: 'val-2' }));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('decision digest: failures keep the buttons disabled and can be retried', () => {
  it('reports HTTP errors with the server message and recovers on retry', async () => {
    let fail = true;
    const api = mockFetch(() => fail ? reply(409, { error: 'Run is not at a decision checkpoint' }) : reply(200, checkpoint()));
    const store = new DecisionDigestStore(api.fetchImpl);
    store.sync(identity());
    await flush();
    expect(snap(store)).toMatchObject({ status: 'error', error: 'Run is not at a decision checkpoint' });
    expect(snap(store).digest).toBeUndefined();

    fail = false;
    store.retry();
    expect(snap(store).status).toBe('loading');
    await flush();
    expect(api.gets()).toHaveLength(2);
    expect(snap(store).status).toBe('ready');
  });

  it('reports network failures and falls back to the HTTP status without a JSON error', async () => {
    let requests = 0;
    const api = mockFetch(() => { if (++requests === 1) throw new Error('Failed to fetch'); return reply(404, undefined, 'Not Found'); });
    const store = new DecisionDigestStore(api.fetchImpl);
    store.sync(identity());
    await flush();
    expect(snap(store)).toMatchObject({ status: 'error', error: 'Failed to fetch' });
    store.retry();
    await flush();
    expect(snap(store)).toMatchObject({ status: 'error', error: '404 Not Found' });
  });

  it.each([
    ['a malformed digest', checkpoint({ evidenceDigest: 'abc' })],
    ['an incomplete checkpoint', { runId: 'run-1', evidenceDigest: hex('a') }],
  ])('rejects %s', async (_name, body) => {
    const api = mockFetch(() => reply(200, body));
    const store = new DecisionDigestStore(api.fetchImpl);
    store.sync(identity());
    await flush();
    expect(snap(store).status).toBe('error');
    expect(snap(store).digest).toBeUndefined();
  });

  it('refuses a digest issued for evidence other than what the panel shows', async () => {
    // The server already moved to a newer validation; the view has not refreshed yet.
    const api = mockFetch(() => reply(200, checkpoint({ validationId: 'val-newer' })));
    const store = new DecisionDigestStore(api.fetchImpl);
    store.sync(identity());
    await flush();
    expect(snap(store).status).toBe('error');
    expect(snap(store).error).toMatch(/no longer matches what is on screen/);
    await store.decide(async () => ({}));
    expect(api.posts()).toHaveLength(0);
  });
});

describe('decision digest: a 409 (evidence changed)', () => {
  const serverMessage = 'The evidence changed since you reviewed it; refresh and review the current result before deciding.';

  it('surfaces the message, refreshes the state, refetches the digest, and lets the operator decide again', async () => {
    let current = hex('a');
    const log: string[] = [];
    const api = mockFetch(call => {
      log.push(call.method);
      if (call.method === 'GET') return reply(200, checkpoint({ evidenceDigest: current }));
      if (call.body?.evidenceDigest === hex('a')) { current = hex('b'); return reply(409, { error: serverMessage }); }
      return reply(200, { id: 'approval-1' });
    });
    const store = new DecisionDigestStore(api.fetchImpl);
    store.sync(identity());
    await flush();

    // Same shape as the App's decision handler: POST, then the normal state refresh.
    const decideLikeApp = (approved: boolean) => store.decide(async digest => {
      const outcome = await postDecision('run-1', { approved, evidenceDigest: digest }, api.fetchImpl);
      log.push('refresh');
      return outcome;
    });

    await decideLikeApp(true);
    expect(snap(store).conflict).toBe(serverMessage);
    expect(snap(store).status).toBe('loading'); // buttons stay disabled until the new digest arrives
    expect(snap(store).digest).toBeUndefined();
    await flush();
    expect(log).toEqual(['GET', 'POST', 'refresh', 'GET']);
    expect(snap(store)).toMatchObject({ status: 'ready', conflict: serverMessage, digest: { evidenceDigest: hex('b') } });

    // Deciding again uses the new digest and clears the message.
    await decideLikeApp(true);
    expect(api.posts().map(c => c.body?.evidenceDigest)).toEqual([hex('a'), hex('b')]);
    expect(snap(store).conflict).toBeUndefined();
    expect(api.gets()).toHaveLength(2);
  });

  it('keeps the message while the view refreshes to new evidence', async () => {
    const api = mockFetch(call => call.method === 'GET' ? reply(200, checkpoint()) : reply(409, { error: serverMessage }));
    const store = new DecisionDigestStore(api.fetchImpl);
    store.sync(identity());
    await flush();
    await store.decide(digest => postDecision('run-1', { approved: false, evidenceDigest: digest }, api.fetchImpl));
    await flush();
    api.fetchImpl.mockImplementation(async () => reply(200, checkpoint({ validationId: 'val-2' })));
    store.sync(identity({ validationId: 'val-2' }));
    await flush();
    expect(snap(store)).toMatchObject({ status: 'ready', conflict: serverMessage });
    // A different run starts clean.
    api.fetchImpl.mockImplementation(async () => reply(200, checkpoint({ runId: 'run-2' })));
    store.sync(identity({ runId: 'run-2' }));
    await flush();
    expect(snap(store).conflict).toBeUndefined();
  });

  it('postDecision resolves the conflict message, with a standard fallback', async () => {
    const withBody = mockFetch(() => reply(409, { error: serverMessage }));
    expect(await postDecision('run-1', { approved: true, evidenceDigest: hex('a') }, withBody.fetchImpl)).toEqual({ conflict: serverMessage });
    const withoutBody = mockFetch(() => ({ ok: false, status: 409, statusText: 'Conflict', json: async () => { throw new Error('no body'); } }) as unknown as Response);
    expect(await postDecision('run-1', { approved: true, evidenceDigest: hex('a') }, withoutBody.fetchImpl)).toEqual({ conflict: EVIDENCE_CHANGED_MESSAGE });
  });

  it('other errors behave as today: the message is thrown, with no conflict and no refetch', async () => {
    const api = mockFetch(call => call.method === 'GET' ? reply(200, checkpoint()) : reply(400, { error: 'evidenceDigest must be a 64-character hex string' }));
    const store = new DecisionDigestStore(api.fetchImpl);
    store.sync(identity());
    await flush();
    await expect(store.decide(digest => postDecision('run-1', { approved: true, evidenceDigest: digest }, api.fetchImpl)))
      .rejects.toThrow('evidenceDigest must be a 64-character hex string');
    await flush();
    expect(snap(store)).toMatchObject({ status: 'ready', conflict: undefined });
    expect(api.gets()).toHaveLength(1);
  });
});
