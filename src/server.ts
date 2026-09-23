import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { Controller } from './controller.js';
import { JsonStore } from './store.js';
import { UhpClient } from './uhp.js';

const config=loadConfig();
const store=new JsonStore(resolve(config.dataDir,'state.json'));
const uhpToken=process.env.UHP_TOKEN;
const uhp=uhpToken && config.uhpBaseUrl ? new UhpClient({baseUrl:config.uhpBaseUrl,token:uhpToken,timeoutMs:config.requestTimeoutMs}) : {
  async submit():Promise<never>{throw new Error('UHP is not configured (set UHP_BASE_URL and UHP_TOKEN)');},
  async cancel():Promise<never>{throw new Error('UHP is not configured (set UHP_BASE_URL and UHP_TOKEN)');}
};
const controller=new Controller(store,uhp);
const body=async(req:IncomingMessage):Promise<any>=>{let data='';for await(const chunk of req)data+=chunk;if(data.length>1_000_000)throw Object.assign(new Error('Request body too large'),{statusCode:413});return data?JSON.parse(data):{};};
const json=(res:ServerResponse,status:number,data:unknown)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
const server=createServer(async(req,res)=>{
  const url=new URL(req.url??'/',`http://${req.headers.host??'localhost'}`), path=url.pathname;
  try {
    if(req.method==='GET'&&path==='/api/state'){json(res,200,await controller.state());return;}
    if(req.method==='GET'&&path==='/api/events'){
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','access-control-allow-origin':'*'});
      let last=Number(req.headers['last-event-id']??url.searchParams.get('after')??0);
      const send=async()=>{const state=await controller.state();for(let i=last;i<state.events.length;i++){const e=state.events[i]!;last=i+1;res.write(`id: ${last}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);}};
      await send(); const timer=setInterval(()=>{void send().catch(()=>undefined);},1000); req.on('close',()=>clearInterval(timer)); return;
    }
    if(req.method==='POST'&&path==='/api/projects'){const b=await body(req);json(res,201,await controller.createProject(String(b.name??'')));return;}
    let m=path.match(/^\/api\/projects\/([^/]+)\/tasks$/);if(req.method==='POST'&&m){const b=await body(req);json(res,201,await controller.createTask(decodeURIComponent(m[1]!),String(b.title??'')));return;}
    m=path.match(/^\/api\/tasks\/([^/]+)\/runs$/);if(req.method==='POST'&&m){json(res,201,await controller.createRun(decodeURIComponent(m[1]!)));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/guidance$/);if(req.method==='POST'&&m){const b=await body(req);json(res,201,await controller.addGuidance(decodeURIComponent(m[1]!),String(b.text??'')));return;}
    m=path.match(/^\/api\/guidance\/([^/]+)\/ack$/);if(req.method==='POST'&&m){const b=await body(req);json(res,200,await controller.acknowledgeGuidance(decodeURIComponent(m[1]!),b.acknowledgment));return;}
    m=path.match(/^\/api\/runs\/([^/]+)\/assignments$/);if(req.method==='POST'&&m){const b=await body(req);json(res,201,await controller.assign(decodeURIComponent(m[1]!),String(b.roleId??''),String(b.prompt??''),b.config));return;}
    m=path.match(/^\/api\/assignments\/([^/]+)\/cancel$/);if(req.method==='POST'&&m){json(res,200,await controller.cancelAssignment(decodeURIComponent(m[1]!)));return;}
    json(res,404,{error:'Not found'});
  } catch(e) {const err=e as Error&{statusCode?:number};json(res,err.statusCode??400,{error:err.message});}
});
await store.load();
await controller.recover();
server.listen(config.port,config.host,()=>process.stdout.write(`Foreman listening on http://${config.host}:${config.port}\n`));
