import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dirs = [];
async function fixtureCli(dir, name, body) {
  const path = join(dir, name);
  await writeFile(path, `#!${process.execPath}\n${body}\n`); await chmod(path, 0o700); return path;
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'local-cli-uhp-test-')); dirs.push(dir);
  const count = join(dir, 'count');
  const claude = await fixtureCli(dir, 'fake-claude', `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(count)}, 'c\\n'); process.stdin.resume(); process.stdin.on('end',()=>{ console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-actual',session_id:'claude-session'})); console.log(JSON.stringify({type:'result',subtype:'success',result:'bounded answer',model:'claude-actual',session_id:'claude-session',usage:{input_tokens:7,output_tokens:3}})); });`);
  const codex = await fixtureCli(dir, 'fake-codex', `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(count)}, 'x\\n'); process.stdin.resume(); process.stdin.on('end',()=>{ console.log(JSON.stringify({type:'thread.started',thread_id:'codex-thread'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'codex bounded answer'}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:4,output_tokens:2}})); });`);
  const port = 22000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, LOCAL_CLI_UHP_PORT: String(port), LOCAL_CLI_UHP_STATE: join(dir, 'state.json'), LOCAL_CLI_UHP_WORK: join(dir, 'work'), CLAUDE_CONFIG_DIR: join(dir, 'claude-auth'), CODEX_HOME: join(dir, 'codex-auth'), CLAUDE_BIN: claude, CODEX_BIN: codex };
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
  const d=await (await fetch(`${base}/v1/uhp`)).json(); assert.equal(d.default_version,'2026-09-12');
  const hs=await (await fetch(`${base}/v1/harnesses`)).json(); assert.deepEqual(hs.harnesses.map(x=>x.id),['claude-code','codex-cli']);
  const first=await submit(base,'claude-code','default','same-key'); assert.equal(first[0].type,'response.created'); assert.equal(first[1].type,'response.completed',JSON.stringify(first));
  const r=first[1].response; assert.equal(r.output_text,'bounded answer'); assert.equal(r.model,'claude-actual'); assert.equal(r.session_id,'claude-session'); assert.deepEqual(r.usage,{input_tokens:7,output_tokens:3});
  const second=await submit(base,'claude-code','default','same-key'); assert.equal(second[1].response.id,r.id);
  await restart();
  const afterRestart=await submit(base,'claude-code','default','same-key'); assert.equal(afterRestart[1].response.id,r.id);
  assert.equal((await readFile(count,'utf8')).trim().split('\n').length,1);
  const retrieved=await (await fetch(`${base}/v1/responses/${r.id}`,{headers:{'UHP-Version':'2026-09-12'}})).json(); assert.equal(retrieved.id,r.id);
});
test('Codex parser returns reported output and leaves unavailable model/usage absent', async t => {
  const {base,count}=await setup(t);
  const events=await submit(base,'codex-cli','default','codex-key'); const r=events[1].response;
  assert.equal(events[1].type,'response.completed',JSON.stringify(events)); assert.equal(r.output_text,'codex bounded answer'); assert.equal(r.model,undefined);
  assert.equal(r.session_id,'codex-thread'); assert.deepEqual(r.usage,{input_tokens:4,output_tokens:2});
  assert.equal((await readFile(count,'utf8')).trim().split('\n').length,1);
});
test('invalid model and prompt bounds are rejected before CLI spawn', async t => {
  const {base,count}=await setup(t);
  const r=await fetch(`${base}/v1/responses`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'bad'},body:JSON.stringify({input:'x'.repeat(16001),model:'default',metadata:{harness_id:'claude-code'}})});
  assert.equal(r.status,400); await assert.rejects(readFile(count));
});
