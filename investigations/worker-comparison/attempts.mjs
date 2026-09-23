export function parseAttemptCount(value = '1') {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('FOREMAN_WORKER_COMPARISON_ATTEMPTS must be an integer from 1 to 10');
  return count;
}

export function attemptIdFor(index) {
  if (!Number.isInteger(index) || index < 1 || index > 10) throw new Error('Attempt index must be from 1 to 10');
  return `attempt-${String(index).padStart(3, '0')}`;
}

export function parseAttemptId(value, count) {
  const match = /^attempt-(\d{3})$/.exec(value ?? '');
  const index = match ? Number(match[1]) : 0;
  if (!index || index > count) throw new Error(`Attempt ID must be between attempt-001 and ${attemptIdFor(count)}`);
  return value;
}

export function parseComparisonTimeoutSeconds(value = '110') {
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 110) throw new Error('FOREMAN_WORKER_COMPARISON_TIMEOUT_SECONDS must be an integer from 1 to 110');
  return timeout;
}

export function comparisonClientTimeouts(timeoutSeconds) {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 110) throw new Error('Comparison timeout must be an integer from 1 to 110 seconds');
  // UhpClient currently caps the full response-stream inactivity deadline at 120s.
  // Reserve ten seconds beyond the CLI bound for bridge finalization, within its cap.
  return { timeoutMs: 120_000, streamInactivityTimeoutMs: Math.max(45_000, (timeoutSeconds + 10) * 1000) };
}
