import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { createHash } from 'node:crypto';
import { getResearchLimits } from './research-limits.js';

export interface ResearchRequest { url:string; purpose?:string; searchTerms?:string[] }
export interface ResearchEvidence {
  id?:string;
  requestedByAssignmentId?:string;
  requestedUrl:string;
  finalUrl?:string;
  purpose?:string;
  searchTerms:string[];
  matchedSearchTerms:string[];
  unmatchedSearchTerms:string[];
  retrievedAt:string;
  outcome:'retrieved'|'http_error'|'fetch_error';
  statusCode?:number;
  contentType?:string;
  bodyExcerpt?:string;
  excerptTruncated:boolean;
  bodyExcerptComplete:boolean;
  excerptUnavailableReason?:string;
  capturedBytes?:number;
  bodyDigest?:string;
  bodyDigestComplete:boolean;
  bodyTruncated:boolean;
  excerptMode?:'raw_text'|'html_visible_text'|'json_structured';
  reusedCapture?:boolean;
  jsonObservations?:JsonObservations;
  excerptSegments:Array<{startChar:number;endChar:number;sourceStartChar?:number;sourceEndChar?:number;sourcePath?:string;matchedTerms:string[]}>;
  error?:string;
}
export interface JsonObservations {
  rootType:'array'|'object'|'primitive'; topLevelEntryCount:number; objectRecords:number; recordsScanned:number; scanComplete:boolean;
  queryParameters:Array<{name:string;value:string}>;
  fields:Array<{path:string;recordsPresent:number;valueCounts:Array<{value:string;count:number}>;queryValue?:string;queryValueRecords?:number}>;
  samplePaths:string[];
}
export interface ResearchCapture {
  cacheKey:string;
  requestedUrl:string;
  finalUrl?:string;
  retrievedAt:string;
  outcome:'retrieved'|'http_error'|'fetch_error';
  statusCode?:number;
  contentType?:string;
  body:Uint8Array;
  bodyDigest:string;
  bodyDigestComplete:boolean;
  bodyTruncated:boolean;
  error?:string;
}
export interface ResearchAddress { address:string; family:4|6 }
export interface ResearchHttpResponse { statusCode:number; headers:Record<string,string>; body:Uint8Array; truncated:boolean }
export interface ResearchOptions {
  resolveHost?:(hostname:string,signal:AbortSignal)=>Promise<readonly ResearchAddress[]>;
  transport?:(url:URL,addresses:readonly ResearchAddress[],maxBytes:number,timeoutMs:number,signal:AbortSignal)=>Promise<ResearchHttpResponse>;
  now?:()=>Date;
  timeoutMs?:number;
  maxBytes?:number;
  maxExcerptBytes?:number;
  maxTotalBytes?:number;
}

export const RESEARCH_MAX_REQUESTS=6;
export const RESEARCH_MAX_REDIRECTS=3;
export const RESEARCH_TIMEOUT_MS=15_000;
export const RESEARCH_MAX_BODY_BYTES=8*1024*1024;
export const RESEARCH_MAX_CONFIG_BODY_BYTES=64*1024*1024;
export const RESEARCH_DEFAULT_BATCH_BYTES=64*1024*1024;
export const RESEARCH_MAX_BATCH_BYTES=1024*1024*1024;
export const RESEARCH_MAX_EXCERPT_BYTES=16*1024;
export const RESEARCH_MAX_CONFIG_EXCERPT_BYTES=64*1024;
export const RESEARCH_MAX_PURPOSE_CHARS=500;
export const RESEARCH_MAX_SEARCH_TERMS=8;
export const RESEARCH_MAX_SEARCH_TERM_CHARS=160;

const REDACT_QUERY_KEY=/(?:token|secret|password|passwd|api[_-]?key|authorization|auth)/i;
const REDACTED='[redacted]';

/**
 * Fetches bounded pieces of public, read-only evidence. This transport never
 * accepts credentials, headers, request bodies, or methods from the caller.
 * DNS answers are validated and the HTTPS socket is pinned to one validated IP.
 */
export async function fetchPublicResearch(requests:ResearchRequest[],options:ResearchOptions={}):Promise<ResearchEvidence[]> {
  const max=getResearchLimits().network.maximumRequestsPerBatch;
  if(!Array.isArray(requests)||requests.length>max)throw new Error(`At most ${max} public research requests are allowed per batch`);
  const captures=await capturePublicResearch(requests,options);
  const seen=new Set<string>();
  return requests.map((request,index)=>{const key=publicResearchCacheKey(request.url)??'';const reused=!!key&&seen.has(key);if(key)seen.add(key);return projectResearchEvidence(request,captures[index]!,{maxExcerptBytes:options.maxExcerptBytes,reusedCapture:reused});});
}

export function publicResearchCacheKey(rawUrl:string):string|undefined {
  try{return validatePublicHttpsUrl(rawUrl).toString();}catch{return undefined;}
}

/** Fetch each distinct normalized public URL at most once. Captures are ephemeral raw response bytes. */
export async function capturePublicResearch(requests:ResearchRequest[],options:ResearchOptions={}):Promise<ResearchCapture[]> {
  const limits=getResearchLimits().network,max=limits.maximumRequestsPerBatch;
  if(!Array.isArray(requests)||requests.length>max)throw new Error(`At most ${max} public research requests are allowed per batch`);
  const requestedTimeout=Number.isFinite(options.timeoutMs)?Number(options.timeoutMs):limits.timeoutMs;
  const timeout=Math.max(1,Math.min(limits.maximumTimeoutMs,requestedTimeout));
  const perResponse=Math.max(1,Math.min(limits.maximumResponseBytes,options.maxBytes??limits.maxResponseBytes));
  const requestedTotal=options.maxTotalBytes??limits.defaultTotalResponseBytes;
  if(!Number.isSafeInteger(requestedTotal)||requestedTotal<0)throw new Error('Public research total byte budget must be a non-negative whole number');
  const total=Math.min(limits.maximumTotalResponseBytes,requestedTotal);
  const unique=new Map<string,ResearchRequest>();
  for(const request of requests){const key=publicResearchCacheKey(request?.url);if(key&&!unique.has(key))unique.set(key,request);}
  if(unique.size>0&&total<unique.size)throw Object.assign(new Error(`Public research byte budget has ${total} byte(s) for ${unique.size} unique URL(s); at least one byte per response is required. No requests were sent.`),{statusCode:429});
  const remainingForCapture=unique.size?Math.floor(total/unique.size):0;
  const captures=new Map<string,ResearchCapture>();
  await Promise.all([...unique.entries()].map(async([key,request])=>captures.set(key,await fetchCapture(request,key,options,{timeout,perResponse:Math.min(perResponse,remainingForCapture)}))));
  return requests.map(request=>{const key=publicResearchCacheKey(request?.url);if(key)return captures.get(key)!;let reason='Public research URL is invalid';try{validatePublicHttpsUrl(request?.url);}catch(error){reason=safeError(error);}return failedCapture(request?.url,nowDate(options).toISOString(),reason);});
}

/** Projects a bounded, search-term-specific view from an ephemeral fetched response. */
export function projectResearchEvidence(request:ResearchRequest,capture:ResearchCapture,options:Pick<ResearchOptions,'maxExcerptBytes'>&{reusedCapture?:boolean}={}):ResearchEvidence {
  const safeRequested=safeRecordedUrl(request?.url),purpose=typeof request?.purpose==='string'?request.purpose.slice(0,RESEARCH_MAX_PURPOSE_CHARS):undefined,searchTerms=cleanSearchTerms(request?.searchTerms);
  const evidenceBase={requestedUrl:safeRequested,...(purpose?{purpose}:{}),searchTerms,matchedSearchTerms:[] as string[],unmatchedSearchTerms:[...searchTerms],excerptSegments:[] as ResearchEvidence['excerptSegments']};
  if(capture.outcome==='fetch_error')return {...evidenceBase,retrievedAt:capture.retrievedAt,outcome:'fetch_error',excerptTruncated:false,bodyExcerptComplete:false,bodyDigestComplete:false,bodyTruncated:false,error:capture.error??'Public research request failed'};
  const textual=isTextualContentType(capture.contentType),text=textual?new TextDecoder('utf-8').decode(capture.body):'';
  const limits=getResearchLimits().network;
  const maxExcerpt=Math.max(1,Math.min(limits.maximumExcerptBytes,options.maxExcerptBytes??limits.defaultExcerptBytes));
  const excerpt=selectBodyExcerpt(text,capture.contentType??'',capture.requestedUrl,searchTerms,maxExcerpt,capture.bodyTruncated);
  const matched=excerpt.matched;
  return {...evidenceBase,matchedSearchTerms:matched,unmatchedSearchTerms:searchTerms.filter(term=>!matched.some(value=>value.toLocaleLowerCase()===term.toLocaleLowerCase())),...(capture.finalUrl?{finalUrl:capture.finalUrl}:{}),retrievedAt:capture.retrievedAt,outcome:capture.outcome,statusCode:capture.statusCode,...(capture.contentType?{contentType:capture.contentType}:{}),...(excerpt.text?{bodyExcerpt:excerpt.text}:{}),excerptMode:excerpt.mode,...(excerpt.jsonObservations?{jsonObservations:excerpt.jsonObservations}:{}),excerptTruncated:excerpt.truncated,bodyExcerptComplete:textual&&!capture.bodyTruncated&&!excerpt.truncated&&excerpt.mode==='raw_text',...(!textual&&capture.body.byteLength?{excerptUnavailableReason:'Response content type is not text or JSON'}:{}),capturedBytes:capture.body.byteLength,bodyDigest:capture.bodyDigest,bodyDigestComplete:capture.bodyDigestComplete,bodyTruncated:capture.bodyTruncated,excerptSegments:excerpt.segments,...(capture.error?{error:capture.error}:{}),...(capture.outcome==='http_error'?{error:capture.error??`Public HTTPS request returned HTTP ${capture.statusCode}`}:{}),...(options.reusedCapture?{reusedCapture:true}:{})};
}

function nowDate(options:ResearchOptions):Date{return (options.now??(()=>new Date()))();}

async function fetchCapture(request:ResearchRequest,cacheKey:string,options:ResearchOptions,bounds:{timeout:number;perResponse:number}):Promise<ResearchCapture> {
  const requestedUrl=safeRecordedUrl(request?.url),now=nowDate(options),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),bounds.timeout);timer.unref?.();const began=Date.now();
  try {
    let url=validatePublicHttpsUrl(request?.url),response:ResearchHttpResponse|undefined;
    for(let hop=0;hop<=RESEARCH_MAX_REDIRECTS;hop++){
      assertTimeRemaining(began,bounds.timeout,controller.signal);
      const addresses=await withAbort((options.resolveHost??resolvePublicAddresses)(url.hostname,controller.signal),controller.signal);
      assertTimeRemaining(began,bounds.timeout,controller.signal);validateAddressSet(addresses);
      const remaining=Math.max(1,bounds.timeout-(Date.now()-began)),pinnedAddresses=[...addresses].sort((a,b)=>a.family===b.family?0:a.family===4?-1:1);
      response=await withAbort((options.transport??pinnedHttpsGet)(url,pinnedAddresses,bounds.perResponse,remaining,controller.signal),controller.signal);
      assertTimeRemaining(began,bounds.timeout,controller.signal);
      const encoding=header(response.headers,'content-encoding');if(encoding&&encoding.toLowerCase()!=='identity')throw new Error('Public research response uses an unsupported content encoding');
      if(!isRedirect(response.statusCode))break;const location=header(response.headers,'location');if(!location)break;if(hop===RESEARCH_MAX_REDIRECTS)throw new Error('Public research redirect limit exceeded');url=validatePublicHttpsUrl(new URL(location,url));
    }
    if(!response)throw new Error('Public research request returned no response');
    const body=Buffer.from(response.body).subarray(0,bounds.perResponse),truncated=response.truncated||response.body.byteLength>body.byteLength,contentType=header(response.headers,'content-type')?.slice(0,200),bodyDigest=createHash('sha256').update(body).digest('hex'),outcome=response.statusCode>=200&&response.statusCode<300?'retrieved':'http_error';
    return {cacheKey,requestedUrl,finalUrl:safeRecordedUrl(url.toString()),retrievedAt:now.toISOString(),outcome,statusCode:response.statusCode,...(contentType?{contentType}:{}),body,bodyDigest,bodyDigestComplete:!truncated,bodyTruncated:truncated,...(outcome==='http_error'?{error:`Public HTTPS request returned HTTP ${response.statusCode}`}:{})};
  } catch(error) {return failedCapture(requestedUrl,now.toISOString(),controller.signal.aborted?'Public research request timed out':safeError(error),cacheKey);}
  finally {clearTimeout(timer);}
}

function failedCapture(requestedUrl:string,retrievedAt:string,error:string,cacheKey=publicResearchCacheKey(requestedUrl)??'[invalid URL]'):ResearchCapture{return {cacheKey,requestedUrl:safeRecordedUrl(requestedUrl),retrievedAt,outcome:'fetch_error',body:new Uint8Array(),bodyDigest:createHash('sha256').update(new Uint8Array()).digest('hex'),bodyDigestComplete:false,bodyTruncated:false,error};}

function validatePublicHttpsUrl(input:string|URL):URL {
  let url:URL;
  try{url=input instanceof URL?new URL(input.toString()):new URL(input);}catch{throw new Error('Public research URL is invalid');}
  if(url.protocol!=='https:')throw new Error('Public research allows HTTPS URLs only');
  if(url.username||url.password)throw new Error('Public research URLs cannot include credentials');
  if(url.port&&url.port!=='443')throw new Error('Public research allows the standard HTTPS port only');
  for(const key of url.searchParams.keys())if(REDACT_QUERY_KEY.test(key))throw new Error('Public research URL cannot include credential query parameters');
  if(url.hash)url.hash='';
  const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'');
  if(!host||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||host.endsWith('.test')||host.endsWith('.invalid')||host.endsWith('.example')||(!isIP(host)&&!host.includes('.')))throw new Error('Public research URL must use a public host');
  if(isIP(host)&&!isPublicAddress(host))throw new Error('Public research URL must use a globally routable host');
  return url;
}

async function resolvePublicAddresses(hostname:string,signal:AbortSignal):Promise<readonly ResearchAddress[]> {
  if(signal.aborted)throw new Error('Public research request timed out');
  const bare=hostname.replace(/^\[|\]$/g,'');
  if(isIP(bare))return [{address:bare,family:isIP(bare) as 4|6}];
  const results=await lookup(bare,{all:true,verbatim:true});
  if(signal.aborted)throw new Error('Public research request timed out');
  return results.map(value=>({address:value.address,family:value.family as 4|6}));
}

function validateAddressSet(addresses:readonly ResearchAddress[]):void {
  if(!Array.isArray(addresses)||!addresses.length||addresses.length>32)throw new Error('Public research host did not resolve to a bounded set of addresses');
  for(const item of addresses){
    if(!item||isIP(item.address)!==item.family||!isPublicAddress(item.address))throw new Error('Public research host resolved to a non-public or invalid address');
  }
}

function isPublicAddress(address:string):boolean {
  const family=isIP(address);
  if(family===4){
    const n=address.split('.').map(Number);if(n.length!==4||n.some(x=>!Number.isInteger(x)||x<0||x>255))return false;
    const [a,b,c]=n as [number,number,number,number];
    if(a===0||a===10||a===127||a>=224)return false;
    if(a===100&&b>=64&&b<=127)return false;
    if(a===169&&b===254)return false;
    if(a===172&&b>=16&&b<=31)return false;
    if(a===192&&(b===0||b===168||b===88&&c===99))return false;
    if(a===198&&(b===18||b===19||b===51&&c===100))return false;
    if(a===203&&b===0&&c===113)return false;
    return true;
  }
  if(family!==6||address.includes('%'))return false;
  const value=ipv6BigInt(address);if(value===undefined)return false;
  const prefix=(value>>125n); // Global unicast allocation is 2000::/3.
  if(prefix!==1n)return false;
  if((value>>96n)===0x20010db8n)return false; // Documentation prefix.
  if((value>>105n)===0x100080n)return false; // 2001::/23 protocol assignments, including Teredo.
  if((value>>108n)===0x3fff0n)return false; // 3fff::/20 documentation prefix.
  if((value>>112n)===0x2002n)return false; // 6to4 embeds IPv4 addresses.
  return true;
}

function ipv6BigInt(input:string):bigint|undefined {
  let value=input.toLowerCase();
  if(value.includes('.')){
    const lastColon=value.lastIndexOf(':');if(lastColon<0)return;
    const ipv4=value.slice(lastColon+1),parts=ipv4.split('.').map(Number);if(parts.length!==4||parts.some(x=>!Number.isInteger(x)||x<0||x>255))return;
    const high=((parts[0]!<<8)|parts[1]!).toString(16),low=((parts[2]!<<8)|parts[3]!).toString(16);
    value=`${value.slice(0,lastColon)}:${high}:${low}`;
  }
  const halves=value.split('::');if(halves.length>2)return;
  const left=halves[0]?halves[0]!.split(':'):[],right=halves.length===2&&halves[1]?halves[1]!.split(':'):[];
  if(left.concat(right).some(p=>! /^[0-9a-f]{1,4}$/.test(p)))return;
  let groups:string[];
  if(halves.length===1){if(left.length!==8)return;groups=left;}
  else {const zeros=8-left.length-right.length;if(zeros<1)return;groups=[...left,...Array(zeros).fill('0'),...right];}
  return groups.reduce((acc,group)=>(acc<<16n)|BigInt(`0x${group}`),0n);
}

async function pinnedHttpsGet(url:URL,addresses:readonly ResearchAddress[],maxBytes:number,timeoutMs:number,signal:AbortSignal):Promise<ResearchHttpResponse> {
  const address=addresses[0]!;
  return new Promise((resolvePromise,reject)=>{
    let settled=false;const finish=(error?:Error,response?:ResearchHttpResponse)=>{if(settled)return;settled=true;signal.removeEventListener('abort',onAbort);if(error)reject(error);else resolvePromise(response!);};
    const onAbort=()=>{request.destroy(new Error('Public research request timed out'));finish(new Error('Public research request timed out'));};
    const request=httpsRequest({hostname:address.address,family:address.family,port:443,method:'GET',path:`${url.pathname}${url.search}`,servername:url.hostname.replace(/^\[|\]$/g,''),headers:{host:url.host,'accept':'application/json, text/plain, text/html;q=0.8, */*;q=0.1','accept-encoding':'identity','user-agent':'Foreman-ReadOnly-Research/1.0'},agent:false,timeout:timeoutMs},response=>{
      const chunks:Buffer[]=[];let size=0,truncated=false;const headers=headersToRecord(response.headers);
      response.on('data',(chunk:Buffer)=>{if(settled)return;const remaining=maxBytes-size;if(remaining<=0){truncated=true;response.destroy();finish(undefined,{statusCode:response.statusCode??0,headers,body:Buffer.concat(chunks),truncated});return;}const part=chunk.subarray(0,remaining);chunks.push(part);size+=part.length;if(part.length<chunk.length){truncated=true;response.destroy();finish(undefined,{statusCode:response.statusCode??0,headers,body:Buffer.concat(chunks),truncated});}});
      response.on('end',()=>finish(undefined,{statusCode:response.statusCode??0,headers,body:Buffer.concat(chunks),truncated}));
      response.on('error',error=>{if(truncated)finish(undefined,{statusCode:response.statusCode??0,headers,body:Buffer.concat(chunks),truncated:true});else finish(error);});
    });
    request.on('timeout',()=>request.destroy(new Error('Public research request timed out')));
    request.on('error',error=>finish(error));
    signal.addEventListener('abort',onAbort,{once:true});
    if(signal.aborted)onAbort();else request.end();
  });
}

function headersToRecord(headers:IncomingHttpHeaders):Record<string,string>{const result:Record<string,string>={};for(const [key,value] of Object.entries(headers))if(typeof value==='string')result[key.toLowerCase()]=value;else if(Array.isArray(value))result[key.toLowerCase()]=value.join(', ');return result;}
function header(headers:Record<string,string>,name:string):string|undefined{return headers[name.toLowerCase()];}
function isRedirect(status:number):boolean{return [301,302,303,307,308].includes(status);}
function isTextualContentType(type:string|undefined):boolean{return !!type&&(/^(?:text\/|application\/(?:json|[^;]+\+json|xml|[^;]+\+xml))/i.test(type));}
function safeError(error:unknown):string{const raw=error instanceof Error?error.message:'Public research request failed';return raw.replace(/[\r\n\t]+/g,' ').slice(0,300)||'Public research request failed';}
function safeRecordedUrl(raw:unknown):string {if(typeof raw!=='string')return '[invalid URL]';try{const url=new URL(raw);url.username='';url.password='';url.hash='';for(const key of [...url.searchParams.keys()])if(REDACT_QUERY_KEY.test(key))url.searchParams.set(key,REDACTED);return url.toString().slice(0,2_000);}catch{return '[invalid URL]';}}
function cleanSearchTerms(input:unknown):string[]{if(!Array.isArray(input))return [];return input.filter((x):x is string=>typeof x==='string'&&!!x.trim()).slice(0,RESEARCH_MAX_SEARCH_TERMS).map(x=>x.trim().slice(0,RESEARCH_MAX_SEARCH_TERM_CHARS));}
function assertTimeRemaining(start:number,timeout:number,signal:AbortSignal):void{if(signal.aborted||Date.now()-start>=timeout)throw new Error('Public research request timed out');}
function withAbort<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{if(signal.aborted)return Promise.reject(new Error('Public research request timed out'));return new Promise((resolvePromise,reject)=>{const onAbort=()=>{cleanup();reject(new Error('Public research request timed out'));};const cleanup=()=>signal.removeEventListener('abort',onAbort);signal.addEventListener('abort',onAbort,{once:true});promise.then(value=>{cleanup();resolvePromise(value);},error=>{cleanup();reject(error);});});}

type Excerpt={text:string;segments:ResearchEvidence['excerptSegments'];truncated:boolean;matched:string[];mode:NonNullable<ResearchEvidence['excerptMode']>;jsonObservations?:JsonObservations};
type VisibleProjection={text:string;map:Array<{start:number;end:number;sourceStart:number;sourceEnd:number}>};

function selectBodyExcerpt(text:string,contentType:string,requestedUrl:string,terms:string[],maxBytes:number,bodyTruncated:boolean):Excerpt {
  if(!text)return {text:'',segments:[],truncated:false,matched:[],mode:'raw_text'};
  if(/json/i.test(contentType)&&!bodyTruncated){try{const parsed=JSON.parse(text) as unknown;if(Buffer.byteLength(text,'utf8')<=maxBytes)return {text,segments:[{startChar:0,endChar:text.length,sourceStartChar:0,sourceEndChar:text.length,matchedTerms:terms.filter(term=>text.toLocaleLowerCase().includes(term.toLocaleLowerCase()))}],truncated:false,matched:terms.filter(term=>text.toLocaleLowerCase().includes(term.toLocaleLowerCase())),mode:'raw_text'};return selectJsonObservation(parsed,requestedUrl,terms,maxBytes,text);}catch{}}
  if(/html/i.test(contentType)){
    const projection=visibleHtmlProjection(text),selected=selectExcerpt(projection.text,terms,maxBytes,'html_visible_text');
    selected.segments=selected.segments.map(segment=>{const sourceStart=mapProjectedOffset(projection.map,segment.sourceStartChar??0,'start'),sourceEnd=mapProjectedOffset(projection.map,segment.sourceEndChar??0,'end');return {...segment,sourceStartChar:sourceStart,sourceEndChar:sourceEnd};});
    if(projection.text.length!==text.length)selected.truncated=true;
    return selected;
  }
  return selectExcerpt(text,terms,maxBytes,'raw_text');
}

function selectJsonObservation(root:unknown,requestedUrl:string,terms:string[],maxBytes:number,rawText:string):Excerpt {
  const url=new URL(requestedUrl),query=[...url.searchParams.entries()],isArray=Array.isArray(root),rootRecord=root!==null&&typeof root==='object'&&!isArray?root as Record<string,unknown>:undefined;
  const entries:Array<[string,unknown]>=isArray?root.map((value,index)=>[String(index),value]):rootRecord?Object.entries(rootRecord):[];
  const records=entries.filter(([,value])=>value!==null&&typeof value==='object'),fieldNames=new Set<string>(query.map(([key])=>key.toLowerCase()));
  for(const term of terms)for(const token of term.match(/[A-Za-z_][A-Za-z0-9_]*/g)??[])if(token.length>2)fieldNames.add(token.toLowerCase());
  type Stat={records:Set<number>;values:Map<string,number>;queryMatches:Map<string,Set<number>>};const stats=new Map<string,Stat>();
  const queryByName=new Map<string,string[]>();for(const [key,value] of query){const k=key.toLowerCase();queryByName.set(k,[...(queryByName.get(k)??[]),value]);}
  const scanRecord=(value:unknown,recordIndex:number)=>{const stack:Array<{value:unknown;path:string;depth:number}>=[{value,path:'',depth:0}];while(stack.length){const current=stack.pop()!;if(current.depth>6||!current.value||typeof current.value!=='object')continue;const children=Array.isArray(current.value)?current.value.map((v,i)=>[String(i),v] as [string,unknown]):Object.entries(current.value as Record<string,unknown>);for(const [key,item] of children){const path=`${current.path}/${escapeJsonPointer(key)}`,lower=key.toLowerCase();if(fieldNames.has(lower)){let stat=stats.get(path);if(!stat){stat={records:new Set(),values:new Map(),queryMatches:new Map()};stats.set(path,stat);}stat.records.add(recordIndex);for(const label of new Set(jsonValueLabels(item)))stat.values.set(label,(stat.values.get(label)??0)+1);for(const expected of queryByName.get(lower)??[]){if(valueMatches(item,expected)){let set=stat.queryMatches.get(expected);if(!set){set=new Set();stat.queryMatches.set(expected,set);}set.add(recordIndex);}}}if(item&&typeof item==='object')stack.push({value:item,path,depth:current.depth+1});}}};
  const recordLimit=500_000,scanned=Math.min(records.length,recordLimit);for(let i=0;i<scanned;i++)scanRecord(records[i]![1],i);
  const rawLower=rawText.toLowerCase(),matched=terms.filter(term=>rawLower.includes(term.toLowerCase())),sorted=[...stats.entries()].sort(([a],[b])=>a.localeCompare(b));
  const fields:JsonObservations['fields']=sorted.slice(0,24).map(([path,stat])=>{const key=path.split('/').at(-1)??path,queryRow=query.find(([name])=>name.toLowerCase()===key.toLowerCase());return {path,recordsPresent:stat.records.size,valueCounts:[...stat.values].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,12).map(([value,count])=>({value,count})),...(queryRow?{queryValue:queryRow[1],queryValueRecords:stat.queryMatches.get(queryRow[1])?.size??0}:{})};});
  const observations:JsonObservations={rootType:isArray?'array':rootRecord?'object':'primitive',topLevelEntryCount:entries.length,objectRecords:records.length,recordsScanned:scanned,scanComplete:scanned===records.length,queryParameters:query.map(([name,value])=>({name,value})),fields,samplePaths:[]};
  const queryNames=[...new Set(query.map(([key])=>key.toLowerCase()))];let matching:[string,unknown]|undefined,other:[string,unknown]|undefined;
  for(const record of records){const isMatch=queryNames.length>0&&queryNames.every(name=>queryByName.get(name)!.every(v=>recordHasValue(record[1],name,v)));if(isMatch&&!matching)matching=record;if(queryNames.length&&!isMatch&&!other)other=record;if(matching&&other)break;}
  const samples=[matching,other].filter((x):x is [string,unknown]=>!!x),sampleText:string[]=[],segments:ResearchEvidence['excerptSegments']=[];for(const sample of samples){const path=`/${escapeJsonPointer(sample[0])}`,full=JSON.stringify(sample[1]),json=Buffer.byteLength(full,'utf8')<=Math.min(8_192,Math.floor(maxBytes/3))?full:JSON.stringify(projectJsonSample(sample[1],fieldNames));const projected=json!==full;if(Buffer.byteLength(json,'utf8')>Math.min(8_192,Math.floor(maxBytes/3)))continue;sampleText.push(`${projected?'Projected':'Complete'} returned record JSON Pointer ${path}${projected?' (selected fields only; omitted fields are marked)':''}: ${json}`);observations.samplePaths.push(path);}
  const lines=[`JSON STRUCTURAL OBSERVATION (derived from captured JSON; does not establish API contract or server-side filter behavior).`,`Root ${observations.rootType}; ${entries.length} top-level entries; ${records.length} object records; scanned ${scanned}${observations.scanComplete?' (complete)':' (scan capped)'}.`,`Requested query: ${query.length?query.map(([k,v])=>`${k}=${v}`).join('&'):'(none)'}.`,`Field paths are relative to each top-level object record; counts aggregate across scanned records.`];
  for(const field of fields)lines.push(`Field ${field.path}: present in ${field.recordsPresent}/${scanned} scanned records; values ${field.valueCounts.map(x=>`${x.value} (${x.count})`).join(', ')||'(none)'}${field.queryValue!==undefined?`; records containing requested value ${field.queryValue}: ${field.queryValueRecords}`:''}.`);
  const summary=lines.join('\n'),reserved=sampleText.join('\n').length+2,summaryBudget=Math.max(0,maxBytes-Math.min(reserved,Math.floor(maxBytes/2)));let excerpt=boundedUtf8(summary,summaryBudget),truncated=excerpt.length<summary.length;
  for(const sample of sampleText){const append=`\n${sample}`;if(Buffer.byteLength(excerpt+append,'utf8')>maxBytes)continue;const start=excerpt.length+1;excerpt+=append;const path=observations.samplePaths[segments.length]??'';segments.push({startChar:start,endChar:excerpt.length,sourcePath:path,matchedTerms:query.map(([key])=>key)});}
  return {text:excerpt,segments,truncated:truncated||Buffer.byteLength(rawText,'utf8')>maxBytes,matched,mode:'json_structured',jsonObservations:observations};
}

function valueMatches(value:unknown,expected:string):boolean {const values=Array.isArray(value)?value:[value];return values.some(item=>String(item).toLowerCase()===expected.toLowerCase());}
function projectJsonSample(value:unknown,fieldNames:Set<string>):unknown {if(!value||typeof value!=='object'||Array.isArray(value))return value;const source=value as Record<string,unknown>,selected:Record<string,unknown>={_foremanProjection:'selected fields only',_omittedFields:true};for(const [key,item] of Object.entries(source)){const lower=key.toLowerCase();if(fieldNames.has(lower)||/^(?:id|key|player_id|name|type)$/i.test(key))selected[key]=item;}return selected;}
function recordHasValue(record:unknown,key:string,expected:string):boolean {const stack:Array<{value:unknown;depth:number}>=[{value:record,depth:0}];while(stack.length){const current=stack.pop()!;if(current.depth>6||!current.value||typeof current.value!=='object')continue;const items=Array.isArray(current.value)?current.value.map((value,index)=>[String(index),value] as [string,unknown]):Object.entries(current.value as Record<string,unknown>);for(const [name,value] of items){if(name.toLowerCase()===key){const values=Array.isArray(value)?value:[value];if(values.some(item=>String(item).toLowerCase()===expected.toLowerCase()))return true;}if(value&&typeof value==='object')stack.push({value,depth:current.depth+1});}}return false;}
function keyInObject(record:unknown,term:string):boolean {const tokens=(term.match(/[A-Za-z_][A-Za-z0-9_]*/g)??[]).map(value=>value.toLocaleLowerCase());if(!tokens.length||!record||typeof record!=='object')return false;const keys=Object.keys(record as object).map(value=>value.toLocaleLowerCase());return tokens.some(token=>keys.includes(token));}
function jsonValueLabels(value:unknown):string[] {const values=Array.isArray(value)?value:[value];return values.map(item=>{if(item===null)return 'null';if(typeof item==='string')return JSON.stringify(item.slice(0,80));if(typeof item==='number'||typeof item==='boolean')return String(item);return Array.isArray(item)?`[${item.length} items]`:'{object}';}).slice(0,32);}
function escapeJsonPointer(value:string):string{return value.replace(/~/g,'~0').replace(/\//g,'~1');}

function visibleHtmlProjection(source:string):VisibleProjection {
  const primaryRanges=htmlPrimaryRanges(source),usePrimary=primaryRanges.length>0,allowed=(index:number)=>!usePrimary||primaryRanges.some(range=>index>=range.start&&index<range.end);
  const skipNames=new Set(['script','style','noscript','svg','template','nav','header','footer']),voidNames=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  const tagRegex=/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>/g;let match:RegExpExecArray|null,last=0,skipDepth=0;const stack:Array<{name:string;skip:boolean}>=[];const chunks:Array<{text:string;start:number;end:number}> = [];
  while((match=tagRegex.exec(source))){if(skipDepth===0&&allowed(last)&&match.index>last)chunks.push({text:source.slice(last,match.index),start:last,end:match.index});const tag=match[0],name=(tag.match(/^<\/?\s*([a-zA-Z0-9-]+)/)?.[1]??'').toLowerCase(),closing=/^<\//.test(tag),selfClosing=/\/\s*>$/.test(tag),navigationLike=/\b(?:class|id)\s*=\s*["'][^"']*(?:sidebar|side-nav|toc|table-of-contents|navigation|navbar|menu)[^"']*["']/i.test(tag)||/\brole\s*=\s*["']navigation["']/i.test(tag),skip=skipNames.has(name)||navigationLike;if(name){if(closing){const found=stack.map(row=>row.name).lastIndexOf(name);if(found>=0){for(const popped of stack.splice(found)){if(popped.skip)skipDepth=Math.max(0,skipDepth-1);}}}else if(!selfClosing&&!voidNames.has(name)){stack.push({name,skip});if(skip)skipDepth++;}}last=tagRegex.lastIndex;}
  if(skipDepth===0&&allowed(last)&&last<source.length)chunks.push({text:source.slice(last),start:last,end:source.length});
  let text='',map:VisibleProjection['map']=[];for(const chunk of chunks){const pieces=decodeHtmlChunk(chunk.text,chunk.start);if(!pieces.length)continue;if(text&&!/\s$/.test(text)&&!/^[\s.,;:!?)}\]]/.test(pieces[0]!.text)){text+=' ';map.push({start:text.length-1,end:text.length,sourceStart:chunk.start,sourceEnd:chunk.start});}for(const piece of pieces){const start=text.length;text+=piece.text;map.push({start,end:text.length,sourceStart:piece.sourceStart,sourceEnd:piece.sourceEnd});}}
  return {text,map};
}
function htmlPrimaryRanges(source:string):Array<{start:number;end:number}>{const ranges:Array<{start:number;end:number}>=[],tagRegex=/<\/?([a-zA-Z][\w:-]*)\b([^>]*)>/g,voidNames=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);let match:RegExpExecArray|null;const stack:Array<{name:string;start:number;primary:boolean}>=[];while((match=tagRegex.exec(source))){const name=match[1]!.toLowerCase(),attrs=match[2]??'',closing=match[0].startsWith('</'),primary=name==='main'||name==='article'||/\brole\s*=\s*["']main["']/i.test(attrs)||/\b(?:id|class)\s*=\s*["'][^"']*(?:main-content|article-content|doc-content|documentation-content)[^"']*["']/i.test(attrs);if(closing){const index=stack.map(row=>row.name).lastIndexOf(name);if(index>=0){for(const row of stack.splice(index)){if(row.primary)ranges.push({start:row.start,end:match.index});}}}else if(!voidNames.has(name)&&!/\/\s*>$/.test(match[0]))stack.push({name,start:tagRegex.lastIndex,primary});}for(const row of stack)if(row.primary)ranges.push({start:row.start,end:source.length});return ranges;}
function decodeHtmlChunk(raw:string,sourceStart:number):Array<{text:string;sourceStart:number;sourceEnd:number}>{const out:Array<{text:string;sourceStart:number;sourceEnd:number}>=[],entity=/&(?:#\d+|#x[\da-f]+|amp|lt|gt|quot|apos|nbsp);/gi;let last=0,match:RegExpExecArray|null;while((match=entity.exec(raw))){if(match.index>last)out.push({text:raw.slice(last,match.index),sourceStart:sourceStart+last,sourceEnd:sourceStart+match.index});const decoded=decodeEntity(match[0]);out.push({text:decoded,sourceStart:sourceStart+match.index,sourceEnd:sourceStart+entity.lastIndex});last=entity.lastIndex;}if(last<raw.length)out.push({text:raw.slice(last),sourceStart:sourceStart+last,sourceEnd:sourceStart+raw.length});return out;}
function decodeEntity(entity:string):string {const lower=entity.toLowerCase();const named:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '};if(named[lower])return named[lower]!;if(lower.startsWith('&#x')){const value=Number.parseInt(lower.slice(3,-1),16);return Number.isFinite(value)&&value>0&&value<=0x10ffff?String.fromCodePoint(value):entity;}if(lower.startsWith('&#')){const value=Number.parseInt(lower.slice(2,-1),10);return Number.isFinite(value)&&value>0&&value<=0x10ffff?String.fromCodePoint(value):entity;}return entity;}
function mapProjectedOffset(map:VisibleProjection['map'],offset:number,boundary:'start'|'end'):number {if(!map.length)return 0;let low=0,high=map.length-1;while(low<high){const mid=(low+high)>>1;if(map[mid]!.end<offset)low=mid+1;else high=mid;}const piece=map[low]??map.at(-1)!;return boundary==='start'?piece.sourceStart:piece.sourceEnd;}

function selectExcerpt(text:string,terms:string[],maxBytes:number,mode:Excerpt['mode']='raw_text'):Excerpt {
  if(!text||maxBytes<=0)return {text:'',segments:[],truncated:text.length>0,matched:[],mode};
  const lower=text.toLocaleLowerCase(),matched=terms.filter(term=>lower.includes(term.toLocaleLowerCase()));
  if(Buffer.byteLength(text,'utf8')<=maxBytes)return {text,segments:[{startChar:0,endChar:text.length,sourceStartChar:0,sourceEndChar:text.length,matchedTerms:matched}],truncated:false,matched,mode};
  const candidates:Array<{start:number;end:number;matched:string[];score:number}>=[];
  const add=(position:number,term:string)=>{const start=Math.max(0,position-220),end=Math.min(text.length,position+term.length+420),window=text.slice(start,end),included=terms.filter(candidate=>window.toLocaleLowerCase().includes(candidate.toLocaleLowerCase()));if(candidates.some(item=>start<=item.end&&end>=item.start)){const prior=candidates.find(item=>start<=item.end&&end>=item.start)!;prior.start=Math.min(prior.start,start);prior.end=Math.max(prior.end,end);prior.matched=[...new Set([...prior.matched,...included])];prior.score=prior.matched.length;return;}candidates.push({start,end,matched:included.length?included:[term],score:included.length});};
  for(const term of terms){const needle=term.toLocaleLowerCase();if(!needle)continue;const positions:number[]=[];let index=0;while((index=lower.indexOf(needle,index))>=0){positions.push(index);index+=Math.max(1,needle.length);}if(positions.length){const take=Math.min(12,positions.length);for(let i=0;i<take;i++){const selected=Math.round(i*(positions.length-1)/Math.max(1,take-1));add(positions[selected]!,term);}}}
  if(!candidates.length)candidates.push({start:0,end:text.length,matched:[],score:0});
  const chosen:Array<typeof candidates[number]>=[],remaining=[...candidates],covered=new Set<string>();let budget=maxBytes;
  while(remaining.length){remaining.sort((a,b)=>{const newA=a.matched.filter(term=>!covered.has(term.toLocaleLowerCase())).length,newB=b.matched.filter(term=>!covered.has(term.toLocaleLowerCase())).length;return newB-newA||b.score-a.score||Math.abs(a.start-text.length/2)-Math.abs(b.start-text.length/2)||a.start-b.start;});const next=remaining.shift()!,label=`[selected text chars ${next.start}-${next.end}; matches: ${next.matched.join(', ')||'prefix'}]\n`,cost=Buffer.byteLength(label,'utf8')+Buffer.byteLength(text.slice(next.start,next.end),'utf8');if(cost>budget){const labelBytes=Buffer.byteLength(label,'utf8'),slice=boundedUtf8(text.slice(next.start,next.end),Math.max(0,budget-labelBytes));if(slice)chosen.push({...next,end:next.start+slice.length});break;}chosen.push(next);budget-=cost;for(const term of next.matched)covered.add(term.toLocaleLowerCase());if(budget<100)break;}
  chosen.sort((a,b)=>a.start-b.start);let excerpt='',segments:ResearchEvidence['excerptSegments']=[];for(const range of chosen){const label=`[selected text chars ${range.start}-${range.end}; matches: ${range.matched.join(', ')||'prefix'}]\n`,available=maxBytes-Buffer.byteLength(excerpt,'utf8')-Buffer.byteLength(label,'utf8');if(available<=0)break;const slice=boundedUtf8(text.slice(range.start,range.end),available);if(!slice)break;const start=excerpt.length+label.length;excerpt+=label+slice;segments.push({startChar:start,endChar:excerpt.length,sourceStartChar:range.start,sourceEndChar:range.start+slice.length,matchedTerms:range.matched});}
  return {text:excerpt,segments,truncated:chosen.length<candidates.length||segments.some(segment=>segment.sourceStartChar!==0||segment.sourceEndChar!==text.length),matched,mode};
}
function boundedUtf8(value:string,maxBytes:number):string {if(maxBytes<=0)return '';const bytes=Buffer.from(value,'utf8');if(bytes.byteLength<=maxBytes)return value;let end=maxBytes;while(end>0&&(bytes[end]!&0xc0)===0x80)end--;return bytes.subarray(0,end).toString('utf8');}
