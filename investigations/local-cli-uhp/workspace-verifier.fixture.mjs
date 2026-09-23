import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateBridgeSnapshot } from './workspace-verifier.mjs';

const base = 'a'.repeat(40);
function file(path, text, mode = '100644') {
  const bytes = Buffer.from(text);
  return { path, kind: 'file', mode, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') };
}
const complete = entries => ({ complete: true, base_commit: base, entries, errors: [] });

test('accepts exact complete bridge bytes and executable mode', () => {
  const entries = validateBridgeSnapshot(complete([file('.hidden/AGENTS.md', 'instructions\n'), file('bin/run', '#!/bin/sh\n', '100755')]), base);
  assert.deepEqual(entries.map(e => [e.path, e.executable]), [['.hidden/AGENTS.md', false], ['bin/run', true]]);
});

test('rejects a false base, incomplete tree, errors, missing bytes, and mismatched hashes', () => {
  assert.throws(() => validateBridgeSnapshot({ ...complete([]), base_commit: 'b'.repeat(40) }, base), /does not match/);
  assert.throws(() => validateBridgeSnapshot({ ...complete([]), complete: false }, base), /incomplete/);
  assert.throws(() => validateBridgeSnapshot({ ...complete([]), errors: [{ path: 'bad', error: 'EACCES' }] }, base), /contains errors/);
  const valid = file('x', 'bytes');
  assert.throws(() => validateBridgeSnapshot(complete([{ ...valid, contentBase64: undefined }]), base), /Missing retrievable/);
  assert.throws(() => validateBridgeSnapshot(complete([{ ...valid, sha256: '0'.repeat(64) }]), base), /hash mismatch/);
});

test('preserves symlink target bytes and rejects unsupported mode', () => {
  const target = '../target'; const bytes = Buffer.from(target);
  const link = { path: 'link', kind: 'symlink', mode: '120000', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), target };
  assert.equal(Buffer.from(validateBridgeSnapshot(complete([link]), base)[0].contentBase64, 'base64').toString(), target);
  assert.throws(() => validateBridgeSnapshot(complete([{ ...file('x', 'x'), mode: '100600' }]), base), /Unsupported regular-file mode/);
});
