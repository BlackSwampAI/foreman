import { describe, expect, it } from 'vitest';
import { guardRequest, isAllowedForemanHost } from '../src/http-guard.js';

const policy = { bindHost: '127.0.0.1', port: 4399 };
const req = (method: string, headers: Record<string, string> = {}, socket: unknown = {}) => ({ method, headers: { host: '127.0.0.1:4399', ...headers }, socket });
const sameOrigin = { origin: 'http://127.0.0.1:4399', 'sec-fetch-site': 'same-origin' };

describe('request guard: Host', () => {
  it('rejects a foreign Host on GET (DNS rebinding)', () => {
    expect(guardRequest(req('GET', { host: 'attacker.example:4399' }), policy)).toMatch(/configured local host and port/);
    expect(guardRequest(req('HEAD', { host: 'attacker.example:4399' }), policy)).toBeDefined();
  });
  it('rejects a missing or malformed Host', () => {
    expect(guardRequest({ method: 'GET', headers: {}, socket: {} }, policy)).toBeDefined();
    expect(guardRequest(req('GET', { host: 'a b' }), policy)).toBeDefined();
    expect(guardRequest(req('GET', { host: 'user@127.0.0.1:4399' }), policy)).toBeDefined();
  });
  it('accepts the loopback aliases on the configured port', () => {
    for (const host of ['127.0.0.1:4399', 'localhost:4399', 'LOCALHOST:4399', '[::1]:4399']) expect(guardRequest(req('GET', { host }), policy), host).toBeUndefined();
  });
  it('rejects the wrong port', () => {
    for (const host of ['127.0.0.1:4400', 'localhost:80', 'localhost', '[::1]:1']) expect(guardRequest(req('GET', { host }), policy), host).toBeDefined();
  });
  it('accepts loopback names for a wildcard bind but not arbitrary hosts', () => {
    const wildcard = { bindHost: '0.0.0.0', port: 4399 };
    expect(guardRequest(req('GET', { host: 'localhost:4399' }), wildcard)).toBeUndefined();
    expect(guardRequest(req('GET', { host: 'evil.example:4399' }), wildcard)).toBeDefined();
  });
  it('does not require Origin on GET or HEAD', () => {
    expect(guardRequest(req('GET'), policy)).toBeUndefined();
    expect(guardRequest(req('HEAD'), policy)).toBeUndefined();
    expect(isAllowedForemanHost('localhost:4399', policy)).toBe(true);
  });
});

describe('request guard: Origin on writes', () => {
  it('accepts a same-origin POST, with or without Sec-Fetch-Site', () => {
    expect(guardRequest(req('POST', sameOrigin), policy)).toBeUndefined();
    expect(guardRequest(req('POST', { origin: 'http://127.0.0.1:4399' }), policy)).toBeUndefined();
    expect(guardRequest(req('DELETE', { host: 'localhost:4399', origin: 'http://localhost:4399' }), policy)).toBeUndefined();
    expect(guardRequest(req('PUT', { host: '[::1]:4399', origin: 'http://[::1]:4399' }), policy)).toBeUndefined();
  });
  it('rejects a cross-origin POST even when it needs no preflight', () => {
    expect(guardRequest(req('POST', { origin: 'http://attacker.example', 'content-type': 'text/plain' }), policy)).toMatch(/own origin/);
    expect(guardRequest(req('POST', { origin: 'http://127.0.0.1:4400' }), policy)).toBeDefined();
    expect(guardRequest(req('POST', { origin: 'http://localhost:4399' }), policy)).toBeDefined();
  });
  it('rejects a POST without Origin', () => {
    expect(guardRequest(req('POST'), policy)).toMatch(/own origin/);
    expect(guardRequest(req('DELETE'), policy)).toBeDefined();
    expect(guardRequest(req('PATCH'), policy)).toBeDefined();
  });
  it('rejects a write whose Sec-Fetch-Site is not same-origin', () => {
    for (const site of ['cross-site', 'same-site', 'none']) expect(guardRequest(req('POST', { ...sameOrigin, 'sec-fetch-site': site }), policy), site).toBeDefined();
  });
  it('rejects a malformed or scheme-mismatched Origin', () => {
    expect(guardRequest(req('POST', { origin: 'null' }), policy)).toBeDefined();
    expect(guardRequest(req('POST', { origin: 'https://127.0.0.1:4399' }), policy)).toBeDefined();
    expect(guardRequest(req('POST', { origin: 'http://127.0.0.1:4399' }, { encrypted: true }), policy)).toBeDefined();
    expect(guardRequest(req('POST', { origin: 'https://127.0.0.1:4399' }, { encrypted: true }), policy)).toBeUndefined();
  });
  it('rejects a write with a foreign Host even if Origin matches it', () => {
    expect(guardRequest(req('POST', { host: 'attacker.example:4399', origin: 'http://attacker.example:4399', 'sec-fetch-site': 'same-origin' }), policy)).toMatch(/configured local host and port/);
  });
});
