#!/usr/bin/env node
// One bounded UHP task through Foreman's built client. Intentionally not run by tests.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { UhpClient } from '../../dist/uhp.js';

const [baseUrl, harnessId] = process.argv.slice(2);
if (!baseUrl || !['claude-code', 'codex-cli'].includes(harnessId)) {
  throw new Error('Usage: node smoke.mjs <loopback-base-url> <claude-code|codex-cli>');
}
const prompt = 'In one sentence, state one benefit of deterministic tests. Keep the answer under 20 words.';
const keyFile = resolve(process.env.LOCAL_CLI_UHP_SMOKE_KEY_FILE ?? '/tmp/local-cli-uhp-smoke-key.json');
await mkdir(dirname(keyFile), { recursive: true });
let saved;
try {
  saved = JSON.parse(await readFile(keyFile, 'utf8'));
  if (saved.baseUrl !== baseUrl || saved.harnessId !== harnessId || saved.prompt !== prompt) throw new Error('Existing idempotency record belongs to a different request; choose a new key file for a new task');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  saved = { key: `local-cli-smoke-${randomUUID()}`, baseUrl, harnessId, prompt };
  await writeFile(keyFile, `${JSON.stringify(saved)}\n`, { mode: 0o600, flag: 'wx' });
}

const client = new UhpClient({ baseUrl, timeoutMs: 120_000, streamInactivityTimeoutMs: 60_000 });
const discovery = await client.discover();
const model = discovery.harnessModels[harnessId]?.find(candidate => candidate.available !== false)?.id;
if (!model) throw new Error(`No available discovered model for ${harnessId}`);
const eventTypes = [];
const result = await client.submit({
  submissionId: saved.key, assignmentId: saved.key, runId: saved.key, roleId: 'smoke', taskId: saved.key, projectId: 'local-cli-uhp-smoke',
  prompt, config: { harnessId, model, timeoutSeconds: 45, maxStep: 1 }, idempotencyKey: saved.key,
  onEvent: item => { if (item.type) eventTypes.push(item.type); },
});
const usage = result.usage && Object.keys(result.usage).length ? result.usage : undefined;
process.stdout.write(`${JSON.stringify({ status: result.status, requestedModel: result.requestedModel, actualModel: result.actualModel, responseId: result.responseId, sessionId: result.sessionId, eventTypes, ...(usage ? { measuredUsage: usage } : {}) }, null, 2)}\n`);
