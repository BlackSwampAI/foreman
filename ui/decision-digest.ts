/**
 * Evidence digest binding for the human Approve/Reject decision.
 *
 * The operator's decision must be bound to the evidence they actually looked
 * at. When the decision panel shows a decidable run it fetches
 * `GET /api/runs/:id/decision` (keyed on the evidence identity: Worker
 * response, validation, Reviewer recommendation, controller inactive) and every
 * Approve/Reject click sends that digest back. The digest is never fetched at
 * click time.
 *
 * Everything except `useDecisionDigest` is framework-agnostic so it can be unit
 * tested with a mocked `fetch` and no DOM.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

/** What the panel is showing: changes exactly when the reviewed evidence changes. */
export interface EvidenceIdentity {
  runId: string;
  /** `run.workerEvidence.responseId` */
  workerResponseId?: string;
  /** `run.validation.id` */
  validationId?: string;
  /** `run.reviewerRecommendation.id` */
  recommendationId?: string;
  /** A run whose controller is active is not at a decision checkpoint. */
  controllerActive: boolean;
}

/** Body of `GET /api/runs/:id/decision`. */
export interface DecisionDigest {
  runId: string;
  evidenceDigest: string;
  pinnedBaseCommit: string;
  workerResponseId: string;
  validationId: string;
  recommendationId: string;
}

export type DigestStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface DecisionSnapshot {
  status: DigestStatus;
  /** Evidence key the status/digest/error belongs to; undefined while idle. */
  key?: string;
  digest?: DecisionDigest;
  error?: string;
  /** Server message from the last 409; kept until the operator decides again. */
  conflict?: string;
}

/** Result of submitting a decision: `conflict` is set when the server answered 409. */
export interface DecisionOutcome { conflict?: string }

export const EVIDENCE_CHANGED_MESSAGE = 'The evidence changed since you reviewed it; refresh and review the current result before deciding.';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/i;

/** Key for the fetch, or undefined when the run is not at a decision checkpoint. */
export function decisionKey(identity: EvidenceIdentity | undefined): string | undefined {
  if (!identity || identity.controllerActive) return undefined;
  return JSON.stringify([identity.runId, identity.workerResponseId ?? null, identity.validationId ?? null, identity.recommendationId ?? null, 'controller-inactive']);
}

async function errorDetail(response: Response): Promise<string> {
  let detail = `${response.status} ${response.statusText}`.trim();
  try {
    const body = await response.json() as { error?: string; message?: string };
    detail = body.error ?? body.message ?? detail;
  } catch { /* Keep the HTTP status when the response has no JSON error. */ }
  return detail;
}

function parseDigest(value: unknown): DecisionDigest {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const text = (field: string): string => {
    const item = record[field];
    if (typeof item !== 'string') throw new Error(`The server returned an incomplete decision checkpoint (missing ${field})`);
    return item;
  };
  const digest: DecisionDigest = {
    runId: text('runId'), evidenceDigest: text('evidenceDigest'), pinnedBaseCommit: text('pinnedBaseCommit'),
    workerResponseId: text('workerResponseId'), validationId: text('validationId'), recommendationId: text('recommendationId'),
  };
  if (!DIGEST_PATTERN.test(digest.evidenceDigest)) throw new Error('The server returned a malformed evidence digest');
  return digest;
}

/**
 * A digest issued for evidence other than what the panel is showing (the server
 * moved on before the view refreshed) must not enable the buttons.
 */
function assertMatchesIdentity(digest: DecisionDigest, identity: EvidenceIdentity): void {
  const mismatch = digest.runId !== identity.runId
    || (identity.workerResponseId !== undefined && digest.workerResponseId !== identity.workerResponseId)
    || (identity.validationId !== undefined && digest.validationId !== identity.validationId)
    || (identity.recommendationId !== undefined && digest.recommendationId !== identity.recommendationId);
  if (mismatch) throw new Error('The result on the server no longer matches what is on screen; wait for the view to refresh, then retry');
}

/** Holds the digest for the evidence currently shown. Compatible with `useSyncExternalStore`. */
export class DecisionDigestStore {
  private snapshot: DecisionSnapshot = { status: 'idle' };
  private identity: EvidenceIdentity | undefined;
  private readonly listeners = new Set<() => void>();
  /** Bumped on every load and on dispose: only the newest request may write. */
  private generation = 0;
  private deciding = false;

  constructor(private readonly fetchImpl?: FetchLike) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): DecisionSnapshot => this.snapshot;

  /**
   * Point the store at the evidence the panel is showing. Fetches when the
   * evidence key changes; the same key (an unrelated re-render) is a no-op.
   */
  sync(identity: EvidenceIdentity | undefined): void {
    const key = decisionKey(identity);
    const conflict = identity && this.identity?.runId === identity.runId ? this.snapshot.conflict : undefined;
    this.identity = identity;
    if (key !== undefined && key === this.snapshot.key) return;
    if (key === undefined) {
      this.generation += 1;
      if (this.snapshot.status !== 'idle' || this.snapshot.conflict !== conflict) this.set({ status: 'idle', conflict });
      return;
    }
    this.load(identity as EvidenceIdentity, key, conflict);
  }

  /** Refetch the digest for the current evidence (the Retry button). */
  retry(): void {
    const key = decisionKey(this.identity);
    if (key !== undefined && this.identity) this.load(this.identity, key, this.snapshot.conflict);
  }

  /** The server rejected the digest as stale: show its message and fetch a fresh digest. */
  reportConflict(message: string): void {
    const key = decisionKey(this.identity);
    if (key !== undefined && this.identity) this.load(this.identity, key, message);
    else this.set({ status: 'idle', conflict: message });
  }

  /**
   * Submit a decision with the digest the operator was looking at. Never
   * fetches at click time, and does nothing unless a digest is ready.
   */
  async decide(submit: (evidenceDigest: string) => Promise<DecisionOutcome | void> | void): Promise<void> {
    const { status, digest } = this.snapshot;
    if (this.deciding || status !== 'ready' || !digest) return;
    this.deciding = true;
    if (this.snapshot.conflict) this.set({ ...this.snapshot, conflict: undefined });
    try {
      const outcome = await submit(digest.evidenceDigest);
      if (outcome?.conflict) this.reportConflict(outcome.conflict);
    } finally {
      this.deciding = false;
    }
  }

  /** Drop in-flight work (unmount). A later sync fetches again. */
  dispose(): void {
    this.generation += 1;
    this.identity = undefined;
    this.snapshot = { status: 'idle' };
  }

  private set(next: DecisionSnapshot): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }

  private load(identity: EvidenceIdentity, key: string, conflict: string | undefined): void {
    const generation = ++this.generation;
    this.set({ status: 'loading', key, conflict });
    const finish = (next: Omit<DecisionSnapshot, 'key' | 'conflict'>) => {
      // A newer key, retry or dispose superseded this request: drop it.
      if (generation !== this.generation) return;
      this.set({ ...next, key, conflict: this.snapshot.conflict });
    };
    const doFetch: FetchLike = this.fetchImpl ?? ((input, init) => fetch(input, init));
    void (async () => {
      try {
        const response = await doFetch(`/api/runs/${encodeURIComponent(identity.runId)}/decision`, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(await errorDetail(response));
        const digest = parseDigest(await response.json());
        assertMatchesIdentity(digest, identity);
        finish({ status: 'ready', digest });
      } catch (e) {
        finish({ status: 'error', error: e instanceof Error ? e.message : 'Could not load the evidence digest' });
      }
    })();
  }
}

/** What the panel renders: a snapshot re-keyed to the evidence being shown right now. */
export interface DigestViewState {
  status: DigestStatus;
  digest?: DecisionDigest;
  error?: string;
  conflict?: string;
}

export interface DecisionDigestView extends DigestViewState {
  retry: () => void;
  decide: (submit: (evidenceDigest: string) => Promise<DecisionOutcome | void> | void) => Promise<void>;
}

/**
 * A snapshot for a different key is never shown: the first render after the
 * evidence changes reads as loading, not as the old digest on new evidence.
 */
export function deriveDigestView(snapshot: DecisionSnapshot, key: string | undefined): DigestViewState {
  if (key === undefined) return { status: 'idle', conflict: snapshot.conflict };
  if (snapshot.key !== key) return { status: 'loading', conflict: snapshot.conflict };
  return { status: snapshot.status, digest: snapshot.digest, error: snapshot.error, conflict: snapshot.conflict };
}

/** Fetch on render, keyed on the evidence identity. Pass undefined when the run is not decidable. */
export function useDecisionDigest(identity: EvidenceIdentity | undefined): DecisionDigestView {
  const [store] = useState(() => new DecisionDigestStore());
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const key = decisionKey(identity);
  useEffect(() => { store.sync(identity); }, [store, key]);
  useEffect(() => () => store.dispose(), [store]);
  return useMemo(() => ({
    ...deriveDigestView(snapshot, key),
    retry: () => store.retry(),
    decide: (submit) => store.decide(submit),
  }), [store, snapshot, key]);
}

/**
 * `POST /api/runs/:id/approve` with the reviewed digest. Resolves `{}` on
 * success, `{ conflict }` on a 409 (evidence changed), and throws the server's
 * message for any other failure.
 */
export async function postDecision(
  runId: string,
  decision: { approved: boolean; evidenceDigest: string; rationale?: string },
  fetchImpl?: FetchLike,
): Promise<DecisionOutcome> {
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  const response = await doFetch(`/api/runs/${encodeURIComponent(runId)}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(decision),
  });
  if (response.status === 409) {
    let message = EVIDENCE_CHANGED_MESSAGE;
    try { const body = await response.json() as { error?: string }; if (body.error) message = body.error; } catch { /* Fall back to the standard message. */ }
    return { conflict: message };
  }
  if (!response.ok) throw new Error(await errorDetail(response));
  return {};
}
