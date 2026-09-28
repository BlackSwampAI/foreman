import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, type State } from '../ui/main.js';
import { BridgeBadge, BridgeNotice, BRIDGE_POLL_MS, BRIDGE_IDLE_POLL_MS, createBridgePoller, secondsUntil, type BridgeHealth } from '../ui/bridge-status.js';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const restarting: BridgeHealth = { state: 'restarting', restarts: 2, nextRestartAt: '2026-09-28T12:00:07.200Z', restartDelayMs: 8000, logPath: '/data/local-bridge/prj.log', message: 'Bridge exited with code 1; restarting.' };
const unavailable: BridgeHealth = { state: 'unavailable', restarts: 5, logPath: '/data/local-bridge/prj.log', message: 'Bridge kept crashing; giving up.' };

describe('bridge status rendering', () => {
  it('renders nothing when ready or unknown', () => {
    expect(renderToStaticMarkup(createElement(BridgeBadge, { status: 'ready' }))).toBe('');
    expect(renderToStaticMarkup(createElement(BridgeBadge, {}))).toBe('');
    expect(renderToStaticMarkup(createElement(BridgeNotice, { status: 'ready', health: { state: 'ready', restarts: 0 } }))).toBe('');
  });
  it('shows a warning badge and notice with restart detail while restarting', () => {
    expect(renderToStaticMarkup(createElement(BridgeBadge, { status: 'restarting' }))).toContain('tone-warning');
    const html = renderToStaticMarkup(createElement(BridgeNotice, { status: 'restarting', health: restarting, now: NOW, onCopy: () => {}, onReopen: () => {} }));
    expect(html).toContain('Bridge exited with code 1; restarting.');
    expect(html).toContain('2 restarts');
    expect(html).toContain('next restart in 8s');
    expect(html).toContain('<code>/data/local-bridge/prj.log</code>');
    expect(html).toContain('>Copy</button>');
    expect(html).not.toContain('fresh bridge');
    expect(html).not.toContain('Reopen repository');
  });
  it('shows a danger badge, reopen guidance and action when unavailable', () => {
    expect(renderToStaticMarkup(createElement(BridgeBadge, { status: 'unavailable' }))).toContain('tone-failed');
    const html = renderToStaticMarkup(createElement(BridgeNotice, { status: 'unavailable', health: unavailable, now: NOW, onReopen: () => {} }));
    expect(html).toContain('Bridge kept crashing; giving up.');
    expect(html).toContain('5 restarts');
    expect(html).not.toContain('next restart');
    expect(html).toContain('Reopening the repository starts a fresh bridge.');
    expect(html).toContain('>Reopen repository</button>');
  });
  it('falls back to a default message and clamps the countdown', () => {
    expect(renderToStaticMarkup(createElement(BridgeNotice, { status: 'unavailable' }))).toContain('The local bridge is not running.');
    expect(secondsUntil('2026-09-28T11:59:00.000Z', NOW)).toBe(0);
    expect(secondsUntil(undefined, NOW)).toBeUndefined();
    expect(secondsUntil('nope', NOW)).toBeUndefined();
  });
  it('integrates into the project header only when the bridge is unhealthy', () => {
    const state: State = { projects: [{ id: 'prj_b', name: 'Bridge project', repoPath: '/repo/b', tasks: [] }], roles: [] };
    const base = { repoPath: '/repo/b', head: 'a'.repeat(40), dirty: false, allowedScope: [], validationCommands: [] };
    const healthy = renderToStaticMarkup(createElement(App, { initialState: state, initialWorkspaceSetup: { ...base, bridgeStatus: 'ready' } }));
    expect(healthy).not.toContain('bridge-badge');
    expect(healthy).not.toContain('bridge-notice');
    const down = renderToStaticMarkup(createElement(App, { initialState: state, initialWorkspaceSetup: { ...base, bridgeStatus: 'unavailable', bridgeHealth: unavailable } }));
    expect(down).toContain('Bridge<span class="bridge-word"> · Unavailable');
    expect(down).toContain('Reopening the repository starts a fresh bridge.');
    expect(down).toContain('/data/local-bridge/prj.log');
  });
});

describe('bridge health poller', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('polls every 30 s while ready or unknown', () => {
    const fn = vi.fn(); const p = createBridgePoller(fn);
    p.sync('ready'); p.sync(undefined);
    vi.advanceTimersByTime(BRIDGE_IDLE_POLL_MS - 1); expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(BRIDGE_IDLE_POLL_MS); expect(fn).toHaveBeenCalledTimes(2);
    p.stop();
  });
  it('polls every 5 s while restarting or unavailable', () => {
    const fn = vi.fn(); const p = createBridgePoller(fn);
    p.sync('restarting');
    vi.advanceTimersByTime(BRIDGE_POLL_MS); expect(fn).toHaveBeenCalledTimes(1);
    p.sync('unavailable');
    vi.advanceTimersByTime(BRIDGE_POLL_MS); expect(fn).toHaveBeenCalledTimes(2);
    p.stop();
  });
  it('switches rates without stacking timers', () => {
    const fn = vi.fn(); const p = createBridgePoller(fn);
    p.sync('ready'); p.sync('ready'); expect(vi.getTimerCount()).toBe(1);
    p.sync('restarting'); p.sync('restarting'); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(BRIDGE_POLL_MS * 2); expect(fn).toHaveBeenCalledTimes(2);
    p.sync('ready'); expect(vi.getTimerCount()).toBe(1);
    fn.mockClear();
    vi.advanceTimersByTime(BRIDGE_IDLE_POLL_MS - 1); expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(fn).toHaveBeenCalledTimes(1);
    p.stop();
  });
  it('skips ticks while the tab is hidden and resumes when visible', () => {
    const doc = { visibilityState: 'hidden' };
    vi.stubGlobal('document', doc);
    const fn = vi.fn(); const p = createBridgePoller(fn);
    p.sync('restarting');
    vi.advanceTimersByTime(BRIDGE_POLL_MS * 3); expect(fn).not.toHaveBeenCalled();
    doc.visibilityState = 'visible';
    vi.advanceTimersByTime(BRIDGE_POLL_MS); expect(fn).toHaveBeenCalledTimes(1);
    p.stop();
  });
  it('leaves nothing behind after stop', () => {
    const fn = vi.fn(); const p = createBridgePoller(fn);
    p.sync('restarting'); p.stop(); p.stop();
    expect(p.isActive()).toBe(false); expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(BRIDGE_IDLE_POLL_MS * 2); expect(fn).not.toHaveBeenCalled();
  });
});
