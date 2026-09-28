import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const NAMES = ['FOREMAN_WORKSPACE_BRIDGE_TOKEN', 'FOREMAN_WORKSPACE_BRIDGE_URL'];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = Object.fromEntries(NAMES.map(name => [name, process.env[name]])); for (const name of NAMES) delete process.env[name]; });
afterEach(() => { for (const name of NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

describe('FOREMAN_WORKSPACE_BRIDGE_TOKEN', () => {
  it('is optional and absent by default', () => {
    expect(loadConfig().workspaceBridgeToken).toBeUndefined();
    process.env.FOREMAN_WORKSPACE_BRIDGE_TOKEN = '   ';
    expect(loadConfig().workspaceBridgeToken).toBeUndefined();
  });

  it('is read, trimmed, alongside the external bridge URL', () => {
    process.env.FOREMAN_WORKSPACE_BRIDGE_URL = 'http://127.0.0.1:8787';
    process.env.FOREMAN_WORKSPACE_BRIDGE_TOKEN = '  s3cret-Token_1  ';
    expect(loadConfig()).toMatchObject({ workspaceBridgeUrl: 'http://127.0.0.1:8787', workspaceBridgeToken: 's3cret-Token_1' });
  });

  it('requires the bridge URL it belongs to', () => {
    process.env.FOREMAN_WORKSPACE_BRIDGE_TOKEN = 'orphan-token';
    expect(() => loadConfig()).toThrow('FOREMAN_WORKSPACE_BRIDGE_TOKEN requires FOREMAN_WORKSPACE_BRIDGE_URL');
  });

  it('rejects a value that cannot be a header token, without echoing it', () => {
    process.env.FOREMAN_WORKSPACE_BRIDGE_URL = 'http://127.0.0.1:8787';
    for (const bad of ['has a space', 'tab\there', 'café', 'x'.repeat(513)]) {
      process.env.FOREMAN_WORKSPACE_BRIDGE_TOKEN = bad;
      let message = '';
      try { loadConfig(); } catch (error) { message = (error as Error).message; }
      expect(message).toBe('FOREMAN_WORKSPACE_BRIDGE_TOKEN must be 1-512 printable ASCII characters without spaces');
    }
  });
});
