/**
 * Badge — the one status/tag/counter element used across the UI.
 *
 * Every pill, chip, verdict, check marker, service state and counter renders through this
 * component (`.status-pill` + one `.tone-*` class). Height, padding, radius, type and the
 * leading marker (✓ ✕ ! or a dot, drawn by CSS) are identical everywhere; only the tone differs.
 */
import React from 'react';

export type Tone = 'neutral' | 'info' | 'running' | 'passed' | 'warning' | 'failed';

/**
 * The single status → tone table. Statuses are normalised (lower-cased, `-`/`_`/space removed)
 * so `awaiting_approval`, `Awaiting Approval` and `awaitingapproval` all resolve alike.
 * Anything not listed is neutral.
 *
 * running: work is in flight            passed: finished well / verified / good
 * failed:  broken, blocked or rejected  warning: needs a human look or is not yet verified
 * info:    informational tag (roles, source, open PR)    neutral: idle, unknown, cancelled
 */
const TONE_BY_STATUS: Record<string, Tone> = {
  // running
  running: 'running', active: 'running', planning: 'running', waitingguidance: 'running', validation: 'running', review: 'running',
  submitting: 'running', submitted: 'running', promoting: 'running', inprogress: 'running', orchestrating: 'running', dispatching: 'running',
  verifying: 'running', validating: 'running', reviewing: 'running', sending: 'running',
  // passed
  completed: 'passed', approved: 'passed', promoted: 'passed', succeeded: 'passed', passed: 'passed', applied: 'passed', verified: 'passed',
  recommend: 'passed', clear: 'passed', done: 'passed', merged: 'passed', success: 'passed', clean: 'passed', online: 'passed', connected: 'passed', complete: 'passed',
  // failed
  failed: 'failed', blocked: 'failed', rejected: 'failed', reject: 'failed', requestchanges: 'failed', changesrequested: 'failed', timedout: 'failed',
  error: 'failed', degraded: 'failed', dirty: 'failed', stopped: 'failed', failure: 'failed',
  // warning
  awaitingapproval: 'warning', pending: 'warning', proposed: 'warning', unverified: 'warning', needsrevision: 'warning', unparsed: 'warning',
  reviewrequired: 'warning', unstable: 'warning', behind: 'warning', cancelrequested: 'warning',
  // info
  open: 'info',
};

export const toneForStatus = (status?: string): Tone => TONE_BY_STATUS[(status ?? '').toLowerCase().replace(/[-_ ]/g, '')] ?? 'neutral';

export function Badge({ tone = 'neutral', count, className, children, ...rest }: { tone?: Tone; count?: boolean; className?: string; children?: React.ReactNode } & Omit<React.HTMLAttributes<HTMLSpanElement>, 'className'>): React.ReactElement {
  return <span className={`status-pill tone-${tone}${count ? ' is-count' : ''}${className ? ` ${className}` : ''}`} {...rest}>{children}</span>;
}
