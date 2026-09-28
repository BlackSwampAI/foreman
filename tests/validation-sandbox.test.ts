import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { SANDBOX_UNAVAILABLE_MESSAGE, buildSandboxArgs, defaultNetworkAccess, parseSandboxMode, probeBwrap, validationSandboxStatus, type SandboxPlanInput } from '../src/validation-sandbox.js';
import { normalizeValidationCommands } from '../src/controller.js';
import { validateWorkerOutput, verifyWorkerSnapshot, type ValidationCommand } from '../src/verified-workspace.js';

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function scratch(parent: string, prefix: string): Promise<string> { const dir = await mkdtemp(join(parent, prefix)); dirs.push(dir); return dir; }

/** A disposable Git repository plus verified Worker evidence for it. `parent` chooses which host tree the repository lives in. */
async function fixture(parent = tmpdir(), files: Record<string, string> = {}) {
  const root = await scratch(parent, 'foreman-sandbox-test-'), repo = join(root, 'repo');
  await mkdir(repo);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repo, 'README.md'), 'base\n'); git(repo, 'add', 'README.md'); git(repo, 'commit', '-qm', 'base');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const entries = Object.entries({ 'README.md': 'base\n', ...files }).map(([path, text]) => {
    const bytes = Buffer.from(text);
    return { path, kind: 'file' as const, mode: '100644' as const, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') };
  });
  const evidence = await verifyWorkerSnapshot({ repoPath: repo, pinnedBaseCommit: sha, allowedScope: entries.map(entry => entry.path), envelope: { complete: true, base_commit: sha, errors: [], entries } });
  return { root, repo, evidence };
}

const node = (script: string, ...args: string[]): ValidationCommand => ({ name: 'probe', command: process.execPath, args: ['-e', script, ...args] });
async function run(f: Awaited<ReturnType<typeof fixture>>, command: ValidationCommand, options: Partial<Parameters<typeof validateWorkerOutput>[0]> = {}) {
  const result = await validateWorkerOutput({ repoPath: f.repo, evidence: f.evidence, commands: [command], timeoutMs: 20_000, ...options });
  return result.checks[0]!;
}
const json = (output: string) => JSON.parse(output.trim().split('\n').at(-1)!);
/** Read each path and report contents or the error code. */
const READ_ALL = "const fs=require('fs'),out={};for(const [k,p] of Object.entries(JSON.parse(process.argv[1]))){try{out[k]=fs.readFileSync(p,'utf8')}catch(e){out[k]='ERR:'+e.code}}console.log(JSON.stringify(out))";
const processesMatching = (needle: string): string[] => readdirSync('/proc').filter(pid => /^\d+$/.test(pid)).filter(pid => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(needle); } catch { return false; } });
async function waitFor(check: () => boolean, ms = 8000): Promise<boolean> { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await new Promise(r => setTimeout(r, 50)); } return check(); }
const hostRealpath = (path: string): string | undefined => { try { return realpathSync(path); } catch { return undefined; } };
/** Directories strictly below `root` on the way to `file`, which lives under `root`. */
const dirsBetween = (root: string, file: string): string[] => { const found: string[] = []; for (let dir = dirname(file); dir.length > root.length; dir = dirname(dir)) found.unshift(dir); return found; };
/**
 * Inside the sandbox: list everything under each root without following symlinks; any non-directory entry counts as a file. Also reports /etc/resolv.conf.
 * Callers pass only roots that exist on the host and are masked there (/run, or /var/run linking to it), so they always exist in the sandbox too;
 * a missing root is reported as `error` and fails the comparison.
 */
const WALK_RUN = "const fs=require('fs'),path=require('path'),out={};for(const root of JSON.parse(process.argv[1])){const files=[],dirs=[];let error;const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory()){dirs.push(full);walk(full)}else files.push(full)}};try{walk(root)}catch(e){error=e.code}out[root]={files:files.sort(),dirs:dirs.sort(),error}}let resolv;try{resolv=fs.readFileSync('/etc/resolv.conf','utf8')}catch(e){resolv='ERR:'+e.code}console.log(JSON.stringify({out,resolv}))";
/**
 * Run `find` under `root` in a sandbox built straight from buildSandboxArgs, so the resolv.conf location can be faked.
 * A root that does not exist inside the sandbox has nothing visible under it (a home under the folded /home mask, when nothing is re-exposed).
 * That cannot hide a failure: bwrap or find errors still exit non-zero, and the cases that expect files fail on an empty result.
 */
function walkInSandbox(root: string, plan: Pick<SandboxPlanInput, 'workspacePath' | 'repoPath' | 'resolvConf'>) {
  const args = buildSandboxArgs({ command: '/bin/sh', args: ['-c', '[ -e "$1" ] || exit 0; find "$1" -mindepth 1 ! -type d; echo ---; find "$1" -mindepth 1 -type d', 'sh', root], env: { path: '/usr/bin:/bin', lang: 'C.UTF-8', lcAll: 'C.UTF-8' }, home: homedir(), tmpDir: tmpdir(), ...plan });
  const result = spawnSync('bwrap', args, { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  expect(result.status, result.stderr).toBe(0);
  const [files = '', directories = ''] = result.stdout.split('---\n');
  const lines = (text: string) => text.split('\n').filter(Boolean).sort();
  return { files: lines(files), dirs: lines(directories) };
}
const canWriteRun = (() => { try { accessSync('/run', constants.W_OK); return true; } catch { return false; } })();

describe('validation sandbox (bubblewrap)', () => {
  it('cannot read the operator home, Foreman data dir, source checkout, host /tmp or /run, and cannot write to them', async () => {
    const home = await scratch(homedir(), '.foreman-sandbox-home-');
    const f = await fixture(home);
    const dataDir = join(home, 'data');
    await mkdir(dataDir);
    const secrets = { home: join(home, 'credentials'), data: join(dataDir, 'state.json'), repo: join(f.repo, 'README.md'), tmp: join(tmpdir(), `foreman-sentinel-${process.pid}-${Date.now()}`) };
    await writeFile(secrets.home, 'home-secret'); await writeFile(secrets.data, 'data-secret'); await writeFile(secrets.tmp, 'tmp-secret');
    dirs.push(secrets.tmp);
    const check = await run(f, node(READ_ALL, JSON.stringify(secrets)), { sandbox: { dataDir, cacheDir: join(dataDir, 'validation-cache') } });
    expect(check).toMatchObject({ exitCode: 0, sandbox: 'bwrap' });
    expect(json(check.output)).toEqual({ home: 'ERR:ENOENT', data: 'ERR:ENOENT', repo: 'ERR:ENOENT', tmp: 'ERR:ENOENT' });

    const marks = { home: join(homedir(), `.foreman-sandbox-write-${process.pid}`), repo: join(f.repo, 'pwned'), tmp: join(tmpdir(), `foreman-sandbox-write-${process.pid}`), data: join(dataDir, 'pwned'), etc: '/etc/foreman-sandbox-write' };
    const write = await run(f, node("const fs=require('fs'),out={};for(const [k,p] of Object.entries(JSON.parse(process.argv[1]))){try{fs.writeFileSync(p,'x');out[k]='written'}catch(e){out[k]='ERR:'+e.code}}console.log(JSON.stringify(out))", JSON.stringify(marks)), { sandbox: { dataDir } });
    for (const path of Object.values(marks)) expect(existsSync(path)).toBe(false);
    expect(json(write.output)).toMatchObject({ repo: 'ERR:ENOENT', data: 'ERR:ENOENT', etc: expect.stringMatching(/^ERR:(EROFS|EACCES)$/) });
  });

  it('hides other processes and drops all capabilities', async () => {
    const f = await fixture();
    const check = await run(f, node("const fs=require('fs');console.log(JSON.stringify({pids:fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x)).map(Number),cap:fs.readFileSync('/proc/self/status','utf8').match(/CapEff:\\s*(\\w+)/)[1]}))"));
    const seen = json(check.output);
    expect(seen.pids.length).toBeLessThan(10);
    expect(Math.max(...seen.pids)).toBeLessThan(100);
    expect(seen.cap).toBe('0000000000000000');
  });

  it('shows nothing under /run and /var/run except the re-exposed resolv.conf target (when the host keeps it there) and its parent directories', async () => {
    // With systemd-resolved, /etc/resolv.conf links into /run/systemd/resolve; on a plain host it is a regular file and /run must be empty.
    const resolv = hostRealpath('/etc/resolv.conf'), roots = ['/run', '/var/run'].filter(existsSync);
    const hostText = (() => { try { return readFileSync('/etc/resolv.conf', 'utf8'); } catch (error) { return `ERR:${(error as NodeJS.ErrnoException).code}`; } })();
    const seen = json((await run(await fixture(), node(WALK_RUN, JSON.stringify(roots)))).output);
    expect(roots).toContain('/run');
    for (const root of roots) {
      const rootReal = realpathSync(root), target = resolv?.startsWith(`${rootReal}/`) ? join(root, relative(rootReal, resolv)) : undefined;
      expect(seen.out[root], root).toEqual({ files: target ? [target] : [], dirs: target ? dirsBetween(root, target).sort() : [] });
    }
    expect(seen.resolv).toBe(hostText);
  });

  it('re-exposes only the resolv.conf target inside a hidden tree, with just its parent directories (systemd-resolved layout)', async () => {
    const base = await scratch(homedir(), '.foreman-sandbox-resolv-'), other = await scratch(tmpdir(), 'foreman-sandbox-plan-');
    const target = join(realpathSync(base), 'run', 'systemd', 'resolve', 'stub-resolv.conf'), link = join(other, 'resolv.conf'), home = realpathSync(homedir());
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, 'nameserver 127.0.0.53\n'); await symlink(target, link);
    expect(walkInSandbox(home, { workspacePath: other, repoPath: other, resolvConf: link })).toEqual({ files: [target], dirs: dirsBetween(home, target).sort() });
    // A resolv.conf that is a regular file outside every hidden tree needs no re-exposing (stand-in: /etc/passwd).
    expect(walkInSandbox(home, { workspacePath: other, repoPath: other, resolvConf: '/etc/passwd' })).toEqual({ files: [], dirs: [] });
  });

  it.runIf(canWriteRun)('leaves /run empty except a fake resolv.conf target placed there', async () => {
    const runDir = `/run/foreman-test-resolv-${process.pid}`, other = await scratch(tmpdir(), 'foreman-sandbox-plan-');
    dirs.push(runDir);
    await mkdir(runDir); await writeFile(join(runDir, 'stub.conf'), 'nameserver 127.0.0.53\n');
    const link = join(other, 'resolv.conf');
    await symlink(join(runDir, 'stub.conf'), link);
    expect(walkInSandbox('/run', { workspacePath: other, repoPath: other, resolvConf: link })).toEqual({ files: [join(runDir, 'stub.conf')], dirs: [runDir] });
    expect(walkInSandbox('/run', { workspacePath: other, repoPath: other, resolvConf: '/nonexistent/resolv.conf' })).toEqual({ files: [], dirs: [] });
  });

  it('runs in a writable /workspace with a private HOME, minimal environment and the requested cwd', async () => {
    vi.stubEnv('FOREMAN_SANDBOX_SECRET_TEST', 'must-not-leak');
    const f = await fixture(tmpdir(), { 'sub/keep.txt': 'kept\n' });
    const check = await run(f, { ...node("const fs=require('fs');fs.writeFileSync('made.txt','ok');console.log(JSON.stringify({cwd:process.cwd(),made:fs.readFileSync('made.txt','utf8'),keep:fs.readFileSync('keep.txt','utf8'),home:process.env.HOME,env:Object.keys(process.env).sort()}))"), cwd: 'sub' });
    const seen = json(check.output);
    expect(check.exitCode).toBe(0);
    expect(seen).toMatchObject({ cwd: '/tmp/workspace/sub', made: 'ok', keep: 'kept\n', home: '/tmp/home' });
    expect(seen.env).toEqual(['HOME', 'LANG', 'LC_ALL', 'PATH', 'PWD', 'TMPDIR']);
    const top = await run(f, node("console.log(require('fs').readdirSync('.').sort().join(','))"));
    expect(top.output.trim()).toBe('README.md,sub');
  });

  it('shares a persistent 0700 package-manager cache across validations', async () => {
    const f = await fixture();
    const cacheDir = join(f.root, 'data', 'validation-cache');
    const first = await run(f, node("const fs=require('fs'),p=process.env.npm_config_cache;fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+'/entry','cached');console.log(JSON.stringify({names:['XDG_CACHE_HOME','npm_config_cache','npm_config_store_dir','COREPACK_HOME'].map(n=>process.env[n])}))"), { sandbox: { cacheDir } });
    expect(json(first.output).names).toEqual(['/tmp/foreman-cache/xdg', '/tmp/foreman-cache/npm', '/tmp/foreman-cache/pnpm-store', '/tmp/foreman-cache/corepack']);
    expect((await stat(cacheDir)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(cacheDir, 'npm', 'entry'), 'utf8')).toBe('cached');
    const second = await run(f, node("console.log(require('fs').readFileSync(process.env.npm_config_cache+'/entry','utf8'))"), { sandbox: { cacheDir } });
    expect(second.output.trim()).toBe('cached');
  });

  it('re-exposes a toolchain that lives under the hidden home directory', async () => {
    const home = await scratch(homedir(), '.foreman-sandbox-toolchain-');
    const prefix = join(home, 'versions', 'v1'), bin = join(prefix, 'bin');
    await mkdir(bin, { recursive: true }); await mkdir(join(prefix, 'lib'));
    await writeFile(join(prefix, 'lib', 'data.txt'), 'toolchain-data');
    await writeFile(join(bin, 'fake-tool'), '#!/bin/sh\ncat "$(dirname "$0")/../lib/data.txt"\n'); await chmod(join(bin, 'fake-tool'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    const f = await fixture();
    const byName = await run(f, { name: 'tool', command: 'fake-tool', args: [] });
    expect(byName).toMatchObject({ exitCode: 0, output: 'toolchain-data' });
    const byPath = await run(f, { name: 'tool', command: join(bin, 'fake-tool'), args: [] });
    expect(byPath).toMatchObject({ exitCode: 0, output: 'toolchain-data' });
  });

  it('kills the whole process tree when the timeout fires', async () => {
    const marker = `4321.${Math.floor(Math.random() * 1e9)}`;
    const f = await fixture();
    const pending = run(f, { name: 'sleeper', command: '/bin/sh', args: ['-c', `sleep ${marker} & sleep ${marker}; wait`] }, { timeoutMs: 3000 });
    expect(await waitFor(() => processesMatching(`sleep\0${marker}`).length >= 1)).toBe(true);
    const check = await pending;
    expect(check).toMatchObject({ timedOut: true });
    expect(check.exitCode === 0).toBe(false);
    expect(await waitFor(() => processesMatching(`sleep\0${marker}`).length === 0)).toBe(true);
  });

  it('kills the whole process tree when output exceeds the bound', async () => {
    const marker = `5432.${Math.floor(Math.random() * 1e9)}`;
    const f = await fixture();
    const check = await run(f, { name: 'chatty', command: '/bin/sh', args: ['-c', `sleep ${marker} & yes`] }, { maxOutputBytes: 4096 });
    expect(check).toMatchObject({ outputTruncated: true, sandbox: 'bwrap' });
    expect(await waitFor(() => processesMatching(`sleep\0${marker}`).length === 0)).toBe(true);
  });

  it('reports a missing command as a failed observation instead of crashing', async () => {
    const check = await run(await fixture(), { name: 'missing', command: 'definitely-not-installed-anywhere', args: [] });
    expect(check.exitCode).not.toBe(0);
    expect(check.timedOut).toBe(false);
    expect(check.output).toMatch(/definitely-not-installed-anywhere/);
  });

  it('fails closed with a clear message when bwrap is missing or unusable and never runs the command', async () => {
    const f = await fixture(), marker = join(f.root, 'ran');
    const command = node("require('fs').writeFileSync(process.argv[1],'ran')", marker);
    await expect(run(f, command, { sandbox: { bwrapPath: join(f.root, 'no-such-bwrap') } })).rejects.toThrow(SANDBOX_UNAVAILABLE_MESSAGE);
    await expect(run(f, command, { sandbox: { bwrapPath: '/bin/false' } })).rejects.toThrow(SANDBOX_UNAVAILABLE_MESSAGE);
    await expect(run(f, command, { sandbox: { mode: 'bwrap', bwrapPath: join(f.root, 'no-such-bwrap') } })).rejects.toMatchObject({ statusCode: 503 });
    expect(existsSync(marker)).toBe(false);
    expect(await validationSandboxStatus({ bwrapPath: join(f.root, 'no-such-bwrap') })).toEqual({ mode: 'bwrap', available: false });
  });

  it('mode none runs directly on the host as before, and says so', async () => {
    const f = await fixture(), secret = join(f.root, 'host-secret');
    await writeFile(secret, 'visible');
    const check = await run(f, node("const fs=require('fs');console.log(JSON.stringify({secret:fs.readFileSync(process.argv[1],'utf8'),cwd:process.cwd(),env:Object.keys(process.env).sort()}))", secret), { sandbox: { mode: 'none', bwrapPath: join(f.root, 'no-such-bwrap') } });
    const seen = json(check.output);
    expect(check).toMatchObject({ exitCode: 0, sandbox: 'none' });
    expect(seen.secret).toBe('visible');
    expect(seen.cwd).toMatch(/foreman-validation-/);
    expect(seen.env).toEqual(['LANG', 'LC_ALL', 'PATH']);
    expect(await validationSandboxStatus({ mode: 'none' })).toEqual({ mode: 'none', available: true });
  });

  it('reports the sandbox as usable on this host', async () => {
    expect(await probeBwrap()).toEqual({ ok: true });
    expect(await validationSandboxStatus()).toEqual({ mode: 'bwrap', available: true });
  });
});

/** A TCP (or, with `abstractName`, abstract-namespace Unix) listener on the host that counts connections. */
async function hostListener(abstractName?: string) {
  let connections = 0;
  const server = createTcpServer(socket => { connections++; socket.end('pong'); });
  await new Promise<void>(resolve => abstractName ? server.listen(`\0${abstractName}`, resolve) : server.listen(0, '127.0.0.1', resolve));
  return { port: abstractName ? 0 : (server.address() as AddressInfo).port, connections: () => connections, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
const CONNECT_TCP = "const c=require('net').connect({host:process.argv[1],port:Number(process.argv[2])});let data='';c.on('data',d=>data+=d);c.on('end',()=>console.log(JSON.stringify({data})));c.on('error',e=>console.log(JSON.stringify({error:e.code})))";
const CONNECT_ABSTRACT = "const c=require('net').connect({path:'\\0'+process.argv[1]});let data='';c.on('data',d=>data+=d);c.on('end',()=>console.log(JSON.stringify({data})));c.on('error',e=>console.log(JSON.stringify({error:e.code})))";
/** Bind and connect to loopback from inside: a raw TCP echo, then an HTTP request, as a test suite would. */
const LOOPBACK = "const net=require('net'),http=require('http'),os=require('os');const tcp=net.createServer(s=>s.end('inside')).listen(0,'127.0.0.1',()=>{const c=net.connect({host:'127.0.0.1',port:tcp.address().port});let data='';c.on('data',d=>data+=d);c.on('end',()=>{tcp.close();const web=http.createServer((q,r)=>r.end('web')).listen(0,'127.0.0.1',()=>{fetch('http://127.0.0.1:'+web.address().port).then(r=>r.text()).then(body=>{web.close();console.log(JSON.stringify({data,body,interfaces:Object.keys(os.networkInterfaces())}))},e=>{console.log(JSON.stringify({error:String(e.cause&&e.cause.code)}));process.exit(1)})})});c.on('error',e=>{console.log(JSON.stringify({error:e.code}));process.exit(1)})})";

describe('validation network policy (live bubblewrap)', () => {
  it('cannot connect to a TCP listener on the host loopback unless the command asks for the network', async () => {
    const listener = await hostListener();
    try {
      const f = await fixture();
      for (const network of [undefined, false]) {
        const check = await run(f, { ...node(CONNECT_TCP, '127.0.0.1', String(listener.port)), ...(network === undefined ? {} : { network }) });
        expect(check, `network ${network}`).toMatchObject({ exitCode: 0, sandbox: 'bwrap', network: false });
        expect(json(check.output)).toEqual({ error: 'ECONNREFUSED' });
      }
      expect(listener.connections()).toBe(0);

      const allowed = await run(f, { ...node(CONNECT_TCP, '127.0.0.1', String(listener.port)), network: true });
      expect(allowed).toMatchObject({ exitCode: 0, sandbox: 'bwrap', network: true });
      expect(json(allowed.output)).toEqual({ data: 'pong' });
      expect(listener.connections()).toBe(1);
    } finally { await listener.close(); }
  });

  it('cannot reach the host abstract Unix sockets without the network, and can with it', async () => {
    const name = `foreman-net-test-${process.pid}-${Date.now()}`, listener = await hostListener(name);
    try {
      const f = await fixture();
      const denied = json((await run(f, node(CONNECT_ABSTRACT, name))).output);
      expect(['ECONNREFUSED', 'ENOENT']).toContain(denied.error);
      expect(listener.connections()).toBe(0);
      expect(json((await run(f, { ...node(CONNECT_ABSTRACT, name), network: true })).output)).toEqual({ data: 'pong' });
      expect(listener.connections()).toBe(1);
    } finally { await listener.close(); }
  });

  it('has no route out (cloud metadata address, public addresses) and DNS lookups fail', async () => {
    const f = await fixture();
    const connect = "const c=require('net').connect({host:process.argv[1],port:Number(process.argv[2]),timeout:5000});c.on('connect',()=>{console.log(JSON.stringify({connected:true}));c.destroy()});c.on('timeout',()=>{console.log(JSON.stringify({error:'TIMEOUT'}));c.destroy()});c.on('error',e=>console.log(JSON.stringify({error:e.code})))";
    for (const [host, port] of [['169.254.169.254', '80'], ['8.8.8.8', '53'], ['1.1.1.1', '443']]) {
      expect(json((await run(f, node(connect, host!, port!))).output), `${host}:${port}`).toEqual({ error: 'ENETUNREACH' });
    }
    const lookup = json((await run(f, node("require('dns').lookup('example.com',(e,a)=>console.log(JSON.stringify({error:e&&e.code,address:a})))"))).output);
    expect(['ENOTFOUND', 'EAI_AGAIN']).toContain(lookup.error);
    expect(lookup.address).toBeUndefined();
  });

  it('keeps loopback up inside the private namespace: bind, connect and HTTP to 127.0.0.1 work without network', async () => {
    const check = await run(await fixture(), node(LOOPBACK));
    expect(check).toMatchObject({ exitCode: 0, network: false });
    expect(json(check.output)).toEqual({ data: 'inside', body: 'web', interfaces: ['lo'] });
    // The namespace is the same when the command is explicitly offline, and loopback also works with network on.
    const explicit = await run(await fixture(), { ...node(LOOPBACK), network: false });
    expect(json(explicit.output)).toMatchObject({ data: 'inside', body: 'web', interfaces: ['lo'] });
    const online = await run(await fixture(), { ...node(LOOPBACK), network: true });
    expect(json(online.output)).toMatchObject({ data: 'inside', body: 'web' });
  });

  it('decides per command and records the decision on every observation', async () => {
    const listener = await hostListener();
    try {
      const f = await fixture(), probe = (name: string, network?: boolean): ValidationCommand => ({ ...node(CONNECT_TCP, '127.0.0.1', String(listener.port)), name, ...(network === undefined ? {} : { network }) });
      const result = await validateWorkerOutput({ repoPath: f.repo, evidence: f.evidence, commands: [probe('install', true), probe('tests', false), probe('lint')], timeoutMs: 20_000 });
      expect(result.checks.map(check => [check.name, check.network, json(check.output).data ?? json(check.output).error])).toEqual([['install', true, 'pong'], ['tests', false, 'ECONNREFUSED'], ['lint', false, 'ECONNREFUSED']]);
      expect(listener.connections()).toBe(1);
    } finally { await listener.close(); }
  });

  it('applies the install default at execution time: a legacy command list with no network fields gives only the install the network', async () => {
    const listener = await hostListener();
    try {
      // Fake pnpm/npm/yarn that connect to the host listener (the port is read from a file inside the re-exposed toolchain prefix), so no real install runs.
      const home = await scratch(homedir(), '.foreman-sandbox-legacy-'), prefix = join(home, 'versions', 'v1'), bin = join(prefix, 'bin'), lib = join(prefix, 'lib');
      await mkdir(bin, { recursive: true }); await mkdir(lib);
      await writeFile(join(lib, 'port'), String(listener.port));
      await writeFile(join(lib, 'probe.js'), "const c=require('net').connect({host:'127.0.0.1',port:Number(require('fs').readFileSync(__dirname+'/port','utf8'))});let d='';c.on('data',x=>d+=x);c.on('end',()=>console.log(JSON.stringify({data:d})));c.on('error',e=>console.log(JSON.stringify({error:e.code})))");
      for (const tool of ['pnpm', 'npm', 'yarn']) { await writeFile(join(bin, tool), `#!/bin/sh\nexec '${process.execPath}' '${join(lib, 'probe.js')}' "$@"\n`); await chmod(join(bin, tool), 0o755); }
      vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);

      const legacy: ValidationCommand[] = [
        { name: 'pnpm install', command: 'pnpm', args: ['install', '--frozen-lockfile'] },
        { name: 'npm ci', command: 'npm', args: ['ci'] },
        { name: 'bare yarn', command: 'yarn', args: [] },
        { name: 'yarn add', command: 'yarn', args: ['add', 'left-pad'] },
        { name: 'pnpm test', command: 'pnpm', args: ['run', 'test'] },
        { name: 'npm test', command: 'npm', args: ['test'] },
        { name: 'yarn flags', command: 'yarn', args: ['--immutable'] },
        { name: 'explicit off', command: 'pnpm', args: ['install'], network: false },
        { name: 'explicit on', command: 'pnpm', args: ['run', 'test'], network: true },
      ];
      const before = structuredClone(legacy), f = await fixture();
      const result = await validateWorkerOutput({ repoPath: f.repo, evidence: f.evidence, commands: legacy, timeoutMs: 20_000 });
      expect(result.checks.map(check => [check.name, check.network, json(check.output).data ?? json(check.output).error])).toEqual([
        ['pnpm install', true, 'pong'], ['npm ci', true, 'pong'], ['bare yarn', true, 'pong'], ['yarn add', true, 'pong'],
        ['pnpm test', false, 'ECONNREFUSED'], ['npm test', false, 'ECONNREFUSED'], ['yarn flags', false, 'ECONNREFUSED'],
        ['explicit off', false, 'ECONNREFUSED'], ['explicit on', true, 'pong'],
      ]);
      expect(listener.connections()).toBe(5);
      // The stored command list is not rewritten: the default is decided when the command runs.
      expect(legacy).toEqual(before);
    } finally { await listener.close(); }
  });

  it('rejects a network flag that is not a boolean instead of guessing', async () => {
    const f = await fixture(), marker = join(f.root, 'ran');
    for (const network of ['true', 'false', 1, 0, null]) {
      await expect(run(f, { ...node("require('fs').writeFileSync(process.argv[1],'ran')", marker), network: network as unknown as boolean }), JSON.stringify(network)).rejects.toThrow('network must be a boolean');
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('mode none leaves the host network alone and says so on the observation', async () => {
    const listener = await hostListener();
    try {
      const f = await fixture();
      for (const network of [undefined, false]) {
        const check = await run(f, { ...node(CONNECT_TCP, '127.0.0.1', String(listener.port)), ...(network === undefined ? {} : { network }) }, { sandbox: { mode: 'none' } });
        expect(check).toMatchObject({ sandbox: 'none', network: true });
        expect(json(check.output)).toEqual({ data: 'pong' });
      }
      expect(listener.connections()).toBe(2);
    } finally { await listener.close(); }
  });

  it('probes bwrap with the private network namespace, so a host that cannot create one fails closed instead of running networked', async () => {
    const dir = await scratch(tmpdir(), 'foreman-fake-bwrap-'), log = join(dir, 'argv'), recording = join(dir, 'bwrap-ok'), failing = join(dir, 'bwrap-no-netns');
    await writeFile(recording, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`); await chmod(recording, 0o755);
    expect(await probeBwrap(recording)).toEqual({ ok: true });
    expect((await readFile(log, 'utf8')).split('\n')).toContain('--unshare-net');
    await writeFile(failing, '#!/bin/sh\nfor arg in "$@"; do [ "$arg" = --unshare-net ] && { echo "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted" >&2; exit 1; }; done\nexit 0\n'); await chmod(failing, 0o755);
    const f = await fixture(), marker = join(f.root, 'ran');
    const command = node("require('fs').writeFileSync(process.argv[1],'ran')", marker);
    await expect(run(f, command, { sandbox: { bwrapPath: failing } })).rejects.toThrow(/Validation sandbox unavailable.*RTM_NEWADDR/);
    await expect(run(f, { ...command, network: true }, { sandbox: { bwrapPath: failing } })).rejects.toThrow(SANDBOX_UNAVAILABLE_MESSAGE);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('sandbox mount plan (pure)', () => {
  async function plan(overrides: Partial<SandboxPlanInput> = {}) {
    const base = await scratch(tmpdir(), 'foreman-plan-');
    for (const name of ['home', 'repo', 'data', 'workspace']) await mkdir(join(base, name));
    const input: SandboxPlanInput = {
      workspacePath: join(base, 'workspace'), command: 'true', args: [], env: { path: '/usr/bin:/bin', lang: 'C.UTF-8', lcAll: 'C.UTF-8' },
      home: join(base, 'home'), tmpDir: tmpdir(), repoPath: join(base, 'repo'), dataDir: join(base, 'data'), resolvConf: '/nonexistent/resolv.conf', ...overrides,
    };
    return { base, input, args: buildSandboxArgs(input) };
  }
  const flags = (args: string[], flag: string) => args.flatMap((arg, index) => arg === flag ? [args[index + 1]!] : []);
  const triples = (args: string[], flag: string) => args.flatMap((arg, index) => arg === flag ? [[args[index + 1]!, args[index + 2]!]] : []);

  it('starts from a read-only root, hides sensitive trees, then mounts the workspace', async () => {
    const { args } = await plan();
    expect(args.slice(0, 7)).toEqual(['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL']);
    const rootBind = args.indexOf('--ro-bind');
    expect(args.slice(rootBind, rootBind + 3)).toEqual(['--ro-bind', '/', '/']);
    const masks = flags(args, '--tmpfs');
    expect(masks).toEqual(expect.arrayContaining(['/tmp', ...['/home', '/root', '/run'].filter(existsSync)]));
    expect(args.lastIndexOf('--tmpfs')).toBeGreaterThan(rootBind);
    expect(args.indexOf('--bind')).toBeGreaterThan(args.lastIndexOf('--tmpfs'));
    expect(args).toEqual(expect.arrayContaining(['--proc', '/proc', '--dev', '/dev', '--dir', '/tmp/home', '--chdir', '/tmp/workspace']));
    expect(args.slice(args.indexOf('--') + 1)).toEqual(['true']);
    expect(triples(args, '--bind')).toEqual([[expect.stringMatching(/workspace$/), '/tmp/workspace']]);
  });

  it('masks the source repository, data dir and home even outside the default hidden trees, following symlinks', async () => {
    const { base, args } = await plan({ repoPath: '/usr/lib', dataDir: '/usr/share', home: '/usr/bin' });
    expect(flags(args, '--tmpfs')).toEqual(expect.arrayContaining(['/usr/lib', '/usr/share', '/usr/bin']));
    const link = join(base, 'repo-link');
    await symlink('/usr/share', link);
    const linked = flags((await plan({ repoPath: link })).args, '--tmpfs');
    expect(linked).toContain('/usr/share');
    expect(linked).not.toContain(link);
    const masks = flags(args, '--tmpfs');
    expect(new Set(masks).size).toBe(masks.length);
  });

  it('skips missing paths and folds nested paths into their parent mask', async () => {
    const { args } = await plan({ repoPath: '/no/such/checkout', dataDir: undefined });
    expect(flags(args, '--tmpfs')).not.toContain('/no/such/checkout');
    const nested = flags((await plan()).args, '--tmpfs');
    expect(nested.some(path => path.includes('foreman-plan-'))).toBe(false);
  });

  it('re-exposes PATH toolchain directories under a hidden home, after the masks and read-only', async () => {
    const { input } = await plan();
    const local = join(input.home, '.local', 'bin'), nvm = join(input.home, '.nvm', 'versions', 'node', 'v22', 'bin');
    await mkdir(local, { recursive: true }); await mkdir(nvm, { recursive: true });
    await writeFile(join(nvm, 'node'), '#!/bin/sh\n'); await chmod(join(nvm, 'node'), 0o755);
    await writeFile(join(local, 'pnpm'), '#!/bin/sh\n'); await chmod(join(local, 'pnpm'), 0o755);
    const args = buildSandboxArgs({ ...input, command: 'pnpm', env: { ...input.env, path: `${local}:${nvm}:/usr/bin:/bin` } });
    const binds = triples(args, '--ro-bind');
    const prefix = join(input.home, '.nvm', 'versions', 'node', 'v22');
    expect(binds).toContainEqual([local, local]);
    expect(binds).toContainEqual([prefix, prefix]);
    expect(binds).not.toContainEqual([nvm, nvm]);
    for (const [src] of binds.slice(1)) expect(args.indexOf(src!)).toBeGreaterThan(args.lastIndexOf('--tmpfs'));
  });

  it('never re-exposes a hidden root itself or the shallow directory that holds a stray binary', async () => {
    const { input } = await plan();
    await mkdir(join(input.home, 'bin')); await mkdir(join(input.home, '.tool'));
    for (const file of [join(input.home, 'bin', 'x'), join(input.home, '.tool', 'y')]) { await writeFile(file, '#!/bin/sh\n'); await chmod(file, 0o755); }
    for (const [command, path] of [[join(input.home, 'bin', 'x'), '/usr/bin'], [join(input.home, '.tool', 'y'), '/usr/bin'], ['true', `${input.home}:${input.repoPath}:${input.dataDir}:/usr/bin`]] as const) {
      const exposed = triples(buildSandboxArgs({ ...input, command, env: { ...input.env, path } }), '--ro-bind').filter(([src]) => src !== '/').map(([src]) => src);
      expect(exposed).not.toContain(input.home);
      expect(exposed).not.toContain(join(input.home, '.tool'));
      expect(exposed).not.toContain(input.repoPath);
      expect(exposed).not.toContain(input.dataDir);
    }
  });

  it('exposes a symlinked PATH entry at both its target and its own path', async () => {
    const { base, input } = await plan();
    const target = join(base, 'tools', 'bin');
    await mkdir(target, { recursive: true });
    const link = join(input.home, 'bin');
    await symlink(target, link);
    const binds = triples(buildSandboxArgs({ ...input, env: { ...input.env, path: `${link}:/usr/bin` } }), '--ro-bind');
    expect(binds).toContainEqual([target, link]);
  });

  it('re-exposes resolv.conf when it is a symlink into a hidden tree, and exposes nothing else', async () => {
    const { base, input } = await plan();
    const real = join(base, 'resolved.conf'), link = join(base, 'resolv.conf');
    await writeFile(real, 'nameserver 127.0.0.53\n'); await symlink(real, link);
    const exposed = (resolvConf: string) => triples(buildSandboxArgs({ ...input, resolvConf }), '--ro-bind').filter(([src]) => src !== '/');
    expect(exposed(link)).toEqual([[real, real]]);
    expect(exposed('/etc/passwd')).toEqual([]);
    expect(exposed(join(base, 'missing.conf'))).toEqual([]);
  });

  it('adds operator-supplied read-only paths and rejects ones that would defeat the masks', async () => {
    const { base, input } = await plan();
    const volta = join(input.home, '.volta');
    await mkdir(volta);
    expect(triples(buildSandboxArgs({ ...input, roPaths: [volta, join(base, 'does-not-exist')] }), '--ro-bind')).toContainEqual([volta, volta]);
    expect(() => buildSandboxArgs({ ...input, roPaths: ['relative/path'] })).toThrow('absolute');
    expect(() => buildSandboxArgs({ ...input, roPaths: [input.home] })).toThrow('would expose');
    expect(() => buildSandboxArgs({ ...input, roPaths: [input.repoPath] })).toThrow('would expose');
    expect(() => buildSandboxArgs({ ...input, roPaths: ['/'] })).toThrow('would expose');
  });

  it('wires the cache directory and a scrubbed environment', async () => {
    vi.stubEnv('FOREMAN_SANDBOX_SECRET_TEST', 'must-not-leak');
    const { base, input } = await plan({ cwd: 'a/b', cacheDir: undefined });
    const without = buildSandboxArgs(input);
    expect(without).not.toContain('/tmp/foreman-cache');
    expect(without).toContain('/tmp/workspace/a/b');
    expect(without.join(' ')).not.toContain('must-not-leak');
    const cacheDir = join(base, 'data', 'validation-cache');
    await mkdir(cacheDir);
    const withCache = buildSandboxArgs({ ...input, cacheDir });
    expect(triples(withCache, '--bind')).toContainEqual([cacheDir, '/tmp/foreman-cache']);
    const env = Object.fromEntries(withCache.flatMap((arg, index) => arg === '--setenv' ? [[withCache[index + 1]!, withCache[index + 2]!]] : []));
    expect(Object.keys(env).sort()).toEqual(['COREPACK_HOME', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'YARN_CACHE_FOLDER', 'npm_config_cache', 'npm_config_store_dir', 'pnpm_config_store_dir']);
    expect(withCache.indexOf('--clearenv')).toBeLessThan(withCache.indexOf('--setenv'));
  });

  it('unshares the network namespace unless the command explicitly asks for the network', async () => {
    const { input } = await plan();
    for (const network of [undefined, false]) {
      const args = buildSandboxArgs({ ...input, network });
      expect(args, `network ${network}`).toContain('--unshare-net');
      expect(args.indexOf('--unshare-net')).toBeLessThan(args.indexOf('--ro-bind'));
    }
    expect(buildSandboxArgs({ ...input, network: true })).not.toContain('--unshare-net');
    // Only a real `true` opens the network: a truthy string or number does not.
    for (const network of ['true', 1, {}]) expect(buildSandboxArgs({ ...input, network: network as unknown as boolean })).toContain('--unshare-net');
    // The flag is the only difference between the two plans, and it is a bwrap option, not part of the sandboxed command's argv.
    const offline = buildSandboxArgs(input), online = buildSandboxArgs({ ...input, network: true });
    expect(offline.filter(arg => arg !== '--unshare-net')).toEqual(online);
    expect(offline.indexOf('--unshare-net')).toBeLessThan(offline.indexOf('--'));
    expect(buildSandboxArgs({ ...input, network: true, args: ['--unshare-net'] }).slice(-2)).toEqual(['true', '--unshare-net']);
  });

  it('recognises package-manager installs for the compatibility default and nothing else', () => {
    const table: Array<[string, string[], boolean]> = [
      ['pnpm', ['install', '--frozen-lockfile'], true], ['pnpm', ['i'], true], ['pnpm', ['ci'], true], ['pnpm', ['add', 'left-pad'], true],
      ['npm', ['ci'], true], ['npm', ['install'], true], ['npm', ['i', '-D', 'x'], true], ['npm', ['add', 'x'], true],
      ['yarn', [], true], ['yarn', ['install', '--immutable'], true], ['yarn', ['add', 'x'], true], [' pnpm ', ['install'], true],
      ['pnpm', ['test'], false], ['pnpm', ['run', 'install'], false], ['pnpm', ['--filter', 'app', 'install'], false], ['pnpm', [], false], ['npm', [], false],
      ['npm', ['run', 'build'], false], ['npm', ['test'], false], ['yarn', ['test'], false], ['yarn', ['--immutable'], false],
      ['npx', ['install'], false], ['bun', ['install'], false], ['cargo', ['test'], false], ['go', ['test', './...'], false], ['python', ['-m', 'pytest'], false],
      ['/usr/local/bin/pnpm', ['install'], false], ['sh', ['-c', 'pnpm install'], false], ['true', [], false],
    ];
    for (const [command, args, expected] of table) expect(defaultNetworkAccess(command, args), `${command} ${args.join(' ')}`).toBe(expected);
  });
});

describe('sandbox configuration', () => {
  it('parses the mode, defaulting to bwrap', () => {
    expect(parseSandboxMode(undefined)).toBe('bwrap');
    expect(parseSandboxMode('')).toBe('bwrap');
    expect(parseSandboxMode(' None ')).toBe('none');
    expect(parseSandboxMode('docker')).toBeUndefined();
  });

  it('loadConfig defaults to bwrap with a cache under the data dir and warns only for none', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      vi.stubEnv('FOREMAN_DATA_DIR', '/srv/foreman-data'); vi.stubEnv('FOREMAN_VALIDATION_SANDBOX', ''); vi.stubEnv('FOREMAN_VALIDATION_SANDBOX_RO_PATHS', '');
      expect(loadConfig().validationSandbox).toEqual({ mode: 'bwrap', roPaths: [], dataDir: '/srv/foreman-data', cacheDir: '/srv/foreman-data/validation-cache' });
      const warnings = () => write.mock.calls.map(call => String(call[0])).filter(text => text.startsWith('WARNING:'));
      expect(warnings()).toEqual([]);
      vi.stubEnv('FOREMAN_VALIDATION_SANDBOX', 'none'); vi.stubEnv('FOREMAN_VALIDATION_SANDBOX_RO_PATHS', '/opt/a, /opt/b ,');
      expect(loadConfig().validationSandbox).toMatchObject({ mode: 'none', roPaths: ['/opt/a', '/opt/b'] });
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toMatch(/^WARNING: FOREMAN_VALIDATION_SANDBOX=none.*\n$/);
      vi.stubEnv('FOREMAN_VALIDATION_SANDBOX', 'chroot');
      expect(() => loadConfig()).toThrow('FOREMAN_VALIDATION_SANDBOX must be "bwrap" or "none"');
      vi.stubEnv('FOREMAN_VALIDATION_SANDBOX', 'bwrap'); vi.stubEnv('FOREMAN_VALIDATION_SANDBOX_RO_PATHS', 'relative/dir');
      expect(() => loadConfig()).toThrow('absolute paths');
    } finally { write.mockRestore(); }
  });
});

describe('validation command network flag', () => {
  const list = (...commands: unknown[]) => JSON.stringify(commands);

  it('FOREMAN_VALIDATION_COMMANDS keeps an explicit flag and defaults an unflagged command by the install rule', () => {
    vi.stubEnv('FOREMAN_VALIDATION_COMMANDS', list(
      { name: 'Install', command: 'pnpm', args: ['install', '--frozen-lockfile'] },
      { name: 'Install offline', command: 'npm', args: ['ci', '--offline'], network: false },
      { name: 'Tests', command: 'pnpm', args: ['test'] },
      { name: 'Cargo', command: 'cargo', args: ['test'], network: true },
      { name: 'Sub', command: 'yarn', args: [], cwd: 'app' },
    ));
    expect(loadConfig().validationCommands).toEqual([
      { name: 'Install', command: 'pnpm', args: ['install', '--frozen-lockfile'], network: true },
      { name: 'Install offline', command: 'npm', args: ['ci', '--offline'], network: false },
      { name: 'Tests', command: 'pnpm', args: ['test'], network: false },
      { name: 'Cargo', command: 'cargo', args: ['test'], network: true },
      { name: 'Sub', command: 'yarn', args: [], cwd: 'app', network: true },
    ]);
  });

  it('FOREMAN_VALIDATION_COMMANDS accepts only true or false', () => {
    for (const network of ['true', 'false', 1, 0, null, {}, []]) {
      vi.stubEnv('FOREMAN_VALIDATION_COMMANDS', list({ name: 'Install', command: 'pnpm', args: ['install'], network }));
      expect(() => loadConfig(), JSON.stringify(network)).toThrow('FOREMAN_VALIDATION_COMMANDS must be a JSON array of {name,command,args,cwd?,network?} where network is true or false');
    }
  });

  it('task-start validation commands: explicit flag, install default, strict booleans', () => {
    expect(normalizeValidationCommands([
      { name: ' Install ', command: ' pnpm ', args: ['install'] },
      { name: 'Tests', command: 'pnpm', args: ['test'] },
      { name: 'Cargo', command: 'cargo', args: ['test'], network: true, cwd: 'crate' },
      { name: 'Offline install', command: 'npm', args: ['ci'], network: false },
    ])).toEqual([
      { name: 'Install', command: 'pnpm', args: ['install'], network: true },
      { name: 'Tests', command: 'pnpm', args: ['test'], network: false },
      { name: 'Cargo', command: 'cargo', args: ['test'], cwd: 'crate', network: true },
      { name: 'Offline install', command: 'npm', args: ['ci'], network: false },
    ]);
    for (const network of ['true', 'false', 1, 0, null, {}]) {
      const attempt = () => normalizeValidationCommands([{ name: 'Install', command: 'pnpm', args: ['install'], network }]);
      expect(attempt, JSON.stringify(network)).toThrow('network must be true or false');
      expect(attempt, JSON.stringify(network)).toThrow(expect.objectContaining({ statusCode: 422 }));
    }
  });
});
