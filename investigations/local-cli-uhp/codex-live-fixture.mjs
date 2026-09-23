#!/usr/bin/env node
// Create a one-file disposable Git repository for the explicitly bounded Codex
// Worker smoke. The caller owns cleanup after recording evidence.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = await mkdtemp(join(tmpdir(), 'foreman-codex-live-repo-'));
await exec('git', ['init', '-q', repo]);
await exec('git', ['-C', repo, 'config', 'user.name', 'Foreman Codex Smoke']);
await exec('git', ['-C', repo, 'config', 'user.email', 'foreman-codex-smoke@example.invalid']);
await writeFile(join(repo, 'README.md'), '# Disposable Codex Worker smoke\n\nThis repository contains no project or personal data.\n');
await exec('git', ['-C', repo, 'add', 'README.md']);
await exec('git', ['-C', repo, 'commit', '-qm', 'disposable Codex Worker base']);
const baseCommit = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
process.stdout.write(`${JSON.stringify({ repo, baseCommit })}\n`);
