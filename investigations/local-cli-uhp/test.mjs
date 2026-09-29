import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rm, truncate, mkdir, readdir, stat, lstat, symlink, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';

await import('tsx/esm/api').then(({ register }) => register());
const { UhpClient } = await import('../../src/uhp.ts');
const { Controller } = await import('../../src/controller.ts');
const { JsonStore } = await import('../../src/store.ts');
const { snapshotGitCommit } = await import('../../src/git-workspace.ts');
const { seedBridgeWorkspace, fetchBridgeSnapshot, overlayBridgeWorkspace } = await import('../../src/verified-workspace.ts');
const { bearerFetch } = await import('../../src/local-bridge.ts');
const { verifyBridgeWorkspace, validateBridgeSnapshot } = await import('./workspace-verifier.mjs');
const { createWorkspaceFixture, applyAllFileCaseChanges } = await import('./workspace-fixture.mjs');
const { assertReviewerBounds, isPrepareOnly, REVIEWER_TASK_BOUNDS, REVIEWER_STREAM_INACTIVITY_TIMEOUT_MS, REVIEWER_BRIDGE_MAX_STEP } = await import('./reviewer-smoke-bounds.mjs');

const here = dirname(fileURLToPath(import.meta.url));
const BRIDGE_TOKEN = '0123456789abcdef'.repeat(4);
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
  const env = { ...process.env, ANTHROPIC_API_KEY:'fixture-only-do-not-forward', OPENAI_API_KEY:'fixture-only-do-not-forward', AWS_ACCESS_KEY_ID:'fixture-only-do-not-forward', GOOGLE_API_KEY:'fixture-only-do-not-forward', CLAUDE_CODE_USE_BEDROCK:'1', CLAUDE_CODE_USE_VERTEX:'1', CLAUDE_CODE_USE_FOUNDRY:'1', CODEX_API_KEY:'fixture-only-do-not-forward', ...(options.claudeNetworkRequirements ? {HTTP_PROXY:'http://fixture-proxy.invalid:8080'} : {}), ...(Number.isFinite(options.keepaliveMs) ? {LOCAL_CLI_UHP_KEEPALIVE_MS:String(options.keepaliveMs)} : {}), ...(options.agyWorkerEffort ? {AGY_WORKER_EFFORT:options.agyWorkerEffort} : {}), LOCAL_CLI_UHP_PORT: String(port), LOCAL_CLI_UHP_STATE: join(dir, 'state.json'), LOCAL_CLI_UHP_WORK: join(dir, 'work'), FOREMAN_CLAUDE_USAGE_CACHE: join(dir,'claude-usage-cache.json'), CLAUDE_CONFIG_DIR: join(dir, 'claude-auth'), CODEX_HOME: join(dir, 'codex-auth'), CLAUDE_MODEL: options.noClaudeModel ? '' : options.claudeModel ?? 'claude-requested', CODEX_MODEL: 'codex-requested', CLAUDE_BIN: options.claudeBin ?? (options.spawnError ? join(dir,'missing-cli') : claude), CODEX_BIN: codex, AGY_BIN:join(dir,'missing-agy'), ...(options.agyEnabled ? { AGY_CONFIG_DIR: join(dir,'agy-auth'), ...(options.noAgyModel ? {} : {AGY_MODEL:options.agyModel ?? 'gemini-3.8-flash-medium'}), AGY_BIN:agy } : {}), ...agyDiscoveryEnv, LOCAL_CLI_UHP_SOURCE_REPO: options.sourceRepo ?? fixture.repo, LOCAL_CLI_UHP_BWRAP: options.bwrapBin ?? 'bwrap' };
  if (options.noAgyModel) delete env.AGY_MODEL;
  if (options.extraEnv) Object.assign(env, options.extraEnv);
  if (!options.agyWorkerEffort) delete env.AGY_WORKER_EFFORT;
  if (options.agyEnabled) Object.assign(env,{AGY_CONFIG_DIR:join(dir,'agy-auth'),...(options.noAgyModel?{}:{AGY_MODEL:options.agyModel ?? 'gemini-3.8-flash-medium'}),AGY_BIN:agy});
  // Tests run without a bridge token unless one is requested, whatever the developer's shell exports.
  delete env.LOCAL_CLI_UHP_TOKEN;
  if (options.token) env.LOCAL_CLI_UHP_TOKEN = options.token;
  const authHeaders = options.token ? { authorization: `Bearer ${options.token}` } : {};
  let output = '';
  const startBridge = () => { const child = spawn(process.execPath, [join(here, 'server.mjs')], { env, cwd: dir, stdio: options.captureOutput ? ['ignore','pipe','pipe'] : 'ignore' }); if (options.captureOutput) for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; }); return child; };
  let proc = startBridge();
  t.after(async () => { if (proc.exitCode === null) { proc.kill('SIGTERM'); await new Promise(r => proc.once('exit', r)); } await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i=0;i<250&&proc.exitCode===null;i++) { try { const r=await fetch(`${base}/v1/uhp`, { headers: authHeaders }); if(r.ok) break; } catch {} await new Promise(r=>setTimeout(r,20)); }
  return { base, dir, env, port, token: options.token, authHeaders, output: () => output, baseCommit: options.baseCommit ?? fixture?.baseCommit, sourceRepo: options.sourceRepo ?? fixture?.repo, countFor: workspaceId=>join(env.LOCAL_CLI_UHP_WORK,workspaceId,'.fixture-cli-count'), restart: async () => { proc.kill('SIGTERM'); await new Promise(r => proc.once('exit', r)); proc = startBridge(); for(let i=0;i<250&&proc.exitCode===null;i++){try{if((await fetch(`${base}/v1/uhp`, { headers: authHeaders })).ok)break;}catch{} await new Promise(r=>setTimeout(r,20));} } };
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
test('Claude discovery offers Opus and Sonnet and dispatches the selected model', async t => {
  const {base,baseCommit,countFor}=await setup(t,{claudeModel:'opus'});
  const models=await (await fetch(`${base}/v1/harnesses/claude-code/models`)).json();
  assert.deepEqual(models.models.map(model=>model.id),['opus','sonnet']);
  const events=await submit(base,'claude-code','sonnet','claude-sonnet-selection',baseCommit);
  const response=terminalEvent(events).response;
  assert.equal(response.status,'completed');
  assert.equal(response.requested_model,'sonnet');
  assert.equal((await readFile(countFor(response.metadata.workspace_id),'utf8')).trim(),'c:provider-env-absent:model=sonnet');
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
test('snapshot-backed Orchestrator persists transcripts and resumes with its read-only repository across restart', async t => {
  const body = `import {readFileSync,writeFileSync} from 'node:fs';process.stdin.resume();process.stdin.on('end',()=>{const resumed=process.argv.includes('--resume');const transcript='/auth/projects/snapshot-session.txt';const repo=readFileSync('/workspace/edit.txt','utf8');if(repo!=='edit before\\n')process.exit(21);if(resumed&&readFileSync(transcript,'utf8')!=='first turn')process.exit(22);let readonly=false;try{writeFileSync('/workspace/.forbidden-write','changed')}catch{readonly=true}if(!readonly)process.exit(23);if(!resumed)writeFileSync(transcript,'first turn');console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-requested',session_id:'snapshot-native-session'}));console.log(JSON.stringify({type:'result',subtype:'success',result:resumed?'resumed with repository':'first snapshot turn',model:'claude-requested',session_id:'snapshot-native-session',usage:{input_tokens:2,output_tokens:1}}));});`;
  const {base,baseCommit,env,restart} = await setup(t,{claudeBody:body});
  const seeded = await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base_commit:baseCommit})})).json();
  const turn = async (key,previousResponseId,workspaceId) => {
    const response = await fetch(`${base}/v1/responses`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream','Idempotency-Key':key},body:JSON.stringify({input:'Plan the correction from the verified result inbox.',model:'claude-requested',previous_response_id:previousResponseId,metadata:{harness_id:'claude-code',foreman_run_id:'run-snapshot-session',foreman_role_id:'orchestrator',foreman_project_id:'project-snapshot-session',...(workspaceId?{foreman_read_only_workspace_id:workspaceId}:{})},stream:true,timeout_seconds:5,max_step:1})});
    const text = await response.text(); assert.equal(response.status,200,text);
    return terminalEvent(text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)))).response;
  };
  const first = await turn('snapshot-session-first',undefined,seeded.workspace_id);
  assert.equal(first.status,'completed',JSON.stringify(first));
  assert.equal(await readFile(join(first.metadata.role_session.state_path,'claude-projects','snapshot-session.txt'),'utf8'),'first turn');
  assert.equal(await stat(join(env.CLAUDE_CONFIG_DIR,'projects','snapshot-session.txt')).catch(()=>null),null);
  await restart();
  const second = await turn('snapshot-session-second',first.id);
  assert.equal(second.status,'completed',JSON.stringify(second));
  assert.equal(second.output_text,'resumed with repository');
  assert.equal(second.metadata.foreman_read_only_workspace_id,seeded.workspace_id);
  assert.equal(second.metadata.role_session.state_path,first.metadata.role_session.state_path);
  assert.equal(second.session_id,first.session_id);
});

test('a missing native resume is classified without treating the failed response as a valid predecessor', async t => {
  const body = `process.stdin.resume();process.stdin.on('end',()=>{if(process.argv.includes('--resume')){console.error('No conversation found with session ID: fixture-missing');process.exit(2)}console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-requested',session_id:'fixture-missing'}));console.log(JSON.stringify({type:'result',subtype:'success',result:'first turn',model:'claude-requested',session_id:'fixture-missing'}));});`;
  const {base} = await setup(t,{claudeBody:body});
  const turn = async (key,previousResponseId) => {
    const response = await fetch(`${base}/v1/responses`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream','Idempotency-Key':key},body:JSON.stringify({input:'Plan a correction.',model:'claude-requested',previous_response_id:previousResponseId,metadata:{harness_id:'claude-code',foreman_run_id:'run-missing-resume',foreman_role_id:'orchestrator',foreman_project_id:'project-missing-resume'},stream:true,timeout_seconds:5,max_step:1})});
    const text = await response.text();
    return {status:response.status,result:response.status===200?terminalEvent(text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)))).response:JSON.parse(text)};
  };
  const first = (await turn('missing-resume-first')).result;
  assert.equal(first.status,'completed');
  const failed = (await turn('missing-resume-second',first.id)).result;
  assert.equal(failed.status,'failed');
  assert.equal(failed.metadata.cli_failure_category,'session_resume_unavailable');
  assert.ok(!JSON.stringify(failed).includes('No conversation found with session ID'));
  const invalid = await turn('missing-resume-third',failed.id);
  assert.equal(invalid.status,409);
  assert.equal(invalid.result.error.code,'previous_response_invalid');
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
  assert.deepEqual(response.metadata.agy_diagnostic,{permission_mode:'request-review',observed_agent:'foreman-worker',cwd:'assigned_workspace',available_tools:['ask_permission','run_command','write_to_file','view_file','list_dir','replace_file_content','multi_replace_file_content','finish'],available_tools_semantics:'headless_init_tools_available_to_cli_not_profile_allowlist',tool_events:[{step_index:1,name:'list_dir',state:'DONE',error_category:'permission_denied',denied_path:'unknown'}],tool_lifecycle_update_count:1,distinct_tool_step_count:1,soft_denial_observed:true,result_status:'SUCCESS',response_empty:true,response_characters:0,streamed_agent_text_characters:0,requested_agent:'foreman-worker',agent_definition_sha256:response.metadata.agy_diagnostic.agent_definition_sha256,requested_execution_mode:'accept-edits',outcome:'soft_denied_without_response'});
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
  assert.equal(response.error.message,"The Worker used AGY's `run_command` tool, which Foreman's Worker profile doesn't allow; retry, or switch the Worker model.");
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
    {step_index:3,name:'view_file',state:'ERROR',error_category:'permission_denied',denied_path:'unknown'},
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
  assert.equal(response.error.message,'AGY Worker selected the wrong agent; retry, or switch the Worker model');
  assert.equal(response.metadata.agy_worker_tool_policy.selected_agent,'default');
  assert.equal(response.metadata.agy_worker_tool_policy.selected_agent_matches,false);
  assert.deepEqual(response.metadata.agy_worker_tool_policy.unsafe_tool_events,[]);
});

test('AGY Worker reports an agent problem before an unsafe tool when both occur', async t => {
  const shell=`{event:'step_update',step_update:{conversation_id:'agy-both',step_index:1,state:'ACTIVE',step_type:'tool',tool_name:'run_command',tool_info:{name:'run_command'}}}`;
  const result=`{event:'result',result:{conversation_id:'agy-both',status:'SUCCESS',response:'No work performed.',model:'gemini-3.8-flash-medium'}}`;
  const cases=[
    {key:'agy-wrong-agent-and-shell-key',init:`{event:'init',conversation_id:'agy-both',agent:'default',init:{cwd:'/workspace',model:'gemini-3.8-flash-medium',tools:['run_command']}}`,message:'AGY Worker selected the wrong agent; retry, or switch the Worker model',selected:'default'},
    {key:'agy-no-init-and-shell-key',init:undefined,message:'AGY Worker did not emit an initialization event identifying the selected agent',selected:'unreported'},
  ];
  for (const {key,init,message,selected} of cases) {
    const body=`if(process.argv[2]==='models'){console.log('gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)');process.exit(0)}${init?`console.log(JSON.stringify(${init}));`:''}console.log(JSON.stringify(${shell}));console.log(JSON.stringify(${result}));`;
    const {base,baseCommit}=await setup(t,{agyEnabled:true,agyBody:body});
    const events=await submit(base,'antigravity-cli','gemini-3.8-flash-medium',key,baseCommit); const response=events.at(-1).response;
    assert.equal(events.at(-1).type,'response.failed',JSON.stringify(events));
    assert.equal(response.error.message,message,key);
    assert.equal(response.metadata.agy_worker_tool_policy.selected_agent,selected,key);
    assert.deepEqual(response.metadata.agy_worker_tool_policy.unsafe_tool_events,['run_command'],key);
  }
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

// The full Foreman-to-bridge Worker flow, with or without a bridge token (Foreman wires it as server.ts does for a project bridge).
async function codexWorkerFlow(t, token) {
  const fixture = await createWorkspaceFixture(); t.after(fixture.cleanup);
  const parent = await mkdtemp(join(tmpdir(),'foreman-codex-boundary-')); t.after(()=>rm(parent,{recursive:true,force:true}));
  const sentinel=join(parent,'outside-sentinel'); await writeFile(sentinel,'FOREMAN-CODEX-OUTSIDE-SENTINEL');
  const codexBody = `import {readFileSync,writeFileSync} from 'node:fs'; const path=${JSON.stringify(sentinel)}; let read='allowed',write='allowed'; try{readFileSync(path,'utf8')}catch{read='denied'} try{writeFileSync(path,'CHANGED')}catch{write='denied'} writeFileSync('README.md',${JSON.stringify('# Fixture\n\nCodex changed the assigned README.\n')}); writeFileSync('.boundary-result.json',JSON.stringify({read,write})); console.log(JSON.stringify({type:'thread.started',thread_id:'codex-worker-thread'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Updated README.md in the assigned workspace.'}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:11,output_tokens:7}}));`;
  const claudeBody=`let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{const model='claude-actual';const result=prompt.includes('"workerTask"')&&prompt.includes('"targetFiles"')?JSON.stringify({workerTask:'Change README.md with one short sentence.',targetFiles:['README.md']}):'Planner recommends a concise README note.';console.log(JSON.stringify({type:'system',subtype:'init',model,session_id:'judgment-session'}));console.log(JSON.stringify({type:'result',subtype:'success',result,model,session_id:'judgment-session',usage:{input_tokens:5,output_tokens:2}}));});`;
  const {base,env}=await setup(t,{sourceRepo:fixture.repo,baseCommit:fixture.baseCommit,codexBody,claudeBody,...(token?{token}:{})});
  const uhp = new UhpClient({baseUrl:base,timeoutMs:20_000,...(token?{token,fetch:bearerFetch(token)}:{})});
  const controller = new Controller(new JsonStore(join(parent,'foreman-state.json')),uhp,false,true);
  controller.configureVerifiedWorkspace({repoPath:fixture.repo,allowedScope:['README.md','.boundary-result.json'],commands:[{name:'assert verified README content',command:process.execPath,args:['-e',`const fs=require('node:fs');if(fs.readFileSync('README.md','utf8')!=='# Fixture\\n\\nCodex changed the assigned README.\\n')process.exit(1)`]}],bridgeBaseUrl:base,timeoutMs:10_000,maxOutputBytes:2_000,...(token?{bridgeToken:token}:{})});
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
}
test('Codex Worker edits only its seeded workspace; Foreman verifies the complete snapshot and validates it', t => codexWorkerFlow(t));
test('the same Worker flow works end to end against a token-protected bridge, with the token on every Foreman-to-bridge call', t => codexWorkerFlow(t, BRIDGE_TOKEN));

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

// ---- Bearer-token authentication and Host validation ----
// fetch() will not let a caller choose the Host header, so these tests speak raw HTTP.
function rawRequest(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolveRequest, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers, setHost: false }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => resolveRequest({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject); req.end(body);
  });
}
const jsonHeaders = { 'content-type': 'application/json' };
function protectedRoutes(baseCommit) {
  const workspace = 'ws_00000000-0000-0000-0000-000000000000';
  const seed = JSON.stringify({ base_commit: baseCommit });
  const submission = JSON.stringify({ input: 'unauthenticated prompt', model: 'claude-requested', metadata: { harness_id: 'claude-code' }, timeout_seconds: 5, max_step: 1 });
  return [
    ['GET', '/v1/uhp'], ['GET', '/v1/harnesses'], ['GET', '/v1/harnesses/claude-code/models'], ['GET', '/v1/usage'],
    ['POST', '/extensions/foreman-workspace/v1/workspaces', seed],
    ['GET', `/extensions/foreman-workspace/v1/workspaces/${workspace}/snapshot`],
    ['POST', `/extensions/foreman-workspace/v1/workspaces/${workspace}/overlay`, JSON.stringify({ entries: [] })],
    ['POST', '/v1/responses', submission, { 'idempotency-key': 'unauthenticated-key' }],
    ['GET', '/v1/responses/resp_00000000-0000-0000-0000-000000000000'],
    ['POST', '/v1/responses/resp_00000000-0000-0000-0000-000000000000/cancel', '{}'],
  ];
}

test('with LOCAL_CLI_UHP_TOKEN set, a missing or wrong bearer token gets 401 on every route before any work', async t => {
  const { port, env, token, baseCommit } = await setup(t, { token: BRIDGE_TOKEN });
  const wrong = [undefined, 'Bearer', 'Bearer ', 'Bearer wrong', `Bearer ${token.slice(0, -1)}`, `Bearer ${token}x`, `Bearer ${token.toUpperCase()}`, `Basic ${token}`, token, `Bearer ${token} ${token}`];
  for (const [method, path, body, extra] of protectedRoutes(baseCommit)) for (const authorization of wrong) {
    const response = await rawRequest(port, { method, path, body, headers: { host: `127.0.0.1:${port}`, ...(body ? jsonHeaders : {}), ...extra, ...(authorization === undefined ? {} : { authorization }) } });
    const label = `${method} ${path} with ${authorization === undefined ? 'no Authorization' : JSON.stringify(authorization.replace(token, '<token>'))}`;
    assert.equal(response.status, 401, label);
    assert.equal(JSON.parse(response.text).error.code, 'unauthorized', label);
    assert.equal(response.headers['www-authenticate'], 'Bearer', label);
    assert.ok(!response.text.includes(token), label);
  }
  // Nothing behind the rejected requests ran: no workspace was seeded and no idempotency intent was persisted.
  assert.deepEqual((await readdir(env.LOCAL_CLI_UHP_WORK)).filter(name => name.startsWith('ws_')), []);
  await assert.rejects(stat(env.LOCAL_CLI_UHP_STATE), { code: 'ENOENT' });
});

test('the right bearer token unlocks discovery, seeding, snapshots, usage and submissions through Foreman clients', async t => {
  const claudeBody = `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-requested',session_id:'token-session'}));console.log(JSON.stringify({type:'result',subtype:'success',result:'authorized answer',model:'claude-requested',session_id:'token-session',usage:{input_tokens:1,output_tokens:1}}));});`;
  const { base, authHeaders, token, baseCommit } = await setup(t, { token: BRIDGE_TOKEN, claudeBody });
  const discovery = await fetch(`${base}/v1/uhp`, { headers: { authorization: `bEaReR ${token}` } });
  assert.equal(discovery.status, 200); assert.equal((await discovery.json()).implementation.name, 'local-cli-uhp');
  assert.equal((await fetch(`${base}/v1/usage`, { headers: authHeaders })).status, 200);
  // The Foreman workspace helpers: seed, overlay and read the snapshot back, all with the token.
  const seeded = await seedBridgeWorkspace(base, baseCommit, { token });
  assert.equal(seeded.baseCommit, baseCommit);
  const overlay = await overlayBridgeWorkspace(base, seeded.workspaceId, [{ path: 'README.md', contentBase64: Buffer.from('overlaid\n').toString('base64'), mode: '100644' }], { token });
  assert.equal(overlay.applied, 1);
  const snapshot = await fetchBridgeSnapshot(base, seeded.workspaceId, baseCommit, { token });
  assert.equal(snapshot.complete, true); assert.ok(snapshot.entries.length > 0);
  assert.equal(Buffer.from(snapshot.entries.find(entry => entry.path === 'README.md').contentBase64, 'base64').toString('utf8'), 'overlaid\n');
  // Without the token, or with a wrong one, the same helpers surface a 401 and never echo the token.
  for (const call of [() => seedBridgeWorkspace(base, baseCommit), () => overlayBridgeWorkspace(base, seeded.workspaceId, []), () => fetchBridgeSnapshot(base, seeded.workspaceId, baseCommit), () => seedBridgeWorkspace(base, baseCommit, { token: `${token}0` })]) {
    await assert.rejects(call, error => /\(401\)/.test(error.message) && !error.message.includes(token));
  }
  // Foreman's client for the bridge (see createProjectRuntime): the token rides on every call, discovery included.
  const input = { submissionId: 'sub-token', assignmentId: 'asg-token', runId: 'run-token', roleId: 'planner', taskId: 'task-token', projectId: 'prj-token', prompt: 'Reply once.', config: { harnessId: 'claude-code', model: 'claude-requested', timeoutSeconds: 5 }, idempotencyKey: 'token-submit-key' };
  const authorized = new UhpClient({ baseUrl: base, token, fetch: bearerFetch(token), harnessId: 'claude-code', model: 'claude-requested' });
  assert.equal((await authorized.discover()).version, '2026-09-12');
  assert.equal((await authorized.submit(input)).outputText, 'authorized answer');
  await assert.rejects(new UhpClient({ baseUrl: base, harnessId: 'claude-code', model: 'claude-requested' }).submit(input), /UHP request failed \(401\): unauthorized/);
  await assert.rejects(new UhpClient({ baseUrl: base, token: `${token}0`, fetch: bearerFetch(`${token}0`), harnessId: 'claude-code', model: 'claude-requested' }).discover(), /UHP request failed \(401\): unauthorized/);
});

for (const withToken of [false, true]) test(`a foreign Host header gets 403 ${withToken ? 'even with the right token' : 'when no token is configured'}; loopback names on the bridge port are accepted`, async t => {
  const { port, authHeaders, baseCommit } = await setup(t, { token: withToken ? BRIDGE_TOKEN : undefined });
  const foreign = [`evil.example:${port}`, 'evil.example', '127.0.0.1', 'localhost', '[::1]', `127.0.0.1:${port + 1}`, `localhost:${port}0`, `localhost.evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `0.0.0.0:${port}`, `[::2]:${port}`, `::1:${port}`, `localhost..:${port}`, `user@localhost:${port}`];
  for (const host of foreign) for (const [method, path, body, extra] of protectedRoutes(baseCommit).filter((_, index) => index % 3 === 0)) {
    const label = `Host ${JSON.stringify(host)} ${method} ${path}`;
    const response = await rawRequest(port, { method, path, body, headers: { host, ...authHeaders, ...(body ? jsonHeaders : {}), ...extra } });
    assert.equal(response.status, 403, label); assert.equal(JSON.parse(response.text).error.code, 'host_forbidden', label);
  }
  // A foreign Host is refused before the missing or wrong token is even considered.
  if (withToken) for (const authorization of [undefined, 'Bearer wrong']) assert.equal((await rawRequest(port, { path: '/v1/uhp', headers: { host: `evil.example:${port}`, ...(authorization ? { authorization } : {}) } })).status, 403);
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `LocalHost.:${port}`, `127.0.0.1.:${port}`, `[::1]:${port}`]) {
    const response = await rawRequest(port, { path: '/v1/uhp', headers: { host, ...authHeaders } });
    assert.equal(response.status, 200, host); assert.equal(JSON.parse(response.text).protocol, 'uhp');
  }
});

test('the bridge warns once at startup when unauthenticated, stays quiet when a token is set, and never prints the token', async t => {
  const waitForListening = async bridge => { for (let i = 0; i < 500 && !/listening on/.test(bridge.output()); i++) await new Promise(r => setTimeout(r, 20)); assert.match(bridge.output(), /listening on/, 'the bridge never reported that it is listening'); };
  const open = await setup(t, { captureOutput: true }); await waitForListening(open);
  assert.equal(open.output().split('\n').filter(line => line.includes('WARNING: LOCAL_CLI_UHP_TOKEN is not set')).length, 1, open.output());
  assert.equal((await fetch(`${open.base}/v1/uhp`)).status, 200); // still serves unauthenticated requests in the documented manual mode
  const secured = await setup(t, { token: BRIDGE_TOKEN, captureOutput: true }); await waitForListening(secured);
  assert.match(secured.output(), /listening on 127\.0\.0\.1:\d+ \(bearer token required\)/);
  assert.doesNotMatch(secured.output(), /WARNING/); assert.ok(!secured.output().includes(BRIDGE_TOKEN));
});

test('an unusable token or an occupied port stops the bridge at startup without printing the token', async () => {
  const badToken = 'bad token with spaces';
  const bad = spawn(process.execPath, [join(here, 'server.mjs')], { env: { ...process.env, LOCAL_CLI_UHP_TOKEN: badToken, LOCAL_CLI_UHP_WORK: join(tmpdir(), `local-cli-uhp-bad-token-${process.pid}`) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let badOutput = ''; for (const stream of [bad.stdout, bad.stderr]) stream.on('data', chunk => { badOutput += chunk; });
  assert.equal(await new Promise(resolveCode => bad.once('exit', resolveCode)), 1);
  assert.match(badOutput, /LOCAL_CLI_UHP_TOKEN must be 1-512 printable ASCII characters without spaces/); assert.ok(!badOutput.includes(badToken));
  // A restart that cannot rebind its port must exit promptly with a diagnostic so a supervisor can count it as a failure.
  const holder = createNetServer(); await new Promise(resolveListen => holder.listen(0, '127.0.0.1', resolveListen));
  const dir = await mkdtemp(join(tmpdir(), 'local-cli-uhp-port-')); dirs.push(dir);
  try {
    const busy = spawn(process.execPath, [join(here, 'server.mjs')], { env: { ...process.env, LOCAL_CLI_UHP_PORT: String(holder.address().port), LOCAL_CLI_UHP_STATE: join(dir, 'state.json'), LOCAL_CLI_UHP_WORK: join(dir, 'work') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let busyOutput = ''; for (const stream of [busy.stdout, busy.stderr]) stream.on('data', chunk => { busyOutput += chunk; });
    assert.equal(await new Promise(resolveCode => busy.once('exit', resolveCode)), 1);
    assert.match(busyOutput, /could not listen on 127\.0\.0\.1:\d+: .*EADDRINUSE/);
  } finally { holder.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an authenticated request with a malformed URL is rejected without crashing the bridge, and CLI children never see the token', async t => {
  const claudeBody = `process.stdin.resume();process.stdin.on('end',()=>{const seen=Object.entries(process.env).some(([name,value])=>/TOKEN/i.test(name)||String(value).includes(${JSON.stringify(BRIDGE_TOKEN)}));console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-requested',session_id:'env-session'}));console.log(JSON.stringify({type:'result',subtype:'success',result:'token_visible='+seen+';env_entries='+(Object.keys(process.env).length>0),model:'claude-requested',session_id:'env-session',usage:{input_tokens:1,output_tokens:1}}));});`;
  const { base, port, token, authHeaders } = await setup(t, { token: BRIDGE_TOKEN, claudeBody });
  const malformed = await rawRequest(port, { path: '//[', headers: { host: `127.0.0.1:${port}`, ...authHeaders } });
  assert.equal(malformed.status, 400); assert.equal(JSON.parse(malformed.text).error.code, 'invalid_url');
  assert.equal((await fetch(`${base}/v1/uhp`, { headers: authHeaders })).status, 200);
  const client = new UhpClient({ baseUrl: base, token, fetch: bearerFetch(token), harnessId: 'claude-code', model: 'claude-requested' });
  const result = await client.submit({ submissionId: 'sub-env', assignmentId: 'asg-env', runId: 'run-env', roleId: 'planner', taskId: 'task-env', projectId: 'prj-env', prompt: 'Report your environment.', config: { harnessId: 'claude-code', model: 'claude-requested', timeoutSeconds: 5 }, idempotencyKey: 'token-env-key' });
  assert.equal(result.outputText, 'token_visible=false;env_entries=true');
});

// Batch seeding and workspace cleanup.
const gitIn = (repo, ...args) => new Promise((resolveGit, reject) => execFile('git', ['-C', repo, ...args], { encoding: 'buffer', maxBuffer: 1 << 28 }, (error, out) => error ? reject(error) : resolveGit(out)));
async function makeRepo(t, populate) {
  const repo = await mkdtemp(join(tmpdir(), 'uhp-batch-repo-')); t.after(() => rm(repo, { recursive: true, force: true }));
  await gitIn(repo, 'init', '-q'); await gitIn(repo, 'config', 'user.name', 'Fixture'); await gitIn(repo, 'config', 'user.email', 'fixture@example.invalid');
  await populate(repo);
  await gitIn(repo, 'add', '--all'); await gitIn(repo, 'commit', '-qm', 'fixture');
  return { repo, baseCommit: (await gitIn(repo, 'rev-parse', 'HEAD')).toString().trim() };
}
const seedRaw = (base, baseCommit, headers = {}) => fetch(`${base}/extensions/foreman-workspace/v1/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ base_commit: baseCommit }) });
const deleteWorkspace = (base, id, headers = {}) => fetch(`${base}/extensions/foreman-workspace/v1/workspaces/${id}`, { method: 'DELETE', headers });
async function bridgeGitChildren(repo) {
  const found = [];
  for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) { try { if ((await readFile(`/proc/${pid}/cmdline`, 'utf8')).includes(`${repo}\0cat-file`)) found.push(pid); } catch {} }
  return found;
}
const slowClaude = ms => `process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-requested',session_id:'slow-session'}));console.log(JSON.stringify({type:'result',subtype:'success',result:'slow bounded answer',model:'claude-requested',session_id:'slow-session',usage:{input_tokens:3,output_tokens:2}}));},${ms}));`;
async function startResponse(base, headers, key, workspaceId) {
  const r = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'UHP-Version': '2026-09-12', 'Idempotency-Key': key, ...headers }, body: JSON.stringify({ input: 'Say bounded answer', model: 'claude-requested', metadata: { harness_id: 'claude-code', workspace_id: workspaceId }, stream: true, timeout_seconds: 10, max_step: 1 }) });
  assert.equal(r.status, 200); return r;
}
async function until(check, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise(r => setTimeout(r, 50)); } return false; }
const exists = path => lstat(path).then(() => true, () => false);

test('batch seeding reproduces binary, empty, executable and symlink blobs across more than 200 files', async t => {
  const files = new Map();
  const { repo, baseCommit } = await makeRepo(t, async repo => {
    for (let i = 0; i < 250; i++) { const path = `dir${i % 7}/sub/file${i}.txt`; files.set(path, Buffer.from(`file ${i}\n`.repeat(1 + (i % 5)))); }
    files.set('bin/random.bin', randomBytes(300_000));
    files.set('bin/all.bin', Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from('\n\n0123456789abcdef 1 2\n'), Buffer.alloc(70_000, 10)]));
    files.set('empty.txt', Buffer.alloc(0));
    for (const [path, bytes] of files) { await mkdir(dirname(join(repo, path)), { recursive: true }); await writeFile(join(repo, path), bytes); }
    await writeFile(join(repo, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 }); await chmod(join(repo, 'run.sh'), 0o755);
    await symlink('dir0/sub/file0.txt', join(repo, 'link'));
  });
  const { base, env } = await setup(t, { sourceRepo: repo });
  const seed = await seedRaw(base, baseCommit); assert.equal(seed.status, 201);
  const work = join(env.LOCAL_CLI_UHP_WORK, (await seed.json()).workspace_id);
  for (const [path, bytes] of files) assert.ok((await readFile(join(work, path))).equals(bytes), path);
  assert.equal((await stat(join(work, 'run.sh'))).mode & 0o777, 0o755); assert.equal((await stat(join(work, 'empty.txt'))).mode & 0o777, 0o644);
  assert.equal(await readlink(join(work, 'link')), 'dir0/sub/file0.txt');
  assert.deepEqual(await bridgeGitChildren(repo), []);
});

test('batch seeding fails cleanly on a blob over the cap, a missing blob and an escaping symlink, and leaves no workspace or git child', async t => {
  const big = await makeRepo(t, async repo => { await writeFile(join(repo, 'a.txt'), 'small\n'); await writeFile(join(repo, 'big.bin'), Buffer.alloc(16 * 1024 * 1024 + 1)); });
  const missing = await makeRepo(t, async repo => { await writeFile(join(repo, 'a.txt'), 'small\n'); await writeFile(join(repo, 'gone.txt'), 'this blob will be deleted\n'); });
  const oid = (await gitIn(missing.repo, 'rev-parse', `${missing.baseCommit}:gone.txt`)).toString().trim();
  await rm(join(missing.repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), { force: true });
  const escape = await makeRepo(t, async repo => { await writeFile(join(repo, 'a.txt'), 'small\n'); await symlink('../outside', join(repo, 'evil')); });
  const { base, env } = await setup(t, { sourceRepo: big.repo });
  const r1 = await seedRaw(base, big.baseCommit); assert.equal(r1.status, 500); assert.match((await r1.json()).error.message, /size limit exceeded: big\.bin/);
  assert.deepEqual(await readdir(env.LOCAL_CLI_UHP_WORK), []); assert.deepEqual(await bridgeGitChildren(big.repo), []);
  const other = await setup(t, { sourceRepo: missing.repo });
  const r2 = await seedRaw(other.base, missing.baseCommit); assert.equal(r2.status, 500); assert.match((await r2.json()).error.message, /blob is missing: gone\.txt/);
  assert.deepEqual(await readdir(other.env.LOCAL_CLI_UHP_WORK), []); assert.deepEqual(await bridgeGitChildren(missing.repo), []);
  const third = await setup(t, { sourceRepo: escape.repo });
  const r3 = await seedRaw(third.base, escape.baseCommit); assert.equal(r3.status, 500); assert.match((await r3.json()).error.message, /symlink escapes workspace: evil/);
  assert.deepEqual(await readdir(third.env.LOCAL_CLI_UHP_WORK), []);
  assert.equal((await fetch(`${other.base}/v1/uhp`)).status, 200);
});

test('DELETE removes a workspace and its sibling dirs: 404 unknown, 401 without the token, 409 while a response runs, 204 after', async t => {
  const { base, env, baseCommit, authHeaders } = await setup(t, { token: BRIDGE_TOKEN, claudeBody: slowClaude(1500) });
  const seed = await (await seedRaw(base, baseCommit, authHeaders)).json(); const id = seed.workspace_id;
  const work = join(env.LOCAL_CLI_UHP_WORK, id); const codexHome = `${work}.codex-home`; await mkdir(codexHome);
  assert.equal((await deleteWorkspace(base, `ws_${randomUUID()}`, authHeaders)).status, 404);
  for (const headers of [{}, { authorization: 'Bearer wrong' }]) assert.equal((await deleteWorkspace(base, id, headers)).status, 401);
  assert.ok(await exists(work));
  const running = await startResponse(base, authHeaders, 'delete-running', id);
  const blocked = await deleteWorkspace(base, id, authHeaders); assert.equal(blocked.status, 409); assert.equal((await blocked.json()).error.code, 'workspace_task_in_progress');
  assert.ok(await exists(work));
  assert.equal(terminalEvent((await running.text()).split('\n').filter(x => x.startsWith('data: ')).map(x => JSON.parse(x.slice(6))))?.type, 'response.completed');
  const removed = await deleteWorkspace(base, id, authHeaders); assert.equal(removed.status, 204); assert.equal(await removed.text(), '');
  assert.ok(!(await exists(work))); assert.ok(!(await exists(codexHome)));
  assert.equal(JSON.parse(await readFile(env.LOCAL_CLI_UHP_STATE, 'utf8')).workspaces[id], undefined);
  assert.equal((await deleteWorkspace(base, id, authHeaders)).status, 404);
  assert.equal((await fetch(`${base}/extensions/foreman-workspace/v1/workspaces/${id}/snapshot`, { headers: authHeaders })).status, 404);
});

test('DELETE and the startup sweep never remove anything outside the work root through a symlinked workspace dir', async t => {
  const { base, env, baseCommit, restart } = await setup(t);
  const outside = await mkdtemp(join(tmpdir(), 'uhp-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'precious.txt'), 'keep me');
  const id = (await (await seedRaw(base, baseCommit)).json()).workspace_id; const work = join(env.LOCAL_CLI_UHP_WORK, id);
  await rm(work, { recursive: true, force: true }); await symlink(outside, work); await symlink(outside, `${work}.codex-home`);
  assert.equal((await deleteWorkspace(base, id)).status, 204);
  assert.ok(!(await exists(work))); assert.ok(!(await exists(`${work}.codex-home`)));
  assert.equal(await readFile(join(outside, 'precious.txt'), 'utf8'), 'keep me');
  const orphan = join(env.LOCAL_CLI_UHP_WORK, `ws_${randomUUID()}`); await symlink(outside, orphan); await symlink(outside, join(env.LOCAL_CLI_UHP_WORK, `review-${randomUUID()}`));
  await restart();
  assert.ok(!(await exists(orphan))); assert.deepEqual(await readdir(env.LOCAL_CLI_UHP_WORK), []);
  assert.equal(await readFile(join(outside, 'precious.txt'), 'utf8'), 'keep me');
});

test('startup removes work-root entries no persisted state references and keeps everything that is referenced', async t => {
  const { base, env, baseCommit, restart } = await setup(t);
  const root = env.LOCAL_CLI_UHP_WORK;
  const kept = (await (await seedRaw(base, baseCommit)).json()).workspace_id; await mkdir(join(root, `${kept}.codex-home`));
  const orphan = `ws_${randomUUID()}`; const orphanFiles = [orphan, `${orphan}.codex-home`, `review-${randomUUID()}`, `resp_${randomUUID()}.review-codex-home`, `codex-preflight-${randomUUID()}`];
  for (const name of orphanFiles) { await mkdir(join(root, name)); await writeFile(join(root, name, 'x'), 'x'); }
  await chmod(join(root, orphanFiles[2]), 0o500);
  for (const name of ['kept-role', 'orphan-role']) { await mkdir(join(root, 'role-sessions', name), { recursive: true }); await writeFile(join(root, 'role-sessions', name, 'x'), 'x'); }
  await writeFile(join(root, 'not-ours.txt'), 'foreign'); await mkdir(join(root, 'ws_not-a-uuid'));
  const statePath = env.LOCAL_CLI_UHP_STATE; const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  persisted.responses.resp_role = { id: 'resp_role', object: 'response', status: 'completed', metadata: { role_session_state_path: join(root, 'role-sessions', 'kept-role') } };
  await writeFile(statePath, JSON.stringify(persisted));
  await restart();
  assert.deepEqual((await readdir(root)).sort(), [kept, `${kept}.codex-home`, 'not-ours.txt', 'role-sessions', 'ws_not-a-uuid'].sort());
  assert.deepEqual(await readdir(join(root, 'role-sessions')), ['kept-role']);
  assert.equal((await fetch(`${base}/extensions/foreman-workspace/v1/workspaces/${kept}/snapshot`)).status, 200);
  await rm(join(root, kept), { recursive: true, force: true }); await restart();
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).workspaces[kept], undefined);
});

test('the TTL sweep removes idle workspaces but never one with a running response', async t => {
  const { base, env, baseCommit } = await setup(t, { claudeBody: slowClaude(3000), extraEnv: { LOCAL_CLI_UHP_WORKSPACE_TTL_MS: '800' } });
  const idle = (await (await seedRaw(base, baseCommit)).json()).workspace_id; const busy = (await (await seedRaw(base, baseCommit)).json()).workspace_id;
  const busyDir = join(env.LOCAL_CLI_UHP_WORK, busy);
  const running = await startResponse(base, {}, 'ttl-running', busy); let finished = false; const body = running.text().then(text => { finished = true; return text; });
  assert.ok(await until(async () => !(await exists(join(env.LOCAL_CLI_UHP_WORK, idle)))), 'the idle workspace was never swept');
  assert.equal(finished, false); assert.ok(await exists(busyDir), 'the busy workspace was swept mid-run');
  assert.match(await body, /response\.completed/);
  assert.ok(await exists(busyDir));
  assert.ok(await until(async () => !(await exists(busyDir))), 'the finished workspace was never swept once idle');
  const persisted = JSON.parse(await readFile(env.LOCAL_CLI_UHP_STATE, 'utf8')).workspaces; assert.equal(persisted[idle], undefined); assert.equal(persisted[busy], undefined);
});

// Worker check gate: the bridge pauses a completed Worker turn, Foreman checks the paused workspace, and a failed verdict
// resumes the same CLI session with the failures.
async function streamGatedWorker(base, { harness, model, key, workspaceId, rounds = 2, onGate }) {
  const r = await fetch(`${base}/v1/responses`, { method:'POST', headers:{ 'Content-Type':'application/json', Accept:'text/event-stream', 'UHP-Version':'2026-09-12', 'Idempotency-Key':key }, body:JSON.stringify({ input:'Change README.md', model, metadata:{ harness_id:harness, workspace_id:workspaceId, foreman_worker_gate:{ max_rounds:rounds } }, stream:true, timeout_seconds:5, max_step:1 }) });
  if (r.status !== 200) assert.fail(await r.text());
  const reader = r.body.getReader(), decoder = new TextDecoder(), events = []; let buffer = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream:true });
    let cut; while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
      const line = chunk.split('\n').find(x => x.startsWith('data: ')); if (!line) continue;
      const item = JSON.parse(line.slice(6)); events.push(item);
      if (item.type === 'response.activity' && item.response.activity.kind === 'worker_gate') await onGate(item.response.activity.gate_round, item.response.id);
    }
  }
  return events;
}
const postVerdict = (base, responseId, verdict) => fetch(`${base}/extensions/foreman-workspace/v1/responses/${responseId}/worker-gate`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(verdict) });
const seedWorkspace = async (base, baseCommit) => (await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ base_commit:baseCommit }) })).json()).workspace_id;

test('check gate resumes a Claude Worker in its own kept session with the failure feedback', async t => {
  // First turn writes a wrong README and records a transcript; the resumed turn must see that transcript and the feedback.
  const claudeBody = `import {writeFileSync,readFileSync,existsSync,appendFileSync,mkdirSync} from 'node:fs'; let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{const resume=process.argv.includes('--resume')?process.argv[process.argv.indexOf('--resume')+1]:''; const transcript=process.env.CLAUDE_CONFIG_DIR+'/projects/gate-transcript'; const kept=existsSync(transcript); mkdirSync(process.env.CLAUDE_CONFIG_DIR+'/projects',{recursive:true}); writeFileSync(transcript,'turn'); appendFileSync('.gate-log',JSON.stringify({resume,kept,feedback:prompt.includes('lint failed: README must say fixed')})+'\\n'); writeFileSync('README.md',resume?'fixed\\n':'first\\n'); const model='claude-actual'; console.log(JSON.stringify({type:'system',subtype:'init',model,session_id:'gate-session'})); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:resume?'Fixed the check.':'Changed README.',model,session_id:'gate-session',usage:{input_tokens:7,output_tokens:3,cache_read_input_tokens:2}}));});`;
  const { base, baseCommit, env } = await setup(t, { claudeBody });
  const workspaceId = await seedWorkspace(base, baseCommit);
  const seen = [];
  const events = await streamGatedWorker(base, { harness:'claude-code', model:'claude-requested', key:'gate-claude', workspaceId, onGate: async (round, responseId) => {
    const snapshot = await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces/${workspaceId}/snapshot`)).json();
    const readme = Buffer.from(snapshot.entries.find(e => e.path === 'README.md').contentBase64, 'base64').toString('utf8');
    seen.push({ round, complete:snapshot.complete, errors:snapshot.errors.length, readme });
    assert.equal((await postVerdict(base, responseId, { round:round + 1, status:'passed' })).status, 409, 'a verdict for another round is refused');
    const verdict = round === 1 ? { round, status:'failed', feedback:'lint failed: README must say fixed', failed_checks:['lint'] } : { round, status:'passed' };
    assert.equal((await postVerdict(base, responseId, verdict)).status, 202);
  } });
  const final = events.at(-1);
  assert.equal(final.type, 'response.completed', JSON.stringify(final));
  assert.deepEqual(seen, [{ round:1, complete:true, errors:0, readme:'first\n' }, { round:2, complete:true, errors:0, readme:'fixed\n' }]);
  assert.deepEqual(final.response.metadata.worker_gate, { max_rounds:2, state:'finished', rounds:[{ round:1, status:'failed', failed_checks:['lint'] }, { round:2, status:'passed' }] });
  assert.equal(final.response.session_id, 'gate-session');
  assert.deepEqual(final.response.usage, { input_tokens:14, output_tokens:6, input_tokens_details:{ cached_tokens:4 } });
  const work = join(env.LOCAL_CLI_UHP_WORK, workspaceId);
  const log = (await readFile(join(work, '.gate-log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log, [{ resume:'', kept:false, feedback:false }, { resume:'gate-session', kept:true, feedback:true }]);
  assert.equal(await exists(`${work}.worker-session`), false, 'the kept session is removed when the task ends');
  const snapshot = await (await fetch(`${base}/extensions/foreman-workspace/v1/workspaces/${workspaceId}/snapshot`)).json();
  assert.equal(snapshot.complete, true);
});

test('check gate ends the Worker turn as it is on a passed first verdict, a timeout, or a cancellation', async t => {
  const claudeBody = `import {writeFileSync,appendFileSync} from 'node:fs'; process.stdin.resume(); process.stdin.on('end',()=>{appendFileSync('.gate-count','x'); writeFileSync('README.md','edited\\n'); const model='claude-actual'; console.log(JSON.stringify({type:'system',subtype:'init',model,session_id:'s'})); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok',model,session_id:'s',usage:{input_tokens:1,output_tokens:1}}));});`;
  const { base, baseCommit, env } = await setup(t, { claudeBody, extraEnv:{ LOCAL_CLI_UHP_WORKER_GATE_TIMEOUT_MS:'300' } });
  const passedWs = await seedWorkspace(base, baseCommit);
  const passed = await streamGatedWorker(base, { harness:'claude-code', model:'claude-requested', key:'gate-pass', workspaceId:passedWs, onGate: async (round, id) => { assert.equal((await postVerdict(base, id, { round, status:'passed' })).status, 202); } });
  assert.equal(passed.at(-1).type, 'response.completed');
  assert.deepEqual(passed.at(-1).response.metadata.worker_gate.rounds, [{ round:1, status:'passed' }]);
  assert.equal(await readFile(join(env.LOCAL_CLI_UHP_WORK, passedWs, '.gate-count'), 'utf8'), 'x');
  const timedWs = await seedWorkspace(base, baseCommit);
  const timed = await streamGatedWorker(base, { harness:'claude-code', model:'claude-requested', key:'gate-timeout', workspaceId:timedWs, onGate: async () => {} });
  assert.equal(timed.at(-1).type, 'response.completed');
  assert.deepEqual(timed.at(-1).response.metadata.worker_gate.rounds, [{ round:1, status:'skipped', reason:'verdict_timeout' }]);
  const cancelWs = await seedWorkspace(base, baseCommit);
  const cancelled = await streamGatedWorker(base, { harness:'claude-code', model:'claude-requested', key:'gate-cancel', workspaceId:cancelWs, onGate: async (round, id) => { assert.equal((await fetch(`${base}/v1/responses/${id}/cancel`, { method:'POST' })).status, 200); } });
  assert.equal(cancelled.at(-1).type, 'response.cancelled', JSON.stringify(cancelled.at(-1)));
});

test('check gate requests are validated and refused for Reviewer and role sessions', async t => {
  const { base, baseCommit } = await setup(t);
  const workspaceId = await seedWorkspace(base, baseCommit);
  const post = (key, metadata) => fetch(`${base}/v1/responses`, { method:'POST', headers:{ 'Content-Type':'application/json', 'UHP-Version':'2026-09-12', 'Idempotency-Key':key }, body:JSON.stringify({ input:'x', model:'claude-requested', metadata:{ harness_id:'claude-code', ...metadata }, stream:true, timeout_seconds:5, max_step:1 }) });
  assert.equal((await (await post('gate-bad-rounds', { workspace_id:workspaceId, foreman_worker_gate:{ max_rounds:9 } })).json()).error.code, 'worker_gate_invalid');
  assert.equal((await (await post('gate-planner', { foreman_role_id:'planner', foreman_run_id:'run_1', foreman_worker_gate:{ max_rounds:1 } })).json()).error.code, 'worker_gate_role_unsupported');
  const discovery = await (await fetch(`${base}/v1/uhp`)).json();
  assert.deepEqual(discovery.capabilities.extensions.foreman_worker_gate_v1, { version:1, max_rounds:3 });
  assert.equal((await postVerdict(base, 'resp_missing', { round:1, status:'passed' })).status, 404);
});

test('Foreman answers check rounds so a Codex Worker fixes a failing check in its kept session within one attempt', async t => {
  const fixture = await createWorkspaceFixture(); t.after(fixture.cleanup);
  const parent = await mkdtemp(join(tmpdir(),'foreman-worker-gate-')); t.after(()=>rm(parent,{recursive:true,force:true}));
  const codexBody = `import {readFileSync,writeFileSync,existsSync,appendFileSync,mkdirSync} from 'node:fs'; let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{const i=process.argv.indexOf('resume'); const resume=i>=0?process.argv[i+1]:''; const marker=process.env.CODEX_HOME+'/sessions/gate'; const kept=existsSync(marker); mkdirSync(process.env.CODEX_HOME+'/sessions',{recursive:true}); writeFileSync(marker,'x'); appendFileSync('.gate-log',JSON.stringify({resume,kept,ephemeral:process.argv.includes('--ephemeral'),feedback:prompt.includes('assert fixed README')&&prompt.includes('README is not fixed yet')})+'\\n'); writeFileSync('README.md',resume?'# Fixture\\n\\nfixed\\n':'# Fixture\\n\\nfirst try\\n'); console.log(JSON.stringify({type:'thread.started',thread_id:'codex-gate-thread'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Edited README.md.'}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:11,output_tokens:7}}));});`;
  const claudeBody=`let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{const model='claude-actual';const result=prompt.includes('"workerTask"')&&prompt.includes('"targetFiles"')?JSON.stringify({workerTask:'Change README.md with one short sentence.',targetFiles:['README.md']}):'Planner recommends a concise README note.';console.log(JSON.stringify({type:'system',subtype:'init',model,session_id:'judgment-session'}));console.log(JSON.stringify({type:'result',subtype:'success',result,model,session_id:'judgment-session',usage:{input_tokens:5,output_tokens:2}}));});`;
  const {base,env}=await setup(t,{sourceRepo:fixture.repo,baseCommit:fixture.baseCommit,codexBody,claudeBody});
  const uhp = new UhpClient({baseUrl:base,timeoutMs:20_000});
  const controller = new Controller(new JsonStore(join(parent,'foreman-state.json')),uhp,false,true);
  const check = `const fs=require('node:fs');if(!fs.readFileSync('README.md','utf8').includes('fixed')){console.log('README is not fixed yet');process.exit(1)}`;
  controller.configureVerifiedWorkspace({repoPath:fixture.repo,allowedScope:['README.md','.gate-log'],commands:[{name:'assert fixed README',command:process.execPath,args:['-e',check]}],bridgeBaseUrl:base,timeoutMs:10_000,maxOutputBytes:2_000,workerCheckRounds:2});
  await controller.refreshDiscovery();
  const project=await controller.createProject('Worker check gate fixture');
  const task=await controller.createTask(project.id,'Edit the assigned README');
  const run=await controller.createRun(task.id);
  for (const role of ['planner','orchestrator']) await controller.selectRoleConfig(role,{harnessId:'claude-code',model:'claude-requested',options:{timeoutSeconds:5,maxStep:1}},undefined,run.id);
  await controller.selectRoleConfig('worker',{harnessId:'codex-cli',model:'codex-requested',options:{timeoutSeconds:5,maxStep:1}},undefined,run.id);
  await controller.prepareWorkerWorkspace(run.id,fixture.baseCommit);
  await controller.addGuidance(run.id,'Keep the README change to one short note.');
  const orchestration=await controller.orchestrate(run.id,'Implement the requested README note.');
  assert.ok(orchestration.proposal, JSON.stringify(orchestration.assignment));
  const assignment=await controller.dispatchWorkerProposal(run.id,orchestration.proposal.id);
  assert.equal(assignment.status,'succeeded',JSON.stringify(assignment));
  assert.equal(assignment.usage.inputTokens,22,'both Codex turns are counted');
  assert.deepEqual(assignment.cliInvocation?.args.slice(-3),['--model','codex-requested','-']);
  const response=await uhp.retrieve(assignment.responseId);
  assert.deepEqual(response.metadata.worker_gate.rounds,[{round:1,status:'failed',failed_checks:['assert fixed README']},{round:2,status:'passed'}]);
  const log=(await readFile(join(env.LOCAL_CLI_UHP_WORK,response.metadata.workspace_id,'.gate-log'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(log,[{resume:'',kept:false,ephemeral:false,feedback:false},{resume:'codex-gate-thread',kept:true,ephemeral:false,feedback:true}]);
  const state=await controller.state();
  assert.deepEqual(state.events.filter(e=>e.type==='worker.check_round').map(e=>[e.data.round,e.data.status,e.data.failedChecks]),[[1,'failed',['assert fixed README']],[2,'passed',[]]]);
  const verified=await controller.verifyWorkerOutput(run.id,assignment.id);
  assert.equal(verified.validation.status,'passed',JSON.stringify(verified.validation));
  assert.equal((await controller.state()).projects[0].tasks[0].runs[0].assignments.filter(a=>a.roleId==='worker').length,1,'the fix used no second Worker attempt');
});

test('check gate resumes an Antigravity Worker in its kept conversation', async t => {
  const agyBody = `import {writeFileSync,existsSync,appendFileSync} from 'node:fs'; if(process.argv[2]==='models'){console.log('gemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)');process.exit(0)} const ci=process.argv.indexOf('--conversation'); const resume=ci>=0?process.argv[ci+1]:''; const prompt=process.argv[process.argv.indexOf('-p')+1]||''; const marker=process.env.HOME+'/.gemini/antigravity-cli/conversations/gate'; const kept=existsSync(marker); writeFileSync(marker,'x'); appendFileSync('.gate-log',JSON.stringify({resume,kept,feedback:prompt.includes('typecheck failed here')})+'\\n'); writeFileSync('README.md',resume?'fixed\\n':'first\\n'); const conversation_id='agy-gate-conversation'; const model='gemini-3.8-flash-medium'; console.log(JSON.stringify({event:'init',conversation_id,agent:'foreman-worker',init:{cwd:'/workspace',model,tools:['view_file','write_to_file','finish']}})); console.log(JSON.stringify({event:'step_update',step_update:{conversation_id,step_index:0,state:'DONE',step_type:'tool',tool_name:'write_to_file',tool_info:{name:'write_to_file'}}})); console.log(JSON.stringify({event:'result',result:{conversation_id,status:'SUCCESS',response:'Edited README.',model,usage:{input_tokens:resume?30:10,output_tokens:resume?8:4}}}));`;
  const { base, baseCommit, env } = await setup(t, { agyEnabled:true, agyBody });
  const workspaceId = await seedWorkspace(base, baseCommit);
  const events = await streamGatedWorker(base, { harness:'antigravity-cli', model:'gemini-3.8-flash-medium', key:'gate-agy', workspaceId, rounds:1, onGate: async (round, id) => {
    assert.equal((await postVerdict(base, id, { round, status:'failed', feedback:'typecheck failed here', failed_checks:['typecheck'] })).status, 202);
  } });
  const final = events.at(-1);
  assert.equal(final.type, 'response.completed', JSON.stringify(final));
  assert.deepEqual(final.response.metadata.worker_gate.rounds, [{ round:1, status:'failed', failed_checks:['typecheck'] }]);
  assert.equal(final.response.usage.input_tokens, 30, 'Antigravity reports cumulative conversation usage, so the last turn is the total');
  const log = (await readFile(join(env.LOCAL_CLI_UHP_WORK, workspaceId, '.gate-log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log, [{ resume:'', kept:false, feedback:false }, { resume:'agy-gate-conversation', kept:true, feedback:true }]);
});
