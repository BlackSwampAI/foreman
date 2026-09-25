import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeClaudeControlUsage, readClaudeControlUsage } from './claude-quota.mjs';

test('normalizes Claude Code control usage without confusing scoped limits with account limits', () => {
  const observedAt = '2026-09-24T12:00:00.000Z';
  const windows = normalizeClaudeControlUsage({ rate_limits_available: true, rate_limits: { limits: [
    { kind: 'weekly_all', scope: { model: { display_name: 'Opus' } }, percent: 90 },
    { kind: 'session', percent: 23.5, resets_at: '2030-01-01T12:00:00Z' },
    { kind: 'weekly_all', percent: 41.2, resets_at: '2030-01-07T12:00:00Z' },
  ] } }, observedAt);
  assert.deepEqual(windows, {
    fiveHour: { status: 'available', usedPercent: 23.5, remainingPercent: 76.5, observedAt, resetsAt: '2030-01-01T12:00:00.000Z' },
    weekly: { status: 'available', usedPercent: 41.2, remainingPercent: 58.8, observedAt, resetsAt: '2030-01-07T12:00:00.000Z' },
  });
  assert.equal(normalizeClaudeControlUsage({ rate_limits_available: true, rate_limits: null }).fiveHour.status, 'unavailable');
});

test('asks Claude Code only for get_usage and does not forward provider keys', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-claude-quota-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'fake-claude');
  const record = join(dir, 'request.json');
  await writeFile(bin, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.resume();process.stdin.on('end',()=>{writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),input,providerKey:process.env.ANTHROPIC_API_KEY??null,authDir:process.env.CLAUDE_CONFIG_DIR}));const request=JSON.parse(input.trim());console.log(JSON.stringify({type:'control_response',response:{request_id:request.request_id,subtype:'success',response:{rate_limits_available:true,rate_limits:{five_hour:{utilization:12,resets_at:'2030-01-01T12:00:00Z'},seven_day:{utilization:34,resets_at:'2030-01-07T12:00:00Z'}}}}}));});\n`);
  await chmod(bin, 0o700);
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'fixture-only';
  let windows;
  try { windows = await readClaudeControlUsage(bin, join(dir, 'auth')); }
  finally { if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous; }
  const sent = JSON.parse(await readFile(record, 'utf8'));
  assert.deepEqual(JSON.parse(sent.input), { type: 'control_request', request_id: 'foreman-usage', request: { subtype: 'get_usage' } });
  assert.equal(sent.providerKey, null);
  assert.equal(sent.authDir, join(dir, 'auth'));
  assert.ok(sent.args.includes('--input-format') && sent.args.includes('stream-json'));
  assert.equal(windows.fiveHour.usedPercent, 12);
  assert.equal(windows.weekly.usedPercent, 34);
});
