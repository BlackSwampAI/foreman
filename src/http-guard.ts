import type { IncomingMessage } from 'node:http';

export interface HostPolicy { bindHost:string; port:number }
export type GuardRequest={method?:string;headers:Pick<IncomingMessage['headers'],'host'|'origin'|'sec-fetch-site'>;socket:unknown};
export type OriginFailure='not-same-origin'|'host'|'invalid-origin';

export function firstHeader(value:string|string[]|undefined):string|undefined{return Array.isArray(value)?value[0]:value;}

export function isAllowedForemanHost(authority:string,policy:HostPolicy):boolean{
  if(!Number.isSafeInteger(policy.port)||policy.port<1||policy.port>65535)return false;
  let url:URL;try{url=new URL(`http://${authority}`);}catch{return false;}
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash)return false;
  const port=Number(url.port||80);if(port!==policy.port)return false;
  const normalize=(host:string)=>host.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
  const hostname=normalize(url.hostname),bind=normalize(policy.bindHost);
  const allowed=new Set([bind]);
  // The default loopback bind is commonly reached by either spelling in a browser.
  if(['127.0.0.1','localhost','::1'].includes(bind)){allowed.add('127.0.0.1');allowed.add('localhost');allowed.add('::1');}
  // Wildcard binds still accept the loopback names, but no arbitrary DNS host.
  if(['0.0.0.0','::'].includes(bind)){allowed.add('127.0.0.1');allowed.add('localhost');allowed.add('::1');}
  return allowed.has(hostname);
}

/** Why a request is not a same-origin browser request to Foreman's own host, or undefined when it is. */
export function sameOriginFailure(req:GuardRequest,policy:HostPolicy):OriginFailure|undefined{
  const host=firstHeader(req.headers.host),origin=firstHeader(req.headers.origin),fetchSite=firstHeader(req.headers['sec-fetch-site']);
  if(!host||!origin||fetchSite&&fetchSite!=='same-origin')return 'not-same-origin';
  if(!isAllowedForemanHost(host,policy))return 'host';
  let originUrl:URL;try{originUrl=new URL(origin);}catch{return 'invalid-origin';}
  const expectedProtocol=(req.socket as import('node:tls').TLSSocket).encrypted?'https:':'http:';
  if(originUrl.host.toLowerCase()!==host.toLowerCase()||originUrl.protocol!==expectedProtocol)return 'not-same-origin';
  return undefined;
}

/**
 * Request-wide CSRF and DNS-rebinding guard. Every request must carry Foreman's own Host
 * (a rebound attacker hostname is refused), and every non-GET/HEAD request must also be
 * same-origin. Returns the 403 error message, or undefined when the request may proceed.
 */
export function guardRequest(req:GuardRequest,policy:HostPolicy):string|undefined{
  const host=firstHeader(req.headers.host);
  if(!host||!isAllowedForemanHost(host,policy))return 'Foreman only accepts requests addressed to its configured local host and port.';
  if(req.method==='GET'||req.method==='HEAD')return undefined;
  if(sameOriginFailure(req,policy))return 'Foreman only accepts state-changing requests from its own origin.';
  return undefined;
}
