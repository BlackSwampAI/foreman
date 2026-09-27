import { dirname } from 'node:path';

/**
 * Build the base bwrap argument list for a sandboxed CLI run.
 * When readOnlyWorkspace=true the workspace directory is mounted with --ro-bind
 * instead of --bind, preventing the CLI from writing to it.
 */
export function bwrapBaseArgs(ws, runtime = [], readOnlyWorkspace = false, mountAuth = true) {
  const dirs = new Set(['/tmp/cli-home', '/opt', '/etc', '/etc/ssl', '/etc/ssl/certs']);
  for (const file of runtime) {
    let parent = dirname(file);
    while (parent !== '/') { dirs.add(parent); parent = dirname(parent); }
  }
  const dirArgs = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length).flatMap(dir => ['--dir', dir]);
  const mounts = runtime.flatMap(file => ['--ro-bind', file, file]);
  const resolverMounts = ['/etc/hosts','/etc/nsswitch.conf','/etc/resolv.conf'].flatMap(path => ['--ro-bind', path, path]);
  return ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', ...dirArgs, ...mounts, ...resolverMounts, readOnlyWorkspace ? '--ro-bind' : '--bind', ws.dir, '/workspace', '--chdir', '/workspace', ...(mountAuth ? ['--ro-bind', ws.authDir, '/auth'] : [])];
}
