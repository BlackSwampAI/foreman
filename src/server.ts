import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve, extname, sep } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { Controller } from './controller.js';
import { JsonStore } from './store.js';
import { UhpClient } from './uhp.js';
import { HindsightClient } from './hindsight.js';

const config=loadConfig();
const workspacePolicyConfigured=Boolean(config.workspaceSourceRepo||config.workspaceBridgeUrl||config.workspaceAllowedScope.length||config.validationCommands.length);
if(workspacePolicyConfigured&&(!config.workspaceSourceRepo||!config.workspaceBridgeUrl||!config.workspaceAllowedScope.length||!config.validationCommands.length))throw new Error('Workspace workflow configuration is partial; configure source repo, loopback bridge URL, allowed scope, and validation commands together');
const store=new JsonStore(resolve(config.dataDir,'state.json'));
const uhpToken=process.env.UHP_TOKEN;
const uhp=config.uhpBaseUrl ? new UhpClient({baseUrl:config.uhpBaseUrl,...(uhpToken?{token:uhpToken}:{}),harnessId:config.uhpHarnessId,model:config.uhpModel,timeoutMs:Math.max(config.requestTimeoutMs,45_000)}) : {
  async submit():Promise<never>{throw new Error('UHP is not configured (set UHP_BASE_URL)');},
  async cancel():Promise<never>{throw new Error('UHP is not configured (set UHP_BASE_URL)');}
};
const hindsight=config.hindsightBaseUrl?new HindsightClient({baseUrl:config.hindsightBaseUrl,token:process.env.HINDSIGHT_TOKEN}):undefined;
const controller=new Controller(store,uhp,!!config.hindsightBaseUrl,!!config.uhpBaseUrl,config.uhpHarnessId&&config.uhpModel?{harnessId:config.uhpHarnessId,model:config.uhpModel}:undefined,hindsight,Math.ceil(config.taskTimeoutMs/1000));
if(config.workspaceSourceRepo&&config.workspaceAllowedScope.length&&config.validationCommands.length)controller.configureVerifiedWorkspace({repoPath:config.workspaceSourceRepo,allowedScope:config.workspaceAllowedScope,commands:config.validationCommands,bridgeBaseUrl:config.workspaceBridgeUrl,timeoutMs:config.validationTimeoutMs,maxOutputBytes:config.validationMaxOutputBytes});
const uiRoot=resolve(fileURLToPath(new URL('../dist/ui/',import.meta.url)));
const body=async(req:IncomingMessage):Promise<any>=>{let data='';for await(const chunk of req)data+=chunk;if(data.length>1_000_000)throw Object.assign(new Error('Request body too large'),{statusCode:413});return data?JSON.parse(data):{};};
const json=(res:ServerResponse,status:number,data:unknown)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
const server=createServer(async(req,res)=>{
  const url=new URL(req.url??'/',`http://${req.headers.host??'localhost'}`), path=url.pathname;
  try {
    if(req.method==='GET'&&path==='/api/state'){json(res,200,await controller.state());return;}
    if(req.method==='GET'&&path==='/api/status'){json(res,200,await controller.serviceStatus());return;}
    if(req.method==='GET'&&path==='/api/events'){
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});
      let last=Number(req.headers['last-event-id']??url.searchParams.get('after')??0);
      const send=async()=>{const state=await controller.state();for(let i=last;i<state.events.length;i++){const e=state.events[i]!;last=i+1;res.write(`id: ${last}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);}};
      await send(); const timer=setInterval(()=>{void send().catch(()=>undefined);},1000); req.on('close',()=>clearInterval(timer)); return;
    }
    if(req.method==='POST'&&path==='/api/projects'){const b=await body(req);json(res,201,await controller.createProject(String(b.name??'')));return;}
    let m=path.match(/^\/api\/roles\/([^/]+)\/config$/);if(req.method==='PUT'&&m){const b=await body(req);json(res,200,await controller.selectRoleConfig(decodeURIComponent(m[1]!),b.config));return;}
    m=path.match(/^\/api\/projects\/([^/]+)\/roles\/([^/]+)\/config$/);if(req.method==='PUT'&&m){const b=await body(req);json(res,200,await controller.selectRoleConfig(decodeURIComponent(m[2]!),b.config,decodeURIComponent(m[1]!)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/roles\/([^/]+)\/config$/);if(req.method==='PUT'&&m){const b=await body(req);json(res,200,await controller.selectRoleConfig(decodeURIComponent(m[2]!),b.config,undefined,decodeURIComponent(m[1]!)));return;}
    m=path.match(/^\/api\/projects\/([^/]+)\/tasks$/);if(req.method==='POST'&&m){const b=await body(req);json(res,201,await controller.createTask(decodeURIComponent(m[1]!),String(b.title??'')));return;}
    m=path.match(/^\/api\/tasks\/([^/]+)\/runs$/);if(req.method==='POST'&&m){json(res,201,await controller.createRun(decodeURIComponent(m[1]!)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/guidance$/);if(req.method==='POST'&&m){const b=await body(req);json(res,201,await controller.addGuidance(decodeURIComponent(m[1]!),String(b.text??'')));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/orchestrator$/);if(req.method==='POST'&&m){const b=await body(req);json(res,201,await controller.orchestrate(decodeURIComponent(m[1]!),String(b.prompt??'')));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/orchestrator\/follow-up$/);if(req.method==='POST'&&m){const b=await body(req);json(res,201,await controller.followUpOrchestrator(decodeURIComponent(m[1]!),String(b.prompt??'')));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/worker-dispatch$/);if(req.method==='POST'&&m){const b=await body(req);json(res,201,await controller.dispatchWorkerProposal(decodeURIComponent(m[1]!),String(b.proposalId??'')));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/worker-retry$/);if(req.method==='POST'&&m){const b=await body(req);json(res,201,await controller.retryWorkerProposal(decodeURIComponent(m[1]!),String(b.proposalId??'')));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/guidance\/checkpoint$/);if(req.method==='POST'&&m){json(res,200,await controller.deliverGuidanceCheckpoint(decodeURIComponent(m[1]!)));return;}
    m=path.match(/^\/api\/guidance\/([^/]+)\/ack$/);if(req.method==='POST'&&m){const b=await body(req);json(res,200,await controller.acknowledgeGuidance(decodeURIComponent(m[1]!),b.acknowledgment));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/assignments$/);if(req.method==='POST'&&m){const b=await body(req);json(res,201,await controller.assign(decodeURIComponent(m[1]!),String(b.roleId??''),String(b.prompt??''),b.config));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/sessions\/(planner|orchestrator)\/rotate$/);if(req.method==='POST'&&m){json(res,200,await controller.rotateSession(decodeURIComponent(m[1]!),m[2]!));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/reviews$/);if(req.method==='POST'&&m){json(res,201,await controller.addReview(decodeURIComponent(m[1]!),await body(req)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/validation$/);if(req.method==='POST'&&m){json(res,201,await controller.recordValidation(decodeURIComponent(m[1]!),await body(req)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/workspace$/);if(req.method==='POST'&&m){const b=await body(req);json(res,200,await controller.prepareWorkerWorkspace(decodeURIComponent(m[1]!),String(b.baseCommit??'')));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/worker-evidence$/);if(req.method==='POST'&&m){const b=await body(req);json(res,200,await controller.verifyWorkerOutput(decodeURIComponent(m[1]!),String(b.assignmentId??'')));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/validation\/retry$/);if(req.method==='POST'&&m){json(res,200,await controller.retryValidation(decodeURIComponent(m[1]!)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/reviewer$/);if(req.method==='POST'&&m){const b=await body(req);if(b.action==='recommendation')json(res,200,await controller.recordReviewerRecommendation(decodeURIComponent(m[1]!),String(b.assignmentId??'')));else json(res,201,await controller.requestReviewer(decodeURIComponent(m[1]!)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/reviewer\/retry$/);if(req.method==='POST'&&m){await controller.retryReviewer(decodeURIComponent(m[1]!));json(res,200,{ok:true});return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/approve$/);if(req.method==='POST'&&m){json(res,200,await controller.approveRun(decodeURIComponent(m[1]!),await body(req)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/promotion$/);if(req.method==='POST'&&m){json(res,200,await controller.promoteRun(decodeURIComponent(m[1]!),await body(req)));return;}
    m=path.match(/^\/api\/assignments\/([^/]+)\/cancel$/);if(req.method==='POST'&&m){json(res,200,await controller.cancelAssignment(decodeURIComponent(m[1]!)));return;}
    m=path.match(/^\/api\/assignments\/([^/]+)\/refresh$/);if(req.method==='POST'&&m){json(res,200,await controller.refreshAssignment(decodeURIComponent(m[1]!)));return;}
    if(req.method==='GET'&&(path==='/'||!path.startsWith('/api/'))){const root=uiRoot;const requested=path==='/'?'index.html':decodeURIComponent(path.slice(1));const candidate=resolve(root,requested);if(candidate!==root&&!candidate.startsWith(`${root}${sep}`)){json(res,403,{error:'Forbidden'});return;}try{if(!(await stat(candidate)).isFile())throw new Error();const content=await readFile(candidate);res.writeHead(200,{'content-type':mime(extname(candidate)),'cache-control':'no-cache'});res.end(content);return;}catch{const index=await readFile(resolve(root,'index.html')).catch(()=>undefined);if(index){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache'});res.end(index);return;}}}
    json(res,404,{error:'Not found'});
  } catch(e) {const err=e as Error&{statusCode?:number};json(res,err.statusCode??400,{error:err.message});}
});
await store.load();
await controller.refreshDiscovery();
await controller.recover();
setInterval(()=>{void controller.reconcileRunning();},5000).unref();
server.listen(config.port,config.host,()=>process.stdout.write(`Foreman listening on http://${config.host}:${config.port}\n`));

function mime(ext:string):string{return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'})[ext]??'application/octet-stream';}
