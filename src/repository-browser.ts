import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { readdir, realpath, stat } from 'node:fs/promises';

export interface RepositoryBrowserEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export async function browseRepositories(requestedPath?: string): Promise<{
  currentPath: string;
  parentPath: string | null;
  entries: RepositoryBrowserEntry[];
  roots: Array<{ name: string; path: string }>;
  truncated: boolean;
}> {
  const currentPath = await realpath(resolve(requestedPath?.trim() || homedir()));
  if (!(await stat(currentPath)).isDirectory()) throw Object.assign(new Error('Choose a directory'), { statusCode: 400 });
  const names = await readdir(currentPath, { withFileTypes: true });
  const directories = names.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name));
  const entries: RepositoryBrowserEntry[] = [];
  for (const entry of directories.slice(0, 300)) {
    const path = join(currentPath, entry.name);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isDirectory()) continue;
    const git = await stat(join(path, '.git')).catch(() => undefined);
    entries.push({ name: entry.name, path, isGitRepo: Boolean(git?.isDirectory() || git?.isFile()) });
  }
  const rootCandidates = [
    { name: 'Home', path: homedir() },
    { name: 'Projects', path: join(homedir(), 'Projects') },
    { name: 'Computer', path: resolve('/') },
  ];
  const roots = [];
  for (const root of rootCandidates) {
    const info = await stat(root.path).catch(() => undefined);
    if (info?.isDirectory()) roots.push(root);
  }
  return {
    currentPath,
    parentPath: dirname(currentPath) === currentPath ? null : dirname(currentPath),
    entries,
    roots,
    truncated: directories.length > 300,
  };
}

export function repositoryName(path: string): string {
  return basename(path) || path;
}
