import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

await import('tsx/esm/api').then(({ register }) => register());
const { UhpClient } = await import('../../src/uhp.ts');

const here = dirname(fileURLToPath(import.meta.url));
const dirs = [];
async function fixtureCli(dir, name, body) {
  const path = join(dir, name);
  await writeFile(path, `#!${process.execPath}\n${body}\n`); await chmod(path, 0o700); return path;
}
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'local-cli-uhp-test-')); dirs.push(dir);
  const count = join(dir, 'count');
  const claude = await fixtureCli(dir, 'fake-claude', `import { appendFileSync } from 'node:fs'; const names=['ANTHROPIC_API_KEY','OPENAI_API_KEY','AWS_ACCESS_KEY_ID','GOOGLE_API_KEY','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CODEX_API_KEY']; appendFileSync(${JSON.stringify(count)}, names.some(name=>process.env[name]) ? 'c:provider-env-present\\n' : 'c:provider-env-absent\\n'); process.stdin.resume(); process.stdin.on('end',()=>{ console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-actual',session_id:'claude-session'})); console.log(JSON.stringify({type:'result',subtype:${JSON.stringify(options.claudeIsError ? 'error_api_error' : 'success')},is_error:${options.claudeIsError === true},result:'bounded answer',model:'claude-actual',session_id:'claude-session',usage:{input_tokens:7,output_tokens:3,cache_read_input_tokens:2,cache_creation_input_tokens:99}})); });`);
  const codex = await fixtureCli(dir, 'fake-codex', `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(count)}, process.env.OPENAI_API_KEY ? 'x:provider-env-present\\n' : 'x:provider-env-absent\\n'); process.stdin.resume(); process.stdin.on('end',()=>{ console.log(JSON.stringify({type:'thread.started',thread_id:'codex-thread'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'codex bounded answer'}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:4,output_tokens:2}})); });`);
  const port = 22000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, ANTHROPIC_API_KEY:'fixture-only-do-not-forward', OPENAI_API_KEY:'fixture-only-do-not-forward', AWS_ACCESS_KEY_ID:'fixture-only-do-not-forward', GOOGLE_API_KEY:'fixture-only-do-not-forward', CLAUDE_CODE_USE_BEDROCK:'1', CLAUDE_CODE_USE_VERTEX:'1', CLAUDE_CODE_USE_FOUNDRY:'1', CODEX_API_KEY:'fixture-only-do-not-forward', LOCAL_CLI_UHP_PORT: String(port), LOCAL_CLI_UHP_STATE: join(dir, 'state.json'), LOCAL_CLI_UHP_WORK: join(dir, 'work'), CLAUDE_CONFIG_DIR: join(dir, 'claude-auth'), CODEX_HOME: join(dir, 'codex-auth'), CLAUDE_BIN: options.spawnError ? join(dir,'missing-cli') : claude, CODEX_BIN: codex };
  let proc = spawn(process.execPath, [join(here, 'server.mjs')], { env, stdio: 'ignore' });
  t.after(async () => { if (proc.exitCode === null) { proc.kill('SIGTERM'); await new Promise(r => proc.once('exit', r)); } await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i=0;i<100;i++) { try { const r=await fetch(`${base}/v1/uhp`); if(r.ok) break; } catch {} await new Promise(r=>setTimeout(r,20)); }
  return { base, count, dir, env, restart: async () => { proc.kill('SIGTERM'); await new Promise(r => proc.once('exit', r)); proc = spawn(process.execPath, [join(here, 'server.mjs')], { env, stdio: 'ignore' }); for(let i=0;i<100;i++){try{if((await fetch(`${base}/v1/uhp`)).ok)break;}catch{} await new Promise(r=>setTimeout(r,20));} } };
}
async function submit(base, harness, model, key) {
  const r = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { 'Content-Type':'application/json', Accept:'text/event-stream', 'UHP-Version':'2026-09-12', 'Idempotency-Key':key }, body: JSON.stringify({ input:'Say bounded answer', model, metadata:{harness_id:harness}, stream:true, timeout_seconds:5, max_step:1 }) });
  assert.equal(r.status,200); return (await r.text()).split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
}
test('discovery advertises configured CLIs and Claude submit/replay retains idempotent response across restart', async t => {
  const {base,count,restart}=await setup(t);
  const d=await (await fetch(`${base}/v1/uhp`)).json(); assert.equal(d.default_version,'2026-09-12'); assert.equal(d.capabilities.sessions,false);
  const hs=await (await fetch(`${base}/v1/harnesses`)).json(); assert.deepEqual(hs.harnesses.map(x=>x.id),['claude-code','codex-cli']);
  const first=await submit(base,'claude-code','default','same-key'); assert.equal(first[0].type,'response.created'); assert.equal(first[1].type,'response.completed',JSON.stringify(first));
  const r=first[1].response; assert.equal(r.output_text,'bounded answer'); assert.equal(r.model,'claude-actual'); assert.equal(r.session_id,'claude-session'); assert.equal(r.metadata.session_id,'claude-session'); assert.deepEqual(r.usage,{input_tokens:7,output_tokens:3,input_tokens_details:{cached_tokens:2}});
  assert.equal(r.metadata.requested_model,'default'); assert.equal(r.metadata.model_fallback,true); assert.equal(r.metadata.model_alias_resolved,true);
  const second=await submit(base,'claude-code','default','same-key'); assert.equal(second[1].response.id,r.id);
  await restart();
  const afterRestart=await submit(base,'claude-code','default','same-key'); assert.equal(afterRestart[1].response.id,r.id);
  assert.equal((await readFile(count,'utf8')).trim(),'c:provider-env-absent');
  const retrieved=await (await fetch(`${base}/v1/responses/${r.id}`,{headers:{'UHP-Version':'2026-09-12'}})).json(); assert.equal(retrieved.id,r.id);
});
test('Foreman UhpClient discovers, submits, validates fallback/session/usage, and replays idempotently', async t => {
  const {base,count}=await setup(t); const client=new UhpClient({baseUrl:base,harnessId:'claude-code',model:'default'});
  const discovery=await client.discover(); assert.equal(discovery.version,'2026-09-12'); assert.equal(discovery.capabilities.sessions,false);
  const seen=[]; const input={submissionId:'sub-smoke-fixture',assignmentId:'assignment-fixture',runId:'run-fixture',roleId:'planner',taskId:'task-fixture',projectId:'project-fixture',prompt:'Reply with one bounded sentence.',config:{harnessId:'claude-code',model:'default',timeoutSeconds:5,maxStep:1},idempotencyKey:'uhpclient-fixed-fixture-key',onEvent:e=>seen.push(e.type)};
  const first=await client.submit(input); assert.equal(first.status,'completed'); assert.equal(first.actualModel,'claude-actual'); assert.equal(first.requestedModel,'default'); assert.equal(first.modelFallback,true); assert.equal(first.selectedHarnessId,'claude-code'); assert.equal(first.sessionId,'claude-session'); assert.equal(first.responseId,first.externalId); assert.deepEqual(first.usage,{inputTokens:7,outputTokens:3,cachedInputTokens:2}); assert.deepEqual(seen,['response.created','response.completed']);
  const replay=await client.submit(input); assert.equal(replay.responseId,first.responseId); assert.equal((await readFile(count,'utf8')).trim().split('\n').length,1);
});
test('Codex parser returns reported output and leaves unavailable model/usage absent', async t => {
  const {base,count}=await setup(t);
  const events=await submit(base,'codex-cli','default','codex-key'); const r=events[1].response;
  assert.equal(events[1].type,'response.failed',JSON.stringify(events)); assert.equal(r.output_text,'codex bounded answer'); assert.equal(r.model,undefined); assert.match(r.error.message,/did not report an actual model/);
  assert.equal(r.session_id,'codex-thread'); assert.deepEqual(r.usage,{input_tokens:4,output_tokens:2});
  assert.equal((await readFile(count,'utf8')).trim(),'x:provider-env-absent');
});
test('invalid model and prompt bounds are rejected before CLI spawn', async t => {
  const {base,count}=await setup(t);
  const r=await fetch(`${base}/v1/responses`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'bad'},body:JSON.stringify({input:'x'.repeat(16001),model:'default',metadata:{harness_id:'claude-code'}})});
  assert.equal(r.status,400); await assert.rejects(readFile(count));
});
test('spawn errors produce a sanitized terminal response without stderr details', async t => {
  const {base}=await setup(t,{spawnError:true}); const events=await submit(base,'claude-code','default','spawn-error-key');
  assert.equal(events[1].type,'response.failed'); assert.equal(events[1].response.error.message,'CLI could not be started');
  assert.equal(JSON.stringify(events).includes('missing-cli'),false);
});
test('Claude is_error and error subtype do not produce a successful UHP response', async t => {
  const {base}=await setup(t,{claudeIsError:true}); const events=await submit(base,'claude-code','default','claude-error-key');
  assert.equal(events[1].type,'response.failed'); assert.equal(events[1].response.error.message,'Claude Code reported an unsuccessful task');
});
