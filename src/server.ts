import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { Controller } from './controller.js';
import { JsonStore } from './store.js';
import { UhpClient } from './uhp.js';
import { HindsightClient } from './hindsight.js';
import { LocalBridge } from './local-bridge.js';
import { browseRepositories, repositoryName } from './repository-browser.js';
import { inspectRepository } from './repository-inspector.js';
import { deleteWorkspaceSetup, findSavedProjectForRepository, loadWorkspaceSetup, saveWorkspaceSetup, validateWorkspaceSetup } from './workspace-setup.js';
import { GitHubIntegration, requireSameOriginWrite } from './github.js';

const config=loadConfig();
const workspacePolicyConfigured=Boolean(config.workspaceSourceRepo||config.workspaceBridgeUrl||config.workspaceAllowedScope.length||config.validationCommands.length);
if(workspacePolicyConfigured&&(!config.workspaceSourceRepo||!config.workspaceBridgeUrl||!config.workspaceAllowedScope.length||!config.validationCommands.length))throw new Error('Workspace workflow configuration is partial; configure source repo, loopback bridge URL, allowed scope, and validation commands together');
const store=new JsonStore(resolve(config.dataDir,'state.json'));
const github=new GitHubIntegration(store,config.dataDir);
const uhpToken=process.env.UHP_TOKEN;
const uhp=config.uhpBaseUrl ? new UhpClient({baseUrl:config.uhpBaseUrl,...(uhpToken?{token:uhpToken}:{}),harnessId:config.uhpHarnessId,model:config.uhpModel,timeoutMs:Math.max(config.requestTimeoutMs,45_000)}) : {
  async submit():Promise<never>{throw new Error('UHP is not configured (set UHP_BASE_URL)');},
  async cancel():Promise<never>{throw new Error('UHP is not configured (set UHP_BASE_URL)');}
};
const hindsight=config.hindsightBaseUrl?new HindsightClient({baseUrl:config.hindsightBaseUrl,token:process.env.HINDSIGHT_TOKEN}):undefined;
const controller=new Controller(store,uhp,!!config.hindsightBaseUrl,!!config.uhpBaseUrl,config.uhpHarnessId&&config.uhpModel?{harnessId:config.uhpHarnessId,model:config.uhpModel}:undefined,hindsight,Math.ceil(config.taskTimeoutMs/1000));
if(config.workspaceSourceRepo&&config.workspaceAllowedScope.length&&config.validationCommands.length)controller.configureVerifiedWorkspace({repoPath:config.workspaceSourceRepo,allowedScope:config.workspaceAllowedScope,commands:config.validationCommands,bridgeBaseUrl:config.workspaceBridgeUrl,timeoutMs:config.validationTimeoutMs,maxOutputBytes:config.validationMaxOutputBytes});
const projectControllers=new Map<string,{controller:Controller;bridge:LocalBridge;workspace:Awaited<ReturnType<typeof validateWorkspaceSetup>>}>();
const createProjectRuntime=async(projectId:string,workspace:Awaited<ReturnType<typeof validateWorkspaceSetup>>)=>{
  const bridge=new LocalBridge({dataDir:resolve(config.dataDir,'local-bridges')});
  try {
    const status=await bridge.start(workspace.repoPath,projectId);
    const projectUhp=new UhpClient({baseUrl:status.baseUrl,timeoutMs:Math.max(config.requestTimeoutMs,45_000)});
    const scoped=new Controller(store,projectUhp,!!config.hindsightBaseUrl,true,undefined,hindsight,Math.ceil(config.taskTimeoutMs/1000),projectId);
    scoped.configureVerifiedWorkspace({repoPath:workspace.repoPath,allowedScope:workspace.allowedScope,commands:workspace.validationCommands,bridgeBaseUrl:status.baseUrl,timeoutMs:config.validationTimeoutMs,maxOutputBytes:config.validationMaxOutputBytes});
    projectControllers.set(projectId,{controller:scoped,bridge,workspace});
    return {scoped,bridge,status};
  } catch(error) { await bridge.stop(); throw error; }
};
const uiRoot=resolve(fileURLToPath(new URL('../dist/ui/',import.meta.url)));
const body=async(req:IncomingMessage):Promise<any>=>{let data='';for await(const chunk of req)data+=chunk;if(data.length>1_000_000)throw Object.assign(new Error('Request body too large'),{statusCode:413});return data?JSON.parse(data):{};};
const json=(res:ServerResponse,status:number,data:unknown)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
const controllerForPath=async(path:string,query?:URLSearchParams,method?:string):Promise<Controller>=>{
  const state=await store.load();
  let projectId=query?.get('projectId')??undefined;
  let match=path.match(/^\/api\/projects\/([^/]+)/);
  if(match)projectId=decodeURIComponent(match[1]!);
  if(!projectId){
    match=path.match(/^\/api\/(?:tasks|runs|assignments|guidance)\/([^/]+)/);
    if(match){const resourceId=decodeURIComponent(match[1]!);for(const project of state.projects){if(project.tasks.some(task=>task.id===resourceId||task.runs.some(run=>run.id===resourceId||run.assignments.some(a=>a.id===resourceId)||run.guidance.some(g=>g.id===resourceId)))){projectId=project.id;break;}}}
  }
  if(projectId){
    const runtime=projectControllers.get(projectId);
    if(runtime)return runtime.controller;
    const saved=await loadWorkspaceSetup(config.dataDir,projectId).catch(()=>undefined);
    const setupPath=resolve(config.dataDir,'workspaces',`${projectId}.json`);
    const hasSavedSetup=Boolean(saved)||await access(setupPath).then(()=>true,()=>false);
    const administrativeDelete=method==='DELETE'&&/^\/api\/(?:projects\/[^/]+(?:\/planner)?|tasks\/[^/]+(?:\/plan)?)$/.test(path);
    if(hasSavedSetup&&!(path.endsWith('/workspace-setup')&&saved)&&!administrativeDelete)throw Object.assign(new Error('Local repository bridge is unavailable for this project; restart Foreman to retry it'),{statusCode:503});
  }
  return controller;
};
const server=createServer(async(req,res)=>{
  const url=new URL(req.url??'/',`http://${req.headers.host??'localhost'}`), path=url.pathname;
  try {
    const githubMatch=path.match(/^\/api\/runs\/([^/]+)\/github(?:\/(push|pr|review|merge|enqueue|refresh-local))?$/);
    if(githubMatch){
      const runId=decodeURIComponent(githubMatch[1]!);
      const action=githubMatch[2];
      if(req.method==='GET'&&!action){json(res,200,await github.getRunStatus(runId));return;}
      if(req.method==='POST'&&action){
        const b=await body(req);
        const confirmKind=action==='push'?'push':action==='pr'?'pr':action==='review'?'review':action==='merge'?'merge':action==='enqueue'?'enqueue':'refresh';
        requireSameOriginWrite(req,b,confirmKind,{bindHost:config.host,port:config.port});
        if(action==='push'){json(res,200,await github.pushResult(runId));return;}
        if(action==='pr'){json(res,200,await github.openPullRequest(runId));return;}
        if(action==='review'){json(res,200,await github.submitReview(runId,{event:b.event,body:b.body,reviewedHeadSha:b.reviewedHeadSha}));return;}
        if(action==='merge'){json(res,200,await github.mergePullRequest(runId,{reviewedHeadSha:b.reviewedHeadSha}));return;}
        if(action==='enqueue'){json(res,200,await github.enqueuePullRequest(runId,{reviewedHeadSha:b.reviewedHeadSha}));return;}
        json(res,200,await github.refreshLocal(runId));return;
      }
    }
    const projectUsageMatch=path.match(/^\/api\/projects\/([^/]+)\/usage$/);
    if(req.method==='GET'&&projectUsageMatch){
      const projectId=decodeURIComponent(projectUsageMatch[1]!);
      const runtime=projectControllers.get(projectId);
      const unavailable={status:'unavailable' as const};
      const fallback={harnesses:['claude-code','codex-cli','antigravity-cli'].map(harnessId=>({harnessId,status:'unavailable' as const,windows:{fiveHour:unavailable,weekly:unavailable}}))};
      const baseUrl=runtime?.bridge.status?.baseUrl;
      if(!baseUrl){json(res,200,fallback);return;}
      try{json(res,200,await new UhpClient({baseUrl,timeoutMs:15_000}).usage());return;}
      catch{json(res,200,fallback);return;}
    }
    const activeController=await controllerForPath(path,url.searchParams,req.method);
    if(req.method==='GET'&&path==='/api/repositories/browse'){json(res,200,await browseRepositories(url.searchParams.get('path')??undefined));return;}
    if(req.method==='GET'&&path==='/api/repositories/inspect'){const selected=url.searchParams.get('path');if(!selected)throw Object.assign(new Error('Choose a repository folder'),{statusCode:400});json(res,200,await inspectRepository(selected));return;}
    if(req.method==='POST'&&path==='/api/projects/open'){
      const workspace=await validateWorkspaceSetup(await body(req));
      const savedState=await store.load(),existingId=await findSavedProjectForRepository(config.dataDir,savedState.projects,workspace.repoPath);
      if(existingId){
        let runtime=projectControllers.get(existingId);
        if(runtime){
          const bridgeBaseUrl=runtime.bridge.status?.baseUrl;if(!bridgeBaseUrl)throw Object.assign(new Error('Local repository bridge is unavailable for this project'),{statusCode:503});
          runtime.controller.configureVerifiedWorkspace({repoPath:workspace.repoPath,allowedScope:workspace.allowedScope,commands:workspace.validationCommands,bridgeBaseUrl,timeoutMs:config.validationTimeoutMs,maxOutputBytes:config.validationMaxOutputBytes});
          const saved=await saveWorkspaceSetup(config.dataDir,existingId,{repoPath:workspace.repoPath,allowedScope:workspace.allowedScope,validationCommands:workspace.validationCommands});
          projectControllers.set(existingId,{...runtime,workspace:saved});
        }else{
          const {scoped,bridge}=await createProjectRuntime(existingId,workspace);
          try{await scoped.refreshDiscovery();await scoped.recover();const saved=await saveWorkspaceSetup(config.dataDir,existingId,{repoPath:workspace.repoPath,allowedScope:workspace.allowedScope,validationCommands:workspace.validationCommands});projectControllers.set(existingId,{controller:scoped,bridge,workspace:saved});}
          catch(error){projectControllers.delete(existingId);await bridge.stop();throw error;}
        }
        const resumed=await projectControllers.get(existingId)!.controller.state();const project=resumed.projects.find(item=>item.id===existingId);if(!project)throw new Error('Saved project disappeared while reopening its repository');json(res,200,project);return;
      }
      const projectId=`prj_${randomUUID()}`;
      const {scoped,bridge}=await createProjectRuntime(projectId,workspace);
      try {await scoped.refreshDiscovery();const project=await scoped.createProject(repositoryName(workspace.repoPath),projectId);const saved=await saveWorkspaceSetup(config.dataDir,projectId,{repoPath:workspace.repoPath,allowedScope:workspace.allowedScope,validationCommands:workspace.validationCommands});projectControllers.set(projectId,{controller:scoped,bridge,workspace:saved});json(res,201,project);return;}
      catch(error){projectControllers.delete(projectId);await bridge.stop();throw error;}
    }
    const setupMatch=path.match(/^\/api\/projects\/([^/]+)\/workspace-setup$/);
    if(req.method==='GET'&&setupMatch){const projectId=decodeURIComponent(setupMatch[1]!);let workspace;try{workspace=await loadWorkspaceSetup(config.dataDir,projectId);}catch{throw Object.assign(new Error('Saved repository is unavailable; reopen the repository to continue'),{statusCode:503});}if(!workspace)throw Object.assign(new Error('Workspace setup not found'),{statusCode:404});json(res,200,{...workspace,bridgeStatus:projectControllers.get(projectId)?.bridge.status?'ready':'unavailable'});return;}
    if(req.method==='GET'&&path==='/api/state'){json(res,200,await activeController.state());return;}
    if(req.method==='GET'&&path==='/api/status'){json(res,200,await activeController.serviceStatus());return;}
    if(req.method==='GET'&&path==='/api/events'){
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});
      let last=Number(req.headers['last-event-id']??url.searchParams.get('after')??0);
      const send=async()=>{const state=await activeController.state();for(let i=last;i<state.events.length;i++){const e=state.events[i]!;last=i+1;res.write(`id: ${last}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);}};
      await send(); const timer=setInterval(()=>{void send().catch(()=>undefined);},1000); req.on('close',()=>clearInterval(timer)); return;
    }
    if(req.method==='POST'&&path==='/api/projects'){const b=await body(req);json(res,201,await activeController.createProject(String(b.name??'')));return;}
    let deleteMatch=path.match(/^\/api\/projects\/([^/]+)$/);if(req.method==='DELETE'&&deleteMatch){const projectId=decodeURIComponent(deleteMatch[1]!);const result=await activeController.deleteProject(projectId);const runtime=projectControllers.get(projectId);projectControllers.delete(projectId);configuredProjectIds.delete(projectId);if(runtime)await runtime.bridge.stop().catch(()=>undefined);await deleteWorkspaceSetup(config.dataDir,projectId);json(res,200,result);return;}
    deleteMatch=path.match(/^\/api\/projects\/([^/]+)\/planner$/);if(req.method==='DELETE'&&deleteMatch){json(res,200,await activeController.resetProjectPlanner(decodeURIComponent(deleteMatch[1]!)));return;}
    deleteMatch=path.match(/^\/api\/tasks\/([^/]+)\/plan$/);if(req.method==='DELETE'&&deleteMatch){json(res,200,await activeController.resetTaskPlan(decodeURIComponent(deleteMatch[1]!)));return;}
    deleteMatch=path.match(/^\/api\/tasks\/([^/]+)$/);if(req.method==='DELETE'&&deleteMatch){json(res,200,await activeController.deleteTask(decodeURIComponent(deleteMatch[1]!)));return;}
    const plannerMatch=path.match(/^\/api\/projects\/([^/]+)\/planner\/messages$/);if(req.method==='POST'&&plannerMatch){const b=await body(req);json(res,200,await activeController.sendProjectPlannerMessage(decodeURIComponent(plannerMatch[1]!),String(b.text??'')));return;}
    const plannerRecoveryMatch=path.match(/^\/api\/projects\/([^/]+)\/planner\/assignments\/([^/]+)\/recover-tasks$/);if(req.method==='POST'&&plannerRecoveryMatch){json(res,200,await activeController.recoverProjectPlannerTasks(decodeURIComponent(plannerRecoveryMatch[1]!),decodeURIComponent(plannerRecoveryMatch[2]!)));return;}
    let m=path.match(/^\/api\/roles\/([^/]+)\/config$/);if(req.method==='PUT'&&m){const b=await body(req);json(res,200,await activeController.selectRoleConfig(decodeURIComponent(m[1]!),b.config));return;}
    m=path.match(/^\/api\/projects\/([^/]+)\/roles\/([^/]+)\/config$/);if(req.method==='PUT'&&m){const b=await body(req);json(res,200,await activeController.selectRoleConfig(decodeURIComponent(m[2]!),b.config,decodeURIComponent(m[1]!)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/roles\/([^/]+)\/config$/);if(req.method==='PUT'&&m){const b=await body(req);json(res,200,await activeController.selectRoleConfig(decodeURIComponent(m[2]!),b.config,undefined,decodeURIComponent(m[1]!)));return;}
    m=path.match(/^\/api\/projects\/([^/]+)\/tasks$/);if(req.method==='POST'&&m){const b=await body(req);json(res,201,await activeController.createTask(decodeURIComponent(m[1]!),typeof b.title==='string'&&Object.keys(b).length===1?b.title:b));return;}
    m=path.match(/^\/api\/tasks\/([^/]+)$/);if(req.method==='PATCH'&&m){json(res,200,await activeController.updateTask(decodeURIComponent(m[1]!),await body(req)));return;}
    m=path.match(/^\/api\/tasks\/([^/]+)\/start$/);if(req.method==='POST'&&m){json(res,202,await activeController.startTaskWork(decodeURIComponent(m[1]!),await body(req)));return;}
    m=path.match(/^\/api\/tasks\/([^/]+)\/start-preview$/);if(req.method==='GET'&&m){json(res,200,await activeController.taskStartPreview(decodeURIComponent(m[1]!)));return;}
    m=path.match(/^\/api\/tasks\/([^/]+)\/steer$/);if(req.method==='POST'&&m){const b=await body(req);json(res,200,await activeController.steerTask(decodeURIComponent(m[1]!),String(b.text??'')));return;}
    m=path.match(/^\/api\/tasks\/([^/]+)\/runs$/);if(req.method==='POST'&&m){json(res,201,await activeController.createRun(decodeURIComponent(m[1]!)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/start$/);if(req.method==='POST'&&m){json(res,202,await activeController.startWork(decodeURIComponent(m[1]!),await body(req)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/guidance$/);if(req.method==='POST'&&m){const b=await body(req);json(res,201,await activeController.addGuidance(decodeURIComponent(m[1]!),String(b.text??'')));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/orchestrator$/);if(req.method==='POST'&&m){const b=await body(req);json(res,201,await activeController.orchestrate(decodeURIComponent(m[1]!),String(b.prompt??'')));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/orchestrator\/follow-up$/);if(req.method==='POST'&&m){const b=await body(req);json(res,201,await activeController.followUpOrchestrator(decodeURIComponent(m[1]!),String(b.prompt??'')));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/worker-dispatch$/);if(req.method==='POST'&&m){const b=await body(req);json(res,201,await activeController.dispatchWorkerProposal(decodeURIComponent(m[1]!),String(b.proposalId??'')));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/worker-retry$/);if(req.method==='POST'&&m){const b=await body(req);json(res,201,await activeController.retryWorkerProposal(decodeURIComponent(m[1]!),String(b.proposalId??'')));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/guidance\/checkpoint$/);if(req.method==='POST'&&m){json(res,200,await activeController.deliverGuidanceCheckpoint(decodeURIComponent(m[1]!)));return;}
    m=path.match(/^\/api\/guidance\/([^/]+)\/ack$/);if(req.method==='POST'&&m){const b=await body(req);json(res,200,await activeController.acknowledgeGuidance(decodeURIComponent(m[1]!),b.acknowledgment));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/assignments$/);if(req.method==='POST'&&m){const b=await body(req);json(res,201,await activeController.assign(decodeURIComponent(m[1]!),String(b.roleId??''),String(b.prompt??''),b.config));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/sessions\/(planner|orchestrator)\/rotate$/);if(req.method==='POST'&&m){json(res,200,await activeController.rotateSession(decodeURIComponent(m[1]!),m[2]!));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/reviews$/);if(req.method==='POST'&&m){json(res,201,await activeController.addReview(decodeURIComponent(m[1]!),await body(req)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/validation$/);if(req.method==='POST'&&m){json(res,201,await activeController.recordValidation(decodeURIComponent(m[1]!),await body(req)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/workspace$/);if(req.method==='POST'&&m){const b=await body(req);json(res,200,await activeController.prepareWorkerWorkspace(decodeURIComponent(m[1]!),String(b.baseCommit??'')));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/worker-evidence$/);if(req.method==='POST'&&m){const b=await body(req);json(res,200,await activeController.verifyWorkerOutput(decodeURIComponent(m[1]!),String(b.assignmentId??'')));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/validation\/retry$/);if(req.method==='POST'&&m){json(res,200,await activeController.retryValidation(decodeURIComponent(m[1]!)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/reviewer$/);if(req.method==='POST'&&m){const b=await body(req);if(b.action==='recommendation')json(res,200,await activeController.recordReviewerRecommendation(decodeURIComponent(m[1]!),String(b.assignmentId??'')));else json(res,201,await activeController.requestReviewer(decodeURIComponent(m[1]!)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/reviewer\/retry$/);if(req.method==='POST'&&m){await activeController.retryReviewer(decodeURIComponent(m[1]!));json(res,200,{ok:true});return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/reviewer-correction\/resume$/);if(req.method==='POST'&&m){json(res,202,await activeController.resumeReviewerCorrection(decodeURIComponent(m[1]!)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/approve$/);if(req.method==='POST'&&m){json(res,200,await activeController.approveRun(decodeURIComponent(m[1]!),await body(req)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/abandon-result$/);if(req.method==='POST'&&m){json(res,200,await activeController.abandonApprovedResult(decodeURIComponent(m[1]!),await body(req)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/promotion$/);if(req.method==='POST'&&m){json(res,200,await activeController.promoteRun(decodeURIComponent(m[1]!),await body(req)));return;}
    m=path.match(/^\/api\/assignments\/([^/]+)\/cancel$/);if(req.method==='POST'&&m){json(res,200,await activeController.cancelAssignment(decodeURIComponent(m[1]!)));return;}
    m=path.match(/^\/api\/assignments\/([^/]+)\/refresh$/);if(req.method==='POST'&&m){json(res,200,await activeController.refreshAssignment(decodeURIComponent(m[1]!)));return;}
    if(req.method==='GET'&&(path==='/'||!path.startsWith('/api/'))){const root=uiRoot;const requested=path==='/'?'index.html':decodeURIComponent(path.slice(1));const candidate=resolve(root,requested);if(candidate!==root&&!candidate.startsWith(`${root}${sep}`)){json(res,403,{error:'Forbidden'});return;}try{if(!(await stat(candidate)).isFile())throw new Error();const content=await readFile(candidate);res.writeHead(200,{'content-type':mime(extname(candidate)),'cache-control':'no-cache'});res.end(content);return;}catch{const index=await readFile(resolve(root,'index.html')).catch(()=>undefined);if(index){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache'});res.end(index);return;}}}
    json(res,404,{error:'Not found'});
  } catch(e) {const err=e as Error&{statusCode?:number};json(res,err.statusCode??400,{error:err.message});}
});
await store.load();
const startupState=await store.load();
const configuredProjectIds=new Set<string>();
await controller.refreshDiscovery();
for(const project of startupState.projects){
  let workspace;try{workspace=await loadWorkspaceSetup(config.dataDir,project.id);}catch(error){process.stderr.write(`Saved workspace for ${project.id} is unavailable: ${error instanceof Error?error.message:'invalid setup'}\n`);continue;}
  if(!workspace)continue;configuredProjectIds.add(project.id);
  try{const {scoped}=await createProjectRuntime(project.id,workspace);await scoped.refreshDiscovery();await scoped.recover();}
  catch(error){process.stderr.write(`Could not start local workspace for ${project.id}: ${error instanceof Error?error.message:'bridge startup failed'}\n`);}
}
if(configuredProjectIds.size===0)await controller.recover();
setInterval(()=>{if(configuredProjectIds.size===0)void controller.reconcileRunning();for(const runtime of projectControllers.values())void runtime.controller.reconcileRunning();},5000).unref();
const shutdown=async()=>{server.close();await Promise.all([...projectControllers.values()].map(runtime=>runtime.bridge.stop()));};
process.once('SIGINT',()=>{void shutdown().finally(()=>process.exit(0));});
process.once('SIGTERM',()=>{void shutdown().finally(()=>process.exit(0));});
server.listen(config.port,config.host,()=>process.stdout.write(`Foreman listening on http://${config.host}:${config.port}\n`));

function mime(ext:string):string{return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'})[ext]??'application/octet-stream';}
