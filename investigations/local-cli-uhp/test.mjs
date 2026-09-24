import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rm, truncate, mkdir, readdir, stat } from 'node:fs/promises';
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
  const agyDiscoveryEnv = options.agyDiscoveryRequirements ? { HOME:join(dir,'agy-home'), XDG_RUNTIME_DIR:join(dir,'runtime'), DBUS_SESSION_BUS_ADDRESS:`unix:path=${join(dir,'bus')}`, HTTPS_PROXY:'http://fixture-proxy.invalid:8080', AGY_CONFIG_DIR:join(dir,'agy-auth') } : {};
  const fixture = options.sourceRepo ? undefined : await createWorkspaceFixture();
  if (fixture) t.after(fixture.cleanup);
  const claude = await fixtureCli(dir, 'fake-claude', options.claudeBody ?? `import { appendFileSync } from 'node:fs'; const names=['ANTHROPIC_API_KEY','OPENAI_API_KEY','AWS_ACCESS_KEY_ID','GOOGLE_API_KEY','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CODEX_API_KEY']; const model=${JSON.stringify(options.claudeUndefined ? 'undefined' : 'claude-actual')}; const ix=process.argv.indexOf('--model'); appendFileSync('.fixture-cli-count', (names.some(name=>process.env[name]) ? 'c:provider-env-present' : 'c:provider-env-absent')+':model='+(ix<0?'missing':process.argv[ix+1])+'\\n'); process.stdin.resume(); process.stdin.on('end',()=>{ console.log(JSON.stringify({type:'system',subtype:'init',model,session_id:'claude-session'})); console.log(JSON.stringify({type:'result',subtype:${JSON.stringify(options.claudeIsError ? 'error_api_error' : 'success')},is_error:${options.claudeIsError === true},result:'bounded answer',model,session_id:'claude-session',usage:{input_tokens:7,output_tokens:3,cache_read_input_tokens:2,cache_creation_input_tokens:99}})); });`);
  const codex = await fixtureCli(dir, 'fake-codex', options.codexBody ?? `import { appendFileSync } from 'node:fs'; const ix=process.argv.indexOf('--model'); appendFileSync('.fixture-cli-count', (process.env.OPENAI_API_KEY ? 'x:provider-env-present' : 'x:provider-env-absent')+':model='+(ix<0?'missing':process.argv[ix+1])+':ignore-user-config='+process.argv.includes('--ignore-user-config')+':skip-git-repo-check='+process.argv.includes('--skip-git-repo-check')+'\\n'); process.stdin.resume(); process.stdin.on('end',()=>{ console.log(JSON.stringify({type:'thread.started',thread_id:'codex-thread'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'codex bounded answer'}})); console.log(JSON.stringify({type:'turn.completed',${options.codexReportedModel ? `model:${JSON.stringify(options.codexReportedModel)},` : ''}usage:{input_tokens:4,output_tokens:2}})); ${options.codexExit ? 'process.exit(7);' : ''} });`);
  const agyDiscoveryFixtureBody = options.agyDiscoveryRequirements ? `const required=${JSON.stringify(agyDiscoveryEnv)};if(process.argv[2]==='models'){const ok=Object.entries(required).every(([key,value])=>process.env[key]===value)&&!['ANTHROPIC_API_KEY','OPENAI_API_KEY','AWS_ACCESS_KEY_ID','GOOGLE_API_KEY','CODEX_API_KEY'].some(key=>process.env[key]);console.error('fake local server diagnostic');console.log(ok?'gemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)':'');process.exit(ok?0:1)}` : undefined;
  const agy = await fixtureCli(dir, 'fake-agy', options.agyBody ?? agyDiscoveryFixtureBody ?? `import {writeFileSync,readFileSync} from 'node:fs'; if(process.argv[2]==='models'){console.log('gemini-3.8-flash-low\\tGemini 3.8 Flash (Low)');console.log('gemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)');console.log('gemini-3.8-flash-high\\tGemini 3.8 Flash (High)');process.exit(0)} const ix=process.argv.indexOf('--model'); const model=ix<0?'missing':process.argv[ix+1]; const prompt=process.argv[process.argv.indexOf('-p')+1]||''; const agent=readFileSync(process.env.HOME+'/.gemini/config/agents/foreman-worker.md','utf8'); const agentOk=process.argv.includes('--agent')&&process.argv[process.argv.indexOf('--agent')+1]==='foreman-worker'&&process.argv.includes('--add-dir')&&process.argv[process.argv.indexOf('--add-dir')+1]==='/workspace'&&agent.includes('excludeDefaultComponents: true')&&agent.includes('commandExecutionPolicy: "off"')&&['view_file','replace_file_content','multi_replace_file_content','write_to_file','finish'].every(tool=>agent.includes('  - '+tool))&&!agent.includes('  - list_dir')&&prompt.includes('README.md')&&prompt.includes('do not enumerate directories'); writeFileSync('README.md','AGY fixture edit\\n'); const conversation_id='agy-fixture-conversation'; const tools=['ask_permission','run_command','write_to_file','view_file','list_dir','replace_file_content','multi_replace_file_content','finish']; console.log(JSON.stringify({event:'init',conversation_id,agent:agentOk?'foreman-worker':'unexpected-agent',init:{cwd:process.cwd(),model,tools}})); console.log(JSON.stringify({event:'step_update',step_update:{conversation_id,step_index:0,state:'DONE',step_type:'tool',tool_name:'view_file',tool_info:{name:'view_file'}}})); console.log(JSON.stringify({event:'step_update',step_update:{conversation_id,step_index:1,state:'DONE',step_type:'tool',tool_name:'write_to_file',tool_info:{name:'write_to_file'}}})); console.log(JSON.stringify({event:'step_update',step_update:{conversation_id,step_index:2,state:'DONE',step_type:'agent_response',text_delta:'Edited README.\\n',usage:{input_tokens:11,output_tokens:4}}})); console.log(JSON.stringify({event:'result',result:{conversation_id,status:'SUCCESS',response:'Edited README.',model,usage:{input_tokens:11,output_tokens:4,thinking_tokens:2,cache_read_tokens:3,total_tokens:15}}}));`);
  const port = 22000 + Math.floor(Math.random() * 20000);
  if (options.agyEnabled) {
    await mkdir(join(dir,'agy-auth'));
    for (const name of ['log','crashes','brain','conversations','cache','updater','presence','annotations','implicit','scratch']) await mkdir(join(dir,'agy-auth',name));
  }
  await mkdir(join(dir,'claude-auth'));
  if (!options.claudeAuthRoleDirsAbsent) for (const name of ['projects','session-env','file-history','todos','plans','tasks']) await mkdir(join(dir,'claude-auth',name));
  await mkdir(join(dir,'codex-auth')); await writeFile(join(dir,'codex-auth','auth.json'),'{"fixture":true}',{mode:0o600});
  const env = { ...process.env, ANTHROPIC_API_KEY:'fixture-only-do-not-forward', OPENAI_API_KEY:'fixture-only-do-not-forward', AWS_ACCESS_KEY_ID:'fixture-only-do-not-forward', GOOGLE_API_KEY:'fixture-only-do-not-forward', CLAUDE_CODE_USE_BEDROCK:'1', CLAUDE_CODE_USE_VERTEX:'1', CLAUDE_CODE_USE_FOUNDRY:'1', CODEX_API_KEY:'fixture-only-do-not-forward', ...(options.claudeNetworkRequirements ? {HTTP_PROXY:'http://fixture-proxy.invalid:8080'} : {}), ...(Number.isFinite(options.keepaliveMs) ? {LOCAL_CLI_UHP_KEEPALIVE_MS:String(options.keepaliveMs)} : {}), ...(options.agyWorkerEffort ? {AGY_WORKER_EFFORT:options.agyWorkerEffort} : {}), LOCAL_CLI_UHP_PORT: String(port), LOCAL_CLI_UHP_STATE: join(dir, 'state.json'), LOCAL_CLI_UHP_WORK: join(dir, 'work'), FOREMAN_CLAUDE_USAGE_CACHE: join(dir,'claude-usage-cache.json'), CLAUDE_CONFIG_DIR: join(dir, 'claude-auth'), CODEX_HOME: join(dir, 'codex-auth'), CLAUDE_MODEL: options.noClaudeModel ? '' : 'claude-requested', CODEX_MODEL: 'codex-requested', CLAUDE_BIN: options.claudeBin ?? (options.spawnError ? join(dir,'missing-cli') : claude), CODEX_BIN: codex, AGY_BIN:join(dir,'missing-agy'), ...(options.agyEnabled ? { AGY_CONFIG_DIR: join(dir,'agy-auth'), ...(options.noAgyModel ? {} : {AGY_MODEL:options.agyModel ?? 'gemini-3.8-flash-medium'}), AGY_BIN:agy } : {}), ...agyDiscoveryEnv, LOCAL_CLI_UHP_SOURCE_REPO: options.sourceRepo ?? fixture.repo, LOCAL_CLI_UHP_BWRAP: options.bwrapBin ?? 'bwrap' };
  if (options.noAgyModel) delete env.AGY_MODEL;
  if (!options.agyWorkerEffort) delete env.AGY_WORKER_EFFORT;
  if (options.agyEnabled) Object.assign(env,{AGY_CONFIG_DIR:join(dir,'agy-auth'),...(options.noAgyModel?{}:{AGY_MODEL:options.agyModel ?? 'gemini-3.8-flash-medium'}),AGY_BIN:agy});
  let proc = spawn(process.execPath, [join(here, 'server.mjs')], { env, stdio: 'ignore' });
  t.after(async () => { if (proc.exitCode === null) { proc.kill('SIGTERM'); await new Promise(r => proc.once('exit', r)); } await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i=0;i<100;i++) { try { const r=await fetch(`${base}/v1/uhp`); if(r.ok) break; } catch {} await new Promise(r=>setTimeout(r,20)); }
  return { base, dir, env, baseCommit: options.baseCommit ?? fixture?.baseCommit, sourceRepo: options.sourceRepo ?? fixture?.repo, countFor: workspaceId=>join(env.LOCAL_CLI_UHP_WORK,workspaceId,'.fixture-cli-count'), restart: async () => { proc.kill('SIGTERM'); await new Promise(r => proc.once('exit', r)); proc = spawn(process.execPath, [join(here, 'server.mjs')], { env, stdio: 'ignore' }); for(let i=0;i<100;i++){try{if((await fetch(`${base}/v1/uhp`)).ok)break;}catch{} await new Promise(r=>setTimeout(r,20));} } };
}
async function submit(base, harness, model, key, baseCommit, workspaceId, input = 'Say bounded answer') {
  const seeded=workspaceId ? {workspace_id:workspaceId} : await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base_commit:baseCommit})})).json();
  const r = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { 'Content-Type':'application/json', Accept:'text/event-stream', 'UHP-Version':'2026-09-12', 'Idempotency-Key':key }, body: JSON.stringify({ input, model, metadata:{harness_id:harness,workspace_id:seeded.workspace_id}, stream:true, timeout_seconds:5, max_step:1 }) });
  const text=await r.text(); assert.equal(r.status,200,text); return text.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
}
function terminalEvent(events) { return events.find(item=>['response.completed','response.failed','response.cancelled'].includes(item.type)); }
function reviewEvidence(overrides = {}) { return { validation:'verified_by_foreman_git_comparison', scopeVerified:true, baseCommit:'a'.repeat(40), workerResponseId:'resp_worker_fixture', allowedScope:['src/example.ts'], reviewDiff:'### modify: src/example.ts\n- before\n+ after\n', controllerValidation:{passed:true,policy:{requireAllChecksPass:true,configuredCheckCount:1},observations:[{name:'typecheck',command:'node',args:['--check','src/example.ts'],exitCode:0,signal:null,timedOut:false,output:'passed',outputTruncated:false,passed:true,startedAt:'2026-09-22T00:00:00Z',finishedAt:'2026-09-22T00:00:01Z'}]}, ...overrides }; }
async function submitReview(base, harness, key, metadata = {}, input = 'Review this change for correctness and return a recommendation.') {
  const r = await fetch(`${base}/v1/responses`, {method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream','UHP-Version':'2026-09-12','Idempotency-Key':key},body:JSON.stringify({input,model:harness==='claude-code'?'claude-requested':'codex-requested',metadata:{harness_id:harness,role_id:'reviewer',foreman_review_mode:'read_only',review_evidence:reviewEvidence(),...metadata},stream:true,timeout_seconds:5,max_step:1})});
  const text=await r.text(); return {status:r.status, body:r.headers.get('content-type')?.includes('json')?JSON.parse(text):undefined, events:text.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)))};
}
test('discovery advertises configured CLIs and Claude submit/replay retains idempotent response across restart', async t => {
  const {base,baseCommit,countFor,restart}=await setup(t);
  const d=await (await fetch(`${base}/v1/uhp`)).json(); assert.equal(d.default_version,'2026-09-12'); assert.equal(d.capabilities.sessions,true);
  const hs=await (await fetch(`${base}/v1/harnesses`)).json(); assert.deepEqual(hs.harnesses.map(x=>x.id),['claude-code','codex-cli']);
  const first=await submit(base,'claude-code','claude-requested','same-key',baseCommit); assert.equal(first[0].type,'response.created'); assert.equal(terminalEvent(first)?.type,'response.completed',JSON.stringify(first));
  const r=terminalEvent(first).response; assert.equal(r.output_text,'bounded answer'); assert.equal(r.model,'claude-actual'); assert.equal(r.session_id,'claude-session'); assert.equal(r.metadata.session_id,'claude-session'); assert.deepEqual(r.usage,{input_tokens:7,output_tokens:3,input_tokens_details:{cached_tokens:2}});
  assert.equal(r.metadata.execution_boundary?.proven,true);
  assert.equal(r.metadata.requested_model,'claude-requested'); assert.equal(r.metadata.model_fallback,true);
  const workspaceId=r.metadata.workspace_id; const second=await submit(base,'claude-code','claude-requested','same-key',baseCommit,workspaceId); assert.equal(terminalEvent(second).response.id,r.id);
  await restart();
  const afterRestart=await submit(base,'claude-code','claude-requested','same-key',baseCommit,workspaceId); assert.equal(terminalEvent(afterRestart).response.id,r.id);
  assert.equal((await readFile(countFor(workspaceId),'utf8')).trim(),'c:provider-env-absent:model=claude-requested');
  const retrieved=await (await fetch(`${base}/v1/responses/${r.id}`,{headers:{'UHP-Version':'2026-09-12'}})).json(); assert.equal(retrieved.id,r.id);
});
test('discovery omits configured provider auth when its CLI executable is missing', async t => {
  const dir=await mkdtemp(join(tmpdir(),'local-cli-missing-binary-')); dirs.push(dir);
  const {base}=await setup(t,{claudeBin:join(dir,'missing-claude')});
  const harnesses=await (await fetch(`${base}/v1/harnesses`)).json();
  assert.deepEqual(harnesses.harnesses.map(item=>item.id),['codex-cli']);
});

test('Foreman UhpClient discovers, submits, validates fallback/session/usage, and replays idempotently', async t => {
  const claudeBody=`process.stdin.resume();process.stdin.on('end',()=>{const model='claude-actual';console.log(JSON.stringify({type:'system',subtype:'init',model,session_id:'claude-session'}));console.log(JSON.stringify({type:'result',subtype:'success',result:'bounded answer',model,session_id:'claude-session',usage:{input_tokens:7,output_tokens:3,cache_read_input_tokens:2}}));});`;
  const {base}=await setup(t,{claudeBody});
  const client=new UhpClient({baseUrl:base,harnessId:'claude-code',model:'claude-requested'});
  const discovery=await client.discover(); assert.equal(discovery.version,'2026-09-12'); assert.equal(discovery.capabilities.sessions,true);
  const seen=[]; const input={submissionId:'sub-smoke-fixture',assignmentId:'assignment-fixture',runId:'run-fixture',roleId:'planner',taskId:'task-fixture',projectId:'project-fixture',prompt:'Reply with one bounded sentence.',config:{harnessId:'claude-code',model:'claude-requested',timeoutSeconds:5},idempotencyKey:'uhpclient-fixed-fixture-key',onEvent:e=>seen.push(e.type)};
  const first=await client.submit(input); assert.equal(first.status,'completed'); assert.equal(first.actualModel,'claude-actual'); assert.equal(first.requestedModel,'claude-requested'); assert.equal(first.modelFallback,true); assert.equal(first.selectedHarnessId,'claude-code'); assert.equal(first.sessionId,'claude-session'); assert.equal(first.responseId,first.externalId); assert.deepEqual(first.usage,{inputTokens:7,outputTokens:3,cachedInputTokens:2}); assert.equal(seen[0],'response.created'); assert.equal(seen.at(-1),'response.completed');
  const replay=await client.submit(input); assert.equal(replay.responseId,first.responseId);
  const stored=await (await fetch(`${base}/v1/responses/${first.responseId}`)).json(); assert.equal(stored.metadata.workspace_id,undefined); assert.equal(stored.metadata.execution_boundary.role_context_isolated,true);
  assert.equal(stored.metadata.cli_invocation.args[stored.metadata.cli_invocation.args.indexOf('--max-turns')+1],'10');
});

test('UHP SSE keepalives reset the client inactivity timer during a quiet CLI turn', async t => {
  const body=`process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-requested',session_id:'slow-session'}));console.log(JSON.stringify({type:'result',subtype:'success',result:'slow bounded answer',model:'claude-requested',session_id:'slow-session',usage:{input_tokens:3,output_tokens:2}}));},1250));`;
  const {base}=await setup(t,{claudeBody:body,keepaliveMs:100});
  const client=new UhpClient({baseUrl:base,harnessId:'claude-code',model:'claude-requested',timeoutMs:5_000,streamInactivityTimeoutMs:1_000});
  const seen=[]; const started=Date.now();
  const result=await client.submit({submissionId:'slow-submission',assignmentId:'slow-assignment',runId:'slow-run',roleId:'planner',taskId:'slow-task',projectId:'slow-project',prompt:'Reply once after the quiet interval.',config:{harnessId:'claude-code',model:'claude-requested',timeoutSeconds:5,maxStep:1},idempotencyKey:'slow-sse-keepalive-key',onEvent:event=>seen.push(event.type)});
  assert.ok(Date.now()-started>=1_000);
  assert.equal(result.status,'completed'); assert.equal(result.outputText,'slow bounded answer');
  assert.equal(seen[0],'response.created'); assert.equal(seen.at(-1),'response.completed');
});

test('Planner continuation binds the same native session and keeps a workspace-free role context', async t => {
  const claudeBody=`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-requested',session_id:'planner-native-session'}));console.log(JSON.stringify({type:'result',subtype:'success',result:'planner turn',model:'claude-requested',session_id:'planner-native-session',usage:{input_tokens:2,output_tokens:1}}));});`;
  const {base}=await setup(t,{claudeBody});
  const submitTurn=async (key,previousResponseId)=> {
    const response=await fetch(`${base}/v1/responses`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream','UHP-Version':'2026-09-12','Idempotency-Key':key},body:JSON.stringify({input:'Planner turn',model:'claude-requested',previous_response_id:previousResponseId,metadata:{harness_id:'claude-code',foreman_run_id:'run-session-fixture',foreman_role_id:'planner',foreman_project_id:'project-session-fixture'},stream:true,timeout_seconds:5,max_step:1})});
    const text=await response.text(); assert.equal(response.status,200,text); return text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).at(-1).response;
  };
  const first=await submitTurn('planner-first');
  assert.equal(first.status,'completed'); assert.equal(first.metadata.workspace_id,undefined);
  assert.equal(first.metadata.role_session.cli_session_id,'planner-native-session');
  assert.match(first.metadata.role_session.state_path,/role-sessions\/[a-f0-9]{64}$/);
  const second=await submitTurn('planner-second',first.id);
  assert.equal(second.status,'completed'); assert.equal(second.session_id,'planner-native-session');
  assert.deepEqual(second.metadata.cli_invocation.args.slice(-2),['--resume','planner-native-session']);
  assert.equal(second.metadata.role_session.state_path,first.metadata.role_session.state_path);
});
test('Claude role mounts create missing transcript directories outside the host auth view', async t => {
  const body=`import {readFileSync} from 'node:fs';process.stdin.resume();process.stdin.on('end',()=>{const ca=readFileSync(process.env.SSL_CERT_FILE,'utf8').includes('-----BEGIN CERTIFICATE-----');const keys=['ANTHROPIC_API_KEY','OPENAI_API_KEY','AWS_ACCESS_KEY_ID','GOOGLE_API_KEY','CODEX_API_KEY','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'].some(k=>process.env[k]);const proxy=process.env.HTTP_PROXY==='http://fixture-proxy.invalid:8080';console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-requested',session_id:'missing-dirs-session'}));console.log(JSON.stringify({type:'result',subtype:'success',result:'ca='+ca+';proxy='+proxy+';provider_keys='+keys,model:'claude-requested',session_id:'missing-dirs-session',usage:{input_tokens:2,output_tokens:1}}));if(!ca||!proxy||keys)process.exit(9)});`;
  const {base,env}=await setup(t,{claudeAuthRoleDirsAbsent:true,claudeNetworkRequirements:true,claudeBody:body});
  const response=await fetch(`${base}/v1/responses`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream','UHP-Version':'2026-09-12','Idempotency-Key':'claude-missing-auth-dirs'},body:JSON.stringify({input:'Planner fixture',model:'claude-requested',metadata:{harness_id:'claude-code',foreman_run_id:'run-missing-dirs',foreman_role_id:'planner',foreman_project_id:'project-missing-dirs'},stream:true,timeout_seconds:5,max_step:1})});
  const text=await response.text(); assert.equal(response.status,200,text);
  const result=text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).at(-1).response;
  assert.equal(result.status,'completed',JSON.stringify(result));
  assert.equal(result.output_text,'ca=true;proxy=true;provider_keys=false');
  assert.deepEqual(await readdir(env.CLAUDE_CONFIG_DIR),[]);
  const statePath=result.metadata.role_session.state_path;
  for (const name of ['todos','plans','tasks']) assert.ok((await readdir(statePath)).includes(`claude-${name}`));
});
test('Codex parser returns reported output and leaves unavailable model/usage absent', async t => {
  const {base,baseCommit,countFor}=await setup(t);
  const events=await submit(base,'codex-cli','codex-requested','codex-key',baseCommit); const r=terminalEvent(events).response;
  assert.equal(terminalEvent(events).type,'response.completed',JSON.stringify(events)); assert.equal(r.output_text,'codex bounded answer'); assert.equal(r.model,undefined);
  assert.equal(r.requested_model,'codex-requested'); assert.equal(r.metadata.actual_model_status,'unavailable');
  assert.equal(r.metadata.cli_invocation.executable,'/opt/codex');
  assert.equal(r.metadata.cli_invocation.host_executable.endsWith('/fake-codex'),true);
  assert.ok(r.metadata.cli_invocation.args.includes('workspace-write'));
  assert.deepEqual(r.metadata.cli_invocation.args.slice(-3),['--model','codex-requested','-']);
  assert.equal(r.session_id,'codex-thread'); assert.deepEqual(r.usage,{input_tokens:4,output_tokens:2});
  assert.equal(r.metadata.execution_boundary.proven,true);
  assert.equal((await readFile(countFor(r.metadata.workspace_id),'utf8')).trim(),'x:provider-env-absent:model=codex-requested:ignore-user-config=true:skip-git-repo-check=true');
});

test('AGY Worker effort is an explicit optional flag and leaves the requested model unchanged', async t => {
  for (const effort of ['low', 'medium', 'high']) {
    const {base,baseCommit}=await setup(t,{agyEnabled:true,agyWorkerEffort:effort});
    const events=await submit(base,'antigravity-cli','gemini-3.8-flash-high',`agy-effort-${effort}`,baseCommit,undefined,'Edit README.md with the requested fixture change.');
    const response=events.at(-1).response;
    assert.equal(response.status,'completed',JSON.stringify(events));
    assert.equal(response.requested_model,'gemini-3.8-flash-high');
    assert.equal(response.model,'gemini-3.8-flash-high');
    const args=response.metadata.cli_invocation.args;
    assert.equal(args[args.indexOf('--effort')+1],effort);
    assert.equal(args.filter(arg=>arg==='--effort').length,1);
    assert.equal(args[args.indexOf('--model')+1],'gemini-3.8-flash-high');
  }
});

test('AGY_WORKER_EFFORT rejects unsupported values at startup', async () => {
  const child=spawn(process.execPath,[join(here,'server.mjs')],{env:{...process.env,AGY_WORKER_EFFORT:'urgent',LOCAL_CLI_UHP_WORK:join(tmpdir(),`local-cli-uhp-invalid-${process.pid}`)},stdio:['ignore','ignore','pipe']});
  let stderr=''; child.stderr.setEncoding('utf8'); child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise((resolveCode,reject)=>{child.once('error',reject);child.once('exit',resolveCode);});
  assert.equal(code,1);
  assert.match(stderr,/AGY_WORKER_EFFORT must be low, medium, or high/);
});

test('AGY discovery pins only listed models and its stream result edits only the pinned workspace', async t => {
  const {base,baseCommit,env}=await setup(t,{agyEnabled:true});
  const harnesses=await (await fetch(`${base}/v1/harnesses`)).json(); assert.ok(harnesses.harnesses.some(h=>h.id==='antigravity-cli'));
  const models=await (await fetch(`${base}/v1/harnesses/antigravity-cli/models`)).json(); assert.deepEqual(models.models.map(m=>m.id),['gemini-3.8-flash-low','gemini-3.8-flash-medium','gemini-3.8-flash-high']);
  const events=await submit(base,'antigravity-cli','gemini-3.8-flash-high','agy-stream-fixture-key',baseCommit,undefined,'Edit README.md by replacing its contents with AGY fixture edit.'); const response=events.at(-1).response;
  assert.equal(events.at(-1).type,'response.completed',JSON.stringify(events));
  assert.equal(response.output_text,'Edited README.'); assert.equal(response.model,'gemini-3.8-flash-high');
  assert.equal(response.session_id,'agy-fixture-conversation'); assert.equal(response.metadata.session_id,'agy-fixture-conversation');
  assert.equal(response.metadata.agy_diagnostic.observed_agent,'foreman-worker');
  assert.equal(response.metadata.agy_diagnostic.requested_execution_mode,'accept-edits');
  assert.equal(response.metadata.agy_diagnostic.available_tools_semantics,'headless_init_tools_available_to_cli_not_profile_allowlist');
  assert.ok(response.metadata.agy_diagnostic.available_tools.includes('run_command'));
  assert.deepEqual(response.metadata.agy_worker_tool_policy.observed_executed_tool_events,['view_file','write_to_file']);
  assert.equal(response.metadata.agy_worker_tool_policy.execution_observations_passed,true);
  assert.equal(response.metadata.agy_permission_policy.read_file_allow,'read_file(/workspace)');
  assert.equal(response.metadata.agy_permission_policy.write_file_allow,'write_file(/workspace)');
  assert.equal(response.metadata.agy_permission_policy.directory_listing,'not allowed; task must name exact relative file paths');
  assert.deepEqual(response.metadata.cli_invocation.args.slice(-5),['--mode=accept-edits','--add-dir','/workspace','--agent','foreman-worker']);
  assert.equal(response.metadata.cli_invocation.args.includes('--effort'),false);
  assert.deepEqual(response.usage,{input_tokens:11,output_tokens:4,total_tokens:15,thinking_tokens:2,input_tokens_details:{cached_tokens:3}});
  assert.equal(response.metadata.execution_boundary.proven,true);
  const snapshot=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces/${response.metadata.workspace_id}/snapshot`)).json();
  assert.equal(snapshot.complete,true,JSON.stringify(snapshot.errors));
  const evidence=await verifyBridgeWorkspace({repoPath:env.LOCAL_CLI_UHP_SOURCE_REPO,baseCommit, snapshot,allowedScope:['README.md']});
  assert.equal(evidence.validation,'verified_by_foreman_git_comparison'); assert.equal(evidence.scopeVerified,true);
  assert.equal(evidence.changes.length,1); assert.equal(evidence.changes[0].path,'README.md');
});

test('AGY model discovery keeps host runtime access while filtering provider credential variables', async t => {
  const {base}=await setup(t,{agyEnabled:true,agyDiscoveryRequirements:true});
  const harnesses=await (await fetch(`${base}/v1/harnesses`)).json();
  assert.ok(harnesses.harnesses.some(harness=>harness.id==='antigravity-cli'),JSON.stringify(harnesses));
  const models=await (await fetch(`${base}/v1/harnesses/antigravity-cli/models`)).json();
  assert.deepEqual(models.models.map(model=>model.id),['gemini-3.8-flash-medium']);
});

test('AGY defaults to Flash Low only when host model discovery lists it', async t => {
  const {base}=await setup(t,{agyEnabled:true,noAgyModel:true});
  const harnesses=await (await fetch(`${base}/v1/harnesses`)).json();
  assert.ok(harnesses.harnesses.some(harness=>harness.id==='antigravity-cli'),JSON.stringify(harnesses));
  const models=await (await fetch(`${base}/v1/harnesses/antigravity-cli/models`)).json();
  assert.ok(models.models.some(model=>model.id==='gemini-3.8-flash-low'));
});

test('AGY malformed stream fails closed without returning a complete worker snapshot', async t => {
  const body=`if(process.argv[2]==='models'){console.log('gemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)');process.exit(0)}console.log(JSON.stringify({event:'init',conversation_id:'agy-malformed',agent:'foreman-worker',init:{tools:['view_file','list_dir','replace_file_content','multi_replace_file_content','write_to_file','finish']}}));console.log('not-json');`;
  const {base,baseCommit}=await setup(t,{agyEnabled:true,agyBody:body});
  const events=await submit(base,'antigravity-cli','gemini-3.8-flash-medium','agy-malformed-key',baseCommit); const response=events.at(-1).response;
  assert.equal(events.at(-1).type,'response.failed',JSON.stringify(events));
  assert.equal(response.error.message,'CLI output contained malformed or unrecognized stream records');
  const snapshot=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces/${response.metadata.workspace_id}/snapshot`)).json();
  assert.equal(snapshot.complete,false); assert.ok(snapshot.errors.some(error=>/task_status_failed/.test(error.error)));
});

test('AGY success with an empty response distinguishes headless soft denial from a completed no-edit answer', async t => {
  const body=`import {readFileSync} from 'node:fs';if(process.argv[2]==='models'){console.log('gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)');process.exit(0)}const prompt=process.argv[process.argv.indexOf('-p')+1]||'';let config={};let settingsRead=false;try{config=JSON.parse(readFileSync(process.env.HOME+'/.gemini/antigravity-cli/settings.json','utf8'));settingsRead=true}catch{}let agent='';try{agent=readFileSync(process.env.HOME+'/.gemini/config/agents/foreman-worker.md','utf8')}catch{}const allow=config.permissions?.allow||[];const setupOk=settingsRead&&config.agentMode==='accept-edits'&&config.enableTerminalSandbox===false&&allow.includes('read_file(/workspace)')&&allow.includes('write_file(/workspace)')&&allow.length===2&&!allow.some(rule=>rule.startsWith('command('))&&process.argv.includes('--mode=accept-edits')&&process.argv.includes('--add-dir')&&process.argv[process.argv.indexOf('--add-dir')+1]==='/workspace'&&process.argv.includes('--agent')&&agent.includes('excludeDefaultComponents: true')&&agent.includes('commandExecutionPolicy: "off"')&&prompt.includes('Do not run shell or terminal commands')&&prompt.includes('Foreman will inspect the complete workspace snapshot')&&prompt.includes('do not enumerate directories');const conversation_id='agy-soft-denied';console.error('Tool list_dir was soft-denied in headless mode.');const tools=['ask_permission','run_command','write_to_file','view_file','list_dir','replace_file_content','multi_replace_file_content','finish'];console.log(JSON.stringify({event:'init',conversation_id,agent:'foreman-worker',init:{cwd:'/workspace',model:'gemini-3.8-flash-medium',permission_mode:'request-review',tools:setupOk?tools:['run_command']}}));console.log(JSON.stringify({event:'step_update',step_update:{conversation_id,step_index:1,state:'DONE',step_type:'tool',tool_name:'list_dir',tool_info:{name:'list_dir',error:{type:'PermissionDenied',message:'Approval required in headless mode'}}}}));console.log(JSON.stringify({event:'result',result:{conversation_id,status:'SUCCESS',response:'',model:'gemini-3.8-flash-medium',usage:{input_tokens:14,output_tokens:2,total_tokens:16}}}));`;
  const {base,baseCommit,env}=await setup(t,{agyEnabled:true,agyBody:body});
  const events=await submit(base,'antigravity-cli','gemini-3.8-flash-medium','agy-soft-denied-key',baseCommit); const response=events.at(-1).response;
  assert.equal(events.at(-1).type,'response.failed',JSON.stringify(events));
  assert.equal(response.output_text,''); assert.equal(response.usage.input_tokens,14);
  assert.deepEqual(response.metadata.agy_diagnostic,{permission_mode:'request-review',observed_agent:'foreman-worker',cwd:'assigned_workspace',available_tools:['ask_permission','run_command','write_to_file','view_file','list_dir','replace_file_content','multi_replace_file_content','finish'],available_tools_semantics:'headless_init_tools_available_to_cli_not_profile_allowlist',tool_events:[{step_index:1,name:'list_dir',state:'DONE',error_category:'permission_denied'}],tool_lifecycle_update_count:1,distinct_tool_step_count:1,soft_denial_observed:true,result_status:'SUCCESS',response_empty:true,response_characters:0,streamed_agent_text_characters:0,requested_agent:'foreman-worker',agent_definition_sha256:response.metadata.agy_diagnostic.agent_definition_sha256,requested_execution_mode:'accept-edits',outcome:'soft_denied_without_response'});
  assert.match(response.metadata.agy_diagnostic.agent_definition_sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(response.metadata.agy_worker_tool_policy.unsafe_tool_events,['list_dir']);
  assert.equal(response.metadata.agy_worker_tool_policy.execution_observations_passed,false);
  assert.equal(response.metadata.cli_invocation.args.includes('--agent'),true);
  assert.equal(response.metadata.cli_invocation.args[response.metadata.cli_invocation.args.indexOf('--agent')+1],'foreman-worker');
  assert.deepEqual(response.metadata.agy_permission_policy,{read_file_allow:'read_file(/workspace)',write_file_allow:'write_file(/workspace)',directory_listing:'not allowed; task must name exact relative file paths',terminal_sandbox_disabled_for_nested_runtime:true,outer_bubblewrap_isolation:true});
  assert.doesNotMatch(JSON.stringify(response),/soft-denied because approval/);
  const snapshot=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces/${response.metadata.workspace_id}/snapshot`)).json();
  assert.equal(snapshot.complete,false,JSON.stringify(snapshot.errors));
  assert.ok(snapshot.errors.some(error=>/task_status_failed/.test(error.error)));
  assert.deepEqual((await readdir(env.AGY_CONFIG_DIR)).sort(),['annotations','brain','cache','conversations','crashes','implicit','log','presence','scratch','updater'].sort());
});

test('AGY successful no-edit response is distinct from a headless soft denial', async t => {
  const body=`if(process.argv[2]==='models'){console.log('gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)');process.exit(0)}const conversation_id='agy-no-edit-answer';console.log(JSON.stringify({event:'init',conversation_id,agent:'foreman-worker',init:{cwd:'/workspace',model:'gemini-3.8-flash-medium',permission_mode:'accept-edits',tools:['view_file','list_dir','replace_file_content','multi_replace_file_content','write_to_file','finish']}}));console.log(JSON.stringify({event:'step_update',step_update:{conversation_id,step_index:1,state:'DONE',step_type:'agent_response',text_delta:'No edit is needed.\\n'}}));console.log(JSON.stringify({event:'result',result:{conversation_id,status:'SUCCESS',response:'No edit is needed.',model:'gemini-3.8-flash-medium',usage:{input_tokens:9,output_tokens:4,total_tokens:13}}}));`;
  const {base,baseCommit,env}=await setup(t,{agyEnabled:true,agyBody:body});
  const events=await submit(base,'antigravity-cli','gemini-3.8-flash-medium','agy-no-edit-answer-key',baseCommit); const response=events.at(-1).response;
  assert.equal(events.at(-1).type,'response.completed',JSON.stringify(events));
  assert.equal(response.output_text,'No edit is needed.');
  assert.equal(response.metadata.agy_diagnostic.soft_denial_observed,false);
  assert.equal(response.metadata.agy_diagnostic.outcome,'response_received');
  assert.equal(response.metadata.agy_diagnostic.tool_events.length,0);
  const snapshot=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces/${response.metadata.workspace_id}/snapshot`)).json();
  const evidence=await verifyBridgeWorkspace({repoPath:env.LOCAL_CLI_UHP_SOURCE_REPO,baseCommit,snapshot,allowedScope:['README.md']});
  assert.deepEqual(evidence.changes,[]);
});

test('AGY Worker permits selected custom agent with global tool catalog, but rejects an attempted shell tool', async t => {
  const body=`if(process.argv[2]==='models'){console.log('gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)');process.exit(0)}const conversation_id='agy-command-tool-attempt';console.log(JSON.stringify({event:'init',conversation_id,agent:'foreman-worker',init:{cwd:'/workspace',model:'gemini-3.8-flash-medium',permission_mode:'request-review',tools:['ask_permission','run_command','write_to_file','view_file','list_dir','replace_file_content','multi_replace_file_content','finish']}}));for(let i=0;i<41;i++){const name=i===40?'run_command':'view_file';console.log(JSON.stringify({event:'step_update',step_update:{conversation_id,step_index:i,state:name==='run_command'?'ACTIVE':'DONE',step_type:'tool',tool_name:name,tool_info:{name,error:name==='run_command'?{type:'PermissionDenied',message:'Approval required'}:undefined}}}));if(i===0)console.log(JSON.stringify({event:'step_update',step_update:{conversation_id,step_index:i,state:'DONE',step_type:'tool',tool_name:name,tool_info:{name}}}))}console.log(JSON.stringify({event:'result',result:{conversation_id,status:'SUCCESS',response:'No work performed.',model:'gemini-3.8-flash-medium'}}));`;
  const {base,baseCommit}=await setup(t,{agyEnabled:true,agyBody:body});
  const events=await submit(base,'antigravity-cli','gemini-3.8-flash-medium','agy-command-advertised-key',baseCommit); const response=events.at(-1).response;
  assert.equal(events.at(-1).type,'response.failed',JSON.stringify(events));
  assert.equal(response.error.message,'AGY Worker selected the wrong agent or executed an out-of-profile tool');
  assert.deepEqual(response.metadata.agy_worker_tool_policy.unsafe_tool_events,['run_command']);
  assert.equal(response.metadata.agy_worker_tool_policy.execution_observations_passed,false);
  assert.equal(response.metadata.agy_diagnostic.observed_agent,'foreman-worker');
  assert.equal(response.metadata.agy_diagnostic.permission_mode,'request-review');
  assert.equal(response.metadata.agy_diagnostic.requested_execution_mode,'accept-edits');
  assert.deepEqual(response.metadata.agy_diagnostic.available_tools,['ask_permission','run_command','write_to_file','view_file','list_dir','replace_file_content','multi_replace_file_content','finish']);
  assert.equal(response.metadata.agy_diagnostic.tool_events.length,41);
  assert.equal(response.metadata.agy_diagnostic.tool_events[40].name,'run_command');
  assert.equal(response.metadata.agy_diagnostic.tool_events[40].state,'ACTIVE');
  assert.equal(response.metadata.agy_diagnostic.tool_events[40].step_index,40);
  const snapshot=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces/${response.metadata.workspace_id}/snapshot`)).json();
  assert.equal(snapshot.complete,false);
});

test('AGY lifecycle updates collapse by step while ACTIVE unsafe attempts remain visible', async t => {
  const body=`if(process.argv[2]==='models'){console.log('gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)');process.exit(0)}const conversation_id='agy-lifecycle-dedup';console.log(JSON.stringify({event:'init',conversation_id,agent:'foreman-worker',init:{cwd:'/workspace',permission_mode:'request-review'}}));for(const [step_index,state,tool_name,error] of [[3,'ACTIVE','view_file',undefined],[3,'ERROR','view_file',{type:'PermissionDenied',message:'Approval required'}],[4,'ACTIVE','view_file',undefined],[4,'DONE','view_file',undefined],[5,'ACTIVE','run_command',undefined]])console.log(JSON.stringify({event:'step_update',step_update:{conversation_id,step_index,state,step_type:'tool',tool_name,tool_info:{name:tool_name,error}}}));console.log(JSON.stringify({event:'result',result:{conversation_id,status:'SUCCESS',response:'Done.',num_turns:2}}));`;
  const {base,baseCommit}=await setup(t,{agyEnabled:true,agyBody:body});
  const events=await submit(base,'antigravity-cli','gemini-3.8-flash-medium','agy-lifecycle-dedup-key',baseCommit); const response=events.at(-1).response;
  assert.equal(events.at(-1).type,'response.failed',JSON.stringify(events));
  assert.deepEqual(response.metadata.agy_diagnostic.tool_events,[
    {step_index:3,name:'view_file',state:'ERROR',error_category:'permission_denied'},
    {step_index:4,name:'view_file',state:'DONE'},
    {step_index:5,name:'run_command',state:'ACTIVE'},
  ]);
  assert.equal(response.metadata.agy_diagnostic.tool_lifecycle_update_count,5);
  assert.equal(response.metadata.agy_diagnostic.distinct_tool_step_count,3);
  assert.equal(response.metadata.agy_diagnostic.reported_cli_turns,2);
  assert.equal(response.metadata.agy_diagnostic.response_characters,5);
  assert.equal(response.metadata.agy_diagnostic.result_status,'SUCCESS');
  assert.match(response.metadata.submitted_prompt_sha256,/^[a-f0-9]{64}$/);
  assert.match(response.metadata.agy_diagnostic.agent_definition_sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(response.metadata.agy_worker_tool_policy.observed_executed_tool_events,['view_file','view_file','run_command']);
  assert.deepEqual(response.metadata.agy_worker_tool_policy.unsafe_tool_events,['run_command']);
  assert.equal(response.metadata.agy_worker_tool_policy.execution_observations_passed,false);
});

test('AGY Worker rejects a different init.agent even when it executes only an allowed file tool', async t => {
  const body=`if(process.argv[2]==='models'){console.log('gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)');process.exit(0)}const conversation_id='agy-wrong-agent';console.log(JSON.stringify({event:'init',conversation_id,agent:'default',init:{cwd:'/workspace',model:'gemini-3.8-flash-medium',tools:['run_command','view_file','write_to_file']}}));console.log(JSON.stringify({event:'step_update',step_update:{conversation_id,step_index:1,state:'DONE',step_type:'tool',tool_name:'view_file',tool_info:{name:'view_file'}}}));console.log(JSON.stringify({event:'result',result:{conversation_id,status:'SUCCESS',response:'Read file.',model:'gemini-3.8-flash-medium'}}));`;
  const {base,baseCommit}=await setup(t,{agyEnabled:true,agyBody:body});
  const events=await submit(base,'antigravity-cli','gemini-3.8-flash-medium','agy-wrong-agent-key',baseCommit); const response=events.at(-1).response;
  assert.equal(events.at(-1).type,'response.failed',JSON.stringify(events));
  assert.equal(response.error.message,'AGY Worker selected the wrong agent or executed an out-of-profile tool');
  assert.equal(response.metadata.agy_worker_tool_policy.selected_agent,'default');
  assert.equal(response.metadata.agy_worker_tool_policy.selected_agent_matches,false);
  assert.deepEqual(response.metadata.agy_worker_tool_policy.unsafe_tool_events,[]);
});

test('AGY Worker reports missing initialization separately from a mismatched agent', async t => {
  const body=`if(process.argv[2]==='models'){console.log('gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)');process.exit(0)}console.log(JSON.stringify({event:'result',result:{conversation_id:'agy-no-init',status:'SUCCESS',response:'Done.'}}));`;
  const {base,baseCommit}=await setup(t,{agyEnabled:true,agyBody:body});
  const events=await submit(base,'antigravity-cli','gemini-3.8-flash-medium','agy-no-init-key',baseCommit); const response=events.at(-1).response;
  assert.equal(events.at(-1).type,'response.failed',JSON.stringify(events));
  assert.equal(response.error.message,'AGY Worker did not emit an initialization event identifying the selected agent');
  assert.equal(response.metadata.agy_diagnostic.observed_agent,'unreported');
  assert.deepEqual(response.metadata.agy_worker_tool_policy.unsafe_tool_events,[]);
});

test('AGY accepts a stream without an observed model and records its exact selected invocation', async t => {
  const body=`import {writeFileSync} from 'node:fs';if(process.argv[2]==='models'){console.log('gemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)');process.exit(0)}writeFileSync('README.md','AGY fixture edit\\n');const conversation_id='agy-no-model-conversation';console.log(JSON.stringify({event:'init',conversation_id,agent:'foreman-worker',init:{cwd:process.cwd(),tools:['view_file','list_dir','replace_file_content','multi_replace_file_content','write_to_file','finish']}}));console.log(JSON.stringify({event:'result',result:{conversation_id,status:'SUCCESS',response:'Edited README.',usage:{input_tokens:8,output_tokens:3,total_tokens:11}}}));`;
  const {base,baseCommit,env}=await setup(t,{agyEnabled:true,agyBody:body});
  const events=await submit(base,'antigravity-cli','gemini-3.8-flash-medium','agy-no-model-key',baseCommit); const response=events.at(-1).response;
  assert.equal(events.at(-1).type,'response.completed',JSON.stringify(events));
  assert.equal(response.metadata.actual_model_status,'unavailable'); assert.equal(response.model,undefined);
  assert.equal(response.session_id,'agy-no-model-conversation');
  assert.deepEqual(response.metadata.cli_invocation.args.slice(-5),['--mode=accept-edits','--add-dir','/workspace','--agent','foreman-worker']);
  assert.equal(response.metadata.cli_invocation.args.includes('--mode=accept-edits'),true);
  assert.equal(response.metadata.cli_invocation.args.includes('--model'),true);
  assert.equal(response.metadata.cli_invocation.args[response.metadata.cli_invocation.args.indexOf('--model')+1],'gemini-3.8-flash-medium');
  const snapshot=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces/${response.metadata.workspace_id}/snapshot`)).json();
  assert.equal(snapshot.complete,true,JSON.stringify(snapshot.errors));
  const evidence=await verifyBridgeWorkspace({repoPath:env.LOCAL_CLI_UHP_SOURCE_REPO,baseCommit,snapshot,allowedScope:['README.md']});
  assert.equal(evidence.changes[0].path,'README.md');
});

test('AGY Planner continuation reuses its bound conversation and reports cumulative usage deltas', async t => {
  const body=`if(process.argv[2]==='models'){console.log('gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)');process.exit(0)}const ix=process.argv.indexOf('--conversation');const resumed=ix>=0;const conversation_id=resumed?process.argv[ix+1]:'agy-role-conversation';console.log(JSON.stringify({event:'init',conversation_id,init:{cwd:process.cwd(),model:'gemini-3.8-flash-medium',tools:[]}}));console.log(JSON.stringify({event:'result',result:{conversation_id,status:'SUCCESS',response:resumed?'Planner follow-up':'Planner answer',model:'gemini-3.8-flash-medium',usage:resumed?{input_tokens:13,output_tokens:5,thinking_tokens:3,cache_read_tokens:4,total_tokens:18}:{input_tokens:8,output_tokens:3,thinking_tokens:2,cache_read_tokens:2,total_tokens:11}}}));`;
  const {base}=await setup(t,{agyEnabled:true,agyBody:body});
  const turn=async (key,previous_response_id)=> {
    const response=await fetch(`${base}/v1/responses`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream','UHP-Version':'2026-09-12','Idempotency-Key':key},body:JSON.stringify({input:'Planner turn',model:'gemini-3.8-flash-medium',previous_response_id,metadata:{harness_id:'antigravity-cli',foreman_run_id:'run-agy-session',foreman_role_id:'planner',foreman_project_id:'project-agy-session'},stream:true,timeout_seconds:5,max_step:1})});
    const text=await response.text(); assert.equal(response.status,200,text); return text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).at(-1).response;
  };
  const first=await turn('agy-planner-first');
  assert.equal(first.status,'completed'); assert.equal(first.usage.input_tokens,8); assert.equal(first.usage.output_tokens,3);
  const crossRole=await fetch(`${base}/v1/responses`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'agy-cross-role'},body:JSON.stringify({input:'Orchestrator turn',model:'gemini-3.8-flash-medium',previous_response_id:first.id,metadata:{harness_id:'antigravity-cli',foreman_run_id:'run-agy-session',foreman_role_id:'orchestrator',foreman_project_id:'project-agy-session'},stream:true,timeout_seconds:5,max_step:1})});
  assert.equal(crossRole.status,409); assert.equal((await crossRole.json()).error.code,'previous_response_invalid');
  const second=await turn('agy-planner-second',first.id);
  assert.equal(second.status,'completed'); assert.equal(second.session_id,'agy-role-conversation');
  assert.deepEqual(second.usage,{input_tokens:5,output_tokens:2,total_tokens:7,thinking_tokens:1,input_tokens_details:{cached_tokens:2}});
  assert.equal(second.metadata.cli_invocation.args.includes('--conversation'),true);
  assert.equal(second.metadata.cli_invocation.args[second.metadata.cli_invocation.args.indexOf('--conversation')+1],'agy-role-conversation');
  assert.equal(second.metadata.role_session.state_path,first.metadata.role_session.state_path);
});

test('client-supplied bridge session paths cannot create a workspace-free Worker context', async t => {
  const {base}=await setup(t);
  const response=await fetch(`${base}/v1/responses`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'forged-role-session'},body:JSON.stringify({input:'Do not run',model:'claude-requested',metadata:{harness_id:'claude-code',foreman_run_id:'run-forged',foreman_role_id:'worker',foreman_project_id:'project-forged',role_session_binding:{run_id:'run-forged',role_id:'planner'},role_session_state_path:'/tmp/attacker',conversation_id:'attacker-session'},stream:true,timeout_seconds:5,max_step:1})});
  assert.equal(response.status,409); assert.equal((await response.json()).error.code,'workspace_required');
});

test('Codex Worker edits only its seeded workspace and cannot read or write an outside sentinel', async t => {
  const fixture=await createWorkspaceFixture(); t.after(fixture.cleanup);
  const outside=await mkdtemp(join(tmpdir(),'foreman-codex-outside-')); t.after(()=>rm(outside,{recursive:true,force:true}));
  const sentinel=join(outside,'outside-sentinel'); await writeFile(sentinel,'outside-value');
  const body=`import {readFileSync,writeFileSync,openSync,closeSync} from 'node:fs'; import {spawnSync} from 'node:child_process'; const p=${JSON.stringify(sentinel)}; let outsideRead='allowed',outsideWrite='allowed',authWrite='allowed',caReadable=false,caWrite='allowed'; try{readFileSync(p,'utf8')}catch{outsideRead='denied'} try{writeFileSync(p,'changed')}catch{outsideWrite='denied'} try{writeFileSync(process.env.CODEX_HOME+'/auth.json','changed')}catch{authWrite='denied'} const login=readFileSync(process.env.CODEX_HOME+'/auth.json','utf8'); try{caReadable=readFileSync(process.env.SSL_CERT_FILE).includes(Buffer.from('-----BEGIN CERTIFICATE-----'));const fd=openSync(process.env.SSL_CERT_FILE,'r+');closeSync(fd)}catch{caWrite='denied'} const shellCommand='if test -r '+JSON.stringify(p)+'; then exit 41; fi; if printf changed >> '+JSON.stringify(p)+' 2>/dev/null; then exit 42; fi; printf %s Codex_worker_changed_this_assigned_file. > README.md'; const shell=spawnSync('/bin/sh',['-c',shellCommand]); writeFileSync('codex-boundary.json',JSON.stringify({outsideRead,outsideWrite,authWrite,login,codexHome:process.env.CODEX_HOME,caReadable,caWrite,shellExit:shell.status})); process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'codex-boundary-thread'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'updated README.md'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:4}}));});`;
  const {base,baseCommit,env}=await setup(t,{sourceRepo:fixture.repo,baseCommit:fixture.baseCommit,codexBody:body});
  await writeFile(join(env.CODEX_HOME,'auth.json'),'host-login-visible-read-only');
  const workspace=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base_commit:baseCommit})})).json();
  const events=await submit(base,'codex-cli','codex-requested','codex-boundary-key',baseCommit,workspace.workspace_id); const response=events.at(-1).response;
  assert.equal(events.at(-1).type,'response.completed',JSON.stringify(events));
  assert.equal(response.metadata.actual_model_status,'unavailable');
  assert.equal(response.metadata.execution_boundary.proven,true);
  assert.equal(response.metadata.execution_boundary.ca_bundle_mounted_read_only,true);
  const work=join(env.LOCAL_CLI_UHP_WORK,response.metadata.workspace_id);
  const boundary=JSON.parse(await readFile(join(work,'codex-boundary.json'),'utf8')); assert.deepEqual({outsideRead:boundary.outsideRead,outsideWrite:boundary.outsideWrite,authWrite:boundary.authWrite,login:boundary.login,codexHome:boundary.codexHome,caReadable:boundary.caReadable,caWrite:boundary.caWrite},{outsideRead:'denied',outsideWrite:'denied',authWrite:'denied',login:'host-login-visible-read-only',codexHome:'/codex-home',caReadable:true,caWrite:'denied'}); assert.equal(boundary.shellExit,0,JSON.stringify(boundary));
  assert.equal(await readFile(join(work,'README.md'),'utf8'),'Codex_worker_changed_this_assigned_file.');
  assert.equal(await readFile(sentinel,'utf8'),'outside-value');
  assert.equal(await readFile(join(env.CODEX_HOME,'auth.json'),'utf8'),'host-login-visible-read-only');
  const snapshot=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces/${response.metadata.workspace_id}/snapshot`)).json();
  const evidence=await verifyBridgeWorkspace({repoPath:fixture.repo,baseCommit:fixture.baseCommit,snapshot,allowedScope:['README.md','codex-boundary.json']});
  assert.equal(evidence.validation,'verified_by_foreman_git_comparison'); assert.equal(evidence.scopeVerified,true);
});
test('Codex Worker startup failure records exit status and stage without blaming actual-model reporting', async t => {
  const {base,baseCommit}=await setup(t,{codexBody:"console.error('authentication token=fixture-secret-value'); process.exit(17);"});
  const events=await submit(base,'codex-cli','codex-requested','codex-empty-failure-key',baseCommit); const response=events.at(-1).response;
  assert.equal(events.at(-1).type,'response.failed',JSON.stringify(events));
  assert.equal(response.model,undefined); assert.equal(response.session_id,undefined); assert.equal(response.usage,undefined);
  assert.equal(response.metadata.actual_model_status,'unavailable');
  assert.deepEqual(response.metadata.cli_exit,{exit_code:17,signal:null});
  assert.equal(response.metadata.execution_stage,'cli_execution');
  assert.equal(response.metadata.cli_failure_category,'authentication');
  assert.doesNotMatch(JSON.stringify(response),/fixture-secret-value/);
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
test('CLI stderr is omitted from the terminal response', async t => {
  const {base,baseCommit}=await setup(t,{claudeBody:`console.error('private fixture diagnostic');process.exit(3);`}); const events=await submit(base,'claude-code','claude-requested','stderr-redaction-key',baseCommit);
  assert.equal(terminalEvent(events).type,'response.failed');
  assert.match(terminalEvent(events).response.error.message,/actual model and session id/);
  assert.equal(JSON.stringify(events).includes('private fixture diagnostic'),false);
});
test('Claude is_error and error subtype do not produce a successful UHP response', async t => {
  const {base,baseCommit}=await setup(t,{claudeIsError:true}); const events=await submit(base,'claude-code','claude-requested','claude-error-key',baseCommit);
  assert.equal(terminalEvent(events).type,'response.failed'); assert.equal(terminalEvent(events).response.error.message,'Claude Code reported an unsuccessful task');
});
test('a harness without an explicit model is omitted from discovery', async t => {
  const {base}=await setup(t,{noClaudeModel:true}); const body=await (await fetch(`${base}/v1/harnesses`)).json();
  assert.deepEqual(body.harnesses.map(x=>x.id),['codex-cli']);
  assert.equal((await fetch(`${base}/v1/harnesses/claude-code/models`)).status,404);
});
test('literal undefined from Claude is not accepted as an actual model', async t => {
  const {base,baseCommit}=await setup(t,{claudeUndefined:true}); const events=await submit(base,'claude-code','claude-requested','undefined-model-key',baseCommit);
  assert.equal(terminalEvent(events).type,'response.failed'); assert.equal(terminalEvent(events).response.model,undefined);
  assert.match(terminalEvent(events).response.error.message,/did not report an actual model/);
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
  const malformedScope=await submitReview(base,'claude-code','review-malformed-scope',{review_evidence:reviewEvidence({allowedScope:['docs/../nodes/']})}); assert.equal(malformedScope.status,400); assert.equal(malformedScope.body.error.code,'review_evidence_invalid');
  const oversized=await submitReview(base,'claude-code','review-too-large',{review_evidence:reviewEvidence({reviewDiff:'x'.repeat(48_001)})}); assert.equal(oversized.status,400);
  const bound=await submitReview(base,'claude-code','review-workspace',{workspace_id:'ws_00000000-0000-0000-0000-000000000000'}); assert.equal(bound.status,400); assert.equal(bound.body.error.code,'review_workspace_forbidden');
});

test('read-only Reviewer accepts Foreman directory scopes with trailing slashes and rejects incomplete validation evidence', async t => {
  const {base}=await setup(t);
  const valid=reviewEvidence({
    allowedScope:['docs/','nodes/'],
    reviewDiff:'### add: docs/nba-coverage.md\n+ mode 100644, 16017 bytes\n\n```diff\n--- /dev/null\n+++ b/docs/nba-coverage.md\n+## Sleeper API Coverage\n```',
    controllerValidation:{
      passed:true,
      policy:{requireAllChecksPass:true,configuredCheckCount:2},
      observations:[
        {name:'Install dependencies',command:'pnpm',args:['install','--frozen-lockfile'],exitCode:0,signal:null,timedOut:false,output:'Lockfile is up to date',outputTruncated:false,passed:true},
        {name:'Tests',command:'pnpm',args:['test'],exitCode:0,signal:null,timedOut:false,output:'114 tests passed',outputTruncated:false,passed:true},
      ],
    },
  });
  const accepted=await submitReview(base,'claude-code','review-foreman-directory-scope',{review_evidence:valid});
  assert.equal(accepted.status,200,JSON.stringify(accepted.body));
  assert.equal(accepted.events[0]?.type,'response.created',JSON.stringify(accepted.events));
  assert.notEqual(accepted.events.at(-1)?.response?.error?.message,'review_evidence_invalid',JSON.stringify(accepted.events));

  const incomplete=reviewEvidence({
    allowedScope:['docs/','nodes/'],
    controllerValidation:{passed:true,policy:{requireAllChecksPass:true,configuredCheckCount:2},observations:[
      {name:'Install dependencies',command:'pnpm',args:['install','--frozen-lockfile'],exitCode:0,timedOut:false,output:'passed',outputTruncated:false,passed:true},
    ]},
  });
  const rejected=await submitReview(base,'claude-code','review-incomplete-validation',{review_evidence:incomplete});
  assert.equal(rejected.status,400);
  assert.equal(rejected.body.error.code,'review_evidence_invalid');
});

test('Codex Reviewer can report an unavailable model only with bound invocation and read-only evidence', async t => {
  const codexBody=`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'codex-review-no-model'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'review recommendation'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}));});`;
  const {base}=await setup(t,{codexBody}); const result=await submitReview(base,'codex-cli','codex-review-missing-model');
  const response=result.events.at(-1).response;
  assert.equal(result.events.at(-1).type,'response.completed',JSON.stringify(result.events)); assert.equal(response.model,undefined);
  assert.equal(response.metadata.actual_model_status,'unavailable');
  assert.equal(response.metadata.cli_invocation.executable,'/opt/codex');
  assert.equal(response.metadata.cli_invocation.args[response.metadata.cli_invocation.args.indexOf('--model')+1],'codex-requested');
  assert.equal(response.metadata.reviewer_boundary.codex_sandbox,'read-only');
  assert.equal(response.metadata.reviewer_boundary.proven,true);
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
  assert.equal(discovery.capabilities.sessions,true);
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
  const claudeBody=`let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{const model='claude-actual';const result=prompt.includes('Return exactly one JSON object and no prose: {"workerTask":"..."}')?JSON.stringify({workerTask:'Change README.md with one short sentence.'}):'Planner recommends a concise README note.';console.log(JSON.stringify({type:'system',subtype:'init',model,session_id:'judgment-session'}));console.log(JSON.stringify({type:'result',subtype:'success',result,model,session_id:'judgment-session',usage:{input_tokens:5,output_tokens:2}}));});`;
  const {base,env}=await setup(t,{sourceRepo:fixture.repo,baseCommit:fixture.baseCommit,codexBody,claudeBody});
  const uhp = new UhpClient({baseUrl:base,timeoutMs:20_000});
  const controller = new Controller(new JsonStore(join(parent,'foreman-state.json')),uhp,false,true);
  controller.configureVerifiedWorkspace({repoPath:fixture.repo,allowedScope:['README.md','.boundary-result.json'],commands:[{name:'assert verified README content',command:process.execPath,args:['-e',`const fs=require('node:fs');if(fs.readFileSync('README.md','utf8')!=='# Fixture\\n\\nCodex changed the assigned README.\\n')process.exit(1)`]}],bridgeBaseUrl:base,timeoutMs:10_000,maxOutputBytes:2_000});
  await controller.refreshDiscovery();
  const project=await controller.createProject('Codex disposable workspace fixture');
  const task=await controller.createTask(project.id,'Edit the assigned README');
  const run=await controller.createRun(task.id);
  await controller.selectRoleConfig('planner',{harnessId:'claude-code',model:'claude-requested',options:{timeoutSeconds:5,maxStep:1}},undefined,run.id);
  await controller.selectRoleConfig('orchestrator',{harnessId:'claude-code',model:'claude-requested',options:{timeoutSeconds:5,maxStep:1}},undefined,run.id);
  await controller.selectRoleConfig('worker',{harnessId:'codex-cli',model:'codex-requested',options:{timeoutSeconds:5,maxStep:1}},undefined,run.id);
  await controller.prepareWorkerWorkspace(run.id,fixture.baseCommit);
  const guidance=await controller.addGuidance(run.id,'Keep the README change to one short note.');
  assert.equal(guidance.status,'queued',JSON.stringify(guidance)); assert.equal(guidance.plannerReply,'Planner recommends a concise README note.',JSON.stringify((await controller.state()).events.slice(-8)));
  const orchestration=await controller.orchestrate(run.id,'Implement the requested README note.');
  assert.equal(orchestration.assignment.status,'succeeded',JSON.stringify(orchestration.assignment));
  assert.equal((await controller.state()).projects[0].tasks[0].runs[0].guidance[0].status,'delivered');
  assert.equal(orchestration.proposal?.text,'Change README.md with one short sentence.');
  assert.ok(orchestration.proposal);
  const assignment=await controller.dispatchWorkerProposal(run.id,orchestration.proposal.id);
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

test('usage reports Codex five-hour and weekly windows independently and fails closed for unmeasured providers', async t => {
  const codexBody=`if(process.argv[2]==='app-server'){process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',chunk=>{input+=chunk;const lines=input.split('\\n');input=lines.pop()||'';for(const line of lines){let request;try{request=JSON.parse(line)}catch{continue}if(request.id===1)process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');if(request.id===2)process.stdout.write(JSON.stringify({id:2,result:{rateLimitsByLimitId:{fixture:{primary:{windowDurationMins:300,usedPercent:37,resetsAt:1900000000},secondary:{windowDurationMins:10080,usedPercent:82,resetsAt:1900600000}}}}})+'\\n')}});}`;
  const {base}=await setup(t,{codexBody});
  const response=await fetch(`${base}/v1/usage`);
  assert.equal(response.status,200);
  const usage=await response.json();
  assert.deepEqual(usage.harnesses.find(item=>item.harnessId==='codex-cli'),{
    harnessId:'codex-cli',status:'ready',windows:{
      fiveHour:{status:'available',usedPercent:37,remainingPercent:63,resetsAt:new Date(1900000000*1000).toISOString()},
      weekly:{status:'available',usedPercent:82,remainingPercent:18,resetsAt:new Date(1900600000*1000).toISOString()},
    },
  });
  for (const harnessId of ['claude-code','antigravity-cli']) {
    const harness=usage.harnesses.find(item=>item.harnessId===harnessId);
    assert.equal(harness.windows.fiveHour.status,'unavailable');
    assert.equal(harness.windows.weekly.status,'unavailable');
  }
});

test('usage reads AGY quota pools with its native usage command and keeps explicit windows separate', async t => {
  const captured=join(tmpdir(),`agy-usage-args-${process.pid}-${Math.random().toString(16).slice(2)}.jsonl`);
  t.after(()=>rm(captured,{force:true}));
  const payload={command:{data:{groups:[
    {name:'Gemini models',description:'ignored account details',buckets:[
      {window:'5h',remaining_fraction:0.72,reset_time:'2030-03-17T08:00:00.000Z'},
      {window:'1h',remaining_fraction:0.01,reset_time:'2030-03-17T07:00:00.000Z'},
      {window:'weekly',remaining_fraction:0.41,reset_time:'2030-03-21T00:00:00.000Z'},
    ]},
    {name:'Claude models',description:'ignored account details',buckets:[
      {window:'5h',remaining_fraction:0.9,reset_time:'2030-03-17T09:00:00.000Z'},
      {window:'weekly',remaining_fraction:0.6,reset_time:'2030-03-22T00:00:00.000Z'},
    ]},
    {name:'Claude and Gemini models',description:'ignored account details',buckets:[
      {window:'5h',remaining_fraction:0.1,reset_time:'2030-03-17T10:00:00.000Z'},
    ]},
  ]}}};
  const body=`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(captured)},JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv[2]==='models'){console.log('gemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)');process.exit(0)}if(process.argv.slice(2).join(' ')!=='-p /usage --output-format json --print-timeout 10s')process.exit(41);console.log(${JSON.stringify(JSON.stringify(payload))});`;
  const {base}=await setup(t,{agyEnabled:true,agyBody:body});
  const response=await fetch(`${base}/v1/usage`);
  assert.equal(response.status,200);
  const usage=await response.json();
  const agy=usage.harnesses.find(item=>item.harnessId==='antigravity-cli');
  assert.equal(agy.status,'ready');
  assert.deepEqual(agy.windows,{
    fiveHour:{status:'available',usedPercent:28,remainingPercent:72,resetsAt:'2030-03-17T08:00:00.000Z'},
    weekly:{status:'available',usedPercent:59,remainingPercent:41,resetsAt:'2030-03-21T00:00:00.000Z'},
  });
  assert.equal(agy.groups.length,1);
  const gemini=agy.groups.find(group=>group.id==='gemini');
  assert.ok(gemini);
  assert.equal(agy.groups.some(group=>group.id==='claude'),false);
  assert.equal(gemini.windows.fiveHour.status,'available');
  assert.ok(Math.abs(gemini.windows.fiveHour.usedPercent-28)<1e-8);
  assert.equal(gemini.windows.fiveHour.remainingPercent,72);
  assert.equal(gemini.windows.fiveHour.resetsAt,'2030-03-17T08:00:00.000Z');
  assert.ok(Math.abs(gemini.windows.weekly.usedPercent-59)<1e-8);
  assert.equal(gemini.windows.weekly.remainingPercent,41);
  const invocations=(await readFile(captured,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(invocations.some(args=>args.join(' ')==='-p /usage --output-format json --print-timeout 10s'));
  assert.equal(JSON.stringify(usage).includes('ignored account details'),false);
});

test('AGY quota status fails closed for malformed output and unsuccessful CLI exit', async t => {
  for (const [name, output, exitCode] of [
    ['malformed','not json',0],
    ['cli-error',JSON.stringify({command:{data:{groups:[{name:'Gemini',buckets:[{window:'5h',remaining_fraction:0.5,reset_time:'2030-03-17T08:00:00Z'}]}]}}}),9],
  ]) {
    const body=`if(process.argv[2]==='models'){console.log('gemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)');process.exit(0)}console.log(${JSON.stringify(output)});process.exit(${exitCode});`;
    const {base}=await setup(t,{agyEnabled:true,agyBody:body});
    const response=await fetch(`${base}/v1/usage`);
    assert.equal(response.status,200,name);
    const usage=await response.json();
    const agy=usage.harnesses.find(item=>item.harnessId==='antigravity-cli');
    assert.equal(agy.status,'ready',name);
    assert.equal(agy.windows.fiveHour.status,'unavailable',name);
    assert.equal(agy.windows.weekly.status,'unavailable',name);
    assert.deepEqual(agy.groups,[],name);
    assert.equal(JSON.stringify(usage).includes(output),false,name);
  }
});

async function runClaudeStatusLineCollector(cachePath, input) {
  const child = spawn(process.execPath, [join(here, 'claude-statusline-collector.mjs')], {
    env: { ...process.env, FOREMAN_CLAUDE_USAGE_CACHE: cachePath },
    stdio: ['pipe','pipe','pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(input);
  const exitCode = await new Promise(resolve => child.once('close', resolve));
  return { exitCode, stdout, stderr };
}

test('Claude statusLine collector atomically stores only projected quota fields', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-statusline-fixture-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const cachePath = join(dir,'usage.json');
  const result = await runClaudeStatusLineCollector(cachePath, JSON.stringify({
    rate_limits:{five_hour:{used_percentage:23.5,resets_at:1900000000},seven_day:{used_percentage:41.2,resets_at:1900600000}},
    session_id:'private-session-fixture',account:{email:'private-user@example.invalid'},model:{id:'private-model'},cwd:'/private/project',
  }));
  assert.equal(result.exitCode,0);
  assert.equal(result.stderr,'');
  assert.equal(result.stdout,'5h 23.5% used · 7d 41.2% used');
  const cache = JSON.parse(await readFile(cachePath,'utf8'));
  assert.deepEqual(Object.keys(cache).sort(),['capturedAt','rate_limits','version']);
  assert.deepEqual(cache.rate_limits,{five_hour:{used_percentage:23.5,resets_at:1900000000},seven_day:{used_percentage:41.2,resets_at:1900600000}});
  assert.ok(Date.now()-cache.capturedAt<5_000);
  assert.equal((await stat(cachePath)).mode & 0o777,0o600);
  assert.deepEqual(await readdir(dir),['usage.json']);
  const serialized=JSON.stringify(cache);
  for(const privateValue of ['private-session-fixture','private-user@example.invalid','private-model','/private/project']) assert.equal(serialized.includes(privateValue),false,privateValue);
});

test('Claude statusLine collector ignores missing, malformed, invalid, and oversized quota input', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-statusline-invalid-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const [name,input] of [
    ['missing',JSON.stringify({session_id:'private-missing-session'})],
    ['malformed','not json'],
    ['invalid',JSON.stringify({rate_limits:{five_hour:{used_percentage:101},seven_day:{used_percentage:'42'}}})],
    ['oversized',JSON.stringify({rate_limits:{five_hour:{used_percentage:23}},filler:'x'.repeat(270_000)})],
  ]) {
    const path=join(dir,`${name}.json`);
    const result=await runClaudeStatusLineCollector(path,input);
    assert.equal(result.exitCode,0,name);
    assert.equal(result.stdout,'',name);
    assert.equal(result.stderr,'',name);
    await assert.rejects(readFile(path),undefined,name);
  }
});

test('Claude usage asks the signed-in CLI for quota without a prompt or API key', async t => {
  const marker=join(tmpdir(),`claude-control-usage-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  t.after(()=>rm(marker,{force:true}));
  const claudeBody=`import {writeFileSync} from 'node:fs';let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const request=JSON.parse(input.trim());writeFileSync(${JSON.stringify(marker)},JSON.stringify({request,apiKey:process.env.ANTHROPIC_API_KEY??null}));console.log(JSON.stringify({type:'control_response',response:{request_id:request.request_id,subtype:'success',response:{rate_limits_available:true,rate_limits:{limits:[{kind:'session',percent:23.5,resets_at:'2030-01-01T12:00:00Z'},{kind:'weekly_all',percent:41.2,resets_at:'2030-01-07T12:00:00Z'}]},session:{total_cost_usd:0,model_usage:{}}}}}));});`;
  const {base}=await setup(t,{claudeBody});
  const usage=await (await fetch(`${base}/v1/usage`)).json();
  const claude=usage.harnesses.find(item=>item.harnessId==='claude-code');
  assert.equal(claude.windows.fiveHour.usedPercent,23.5);
  assert.equal(claude.windows.weekly.usedPercent,41.2);
  const sent=JSON.parse(await readFile(marker,'utf8'));
  assert.deepEqual(sent.request,{type:'control_request',request_id:'foreman-usage',request:{subtype:'get_usage'}});
  assert.equal(sent.apiKey,null);
});

test('Claude usage reads only fresh cache snapshots and expires past reset windows', async t => {
  const now=Date.now();
  const futureReset=Math.floor(now/1000)+3600;
  const noModelCallMarker=join(tmpdir(),`claude-usage-no-model-call-${process.pid}-${Math.random().toString(16).slice(2)}`);
  t.after(()=>rm(noModelCallMarker,{force:true}));
  const claudeBody=`import {writeFileSync} from 'node:fs';let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{if(!input.includes('"subtype":"get_usage"'))writeFileSync(${JSON.stringify(noModelCallMarker)},'model-called')});`;
  const cases=[
    ['valid',{version:1,capturedAt:now,rate_limits:{five_hour:{used_percentage:23.5,resets_at:futureReset},seven_day:{used_percentage:41.2,resets_at:futureReset+3600}}},{fiveHour:{status:'available',usedPercent:23.5,remainingPercent:76.5,resetsAt:new Date(futureReset*1000).toISOString()},weekly:{status:'available',usedPercent:41.2,remainingPercent:58.8,resetsAt:new Date((futureReset+3600)*1000).toISOString()}}],
    ['stale',{version:1,capturedAt:now-16*60_000,rate_limits:{five_hour:{used_percentage:23.5,resets_at:futureReset},seven_day:{used_percentage:41.2,resets_at:futureReset+3600}}},{fiveHour:{status:'unavailable'},weekly:{status:'unavailable'}}],
    ['expired-reset',{version:1,capturedAt:now,rate_limits:{five_hour:{used_percentage:23.5,resets_at:Math.floor(now/1000)-1},seven_day:{used_percentage:41.2,resets_at:futureReset+3600}}},{fiveHour:{status:'unavailable'},weekly:{status:'available',usedPercent:41.2,remainingPercent:58.8,resetsAt:new Date((futureReset+3600)*1000).toISOString()}}],
    ['malformed','not-cache-data',{fiveHour:{status:'unavailable'},weekly:{status:'unavailable'}}],
    ['missing',undefined,{fiveHour:{status:'unavailable'},weekly:{status:'unavailable'}}],
  ];
  for(const [name,snapshot,expected] of cases) {
    const {base,env}=await setup(t,{claudeBody});
    if(snapshot!==undefined) await writeFile(env.FOREMAN_CLAUDE_USAGE_CACHE,typeof snapshot==='string'?snapshot:JSON.stringify(snapshot),{mode:0o600});
    const response=await fetch(`${base}/v1/usage`);
    assert.equal(response.status,200,name);
    const usage=await response.json();
    const claude=usage.harnesses.find(item=>item.harnessId==='claude-code');
    assert.equal(claude.status,'ready',name);
    const expectedObserved=structuredClone(expected);
    if(name==='valid') { expectedObserved.fiveHour.observedAt=new Date(now).toISOString(); expectedObserved.weekly.observedAt=new Date(now).toISOString(); }
    if(name==='expired-reset') expectedObserved.weekly.observedAt=new Date(now).toISOString();
    assert.deepEqual(claude.windows,expectedObserved,name);
    assert.equal(JSON.stringify(usage).includes('raw'),false,name);
    await assert.rejects(readFile(noModelCallMarker),undefined,name);
  }
});

test('Claude in-memory usage cache expires at reset time instead of serving stale quota', async t => {
  const {base,env}=await setup(t,{codexBody:`if(process.argv[2]==='app-server'){process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',chunk=>{input+=chunk;const lines=input.split('\\n');input=lines.pop()||'';for(const line of lines){let request;try{request=JSON.parse(line)}catch{continue}if(request.id===1)process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');if(request.id===2)process.stdout.write(JSON.stringify({id:2,result:{}})+'\\n')}})}else process.stdin.resume();`});
  const reset = Math.floor(Date.now()/1000)+5;
  await writeFile(env.FOREMAN_CLAUDE_USAGE_CACHE,JSON.stringify({version:1,capturedAt:Date.now(),rate_limits:{five_hour:{used_percentage:10,resets_at:reset},seven_day:null}}),{mode:0o600});
  const first=await (await fetch(`${base}/v1/usage`)).json();
  assert.equal(first.harnesses.find(item=>item.harnessId==='claude-code').windows.fiveHour.status,'available');
  const delay=Math.max(0,reset*1000-Date.now()+100);
  await new Promise(resolve=>setTimeout(resolve,delay));
  const second=await (await fetch(`${base}/v1/usage`)).json();
  assert.equal(second.harnesses.find(item=>item.harnessId==='claude-code').windows.fiveHour.status,'unavailable');
});

test('activity SSE emits contiguous ordered events and bounds sanitized summaries', async t => {
  const lines=Array.from({length:70},(_,index)=>JSON.stringify({type:'assistant',message:{content:[{type:'text',text:`progress ${index}\u0000`+'x'.repeat(240)}]}}));
  const toolLine=JSON.stringify({type:'stream_event',event:{type:'content_block_start',content_block:{type:'tool_use',name:'Read File'}}});
  const body=`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-requested',session_id:'activity-session'}));console.log(${JSON.stringify(toolLine)});setTimeout(()=>{for(const line of ${JSON.stringify(lines)})console.log(line);console.log(JSON.stringify({type:'result',subtype:'success',result:'done',model:'claude-requested',session_id:'activity-session',usage:{input_tokens:1,output_tokens:1}}));},150);});`;
  const {base,baseCommit}=await setup(t,{claudeBody:body});
  const seeded=await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base_commit:baseCommit})})).json();
  const response=await fetch(`${base}/v1/responses`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream','UHP-Version':'2026-09-12','Idempotency-Key':'activity-bounds'},body:JSON.stringify({input:'Say bounded answer',model:'claude-requested',metadata:{harness_id:'claude-code',workspace_id:seeded.workspace_id},stream:true,timeout_seconds:5,max_step:1})});
  assert.equal(response.status,200);
  const reader=response.body.getReader(); const decoder=new TextDecoder(); let buffer=''; const events=[]; let toolAt; let terminalAt;
  while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const frames=buffer.split('\n\n');buffer=frames.pop()??'';for(const frame of frames){const line=frame.split('\n').find(item=>item.startsWith('data: '));if(!line)continue;const item=JSON.parse(line.slice(6));events.push(item);if(item.type==='response.activity'&&item.response.activity.summary==='Using the ReadFile tool')toolAt=Date.now();if(item.type==='response.completed')terminalAt=Date.now();}}
  assert.equal(events[0].type,'response.created');
  assert.equal(events[0].sequence_number,0);
  const activities=events.filter(item=>item.type==='response.activity');
  assert.ok(activities.length>1,JSON.stringify(events));
  assert.ok(activities.length<=64);
  assert.equal(activities[0].sequence_number,1);
  assert.ok(activities.some(item=>item.response.activity.summary==='Using the ReadFile tool'));
  assert.ok(toolAt!==undefined&&terminalAt!==undefined&&toolAt<terminalAt);
  assert.equal(events.at(-1).type,'response.completed');
  assert.equal(events.at(-1).sequence_number,activities.length+1);
  const summaries=activities.map(item=>item.response.activity.summary);
  assert.ok(summaries.every(summary=>summary.length<=200&&!/[\u0000-\u001f\u007f-\u009f]/.test(summary)));
  assert.equal(activities.every(item=>item.response.status==='in_progress'),true);
});
