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
  return {
    host: process.env.FOREMAN_HOST?.trim() || '127.0.0.1',
    port: integer('FOREMAN_PORT', 4399, 1, 65535),
    dataDir: resolve(process.env.FOREMAN_DATA_DIR?.trim() || '.foreman-data'),
    uhpBaseUrl: optionalHttpUrl('UHP_BASE_URL'),
    uhpHarnessId,
    uhpModel,
    hindsightBaseUrl: optionalHttpUrl('HINDSIGHT_BASE_URL'),
    requestTimeoutMs: integer('FOREMAN_REQUEST_TIMEOUT_MS', 10000, 100, 120000),
    taskTimeoutMs: integer('FOREMAN_TASK_TIMEOUT_MS', 300000, 1000, 600000)
  };
}
