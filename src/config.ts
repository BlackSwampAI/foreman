import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

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
  workspaceSourceRepo?: string;
  workspaceBridgeUrl?: string;
  workspaceAllowedScope: string[];
  validationCommands: Array<{name:string;command:string;args:string[];cwd?:string}>;
  validationTimeoutMs: number;
  validationMaxOutputBytes: number;
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

/** Load an optional local .env and validate the supported service configuration. */
export function loadConfig(): ForemanConfig {
  if (existsSync('.env')) loadEnvFile('.env');
  const uhpHarnessId = process.env.UHP_HARNESS_ID?.trim() || undefined;
  const uhpModel = process.env.UHP_MODEL?.trim() || undefined;
  if (Boolean(uhpHarnessId) !== Boolean(uhpModel)) throw new Error('UHP_HARNESS_ID and UHP_MODEL must be configured together');
  let validationCommands: ForemanConfig['validationCommands'] = [];
  const rawCommands=process.env.FOREMAN_VALIDATION_COMMANDS?.trim();
  if(rawCommands){try{const value=JSON.parse(rawCommands);if(!Array.isArray(value))throw new Error();validationCommands=value.map((item:unknown)=>{if(!item||typeof item!=='object')throw new Error();const x=item as Record<string,unknown>;if(typeof x.name!=='string'||!x.name.trim()||typeof x.command!=='string'||!x.command||!Array.isArray(x.args)||x.args.some(arg=>typeof arg!=='string')||(x.cwd!==undefined&&typeof x.cwd!=='string'))throw new Error();return {name:x.name,command:x.command,args:x.args as string[],...(typeof x.cwd==='string'?{cwd:x.cwd}:{})};});}catch{throw new Error('FOREMAN_VALIDATION_COMMANDS must be a JSON array of {name,command,args,cwd?}');}}
  const workspaceAllowedScope=(process.env.FOREMAN_WORKSPACE_ALLOWED_SCOPE??'').split(',').map(x=>x.trim()).filter(Boolean);
  return {
    host: process.env.FOREMAN_HOST?.trim() || '127.0.0.1',
    port: integer('FOREMAN_PORT', 4399, 1, 65535),
    dataDir: resolve(process.env.FOREMAN_DATA_DIR?.trim() || '.foreman-data'),
    uhpBaseUrl: optionalHttpUrl('UHP_BASE_URL'),
    uhpHarnessId,
    uhpModel,
    hindsightBaseUrl: optionalHttpUrl('HINDSIGHT_BASE_URL'),
    requestTimeoutMs: integer('FOREMAN_REQUEST_TIMEOUT_MS', 10000, 100, 120000),
    taskTimeoutMs: integer('FOREMAN_TASK_TIMEOUT_MS', 300000, 1000, 600000),
    workspaceSourceRepo: process.env.FOREMAN_WORKSPACE_SOURCE_REPO?.trim() || undefined,
    workspaceBridgeUrl: process.env.FOREMAN_WORKSPACE_BRIDGE_URL?.trim() || undefined,
    workspaceAllowedScope,
    validationCommands,
    validationTimeoutMs: integer('FOREMAN_VALIDATION_TIMEOUT_MS', 120000, 1, 600000),
    validationMaxOutputBytes: integer('FOREMAN_VALIDATION_MAX_OUTPUT_BYTES', 1048576, 1, 16777216)
  };
}
