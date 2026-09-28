/**
 * Local bridge health for the open project: a compact badge (only when the bridge is not ready),
 * an inline notice with restart detail, and the poller that keeps it fresh while unhealthy.
 */
import React from 'react';
import { Badge, type Tone } from './badge.js';

/** Mirrors `LocalBridgeHealth` / `bridgeStatus` from the backend workspace-setup response. */
export type BridgeState = 'ready' | 'restarting' | 'unavailable';
export interface BridgeHealth {
  state: BridgeState;
  logPath?: string;
  lastExit?: { code: number | null; signal: string | null; at: string; uptimeMs: number; reason?: string };
  restarts: number;
  nextRestartAt?: string;
  restartDelayMs?: number;
  message?: string;
}

export const BRIDGE_POLL_MS = 5000;
export const BRIDGE_IDLE_POLL_MS = 30000;

const TONE: Record<'restarting' | 'unavailable', Tone> = { restarting: 'warning', unavailable: 'failed' };
const LABEL: Record<'restarting' | 'unavailable', string> = { restarting: 'Restarting', unavailable: 'Unavailable' };

export const bridgeNeedsAttention = (status?: string): status is 'restarting' | 'unavailable' => status === 'restarting' || status === 'unavailable';

/** Whole seconds until `iso`, or undefined when absent or unparseable. Never negative. */
export function secondsUntil(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : undefined;
}

/**
 * Polls `refetch` for as long as it is not stopped: every `attentionMs` while the bridge needs attention, every `idleMs`
 * otherwise (the endpoint runs git, so a healthy bridge is polled slowly). Ticks are skipped while the tab is hidden.
 * `sync` is idempotent and switches rate without stacking timers; `stop` clears everything.
 */
export function createBridgePoller(refetch: () => void, attentionMs = BRIDGE_POLL_MS, idleMs = BRIDGE_IDLE_POLL_MS) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let rate: number | undefined;
  const stop = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; rate = undefined; } };
  const sync = (status?: string) => {
    const next = bridgeNeedsAttention(status) ? attentionMs : idleMs;
    if (timer !== undefined && rate === next) return;
    stop();
    rate = next;
    timer = setInterval(() => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return; refetch(); }, next);
  };
  return { sync, stop, isActive: () => timer !== undefined };
}

/** Header badge. Renders nothing when the bridge is ready or unknown, like the other healthy states. */
export function BridgeBadge({ status }: { status?: string }): React.ReactElement | null {
  if (!bridgeNeedsAttention(status)) return null;
  return <Badge tone={TONE[status]} className="bridge-badge" title={`Local bridge: ${LABEL[status].toLowerCase()}`}>Bridge<span className="bridge-word"> · {LABEL[status]}</span></Badge>;
}

export function BridgeNotice({ status, health, now = Date.now(), onReopen, onCopy, disabled }: { status?: string; health?: BridgeHealth; now?: number; onReopen?: () => void; onCopy?: (text: string) => void; disabled?: boolean }): React.ReactElement | null {
  if (!bridgeNeedsAttention(status)) return null;
  const wait = status === 'restarting' ? secondsUntil(health?.nextRestartAt, now) : undefined;
  const message = health?.message ?? (status === 'restarting' ? 'The local bridge stopped and is being restarted.' : 'The local bridge is not running.');
  const restarts = health ? `${health.restarts} ${health.restarts === 1 ? 'restart' : 'restarts'}` : '';
  const next = wait !== undefined ? `next restart in ${wait}s` : '';
  return (
    <div className={`bridge-notice bridge-${status}`} role="status" aria-label="Local bridge status">
      <b>Local bridge {LABEL[status].toLowerCase()}</b>
      <span>{message}</span>
      {(restarts || next) && <span className="bridge-meta">{[restarts, next].filter(Boolean).join(' · ')}</span>}
      {health?.logPath && <span className="bridge-log"><code>{health.logPath}</code>{onCopy && <button type="button" className="outline small" onClick={() => onCopy(health.logPath!)}>Copy</button>}</span>}
      {status === 'unavailable' && <span className="bridge-reopen">Reopening the repository starts a fresh bridge.{onReopen && <button type="button" className="outline small" onClick={onReopen} disabled={disabled}>Reopen repository</button>}</span>}
    </div>
  );
}
