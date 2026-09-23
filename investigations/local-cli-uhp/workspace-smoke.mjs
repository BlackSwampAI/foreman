#!/usr/bin/env node
// One authorized, bounded Claude workspace smoke. Never invoked by tests.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { UhpClient } from '../../dist/uhp.js';
import { snapshotGitCommit } from '../../dist/git-workspace.js';
import { verifyBridgeWorkspace } from './workspace-verifier.mjs';

const [baseUrl, repoPath, baseCommit, model] = process.argv.slice(2);
if (!baseUrl || !repoPath || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseCommit ?? '') || !model) {
  throw new Error('Usage: node workspace-smoke.mjs <loopback-base-url> <fixture-repo> <full-base-commit-sha> <explicit-model>');
}
const harnessId = 'claude-code';
const allowedScope = ['README.md'];
const prompt = 'Edit only README.md. Add a short section titled "Bridge smoke" with one sentence explaining why deterministic tests help. Preserve the rest of the file. Do not inspect or change any other path. Return a short completion note.';
const keyFile = resolve(process.env.LOCAL_CLI_UHP_SMOKE_KEY_FILE ?? '/tmp/local-cli-uhp-workspace-smoke-key.json');
await mkdir(dirname(keyFile), { recursive: true });
let saved;
try {
  saved = JSON.parse(await readFile(keyFile, 'utf8'));
  if (saved.baseUrl !== baseUrl || saved.harnessId !== harnessId || saved.model !== model || saved.baseCommit !== baseCommit || saved.prompt !== prompt) throw new Error('Persisted idempotency record belongs to a different smoke; select a new key file for another task');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  saved = { key: `foreman-workspace-smoke-${randomUUID()}`, baseUrl, harnessId, model, baseCommit, prompt };
  await writeFile(keyFile, `${JSON.stringify(saved)}\n`, { mode: 0o600, flag: 'wx' });
}

const client = new UhpClient({ baseUrl, timeoutMs: 120_000, streamInactivityTimeoutMs: 60_000 });
const localBase = await snapshotGitCommit(repoPath, baseCommit);
if (localBase.commit !== baseCommit.toLowerCase()) throw new Error('Local Git did not resolve the supplied full base commit SHA exactly');
const discovery = await client.discover(true);
if (discovery.capabilities.idempotency !== true || discovery.capabilities.streaming !== true) throw new Error('Bridge must advertise UHP idempotency and streaming');
const rawDiscovery = await fetch(new URL('v1/uhp', baseUrl));
if (!rawDiscovery.ok) throw new Error(`UHP discovery failed (${rawDiscovery.status})`);
const rawInfo = await rawDiscovery.json();
const ext = rawInfo.capabilities?.extensions?.foreman_workspace_bridge_v1;
if (ext?.version !== 1 || ext.seed !== true || ext.complete_snapshot !== true || ext.execution_boundary !== 'bubblewrap') throw new Error('Bridge has not advertised the required workspace snapshot and execution boundary');

const extension = new URL('extensions/foreman-workspace/v1/workspaces', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
let seeded;
if (saved.workspaceId) seeded = { workspace_id: saved.workspaceId, base_commit: saved.baseCommit };
else {
  const seedResponse = await fetch(extension, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base_commit: baseCommit }) });
  if (!seedResponse.ok) throw new Error(`Workspace seed failed (${seedResponse.status})`);
  seeded = await seedResponse.json();
  if (seeded.base_commit?.toLowerCase() !== baseCommit.toLowerCase() || typeof seeded.workspace_id !== 'string' || !seeded.workspace_id) throw new Error('Bridge did not seed the requested exact base commit');
  saved.workspaceId = seeded.workspace_id;
  const tempKeyFile = `${keyFile}.tmp`;
  await writeFile(tempKeyFile, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
  await rename(tempKeyFile, keyFile);
}

// UhpClient remains the discovery/retrieval client. This extension-specific submission
// adds workspace_id to standard UHP metadata without changing the portable UHP contract.
const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Idempotency-Key': saved.key, 'UHP-Version': discovery.version };
const response = await fetch(new URL('v1/responses', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`), {
  method: 'POST', headers, signal: AbortSignal.timeout(110_000),
  body: JSON.stringify({ input: prompt, model, metadata: { harness_id: harnessId, workspace_id: seeded.workspace_id, foreman_submission_id: saved.key, foreman_assignment_id: saved.key, foreman_run_id: saved.key, foreman_role_id: 'worker', foreman_task_id: saved.key, foreman_project_id: 'local-cli-uhp-workspace-smoke' }, stream: true, store: true, timeout_seconds: 90, max_step: 3 }),
});
if (!response.ok) throw new Error(`UHP task submission failed (${response.status})`);
if (response.headers.get('UHP-Version') !== discovery.version) throw new Error('UHP task response version changed');
const events = await readSse(response);
const terminal = events.at(-1)?.response;
if (!terminal?.id || terminal.status !== 'completed') throw new Error(`Live task did not complete (status: ${terminal?.status ?? 'missing'})`);
const full = await client.retrieve(terminal.id);
if (typeof full.model !== 'string' || !full.model.trim()) throw new Error('UHP response did not report an actual model');
const modelFallback = full.metadata?.model_fallback === true;
if (full.model !== model && (!modelFallback || full.metadata?.requested_model !== model)) throw new Error(`Live task actual model '${full.model}' is not consistent with the explicit request '${model}'`);
if (full.metadata?.workspace_id !== seeded.workspace_id) throw new Error('Task response did not bind the seeded workspace ID');
const snapshotUrl = new URL(`extensions/foreman-workspace/v1/workspaces/${encodeURIComponent(seeded.workspace_id)}/snapshot`, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
const snapshotResponse = await fetch(snapshotUrl);
if (!snapshotResponse.ok) throw new Error(`Workspace snapshot retrieval failed (${snapshotResponse.status})`);
const snapshot = await readLimitedJson(snapshotResponse, 350 * 1024 * 1024);
const evidence = await verifyBridgeWorkspace({ repoPath, baseCommit, snapshot, allowedScope });
const outputFile = resolve(process.env.LOCAL_CLI_UHP_EVIDENCE_FILE ?? '/tmp/local-cli-uhp-workspace-evidence.json');
const report = { ...evidence, responseId: terminal.id, sessionId: terminal.session_id ?? terminal.sessionId ?? full.session_id, actualModel: full.model, requestedModel: model, modelFallback, usage: full.usage ?? null, workspaceId: seeded.workspace_id, idempotencyKey: saved.key };
if (typeof report.sessionId !== 'string' || !report.sessionId) throw new Error('UHP response did not report a session ID');
await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ status: terminal.status, validation: evidence.validation, scopeVerified: evidence.scopeVerified, acceptance: evidence.acceptance, baseCommit: evidence.baseCommit, completeSnapshot: evidence.completeSnapshot, actualModel: full.model, requestedModel: model, responseId: terminal.id, sessionId: report.sessionId, workspaceId: seeded.workspace_id, changedPaths: evidence.changes.map(c => c.kind === 'rename' ? `${c.previousPath} -> ${c.path}` : c.path), measuredUsage: report.usage, evidenceFile: outputFile }, null, 2)}\n`);

async function readSse(resp) {
  if (!resp.body || !(resp.headers.get('content-type') ?? '').includes('text/event-stream')) throw new Error('UHP response had no event stream');
  const reader = resp.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; const events = []; let lastSequence = -1; let terminal = false;
  const consume = block => {
    const lines = block.split(/\r?\n/); const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data);
    if (!Number.isInteger(event.sequence_number) || event.sequence_number !== lastSequence + 1 || (lastSequence === -1 && event.type !== 'response.created') || terminal) throw new Error('UHP event stream had invalid sequence or terminal ordering');
    lastSequence = event.sequence_number;
    if (['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type)) terminal = true;
    events.push(event);
  };
  while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); if (buffer.length > 4 * 1024 * 1024) throw new Error('UHP event stream exceeded 4 MiB'); let i; while ((i = buffer.indexOf('\n\n')) >= 0) { const block = buffer.slice(0, i); buffer = buffer.slice(i + 2); consume(block); } }
  buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
  if (!terminal) throw new Error('UHP event stream ended without a terminal event');
  return events;
}

async function readLimitedJson(resp, maxBytes) {
  const advertised = Number(resp.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > maxBytes) throw new Error(`Workspace snapshot response exceeds ${maxBytes} bytes`);
  if (!resp.body) throw new Error('Workspace snapshot response had no body');
  const reader = resp.body.getReader(); const parts = []; let bytes = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maxBytes) { await reader.cancel(); throw new Error(`Workspace snapshot response exceeds ${maxBytes} bytes`); } parts.push(value); }
  return JSON.parse(Buffer.concat(parts.map(part => Buffer.from(part))).toString('utf8'));
}
