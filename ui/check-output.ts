/** Strip ANSI escape codes from raw terminal output. */
function stripAnsi(text: string): string {
  return text.replace(/\u001b(?:\[[0-9;]*[mGKHFJA-Za-z]|\][^\u0007]*\u0007|[PX^_][^\u001b]*\u001b\\)/g, '');
}

export interface CheckOutputSummary {
  /** Failing test identifiers extracted from vitest/jest output (path > suite > test). */
  testNames: string[];
  /** Key assertion, error, and file-ref lines extracted from the output. */
  summaryLines: string[];
  /** Full output with ANSI codes stripped. */
  fullOutput: string;
}

/**
 * Summarize failing check output for compact display. Strips ANSI codes, extracts
 * vitest/jest failing test identifiers, assertion lines, and ❯ file:line:col references.
 * Falls back to the first few non-empty lines for non-test-framework output.
 */
export function summarizeCheckOutput(details: string): CheckOutputSummary {
  const fullOutput = stripAnsi(details);
  const lines = fullOutput.split('\n');
  const testNames: string[] = [];
  const summaryLines: string[] = [];
  const seen = new Set<string>();

  const addLine = (text: string) => {
    const t = text.trim().slice(0, 220);
    if (t && !seen.has(t)) { seen.add(t); summaryLines.push(t); }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    // vitest/jest: FAIL tests/path.ts > suite > test
    const failFileMatch = trimmed.match(/^(?:FAIL|×|✕)\s+([\w./\\-][\w./\\-]* *>.*)/);
    if (failFileMatch) {
      const name = failFileMatch[1]!.trim();
      if (!testNames.includes(name)) testNames.push(name);
      continue;
    }
    // AssertionError / Error: ...
    if (/^(?:AssertionError|Error):/.test(trimmed)) { addLine(trimmed); continue; }
    // Expected / Received diff lines
    if (/^(?:[-+] )?(Expected|Received)\b/.test(trimmed)) { addLine(trimmed); continue; }
    // ❯ file:line:col references
    if (/^❯\s+\S+:\d+:\d+/.test(trimmed)) { addLine(trimmed); continue; }
  }

  // Generic fallback: first few non-empty lines when nothing was extracted
  if (!testNames.length && !summaryLines.length) {
    for (const line of lines) {
      const t = line.trim();
      if (t && summaryLines.length < 5) summaryLines.push(t.slice(0, 220));
    }
  }

  return { testNames, summaryLines, fullOutput };
}

/**
 * Parse a pass/fail count summary from vitest, jest, or node:test output.
 * Returns a compact string like "17 passed · 1 failed of 18", or undefined
 * if no summary line is recognised.
 *
 * Handled formats (after ANSI stripping):
 *   vitest/jest: "Tests  1 failed | 17 passed (18)"
 *   vitest/jest: "Tests  17 passed (17)"
 *   vitest/jest: "Test Files  2 passed (2)"
 *   node:test:   lines containing "# pass N" / "# fail N"
 */
export function parseChecksSummary(output: string): string | undefined {
  const clean = stripAnsi(output);

  // vitest / jest — "Tests N failed | N passed (total)"
  // The pipe is optional; either failed or passed (or both) may be absent.
  const vitestMatch = clean.match(
    /\bTests?\s+(?:(\d+)\s+failed\b[^|]*[|]?\s*)?(?:(\d+)\s+passed\b)?\s*(?:\((\d+)\))?/m,
  );
  if (vitestMatch) {
    const failed = vitestMatch[1] !== undefined ? parseInt(vitestMatch[1]) : 0;
    const passed = vitestMatch[2] !== undefined ? parseInt(vitestMatch[2]) : 0;
    const total  = vitestMatch[3] !== undefined ? parseInt(vitestMatch[3]) : passed + failed;
    if (total > 0 || passed > 0 || failed > 0) {
      const parts: string[] = [];
      if (passed > 0) parts.push(`${passed} passed`);
      if (failed > 0) parts.push(`${failed} failed`);
      if (parts.length === 0) return undefined;
      return total > 0 ? `${parts.join(' · ')} of ${total}` : parts.join(' · ');
    }
  }

  // node:test — "# pass N" and "# fail N" on separate lines
  const nodePassMatch = clean.match(/^#\s*pass\s+(\d+)/m);
  const nodeFailMatch = clean.match(/^#\s*fail\s+(\d+)/m);
  if (nodePassMatch || nodeFailMatch) {
    const passed = nodePassMatch ? parseInt(nodePassMatch[1]!) : 0;
    const failed = nodeFailMatch ? parseInt(nodeFailMatch[1]!) : 0;
    const total  = passed + failed;
    const parts: string[] = [];
    if (passed > 0) parts.push(`${passed} passed`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (parts.length === 0) return undefined;
    return total > 0 ? `${parts.join(' · ')} of ${total}` : parts.join(' · ');
  }

  return undefined;
}
