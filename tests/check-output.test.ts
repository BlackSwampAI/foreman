import { describe, expect, it } from 'vitest';
import { summarizeCheckOutput } from '../ui/check-output.js';

// Realistic vitest output with ANSI escape codes
const ESC = '\u001b';
const vitestSample = [
  `${ESC}[31mFAIL${ESC}[0m tests/declarative-routing.test.ts > routing hooks > rejects unsupported controlled values`,
  ``,
  `${ESC}[31mAssertionError${ESC}[0m: expected 'error' to deeply equal 'ok'`,
  `${ESC}[32m- Expected:  "ok"${ESC}[0m`,
  `${ESC}[31m+ Received:  "error"${ESC}[0m`,
  ``,
  ` ${ESC}[2m❯${ESC}[0m tests/declarative-routing.test.ts:42:5`,
  ` ${ESC}[2m❯${ESC}[0m tests/declarative-routing.test.ts:10:1`,
].join('\n');

describe('summarizeCheckOutput',()=>{
  it('extracts the failing test identifier from vitest FAIL output',()=>{
    const result=summarizeCheckOutput(vitestSample);
    expect(result.testNames).toContain('tests/declarative-routing.test.ts > routing hooks > rejects unsupported controlled values');
  });
  it('extracts the AssertionError summary line',()=>{
    const result=summarizeCheckOutput(vitestSample);
    expect(result.summaryLines.some(l=>l.includes('AssertionError'))).toBe(true);
  });
  it('strips ANSI codes from fullOutput',()=>{
    const result=summarizeCheckOutput(vitestSample);
    expect(result.fullOutput).not.toContain('\u001b[');
    expect(result.fullOutput).toContain('rejects unsupported controlled values');
  });
  it('falls back to first non-empty lines for generic non-test output',()=>{
    const generic='Some process failed\nReason: file not found\nPlease check your config';
    const result=summarizeCheckOutput(generic);
    expect(result.testNames).toHaveLength(0);
    expect(result.summaryLines).toContain('Some process failed');
    expect(result.summaryLines).toContain('Reason: file not found');
  });
  it('returns empty arrays for empty input',()=>{
    const result=summarizeCheckOutput('');
    expect(result.testNames).toHaveLength(0);
    expect(result.summaryLines).toHaveLength(0);
    expect(result.fullOutput).toBe('');
  });
  it('does not duplicate identical lines',()=>{
    const dupe=`${ESC}[31mAssertionError${ESC}[0m: expected 1 to equal 2\n${ESC}[31mAssertionError${ESC}[0m: expected 1 to equal 2`;
    const result=summarizeCheckOutput(dupe);
    const count=result.summaryLines.filter(l=>l.includes('AssertionError')).length;
    expect(count).toBe(1);
  });
});
