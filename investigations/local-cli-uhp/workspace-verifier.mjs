// Foreman-side verifier for the bridge-specific workspace snapshot extension.
// The bridge transports bytes; only Foreman's pinned Git comparison decides scope.
import { createHash } from 'node:crypto';
import { verifyGitSnapshotScope } from '../../dist/git-workspace.js';

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** Convert the bridge extension envelope into Foreman's exact-byte snapshot format. */
export function validateBridgeSnapshot(envelope, expectedBaseCommit) {
  if (!FULL_SHA.test(expectedBaseCommit)) throw new Error('A full pinned base commit SHA is required');
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('Workspace snapshot response must be an object');
  if (envelope.complete !== true) throw new Error('Bridge workspace snapshot is incomplete');
  if (String(envelope.base_commit ?? '').toLowerCase() !== expectedBaseCommit.toLowerCase()) throw new Error('Bridge snapshot base commit does not match the pinned base');
  if (!Array.isArray(envelope.errors) || envelope.errors.length !== 0) throw new Error('Bridge workspace snapshot contains errors or omitted its error list');
  if (!Array.isArray(envelope.entries)) throw new Error('Bridge workspace snapshot omitted its entries');
  if (envelope.entries.length > 100_000) throw new Error('Bridge workspace snapshot entry count limit exceeded');
  let totalBytes = 0;
  const entries = envelope.entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') throw new Error('Malformed workspace snapshot entry');
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)) throw new Error(`Missing exact size or SHA-256 for ${entry.path}`);
    if (entry.size > 16 * 1024 * 1024 || (totalBytes += entry.size) > 256 * 1024 * 1024) throw new Error(`Workspace snapshot size limit exceeded: ${entry.path}`);
    let kind, executable, bytes;
    if (entry.kind === 'file') {
      if (entry.mode !== '100644' && entry.mode !== '100755') throw new Error(`Unsupported regular-file mode: ${entry.path}`);
      if (typeof entry.contentBase64 !== 'string') throw new Error(`Missing retrievable file bytes: ${entry.path}`);
      kind = 'file'; executable = entry.mode === '100755';
      if (Buffer.from(entry.contentBase64, 'base64').toString('base64') !== entry.contentBase64) throw new Error(`Non-canonical base64 bytes: ${entry.path}`);
      bytes = Buffer.from(entry.contentBase64, 'base64');
    } else if (entry.kind === 'symlink') {
      if (entry.mode !== '120000' || typeof entry.target !== 'string' || !entry.target) throw new Error(`Invalid symlink target or mode: ${entry.path}`);
      kind = 'symlink'; executable = false; bytes = Buffer.from(entry.target, 'utf8');
    } else throw new Error(`Unsupported workspace entry kind: ${entry.path}`);
    if (bytes.length !== entry.size) throw new Error(`Workspace entry size mismatch: ${entry.path}`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== entry.sha256.toLowerCase()) throw new Error(`Workspace entry hash mismatch: ${entry.path}`);
    if (kind === 'symlink' && bytes.toString('utf8') !== entry.target) throw new Error(`Symlink target is not valid UTF-8: ${entry.path}`);
    return { path: entry.path, kind, executable, contentBase64: bytes.toString('base64') };
  });
  return entries;
}

/** Independent local Git comparison. Bridge assertions are recorded as evidence, never as acceptance. */
export async function verifyBridgeWorkspace({ repoPath, baseCommit, snapshot, allowedScope }) {
  const entries = validateBridgeSnapshot(snapshot, baseCommit);
  const verified = await verifyGitSnapshotScope(repoPath, baseCommit, entries, allowedScope);
  const changes = verified.changes.map(change => ({
    kind: change.kind,
    path: change.path,
    ...(change.previousPath ? { previousPath: change.previousPath } : {}),
    ...(change.before ? { before: entryEvidence(change.before) } : {}),
    ...(change.after ? { after: entryEvidence(change.after) } : {}),
  }));
  return {
    evidenceVersion: 1,
    validation: 'verified_by_foreman_git_comparison',
    acceptance: 'not_decided',
    baseCommit: verified.commit,
    scopeVerified: verified.scopeVerified,
    completeSnapshot: { reportedComplete: snapshot.complete, reportedErrors: snapshot.errors.length, entryCount: entries.length },
    bridgeClaim: { baseCommit: snapshot.base_commit },
    allowedScope: verified.allowedScope,
    changes,
    reviewDiff: formatReviewDiff(changes),
  };
}

function entryEvidence(entry) {
  const bytes = Buffer.from(entry.contentBase64, 'base64');
  return { kind: entry.kind, mode: entry.kind === 'symlink' ? '120000' : entry.executable ? '100755' : '100644', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: entry.contentBase64 };
}

function formatReviewDiff(changes) {
  if (!changes.length) return 'No workspace changes.\n';
  return changes.map(change => {
    const before = change.before, after = change.after;
    const label = change.kind === 'rename' ? `${change.previousPath} -> ${change.path}` : change.path;
    let out = `### ${change.kind}: ${label}\n`;
    if (before) out += `- mode ${before.mode}, ${before.size} bytes, sha256 ${before.sha256}\n`;
    if (after) out += `+ mode ${after.mode}, ${after.size} bytes, sha256 ${after.sha256}\n`;
    if (after?.kind === 'file' || before?.kind === 'file') {
      const beforeText = before?.kind === 'file' ? decodeText(Buffer.from(before.contentBase64, 'base64')) : '';
      const afterText = after?.kind === 'file' ? decodeText(Buffer.from(after.contentBase64, 'base64')) : '';
      if (beforeText !== undefined && afterText !== undefined) {
        out += unifiedDiff(change.path, beforeText, afterText);
      } else out += '[binary bytes are preserved in the evidence record]\n';
    } else if (after?.kind === 'symlink') out += `symlink target: ${Buffer.from(after.contentBase64, 'base64').toString('utf8')}\n`;
    return out;
  }).join('\n');
}

function unifiedDiff(path, beforeText, afterText) {
  const oldLines = beforeText ? beforeText.replace(/\n$/, '').split('\n') : [];
  const newLines = afterText ? afterText.replace(/\n$/, '').split('\n') : [];
  if (oldLines.length * newLines.length > 1_000_000) return '[text diff omitted: file exceeds review hunk limit; exact bytes remain in evidence]\n';
  const rows = oldLines.length + 1, cols = newLines.length + 1;
  const lcs = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = oldLines.length - 1; i >= 0; i--) for (let j = newLines.length - 1; j >= 0; j--) {
    lcs[i][j] = oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const diff = []; let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) diff.push(` ${oldLines[i++]}`), j++;
    else if (j < newLines.length && (i === oldLines.length || lcs[i][j + 1] >= lcs[i + 1][j])) diff.push(`+${newLines[j++]}`);
    else diff.push(`-${oldLines[i++]}`);
  }
  return `\n\`\`\`diff\n--- a/${path}\n+++ b/${path}\n@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@\n${diff.join('\n')}\n\`\`\`\n`;
}

function decodeText(bytes) {
  if (bytes.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return undefined; }
}
