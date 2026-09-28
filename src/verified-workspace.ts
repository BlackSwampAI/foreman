import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile, chmod, lstat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { verifyGitSnapshotScope } from './git-workspace.js';
import { assertBwrapUsable, buildSandboxArgs, defaultNetworkAccess, ensureSandboxCache, type ValidationSandboxConfig } from './validation-sandbox.js';
import type { SnapshotChange, SnapshotEntry } from './workspace-snapshot.js';

export interface BridgeSnapshotEntry { path: string; kind: 'file'|'symlink'; mode: '100644'|'100755'|'120000'; size: number; sha256: string; contentBase64?: string; target?: string }
export interface BridgeSnapshotEnvelope { complete: boolean; base_commit: string; entries: BridgeSnapshotEntry[]; errors: unknown[] }
export interface ChangeEvidence { kind: SnapshotChange['kind']; path: string; previousPath?: string; before?: SnapshotEntry; after?: SnapshotEntry }
export interface VerifiedWorkerWorkspace {
  provenance: 'bridge_snapshot'|'recorded_replay'; pinnedBaseCommit: string; completeSnapshot: { reportedComplete: true; reportedErrors: 0; entryCount: number };
  scopeVerified: true; allowedScope: string[]; entries: SnapshotEntry[]; changes: ChangeEvidence[]; reviewDiff: string;
}
export interface ValidationCommand { name: string; command: string; args: string[]; cwd?: string; /** Keep the host network for this command. Unset means a recognised package-manager install gets it and everything else runs offline (`defaultNetworkAccess`); an explicit boolean always wins. */ network?: boolean }
export interface ValidationObservation { name: string; command: string; args: string[]; exitCode: number|null; signal?: string; timedOut: boolean; output: string; outputTruncated: boolean; startedAt: string; finishedAt: string; sandbox: 'bwrap'|'none'; /** True when the command could reach the network: it asked for it, or nothing isolated it (sandbox none). */ network: boolean }
export interface ControllerValidationEvidence { passed: boolean; checks: ValidationObservation[] }
const SHA=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

/** Fetch a bridge snapshot from an explicitly loopback-only bridge endpoint. */
export async function fetchBridgeSnapshot(baseUrl:string,workspaceId:string,expectedBase:string,timeoutMs=15_000,maxResponseBytes=300*1024*1024):Promise<BridgeSnapshotEnvelope>{
  const base=new URL(baseUrl);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!['localhost','127.0.0.1','[::1]','::1'].includes(base.hostname)) throw new Error('Workspace bridge URL must be loopback-only and contain no credentials, query, or fragment');
  if(!workspaceId||workspaceId.includes('/')||workspaceId.includes('\\'))throw new Error('Invalid bridge workspace ID');
  const endpoint=new URL(`/extensions/foreman-workspace/v1/workspaces/${encodeURIComponent(workspaceId)}/snapshot`,base);
  const response=await fetch(endpoint,{signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok)throw new Error(`Workspace bridge snapshot request failed (${response.status})`);
  const declared=Number(response.headers.get('content-length')??0);if(declared>maxResponseBytes)throw new Error('Workspace bridge response exceeds size limit');
  if(!response.body)throw new Error('Workspace bridge response has no body');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxResponseBytes){await reader.cancel();throw new Error('Workspace bridge response exceeds size limit');}chunks.push(value);}
  let parsed:unknown;try{parsed=JSON.parse(Buffer.concat(chunks.map(x=>Buffer.from(x))).toString('utf8'));}catch{throw new Error('Workspace bridge returned malformed JSON');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Workspace bridge snapshot must be an object');
  const envelope=parsed as BridgeSnapshotEnvelope;
  if(envelope.base_commit?.toLowerCase()!==expectedBase.toLowerCase())throw new Error('Bridge snapshot base commit does not match the pinned base');
  return envelope;
}

export interface OverlayEntry { path: string; contentBase64?: string; mode?: string; delete?: true }

export async function overlayBridgeWorkspace(baseUrl:string,workspaceId:string,entries:OverlayEntry[],timeoutMs=15_000):Promise<{workspaceId:string;applied:number}>{
  if(!workspaceId||workspaceId.includes('/')||workspaceId.includes('\\'))throw new Error('Invalid bridge workspace ID');
  const endpoint=bridgeEndpoint(baseUrl,`/extensions/foreman-workspace/v1/workspaces/${encodeURIComponent(workspaceId)}/overlay`);
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entries}),signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok)throw new Error(`Workspace bridge overlay request failed (${response.status})`);
  const body=await boundedJson(response,64*1024) as Record<string,unknown>;
  if(typeof body.workspace_id!=='string'||typeof body.applied!=='number')throw new Error('Workspace bridge returned an invalid overlay result');
  return {workspaceId:body.workspace_id,applied:body.applied};
}
export async function seedBridgeWorkspace(baseUrl:string,pinnedBaseCommit:string,timeoutMs=15_000):Promise<{workspaceId:string;baseCommit:string}>{
  if(!SHA.test(pinnedBaseCommit))throw new Error('A full pinned base commit SHA is required');
  const advertisedResponse=await fetch(bridgeEndpoint(baseUrl,'/v1/uhp'),{signal:AbortSignal.timeout(timeoutMs)});
  if(!advertisedResponse.ok)throw new Error(`Workspace bridge discovery failed (${advertisedResponse.status})`);
  const advertised=await boundedJson(advertisedResponse,64*1024) as any;
  const capability=advertised?.capabilities?.extensions?.foreman_workspace_bridge_v1;
  if(capability?.version!==1||capability.seed!==true||capability.complete_snapshot!==true||capability.execution_boundary!=='bubblewrap')throw new Error('Bridge does not advertise the complete snapshot and bubblewrap workspace extension');
  const endpoint=bridgeEndpoint(baseUrl,'/extensions/foreman-workspace/v1/workspaces');
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({base_commit:pinnedBaseCommit}),signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok)throw new Error(`Workspace bridge seed request failed (${response.status})`);
  const body=await boundedJson(response,64*1024) as Record<string,unknown>;
  if(typeof body.workspace_id!=='string'||typeof body.base_commit!=='string'||body.base_commit.toLowerCase()!==pinnedBaseCommit.toLowerCase())throw new Error('Workspace bridge returned an invalid seed result');
  return {workspaceId:body.workspace_id,baseCommit:body.base_commit};
}
function bridgeEndpoint(baseUrl:string,path:string):URL{const base=new URL(baseUrl);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!['localhost','127.0.0.1','[::1]','::1'].includes(base.hostname))throw new Error('Workspace bridge URL must be loopback-only and contain no credentials, query, or fragment');return new URL(path,base);}
async function boundedJson(response:Response,maxBytes:number):Promise<unknown>{const declared=Number(response.headers.get('content-length')??0);if(declared>maxBytes)throw new Error('Workspace bridge response exceeds size limit');if(!response.body)throw new Error('Workspace bridge response has no body');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();throw new Error('Workspace bridge response exceeds size limit');}chunks.push(value);}try{return JSON.parse(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk))).toString('utf8'));}catch{throw new Error('Workspace bridge returned malformed JSON');}}

/** Validate transport claims, then independently compare its full manifest to pinned Git. */
export async function verifyWorkerSnapshot(input:{repoPath:string;pinnedBaseCommit:string;envelope:BridgeSnapshotEnvelope;allowedScope:readonly string[]}):Promise<VerifiedWorkerWorkspace>{
  const { envelope }=input;
  if(!SHA.test(input.pinnedBaseCommit)) throw new Error('A full pinned base commit SHA is required');
  if(!envelope||typeof envelope!=='object'||envelope.complete!==true) throw new Error('Bridge workspace snapshot is incomplete');
  if(typeof envelope.base_commit!=='string'||envelope.base_commit.toLowerCase()!==input.pinnedBaseCommit.toLowerCase()) throw new Error('Bridge snapshot base commit does not match the pinned base');
  if(!Array.isArray(envelope.errors)||envelope.errors.length!==0) throw new Error('Bridge workspace snapshot contains errors or omitted its error list');
  if(!Array.isArray(envelope.entries)||envelope.entries.length>100_000) throw new Error('Bridge workspace snapshot omitted entries or exceeded entry limits');
  let total=0;
  const entries=envelope.entries.map((item)=>{
    if(!item||typeof item.path!=='string'||!Number.isSafeInteger(item.size)||item.size<0||item.size>16*1024*1024||typeof item.sha256!=='string'||! /^[a-f0-9]{64}$/i.test(item.sha256)) throw new Error('Malformed bridge snapshot entry');
    const kind=item.kind; let mode=item.mode,bytes:Buffer;
    if(kind==='file'&&(mode==='100644'||mode==='100755')&&typeof item.contentBase64==='string'){
      if(Buffer.from(item.contentBase64,'base64').toString('base64')!==item.contentBase64) throw new Error(`Non-canonical base64 bytes: ${item.path}`);
      bytes=Buffer.from(item.contentBase64,'base64');
    } else if(kind==='symlink'&&mode==='120000'&&typeof item.target==='string'&&item.target.length){ bytes=Buffer.from(item.target,'utf8'); }
    else throw new Error(`Malformed bridge snapshot entry: ${item.path}`);
    total+=bytes.length;
    if(total>256*1024*1024||bytes.length!==item.size||createHash('sha256').update(bytes).digest('hex')!==item.sha256.toLowerCase()) throw new Error(`Bridge snapshot size or hash mismatch: ${item.path}`);
    if(kind==='symlink'&&bytes.toString('utf8')!==item.target) throw new Error(`Invalid UTF-8 symlink target: ${item.path}`);
    return {path:item.path,kind,executable:kind==='file'&&mode==='100755',contentBase64:bytes.toString('base64')} as SnapshotEntry;
  });
  const verified=await verifyGitSnapshotScope(input.repoPath,input.pinnedBaseCommit,entries,input.allowedScope);
  const changes=verified.changes.map(c=>({kind:c.kind,path:c.path,...(c.previousPath?{previousPath:c.previousPath}:{}),...(c.before?{before:c.before}:{}),...(c.after?{after:c.after}:{})}));
  return {provenance:'bridge_snapshot',pinnedBaseCommit:verified.commit,completeSnapshot:{reportedComplete:true,reportedErrors:0,entryCount:entries.length},scopeVerified:true,allowedScope:verified.allowedScope,entries,changes,reviewDiff:formatReviewDiff(changes)};
}

/** Reconstruct fixture evidence atop the pinned base and verify the resulting full tree. */
export async function reconstructRecordedSnapshot(input:{repoPath:string;pinnedBaseCommit:string;recordedEvidence:{baseCommit?:string;scopeVerified?:boolean;completeSnapshot?:{reportedComplete?:boolean;reportedErrors?:number;entryCount?:number};reviewDiff?:string;changes?:Array<Record<string,any>>};allowedScope:readonly string[]}):Promise<VerifiedWorkerWorkspace>{
  if(!Array.isArray(input.recordedEvidence?.changes)) throw new Error('Recorded replay requires exact change evidence');
  if(input.recordedEvidence.baseCommit?.toLowerCase()!==input.pinnedBaseCommit.toLowerCase()||input.recordedEvidence.scopeVerified!==true||input.recordedEvidence.completeSnapshot?.reportedComplete!==true||input.recordedEvidence.completeSnapshot.reportedErrors!==0) throw new Error('Recorded evidence provenance or completeness does not match the pinned base');
  const base=await import('./git-workspace.js').then(m=>m.snapshotGitCommit(input.repoPath,input.pinnedBaseCommit));
  const result=new Map(base.entries.map(e=>[e.path,e]));
  for(const change of input.recordedEvidence.changes){
    const before=change.before?{...fromRecordedEntry(change.before),path:change.kind==='rename'?String(change.previousPath):change.path}:undefined,after=change.after?{...fromRecordedEntry(change.after),path:change.path}:undefined;
    const actual=change.kind==='add'?undefined:result.get(change.kind==='rename'?String(change.previousPath):change.path);
    if((actual===undefined)!==(before===undefined)||(actual&&before&&!sameEntry(actual,before)))throw new Error(`Recorded before bytes do not match pinned base: ${change.path}`);
    if(change.kind==='add'||change.kind==='modify'){if(!after)throw new Error('Recorded change omitted after bytes');result.set(change.path,after);}
    else if(change.kind==='delete'){result.delete(change.path);}
    else if(change.kind==='rename'){if(!change.previousPath||!after)throw new Error('Recorded rename is incomplete');result.delete(change.previousPath);result.set(change.path,after);}
    else throw new Error('Unknown recorded change kind');
  }
  const verified=await verifyGitSnapshotScope(input.repoPath,input.pinnedBaseCommit,[...result.values()],input.allowedScope);
  const changes=verified.changes.map(c=>({kind:c.kind,path:c.path,...(c.previousPath?{previousPath:c.previousPath}:{}),...(c.before?{before:c.before}:{}),...(c.after?{after:c.after}:{})}));
  const reviewDiff=formatReviewDiff(changes);
  if(input.recordedEvidence.completeSnapshot.entryCount!==undefined&&input.recordedEvidence.completeSnapshot.entryCount!==result.size)throw new Error('Recorded snapshot entry count does not match reconstructed result');
  if(input.recordedEvidence.reviewDiff!==undefined&&input.recordedEvidence.reviewDiff!==reviewDiff&&input.recordedEvidence.reviewDiff!==legacyFullContextReviewDiff(changes))throw new Error('Recorded review diff does not match reconstructed bytes');
  return {provenance:'recorded_replay',pinnedBaseCommit:verified.commit,completeSnapshot:{reportedComplete:true,reportedErrors:0,entryCount:result.size},scopeVerified:true,allowedScope:verified.allowedScope,entries:[...result.values()],changes,reviewDiff};
}

export async function materializeVerifiedWorkspace(repoPath:string,evidence:VerifiedWorkerWorkspace):Promise<{workspacePath:string;cleanup:()=>Promise<void>}>{
  if(evidence.scopeVerified!==true||!evidence.completeSnapshot.reportedComplete||evidence.completeSnapshot.reportedErrors!==0) throw new Error('Workspace evidence is not complete and scope-verified');
  const checked=await verifyGitSnapshotScope(repoPath,evidence.pinnedBaseCommit,evidence.entries,evidence.allowedScope);
  if(!checked.scopeVerified||JSON.stringify(checked.changes)!==JSON.stringify(evidence.changes.map(change=>({kind:change.kind,path:change.path,...(change.previousPath?{previousPath:change.previousPath}:{}),...(change.before?{before:change.before}:{}),...(change.after?{after:change.after}:{})})))) throw new Error('Workspace evidence no longer matches its pinned base');
  const root=await mkdtemp(join(tmpdir(),'foreman-validation-'));
  try {
    const byPath=new Map(evidence.entries.map(entry=>[entry.path,entry]));
    for(const entry of evidence.entries){
      const parts=entry.path.split('/');
      for(let i=1;i<parts.length;i++){const parent=byPath.get(parts.slice(0,i).join('/'));if(parent?.kind==='symlink')throw new Error(`Snapshot has a symlink path conflict: ${entry.path}`);}
      if(entry.kind==='symlink'){
        const target=Buffer.from(entry.contentBase64,'base64').toString('utf8');
        if(isAbsolute(target)||target.includes('\\')||target.includes('\0'))throw new Error(`Unsafe symlink target: ${entry.path}`);
        const resolved=resolve(dirname(resolve(root,entry.path)),target);if(resolved!==root&&!resolved.startsWith(root+sep))throw new Error(`Symlink escapes disposable workspace: ${entry.path}`);
        const relative=resolved.slice(root.length+1);let prefix='';for(const part of relative.split(sep)){if(!part)continue;prefix=prefix?`${prefix}/${part}`:part;if(byPath.get(prefix)?.kind==='symlink')throw new Error(`Symlink target crosses another symlink: ${entry.path}`);}
      }
    }
    for(const entry of evidence.entries){
      const full=resolve(root,entry.path);if(!full.startsWith(root+sep))throw new Error(`Unsafe workspace path: ${entry.path}`);
      await mkdir(dirname(full),{recursive:true});
      if(entry.kind==='symlink'){
        const target=Buffer.from(entry.contentBase64,'base64').toString('utf8');
        await symlink(target,full);
      } else {await writeFile(full,Buffer.from(entry.contentBase64,'base64'),{flag:'wx'});if(entry.executable)await chmod(full,0o755);}
    }
    return {workspacePath:root,cleanup:()=>rm(root,{recursive:true,force:true})};
  } catch(error){await rm(root,{recursive:true,force:true});throw error;}
}

export async function validateWorkerOutput(input:{repoPath:string;evidence:VerifiedWorkerWorkspace;commands:readonly ValidationCommand[];timeoutMs?:number;maxOutputBytes?:number;sandbox?:ValidationSandboxConfig}):Promise<ControllerValidationEvidence>{
  const sandbox=input.sandbox??{};
  if((sandbox.mode??'bwrap')==='bwrap'){await assertBwrapUsable(sandbox.bwrapPath);if(sandbox.cacheDir)await ensureSandboxCache(sandbox.cacheDir);}
  const {workspacePath,cleanup}=await materializeVerifiedWorkspace(input.repoPath,input.evidence);
  try {
    const checks:ValidationObservation[]=[];
    for(const command of input.commands){
      if(!command.name.trim()||!command.command||!Array.isArray(command.args)||command.args.some(a=>typeof a!=='string'))throw new Error('Validation commands require a name and explicit argv');
      checks.push(await runOne(workspacePath,input.repoPath,command,input.timeoutMs??120_000,input.maxOutputBytes??1024*1024,sandbox));
    }
    return {passed:checks.length>0&&checks.every(c=>c.exitCode===0&&!c.timedOut&&!c.outputTruncated),checks};
  } finally {await cleanup();}
}

async function runOne(root:string,repoPath:string,command:ValidationCommand,timeoutMs:number,maxBytes:number,sandbox:ValidationSandboxConfig):Promise<ValidationObservation>{
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('Invalid validation bounds');
  if(command.network!==undefined&&typeof command.network!=='boolean')throw new Error('Validation command network must be a boolean');
  const cwd=command.cwd?resolve(root,command.cwd):root;if(cwd!==root&&!cwd.startsWith(root+sep))throw new Error('Validation cwd escapes disposable workspace');
  const relCwd=cwd.slice(root.length+1).split(sep);let traversed=root;for(const part of relCwd){traversed=join(traversed,part);try{if((await lstat(traversed)).isSymbolicLink())throw new Error('Validation cwd follows a symlink');}catch(error){if(error instanceof Error&&error.message==='Validation cwd follows a symlink')throw error;}}
  const mode=sandbox.mode??'bwrap',network=mode==='none'||(command.network??defaultNetworkAccess(command.command,command.args)),hostEnv={PATH:process.env.PATH??'',LANG:process.env.LANG??'C.UTF-8',LC_ALL:process.env.LC_ALL??'C.UTF-8'};
  // Sandboxed: bwrap is the direct child, so killing it tears down the whole PID namespace (--die-with-parent + --unshare-pid).
  const launch=mode==='bwrap'
    ?{file:sandbox.bwrapPath??'bwrap',args:buildSandboxArgs({workspacePath:root,cwd:relCwd.join(sep),command:command.command,args:command.args,network,env:{path:hostEnv.PATH,lang:hostEnv.LANG,lcAll:hostEnv.LC_ALL},home:homedir(),tmpDir:tmpdir(),repoPath,dataDir:sandbox.dataDir,cacheDir:sandbox.cacheDir,roPaths:sandbox.roPaths}),cwd:root,env:{PATH:hostEnv.PATH}}
    :{file:command.command,args:command.args,cwd,env:hostEnv};
  const startedAt=new Date().toISOString();return new Promise(resolvePromise=>{
    const child=spawn(launch.file,launch.args,{cwd:launch.cwd,stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32',env:launch.env});
    const chunks:Buffer[]=[];let size=0,truncated=false,timedOut=false,exitCode:number|null=null,signal:string|undefined;
    const collect=(chunk:Buffer)=>{if(size<maxBytes){const keep=chunk.subarray(0,maxBytes-size);chunks.push(keep);size+=keep.length;}if(size>=maxBytes&&chunk.length>0){truncated=true;killTree(child);}};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    const timer=setTimeout(()=>{timedOut=true;killTree(child);},timeoutMs);
    child.once('error',()=>{clearTimeout(timer);exitCode=127;resolvePromise({name:command.name,command:command.command,args:[...command.args],exitCode,signal,timedOut,output:Buffer.concat(chunks).toString('utf8'),outputTruncated:truncated,startedAt,finishedAt:new Date().toISOString(),sandbox:mode,network});});
    child.once('close',(code,term)=>{clearTimeout(timer);exitCode=code;signal=term??undefined;resolvePromise({name:command.name,command:command.command,args:[...command.args],exitCode,signal,timedOut,output:Buffer.concat(chunks).toString('utf8'),outputTruncated:truncated,startedAt,finishedAt:new Date().toISOString(),sandbox:mode,network});});
  });
}

function fromRecordedEntry(value:Record<string,any>):SnapshotEntry {
  const kind=value.kind,mode=value.mode;
  if(!['file','symlink'].includes(kind)||!['100644','100755','120000'].includes(mode)||typeof value.contentBase64!=='string')throw new Error('Recorded change omitted exact bytes/mode');
  const bytes=Buffer.from(value.contentBase64,'base64');
  if(bytes.toString('base64')!==value.contentBase64||bytes.length!==value.size||createHash('sha256').update(bytes).digest('hex')!==String(value.sha256).toLowerCase())throw new Error('Recorded entry size/hash mismatch');
  if((kind==='symlink')!==(mode==='120000'))throw new Error('Recorded entry kind/mode mismatch');
  return {path:'',kind,executable:mode==='100755',contentBase64:value.contentBase64};
}
function sameEntry(a:SnapshotEntry,b:SnapshotEntry):boolean{return a.kind===b.kind&&a.executable===b.executable&&a.contentBase64===b.contentBase64;}
export function formatReviewDiff(changes:ChangeEvidence[]):string{return changes.length?changes.map(c=>{
  const before=c.before,after=c.after, oldText=before?.kind==='file'?decodeText(Buffer.from(before.contentBase64,'base64')):undefined,newText=after?.kind==='file'?decodeText(Buffer.from(after.contentBase64,'base64')):undefined;
  let out=`### ${c.kind}: ${c.previousPath?`${c.previousPath} -> `:''}${c.path}\n`;
  if(before)out+=`- mode ${mode(before)}, ${Buffer.from(before.contentBase64,'base64').length} bytes, sha256 ${hash(before)}\n`;
  if(after)out+=`+ mode ${mode(after)}, ${Buffer.from(after.contentBase64,'base64').length} bytes, sha256 ${hash(after)}\n`;
  if(oldText!==undefined||newText!==undefined)out+=unified(c.path,oldText??'',newText??'');else if(before||after)out+='[binary or symlink bytes preserved in exact evidence]\n';
  return out;
}).join('\n'):'No workspace changes.\n';}
export function legacyFullContextReviewDiff(changes:ChangeEvidence[]):string{return changes.length?changes.map(c=>{
  const before=c.before,after=c.after, oldText=before?.kind==='file'?decodeText(Buffer.from(before.contentBase64,'base64')):undefined,newText=after?.kind==='file'?decodeText(Buffer.from(after.contentBase64,'base64')):undefined;
  let out=`### ${c.kind}: ${c.previousPath?`${c.previousPath} -> `:''}${c.path}\n`;
  if(before)out+=`- mode ${mode(before)}, ${Buffer.from(before.contentBase64,'base64').length} bytes, sha256 ${hash(before)}\n`;
  if(after)out+=`+ mode ${mode(after)}, ${Buffer.from(after.contentBase64,'base64').length} bytes, sha256 ${hash(after)}\n`;
  if(oldText!==undefined||newText!==undefined)out+=legacyUnified(c.path,oldText??'',newText??'');else if(before||after)out+='[binary or symlink bytes preserved in exact evidence]\n';
  return out;
}).join('\n'):'No workspace changes.\n';}
function mode(e:SnapshotEntry):string{return e.kind==='symlink'?'120000':e.executable?'100755':'100644';}
function hash(e:SnapshotEntry):string{return createHash('sha256').update(Buffer.from(e.contentBase64,'base64')).digest('hex');}
function decodeText(bytes:Buffer):string|undefined{if(bytes.includes(0))return;try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return undefined;}}
/** Legacy full-context diff emitter (all unchanged lines as context). Preserved for backward compatibility with recorded evidence. */
function legacyUnified(path:string,a:string,b:string):string{
  const old=a?a.replace(/\n$/,'').split('\n'):[], next=b?b.replace(/\n$/,'').split('\n'):[];
  if(old.length*next.length>500_000)return '[text diff omitted: exact bytes remain in evidence]\n';
  const lcs=Array.from({length:old.length+1},()=>new Uint32Array(next.length+1));
  for(let i=old.length-1;i>=0;i--)for(let j=next.length-1;j>=0;j--)lcs[i]![j]=old[i]===next[j]?(lcs[i+1]?.[j+1]??0)+1:Math.max(lcs[i+1]?.[j]??0,lcs[i]![j+1]??0);
  const rows:string[]=[];let i=0,j=0;
  while(i<old.length||j<next.length){if(i<old.length&&j<next.length&&old[i]===next[j])rows.push(` ${old[i++]}`),j++;else if(j<next.length&&(i===old.length||(lcs[i]![j+1]??0)>=(lcs[i+1]?.[j]??0)))rows.push(`+${next[j++]}`);else rows.push(`-${old[i++]}`);}
  return `\n\`\`\`diff\n--- a/${path}\n+++ b/${path}\n@@ -${old.length?1:0},${old.length} +${next.length?1:0},${next.length} @@\n${rows.join('\n')}\n\`\`\`\n`;
}
/** Standard unified diff with 3-line context windows and merged hunks. */
export function unified(path: string, a: string, b: string): string {
  const CONTEXT = 3;
  const aNoNL = a.length > 0 && !a.endsWith('\n');
  const bNoNL = b.length > 0 && !b.endsWith('\n');
  const old = a ? a.replace(/\n$/, '').split('\n') : [];
  const nxt = b ? b.replace(/\n$/, '').split('\n') : [];
  if (old.length * nxt.length > 500_000) return '[text diff omitted: exact bytes remain in evidence]\n';
  // Build LCS table
  const lcs = Array.from({length: old.length+1}, () => new Uint32Array(nxt.length+1));
  for (let i = old.length-1; i >= 0; i--)
    for (let j = nxt.length-1; j >= 0; j--)
      lcs[i]![j] = old[i] === nxt[j] ? (lcs[i+1]?.[j+1] ?? 0)+1 : Math.max(lcs[i+1]?.[j] ?? 0, lcs[i]![j+1] ?? 0);
  // Build flat ops: {op: ' '|'+'|'-', line: string}
  type Op = {op: ' '|'+'|'-'; line: string};
  const ops: Op[] = [];
  let oi = 0, ni = 0;
  while (oi < old.length || ni < nxt.length) {
    if (oi < old.length && ni < nxt.length && old[oi] === nxt[ni])
      ops.push({op: ' ', line: old[oi++]!}), ni++;
    else if (ni < nxt.length && (oi === old.length || (lcs[oi]![ni+1] ?? 0) >= (lcs[oi+1]?.[ni] ?? 0)))
      ops.push({op: '+', line: nxt[ni++]!});
    else
      ops.push({op: '-', line: old[oi++]!});
  }
  const hasChanges = ops.some(o => o.op !== ' ');
  // Files differ only in trailing newline: synthesize a minimal diff
  if (!hasChanges && aNoNL !== bNoNL) {
    const last = old.length > 0 ? old[old.length-1]! : '';
    const noNL = '\\ No newline at end of file';
    const hunkLines = aNoNL
      ? [`@@ -${old.length},1 +${nxt.length},1 @@`, '-'+last, noNL, '+'+last]
      : [`@@ -${old.length},1 +${nxt.length},1 @@`, '-'+last, '+'+last, noNL];
    return `\n\`\`\`diff\n--- a/${path}\n+++ b/${path}\n${hunkLines.join('\n')}\n\`\`\`\n`;
  }
  if (!hasChanges) return '';
  // Mark ops needed in output: every change, plus CONTEXT lines before/after it
  const need = new Uint8Array(ops.length);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]!.op !== ' ') {
      for (let c = Math.max(0, k-CONTEXT); c <= Math.min(ops.length-1, k+CONTEXT); c++)
        need[c] = 1;
    }
  }
  // Build hunks as consecutive spans of needed ops
  const hunks: Array<{start: number; end: number}> = [];
  for (let k = 0; k < ops.length; k++) {
    if (!need[k]) continue;
    if (hunks.length && hunks[hunks.length-1]!.end >= k-1)
      hunks[hunks.length-1]!.end = k;
    else
      hunks.push({start: k, end: k});
  }
  // Compute old/new line numbers for each op
  let oLine = 1, nLine = 1;
  const oAt: number[] = [], nAt: number[] = [];
  for (const {op} of ops) {
    oAt.push(op === '+' ? 0 : oLine);
    nAt.push(op === '-' ? 0 : nLine);
    if (op !== '+') oLine++;
    if (op !== '-') nLine++;
  }
  // Find last old/new op indices for "no newline at end of file" markers
  let lastOldIdx = -1, lastNxtIdx = -1;
  for (let k = ops.length-1; k >= 0 && (lastOldIdx < 0 || lastNxtIdx < 0); k--) {
    if (lastOldIdx < 0 && ops[k]!.op !== '+') lastOldIdx = k;
    if (lastNxtIdx < 0 && ops[k]!.op !== '-') lastNxtIdx = k;
  }
  // Format hunks into lines
  const lines: string[] = [];
  for (const {start, end} of hunks) {
    let oCnt = 0, nCnt = 0, oStart = 0, nStart = 0;
    for (let k = start; k <= end; k++) {
      if (ops[k]!.op !== '+') { if (!oCnt) oStart = oAt[k]!; oCnt++; }
      if (ops[k]!.op !== '-') { if (!nCnt) nStart = nAt[k]!; nCnt++; }
    }
    if (!oCnt) oStart = 0; // new file: @@ -0,0 +1,N @@
    if (!nCnt) nStart = 0; // deleted file: @@ -1,N +0,0 @@
    lines.push(`@@ -${oStart},${oCnt} +${nStart},${nCnt} @@`);
    for (let k = start; k <= end; k++) {
      lines.push(ops[k]!.op + ops[k]!.line);
      if (aNoNL && k === lastOldIdx && ops[k]!.op !== '+') lines.push('\\ No newline at end of file');
      if (bNoNL && k === lastNxtIdx && ops[k]!.op !== '-') lines.push('\\ No newline at end of file');
    }
  }
  return `\n\`\`\`diff\n--- a/${path}\n+++ b/${path}\n${lines.join('\n')}\n\`\`\`\n`;
}
function killTree(child:ReturnType<typeof spawn>):void{if(!child.pid)return;try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
