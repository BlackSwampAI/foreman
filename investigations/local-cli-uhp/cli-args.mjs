/** Build claude-code CLI args for a standard worker, reviewer, or persistent-context (planner/orchestrator) turn. */
export function claudeCodeCliArgs(model, { reviewer = false, sessionId, persistentContext = false, maxStep = 10 } = {}) {
  if (reviewer) return ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--max-turns', String(Math.min(maxStep, 2)), '--safe-mode', '--restricted', '--strict-mcp-config', '--permission-mode', 'plan', '--tools', ''];
  return ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--max-turns', String(Math.min(maxStep, 10)), '--restricted', '--strict-mcp-config', '--permission-mode', persistentContext ? 'plan' : 'acceptEdits', '--tools', persistentContext ? 'Read,Grep,Glob' : 'Read,Edit,Write', ...(sessionId ? ['--resume', sessionId] : [])];
}

/** `keepSession` keeps a Worker's session on disk (no --ephemeral) so a Worker check round can resume it. */
export function codexCliArgs(model, { reviewer = false, sessionId, persistentContext = false, keepSession = false } = {}) {
  // --sandbox is a top-level Codex option. `codex exec resume` rejects it when
  // placed after `resume`, before any session can be reported.
  return ['--ask-for-approval', 'never', '--sandbox', reviewer || persistentContext ? 'read-only' : 'workspace-write', 'exec', ...(sessionId ? ['resume', sessionId] : []), '--json', ...(!persistentContext && !keepSession ? ['--ephemeral'] : []), '--ignore-user-config', ...(reviewer ? ['--ignore-rules'] : []), '--skip-git-repo-check', '--model', model, '-'];
}
