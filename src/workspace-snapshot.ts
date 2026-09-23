import { createHash } from 'node:crypto';

/** A complete tree entry from an execution workspace. Omission means deletion. */
export interface SnapshotEntry {
  path: string;
  kind: 'file' | 'symlink';
  /** Exact file bytes, or exact UTF-8 symlink target, encoded as canonical base64. */
  contentBase64: string;
  executable: boolean;
}

export interface SnapshotChange {
  kind: 'add' | 'modify' | 'delete' | 'rename';
  path: string;
  previousPath?: string;
  before?: SnapshotEntry;
  after?: SnapshotEntry;
}

function validate(entry: SnapshotEntry): void {
  const parts = entry.path.split('/');
  if (!entry.path || entry.path.startsWith('/') || entry.path.includes('\\') ||
      parts.some(part => !part || part === '.' || part === '..' || part === '.git') ||
      entry.path.includes('\0')) {
    throw new Error(`Unsafe snapshot path: ${entry.path}`);
  }
  if (entry.kind !== 'file' && entry.kind !== 'symlink') throw new Error(`Invalid kind: ${entry.path}`);
  if (typeof entry.executable !== 'boolean' || (entry.kind === 'symlink' && entry.executable)) {
    throw new Error(`Invalid mode: ${entry.path}`);
  }
  if (Buffer.from(entry.contentBase64, 'base64').toString('base64') !== entry.contentBase64) {
    throw new Error(`Invalid content encoding: ${entry.path}`);
  }
  if (entry.kind === 'symlink' && !Buffer.from(entry.contentBase64, 'base64').toString('utf8')) {
    throw new Error(`Empty symlink target: ${entry.path}`);
  }
}

function index(entries: readonly SnapshotEntry[]): Map<string, SnapshotEntry> {
  const result = new Map<string, SnapshotEntry>();
  for (const entry of entries) {
    validate(entry);
    if (result.has(entry.path)) throw new Error(`Duplicate snapshot path: ${entry.path}`);
    result.set(entry.path, entry);
  }
  return result;
}

function signature(entry: SnapshotEntry): string {
  return createHash('sha256')
    .update(entry.kind).update('\0')
    .update(entry.executable ? '100755' : entry.kind === 'symlink' ? '120000' : '100644')
    .update('\0').update(Buffer.from(entry.contentBase64, 'base64')).digest('hex');
}

/** Compare two complete manifests. This does not prove that a remote server supplied a complete manifest. */
export function compareCompleteSnapshots(base: readonly SnapshotEntry[], result: readonly SnapshotEntry[]): SnapshotChange[] {
  const before = index(base);
  const after = index(result);
  const changes: SnapshotChange[] = [];
  const removed: SnapshotEntry[] = [];
  const added: SnapshotEntry[] = [];
  for (const [path, oldEntry] of before) {
    const newEntry = after.get(path);
    if (!newEntry) removed.push(oldEntry);
    else if (signature(oldEntry) !== signature(newEntry)) changes.push({ kind: 'modify', path, before: oldEntry, after: newEntry });
  }
  for (const [path, newEntry] of after) if (!before.has(path)) added.push(newEntry);

  // Pair byte-and-mode-identical moves. A move with edits remains an add and delete,
  // which still describes the exact resulting tree without guessing at rename intent.
  const bySignature = new Map<string, SnapshotEntry[]>();
  for (const entry of removed.sort((a, b) => a.path.localeCompare(b.path))) {
    const key = signature(entry);
    const list = bySignature.get(key) ?? [];
    list.push(entry);
    bySignature.set(key, list);
  }
  for (const entry of added.sort((a, b) => a.path.localeCompare(b.path))) {
    const previous = bySignature.get(signature(entry))?.shift();
    if (previous) changes.push({ kind: 'rename', path: entry.path, previousPath: previous.path, before: previous, after: entry });
    else changes.push({ kind: 'add', path: entry.path, after: entry });
  }
  for (const remaining of bySignature.values()) {
    for (const entry of remaining) changes.push({ kind: 'delete', path: entry.path, before: entry });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
}
