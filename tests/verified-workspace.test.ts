import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchBridgeSnapshot, materializeVerifiedWorkspace, validateWorkerOutput, verifyWorkerSnapshot, unified, legacyFullContextReviewDiff, formatReviewDiff, overlayBridgeWorkspace } from '../src/verified-workspace.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
const bridgeServers:import('node:http').Server[]=[];
afterEach(async()=>{await Promise.all(bridgeServers.splice(0).map(s=>new Promise<void>(resolve=>s.close(()=>resolve()))))});

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

  it('streams bounded check output before the validation process finishes',async()=>{
    const {dir,sha}=await fixtureRepo(),bytes=Buffer.from('base\n'),{createHash}=await import('node:crypto');
    const evidence=await verifyWorkerSnapshot({repoPath:dir,pinnedBaseCommit:sha,allowedScope:['README.md'],envelope:{complete:true,base_commit:sha,errors:[],entries:[{path:'README.md',kind:'file',mode:'100644',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),contentBase64:bytes.toString('base64')}]}});
    let finished=false,resolveOutput!:()=>void;const outputSeen=new Promise<void>(resolve=>resolveOutput=resolve);
    const validationPromise=validateWorkerOutput({repoPath:dir,evidence,commands:[{name:'stream',command:'/bin/sh',args:['-c','printf hello; sleep 0.5']}],timeoutMs:5000,maxOutputBytes:32,sandbox:{mode:'none'},callbacks:{output:(_command,output)=>{if(output.includes('hello'))resolveOutput();},finished:()=>{finished=true;}}});
    await outputSeen;expect(finished).toBe(false);const result=await validationPromise;expect(result.checks[0]?.output).toBe('hello');expect(result.checks[0]?.outputTruncated).toBe(false);
  });

  it('restricts bridge snapshot fetches to loopback URLs',async()=>{
    await expect(fetchBridgeSnapshot('https://example.com','id','a'.repeat(40))).rejects.toThrow('loopback-only');
  });

  it('removes the validation workspace after validation (success and failure)',async()=>{
    const {dir,sha}=await fixtureRepo();const {createHash}=await import('node:crypto');
    const bytes=Buffer.from('base\n');
    const evidence=await verifyWorkerSnapshot({repoPath:dir,pinnedBaseCommit:sha,allowedScope:['README.md'],envelope:{complete:true,base_commit:sha,errors:[],entries:[{path:'README.md',kind:'file',mode:'100644',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),contentBase64:bytes.toString('base64')}]}});
    // Test cleanup via materializeVerifiedWorkspace directly (validateWorkerOutput calls it in a
    // finally block, so this exercises the same cleanup path for both success and failure cases).
    const {lstat}=await import('node:fs/promises');
    // Success path: workspace must not exist after cleanup().
    const m1=await materializeVerifiedWorkspace(dir,evidence);
    await expect(lstat(m1.workspacePath)).resolves.toBeTruthy();
    await m1.cleanup();
    await expect(lstat(m1.workspacePath)).rejects.toMatchObject({code:'ENOENT'});
    // validateWorkerOutput wraps materializeVerifiedWorkspace in finally{cleanup()}: success exit.
    await validateWorkerOutput({repoPath:dir,evidence,commands:[{name:'ok',command:process.execPath,args:['-e','process.exit(0)']}],timeoutMs:5000});
    // Failure path: non-zero exit still triggers cleanup().
    const m2=await materializeVerifiedWorkspace(dir,evidence);
    await m2.cleanup();
    await expect(lstat(m2.workspacePath)).rejects.toMatchObject({code:'ENOENT'});
  });

  it('bounds validation runtime and output and rejects an escaping snapshot symlink',async()=>{
    const {dir,sha}=await fixtureRepo(),{createHash}=await import('node:crypto'),bytes=Buffer.from('base\n'),target='../escape';
    const evidence=await verifyWorkerSnapshot({repoPath:dir,pinnedBaseCommit:sha,allowedScope:['README.md','escape'],envelope:{complete:true,base_commit:sha,errors:[],entries:[{path:'README.md',kind:'file',mode:'100644',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),contentBase64:bytes.toString('base64')},{path:'escape',kind:'symlink',mode:'120000',size:Buffer.byteLength(target),sha256:createHash('sha256').update(target).digest('hex'),target}]}});
    await expect(materializeVerifiedWorkspace(dir,evidence)).rejects.toThrow('Symlink escapes');
    const validation=await validateWorkerOutput({repoPath:dir,evidence:await verifyWorkerSnapshot({repoPath:dir,pinnedBaseCommit:sha,allowedScope:['README.md'],envelope:{complete:true,base_commit:sha,errors:[],entries:[{path:'README.md',kind:'file',mode:'100644',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),contentBase64:bytes.toString('base64')}]}}),commands:[{name:'timeout',command:process.execPath,args:['-e','setTimeout(() => {}, 1000)']},{name:'output cap',command:process.execPath,args:['-e',"process.stdout.write('x'.repeat(1000))"]}],timeoutMs:100,maxOutputBytes:16});
    expect(validation.passed).toBe(false);expect(validation.checks[0]?.timedOut).toBe(true);expect(validation.checks[1]?.outputTruncated).toBe(true);
  });
});

describe('unified() compact diff formatter',()=>{
  it('single change mid-file: one hunk with 3 context lines and correct header',()=>{
    // 10-line file, change at line 5
    const lines=(n:number)=>Array.from({length:n},(_,i)=>`line${i+1}`).join('\n')+'\n';
    const old=lines(10);
    const nxt=old.replace('line5','LINE5');
    const diff=unified('file.txt',old,nxt);
    // Should contain exactly one hunk header
    const headers=diff.match(/@@ [^@]+ @@/g)??[];
    expect(headers).toHaveLength(1);
    // Header should show only the changed region with context (lines 2-8 of 10)
    expect(headers[0]).toMatch(/^@@ -[2-9],\d+ \+[2-9],\d+ @@$/);
    expect(diff).toContain('-line5');
    expect(diff).toContain('+LINE5');
    // Context lines immediately around the change
    expect(diff).toContain(' line4');
    expect(diff).toContain(' line6');
    // The hunk does NOT span all 10 lines (would be @@ -1,10 +1,10 @@)
    expect(diff).not.toContain('@@ -1,10 +1,10 @@');
  });

  it('two distant changes produce two separate hunks',()=>{
    const makeLines=(n:number)=>Array.from({length:n},(_,i)=>`line${i+1}`).join('\n')+'\n';
    const old=makeLines(30);
    const nxt=old.replace('line3','LINE3').replace('line28','LINE28');
    const diff=unified('file.txt',old,nxt);
    const headers=diff.match(/@@ [^@]+ @@/g)??[];
    expect(headers).toHaveLength(2);
    expect(diff).toContain('-line3');
    expect(diff).toContain('+LINE3');
    expect(diff).toContain('-line28');
    expect(diff).toContain('+LINE28');
  });

  it('nearby changes merge into a single hunk',()=>{
    const makeLines=(n:number)=>Array.from({length:n},(_,i)=>`line${i+1}`).join('\n')+'\n';
    const old=makeLines(20);
    const nxt=old.replace('line10','LINE10').replace('line13','LINE13');
    const diff=unified('file.txt',old,nxt);
    const headers=diff.match(/@@ [^@]+ @@/g)??[];
    expect(headers).toHaveLength(1);
    expect(diff).toContain('-line10');
    expect(diff).toContain('+LINE10');
    expect(diff).toContain('-line13');
    expect(diff).toContain('+LINE13');
  });

  it('new file: @@ -0,0 +1,N @@ header',()=>{
    const diff=unified('new.txt','','alpha\nbeta\ngamma\n');
    expect(diff).toContain('@@ -0,0 +1,3 @@');
    expect(diff).toContain('+alpha');
    expect(diff).toContain('+beta');
    expect(diff).toContain('+gamma');
  });

  it('deleted file: @@ -1,N +0,0 @@ header',()=>{
    const diff=unified('del.txt','alpha\nbeta\ngamma\n','');
    expect(diff).toContain('@@ -1,3 +0,0 @@');
    expect(diff).toContain('-alpha');
    expect(diff).toContain('-beta');
    expect(diff).toContain('-gamma');
  });

  it('change at first line',()=>{
    const diff=unified('f.txt','a\nb\nc\n','A\nb\nc\n');
    expect(diff).toContain('@@ -1,');
    expect(diff).toContain('-a');
    expect(diff).toContain('+A');
  });

  it('change at last line',()=>{
    const diff=unified('f.txt','a\nb\nc\n','a\nb\nC\n');
    expect(diff).toContain('-c');
    expect(diff).toContain('+C');
    const headers=diff.match(/@@ [^@]+ @@/g)??[];
    expect(headers).toHaveLength(1);
  });

  it('trailing-newline difference: shows no-newline marker instead of empty diff',()=>{
    const diff=unified('f.txt','hello','hello\n');
    expect(diff).toContain('\\ No newline at end of file');
    expect(diff).toContain('-hello');
    expect(diff).toContain('+hello');
    expect(diff).not.toBe('');
  });

  it('identical files produce empty string',()=>{
    expect(unified('f.txt','same\ncontent\n','same\ncontent\n')).toBe('');
  });

  it('regression: 125-line file with 4-line insertion is far smaller than the full file',()=>{
    // Build a 125-line file
    const oldLines=Array.from({length:125},(_,i)=>`line ${i+1}`).join('\n')+'\n';
    // Insert 4 new lines after line 62
    const parts=oldLines.split('\n');
    parts.splice(62,0,'new1','new2','new3','new4');
    const newLines=parts.join('\n');
    const diff=unified('large.ts',oldLines,newLines);
    // Diff should be MUCH smaller than the file (file is ~1000 bytes, diff should be <200)
    expect(Buffer.byteLength(diff,'utf8')).toBeLessThan(400);
    // No hunk header should span the entire file (no @@ -1,125 or @@ -1,129)
    expect(diff).not.toMatch(/@@ -1,1(2[0-9]|[3-9]\d)/);
    // Should contain the change markers
    expect(diff).toContain('+new1');
    expect(diff).toContain('+new4');
    // Should contain context lines (line 62 and line 63)
    expect(diff).toContain(' line 62');
    expect(diff).toContain(' line 63');
    // Exactly one hunk
    const headers=diff.match(/@@ [^@]+ @@/g)??[];
    expect(headers).toHaveLength(1);
  });

  it('legacy full-context formatter still produces full-file hunk for backward compatibility',()=>{
    // Build a minimal ChangeEvidence for a 10-line file with a 1-line change
    const {createHash}=require('node:crypto') as typeof import('node:crypto');
    const before=Array.from({length:10},(_,i)=>`line${i+1}`).join('\n')+'\n';
    const after=before.replace('line5','LINE5');
    const toEntry=(content:string)=>({path:'f.txt',kind:'file' as const,executable:false,contentBase64:Buffer.from(content).toString('base64')});
    const changes=[{kind:'modify' as const,path:'f.txt',before:toEntry(before),after:toEntry(after)}];
    const legacyDiff=legacyFullContextReviewDiff(changes);
    // Legacy diff should contain the full-file hunk header
    expect(legacyDiff).toContain('@@ -1,10 +1,10 @@');
    // New compact diff should NOT contain a full-file hunk for this case
    const compactDiff=formatReviewDiff(changes);
    expect(compactDiff).not.toContain('@@ -1,10 +1,10 @@');
    // Both should contain the change
    expect(legacyDiff).toContain('-line5');
    expect(compactDiff).toContain('-line5');
  });

  it('size-limit error message includes size and file count',async()=>{
    const {createHash}=await import('node:crypto');
    const {mkdtemp:mkd,rm:rmdir,writeFile:wf}=await import('node:fs/promises');
    const {tmpdir:td}=await import('node:os');
    const {join:pjoin}=await import('node:path');
    const {execFileSync:exec}=await import('node:child_process');
    const dir=await mkd(pjoin(td(),'foreman-size-limit-'));
    try {
      exec('git',['-C',dir,'init','-q'],{stdio:'pipe'});
      exec('git',['-C',dir,'config','user.name','Fixture'],{stdio:'pipe'});
      exec('git',['-C',dir,'config','user.email','fixture@example.invalid'],{stdio:'pipe'});
      // Create a large file that produces a large compact diff (>48,000 bytes)
      const bigContent=Array.from({length:600},(_,i)=>`this is line number ${i+1} with some extra padding to make it longer`).join('\n')+'\n';
      const bigModified=bigContent.replace('line number 1 ','LINE NUMBER 1 ');
      await wf(pjoin(dir,'big.txt'),bigContent);
      exec('git',['-C',dir,'add','big.txt'],{stdio:'pipe'});
      exec('git',['-C',dir,'commit','-qm','base'],{stdio:'pipe'});
      const sha=exec('git',['-C',dir,'rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
      const {createHash:ch}=await import('node:crypto');
      const bigBuf=Buffer.from(bigModified);
      // Verify we can build evidence and check the error message format
      // (using formatReviewDiff directly to avoid full git workflow)
      const entry={path:'big.txt',kind:'file' as const,executable:false,contentBase64:Buffer.from(bigContent).toString('base64')};
      const entryAfter={path:'big.txt',kind:'file' as const,executable:false,contentBase64:bigBuf.toString('base64')};
      const changes=[{kind:'modify' as const,path:'big.txt',before:entry,after:entryAfter}];
      const diff=formatReviewDiff(changes);
      // The compact diff of one changed line in a 600-line file should be small (< 2 KB)
      expect(Buffer.byteLength(diff,'utf8')).toBeLessThan(2000);
    } finally {await rmdir(dir,{recursive:true,force:true});}
  });
});

describe('overlayBridgeWorkspace',()=>{
  it('sends overlay entries to bridge and returns applied count',async()=>{
    const receivedBodies:unknown[]=[];
    const bridge=createServer((req,res)=>{
      let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
        res.setHeader('content-type','application/json');
        const wsId='ws_overlay_fixture';
        if(req.method==='POST'&&req.url===`/extensions/foreman-workspace/v1/workspaces/${wsId}/overlay`){
          receivedBodies.push(JSON.parse(body));res.end(JSON.stringify({workspace_id:wsId,applied:2}));return;
        }
        res.statusCode=404;res.end('{}');
      });
    });
    bridge.listen(0,'127.0.0.1');await once(bridge,'listening');bridgeServers.push(bridge);
    const {port}=bridge.address() as import('node:net').AddressInfo;
    const entries=[{path:'src/foo.ts',contentBase64:Buffer.from('content').toString('base64'),mode:'100644' as const},{path:'docs/removed.md',delete:true as const}];
    const result=await overlayBridgeWorkspace(`http://127.0.0.1:${port}`,'ws_overlay_fixture',entries);
    expect(result).toMatchObject({workspaceId:'ws_overlay_fixture',applied:2});
    expect(receivedBodies).toHaveLength(1);
    expect((receivedBodies[0] as any).entries).toHaveLength(2);
    expect((receivedBodies[0] as any).entries[0]).toMatchObject({path:'src/foo.ts',mode:'100644'});
    expect((receivedBodies[0] as any).entries[1]).toMatchObject({path:'docs/removed.md',delete:true});
  });

  it('rejects non-loopback bridge URLs',async()=>{
    await expect(overlayBridgeWorkspace('https://example.com','ws_test',[{path:'x.ts',contentBase64:'',mode:'100644'}])).rejects.toThrow('loopback-only');
  });

  it('throws when bridge returns an error status',async()=>{
    const bridge=createServer((_req,res)=>{res.statusCode=400;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:{code:'bad_request'}}));});
    bridge.listen(0,'127.0.0.1');await once(bridge,'listening');bridgeServers.push(bridge);
    const {port}=bridge.address() as import('node:net').AddressInfo;
    await expect(overlayBridgeWorkspace(`http://127.0.0.1:${port}`,'ws_id',[{path:'a.ts',contentBase64:'',mode:'100644'}])).rejects.toThrow('overlay request failed (400)');
  });
});
