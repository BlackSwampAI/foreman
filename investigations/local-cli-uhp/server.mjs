#!/usr/bin/env node
// Experimental host-side UHP adapter for already authenticated CLI sessions.
// External to Foreman core. It never reads, copies, or prints credential files.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const VERSION = '2026-09-12';
const PORT = Number(process.env.LOCAL_CLI_UHP_PORT ?? 8787);
const STATE = resolve(process.env.LOCAL_CLI_UHP_STATE ?? join(tmpdir(), 'local-cli-uhp-state.json'));
const ROOT = resolve(process.env.LOCAL_CLI_UHP_WORK ?? join(tmpdir(), 'local-cli-uhp-work'));
if (ROOT !== tmpdir() && !ROOT.startsWith(`${tmpdir()}/`)) throw new Error('LOCAL_CLI_UHP_WORK must be under the system temporary directory');
const MAX_PROMPT = 16_000;
const MAX_OUTPUT = 64_000;
const MAX_TIMEOUT = 120;
const HARNESS = {
  claude: { id: 'claude-code', bin: process.env.CLAUDE_BIN ?? 'claude', authDir: process.env.CLAUDE_CONFIG_DIR, model: process.env.CLAUDE_MODEL },
  codex: { id: 'codex-cli', bin: process.env.CODEX_BIN ?? 'codex', authDir: process.env.CODEX_HOME, model: process.env.CODEX_MODEL },
};
const tasks = new Map();
let state = { keys: {}, responses: {} };

async function persist() {
  await mkdir(resolve(STATE, '..'), { recursive: true });
  const temp = `${STATE}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
  await rename(temp, STATE);
}
async function load() {
  try { state = JSON.parse(await readFile(STATE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const [id, r] of Object.entries(state.responses)) {
    if (r.status === 'in_progress') { r.status = 'failed'; r.error = { message: 'Server restarted before CLI completion; replay will not spawn a duplicate' }; await persist(); }
    tasks.set(id, { response: r });
  }
}
function send(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'UHP-Version': VERSION, ...extra }); res.end(JSON.stringify(body));
}
function body(req) { return new Promise((resolveBody, reject) => { let s=''; req.on('data', c => { s += c; if (s.length > 256_000) reject(Error('body too large')); }); req.on('end', () => { try { resolveBody(JSON.parse(s || '{}')); } catch { reject(Error('invalid JSON')); } }); req.on('error', reject); }); }
function event(res, type, sequence, response) { res.write(`data: ${JSON.stringify({ type, sequence_number: sequence, response })}\n\n`); }
function cliFor(harnessId) { return Object.values(HARNESS).find(h => h.id === harnessId); }
function configured(h) { return !!h?.authDir && typeof h.model === 'string' && h.model.trim() !== '' && h.model.trim().toLowerCase() !== 'undefined'; }
function outputText(r) { return typeof r.output_text === 'string' ? r.output_text : ''; }
function reportedModel(value) { return typeof value === 'string' && value.trim() !== '' && value.trim().toLowerCase() !== 'undefined' ? value.trim() : undefined; }

function parseClaude(text) {
  const events = text.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const result = [...events].reverse().find(e => e.type === 'result');
  const init = events.find(e => e.type === 'system' && e.subtype === 'init');
  return { text: typeof result?.result === 'string' ? result.result : '', model: reportedModel(result?.model) ?? reportedModel(init?.model), session: result?.session_id ?? init?.session_id, isError: result?.is_error === true || (typeof result?.subtype === 'string' && result.subtype.startsWith('error')), usage: result?.usage && typeof result.usage === 'object' ? result.usage : undefined };
}
function parseCodex(text) {
  const events = text.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const done = [...events].reverse().find(e => e.type === 'turn.completed');
  const thread = events.find(e => e.type === 'thread.started');
  const messages = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => e.item.text).filter(x => typeof x === 'string');
  const usage = done?.usage;
  return { text: messages.join('\n'), model: reportedModel(done?.model) ?? reportedModel(thread?.model), session: thread?.thread_id, usage: usage && typeof usage === 'object' ? usage : undefined };
}
function cliArgs(kind, model, timeout, maxStep) {
  if (kind === 'claude') return ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--max-turns', String(Math.min(maxStep, 10)), '--tools', ''];
  return ['exec', '--json', '--ephemeral', '--sandbox', 'read-only', '--model', model, '-'];
}

async function runTask(record, prompt) {
  const h = cliFor(record.metadata.harness_id), kind = h.id === 'claude-code' ? 'claude' : 'codex-cli';
  const work = join(ROOT, record.id); await mkdir(work, { recursive: true, mode: 0o700 });
  const inheritedNames = new Set(['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TERM','TMPDIR','TMP','TEMP','XDG_RUNTIME_DIR','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => inheritedNames.has(name)));
  Object.assign(env, kind === 'claude' ? { CLAUDE_CONFIG_DIR: h.authDir } : { CODEX_HOME: h.authDir });
  const args = cliArgs(kind, record.requested_model, record.timeout_seconds, record.max_step);
  const child = spawn(h.bin, args, { cwd: work, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const active = tasks.get(record.id); active.child = child;
  let out = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { out = (out + chunk).slice(-MAX_OUTPUT * 3); });
  child.stderr.on('data', () => {}); // Drain without retaining or exposing stderr, which may contain credentials.
  child.stdin.on('error', () => {});
  let spawnError;
  let killTimer;
  const timer = setTimeout(() => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000); }, record.timeout_seconds * 1000);
  child.stdin.end(prompt);
  const exit = await new Promise(resolveExit => {
    child.once('error', error => { spawnError = error; resolveExit({ code: null, signal: null }); });
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
  let parsed = kind === 'claude' ? parseClaude(out) : parseCodex(out);
  if (parsed.text.length > MAX_OUTPUT) parsed.text = parsed.text.slice(0, MAX_OUTPUT);
  const missingReportedIdentity = !parsed.model || !parsed.session;
  record.status = active.cancelRequested ? 'cancelled' : spawnError ? 'failed' : parsed.isError || missingReportedIdentity ? 'failed' : exit.code === 0 ? 'completed' : exit.signal === 'SIGTERM' ? 'incomplete' : 'failed';
  record.output_text = parsed.text;
  if (parsed.model) record.model = parsed.model;
  if (parsed.session) { record.session_id = parsed.session; record.metadata.session_id = parsed.session; }
  if (parsed.usage) record.usage = normalizeCliUsage(kind, parsed.usage);
  if (kind === 'codex-cli') record.metadata.ignored_fields = ['max_step'];
  if (record.model && record.model !== record.requested_model) {
    record.metadata.requested_model = record.requested_model;
    record.metadata.model_fallback = true;
  }
  if (record.status !== 'completed') record.error = { message: spawnError ? 'CLI could not be started' : parsed.isError ? 'Claude Code reported an unsuccessful task' : missingReportedIdentity ? 'CLI did not report an actual model and session id' : active.cancelRequested ? 'CLI task was cancelled' : exit.signal ? `CLI terminated by ${exit.signal}` : 'CLI exited unsuccessfully' };
  await persist();
  active.resolve?.();
}

function normalizeCliUsage(kind, value) {
  const usage = {};
  const input = value.input_tokens ?? value.inputTokens;
  const output = value.output_tokens ?? value.outputTokens;
  const cached = value.cached_input_tokens ?? value.cachedInputTokens ?? (kind === 'claude' ? value.cache_read_input_tokens : undefined);
  if (Number.isFinite(input)) usage.input_tokens = input;
  if (Number.isFinite(output)) usage.output_tokens = output;
  if (Number.isFinite(value.total_tokens)) usage.total_tokens = value.total_tokens;
  if (Number.isFinite(cached)) usage.input_tokens_details = { cached_tokens: cached };
  return usage;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/v1/uhp') return send(res, 200, { protocol: 'uhp', versions: [VERSION], default_version: VERSION, implementation: { name: 'local-cli-uhp', experimental: true }, capabilities: { streaming: true, idempotency: true, sessions: false, cancellation: true } });
    if (req.method === 'GET' && url.pathname === '/v1/harnesses') return send(res, 200, { harnesses: Object.values(HARNESS).filter(configured).map(h => ({ id: h.id, name: h.id })) });
    const models = url.pathname.match(/^\/v1\/harnesses\/([^/]+)\/models$/);
    if (req.method === 'GET' && models) { const h = cliFor(decodeURIComponent(models[1])); return send(res, h && configured(h) ? 200 : 404, h && configured(h) ? { models: [{ id: h.model, available: true, name: h.model }] } : { models: [] }); }
    const responsePath = url.pathname.match(/^\/v1\/responses\/([^/]+)$/);
    if (req.method === 'GET' && responsePath) { const r = state.responses[decodeURIComponent(responsePath[1])]; return r ? send(res, 200, r) : send(res, 404, { error: { code: 'not_found' } }); }
    const cancelPath = url.pathname.match(/^\/v1\/responses\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelPath) { const t = tasks.get(decodeURIComponent(cancelPath[1])); if (!t) return send(res, 404, { error: { code: 'not_found' } }); if (t.child && t.response.status === 'in_progress') { t.cancelRequested = true; t.child.kill('SIGTERM'); } return send(res, 200, { status: t.response.status === 'in_progress' ? 'cancelling' : t.response.status }); }
    if (req.method === 'POST' && url.pathname === '/v1/responses') {
      const key = req.headers['idempotency-key']; if (typeof key !== 'string' || !key) return send(res, 400, { error: { code: 'idempotency_key_required' } });
      const prior = state.keys[key];
      if (prior) { const existing = state.responses[prior]; if (!existing) return send(res, 503, { error: { code: 'intent_unresolved' } }); return streamResponse(res, existing); }
      const b = await body(req); const harnessId = b.metadata?.harness_id; const h = cliFor(harnessId);
      if (!h || !configured(h)) return send(res, 409, { error: { code: 'provider_connection_unavailable', message: 'Configure the existing host CLI auth directory and select its harness before discovery/submission' } });
      if (typeof b.input !== 'string' || !b.input.trim() || b.input.length > MAX_PROMPT) return send(res, 400, { error: { code: 'prompt_limit', message: `input must be 1-${MAX_PROMPT} characters` } });
      if (b.model !== h.model) return send(res, 409, { error: { code: 'model_unavailable' } });
      const timeout = Number(b.timeout_seconds ?? 60), steps = Number(b.max_step ?? 1);
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT || !Number.isInteger(steps) || steps < 1 || steps > 10) return send(res, 400, { error: { code: 'bounds_invalid' } });
      const id = `resp_${randomUUID()}`;
      const record = { id, object: 'response', status: 'in_progress', requested_model: h.model, metadata: { ...b.metadata, harness_id: h.id }, timeout_seconds: timeout, max_step: steps };
      state.keys[key] = id; state.responses[id] = record; const task = { response: record, resolve: null }; tasks.set(id, task);
      await persist(); // durable idempotency intent before spawning any CLI process
      runTask(record, b.input).catch(async () => { record.status = 'failed'; record.error = { message: 'CLI task failed internally' }; await persist(); task.resolve?.(); });
      return streamResponse(res, record, task);
    }
    send(res, 404, { error: { code: 'not_found' } });
  } catch (e) { if (!res.headersSent) send(res, 500, { error: { code: 'internal_error', message: String(e.message).slice(0, 500) } }); else res.end(); }
});
function streamResponse(res, record, task = tasks.get(record.id)) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'UHP-Version': VERSION });
  event(res, 'response.created', 0, { id: record.id, object: 'response', status: 'in_progress', metadata: record.metadata });
  const finish = () => {
    const r = record; const type = `response.${r.status}`;
    event(res, type, 1, r); res.end();
  };
  if (record.status !== 'in_progress') finish();
  else { task.resolve = finish; reqClose(res, () => { /* disconnect never cancels durable task */ }); }
}
function reqClose(res, fn) { res.on('close', fn); }

await load();
await mkdir(ROOT, { recursive: true, mode: 0o700 });
server.listen(PORT, '127.0.0.1', () => console.log(`experimental local CLI UHP listening on 127.0.0.1:${PORT}`));
