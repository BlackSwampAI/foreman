import { describe, expect, it } from 'vitest';
import { compareCompleteSnapshots, type SnapshotEntry } from '../src/workspace-snapshot.js';

const file = (path: string, bytes: Uint8Array | string, executable = false): SnapshotEntry => ({
  path, kind: 'file', contentBase64: Buffer.from(bytes).toString('base64'), executable
});
const link = (path: string, target: string): SnapshotEntry => ({
  path, kind: 'symlink', contentBase64: Buffer.from(target).toString('base64'), executable: false
});

describe('complete snapshot comparison', () => {
  it('preserves every requested file case as exact tree changes', () => {
    const base = [
      file('modified.txt', 'old'), file('deleted.txt', 'gone'), file('rename-before.txt', 'same'),
      file('binary.bin', Uint8Array.from([0, 255, 0])), file('run.sh', '#!/bin/sh\n'),
      link('current-link', 'old-target'), file('.env.example', 'old'), file('AGENTS.md', 'old rules')
    ];
    const result = [
      file('added.txt', 'new'), file('modified.txt', 'new'), file('rename-after.txt', 'same'),
      file('binary.bin', Uint8Array.from([0, 254, 0])), file('run.sh', '#!/bin/sh\n', true),
      link('current-link', 'new-target'), file('.env.example', 'new'), file('AGENTS.md', 'new rules')
    ];
    const changes = compareCompleteSnapshots(base, result);
    expect(Object.fromEntries(changes.map(change => [change.path, change.kind]))).toEqual({
      '.env.example': 'modify', 'AGENTS.md': 'modify', 'added.txt': 'add',
      'binary.bin': 'modify', 'current-link': 'modify', 'deleted.txt': 'delete',
      'modified.txt': 'modify', 'rename-after.txt': 'rename', 'run.sh': 'modify'
    });
    expect(changes.find(change => change.kind === 'rename')?.previousPath).toBe('rename-before.txt');
    expect(changes.find(change => change.path === 'run.sh')?.after?.executable).toBe(true);
    expect(changes.find(change => change.path === 'binary.bin')?.after?.contentBase64).toBe('AP4A');
  });

  it('rejects unsafe, ambiguous, and incomplete tree entry encodings', () => {
    expect(() => compareCompleteSnapshots([], [file('../outside', 'x')])).toThrow('Unsafe');
    expect(() => compareCompleteSnapshots([], [file('.git/config', 'x')])).toThrow('Unsafe');
    expect(() => compareCompleteSnapshots([], [file('same', 'a'), file('same', 'b')])).toThrow('Duplicate');
    expect(() => compareCompleteSnapshots([], [{ ...file('a', 'x'), contentBase64: 'not base64' }])).toThrow('Invalid content');
  });
});
