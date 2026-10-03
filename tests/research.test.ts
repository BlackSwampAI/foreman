import { describe, expect, it, vi } from 'vitest';
import { capturePublicResearch, fetchPublicResearch, projectResearchEvidence, RESEARCH_MAX_EXCERPT_BYTES, type ResearchAddress, type ResearchHttpResponse } from '../src/research.js';

const publicDns: ResearchAddress[] = [{ address: '93.184.216.34', family: 4 }];
const response = (statusCode: number, headers: Record<string, string>, body: string, truncated = false): ResearchHttpResponse => ({ statusCode, headers, body: Buffer.from(body), truncated });

describe('bounded public research fetcher', () => {
  it('captures public JSON, selects a relevant bounded excerpt, and records provenance and digest', async () => {
    const transport = vi.fn(async () => response(200, { 'content-type': 'application/json' }, JSON.stringify({ filler: 'x'.repeat(4000), nba: { routes: ['GET /api/v1/games'] } })));
    const rows = await fetchPublicResearch([{ url: 'https://docs.example.org/api', purpose: 'route docs', searchTerms: ['GET /api/v1/games'] }], {
      resolveHost: async () => publicDns, transport, now: () => new Date('2026-10-03T15:00:00Z'),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'retrieved', statusCode: 200, requestedUrl: 'https://docs.example.org/api', finalUrl: 'https://docs.example.org/api', purpose: 'route docs', searchTerms: ['GET /api/v1/games'], retrievedAt: '2026-10-03T15:00:00.000Z', bodyDigestComplete: true, bodyTruncated: false });
    expect(rows[0]?.bodyExcerpt).toContain('GET /api/v1/games');
    expect(rows[0]?.excerptSegments[0]?.matchedTerms).toEqual(['GET /api/v1/games']);
    expect(rows[0]?.bodyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(transport).toHaveBeenCalledWith(expect.any(URL), publicDns, expect.any(Number), expect.any(Number), expect.any(AbortSignal));
  });

  it('returns complete short JSON verbatim and marks relevant terms as matched or absent', async () => {
    const raw = JSON.stringify({ routes: [{ path: '/games/live', fields: ['season', 'teamId'] }] });
    const [short] = await fetchPublicResearch([{ url: 'https://api.example.org/routes' }], { resolveHost: async () => publicDns, transport: async () => response(200, { 'content-type': 'application/json' }, raw) });
    expect(short?.bodyExcerpt).toBe(raw);
    expect(short?.bodyExcerptComplete).toBe(true);
    expect(JSON.parse(short!.bodyExcerpt!)).toMatchObject({ routes: [{ path: '/games/live' }] });

    const long = `Example route only: GET /games/live (example)\n${'x'.repeat(6000)}\nSupported parameters for GET /games/live include season=2026 and teamId=4.`;
    const [selected] = await fetchPublicResearch([{ url: 'https://api.example.org/routes', searchTerms: ['GET /games/live', 'Supported parameters', 'not-present'] }], { resolveHost: async () => publicDns, maxExcerptBytes:1_200, transport: async () => response(200, { 'content-type': 'text/plain' }, long) });
    expect(selected?.bodyExcerpt).toContain('Example route only');
    expect(selected?.bodyExcerpt).toContain('Supported parameters');
    expect(selected?.bodyExcerpt).toContain('season=2026');
    expect(selected).toMatchObject({ matchedSearchTerms: ['GET /games/live', 'Supported parameters'], unmatchedSearchTerms: ['not-present'], bodyExcerptComplete: false, excerptTruncated: true });
    expect(selected?.excerptSegments.length).toBeGreaterThan(1);
  });

  it('extracts visible documentation sections instead of navigation and preserves raw source offsets', async () => {
    const html='<!doctype html><html><body><nav><a>GET /v2/state</a><a>players</a></nav><div class="sidebar"><a>GET /v2/state</a><a>Table of contents</a></div><main><div><h1>State API</h1><p>Example: GET /v2/state (overview).</p><section><h2>Parameters</h2><p>Supported parameters include season=2026 and leagueId.</p></section></div></main><footer>Navigation footer</footer></body></html>';
    const [row]=await fetchPublicResearch([{url:'https://docs.example.org/reference',searchTerms:['Supported parameters','leagueId']}],{resolveHost:async()=>publicDns,transport:async()=>response(200,{'content-type':'text/html'},html)});
    expect(row?.excerptMode).toBe('html_visible_text');
    expect(row?.bodyExcerpt).toContain('Supported parameters include season=2026');
    expect(row?.bodyExcerpt).not.toContain('Navigation footer');
    expect(row?.bodyExcerpt).not.toContain('GET /v2/state</a>');
    expect(row?.bodyExcerpt).not.toContain('Table of contents');
    expect(row?.excerptSegments[0]?.sourceStartChar).toBeGreaterThan(html.indexOf('<main>'));
    expect(row?.bodyExcerptComplete).toBe(false);
  });

  it('summarizes late JSON field distributions and emits only complete returned-record samples', async () => {
    const players:Record<string,unknown>={};
    for(let i=0;i<1_500;i++)players[`filler-${i}`]={description:'x'.repeat(600)};
    for(let i=0;i<500;i++)players[`player-${i}`]={player_id:String(i),active:i%3!==0,position:i%4===0?'PG':i%4===1?'SG':'C',fantasy_positions:['PG','UTIL'],description:'x'.repeat(600)};
    const body=JSON.stringify(players);expect(Buffer.byteLength(body)).toBeGreaterThan(1_000_000);
    const [row]=await fetchPublicResearch([{url:'https://api.example.org/players?active=true&position=PG',searchTerms:['active position distribution']}],{resolveHost:async()=>publicDns,transport:async()=>response(200,{'content-type':'application/json'},body)});
    expect(row).toMatchObject({excerptMode:'json_structured',bodyDigestComplete:true,bodyTruncated:false,bodyExcerptComplete:false});
    expect(row?.jsonObservations).toMatchObject({rootType:'object',topLevelEntryCount:2_000,objectRecords:2_000,recordsScanned:2_000,scanComplete:true,queryParameters:[{name:'active',value:'true'},{name:'position',value:'PG'}]});
    const active=row?.jsonObservations?.fields.find(field=>field.path==='/active');
    const position=row?.jsonObservations?.fields.find(field=>field.path==='/position');
    expect(active?.recordsPresent).toBe(500);expect(active?.valueCounts).toContainEqual({value:'true',count:333});expect(active?.queryValueRecords).toBe(333);
    expect(position?.valueCounts).toEqual(expect.arrayContaining([{value:'"PG"',count:125},{value:'"SG"',count:125},{value:'"C"',count:250}]));expect(position?.queryValueRecords).toBe(125);
    expect(row?.bodyExcerpt).toContain('does not establish API contract or server-side filter behavior');
    for(const segment of row?.excerptSegments??[]){const sample=row!.bodyExcerpt!.slice(segment.startChar,segment.endChar);expect(()=>JSON.parse(sample.slice(sample.indexOf('{')))).not.toThrow();}
    expect(Buffer.byteLength(row?.bodyExcerpt??'')).toBeLessThanOrEqual(RESEARCH_MAX_EXCERPT_BYTES);
  });

  it('reprojects a cached capture for new terms without a second request or false new retrieval time', async () => {
    const transport=vi.fn(async()=>response(200,{'content-type':'text/plain'},'First section alpha.\n'.padEnd(2_000,'x')+'Later section beta endpoint.'));
    const request={url:'https://docs.example.org/reference',searchTerms:['alpha']};
    const [capture]=await capturePublicResearch([request],{resolveHost:async()=>publicDns,transport,now:()=>new Date('2026-10-03T15:00:00Z')});
    expect(await capturePublicResearch([],{maxTotalBytes:0})).toEqual([]);
    const first=projectResearchEvidence(request,capture!);
    const second=projectResearchEvidence({...request,searchTerms:['beta endpoint']},capture!,{reusedCapture:true});
    expect(transport).toHaveBeenCalledTimes(1);expect(second.retrievedAt).toBe(first.retrievedAt);expect(second.bodyDigest).toBe(first.bodyDigest);
    expect(second.bodyExcerpt).toContain('beta endpoint');expect(second.searchTerms).toEqual(['beta endpoint']);expect(second.reusedCapture).toBe(true);
  });

  it('deduplicates repeated URLs within one research batch while retaining each term selection', async () => {
    const transport=vi.fn(async()=>response(200,{'content-type':'text/plain'},'Alpha is the first section. Beta describes another endpoint.'));
    const rows=await fetchPublicResearch([{url:'https://docs.example.org/ref',searchTerms:['Alpha']},{url:'https://docs.example.org/ref',searchTerms:['Beta']}],{resolveHost:async()=>publicDns,transport});
    expect(transport).toHaveBeenCalledTimes(1);expect(rows[0]?.bodyExcerpt).toContain('Alpha');expect(rows[1]?.bodyExcerpt).toContain('Beta');expect(rows[1]?.reusedCapture).toBe(true);expect(rows[0]?.retrievedAt).toBe(rows[1]?.retrievedAt);expect(rows[0]?.bodyDigest).toBe(rows[1]?.bodyDigest);
  });

  it('rejects credentials, non-HTTPS, nonstandard ports, and local addresses before transport', async () => {
    const transport = vi.fn();
    const urls = ['http://docs.example.org/', 'https://user:pass@docs.example.org/', 'https://docs.example.org:8443/', 'https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data/', 'https://metadata.google.internal/'];
    for (const url of urls) {
      const [row] = await fetchPublicResearch([{ url }], { resolveHost: async () => publicDns, transport: transport as never });
      expect(row?.outcome).toBe('fetch_error');
      expect(row?.error).toBeTruthy();
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('blocks any private, reserved, or mixed DNS answer before connecting', async () => {
    for (const addresses of [
      [{ address: '10.1.2.3', family: 4 as const }],
      [{ address: '93.184.216.34', family: 4 as const }, { address: '192.168.1.4', family: 4 as const }],
      [{ address: '2001:db8::1', family: 6 as const }],
      [{ address: '2001::1', family: 6 as const }],
      [{ address: '::1', family: 6 as const }],
    ]) {
      const transport = vi.fn();
      const [row] = await fetchPublicResearch([{ url: 'https://public.example.org/' }], { resolveHost: async () => addresses, transport: transport as never });
      expect(row?.outcome).toBe('fetch_error');
      expect(row?.error).toMatch(/non-public|invalid/);
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it('revalidates redirects and refuses a redirect to a private destination', async () => {
    const transport = vi.fn(async () => response(302, { location: 'https://169.254.169.254/latest/meta-data/' }, ''));
    const [row] = await fetchPublicResearch([{ url: 'https://public.example.org/start' }], { resolveHost: async () => publicDns, transport });
    expect(row?.outcome).toBe('fetch_error');
    expect(row?.error).toMatch(/public host|globally routable/);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('re-resolves and pins each public redirect target, preserving final URL provenance', async () => {
    const v6:ResearchAddress={address:'2606:4700:4700::1111',family:6};
    const resolveHost = vi.fn(async (hostname: string) => hostname === 'one.example.org' ? [v6,...publicDns] : [v6,{ address: '1.1.1.1', family: 4 as const }]);
    const transport = vi.fn(async (url: URL, _addresses: readonly ResearchAddress[]) => url.hostname === 'one.example.org'
      ? response(302, { location: 'https://two.example.org/routes' }, '')
      : response(200, { 'content-type': 'text/plain' }, 'Routes: GET /v1/player'));
    const [row] = await fetchPublicResearch([{ url: 'https://one.example.org/' }], { resolveHost, transport });
    expect(row).toMatchObject({ outcome: 'retrieved', finalUrl: 'https://two.example.org/routes', statusCode: 200 });
    expect(resolveHost).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0]?.[1][0]?.family).toBe(4);
  });

  it('caps request count and excerpt/body sizes while reporting truncation honestly', async () => {
    await expect(fetchPublicResearch(Array.from({ length: 7 }, (_, i) => ({ url: `https://docs${i}.example.org/` })))).rejects.toThrow(/At most/);
    const [row] = await fetchPublicResearch([{ url: 'https://docs.example.org/', searchTerms: ['TARGET'] }], {
      resolveHost: async () => publicDns,
      maxBytes: 10_000,
      maxExcerptBytes: 200,
      transport: async () => response(200, { 'content-type': 'text/plain' }, `${'a'.repeat(9000)}TARGET${'b'.repeat(1000)}`, true),
    });
    expect(row?.capturedBytes).toBe(10_000);
    expect(row?.bodyTruncated).toBe(true);
    expect(row?.bodyDigestComplete).toBe(false);
    expect(Buffer.byteLength(row?.bodyExcerpt ?? '')).toBeLessThanOrEqual(1_200);
    expect(Buffer.byteLength(row?.bodyExcerpt ?? '')).toBeLessThanOrEqual(RESEARCH_MAX_EXCERPT_BYTES);
  });

  it('rejects an insufficient cumulative response-byte budget before any GET is sent', async () => {
    const transport=vi.fn(async()=>response(200,{'content-type':'text/plain'},'x'));
    await expect(fetchPublicResearch([{url:'https://a.example.org/'},{url:'https://b.example.org/'}],{maxTotalBytes:1,resolveHost:async()=>publicDns,transport})).rejects.toThrow(/at least one byte per response.*No requests were sent/i);
    await expect(fetchPublicResearch([{url:'https://a.example.org/'}],{maxTotalBytes:0,resolveHost:async()=>publicDns,transport})).rejects.toThrow(/No requests were sent/i);
    expect(transport).not.toHaveBeenCalled();
  });

  it('returns bounded HTTP and transport errors without promoting them to evidence of success', async () => {
    const [http] = await fetchPublicResearch([{ url: 'https://docs.example.org/missing' }], { resolveHost: async () => publicDns, transport: async () => response(404, { 'content-type': 'text/plain' }, 'not found') });
    expect(http).toMatchObject({ outcome: 'http_error', statusCode: 404, error: 'Public HTTPS request returned HTTP 404' });
    const [failure] = await fetchPublicResearch([{ url: 'https://docs.example.org/' }], { resolveHost: async () => publicDns, transport: async () => { throw new Error('ECONNRESET\nsecret'); } });
    expect(failure?.outcome).toBe('fetch_error');
    expect(failure?.error).toBe('ECONNRESET secret');
  });

  it('does not claim a complete text excerpt for a non-text payload', async () => {
    const [row] = await fetchPublicResearch([{ url: 'https://docs.example.org/file' }], { resolveHost: async () => publicDns, transport: async () => ({ statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from([0, 1, 2, 3]), truncated: false }) });
    expect(row).toMatchObject({ outcome: 'retrieved', bodyExcerptComplete: false, excerptTruncated: false, excerptUnavailableReason: 'Response content type is not text or JSON', bodyDigestComplete: true });
    expect(row?.bodyExcerpt).toBeUndefined();
  });

  it('uses one wall-clock timeout across resolution and transport, including a hung resolver', async () => {
    const never = new Promise<never>(() => {});
    const [row] = await fetchPublicResearch([{ url: 'https://docs.example.org/' }], { timeoutMs: 20, resolveHost: () => never });
    expect(row?.outcome).toBe('fetch_error');
    expect(row?.error).toBe('Public research request timed out');
  });

  it('redacts sensitive URL query parameters and never lets an empty DNS set connect', async () => {
    const transport = vi.fn();
    const [row] = await fetchPublicResearch([{ url: 'https://docs.example.org/?api_key=do-not-leak&version=v2' }], { resolveHost: async () => [], transport: transport as never });
    expect(row?.requestedUrl).toContain('api_key=%5Bredacted%5D');
    expect(row?.requestedUrl).not.toContain('do-not-leak');
    expect(row?.error).toMatch(/credential query/);
    expect(transport).not.toHaveBeenCalled();
  });
});
