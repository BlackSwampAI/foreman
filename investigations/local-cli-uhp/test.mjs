import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rm, truncate, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

await import('tsx/esm/api').then(({ register }) => register());
const { UhpClient } = await import('../../src/uhp.ts');
const { Controller } = await import('../../src/controller.ts');
const { JsonStore } = await import('../../src/store.ts');
const { snapshotGitCommit } = await import('../../src/git-workspace.ts');
const { verifyBridgeWorkspace, validateBridgeSnapshot } = await import('./workspace-verifier.mjs');
const { createWorkspaceFixture, applyAllFileCaseChanges } = await import('./workspace-fixture.mjs');
const { assertReviewerBounds, isPrepareOnly, REVIEWER_TASK_BOUNDS, REVIEWER_STREAM_INACTIVITY_TIMEOUT_MS, REVIEWER_BRIDGE_MAX_STEP } = await import('./reviewer-smoke-bounds.mjs');

const here = dirname(fileURLToPath(import.meta.url));
const dirs = [];
async function fixtureCli(dir, name, body) {
  const path = join(dir, name);
  await writeFile(path, `#!${process.execPath}\n${body}\n`); await chmod(path, 0o700); return path;
}
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'local-cli-uhp-test-')); dirs.push(dir);
  const fixture = options.sourceRepo ? undefined : await createWorkspaceFixture();
  if (fixture) t.after(fixture.cleanup);
  const claude = await fixtureCli(dir, 'fake-claude', options.claudeBody ?? `import { appendFileSync } from 'node:fs'; const names=['ANTHROPIC_API_KEY','OPENAI_API_KEY','AWS_ACCESS_KEY_ID','GOOGLE_API_KEY','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CODEX_API_KEY']; const model=${JSON.stringify(options.claudeUndefined ? 'undefined' : 'claude-actual')}; const ix=process.argv.indexOf('--model'); appendFileSync('.fixture-cli-count', (names.some(name=>process.env[name]) ? 'c:provider-env-present' : 'c:provider-env-absent')+':model='+(ix<0?'missing':process.argv[ix+1])+'\\n'); process.stdin.resume(); process.stdin.on('end',()=>{ console.log(JSON.stringify({type:'system',subtype:'init',model,session_id:'claude-session'})); console.log(JSON.stringify({type:'result',subtype:${JSON.stringify(options.claudeIsError ? 'error_api_error' : 'success')},is_error:${options.claudeIsError === true},result:'bounded answer',model,session_id:'claude-session',usage:{input_tokens:7,output_tokens:3,cache_read_input_tokens:2,cache_creation_input_tokens:99}})); });`);
  const codex = await fixtureCli(dir, 'fake-codex', options.codexBody ?? `import { appendFileSync } from 'node:fs'; const ix=process.argv.indexOf('--model'); appendFileSync('.fixture-cli-count', (process.env.OPENAI_API_KEY ? 'x:provider-env-present' : 'x:provider-env-absent')+':model='+(ix<0?'missing':process.argv[ix+1])+':ignore-user-config='+process.argv.includes('--ignore-user-config')+':skip-git-repo-check='+process.argv.includes('--skip-git-repo-check')+'\\n'); process.stdin.resume(); process.stdin.on('end',()=>{ console.log(JSON.stringify({type:'thread.started',thread_id:'codex-thread'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'codex bounded answer'}})); console.log(JSON.stringify({type:'turn.completed',${options.codexReportedModel ? `model:${JSON.stringify(options.codexReportedModel)},` : ''}usage:{input_tokens:4,output_tokens:2}})); ${options.codexExit ? 'process.exit(7);' : ''} });`);
  const port = 22000 + Math.floor(Math.random() * 20000);
  await mkdir(join(dir,'claude-auth')); await mkdir(join(dir,'codex-auth'));
  const env = { ...process.env, ANTHROPIC_API_KEY:'fixture-only-do-not-forward', OPENAI_API_KEY:'fixture-only-do-not-forward', AWS_ACCESS_KEY_ID:'fixture-only-do-not-forward', GOOGLE_API_KEY:'fixture-only-do-not-forward', CLAUDE_CODE_USE_BEDROCK:'1', CLAUDE_CODE_USE_VERTEX:'1', CLAUDE_CODE_USE_FOUNDRY:'1', CODEX_API_KEY:'fixture-only-do-not-forward', LOCAL_CLI_UHP_PORT: String(port), LOCAL_CLI_UHP_STATE: join(dir, 'state.json'), LOCAL_CLI_UHP_WORK: join(dir, 'work'), CLAUDE_CONFIG_DIR: join(dir, 'claude-auth'), CODEX_HOME: join(dir, 'codex-auth'), CLAUDE_MODEL: options.noClaudeModel ? '' : 'claude-requested', CODEX_MODEL: 'codex-requested', CLAUDE_BIN: options.claudeBin ?? (options.spawnError ? join(dir,'missing-cli') : claude), CODEX_BIN: codex, LOCAL_CLI_UHP_SOURCE_REPO: options.sourceRepo ?? fixture.repo, LOCAL_CLI_UHP_BWRAP: options.bwrapBin ?? 'bwrap' };
  let proc = spawn(process.execPath, [join(here, 'server.mjs')], { env, stdio: 'ignore' });
  t.after(async () => { if (proc.exitCode === null) { proc.kill('SIGTERM'); await new Promise(r => proc.once('exit', r)); } await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i=0;i<100;i++) { try { const r=await fetch(`${base}/v1/uhp`); if(r.ok) break; } catch {} await new Promise(r=>setTimeout(r,20)); }
  return { base, dir, env, baseCommit: options.baseCommit ?? fixture?.baseCommit, sourceRepo: options.sourceRepo ?? fixture?.repo, countFor: workspaceId=>join(env.LOCAL_CLI_UHP_WORK,workspaceId,'.fixture-cli-count'), restart: async () => { proc.kill('SIGTERM'); await new Promise(r => proc.once('exit', r)); proc = spawn(process.execPath, [join(here, 'server.mjs')], { env, stdio: 'ignore' }); for(let i=0;i<100;i++){try{if((await fetch(`${base}/v1/uhp`)).ok)break;}catch{} await new Promise(r=>setTimeout(r,20));} } };
}
async function submit(base, harness, model, key, baseCommit, workspaceId) {
  const seeded=workspaceId ? {workspace_id:workspaceId} : await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base_commit:baseCommit})})).json();
  const r = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { 'Content-Type':'application/json', Accept:'text/event-stream', 'UHP-Version':'2026-09-12', 'Idempotency-Key':key }, body: JSON.stringify({ input:'Say bounded answer', model, metadata:{harness_id:harness,workspace_id:seeded.workspace_id}, stream:true, timeout_seconds:5, max_step:1 }) });
  const text=await r.text(); assert.equal(r.status,200,text); return text.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
}
function reviewEvidence(overrides = {}) { return { validation:'verified_by_foreman_git_comparison', scopeVerified:true, baseCommit:'a'.repeat(40), workerResponseId:'resp_worker_fixture', allowedScope:['src/example.ts'], reviewDiff:'### modify: src/example.ts\n- before\n+ after\n', controllerValidation:{passed:true,policy:{requireAllChecksPass:true,configuredCheckCount:1},observations:[{name:'typecheck',command:'node',args:['--check','src/example.ts'],exitCode:0,signal:null,timedOut:false,output:'passed',outputTruncated:false,passed:true,startedAt:'2026-09-22T00:00:00Z',finishedAt:'2026-09-22T00:00:01Z'}]}, ...overrides }; }
async function submitReview(base, harness, key, metadata = {}, input = 'Review this change for correctness and return a recommendation.') {
  const r = await fetch(`${base}/v1/responses`, {method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream','UHP-Version':'2026-09-12','Idempotency-Key':key},body:JSON.stringify({input,model:harness==='claude-code'?'claude-requested':'codex-requested',metadata:{harness_id:harness,role_id:'reviewer',foreman_review_mode:'read_only',review_evidence:reviewEvidence(),...metadata},stream:true,timeout_seconds:5,max_step:1})});
  const text=await r.text(); return {status:r.status, body:r.headers.get('content-type')?.includes('json')?JSON.parse(text):undefined, events:text.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)))};
}
test('discovery advertises configured CLIs and Claude submit/replay retains idempotent response across restart', async t => {
  const {base,baseCommit,countFor,restart}=await setup(t);
  const d=await (await fetch(`${base}/v1/uhp`)).json(); assert.equal(d.default_version,'2026-09-12'); assert.equal(d.capabilities.sessions,false);
  const hs=await (await fetch(`${base}/v1/harnesses`)).json(); assert.deepEqual(hs.harnesses.map(x=>x.id),['claude-code','codex-cli']);
  const first=await submit(base,'claude-code','claude-requested','same-key',baseCommit); assert.equal(first[0].type,'response.created'); assert.equal(first[1].type,'response.completed',JSON.stringify(first));
  const r=first[1].response; assert.equal(r.output_text,'bounded answer'); assert.equal(r.model,'claude-actual'); assert.equal(r.session_id,'claude-session'); assert.equal(r.metadata.session_id,'claude-session'); assert.deepEqual(r.usage,{input_tokens:7,output_tokens:3,input_tokens_details:{cached_tokens:2}});
  assert.equal(r.metadata.execution_boundary?.proven,true);
  assert.equal(r.metadata.requested_model,'claude-requested'); assert.equal(r.metadata.model_fallback,true);
  const workspaceId=r.metadata.workspace_id; const second=await submit(base,'claude-code','claude-requested','same-key',baseCommit,workspaceId); assert.equal(second[1].response.id,r.id);
  await restart();
  const afterRestart=await submit(base,'claude-code','claude-requested','same-key',baseCommit,workspaceId); assert.equal(afterRestart[1].response.id,r.id);
  assert.equal((await readFile(countFor(workspaceId),'utf8')).trim(),'c:provider-env-absent:model=claude-requested');
  const retrieved=await (await fetch(`${base}/v1/responses/${r.id}`,{headers:{'UHP-Version':'2026-09-12'}})).json(); assert.equal(retrieved.id,r.id);
});
test('Foreman UhpClient discovers, submits, validates fallback/session/usage, and replays idempotently', async t => {
  const {base,baseCommit,countFor}=await setup(t); const seed=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base_commit:baseCommit})})).json();
  const fetchWithWorkspace=async (input,init)=>{if(new URL(input).pathname==='/v1/responses'&&init?.method==='POST'){const body=JSON.parse(init.body);body.metadata.workspace_id=seed.workspace_id;return fetch(input,{...init,body:JSON.stringify(body)});}return fetch(input,init);};
  const client=new UhpClient({baseUrl:base,harnessId:'claude-code',model:'claude-requested',fetch:fetchWithWorkspace});
  const discovery=await client.discover(); assert.equal(discovery.version,'2026-09-12'); assert.equal(discovery.capabilities.sessions,false);
  const seen=[]; const input={submissionId:'sub-smoke-fixture',assignmentId:'assignment-fixture',runId:'run-fixture',roleId:'planner',taskId:'task-fixture',projectId:'project-fixture',prompt:'Reply with one bounded sentence.',config:{harnessId:'claude-code',model:'claude-requested',timeoutSeconds:5,maxStep:1},idempotencyKey:'uhpclient-fixed-fixture-key',onEvent:e=>seen.push(e.type)};
  const first=await client.submit(input); assert.equal(first.status,'completed'); assert.equal(first.actualModel,'claude-actual'); assert.equal(first.requestedModel,'claude-requested'); assert.equal(first.modelFallback,true); assert.equal(first.selectedHarnessId,'claude-code'); assert.equal(first.sessionId,'claude-session'); assert.equal(first.responseId,first.externalId); assert.deepEqual(first.usage,{inputTokens:7,outputTokens:3,cachedInputTokens:2}); assert.deepEqual(seen,['response.created','response.completed']);
  const replay=await client.submit(input); assert.equal(replay.responseId,first.responseId); assert.equal((await readFile(countFor(seed.workspace_id),'utf8')).trim().split('\n').length,1);
});
test('Codex parser returns reported output and leaves unavailable model/usage absent', async t => {
  const {base,baseCommit,countFor}=await setup(t);
  const events=await submit(base,'codex-cli','codex-requested','codex-key',baseCommit); const r=events[1].response;
  assert.equal(events[1].type,'response.completed',JSON.stringify(events)); assert.equal(r.output_text,'codex bounded answer'); assert.equal(r.model,undefined);
  assert.equal(r.requested_model,'codex-requested'); assert.equal(r.metadata.actual_model_status,'unavailable');
  assert.equal(r.metadata.cli_invocation.executable,'/opt/codex');
  assert.equal(r.metadata.cli_invocation.host_executable.endsWith('/fake-codex'),true);
  assert.ok(r.metadata.cli_invocation.args.includes('workspace-write'));
  assert.deepEqual(r.metadata.cli_invocation.args.slice(-3),['--model','codex-requested','-']);
  assert.equal(r.session_id,'codex-thread'); assert.deepEqual(r.usage,{input_tokens:4,output_tokens:2});
  assert.equal(r.metadata.execution_boundary.proven,true);
  assert.equal((await readFile(countFor(r.metadata.workspace_id),'utf8')).trim(),'x:provider-env-absent:model=codex-requested:ignore-user-config=true:skip-git-repo-check=true');
});

test('Codex Worker edits only its seeded workspace and cannot read or write an outside sentinel', async t => {
  const fixture=await createWorkspaceFixture(); t.after(fixture.cleanup);
  const outside=await mkdtemp(join(tmpdir(),'foreman-codex-outside-')); t.after(()=>rm(outside,{recursive:true,force:true}));
  const sentinel=join(outside,'outside-sentinel'); await writeFile(sentinel,'outside-value');
  const body=`import {readFileSync,writeFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process'; const p=${JSON.stringify(sentinel)}; let outsideRead='allowed',outsideWrite='allowed',authWrite='allowed'; try{readFileSync(p,'utf8')}catch{outsideRead='denied'} try{writeFileSync(p,'changed')}catch{outsideWrite='denied'} try{writeFileSync(process.env.CODEX_HOME+'/host-login.fixture','changed')}catch{authWrite='denied'} const login=readFileSync(process.env.CODEX_HOME+'/host-login.fixture','utf8'); const shellCommand='if test -r '+JSON.stringify(p)+'; then exit 41; fi; if printf changed >> '+JSON.stringify(p)+' 2>/dev/null; then exit 42; fi; printf %s Codex_worker_changed_this_assigned_file. > README.md'; const shell=spawnSync('/bin/sh',['-c',shellCommand]); writeFileSync('codex-boundary.json',JSON.stringify({outsideRead,outsideWrite,authWrite,login,codexHome:process.env.CODEX_HOME,shellExit:shell.status})); process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'codex-boundary-thread'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'updated README.md'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:4}}));});`;
  const {base,baseCommit,env}=await setup(t,{sourceRepo:fixture.repo,baseCommit:fixture.baseCommit,codexBody:body});
  await writeFile(join(env.CODEX_HOME,'host-login.fixture'),'host-login-visible-read-only');
  const workspace=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base_commit:baseCommit})})).json();
  const events=await submit(base,'codex-cli','codex-requested','codex-boundary-key',baseCommit,workspace.workspace_id); const response=events.at(-1).response;
  assert.equal(events.at(-1).type,'response.completed',JSON.stringify(events));
  assert.equal(response.metadata.actual_model_status,'unavailable');
  assert.equal(response.metadata.execution_boundary.proven,true);
  const work=join(env.LOCAL_CLI_UHP_WORK,response.metadata.workspace_id);
  const boundary=JSON.parse(await readFile(join(work,'codex-boundary.json'),'utf8')); assert.deepEqual({outsideRead:boundary.outsideRead,outsideWrite:boundary.outsideWrite,authWrite:boundary.authWrite,login:boundary.login,codexHome:boundary.codexHome},{outsideRead:'denied',outsideWrite:'denied',authWrite:'denied',login:'host-login-visible-read-only',codexHome:'/auth'}); assert.equal(boundary.shellExit,0,JSON.stringify(boundary));
  assert.equal(await readFile(join(work,'README.md'),'utf8'),'Codex_worker_changed_this_assigned_file.');
  assert.equal(await readFile(sentinel,'utf8'),'outside-value');
  assert.equal(await readFile(join(env.CODEX_HOME,'host-login.fixture'),'utf8'),'host-login-visible-read-only');
  const snapshot=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces/${response.metadata.workspace_id}/snapshot`)).json();
  const evidence=await verifyBridgeWorkspace({repoPath:fixture.repo,baseCommit:fixture.baseCommit,snapshot,allowedScope:['README.md','codex-boundary.json']});
  assert.equal(evidence.validation,'verified_by_foreman_git_comparison'); assert.equal(evidence.scopeVerified,true);
});
test('Codex Worker startup failure records exit status and stage without blaming actual-model reporting', async t => {
  const {base,baseCommit}=await setup(t,{codexBody:'process.exit(17);'});
  const events=await submit(base,'codex-cli','codex-requested','codex-empty-failure-key',baseCommit); const response=events.at(-1).response;
  assert.equal(events.at(-1).type,'response.failed',JSON.stringify(events));
  assert.equal(response.model,undefined); assert.equal(response.session_id,undefined); assert.equal(response.usage,undefined);
  assert.equal(response.metadata.actual_model_status,'unavailable');
  assert.deepEqual(response.metadata.cli_exit,{exit_code:17,signal:null});
  assert.equal(response.metadata.execution_stage,'cli_execution');
  assert.equal(response.error.message,'Codex CLI exited before reporting a session id');
  assert.doesNotMatch(response.error.message,/actual model/i);
});
test('Codex Worker requires turn.completed even when CLI exits zero with a thread and message', async t => {
  const body=`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'codex-incomplete-thread'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'partial answer'}}));});`;
  const {base,baseCommit}=await setup(t,{codexBody:body});
  const events=await submit(base,'codex-cli','codex-requested','codex-incomplete-turn-key',baseCommit); const response=events.at(-1).response;
  assert.equal(events.at(-1).type,'response.failed',JSON.stringify(events));
  assert.equal(response.output_text,'partial answer'); assert.equal(response.session_id,'codex-incomplete-thread');
  assert.equal(response.model,undefined); assert.equal(response.metadata.actual_model_status,'unavailable');
  assert.deepEqual(response.metadata.cli_exit,{exit_code:0,signal:null});
  assert.equal(response.error.message,'Codex CLI exited without completing a turn');
  assert.doesNotMatch(response.error.message,/actual model/i);
});
test('invalid model and prompt bounds are rejected before CLI spawn', async t => {
  const {base,env}=await setup(t);
  const r=await fetch(`${base}/v1/responses`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'bad'},body:JSON.stringify({input:'x'.repeat(16001),model:'claude-requested',metadata:{harness_id:'claude-code'}})});
  assert.equal(r.status,400); assert.deepEqual(await readdir(env.LOCAL_CLI_UHP_WORK),[]);
});
test('spawn errors produce a sanitized terminal response without stderr details', async t => {
  const {base,baseCommit}=await setup(t,{spawnError:true}); const events=await submit(base,'claude-code','claude-requested','spawn-error-key',baseCommit);
  assert.equal(events[1].type,'response.failed'); assert.match(events[1].response.error.message,/CLI could not be started|CLI task failed internally/);
  assert.equal(JSON.stringify(events).includes('missing-cli'),false);
});
test('Claude is_error and error subtype do not produce a successful UHP response', async t => {
  const {base,baseCommit}=await setup(t,{claudeIsError:true}); const events=await submit(base,'claude-code','claude-requested','claude-error-key',baseCommit);
  assert.equal(events[1].type,'response.failed'); assert.equal(events[1].response.error.message,'Claude Code reported an unsuccessful task');
});
test('a harness without an explicit model is omitted from discovery', async t => {
  const {base}=await setup(t,{noClaudeModel:true}); const body=await (await fetch(`${base}/v1/harnesses`)).json();
  assert.deepEqual(body.harnesses.map(x=>x.id),['codex-cli']);
  assert.equal((await fetch(`${base}/v1/harnesses/claude-code/models`)).status,404);
});
test('literal undefined from Claude is not accepted as an actual model', async t => {
  const {base,baseCommit}=await setup(t,{claudeUndefined:true}); const events=await submit(base,'claude-code','claude-requested','undefined-model-key',baseCommit);
  assert.equal(events[1].type,'response.failed'); assert.equal(events[1].response.model,undefined);
  assert.match(events[1].response.error.message,/did not report an actual model/);
});

test('read-only Reviewer accepts only bounded verified evidence and returns boundary observations', async t => {
  const {base}=await setup(t,{claudeBody:`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-actual',session_id:'claude-session'}));console.log(JSON.stringify({type:'result',subtype:'success',result:'recommendation: clear',model:'claude-actual',session_id:'claude-session',usage:{input_tokens:4,output_tokens:5}}));});`});
  const discovery=await (await fetch(`${base}/v1/uhp`)).json(); assert.equal(discovery.capabilities.readOnlyReviewer,true);
  const result=await submitReview(base,'claude-code','review-success'); assert.equal(result.status,200);
  const response=result.events.at(-1).response; assert.equal(result.events.at(-1).type,'response.completed',JSON.stringify(result.events));
  assert.equal(response.model,'claude-actual'); assert.equal(response.session_id,'claude-session');
  assert.equal(response.metadata.foreman_review_mode,'read_only'); assert.equal(response.metadata.reviewer_mutation_attempted,false);
  assert.deepEqual(response.metadata.reviewer_validation,reviewEvidence().controllerValidation);
  assert.equal(response.metadata.reviewer_boundary.project_workspace_mounted,false);
  assert.equal(response.metadata.reviewer_boundary.workspace_writable,false);
  assert.equal(response.metadata.reviewer_boundary.claude_tool_allowlist_empty,true);
});

test('read-only Reviewer rejects missing model, unsuccessful CLI, mutation tool use, and Codex tool execution', async t => {
  const missing=await setup(t,{claudeUndefined:true}); const noModel=await submitReview(missing.base,'claude-code','review-no-model');
  assert.equal(noModel.events.at(-1).type,'response.failed'); assert.match(noModel.events.at(-1).response.error.message,/actual model/);
  const unsuccessful=await setup(t,{claudeIsError:true}); const failed=await submitReview(unsuccessful.base,'claude-code','review-error'); assert.equal(failed.events.at(-1).type,'response.failed');
  const attempted=await setup(t,{claudeBody:`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-actual',session_id:'s'}));console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Write',input:{}}]}}));console.log(JSON.stringify({type:'result',subtype:'success',result:'done',model:'claude-actual',session_id:'s'}));});`});
  const mutation=await submitReview(attempted.base,'claude-code','review-mutation'); assert.equal(mutation.events.at(-1).type,'response.failed'); assert.equal(mutation.events.at(-1).response.metadata.reviewer_mutation_attempted,true);
  const codex=await setup(t,{codexBody:`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'review-thread'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'recommendation'}}));console.log(JSON.stringify({type:'turn.completed',model:'codex-actual'}));console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'touch x'}}));});`});
  const codexMutation=await submitReview(codex.base,'codex-cli','review-codex-mutation'); assert.equal(codexMutation.events.at(-1).type,'response.failed'); assert.equal(codexMutation.events.at(-1).response.metadata.reviewer_mutation_attempted,true);
});

test('read-only Reviewer fails closed when overflow evicts an early tool event or JSONL is malformed', async t => {
  const overflowing=await setup(t,{claudeBody:`process.stdin.resume();process.stdin.on('end',()=>{const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');emit({type:'system',subtype:'init',model:'claude-actual',session_id:'overflow-session'});emit({type:'assistant',message:{content:[{type:'tool_use',name:'Write',input:{}}]}});process.stdout.write('x'.repeat(600000)+'\\n');emit({type:'result',subtype:'success',result:'recommendation',model:'claude-actual',session_id:'overflow-session'});});`});
  const overflow=await submitReview(overflowing.base,'claude-code','review-overflow');
  assert.notEqual(overflow.events.at(-1).type,'response.completed',JSON.stringify(overflow.events));
  assert.equal(overflow.events.at(-1).response.metadata.reviewer_output_overflow,true);
  const malformed=await setup(t,{claudeBody:`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-actual',session_id:'malformed-session'}));console.log('{"type":"assistant",broken');console.log(JSON.stringify({type:'result',subtype:'success',result:'recommendation',model:'claude-actual',session_id:'malformed-session'}));});`});
  const invalid=await submitReview(malformed.base,'claude-code','review-malformed-jsonl');
  assert.equal(invalid.events.at(-1).type,'response.failed',JSON.stringify(invalid.events));
  assert.match(invalid.events.at(-1).response.error.message,/malformed or unrecognized/);
});

test('read-only Reviewer fails closed for invalid scope, oversized diff, and any workspace binding', async t => {
  const {base}=await setup(t);
  const invalid=await submitReview(base,'claude-code','review-invalid-scope',{review_evidence:reviewEvidence({scopeVerified:false})}); assert.equal(invalid.status,400);
  const oversized=await submitReview(base,'claude-code','review-too-large',{review_evidence:reviewEvidence({reviewDiff:'x'.repeat(48_001)})}); assert.equal(oversized.status,400);
  const bound=await submitReview(base,'claude-code','review-workspace',{workspace_id:'ws_00000000-0000-0000-0000-000000000000'}); assert.equal(bound.status,400); assert.equal(bound.body.error.code,'review_workspace_forbidden');
});

test('Codex Reviewer requires a model reported by its own JSON events', async t => {
  const {base}=await setup(t,{codexUndefined:true}); const result=await submitReview(base,'codex-cli','codex-review-missing-model');
  assert.equal(result.events.at(-1).type,'response.failed'); assert.equal(result.events.at(-1).response.model,undefined);
  assert.match(result.events.at(-1).response.error.message,/actual model/);
});

test('Codex Reviewer runs from an empty transient cwd with read-only ephemeral flags and reported model', async t => {
  const {base}=await setup(t,{codexBody:`import {readdirSync} from 'node:fs';const ix=process.argv.indexOf('--model');const facts={emptyCwd:readdirSync('.').length===0,sandbox:process.argv[process.argv.indexOf('--sandbox')+1],ephemeral:process.argv.includes('--ephemeral'),ignoreUserConfig:process.argv.includes('--ignore-user-config'),ignoreRules:process.argv.includes('--ignore-rules'),requestedModel:process.argv[ix+1]};process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'codex-review-thread'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(facts)}}));console.log(JSON.stringify({type:'turn.completed',model:'codex-actual',usage:{input_tokens:2,output_tokens:3}}));});`});
  const result=await submitReview(base,'codex-cli','codex-review-success'); const response=result.events.at(-1).response;
  assert.equal(result.events.at(-1).type,'response.completed',JSON.stringify(result.events)); assert.equal(response.model,'codex-actual');
  assert.deepEqual(JSON.parse(response.output_text),{emptyCwd:true,sandbox:'read-only',ephemeral:true,ignoreUserConfig:true,ignoreRules:true,requestedModel:'codex-requested'});
  assert.equal(response.metadata.reviewer_boundary.project_workspace_mounted,false); assert.equal(response.metadata.reviewer_boundary.codex_sandbox,'read-only');
});

test('live smoke Reviewer bounds fit the bridge and leave stream inactivity headroom', () => {
  assert.equal(assertReviewerBounds(REVIEWER_TASK_BOUNDS, REVIEWER_STREAM_INACTIVITY_TIMEOUT_MS),true);
  assert.ok(REVIEWER_TASK_BOUNDS.maxStep <= REVIEWER_BRIDGE_MAX_STEP);
  assert.throws(()=>assertReviewerBounds({...REVIEWER_TASK_BOUNDS,maxStep:11}),/maxStep/);
  assert.throws(()=>assertReviewerBounds(REVIEWER_TASK_BOUNDS,90_000),/inactivity timeout/);
});

test('smoke prepare-only switch is an exact opt-in and never authorizes Reviewer submission', () => {
  assert.equal(isPrepareOnly('1'),true);
  assert.equal(isPrepareOnly('0'),false);
  assert.equal(isPrepareOnly(undefined),false);
});

test('bridge-specific seed and full snapshot preserve every Git file case for Foreman verification', async t => {
  const fixture = await createWorkspaceFixture(); t.after(fixture.cleanup);
  assert.match(fixture.baseCommit,/^[0-9a-f]{40}$/);
  const {base,env}=await setup(t,{sourceRepo:fixture.repo});
  const discovery=await (await fetch(`${base}/v1/uhp`)).json();
  assert.equal(discovery.capabilities.sessions,false);
  assert.deepEqual(discovery.capabilities.extensions.foreman_workspace_bridge_v1,{version:1,seed:true,complete_snapshot:true,execution_boundary:'bubblewrap'});
  const seed=await fetch(`${base}/extensions/foreman-workspace/v1/workspaces`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base_commit:fixture.baseCommit})});
  assert.equal(seed.status,201); const workspace=await seed.json();
  assert.equal(workspace.base_commit,fixture.baseCommit); assert.match(workspace.workspace_id,/^[a-zA-Z0-9_-]+$/);
  const work=join(env.LOCAL_CLI_UHP_WORK,workspace.workspace_id);
  const initial=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces/${workspace.workspace_id}/snapshot`)).json();
  assert.equal(initial.complete,true,JSON.stringify(initial.errors)); assert.equal(initial.base_commit,fixture.baseCommit); assert.deepEqual(initial.errors,[]);
  assert.ok(initial.entries.some(entry=>entry.path==='.fixture-dotfile'));
  assert.ok(initial.entries.some(entry=>entry.path==='AGENTS.md'));
  assert.ok(initial.entries.some(entry=>entry.path==='excluded-from-archive.txt'));
  assert.deepEqual(validateBridgeSnapshot(initial,fixture.baseCommit),(await snapshotGitCommit(fixture.repo,fixture.baseCommit)).entries);
  await applyAllFileCaseChanges(work);
  const snapshot=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces/${workspace.workspace_id}/snapshot`)).json();
  assert.equal(snapshot.complete,true,JSON.stringify(snapshot.errors));
  const evidence=await verifyBridgeWorkspace({repoPath:fixture.repo,baseCommit:fixture.baseCommit,snapshot,allowedScope:['added.txt','edit.txt','delete.txt','rename-before.txt','rename-after.txt','binary.bin','run.sh','current-link','.fixture-dotfile','AGENTS.md']});
  assert.equal(evidence.validation,'verified_by_foreman_git_comparison'); assert.equal(evidence.acceptance,'not_decided');
  assert.deepEqual(new Set(evidence.changes.map(change=>change.kind)),new Set(['add','modify','delete','rename']));
  const paths=new Set(evidence.changes.map(change=>change.path));
  for(const path of ['added.txt','edit.txt','delete.txt','rename-after.txt','binary.bin','run.sh','current-link','.fixture-dotfile','AGENTS.md']) assert.ok(paths.has(path),`missing verified change ${path}`);
  const changed= snapshot.entries;
  assert.equal(changed.find(entry=>entry.path==='run.sh').mode,'100755');
  assert.deepEqual(Buffer.from(changed.find(entry=>entry.path==='binary.bin').contentBase64,'base64'),Buffer.from([0,254,0,127,255]));
  assert.equal(changed.find(entry=>entry.path==='current-link').target,'target-b.txt');
  assert.match(evidence.reviewDiff,/binary bytes are preserved/);
  assert.throws(()=>validateBridgeSnapshot({...snapshot,complete:false},fixture.baseCommit),/incomplete/);
  assert.throws(()=>validateBridgeSnapshot({...snapshot,errors:[{path:'bad',error:'unreadable'}]},fixture.baseCommit),/contains errors/);
  assert.throws(()=>validateBridgeSnapshot({...snapshot,base_commit:'f'.repeat(40)},fixture.baseCommit),/does not match/);
  const oversized=join(work,'oversized.fixture'); await writeFile(oversized,Buffer.alloc(1)); await truncate(oversized,16*1024*1024+1);
  const incomplete=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces/${workspace.workspace_id}/snapshot`)).json();
  assert.equal(incomplete.complete,false); assert.ok(incomplete.errors.some(error=>error.path==='oversized.fixture'&&/size_limit/.test(error.error)));
  assert.throws(()=>validateBridgeSnapshot(incomplete,fixture.baseCommit),/incomplete/);
});

test('tool-enabled child cannot read or write outside its seeded workspace', async t => {
  const fixture = await createWorkspaceFixture(); t.after(fixture.cleanup);
  const parent = await mkdtemp(join(tmpdir(),'foreman-uhp-boundary-')); t.after(()=>rm(parent,{recursive:true,force:true}));
  const sentinel=join(parent,'outside-sentinel'); await writeFile(sentinel,'do-not-read-or-change');
  const body = `import {readFileSync,writeFileSync} from 'node:fs'; const path=${JSON.stringify(sentinel)}; let read='allowed',write='allowed'; try{readFileSync(path,'utf8')}catch{read='denied'} try{writeFileSync(path,'CHANGED')}catch{write='denied'} writeFileSync('worker-edit.txt',JSON.stringify({read,write})); writeFileSync('inside-edit.txt','worker changed assigned file\\n'); console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-actual',session_id:'claude-session'})); console.log(JSON.stringify({type:'result',subtype:'success',result:'fixture edit',model:'claude-actual',session_id:'claude-session',usage:{input_tokens:1,output_tokens:1}}));`;
  const {base,env}=await setup(t,{sourceRepo:fixture.repo,claudeBody:body});
  const seed=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base_commit:fixture.baseCommit})})).json();
  const work=join(env.LOCAL_CLI_UHP_WORK,seed.workspace_id);
  const request=await fetch(`${base}/v1/responses`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream','UHP-Version':'2026-09-12','Idempotency-Key':'boundary-fixture-key'},body:JSON.stringify({input:'Edit the assigned fixture only.',model:'claude-requested',metadata:{harness_id:'claude-code',workspace_id:seed.workspace_id},stream:true,timeout_seconds:5,max_step:1})});
  assert.equal(request.status,200); const events=(await request.text()).split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
  assert.equal(events.at(-1).type,'response.completed',JSON.stringify(events));
  assert.equal(events.at(-1).response.metadata.execution_boundary?.proven,true);
  const result=await readFile(join(work,'worker-edit.txt'),'utf8'); assert.deepEqual(JSON.parse(result),{read:'denied',write:'denied'});
  assert.equal(await readFile(join(work,'inside-edit.txt'),'utf8'),'worker changed assigned file\n');
  assert.equal(await readFile(sentinel,'utf8'),'do-not-read-or-change');
  const snapshot=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces/${seed.workspace_id}/snapshot`)).json();
  const evidence=await verifyBridgeWorkspace({repoPath:fixture.repo,baseCommit:fixture.baseCommit,snapshot,allowedScope:['inside-edit.txt','worker-edit.txt']});
  assert.equal(evidence.validation,'verified_by_foreman_git_comparison');
});

test('Codex Worker edits only its seeded workspace; Foreman verifies the complete snapshot and validates it', async t => {
  const fixture = await createWorkspaceFixture(); t.after(fixture.cleanup);
  const parent = await mkdtemp(join(tmpdir(),'foreman-codex-boundary-')); t.after(()=>rm(parent,{recursive:true,force:true}));
  const sentinel=join(parent,'outside-sentinel'); await writeFile(sentinel,'FOREMAN-CODEX-OUTSIDE-SENTINEL');
  const codexBody = `import {readFileSync,writeFileSync} from 'node:fs'; const path=${JSON.stringify(sentinel)}; let read='allowed',write='allowed'; try{readFileSync(path,'utf8')}catch{read='denied'} try{writeFileSync(path,'CHANGED')}catch{write='denied'} writeFileSync('README.md',${JSON.stringify('# Fixture\n\nCodex changed the assigned README.\n')}); writeFileSync('.boundary-result.json',JSON.stringify({read,write})); console.log(JSON.stringify({type:'thread.started',thread_id:'codex-worker-thread'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Updated README.md in the assigned workspace.'}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:11,output_tokens:7}}));`;
  const {base,env}=await setup(t,{sourceRepo:fixture.repo,baseCommit:fixture.baseCommit,codexBody});
  const uhp = new UhpClient({baseUrl:base,timeoutMs:20_000});
  const controller = new Controller(new JsonStore(join(parent,'foreman-state.json')),uhp,false,true);
  controller.configureVerifiedWorkspace({repoPath:fixture.repo,allowedScope:['README.md','.boundary-result.json'],commands:[{name:'assert verified README content',command:process.execPath,args:['-e',`const fs=require('node:fs');if(fs.readFileSync('README.md','utf8')!=='# Fixture\\n\\nCodex changed the assigned README.\\n')process.exit(1)`]}],bridgeBaseUrl:base,timeoutMs:10_000,maxOutputBytes:2_000});
  await controller.refreshDiscovery();
  const project=await controller.createProject('Codex disposable workspace fixture');
  const task=await controller.createTask(project.id,'Edit the assigned README');
  const run=await controller.createRun(task.id);
  await controller.selectRoleConfig('worker',{harnessId:'codex-cli',model:'codex-requested'},undefined,run.id);
  await controller.prepareWorkerWorkspace(run.id,fixture.baseCommit);
  const assignment=await controller.assign(run.id,'worker','Change README.md with one short sentence.',{harnessId:'codex-cli',model:'codex-requested',options:{maxStep:1,timeoutSeconds:5}});
  assert.equal(assignment.status,'succeeded',JSON.stringify(assignment));
  assert.equal(assignment.actualModelStatus,'unavailable');
  assert.deepEqual(assignment.cliInvocation?.args.slice(-3),['--model','codex-requested','-']);
  assert.equal(assignment.sessionId,'codex-worker-thread');
  assert.match(JSON.stringify(assignment.usage),/\"measured\":true/);
  assert.equal(assignment.usage.inputTokens,11);
  assert.equal(assignment.usage.outputTokens,7);
  const response=await uhp.retrieve(assignment.responseId);
  assert.equal(response.model,undefined);
  assert.equal(response.requested_model,'codex-requested');
  assert.equal(response.metadata?.actual_model_status,'unavailable');
  assert.equal(response.metadata?.execution_boundary?.proven,true);
  assert.equal(response.metadata?.execution_boundary?.workspace_writable,true);
  assert.deepEqual(response.metadata?.cli_invocation?.args.slice(-3),['--model','codex-requested','-']);
  const verified=await controller.verifyWorkerOutput(run.id,assignment.id);
  assert.equal(verified.workerEvidence.provenance,'bridge_snapshot');
  assert.equal(verified.workerEvidence.pinnedBaseCommit,fixture.baseCommit);
  assert.equal(verified.workerEvidence.completeSnapshot.reportedComplete,true);
  assert.equal(verified.workerEvidence.completeSnapshot.reportedErrors,0);
  assert.equal(verified.workerEvidence.scopeVerified,true);
  assert.deepEqual(verified.workerEvidence.changes.map(change=>change.path).sort(),['.boundary-result.json','README.md']);
  assert.equal(verified.validation.status,'passed');
  assert.equal(verified.validation.observations[0].exitCode,0);
  const state=await controller.state();
  const stored=state.projects[0].tasks[0].runs[0];
  assert.equal(stored.assignments.find(item=>item.id===assignment.id).cliInvocation.args.includes('codex-requested'),true);
  assert.equal(stored.workerEvidence.actualModel,undefined);
  assert.equal(stored.workerEvidence.requestedModel,'codex-requested');
  assert.equal(stored.workerEvidence.actualModelStatus,'unavailable');
  assert.equal(await readFile(sentinel,'utf8'),'FOREMAN-CODEX-OUTSIDE-SENTINEL');
  const boundary=JSON.parse(await readFile(join(env.LOCAL_CLI_UHP_WORK,stored.workspaceId,'.boundary-result.json'),'utf8'));
  assert.deepEqual(boundary,{read:'denied',write:'denied'});
});

test('failed boundary probe blocks the tool-enabled CLI before spawn', async t => {
  const fixture = await createWorkspaceFixture(); t.after(fixture.cleanup);
  const parent=await mkdtemp(join(tmpdir(),'foreman-uhp-probe-fail-')); t.after(()=>rm(parent,{recursive:true,force:true}));
  const started=join(parent,'cli-started');
  const fakeCli=await fixtureCli(parent,'marker-cli',`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(started)},'started');`);
  const failedBwrap=await fixtureCli(parent,'failed-bwrap','process.exit(31);');
  const {base}=await setup(t,{sourceRepo:fixture.repo,baseCommit:fixture.baseCommit,claudeBin:fakeCli,bwrapBin:failedBwrap});
  const workspace=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base_commit:fixture.baseCommit})})).json();
  const response=await fetch(`${base}/v1/responses`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream','UHP-Version':'2026-09-12','Idempotency-Key':'failed-boundary-fixture'},body:JSON.stringify({input:'Edit only the assigned fixture.',model:'claude-requested',metadata:{harness_id:'claude-code',workspace_id:workspace.workspace_id},stream:true,timeout_seconds:5,max_step:1})});
  const events=(await response.text()).split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
  assert.equal(events.at(-1).type,'response.failed',JSON.stringify(events));
  assert.equal(events.at(-1).response.metadata.execution_stage,'boundary_probe');
  assert.equal(events.at(-1).response.metadata.execution_boundary.proven,false);
  await assert.rejects(readFile(started));
});
