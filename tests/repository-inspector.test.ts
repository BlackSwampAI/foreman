import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectRepository, parseCiScripts, ciChecksNotConfigured, scriptNeedsNetwork } from '../src/repository-inspector.js';

const dirs: string[] = [];
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

async function repoWithPackage(options: {
  scripts?: Record<string, string>;
  packageManager?: string;
  workflowFiles?: Record<string, string>;
  extraFiles?: Record<string, string>;
} = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'foreman-inspector-'));
  dirs.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  const pkg: Record<string, unknown> = {
    name: 'test-pkg',
    scripts: options.scripts ?? { test: 'vitest', typecheck: 'tsc --noEmit' },
    ...(options.packageManager ? { packageManager: options.packageManager } : {}),
  };
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(root, 'pnpm-lock.yaml'), '');
  if (options.workflowFiles) {
    const wfDir = join(root, '.github', 'workflows');
    await mkdir(wfDir, { recursive: true });
    for (const [name, content] of Object.entries(options.workflowFiles)) {
      await writeFile(join(wfDir, name), content);
    }
  }
  for (const [name, content] of Object.entries(options.extraFiles ?? {})) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

describe('repository inspector', () => {
  describe('CI workflow parsing', () => {
    it('parses single-line run: steps and suggests CI-sourced commands', async () => {
      const repo = await repoWithPackage({
        scripts: { 'format:check': 'prettier', lint: 'eslint', typecheck: 'tsc', test: 'vitest', build: 'esbuild' },
        workflowFiles: {
          'ci.yml': `
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Install
        run: pnpm install --frozen-lockfile
      - name: Check formatting
        run: pnpm run format:check
      - name: Lint
        run: pnpm run lint
      - name: Test
        run: pnpm test
`,
        },
      });
      const result = await inspectRepository(repo);
      expect(result.ciScripts).toEqual(['format:check', 'lint', 'test']);
      const names = result.suggestedValidationCommands.map(c => c.name);
      expect(names).toContain('Check formatting');
      expect(names).toContain('Lint');
      expect(names).toContain('Tests');
      expect(result.suggestedValidationCommands.every(c => c.source === 'ci')).toBe(true);
    });

    it('parses multi-line run: | blocks', async () => {
      const repo = await repoWithPackage({
        scripts: { lint: 'eslint', typecheck: 'tsc', test: 'vitest' },
        workflowFiles: {
          'ci.yml': `
on: [push]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Setup and check
        run: |
          pnpm install --frozen-lockfile
          pnpm run lint
          pnpm run typecheck
          pnpm run test
`,
        },
      });
      const result = await inspectRepository(repo);
      expect(result.ciScripts).toContain('lint');
      expect(result.ciScripts).toContain('typecheck');
      expect(result.ciScripts).toContain('test');
      expect(result.suggestedValidationCommands.some(c => c.source === 'ci')).toBe(true);
    });

    it('excludes publish/release/deploy job steps', async () => {
      const repo = await repoWithPackage({
        scripts: { test: 'vitest', 'scan:published': 'scanner', release: 'release-it', deploy: 'deploy-cmd' },
        workflowFiles: {
          'ci.yml': `
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Test
        run: pnpm test
  publish:
    runs-on: ubuntu-latest
    steps:
      - name: Release
        run: pnpm run release
      - name: Deploy
        run: pnpm run deploy
`,
        },
      });
      const ciScripts = await parseCiScripts(repo);
      expect(ciScripts).toContain('test');
      expect(ciScripts).not.toContain('release');
      expect(ciScripts).not.toContain('deploy');
    });

    it('excludes steps whose script name contains publish/published/release/deploy/stage', async () => {
      const repo = await repoWithPackage({
        scripts: { test: 'vitest', 'scan:source': 'scanner', 'scan:published': 'scanner-pub' },
        workflowFiles: {
          'ci.yml': `
on: [push]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm run test
      - run: pnpm run scan:source
      - run: pnpm run scan:published
`,
        },
      });
      const ciScripts = await parseCiScripts(repo);
      expect(ciScripts).toContain('test');
      expect(ciScripts).toContain('scan:source');
      expect(ciScripts).not.toContain('scan:published');
    });

    it('falls back to common scripts in order when no CI workflow exists', async () => {
      const repo = await repoWithPackage({
        scripts: {
          'format:check': 'prettier --check .',
          lint: 'eslint .',
          typecheck: 'tsc',
          test: 'vitest',
          build: 'esbuild',
        },
      });
      const result = await inspectRepository(repo);
      expect(result.ciScripts).toEqual([]);
      const names = result.suggestedValidationCommands.map(c => c.name);
      // format:check before lint before typecheck before test before build
      expect(names.indexOf('Check formatting')).toBeLessThan(names.indexOf('Lint'));
      expect(names.indexOf('Lint')).toBeLessThan(names.indexOf('Typecheck'));
      expect(names.indexOf('Typecheck')).toBeLessThan(names.indexOf('Tests'));
      expect(result.suggestedValidationCommands.every(c => c.source === 'package-script')).toBe(true);
    });

    it('detects pnpm package manager and uses pnpm install --frozen-lockfile', async () => {
      const repo = await repoWithPackage({
        scripts: { test: 'vitest' },
        workflowFiles: {
          'ci.yml': `
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
`,
        },
      });
      const result = await inspectRepository(repo);
      const install = result.suggestedValidationCommands.find(c => c.name === 'Install dependencies');
      expect(install).toBeDefined();
      expect(install?.command).toBe('pnpm');
      expect(install?.args).toContain('--frozen-lockfile');
    });

    it('excludes npm view, pnpm dlx, and release-job scripts from ciScripts', async () => {
      const repo = await repoWithPackage({
        scripts: { test: 'vitest', lint: 'eslint', typecheck: 'tsc', 'build': 'esbuild' },
        workflowFiles: {
          'ci.yml': `
on: [push]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm run lint
      - run: pnpm run typecheck
      - run: pnpm test
      - run: npm view my-pkg version
      - run: pnpm dlx some-tool
  release:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm run build
      - run: npm publish
`,
        },
      });
      const ciScripts = await parseCiScripts(repo, new Set(['test', 'lint', 'typecheck', 'build']));
      expect(ciScripts).toContain('lint');
      expect(ciScripts).toContain('typecheck');
      expect(ciScripts).toContain('test');
      // npm view and pnpm dlx must not appear — not package.json scripts
      expect(ciScripts).not.toContain('view');
      expect(ciScripts).not.toContain('dlx');
      expect(ciScripts).not.toContain('some-tool');
      // build is in a release job — excluded
      expect(ciScripts).not.toContain('build');
      // publish is in skip list
      expect(ciScripts).not.toContain('publish');
    });

    it('orders CI scripts in their first appearance order across workflow files', async () => {
      const repo = await repoWithPackage({
        scripts: { test: 'vitest', lint: 'eslint', typecheck: 'tsc' },
        workflowFiles: {
          'ci.yml': `
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm run lint
      - run: pnpm run typecheck
      - run: pnpm test
`,
        },
      });
      const ciScripts = await parseCiScripts(repo);
      expect(ciScripts.indexOf('lint')).toBeLessThan(ciScripts.indexOf('typecheck'));
      expect(ciScripts.indexOf('typecheck')).toBeLessThan(ciScripts.indexOf('test'));
    });
  });

  describe('suggested allowed scope', () => {
    it('excludes CI configuration but keeps manifests, lockfiles and source', async () => {
      const repo = await repoWithPackage({
        workflowFiles: { 'ci.yml': 'on: [push]\njobs: {}\n' },
        extraFiles: {
          '.gitlab-ci.yml': 'stages: []\n',
          '.circleci/config.yml': 'version: 2.1\n',
          '.buildkite/pipeline.yml': 'steps: []\n',
          'azure-pipelines.yml': 'trigger: []\n',
          Jenkinsfile: 'pipeline {}\n',
          '.travis.yml': 'language: node_js\n',
          'src/index.ts': 'export {};\n',
          'README.md': '# fixture\n',
        },
      });
      const { suggestedAllowedScope } = await inspectRepository(repo);
      expect([...suggestedAllowedScope].sort()).toEqual(['README.md', 'package.json', 'pnpm-lock.yaml', 'src/']);
    });

    it('does not filter look-alike paths that are not CI configuration', async () => {
      const repo = await repoWithPackage({ extraFiles: { 'docs/.github/notes.md': 'x\n', 'Jenkinsfile.md': 'x\n', 'github/readme.md': 'x\n' } });
      const { suggestedAllowedScope } = await inspectRepository(repo);
      expect(suggestedAllowedScope).toEqual(expect.arrayContaining(['docs/', 'Jenkinsfile.md', 'github/']));
    });
  });

  describe('network flag on suggestions', () => {
    /** A committed repository with exactly the given files (no default lockfile). */
    async function repoWithFiles(files: Record<string, string>): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), 'foreman-inspector-net-'));
      dirs.push(root);
      git(root, 'init', '-q');
      git(root, 'config', 'user.name', 'Test');
      git(root, 'config', 'user.email', 'test@example.invalid');
      for (const [name, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, name)), { recursive: true });
        await writeFile(join(root, name), content);
      }
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
      return root;
    }
    const networkByName = (suggestions: Array<{ name: string; network?: boolean }>) => Object.fromEntries(suggestions.map(c => [c.name, c.network === true]));
    const CI = 'on: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run lint\n      - run: pnpm test\n';

    it('marks only the pnpm install network-enabled when the suggestions come from CI', async () => {
      const repo = await repoWithPackage({ scripts: { lint: 'eslint', test: 'vitest' }, workflowFiles: { 'ci.yml': CI } });
      const { suggestedValidationCommands } = await inspectRepository(repo);
      expect(suggestedValidationCommands.map(c => c.args.join(' '))).toEqual(['install --frozen-lockfile', 'run lint', 'run test']);
      expect(networkByName(suggestedValidationCommands)).toEqual({ 'Install dependencies': true, Lint: false, Tests: false });
      expect(suggestedValidationCommands.find(c => c.name === 'Install dependencies')?.network).toBe(true);
      for (const check of suggestedValidationCommands.filter(c => c.name !== 'Install dependencies')) expect(check.network === undefined || check.network === false).toBe(true);
    });

    it('does the same for the package-script fallback and for npm ci', async () => {
      const pnpm = await inspectRepository(await repoWithPackage({ scripts: { test: 'vitest', typecheck: 'tsc', build: 'esbuild' } }));
      expect(networkByName(pnpm.suggestedValidationCommands)).toEqual({ 'Install dependencies': true, Typecheck: false, Tests: false, Build: false });
      const npm = await inspectRepository(await repoWithFiles({ 'package.json': JSON.stringify({ scripts: { test: 'vitest', build: 'tsc' } }), 'package-lock.json': '{}' }));
      expect(npm.suggestedValidationCommands.map(c => [c.command, c.args.join(' ')])).toEqual([['npm', 'ci'], ['npm', 'run test'], ['npm', 'run build']]);
      expect(networkByName(npm.suggestedValidationCommands)).toEqual({ 'Install dependencies': true, Tests: false, Build: false });
    });

    it('gives smoke and install-running scripts from CI the network, since they fail offline whatever the Worker changed', async () => {
      const ci = 'on: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run format:check\n      - run: pnpm run smoke:install\n      - run: pnpm run smoke:load\n      - run: pnpm run e2e\n      - run: pnpm test\n';
      const repo = await repoWithPackage({ scripts: { 'format:check': 'prettier --check .', 'smoke:install': 'node scripts/smoke.mjs', 'smoke:load': 'node -e 1', e2e: 'npx playwright test', test: 'vitest' }, workflowFiles: { 'ci.yml': ci } });
      const { suggestedValidationCommands } = await inspectRepository(repo);
      expect(networkByName(suggestedValidationCommands)).toEqual({ 'Install dependencies': true, 'Check formatting': false, 'Smoke: install': true, 'Smoke: load': true, e2e: true, Tests: false });
    });

    it('decides network from the script name and body', () => {
      expect(scriptNeedsNetwork('smoke:install', 'node smoke.mjs')).toBe(true);
      expect(scriptNeedsNetwork('smoke', 'node smoke.mjs')).toBe(true);
      expect(scriptNeedsNetwork('test:install', 'node t.mjs')).toBe(true);
      expect(scriptNeedsNetwork('pack-check', 'npm pack && cd tmp && npm install ../x.tgz')).toBe(true);
      expect(scriptNeedsNetwork('lint', 'pnpm dlx eslint .')).toBe(true);
      expect(scriptNeedsNetwork('test', 'vitest run')).toBe(false);
      expect(scriptNeedsNetwork('format:check', 'prettier --check .')).toBe(false);
      expect(scriptNeedsNetwork('installer-docs', 'node docs.mjs')).toBe(false);
      expect(scriptNeedsNetwork('smokescreen', 'node x.mjs')).toBe(false);
    });

    it('keeps a package repository without a lockfile fully offline', async () => {
      const { suggestedValidationCommands } = await inspectRepository(await repoWithFiles({ 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) }));
      expect(suggestedValidationCommands.map(c => c.name)).toEqual(['Tests']);
      expect(networkByName(suggestedValidationCommands)).toEqual({ Tests: false });
    });

    it('lets cargo and go fetch dependencies but keeps python offline', async () => {
      const cargo = await inspectRepository(await repoWithFiles({ 'Cargo.toml': '[package]\nname = "x"\n' }));
      const go = await inspectRepository(await repoWithFiles({ 'go.mod': 'module x\n' }));
      const python = await inspectRepository(await repoWithFiles({ 'pyproject.toml': '[project]\nname = "x"\n' }));
      expect(cargo.suggestedValidationCommands).toMatchObject([{ command: 'cargo', args: ['test'], network: true }]);
      expect(go.suggestedValidationCommands).toMatchObject([{ command: 'go', args: ['test', './...'], network: true }]);
      expect(python.suggestedValidationCommands).toHaveLength(1);
      expect(python.suggestedValidationCommands[0]?.network === true).toBe(false);
    });
  });

  describe('ciChecksNotConfigured', () => {
    it('returns CI scripts not covered by any configured command', () => {
      const ciScripts = ['format:check', 'lint', 'typecheck', 'test', 'build'];
      const configured = [
        { name: 'Install', command: 'pnpm', args: ['install', '--frozen-lockfile'] },
        { name: 'Typecheck', command: 'pnpm', args: ['run', 'typecheck'] },
        { name: 'Tests', command: 'pnpm', args: ['run', 'test'] },
      ];
      const missing = ciChecksNotConfigured(ciScripts, configured);
      expect(missing).toContain('format:check');
      expect(missing).toContain('lint');
      expect(missing).toContain('build');
      expect(missing).not.toContain('typecheck');
      expect(missing).not.toContain('test');
    });

    it('returns empty when all CI scripts are configured', () => {
      const ciScripts = ['lint', 'test'];
      const configured = [
        { name: 'Lint', command: 'pnpm', args: ['run', 'lint'] },
        { name: 'Tests', command: 'pnpm', args: ['run', 'test'] },
      ];
      expect(ciChecksNotConfigured(ciScripts, configured)).toEqual([]);
    });

    it('returns empty when ciScripts is empty', () => {
      expect(ciChecksNotConfigured([], [{ name: 'T', command: 'pnpm', args: ['test'] }])).toEqual([]);
    });
  });
});

describe('format step suggestion', () => {
  it('suggests `<runner> run format` from a format script, offline', async () => {
    const repo = await repoWithPackage({ scripts: { test: 'vitest', format: 'prettier --write .', 'format:check': 'prettier --check .' } });
    const result = await inspectRepository(repo);
    expect(result.suggestedFormatCommand).toEqual({ name: 'Format', command: 'pnpm', args: ['run', 'format'], network: false, source: 'package-script' });
  });

  it('falls back to format:write, then prettier:write, and prefers format', async () => {
    expect((await inspectRepository(await repoWithPackage({ scripts: { test: 'x', 'format:write': 'p', 'prettier:write': 'p' } }))).suggestedFormatCommand?.args).toEqual(['run', 'format:write']);
    expect((await inspectRepository(await repoWithPackage({ scripts: { test: 'x', 'prettier:write': 'p' } }))).suggestedFormatCommand?.args).toEqual(['run', 'prettier:write']);
    expect((await inspectRepository(await repoWithPackage({ scripts: { test: 'x', 'prettier:write': 'p', format: 'p' } }))).suggestedFormatCommand?.args).toEqual(['run', 'format']);
  });

  it('uses npm without a pnpm lockfile and suggests nothing for check-only or missing scripts', async () => {
    const npmRepo = await repoWithPackage({ scripts: { test: 'x', format: 'p' } });
    git(npmRepo, 'rm', '-q', 'pnpm-lock.yaml');
    git(npmRepo, 'commit', '-qm', 'no pnpm lock');
    expect((await inspectRepository(npmRepo)).suggestedFormatCommand).toMatchObject({ command: 'npm', args: ['run', 'format'] });
    expect((await inspectRepository(await repoWithPackage({ scripts: { test: 'x', 'format:check': 'prettier --check .' } }))).suggestedFormatCommand).toBeUndefined();
    expect((await inspectRepository(await repoWithPackage())).suggestedFormatCommand).toBeUndefined();
  });
});
