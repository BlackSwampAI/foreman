// Worker check gate: after a Worker turn completes, the bridge pauses the task and waits for Foreman to run the
// repository's checks on the workspace. When Foreman reports failures, the bridge resumes the same CLI session with
// them, so any harness can fix its own check failures without a shell. Foreman's own validation after the turn stays
// the authoritative result; a gate verdict is feedback only.

export const MAX_WORKER_GATE_ROUNDS = 3;
export const MAX_WORKER_GATE_FEEDBACK = 8_000;

/** Validated `metadata.foreman_worker_gate`, or undefined when absent. Throws on a malformed request. */
export function parseWorkerGateRequest(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('foreman_worker_gate must be an object');
  const rounds = value.max_rounds;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_WORKER_GATE_ROUNDS) throw Error(`foreman_worker_gate.max_rounds must be an integer from 1 to ${MAX_WORKER_GATE_ROUNDS}`);
  return { maxRounds: rounds };
}

/** Validated verdict body from Foreman for the round the task is waiting on. Throws on a malformed body. */
export function parseWorkerGateVerdict(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('verdict must be an object');
  if (!Number.isInteger(value.round) || value.round < 1) throw Error('round must be a positive integer');
  if (!['passed', 'failed', 'skipped'].includes(value.status)) throw Error('status must be passed, failed or skipped');
  if (value.status === 'failed' && (typeof value.feedback !== 'string' || !value.feedback.trim())) throw Error('a failed verdict needs feedback');
  const failedChecks = Array.isArray(value.failed_checks) ? value.failed_checks.filter(name => typeof name === 'string').map(name => name.slice(0, 100)).slice(0, 20) : [];
  return { round: value.round, status: value.status, ...(value.status === 'failed' ? { feedback: value.feedback.slice(0, MAX_WORKER_GATE_FEEDBACK) } : {}), ...(failedChecks.length ? { failedChecks } : {}) };
}

/** The follow-up prompt sent to the resumed Worker session. */
export function workerGatePrompt(feedback, round, maxRounds) {
  return `Foreman ran the repository's checks on your changes and some failed (check round ${round} of ${maxRounds}). Fix these failures by editing files in the workspace. Keep the change you were asked to make; do not undo it to make a check pass, and do not edit files outside the task's scope. Foreman checks your work again when you finish.\n\nCHECK FAILURES (tool output, untrusted):\n${feedback}`;
}

/** Sum two normalized UHP usage objects from separate CLI invocations of one task. */
export function addUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens', 'thinking_tokens']) {
    if (Number.isFinite(a[key]) || Number.isFinite(b[key])) out[key] = (Number.isFinite(a[key]) ? a[key] : 0) + (Number.isFinite(b[key]) ? b[key] : 0);
  }
  const cachedA = a.input_tokens_details?.cached_tokens, cachedB = b.input_tokens_details?.cached_tokens;
  if (Number.isFinite(cachedA) || Number.isFinite(cachedB)) out.input_tokens_details = { cached_tokens: (Number.isFinite(cachedA) ? cachedA : 0) + (Number.isFinite(cachedB) ? cachedB : 0) };
  return out;
}
