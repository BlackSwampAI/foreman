// Ask the signed-in Claude Code CLI for its own /usage data. This sends only a
// control request; it never sends a user prompt or handles credentials.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const REQUEST_ID = 'foreman-usage';
const MAX_OUTPUT_BYTES = 256 * 1024;

function windowFromLimit(limit, observedAt) {
  const percent = limit?.percent ?? limit?.utilization;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) return { status: 'unavailable' };
  const reset = limit?.resets_at;
  const resetMs = typeof reset === 'string' ? Date.parse(reset) : NaN;
  if (Number.isFinite(resetMs) && resetMs <= Date.now()) return { status: 'unavailable' };
  const usedPercent = Math.round(percent * 100) / 100;
  return {
    status: 'available', usedPercent, remainingPercent: Math.round((100 - usedPercent) * 100) / 100,
    observedAt, ...(Number.isFinite(resetMs) ? { resetsAt: new Date(resetMs).toISOString() } : {}),
  };
}

export function normalizeClaudeControlUsage(response, observedAt = new Date().toISOString()) {
  const unavailable = { fiveHour: { status: 'unavailable' }, weekly: { status: 'unavailable' } };
  if (!response || response.rate_limits_available !== true || !response.rate_limits) return unavailable;
  const limits = response.rate_limits;
  const rows = Array.isArray(limits.limits) ? limits.limits : [];
  const fiveHour = rows.find(row => row?.kind === 'session' && !row.scope) ?? limits.five_hour;
  const weekly = rows.find(row => row?.kind === 'weekly_all' && !row.scope) ?? limits.seven_day;
  return { fiveHour: windowFromLimit(fiveHour, observedAt), weekly: windowFromLimit(weekly, observedAt) };
}

export async function readClaudeControlUsage(binary, authDir, timeoutMs = 12_000) {
  return await new Promise(resolve => {
    const envNames = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TMP', 'TEMP', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => envNames.has(name) && typeof value === 'string'));
    env.CLAUDE_CONFIG_DIR = authDir;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"hooks":{}}'];
    let child;
    try { child = spawn(binary, args, { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true }); }
    catch { resolve(undefined); return; }
    let done = false, input = '', bytes = 0;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) return finish(undefined);
      input += chunk.toString('utf8');
      const lines = input.split('\n');
      input = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          if (message.type === 'control_response' && message.response?.request_id === REQUEST_ID) {
            return finish(message.response.subtype === 'success' ? normalizeClaudeControlUsage(message.response.response) : undefined);
          }
        } catch { /* Ignore non-JSON progress lines. */ }
      }
    });
    child.once('error', () => finish(undefined));
    child.once('close', () => finish(undefined));
    child.stdin.on('error', () => finish(undefined));
    child.stdin.end(JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'get_usage' } }) + '\n');
  });
}
