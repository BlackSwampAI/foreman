import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { baseFailureNote, baseFailureStopReason, baselineCommandDigest, baselineCommandsFor, ensureBaseline, markFailsOnBase, workerCausedFailures } from '../src/baseline-validation.js';
import type { ValidationCheck } from '../src/domain.js';

const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function baseRepo(){const dir=await mkdtemp(join(tmpdir(),'foreman-baseline-unit-'));dirs.push(dir);const git=(...args:string[])=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');await writeFile(join(dir,'README.md'),'base\n');git('add','README.md');git('commit','-qm','base');return {dir,sha:git('rev-parse','HEAD')};}
const node=(name:string,code:string)=>({name,command:process.execPath,args:['-e',code]});
const check=(name:string,passed:boolean,failsOnBase?:boolean):ValidationCheck=>({name,command:'x',args:[],exitCode:passed?0:1,timedOut:false,output:'',outputTruncated:false,startedAt:'',finishedAt:'',passed,...(failsOnBase===undefined?{}:{failsOnBase})});

describe('baseline validation on the unchanged base commit',()=>{
  it('reruns only setup commands and the failed checks, in configured order',()=>{
    const commands=[{name:'install',command:'pnpm',args:['install']},{name:'lint',command:'pnpm',args:['lint']},{name:'fetch',command:'node',args:['fetch.js'],network:true},{name:'offline install',command:'pnpm',args:['install'],network:false},{name:'test',command:'pnpm',args:['test']},{name:'smoke',command:'pnpm',args:['run','smoke:install']}];
    expect(baselineCommandsFor(commands,new Set(['smoke'])).map(c=>c.name)).toEqual(['install','fetch','smoke']);
    expect(baselineCommandsFor(commands,new Set(['offline install','test'])).map(c=>c.name)).toEqual(['install','fetch','offline install','test']);
  });

  it('runs the checks on the pinned base without the Worker change and caches the result by base and command digest',async()=>{
    const {dir,sha}=await baseRepo();
    const commands=[node('passes on base',"process.exit(require('fs').readFileSync('README.md','utf8')==='base\\n'?0:1)"),node('fails on base','process.exit(2)'),node('not needed','process.exit(3)')];
    const first=await ensureBaseline({repoPath:dir,pinnedBaseCommit:sha,allowedScope:['README.md'],commands,failedNames:['passes on base','fails on base'],sandbox:{mode:'none'}});
    expect(first.ran).toEqual(['passes on base','fails on base']);
    expect(first.baseline).toMatchObject({pinnedBaseCommit:sha,commandDigest:baselineCommandDigest(commands)});
    expect(first.baseline.checks).toEqual([{name:'passes on base',passed:true,exitCode:0,timedOut:false},{name:'fails on base',passed:false,exitCode:2,timedOut:false}]);
    const again=await ensureBaseline({repoPath:dir,pinnedBaseCommit:sha,allowedScope:['README.md'],commands,failedNames:['fails on base'],cached:first.baseline,sandbox:{mode:'none'}});
    expect(again.ran).toEqual([]);expect(again.baseline).toBe(first.baseline);
    const extended=await ensureBaseline({repoPath:dir,pinnedBaseCommit:sha,allowedScope:['README.md'],commands,failedNames:['not needed'],cached:first.baseline,sandbox:{mode:'none'}});
    expect(extended.ran).toEqual(['not needed']);expect(extended.baseline.checks.map(c=>c.name)).toEqual(['passes on base','fails on base','not needed']);
    const changed=await ensureBaseline({repoPath:dir,pinnedBaseCommit:sha,allowedScope:['README.md'],commands:[...commands,node('another','process.exit(0)')],failedNames:['fails on base'],cached:first.baseline,sandbox:{mode:'none'}});
    expect(changed.ran).toEqual(['fails on base']);
  });

  it('marks failed checks, never passing ones, and leaves checks the baseline did not run unmarked',()=>{
    const observations=[check('a',false),check('b',false),check('c',true),check('d',false)];
    markFailsOnBase(observations,{pinnedBaseCommit:'x',commandDigest:'y',ranAt:'',checks:[{name:'a',passed:false,exitCode:1,timedOut:false},{name:'b',passed:true,exitCode:0,timedOut:false},{name:'c',passed:false,exitCode:1,timedOut:false}]});
    expect(observations.map(o=>o.failsOnBase)).toEqual([true,false,undefined,undefined]);
  });

  it('stops only when every failed check also fails on the base and names the Worker-caused ones otherwise',()=>{
    expect(baseFailureStopReason([check('Smoke: install',false,true),check('lint',true)])).toBe('Checks also fail on the base commit, so a Worker retry cannot fix them: Smoke: install. Fix the check or its network setting, then retry validation.');
    expect(baseFailureStopReason([check('Smoke: install',false,true),check('unit tests',false,false)])).toBeUndefined();
    expect(baseFailureStopReason([check('unit tests',false)])).toBeUndefined();
    const mixed=[check('Smoke: install',false,true),check('unit tests',false,false),check('unknown',false)];
    expect(workerCausedFailures(mixed).map(c=>c.name)).toEqual(['unit tests','unknown']);
    expect(baseFailureNote(mixed)).toBe("Also fails on base, not the Worker's to fix (ignore): Smoke: install. ");
    expect(baseFailureNote([check('unit tests',false,false)])).toBe('');
  });
});
