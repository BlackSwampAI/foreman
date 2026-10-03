export type GithubRequestTicket={runId:string;epoch:number;request:number};
export type GithubRequestFeedback<T>={value?:T;stale:boolean;error:string;updatedAt?:string;attemptedAt?:string;message?:string};

export function githubRequestSucceeded<T>(previous:GithubRequestFeedback<T>,value:T,updatedAt:string,message?:string):GithubRequestFeedback<T>{
  return {value,stale:false,error:'',updatedAt,attemptedAt:updatedAt,message:message??(JSON.stringify(previous.value)===JSON.stringify(value)?'GitHub status refreshed; no changes were reported.':'GitHub status refreshed with updated information.')};
}
export function githubRequestFailed<T>(previous:GithubRequestFeedback<T>,error:unknown,attemptedAt:string):GithubRequestFeedback<T>{
  return {...previous,stale:true,error:error instanceof Error?error.message:String(error),attemptedAt};
}

export function assertGithubStatusUsable<T extends {available:boolean;account?:string;message?:string;remoteBranchStatus?:string}>(previous:T|undefined,next:T):void{
  if(!next.available&&previous)throw new Error(next.message??'GitHub status could not be refreshed. Check repository access and GitHub authentication.');
  if(previous?.account&&!next.account)throw new Error(next.message??'GitHub authentication could not be verified. Run `gh auth login`, then refresh GitHub status.');
  if(previous?.remoteBranchStatus&&previous.remoteBranchStatus!=='unavailable'&&next.remoteBranchStatus==='unavailable')throw new Error(next.message??'The remote branch could not be checked. Verify GitHub access, then refresh status.');
}

/** Keeps async GitHub results scoped to the exact selected-run generation. */
export class GithubRequestGate {
  private selectedRunId?:string;
  private epoch=0;
  private request=0;
  private active?:GithubRequestTicket;

  select(runId?:string):void {
    if(this.selectedRunId===runId)return;
    this.selectedRunId=runId;
    this.epoch++;
    this.request++;
    this.active=undefined;
  }

  begin(runId:string):GithubRequestTicket|undefined {
    if(this.selectedRunId!==runId||this.active)return undefined;
    const ticket={runId,epoch:this.epoch,request:++this.request};
    this.active=ticket;
    return ticket;
  }

  isCurrent(ticket:GithubRequestTicket):boolean {
    return this.selectedRunId===ticket.runId&&this.epoch===ticket.epoch&&this.active===ticket;
  }

  finish(ticket:GithubRequestTicket):boolean {
    if(!this.isCurrent(ticket))return false;
    this.active=undefined;
    return true;
  }
}

export async function runGithubRequest<T>(gate:GithubRequestGate,selection:string,request:()=>Promise<T>,handlers:{
  onStart?:()=>void;
  onSuccess:(value:T)=>void;
  onError:(error:unknown)=>void;
  onFinally?:()=>void;
}):Promise<'completed'|'failed'|'ignored'|'duplicate'> {
  const ticket=gate.begin(selection);
  if(!ticket)return 'duplicate';
  handlers.onStart?.();
  let outcome:'completed'|'failed'|'ignored'='ignored';
  try{
    const value=await request();
    if(!gate.isCurrent(ticket))return 'ignored';
    handlers.onSuccess(value);outcome='completed';
  }catch(error){
    if(!gate.isCurrent(ticket))return 'ignored';
    handlers.onError(error);outcome='failed';
  }finally{
    if(gate.finish(ticket))handlers.onFinally?.();
  }
  return outcome;
}
