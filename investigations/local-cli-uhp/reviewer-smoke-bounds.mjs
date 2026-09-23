export const REVIEWER_TASK_BOUNDS = Object.freeze({ maxStep: 2, timeoutSeconds: 90 });
export const REVIEWER_STREAM_INACTIVITY_TIMEOUT_MS = 100_000;
export const REVIEWER_BRIDGE_MAX_STEP = 10;
export const REVIEWER_BRIDGE_MAX_TIMEOUT_SECONDS = 120;

export function isPrepareOnly(value) { return value === '1'; }

export function assertReviewerBounds(bounds, inactivityTimeoutMs = REVIEWER_STREAM_INACTIVITY_TIMEOUT_MS) {
  if (!Number.isInteger(bounds?.maxStep) || bounds.maxStep < 1 || bounds.maxStep > REVIEWER_BRIDGE_MAX_STEP) throw new Error('Reviewer maxStep exceeds the local UHP bridge limit');
  if (!Number.isInteger(bounds?.timeoutSeconds) || bounds.timeoutSeconds < 1 || bounds.timeoutSeconds > REVIEWER_BRIDGE_MAX_TIMEOUT_SECONDS) throw new Error('Reviewer timeoutSeconds exceeds the local UHP bridge limit');
  if (!Number.isInteger(inactivityTimeoutMs) || inactivityTimeoutMs <= bounds.timeoutSeconds * 1000) throw new Error('UHP stream inactivity timeout must exceed the Reviewer task timeout');
  return true;
}
