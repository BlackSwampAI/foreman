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

describe('FOREMAN_FORMAT_COMMAND', () => {
  const saved = process.env.FOREMAN_FORMAT_COMMAND;
  afterEach(() => { if (saved === undefined) delete process.env.FOREMAN_FORMAT_COMMAND; else process.env.FOREMAN_FORMAT_COMMAND = saved; });

  it('is optional, parsed as one command and offline unless network is true', () => {
    delete process.env.FOREMAN_FORMAT_COMMAND;
    expect(loadConfig().formatCommand).toBeUndefined();
    process.env.FOREMAN_FORMAT_COMMAND = JSON.stringify({ name: 'Format', command: 'pnpm', args: ['run', 'format'] });
    expect(loadConfig().formatCommand).toEqual({ name: 'Format', command: 'pnpm', args: ['run', 'format'], network: false });
    process.env.FOREMAN_FORMAT_COMMAND = JSON.stringify({ name: 'Format', command: 'pnpm', args: ['install'], network: true });
    expect(loadConfig().formatCommand?.network).toBe(true);
  });

  it('rejects anything that is not a command object', () => {
    for (const bad of ['[]', '"pnpm"', 'not json', JSON.stringify({ command: 'pnpm', args: [] }), JSON.stringify({ name: 'F', command: 'pnpm', args: [], network: 'yes' })]) {
      process.env.FOREMAN_FORMAT_COMMAND = bad;
      expect(() => loadConfig(), bad).toThrow('FOREMAN_FORMAT_COMMAND must be a JSON object');
    }
  });
});
