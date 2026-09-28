import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { WorkspaceValidationCommand } from './workspace-setup.js';

const run = promisify(execFile);

export interface ValidationSuggestion extends WorkspaceValidationCommand {
  source: 'ci' | 'package-script';
}

/** Excluded job/step patterns for CI inspection. */
const EXCLUDED_JOB_PATTERNS = /\b(publish|release|deploy|staging|stage)\b/i;
const EXCLUDED_SCRIPT_PATTERNS = /\b(publish|release|stage|deploy)\b|(^|:)(publish|published)($|:)/i;
/** Package script invocation patterns in shell run blocks. */
const PKG_INVOKE = /(?:^|\s)(?:pnpm|npm|yarn)\s+(?:run\s+)?([A-Za-z0-9:_-]+)/gm;

/**
 * npm/pnpm/yarn built-in subcommands that can never be package.json script names.
 * Bare `pnpm X` / `npm X` forms should not be treated as script invocations for these.
 */
const BUILTIN_SUBCOMMANDS = new Set([
  // package manager lifecycle / install
  'install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'upgrade', 'outdated',
  'dedupe', 'deduplicate', 'prune', 'link', 'unlink', 'init', 'create',
  // execution helpers
  'exec', 'dlx', 'npx', 'x',
  // publishing / registry
  'publish', 'unpublish', 'deprecate', 'pack', 'dist-tags', 'tag', 'access', 'owner', 'hook',
  // registry / account
  'login', 'logout', 'whoami', 'token', 'auth', 'adduser', 'profile', 'team',
  // info / query
  'view', 'info', 'show', 'search', 'ls', 'list', 'la', 'll', 'why', 'explain',
  // config / environment
  'config', 'set', 'get', 'prefix', 'root', 'bin', 'store', 'fetch',
  // misc
  'audit', 'fund', 'doctor', 'diff', 'ping', 'rebuild', 'restart', 'help',
  'patch', 'patch-commit', 'version', 'explore', 'edit', 'bugs', 'docs', 'home', 'repo',
]);

/** Extract package script names from a shell run block. Skips package-manager built-in subcommands. */
function extractScripts(block: string): string[] {
  const skip = BUILTIN_SUBCOMMANDS;
  const found: string[] = [];
  let m: RegExpExecArray | null;
  PKG_INVOKE.lastIndex = 0;
  while ((m = PKG_INVOKE.exec(block)) !== null) {
    const name = m[1]!;
    if (!skip.has(name) && !EXCLUDED_SCRIPT_PATTERNS.test(name)) {
      found.push(name);
    }
  }
  return found;
}

/** Lightweight line-based YAML run: block parser. Returns [{jobName, stepName, scripts}]. */
function parseWorkflowScripts(content: string): { jobName: string; stepName: string; scripts: string[] }[] {
  const lines = content.split(/\r?\n/);
  const results: { jobName: string; stepName: string; scripts: string[] }[] = [];
  // Track nesting by indentation
  let currentJobName = '';
  let currentJobExcluded = false;
  let currentStepName = '';
  let currentStepExcluded = false;
  let inRunBlock = false;
  let runBlockIndent = -1;
  let runLines: string[] = [];
  let inJobs = false;

  const flushRun = () => {
    if (runLines.length && !currentJobExcluded && !currentStepExcluded) {
      const scripts = extractScripts(runLines.join('\n'));
      if (scripts.length) {
        results.push({ jobName: currentJobName, stepName: currentStepName, scripts });
      }
    }
    inRunBlock = false;
    runBlockIndent = -1;
    runLines = [];
  };

  for (const raw of lines) {
    const trimmed = raw.trimEnd();
    const indent = raw.length - raw.trimStart().length;
    const stripped = trimmed.trimStart();

    // Detect `jobs:` section
    if (/^jobs\s*:/.test(trimmed)) { inJobs = true; continue; }

    if (!inJobs) continue;

    // If we're collecting a multi-line run block
    if (inRunBlock) {
      // End of block when indentation returns to or below block start
      if (stripped && indent <= runBlockIndent) {
        flushRun();
        // Fall through to process this line normally
      } else {
        runLines.push(stripped);
        continue;
      }
    }

    // Job-level lines (indent 2): detect job id and name
    if (indent === 2 && stripped && !stripped.startsWith('#')) {
      const jobId = stripped.replace(/:.*$/, '').trim();
      currentJobName = jobId;
      currentJobExcluded = EXCLUDED_JOB_PATTERNS.test(jobId);
      currentStepName = '';
    }
    // Step name (typically at indent 6-8 after `- name:`)
    const stepNameMatch = stripped.match(/^-?\s*name\s*:\s*(.+)$/);
    if (stepNameMatch && indent >= 4) {
      const stepName = stepNameMatch[1]!.trim().replace(/^['"]|['"]$/g, '');
      currentStepName = stepName;
      currentStepExcluded = EXCLUDED_JOB_PATTERNS.test(stepName);
    }
    // `run:` single-line
    const runInlineMatch = stripped.match(/^-?\s*run\s*:\s*(.+)$/);
    if (runInlineMatch && indent >= 4) {
      const inline = runInlineMatch[1]!.trim();
      if (inline !== '|' && inline !== '>') {
        if (!currentJobExcluded && !currentStepExcluded) {
          const scripts = extractScripts(inline);
          if (scripts.length) results.push({ jobName: currentJobName, stepName: currentStepName, scripts });
        }
      } else {
        // Multi-line run block follows
        inRunBlock = true;
        runBlockIndent = indent;
        runLines = [];
      }
      continue;
    }
    // `run: |` or `run: >` on its own line
    const runBlockStart = stripped.match(/^-?\s*run\s*:\s*[|>][+-]?\s*$/);
    if (runBlockStart && indent >= 4) {
      inRunBlock = true;
      runBlockIndent = indent;
      runLines = [];
    }
  }
  // Flush any trailing run block
  if (inRunBlock) flushRun();
  return results;
}

/**
 * Parse all .github/workflows/*.yml files and return the ordered unique list of non-excluded CI
 * script names.
 *
 * When `knownScripts` is provided, only names that appear in it are included — this filters out
 * npm/pnpm built-in subcommands that slipped through (e.g. `npm view`, `pnpm dlx`) and any
 * string that is not a real package.json script.
 */
export async function parseCiScripts(repoPath: string, knownScripts?: Set<string>): Promise<string[]> {
  const workflowDir = join(repoPath, '.github', 'workflows');
  let files: string[] = [];
  try {
    const entries = await readdir(workflowDir);
    files = entries.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  } catch { return []; }
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const file of files.sort()) {
    let content: string;
    try { content = await readFile(join(workflowDir, file), 'utf8'); } catch { continue; }
    for (const { scripts } of parseWorkflowScripts(content)) {
      for (const s of scripts) {
        if (!seen.has(s) && (!knownScripts || knownScripts.has(s))) {
          seen.add(s);
          ordered.push(s);
        }
      }
    }
  }
  return ordered;
}

/** Scripts that are commonly part of CI but network-dependent or publish-only — skip as fallback suggestions. */
const FALLBACK_COMMON_SCRIPTS = ['format:check', 'lint', 'typecheck', 'test', 'build'] as const;

/** CI configuration runs with repository secrets once pushed, so it is never in the suggested Worker scope. Users can still add it by hand. */
const CI_CONFIG_PATHS = new Set(['.github', '.gitlab-ci.yml', '.circleci', '.buildkite', 'azure-pipelines.yml', 'Jenkinsfile', '.travis.yml']);

/** Read bounded Git metadata for a repository picked in the local folder browser. */
export async function inspectRepository(selectedPath: string): Promise<{
  repoPath: string;
  head: string;
  dirty: boolean;
  trackedFiles: string[];
  trackedFilesTruncated: boolean;
  suggestedAllowedScope: string[];
  suggestedValidationCommands: ValidationSuggestion[];
  ciScripts: string[];
}> {
  const selected = resolve(selectedPath);
  const options = { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 };
  const { stdout: top } = await run('git', ['-C', selected, 'rev-parse', '--show-toplevel'], options);
  const repoPath = resolve(top.trim());
  const [{ stdout: head }, { stdout: status }, { stdout: tracked }] = await Promise.all([
    run('git', ['-C', repoPath, 'rev-parse', '--verify', 'HEAD^{commit}'], options),
    run('git', ['-C', repoPath, 'status', '--porcelain=v1', '--untracked-files=normal'], options),
    run('git', ['-C', repoPath, 'ls-files', '-z'], options),
  ]);
  const allFiles = tracked.split('\0').filter(Boolean);
  const topLevel = new Set<string>();
  for (const file of allFiles) {
    const slash = file.indexOf('/');
    topLevel.add(slash < 0 ? file : `${file.slice(0, slash)}/`);
  }
  const scope = [...topLevel].filter(path => path !== '.git/' && path !== '.git' && !CI_CONFIG_PATHS.has(path.replace(/\/$/, ''))).slice(0, 256);
  const suggestedValidationCommands: ValidationSuggestion[] = [];
  const packagePath = join(repoPath, 'package.json');
  const packageStat = await stat(packagePath).catch(() => undefined);
  let ciScripts: string[] = [];
  if (packageStat?.isFile() && packageStat.size < 512_000) {
    try {
      const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as { packageManager?: string; scripts?: Record<string, string> };
      const runner = pkg.packageManager?.startsWith('pnpm@') || allFiles.includes('pnpm-lock.yaml') ? 'pnpm' : 'npm';
      const pkgScripts = pkg.scripts ?? {};
      const lockfile = runner === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json';
      const installCmd: ValidationSuggestion | undefined = allFiles.includes(lockfile)
        ? { name: 'Install dependencies', command: runner, args: runner === 'pnpm' ? ['install', '--frozen-lockfile'] : ['ci'], network: true, source: 'ci' }
        : undefined;

      // Try CI workflow first — pass known script names so bare `pnpm X` is only
      // counted when X is actually a package.json script (not a built-in subcommand).
      ciScripts = await parseCiScripts(repoPath, new Set(Object.keys(pkgScripts)));
      if (ciScripts.length) {
        if (installCmd) suggestedValidationCommands.push(installCmd);
        for (const script of ciScripts) {
          if (typeof pkgScripts[script] === 'string') {
            suggestedValidationCommands.push({
              name: scriptDisplayName(script),
              command: runner,
              args: ['run', script],
              source: 'ci',
            });
          }
        }
      } else {
        // Fallback: common scripts in package.json in order
        const hasTest = typeof pkgScripts.test === 'string' && !/no test specified/i.test(pkgScripts.test);
        const hasTypecheck = typeof pkgScripts.typecheck === 'string';
        if (hasTest || hasTypecheck) {
          if (installCmd) suggestedValidationCommands.push({ ...installCmd, source: 'package-script' });
          for (const name of FALLBACK_COMMON_SCRIPTS) {
            if (typeof pkgScripts[name] === 'string' && (name !== 'test' || hasTest)) {
              suggestedValidationCommands.push({
                name: scriptDisplayName(name),
                command: runner,
                args: ['run', name],
                source: 'package-script',
              });
            }
          }
        }
      }
    } catch { /* malformed package metadata has no automatic validation suggestion */ }
  } else if (allFiles.includes('Cargo.toml')) {
    // cargo and go fetch dependencies implicitly on first run, so they get the network like the install step; every other suggestion runs offline.
    suggestedValidationCommands.push({ name: 'Tests', command: 'cargo', args: ['test'], network: true, source: 'package-script' });
  } else if (allFiles.includes('go.mod')) {
    suggestedValidationCommands.push({ name: 'Tests', command: 'go', args: ['test', './...'], network: true, source: 'package-script' });
  } else if (allFiles.includes('pyproject.toml')) {
    suggestedValidationCommands.push({ name: 'Tests', command: 'python', args: ['-m', 'pytest'], source: 'package-script' });
  }
  return {
    repoPath,
    head: head.trim().toLowerCase(),
    dirty: status.length > 0,
    trackedFiles: allFiles.slice(0, 300),
    trackedFilesTruncated: allFiles.length > 300,
    suggestedAllowedScope: scope,
    suggestedValidationCommands,
    ciScripts,
  };
}

/** Compute which CI scripts are not covered by a configured validation command list. */
export function ciChecksNotConfigured(ciScripts: string[], configuredCommands: WorkspaceValidationCommand[]): string[] {
  return ciScripts.filter(script =>
    !configuredCommands.some(cmd => cmd.args.some(arg => arg === script))
  );
}

function scriptDisplayName(script: string): string {
  const names: Record<string, string> = {
    test: 'Tests', typecheck: 'Typecheck', lint: 'Lint', build: 'Build',
    'format:check': 'Check formatting', validate: 'Validate',
    'package:check': 'Package check', 'scan:source': 'Scan source',
    'smoke:load': 'Smoke: load', 'smoke:install': 'Smoke: install',
  };
  return names[script] ?? script;
}
