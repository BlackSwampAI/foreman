#!/usr/bin/env node
// Claude Code statusLine collector. It persists only the two quota fields
// needed by Foreman; the complete statusLine input is never logged or stored.
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, chmod, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const MAX_INPUT_BYTES = 256 * 1024;
const CACHE_PATH = resolve(process.env.FOREMAN_CLAUDE_USAGE_CACHE || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'foreman', 'claude-usage.json'));

function projectWindow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.used_percentage !== 'number' || !Number.isFinite(raw.used_percentage) || raw.used_percentage < 0 || raw.used_percentage > 100) return null;
  const output = { used_percentage: raw.used_percentage };
  if (Number.isSafeInteger(raw.resets_at) && raw.resets_at > 0) output.resets_at = raw.resets_at;
  return output;
}

function projectQuota(input) {
  const rateLimits = input && typeof input === 'object' && !Array.isArray(input) ? input.rate_limits : undefined;
  const fiveHour = projectWindow(rateLimits?.five_hour);
  const sevenDay = projectWindow(rateLimits?.seven_day);
  if (!fiveHour && !sevenDay) return undefined;
  return { version: 1, capturedAt: Date.now(), rate_limits: { five_hour: fiveHour, seven_day: sevenDay } };
}

async function writeSnapshot(snapshot, path = CACHE_PATH) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(snapshot));
    } finally { await file.close(); }
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw Error('quota_cache_write_failed');
  }
}

async function main() {
  let input = '';
  let inputBytes = 0;
  let oversized = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    inputBytes += Buffer.byteLength(chunk);
    if (inputBytes > MAX_INPUT_BYTES) { oversized = true; input = ''; return; }
    if (!oversized) input += chunk;
  });
  process.stdin.on('end', async () => {
    if (oversized) return;
    let snapshot;
    try { snapshot = projectQuota(JSON.parse(input)); } catch { return; }
    if (!snapshot) return;
    try { await writeSnapshot(snapshot); } catch { return; }
    const parts = [];
    if (snapshot.rate_limits.five_hour) parts.push(`5h ${snapshot.rate_limits.five_hour.used_percentage}% used`);
    if (snapshot.rate_limits.seven_day) parts.push(`7d ${snapshot.rate_limits.seven_day.used_percentage}% used`);
    process.stdout.write(parts.join(' · '));
  });
}

main();
