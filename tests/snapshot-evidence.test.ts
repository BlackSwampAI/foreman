import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdtemp, readFile, readlink, rm, stat, writeFile, mkdir, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Controller } from '../src/controller.js';
import { snapshotGitCommit } from '../src/git-workspace.js';
import { JsonStore } from '../src/store.js';
import type { SnapshotEntry } from '../src/workspace-snapshot.js';
import { compactSnapshotEvidence, fullSnapshotEntries, materializeVerifiedWorkspace, snapshotDigest, validateWorkerOutput, verifyWorkerSnapshot, type BridgeSnapshotEntry, type VerifiedWorkerWorkspace } from '../src/verified-workspace.js';
import { decisionDigest } from './decision-helper.js';

// Every test builds a repository and rebuilds trees from it; keep them stable when the whole suite runs in parallel.
vi.setConfig({testTimeout:30_000});
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
const git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const SCOPE=['README.md','src/','docs/','bin/'];
const put=async(root:string,rel:string,content:string|Buffer,mode?:number)=>{await mkdir(dirname(join(root,rel)),{recursive:true});await writeFile(join(root,rel),content);if(mode)await chmod(join(root,rel),mode);};

/** A repository with every entry kind the snapshot format supports, plus a large file that no Worker touches. */
async function fixtureRepo(){
  const dir=await mkdtemp(join(tmpdir(),'foreman-snapshot-evidence-'));dirs.push(dir);
  git(dir,'init','-q');git(dir,'config','user.name','Fixture');git(dir,'config','user.email','fixture@example.invalid');
  await put(dir,'README.md','base\n');await put(dir,'src/a.ts','export const a = 1;\n');await put(dir,'src/remove.ts','export const gone = true;\n');await put(dir,'src/old-name.ts','export const moved = 1;\n');
  await put(dir,'bin/run.sh','#!/bin/sh\necho base\n',0o755);await symlink('README.md',join(dir,'link'));
  await put(dir,'big/unchanged.txt',Buffer.alloc(300_000,'u'));await put(dir,'big/binary.bin',Buffer.from([0,255,3,0,9]));
  git(dir,'add','-A');git(dir,'commit','-qm','base');
  return {dir,sha:git(dir,'rev-parse','HEAD')};
}
const bridgeEntry=(entry:SnapshotEntry):BridgeSnapshotEntry=>{const bytes=Buffer.from(entry.contentBase64,'base64'),mode=entry.kind==='symlink'?'120000':entry.executable?'100755':'100644';return {path:entry.path,kind:entry.kind,mode,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),...(entry.kind==='symlink'?{target:bytes.toString('utf8')}:{contentBase64:bytes.toString('base64')})} as BridgeSnapshotEntry;};
const file=(path:string,text:string,executable=false):SnapshotEntry=>({path,kind:'file',contentBase64:Buffer.from(text).toString('base64'),executable});

/** The Worker result: modify + add + delete + rename + an edit that keeps a mode, everything else untouched. */
async function verifiedResult(){
  const {dir,sha}=await fixtureRepo(),base=(await snapshotGitCommit(dir,sha)).entries;
  const result=base.filter(e=>e.path!=='src/remove.ts'&&e.path!=='src/old-name.ts').map(e=>e.path==='README.md'?file('README.md','changed\n'):e.path==='bin/run.sh'?file('bin/run.sh','#!/bin/sh\necho changed\n',true):e);
  result.push(file('docs/new.md','# new\n'),file('src/new-name.ts','export const moved = 1;\n'));
  const verified=await verifyWorkerSnapshot({repoPath:dir,pinnedBaseCommit:sha,allowedScope:SCOPE,envelope:{complete:true,base_commit:sha,errors:[],entries:result.map(bridgeEntry)}});
  return {dir,sha,base,verified,result};
}
const sorted=(entries:readonly SnapshotEntry[])=>[...entries].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);

describe('snapshot digest',()=>{
  it('is canonical: independent of entry order and sensitive to path, mode and bytes',()=>{
    const a=file('a.txt','one\n'),b=file('b.txt','two\n');
    expect(snapshotDigest([a,b])).toBe(snapshotDigest([b,a]));
    expect(snapshotDigest([a,b])).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshotDigest([a])).not.toBe(snapshotDigest([a,b]));
    expect(snapshotDigest([a,b])).not.toBe(snapshotDigest([a,file('b.txt','two\n',true)]));
    expect(snapshotDigest([a,b])).not.toBe(snapshotDigest([a,file('b.txt','twp\n')]));
    expect(snapshotDigest([a,b])).not.toBe(snapshotDigest([a,file('c.txt','two\n')]));
    expect(snapshotDigest([])).toBe(snapshotDigest([]));
  });
});

describe('compact evidence and full snapshot entries',()=>{
  it('drops entries but keeps the exact changes, entry count and digest, and does not grow with unchanged files',async()=>{
    const {verified,result}=await verifiedResult();
    const compact=compactSnapshotEvidence(verified);
    expect(compact).not.toHaveProperty('entries');
    expect(compact.snapshotFormat).toBe('base_plus_changes');
    expect(compact.completeSnapshot).toEqual({reportedComplete:true,reportedErrors:0,entryCount:result.length,snapshotDigest:snapshotDigest(result)});
    expect(compact.changes).toEqual(verified.changes);
    expect(compact.reviewDiff).toBe(verified.reviewDiff);
    expect(new Set(compact.changes.map(c=>c.kind))).toEqual(new Set(['add','modify','delete','rename']));
    // The stored record holds the changed bytes only; the 300 KB unchanged file and every other entry stay in Git.
    expect(JSON.stringify(verified).length).toBeGreaterThan(400_000);
    expect(JSON.stringify(compact).length).toBeLessThan(20_000);
    // The verified in-memory object is not mutated by compaction.
    expect(verified.entries).toHaveLength(result.length);
  });

  it('rebuilds the exact complete tree from the pinned base plus changes for every change kind',async()=>{
    const {dir,verified,result}=await verifiedResult();
    const rebuilt=await fullSnapshotEntries(dir,compactSnapshotEvidence(verified));
    expect(rebuilt).toEqual(sorted(result));
    // The rebuilt tree round-trips through the same verification the bridge path uses.
    const again=await verifyWorkerSnapshot({repoPath:dir,pinnedBaseCommit:verified.pinnedBaseCommit,allowedScope:SCOPE,envelope:{complete:true,base_commit:verified.pinnedBaseCommit,errors:[],entries:rebuilt.map(bridgeEntry)}});
    expect(again.changes).toEqual(verified.changes);
    expect(compactSnapshotEvidence(again).completeSnapshot.snapshotDigest).toBe(compactSnapshotEvidence(verified).completeSnapshot.snapshotDigest);
  });

  it('returns legacy stored entries untouched without consulting Git',async()=>{
    const {verified}=await verifiedResult();
    const legacy:VerifiedWorkerWorkspace={...verified};
    expect(await fullSnapshotEntries('/nonexistent/repository',legacy)).toBe(verified.entries);
    // A legacy record has no format marker; one with neither entries nor a format cannot be reconstructed.
    const {entries:_entries,...bare}=legacy;
    await expect(fullSnapshotEntries('/nonexistent/repository',bare as VerifiedWorkerWorkspace)).rejects.toThrow('neither stored snapshot entries nor a reconstructable snapshot format');
  });

  it('rejects reconstruction that does not match the recorded digest, entry count, base or changes',async()=>{
    const {dir,verified}=await verifiedResult();
    const compact=compactSnapshotEvidence(verified),clone=()=>structuredClone(compact) as VerifiedWorkerWorkspace;
    await expect(fullSnapshotEntries(dir,{...clone(),completeSnapshot:{...compact.completeSnapshot,snapshotDigest:'0'.repeat(64)}})).rejects.toThrow('digest does not match');
    await expect(fullSnapshotEntries(dir,{...clone(),completeSnapshot:{...compact.completeSnapshot,entryCount:compact.completeSnapshot.entryCount+1}})).rejects.toThrow(/has \d+ entries but the evidence recorded \d+/);
    const {snapshotDigest:_digest,...noDigest}=compact.completeSnapshot;
    await expect(fullSnapshotEntries(dir,{...clone(),completeSnapshot:noDigest})).rejects.toThrow('omitted its snapshot entry count or digest');
    await expect(fullSnapshotEntries(dir,{...clone(),snapshotFormat:'v9' as any})).rejects.toThrow('Unknown Worker evidence snapshot format');
    await expect(fullSnapshotEntries(dir,{...clone(),entries:[]})).rejects.toThrow('must not also store snapshot entries');
    // Different after-bytes for a change leave a self-consistent tree that no longer matches the digest.
    const alteredAfter=clone();alteredAfter.changes.find(c=>c.path==='README.md')!.after!.contentBase64=Buffer.from('forged\n').toString('base64');
    await expect(fullSnapshotEntries(dir,alteredAfter)).rejects.toThrow('digest does not match');
    // Different before-bytes no longer match the pinned base.
    const alteredBefore=clone();alteredBefore.changes.find(c=>c.path==='README.md')!.before!.contentBase64=Buffer.from('forged\n').toString('base64');
    await expect(fullSnapshotEntries(dir,alteredBefore)).rejects.toThrow('before bytes do not match pinned base: README.md');
    // Dropping a change changes both the count and the tree.
    const dropped=clone();dropped.changes=dropped.changes.filter(c=>c.kind!=='delete');
    await expect(fullSnapshotEntries(dir,dropped)).rejects.toThrow(/entries but the evidence recorded/);
    // An add that collides with a base path is malformed.
    const collision=clone();collision.changes=[...collision.changes,{kind:'add',path:'src/a.ts',after:file('src/a.ts','x\n')}];
    await expect(fullSnapshotEntries(dir,collision)).rejects.toThrow('add conflicts with the tree at: src/a.ts');
    // The base commit must exist in the repository that is asked to rebuild the tree.
    const other=await fixtureRepo();
    await expect(fullSnapshotEntries(other.dir,{...clone(),pinnedBaseCommit:'1'.repeat(40)})).rejects.toThrow();
  });

  it('materializes and validates compact evidence, and refuses tampered compact evidence',async()=>{
    const {dir,verified,base}=await verifiedResult();
    const compact=compactSnapshotEvidence(verified);
    const workspace=await materializeVerifiedWorkspace(dir,compact);
    try{
      expect(await readFile(join(workspace.workspacePath,'README.md'),'utf8')).toBe('changed\n');
      expect(await readFile(join(workspace.workspacePath,'docs/new.md'),'utf8')).toBe('# new\n');
      expect(await readFile(join(workspace.workspacePath,'src/new-name.ts'),'utf8')).toBe('export const moved = 1;\n');
      await expect(lstat(join(workspace.workspacePath,'src/remove.ts'))).rejects.toMatchObject({code:'ENOENT'});
      await expect(lstat(join(workspace.workspacePath,'src/old-name.ts'))).rejects.toMatchObject({code:'ENOENT'});
      expect((await stat(join(workspace.workspacePath,'big/unchanged.txt'))).size).toBe(300_000);
      expect((await readFile(join(workspace.workspacePath,'big/binary.bin'))).equals(Buffer.from([0,255,3,0,9]))).toBe(true);
      expect((await stat(join(workspace.workspacePath,'bin/run.sh'))).mode&0o111).not.toBe(0);
      expect(await readlink(join(workspace.workspacePath,'link'))).toBe('README.md');
    }finally{await workspace.cleanup();}
    expect(base.length).toBeGreaterThan(5);
    const check=await validateWorkerOutput({repoPath:dir,evidence:compact,commands:[{name:'tree is complete',command:process.execPath,args:['-e',"const fs=require('fs');if(fs.readFileSync('README.md','utf8')!=='changed\\n'||!fs.existsSync('docs/new.md')||fs.statSync('big/unchanged.txt').size!==300000)process.exit(3)"]}],timeoutMs:15000});
    expect(check.passed).toBe(true);
    const forged=structuredClone(compact) as VerifiedWorkerWorkspace;forged.changes.find(c=>c.path==='README.md')!.after!.contentBase64=Buffer.from('forged\n').toString('base64');
    await expect(materializeVerifiedWorkspace(dir,forged)).rejects.toThrow('digest does not match');
    // Full in-memory verified evidence (what the controller validates right after verification) still materializes from its own entries.
    const inMemory=await materializeVerifiedWorkspace(dir,verified);
    try{expect(await readFile(join(inMemory.workspacePath,'README.md'),'utf8')).toBe('changed\n');}finally{await inMemory.cleanup();}
  });
});

/**
 * tests/fixtures/legacy-evidence-state.json was written by the controller as it was BEFORE evidence became base + changes:
 * `workerEvidence.entries` holds the complete tree and `approval.evidenceDigest` binds a digest over that stored record.
 * Run A was approved but not promoted; run B has a Reviewer recommendation and awaits the human decision.
 */
describe('legacy full-entry evidence keeps working unchanged',()=>{
  const fixture=JSON.parse(readFileSync(resolve('tests/fixtures/legacy-evidence-state.json'),'utf8')) as {runs:{'approved-unpromoted':string;'awaiting-decision':string};repoBaseCommit:string;state:any};
  async function open(){
    const dir=await mkdtemp(join(tmpdir(),'foreman-legacy-evidence-'));dirs.push(dir);
    const repoPath=join(dir,'repo');execFileSync('git',['clone','--quiet',resolve('tests/fixtures/recorded-worker-base.bundle'),repoPath],{stdio:'pipe'});
    await writeFile(join(dir,'state.json'),JSON.stringify(fixture.state));
    const store=new JsonStore(join(dir,'state.json')),controller=new Controller(store,{submit:async()=>{throw new Error('legacy evidence handling must not call a model');},cancel:async()=>({status:'cancelled'})});
    controller.configureVerifiedWorkspace({repoPath,allowedScope:['README.md'],commands:[{name:'legacy fixture check',command:'true',args:[]}]});
    const run=async(id:string)=>(await store.load()).projects.flatMap(p=>p.tasks.flatMap(t=>t.runs)).find(r=>r.id===id)!;
    return {dir,repoPath,store,controller,run};
  }
  const expectedReadme=(evidence:any)=>Buffer.from(evidence.changes.find((c:any)=>c.path==='README.md').after.contentBase64,'base64').toString('utf8');

  it('is genuinely in the legacy shape: full entries, no format marker, no snapshot digest',async()=>{
    const {run}=await open();
    for(const id of [fixture.runs['approved-unpromoted'],fixture.runs['awaiting-decision']]){
      const evidence=(await run(id)).workerEvidence as any;
      expect(evidence.entries).toHaveLength(4);expect(evidence.snapshotFormat).toBeUndefined();expect(evidence.completeSnapshot).toEqual({reportedComplete:true,reportedErrors:0,entryCount:4});
      expect(await fullSnapshotEntries('/nonexistent/repository',evidence)).toBe(evidence.entries);
    }
  });

  it('promotes an approved-but-unpromoted legacy run whose approval digest was bound over stored entries',async()=>{
    const {repoPath,run,controller}=await open(),id=fixture.runs['approved-unpromoted'];
    const before=await run(id);
    expect(before.approval).toMatchObject({approved:true,decision:'approved'});expect(before.promotion).toMatchObject({status:'not_started',evidenceDigest:before.approval!.evidenceDigest});
    const promoted:any=await controller.promoteRun(id,{destinationBranch:'foreman/results/legacy-approved'});
    expect(promoted.promotion).toMatchObject({status:'applied',destinationBranch:'foreman/results/legacy-approved',evidenceDigest:before.approval!.evidenceDigest});
    expect(git(repoPath,'rev-list','--parents','-n','1',promoted.promotion.resultCommit)).toBe(`${promoted.promotion.resultCommit} ${fixture.repoBaseCommit}`);
    expect(execFileSync('git',['-C',repoPath,'show',`${promoted.promotion.resultCommit}:README.md`],{encoding:'utf8'})).toBe(expectedReadme(before.workerEvidence));
    const after=await run(id);
    // Stored legacy evidence and the immutable approval are never rewritten by promotion.
    expect(after.workerEvidence).toEqual(before.workerEvidence);expect(after.approval).toEqual(before.approval);expect((after.workerEvidence as any).entries).toHaveLength(4);
  });

  it('still approves a legacy run and then promotes it, binding digests over the stored entries at both points',async()=>{
    const {repoPath,run,controller}=await open(),id=fixture.runs['awaiting-decision'];
    const before=await run(id);expect(before.approval).toBeUndefined();
    const reviewed=await decisionDigest(controller,id);
    const approval:any=await controller.approveRun(id,{approved:true,evidenceDigest:reviewed,rationale:'Accepted the verified legacy result after inspecting its simulated review.'});
    expect(approval).toMatchObject({approved:true,decision:'approved',evidenceDigest:reviewed});
    const promoted:any=await controller.promoteRun(id,{destinationBranch:'foreman/results/legacy-pending'});
    expect(promoted.promotion).toMatchObject({status:'applied',evidenceDigest:approval.evidenceDigest});
    expect(execFileSync('git',['-C',repoPath,'show',`${promoted.promotion.resultCommit}:README.md`],{encoding:'utf8'})).toBe(expectedReadme(before.workerEvidence));
    const after=await run(id),{acceptance:acceptedAfter,...evidenceAfter}=after.workerEvidence as any,{acceptance:_before,...evidenceBefore}=before.workerEvidence as any;
    expect(acceptedAfter).toBe('accepted');expect(evidenceAfter).toEqual(evidenceBefore);expect(evidenceAfter.entries).toHaveLength(4);
  });

  it('still binds the stored entries: changing a legacy entry after approval blocks promotion',async()=>{
    const {store,run,controller,repoPath}=await open(),id=fixture.runs['approved-unpromoted'];
    await store.mutate(s=>{const evidence=s.projects.flatMap(p=>p.tasks.flatMap(t=>t.runs)).find(r=>r.id===id)!.workerEvidence!;evidence.entries![0]!.contentBase64=Buffer.from('tampered\n').toString('base64');});
    await expect(controller.promoteRun(id,{destinationBranch:'foreman/results/legacy-tamper'})).rejects.toThrow('Approval evidence binding no longer matches stored evidence');
    expect((await run(id)).promotion).toMatchObject({status:'not_started'});
    expect(()=>git(repoPath,'show-ref','--verify','refs/heads/foreman/results/legacy-tamper')).toThrow();
  });
});
