import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchBridgeSnapshot, materializeVerifiedWorkspace, validateWorkerOutput, verifyWorkerSnapshot } from '../src/verified-workspace.js';

const dirs:string[]=[];
const git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function fixtureRepo(){const dir=await mkdtemp(join(tmpdir(),'foreman-verified-'));dirs.push(dir);git(dir,'init','-q');git(dir,'config','user.name','Fixture');git(dir,'config','user.email','fixture@example.invalid');await writeFile(join(dir,'README.md'),'base\n');git(dir,'add','README.md');git(dir,'commit','-qm','base');return {dir,sha:git(dir,'rev-parse','HEAD')};}
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});

describe('verified Worker output and validation',()=>{
  it('rejects incomplete, malformed, and out-of-scope snapshot envelopes',async()=>{
    const {dir,sha}=await fixtureRepo();
    const good={complete:true,base_commit:sha,entries:[{path:'README.md',kind:'file' as const,mode:'100644' as const,size:5,sha256:'b1e0a0a0c82b7b8f42eb30d4ba2dff975d4897285b950047d36c5d5a5f24e8e2',contentBase64:Buffer.from('base\n').toString('base64')}],errors:[]};
    const {createHash}=await import('node:crypto');good.entries[0]!.sha256=createHash('sha256').update('base\n').digest('hex');
    await expect(verifyWorkerSnapshot({repoPath:dir,pinnedBaseCommit:sha,envelope:{...good,complete:false},allowedScope:['README.md']})).rejects.toThrow('incomplete');
    await expect(verifyWorkerSnapshot({repoPath:dir,pinnedBaseCommit:sha,envelope:{...good,entries:[{...good.entries[0]!,contentBase64:'%%%'}]},allowedScope:['README.md']})).rejects.toThrow();
    const outside={...good,entries:[...good.entries,{path:'secret.txt',kind:'file' as const,mode:'100644' as const,size:1,sha256:createHash('sha256').update('x').digest('hex'),contentBase64:Buffer.from('x').toString('base64')}]};
    await expect(verifyWorkerSnapshot({repoPath:dir,pinnedBaseCommit:sha,envelope:outside,allowedScope:['README.md']})).rejects.toThrow('outside the allowed scope');
  });

  it('materializes exact verified bytes and records validation exit, output and failure',async()=>{
    const {dir,sha}=await fixtureRepo();const base=Buffer.from('base\n'),after=Buffer.from('validated\n');
    const {createHash}=await import('node:crypto');
    const evidence=await verifyWorkerSnapshot({repoPath:dir,pinnedBaseCommit:sha,allowedScope:['README.md'],envelope:{complete:true,base_commit:sha,errors:[],entries:[{path:'README.md',kind:'file',mode:'100644',size:after.length,sha256:createHash('sha256').update(after).digest('hex'),contentBase64:after.toString('base64')}]}});
    expect(evidence.reviewDiff).toContain('-base');expect(evidence.reviewDiff).toContain('+validated');
    const materialized=await materializeVerifiedWorkspace(dir,evidence);
    try{expect(await import('node:fs/promises').then(m=>m.readFile(join(materialized.workspacePath,'README.md'),'utf8'))).toBe('validated\n');}
    finally{await materialized.cleanup();}
    const validation=await validateWorkerOutput({repoPath:dir,evidence,commands:[{name:'intentional failure',command:process.execPath,args:['-e',"console.log('observed');process.exit(3)"]}],timeoutMs:5000});
    expect(validation.passed).toBe(false);expect(validation.checks[0]).toMatchObject({exitCode:3,output:'observed\n',timedOut:false});
  });

  it('restricts bridge snapshot fetches to loopback URLs',async()=>{
    await expect(fetchBridgeSnapshot('https://example.com','id','a'.repeat(40))).rejects.toThrow('loopback-only');
  });

  it('bounds validation runtime and output and rejects an escaping snapshot symlink',async()=>{
    const {dir,sha}=await fixtureRepo(),{createHash}=await import('node:crypto'),bytes=Buffer.from('base\n'),target='../escape';
    const evidence=await verifyWorkerSnapshot({repoPath:dir,pinnedBaseCommit:sha,allowedScope:['README.md','escape'],envelope:{complete:true,base_commit:sha,errors:[],entries:[{path:'README.md',kind:'file',mode:'100644',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),contentBase64:bytes.toString('base64')},{path:'escape',kind:'symlink',mode:'120000',size:Buffer.byteLength(target),sha256:createHash('sha256').update(target).digest('hex'),target}]}});
    await expect(materializeVerifiedWorkspace(dir,evidence)).rejects.toThrow('Symlink escapes');
    const validation=await validateWorkerOutput({repoPath:dir,evidence:await verifyWorkerSnapshot({repoPath:dir,pinnedBaseCommit:sha,allowedScope:['README.md'],envelope:{complete:true,base_commit:sha,errors:[],entries:[{path:'README.md',kind:'file',mode:'100644',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),contentBase64:bytes.toString('base64')}]}}),commands:[{name:'timeout',command:process.execPath,args:['-e','setTimeout(() => {}, 1000)']},{name:'output cap',command:process.execPath,args:['-e',"process.stdout.write('x'.repeat(1000))"]}],timeoutMs:100,maxOutputBytes:16});
    expect(validation.passed).toBe(false);expect(validation.checks[0]?.timedOut).toBe(true);expect(validation.checks[1]?.outputTruncated).toBe(true);
  });
});
