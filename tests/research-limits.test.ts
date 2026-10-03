import { describe, expect, it } from 'vitest';
import { boundedUtf8 } from '../src/controller.js';
import { defaultRunResearchBudget, getResearchLimits } from '../src/research-limits.js';

describe('public research and handoff limits', () => {
  it('keeps the approved network and prompt defaults explicit', () => {
    const limits = getResearchLimits({});
    expect(limits.network).toMatchObject({
      defaultRequestsPerRun: 24,
      maximumRequestsPerRun: 128,
      defaultRequestsPerBatch: 6,
      maximumRequestsPerBatch: 6,
      maxResponseBytes: 8 * 1024 * 1024,
      maximumResponseBytes: 64 * 1024 * 1024,
      defaultTotalResponseBytes: 64 * 1024 * 1024,
      maximumTotalResponseBytes: 1024 * 1024 * 1024,
      defaultExcerptBytes: 16 * 1024,
      maximumExcerptBytes: 64 * 1024,
      timeoutMs: 15_000,
      maximumTimeoutMs: 60_000,
    });
    expect(limits.handoff).toMatchObject({
      promptBytes: 128 * 1024,
      workerResearchBytes: 96 * 1024,
      reviewPackageBytes: 1024 * 1024,
      reviewDiffBytes: 256 * 1024,
      apiBodyBytes: 4 * 1024 * 1024,
      cliOutputBytes: 512 * 1024,
    });
    expect(defaultRunResearchBudget({})).toMatchObject({
      maxRequests: 24,
      maxBatchSize: 6,
      maxResponseBytes: 8 * 1024 * 1024,
      maxTotalResponseBytes: 64 * 1024 * 1024,
      maxExcerptBytes: 16 * 1024,
      timeoutMs: 15_000,
    });
  });

  it('reads overrides at call time so values loaded after module import take effect', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(getResearchLimits(env).network.defaultRequestsPerRun).toBe(24);
    env.FOREMAN_RESEARCH_REQUESTS = '31';
    env.FOREMAN_RESEARCH_BATCH = '5';
    env.FOREMAN_RESEARCH_RESPONSE_BYTES = String(12 * 1024 * 1024);
    env.FOREMAN_RESEARCH_BYTES = String(96 * 1024 * 1024);
    env.FOREMAN_RESEARCH_EXCERPT_BYTES = String(32 * 1024);
    env.FOREMAN_RESEARCH_TIMEOUT_MS = '25000';
    env.FOREMAN_PROMPT_BYTES = String(256 * 1024);
    env.FOREMAN_WORKER_RESEARCH_BYTES = String(192 * 1024);
    const changed = getResearchLimits(env);
    expect(changed.network).toMatchObject({ defaultRequestsPerRun: 31, defaultRequestsPerBatch: 5, maxResponseBytes: 12 * 1024 * 1024, defaultTotalResponseBytes: 96 * 1024 * 1024, defaultExcerptBytes: 32 * 1024, timeoutMs: 25_000 });
    expect(changed.handoff).toMatchObject({ promptBytes: 256 * 1024, workerResearchBytes: 192 * 1024 });
  });

  it('rejects non-integer, out-of-range, and cross-limit research budgets', () => {
    for (const [key, value] of [
      ['FOREMAN_RESEARCH_REQUESTS', '1.5'],
      ['FOREMAN_RESEARCH_REQUESTS', '129'],
      ['FOREMAN_RESEARCH_BATCH', '7'],
      ['FOREMAN_RESEARCH_RESPONSE_BYTES', String(64 * 1024 * 1024 + 1)],
      ['FOREMAN_RESEARCH_BYTES', String(1024 * 1024 - 1)],
      ['FOREMAN_RESEARCH_EXCERPT_BYTES', String(64 * 1024 + 1)],
      ['FOREMAN_RESEARCH_TIMEOUT_MS', '60001'],
      ['FOREMAN_PROMPT_BYTES', '15999'],
    ] as const) {
      expect(() => getResearchLimits({ [key]: value })).toThrow(new RegExp(key));
    }
    expect(() => defaultRunResearchBudget({ maxResponseBytes: 8 * 1024 * 1024, maxTotalResponseBytes: 4 * 1024 * 1024 })).toThrow(/cannot exceed/);
    expect(() => defaultRunResearchBudget({ maxRequests: 129 })).toThrow(/maxRequests/);
  });

  it('truncates only at complete UTF-8 character boundaries', () => {
    const euroAndEmoji = 'A€😀Z';
    const expected: Array<[number, string]> = [
      [0, ''], [1, 'A'], [2, 'A'], [3, 'A'], [4, 'A€'], [5, 'A€'], [6, 'A€'], [7, 'A€'], [8, 'A€😀'], [9, euroAndEmoji], [20, euroAndEmoji],
    ];
    for (const [limit, prefix] of expected) {
      const actual = boundedUtf8(euroAndEmoji, limit);
      expect(actual).toBe(prefix);
      expect(Buffer.byteLength(actual, 'utf8')).toBeLessThanOrEqual(limit);
      expect(Buffer.from(actual, 'utf8').toString('utf8')).toBe(actual);
    }
    expect(boundedUtf8('ASCII text', 5)).toBe('ASCII');
    expect(boundedUtf8('😀a€z', 4)).toBe('😀');
    expect(boundedUtf8('😀a€z', 5)).toBe('😀a');
    expect(boundedUtf8('😀a€z', 7)).toBe('😀a');
    expect(boundedUtf8('😀a€z', 8)).toBe('😀a€');
  });
});
