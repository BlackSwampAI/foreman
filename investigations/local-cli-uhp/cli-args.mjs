export function codexCliArgs(model, { reviewer = false, sessionId, persistentContext = false } = {}) {
  // --sandbox is a top-level Codex option. `codex exec resume` rejects it when
  // placed after `resume`, before any session can be reported.
  return ['--ask-for-approval', 'never', '--sandbox', reviewer || persistentContext ? 'read-only' : 'workspace-write', 'exec', ...(sessionId ? ['resume', sessionId] : []), '--json', ...(!persistentContext ? ['--ephemeral'] : []), '--ignore-user-config', ...(reviewer ? ['--ignore-rules'] : []), '--skip-git-repo-check', '--model', model, '-'];
}
