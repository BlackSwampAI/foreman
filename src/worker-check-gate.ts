import { baselineCommandDigest } from './baseline-validation.js';
import type { BaselineValidation } from './domain.js';
import { formatWorkerSnapshot, formatSetupCommands } from './format-step.js';
import type { ValidationSandboxConfig } from './validation-sandbox.js';
import { validateWorkerOutput, verifyWorkerSnapshot, type BridgeSnapshotEnvelope, type ValidationCommand, type ValidationObservation } from './verified-workspace.js';

/**
 * The Worker check gate. The bridge pauses a Worker after each completed turn; Foreman runs the configured checks on
 * the paused workspace and returns a verdict. On `failed`, the bridge resumes the same Worker session with `feedback`,
 * so every harness can fix its own check failures without a shell. The verdict is feedback only: Foreman's validation
 * after the turn is still the authoritative result.
 */
export interface WorkerCheckRound { status: 'passed'|'failed'|'skipped'; failedChecks: string[]; feedback?: string; reason?: string }

/** Upper bound on the feedback text sent back to the Worker. */
export const WORKER_CHECK_FEEDBACK_BYTES = 7_000;
const MIN_PER_CHECK_BYTES = 600;

const stripAnsi = (text:string):string => text.replace(/\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*\u0007|[PX^_][^\u001b]*\u001b\\)/g, '');
const passed = (o:ValidationObservation):boolean => o.exitCode === 0 && !o.timedOut && !o.outputTruncated;

/** UTF-8-safe excerpt of at most `maxBytes`, keeping the start and (more of) the end, where tools print their summary. */
export function headTailExcerpt(text:string, maxBytes:number):string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  const marker = '\n[... output trimmed ...]\n', room = Math.max(0, maxBytes - Buffer.byteLength(marker));
  const head = Math.floor(room / 3), tail = room - head;
  const start = bytes.subarray(0, head).toString('utf8').replace(/�$/, '');
  const end = bytes.subarray(bytes.length - tail).toString('utf8').replace(/^�/, '');
  return `${start}${marker}${end}`;
}

/** Readable failure report for the Worker: each failed check's command, exit status and a head-and-tail output excerpt. */
export function workerCheckFeedback(failures:readonly ValidationObservation[], maxBytes = WORKER_CHECK_FEEDBACK_BYTES):string {
  if (!failures.length) return '';
  const perCheck = Math.max(MIN_PER_CHECK_BYTES, Math.floor(maxBytes / failures.length) - 200);
  const parts = failures.map(f => {
    const status = f.timedOut ? 'timed out' : f.outputTruncated ? `exit ${f.exitCode ?? 'none'}, output exceeded the limit` : `exit ${f.exitCode ?? 'none'}${f.signal ? `, ${f.signal}` : ''}`;
    const output = stripAnsi(f.output ?? '').trim();
    return `## ${f.name} failed (${status})\n$ ${[f.command, ...f.args].join(' ')}\n${output ? headTailExcerpt(output, perCheck) : '(no output)'}`;
  });
  return headTailExcerpt(parts.join('\n\n'), maxBytes);
}

/**
 * One gate round against a paused Worker's bridge snapshot: verify it against the pinned base and allowed scope, apply the
 * configured formatter the same way the final validation does, run the checks, and report the failures the Worker could have caused.
 * A scope violation is the Worker's to fix and fails the round; any other problem skips it, so the Worker is never sent
 * feedback about Foreman's own infrastructure.
 */
export async function runWorkerCheckRound(input:{
  repoPath:string; pinnedBaseCommit:string; allowedScope:readonly string[]; commands:readonly ValidationCommand[]; formatCommand?:ValidationCommand;
  envelope:BridgeSnapshotEnvelope; baseline?:BaselineValidation; timeoutMs?:number; maxOutputBytes?:number; sandbox?:ValidationSandboxConfig;
}):Promise<WorkerCheckRound> {
  let snapshot;
  try { snapshot = await verifyWorkerSnapshot({ repoPath:input.repoPath, pinnedBaseCommit:input.pinnedBaseCommit, envelope:input.envelope, allowedScope:input.allowedScope }); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/outside the allowed scope/.test(message)) return { status:'failed', failedChecks:['allowed scope'], feedback:`${message}. Only change files inside the allowed scope (${input.allowedScope.join(', ')}); restore any other file you changed.` };
    return { status:'skipped', failedChecks:[], reason:message };
  }
  if (!snapshot.changes.length) return { status:'skipped', failedChecks:[], reason:'The Worker workspace has no changes to check' };
  const verified = input.formatCommand
    ? (await formatWorkerSnapshot({ repoPath:input.repoPath, verified:snapshot, setupCommands:formatSetupCommands(input.commands), formatCommand:input.formatCommand, allowedScope:input.allowedScope, timeoutMs:input.timeoutMs, maxOutputBytes:input.maxOutputBytes, sandbox:input.sandbox })).verified
    : snapshot;
  const observed = await validateWorkerOutput({ repoPath:input.repoPath, evidence:verified, commands:input.commands, timeoutMs:input.timeoutMs, maxOutputBytes:input.maxOutputBytes, sandbox:input.sandbox });
  const baseline = input.baseline?.pinnedBaseCommit === input.pinnedBaseCommit && input.baseline.commandDigest === baselineCommandDigest(input.commands) ? input.baseline : undefined;
  const baseFailing = new Set((baseline?.checks ?? []).filter(c => !c.passed).map(c => c.name));
  const failures = observed.checks.filter(c => !passed(c) && !baseFailing.has(c.name));
  if (!failures.length) return { status:'passed', failedChecks:[] };
  return { status:'failed', failedChecks:failures.map(f => f.name), feedback:workerCheckFeedback(failures) };
}
