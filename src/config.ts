import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { defaultNetworkAccess, parseSandboxMode, type ValidationSandboxMode } from './validation-sandbox.js';

export interface ForemanConfig {
  host: string;
  port: number;
  dataDir: string;
  uhpBaseUrl?: string;
  uhpHarnessId?: string;
  uhpModel?: string;
  hindsightBaseUrl?: string;
  requestTimeoutMs: number;
  taskTimeoutMs: number;
  workerTimeoutMs: number;
  workspaceSourceRepo?: string;
  workspaceBridgeUrl?: string;
  workspaceBridgeToken?: string;
  workspaceAllowedScope: string[];
  validationCommands: Array<{name:string;command:string;args:string[];cwd?:string;network:boolean}>;
  /** Optional formatter Foreman runs over the Worker's changed files before validation; offline unless it sets network true. */
  formatCommand?: {name:string;command:string;args:string[];cwd?:string;network:boolean};
  validationTimeoutMs: number;
  validationMaxOutputBytes: number;
  validationSandbox: { mode: ValidationSandboxMode; roPaths: string[]; dataDir: string; cacheDir: string };
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function optionalHttpUrl(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  let value: URL;
  try { value = new URL(raw); } catch { throw new Error(`${name} must be an absolute HTTP URL`); }
  if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.search || value.hash) {
    throw new Error(`${name} must be an HTTP URL without credentials, query, or fragment`);
  }
  return value.toString().replace(/\/$/, '');
}

/** A bearer credential: printable ASCII without spaces, so it is always a valid header value and never needs to appear in an error. */
function optionalToken(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  if (!/^[\x21-\x7e]{1,512}$/.test(raw)) throw new Error(`${name} must be 1-512 printable ASCII characters without spaces`);
  return raw;
}

/** Load an optional local .env and validate the supported service configuration. */
export function loadConfig(): ForemanConfig {
  if (existsSync('.env')) loadEnvFile('.env');
  const uhpHarnessId = process.env.UHP_HARNESS_ID?.trim() || undefined;
  const uhpModel = process.env.UHP_MODEL?.trim() || undefined;
  if (Boolean(uhpHarnessId) !== Boolean(uhpModel)) throw new Error('UHP_HARNESS_ID and UHP_MODEL must be configured together');
  const workspaceBridgeToken = optionalToken('FOREMAN_WORKSPACE_BRIDGE_TOKEN');
  if (workspaceBridgeToken && !process.env.FOREMAN_WORKSPACE_BRIDGE_URL?.trim()) throw new Error('FOREMAN_WORKSPACE_BRIDGE_TOKEN requires FOREMAN_WORKSPACE_BRIDGE_URL');
  let validationCommands: ForemanConfig['validationCommands'] = [];
  const rawCommands=process.env.FOREMAN_VALIDATION_COMMANDS?.trim();
  if(rawCommands){try{const value=JSON.parse(rawCommands);if(!Array.isArray(value))throw new Error();validationCommands=value.map((item:unknown)=>{if(!item||typeof item!=='object')throw new Error();const x=item as Record<string,unknown>;if(typeof x.name!=='string'||!x.name.trim()||typeof x.command!=='string'||!x.command||!Array.isArray(x.args)||x.args.some(arg=>typeof arg!=='string')||(x.cwd!==undefined&&typeof x.cwd!=='string')||(x.network!==undefined&&typeof x.network!=='boolean'))throw new Error();return {name:x.name,command:x.command,args:x.args as string[],...(typeof x.cwd==='string'?{cwd:x.cwd}:{}),network:(x.network as boolean|undefined)??defaultNetworkAccess(x.command,x.args as string[])};});}catch{throw new Error('FOREMAN_VALIDATION_COMMANDS must be a JSON array of {name,command,args,cwd?,network?} where network is true or false');}}
  let formatCommand: ForemanConfig['formatCommand'];
  const rawFormat=process.env.FOREMAN_FORMAT_COMMAND?.trim();
  if(rawFormat){try{const x=JSON.parse(rawFormat) as Record<string,unknown>;if(!x||typeof x!=='object'||Array.isArray(x)||typeof x.name!=='string'||!x.name.trim()||typeof x.command!=='string'||!x.command||!Array.isArray(x.args)||x.args.some(arg=>typeof arg!=='string')||(x.cwd!==undefined&&typeof x.cwd!=='string')||(x.network!==undefined&&typeof x.network!=='boolean'))throw new Error();formatCommand={name:x.name,command:x.command,args:x.args as string[],...(typeof x.cwd==='string'?{cwd:x.cwd}:{}),network:x.network===true};}catch{throw new Error('FOREMAN_FORMAT_COMMAND must be a JSON object {name,command,args,cwd?,network?} where network is true or false');}}
  const workspaceAllowedScope=(process.env.FOREMAN_WORKSPACE_ALLOWED_SCOPE??'').split(',').map(x=>x.trim()).filter(Boolean);
  const sandboxMode = parseSandboxMode(process.env.FOREMAN_VALIDATION_SANDBOX);
  if (!sandboxMode) throw new Error('FOREMAN_VALIDATION_SANDBOX must be "bwrap" or "none"');
  if (sandboxMode === 'none') process.stderr.write('WARNING: FOREMAN_VALIDATION_SANDBOX=none: Worker-authored validation commands run directly on this host with your credentials and network access\n');
  const sandboxRoPaths = (process.env.FOREMAN_VALIDATION_SANDBOX_RO_PATHS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (sandboxRoPaths.some(path => !isAbsolute(path))) throw new Error('FOREMAN_VALIDATION_SANDBOX_RO_PATHS must be a comma-separated list of absolute paths');
  const dataDir = resolve(process.env.FOREMAN_DATA_DIR?.trim() || '.foreman-data');
  return {
    host: process.env.FOREMAN_HOST?.trim() || '127.0.0.1',
    port: integer('FOREMAN_PORT', 4399, 1, 65535),
    dataDir,
    uhpBaseUrl: optionalHttpUrl('UHP_BASE_URL'),
    uhpHarnessId,
    uhpModel,
    hindsightBaseUrl: optionalHttpUrl('HINDSIGHT_BASE_URL'),
    requestTimeoutMs: integer('FOREMAN_REQUEST_TIMEOUT_MS', 120000, 100, 120000),
    taskTimeoutMs: integer('FOREMAN_TASK_TIMEOUT_MS', 180000, 1000, 900000),
    workerTimeoutMs: integer('FOREMAN_WORKER_TIMEOUT_MS', 600000, 1000, 900000),
    workspaceSourceRepo: process.env.FOREMAN_WORKSPACE_SOURCE_REPO?.trim() || undefined,
    workspaceBridgeUrl: process.env.FOREMAN_WORKSPACE_BRIDGE_URL?.trim() || undefined,
    workspaceBridgeToken,
    workspaceAllowedScope,
    validationCommands,
    ...(formatCommand ? { formatCommand } : {}),
    validationTimeoutMs: integer('FOREMAN_VALIDATION_TIMEOUT_MS', 120000, 1, 600000),
    validationMaxOutputBytes: integer('FOREMAN_VALIDATION_MAX_OUTPUT_BYTES', 1048576, 1, 16777216),
    validationSandbox: { mode: sandboxMode, roPaths: sandboxRoPaths.map(path => resolve(path)), dataDir, cacheDir: resolve(dataDir, 'validation-cache') }
  };
}
