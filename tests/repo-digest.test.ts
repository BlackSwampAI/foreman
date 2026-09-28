import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRepoDigest, extractKeywords } from '../src/repo-digest.js';

const dirs: string[] = [];

async function makeGitRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-digest-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
  return dir;
}

async function commitAll(dir: string) {
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty-message', '-m', 'init'], { stdio: 'pipe' });
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

describe('extractKeywords', () => {
  it('keeps ALL-CAPS acronyms, digit-bearing tokens, and named identifiers; drops generic words', () => {
    const result = extractKeywords("I'd like to add NBA support to this n8n community node repo for the Sleeper API");
    // acronyms and identifier tokens kept
    expect(result).toContain('NBA');
    expect(result).toContain('Sleeper');
    // n8n has a digit — kept
    expect(result).toContain('n8n');
    // generic request/project vocabulary dropped
    expect(result).not.toContain('like');
    expect(result).not.toContain('support');
    expect(result).not.toContain('community');
    expect(result).not.toContain('node');
    expect(result).not.toContain('repo');
    expect(result.length).toBeLessThanOrEqual(8);
  });

  it('returns canonical lowercase-deduplicated set (no two tokens share a lowercased form)', () => {
    const result = extractKeywords("Sleeper sleeper SLEEPER Sleeper NFL nfl NBA nba");
    const lowers = result.map(t => t.toLowerCase());
    expect(new Set(lowers).size).toBe(lowers.length);
  });

  it('deduplicates tokens and respects the max limit', () => {
    const text = 'alpha alpha alpha alpha alpha alpha alpha alpha alpha extra unique items present here';
    const result = extractKeywords(text, 3);
    expect(new Set(result).size).toBe(result.length); // no duplicates
    expect(result.length).toBeLessThanOrEqual(3);
  });
});

describe('buildRepoDigest — file tree and exclusions', () => {
  it('excludes node_modules and dist from the file tree', async () => {
    const dir = await makeGitRepo();
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, 'node_modules', 'lib'), { recursive: true });
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(join(dir, 'src', 'index.ts'), 'export const x = 1;');
    await writeFile(join(dir, 'node_modules', 'lib', 'index.js'), 'module.exports = {};');
    await writeFile(join(dir, 'dist', 'bundle.js'), 'var x=1;');
    await writeFile(join(dir, 'README.md'), '# Test repo');
    const commit = await commitAll(dir);
    const result = await buildRepoDigest({ repoPath: dir, commit, allowedScope: [] });
    expect(result.text).toContain('src/');
    expect(result.text).not.toContain('node_modules');
    expect(result.text).not.toContain('dist/');
    expect(result.commit).toBe(commit);
  });

  it('filters the file tree to the allowed scope', async () => {
    const dir = await makeGitRepo();
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, 'private'), { recursive: true });
    await writeFile(join(dir, 'src', 'api.ts'), 'export const api = "Sleeper";');
    await writeFile(join(dir, 'private', 'secret.ts'), 'const key = "private";');
    await writeFile(join(dir, 'README.md'), '# Test');
    const commit = await commitAll(dir);
    const result = await buildRepoDigest({ repoPath: dir, commit, allowedScope: ['src/'] });
    expect(result.text).toContain('src/');
    expect(result.text).not.toContain('private');
  });
});

describe('buildRepoDigest — keyword hits', () => {
  it('formats keyword hits as path:line: text', async () => {
    const dir = await makeGitRepo();
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'api.ts'), [
      'export const SleeperClient = "https://api.sleeper.app";',
      '// Sleeper fantasy sports API',
    ].join('\n'));
    await writeFile(join(dir, 'README.md'), '# Sleeper integration');
    const commit = await commitAll(dir);
    const result = await buildRepoDigest({ repoPath: dir, commit, allowedScope: ['src/', 'README.md'], keywords: ['Sleeper'] });
    expect(result.text).toContain('## Keyword hits');
    // format: path:line: text
    const hit = result.text.match(/src\/api\.ts:\d+: .+Sleeper/);
    expect(hit).not.toBeNull();
  });

  it('excludes pnpm-lock.yaml from keyword search hits', async () => {
    const dir = await makeGitRepo();
    await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# Sleeper: 1.0.0\n');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'empty.ts'), '// no keywords here');
    const commit = await commitAll(dir);
    const result = await buildRepoDigest({ repoPath: dir, commit, allowedScope: [], keywords: ['Sleeper'] });
    if (result.text.includes('Keyword hits')) {
      expect(result.text).not.toMatch(/pnpm-lock\.yaml:\d+:/);
    }
  });
});

describe('buildRepoDigest — keyword rarity weighting', () => {
  it('drops keywords appearing in >40% of files and surfaces rare keyword lines', async () => {
    const dir = await makeGitRepo();
    // "common" appears in every file — should be filtered out as too common
    // "rare" appears only in 3 nodes/ files — its lines must dominate
    await mkdir(join(dir, 'nodes', 'Sleeper'), { recursive: true });
    await mkdir(join(dir, 'docs'), { recursive: true });
    const numCommonFiles = 8;
    for (let i = 0; i < numCommonFiles; i++) {
      await writeFile(join(dir, `docs`, `doc${i}.md`), `common word appears on line ${i}\nothing unusual on this line\n`);
    }
    await writeFile(join(dir, 'nodes', 'Sleeper', 'a.ts'), 'const rare = true; // common stuff\n');
    await writeFile(join(dir, 'nodes', 'Sleeper', 'b.ts'), 'export function rare() {} // common\n');
    await writeFile(join(dir, 'nodes', 'Sleeper', 'c.ts'), 'if (rare) return; // common value\n');
    const commit = await commitAll(dir);
    const result = await buildRepoDigest({
      repoPath: dir,
      commit,
      allowedScope: ['docs/', 'nodes/'],
      keywords: ['common', 'rare'],
    });
    // "common" hits every file (100%) → should be dropped or reported as too common
    expect(result.text).toMatch(/too common.*common/i);
    // "rare" only in 3 files — its lines must appear
    expect(result.text).toMatch(/nodes\/Sleeper\/[abc]\.ts:\d+:.*rare/);
  });
});

describe('buildRepoDigest — keyword source prioritisation', () => {
  it('includes hits from nodes/ even when docs contain many more keyword matches', async () => {
    const dir = await makeGitRepo();
    // docs/ has 30 lines with keyword "sleeper" — enough to exhaust a naive budget
    await mkdir(join(dir, 'docs'), { recursive: true });
    const docLines = Array.from({ length: 30 }, (_, i) => `sleeper fantasy sports line ${i}`).join('\n');
    await writeFile(join(dir, 'docs', 'guide.md'), docLines);
    // nodes/ has 3 lines with keyword "sleeper" — must still appear
    await mkdir(join(dir, 'nodes', 'Sleeper'), { recursive: true });
    await writeFile(join(dir, 'nodes', 'Sleeper', 'utils.ts'), [
      'export function isSleeper(sport: string) {',
      "  return sport === 'sleeper';",
      '}',
    ].join('\n'));
    const commit = await commitAll(dir);
    const result = await buildRepoDigest({
      repoPath: dir,
      commit,
      allowedScope: ['docs/', 'nodes/'],
      keywords: ['sleeper'],
    });
    // Source file hits must appear despite docs having far more matches
    expect(result.text).toMatch(/nodes\/Sleeper\/utils\.ts:\d+:/);
  });
});

describe('buildRepoDigest — size bound', () => {
  it('keeps total output within the 24 KB default limit even with a large file', async () => {
    const dir = await makeGitRepo();
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'big.ts'), 'const x = "' + 'y'.repeat(50 * 1024) + '";');
    await writeFile(join(dir, 'README.md'), '# Big');
    const commit = await commitAll(dir);
    const result = await buildRepoDigest({ repoPath: dir, commit, allowedScope: [], keywords: ['big'] });
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(24 * 1024);
  });

  it('respects a custom maxBytes limit', async () => {
    const dir = await makeGitRepo();
    await writeFile(join(dir, 'README.md'), '# Short readme\n' + 'line\n'.repeat(200));
    const commit = await commitAll(dir);
    const small = await buildRepoDigest({ repoPath: dir, commit, allowedScope: [], maxBytes: 512 });
    expect(Buffer.byteLength(small.text, 'utf8')).toBeLessThanOrEqual(512);
  });

  it('truncates the file tree to fit a small maxBytes instead of dropping it', async () => {
    const dir = await makeGitRepo();
    await mkdir(join(dir, 'src'), { recursive: true });
    for (let i = 0; i < 150; i++) await writeFile(join(dir, 'src', `file-with-a-long-name-${i}.ts`), `export const value${i} = ${i};\n`);
    await writeFile(join(dir, 'README.md'), '# Big\n' + 'readme line\n'.repeat(100));
    const commit = await commitAll(dir);
    const full = await buildRepoDigest({ repoPath: dir, commit, allowedScope: [] });
    expect(full.text).not.toContain('tree lines omitted');
    const small = await buildRepoDigest({ repoPath: dir, commit, allowedScope: [], maxBytes: 1024 });
    expect(Buffer.byteLength(small.text, 'utf8')).toBeLessThanOrEqual(1024);
    expect(small.text).toContain('## Repository file tree');
    expect(small.text).toContain('src/');
    expect(small.text).toMatch(/… \d+ more tree lines omitted/);
  });

  it('never exceeds maxBytes, including when the budget is too small for any section', async () => {
    const dir = await makeGitRepo();
    await mkdir(join(dir, 'src'), { recursive: true });
    for (let i = 0; i < 50; i++) await writeFile(join(dir, 'src', `file-${i}.ts`), `export const retry${i} = ${i};\n`);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`dependency-${i}`, '1'])) }));
    await writeFile(join(dir, 'README.md'), '# Big\n' + 'readme line\n'.repeat(100));
    const commit = await commitAll(dir);
    for (const maxBytes of [0, 20, 100, 300, 700, 1500, 3000, 6000]) {
      const result = await buildRepoDigest({ repoPath: dir, commit, allowedScope: ['src/', 'package.json', 'README.md'], keywords: ['retry'], maxBytes });
      expect(Buffer.byteLength(result.text, 'utf8'), `maxBytes=${maxBytes}`).toBeLessThanOrEqual(maxBytes);
    }
  });

  it('cuts multi-byte text on a character boundary', async () => {
    const dir = await makeGitRepo();
    await writeFile(join(dir, 'README.md'), '# Ünïcödé\n' + '日本語のドキュメント 🚀\n'.repeat(60));
    const commit = await commitAll(dir);
    for (const maxBytes of [900, 901, 902, 903, 1000, 1001]) {
      const result = await buildRepoDigest({ repoPath: dir, commit, allowedScope: [], maxBytes });
      expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(maxBytes);
      expect(result.text).not.toContain('\uFFFD');
    }
  });
});
