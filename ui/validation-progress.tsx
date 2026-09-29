import React, { useEffect, useMemo, useState } from 'react';
import { Badge, type Tone } from './badge.js';

export type ValidationProgressCheck = {
  name: string;
  command: string;
  args: string[];
  status: 'queued' | 'running' | 'passed' | 'failed';
  output: string;
  outputTruncated: boolean;
  startedAt?: string;
  finishedAt?: string;
  elapsedMs?: number;
  exitCode?: number | null;
  signal?: string;
  timedOut?: boolean;
  network?: boolean;
};

export type ValidationProgress = {
  attemptId: string;
  startedAt: string;
  finishedAt?: string;
  checks: ValidationProgressCheck[];
};

type Props = {
  runId: string;
  progress?: ValidationProgress;
  observations?: Array<{name:string;command:string;args:string[];exitCode:number|null;timedOut:boolean;output:string;outputTruncated:boolean;passed?:boolean;startedAt?:string;finishedAt?:string;network?:boolean}>;
  running: boolean;
  autoCorrection: boolean;
  correcting: boolean;
  phase?: string;
  correctionStage?: 'orchestrating'|'dispatching';
  onAutoCorrectionChange: (enabled: boolean) => Promise<void>;
};

const tone: Record<ValidationProgressCheck['status'], Tone> = {
  queued: 'neutral', running: 'running', passed: 'passed', failed: 'failed',
};

function elapsed(check: ValidationProgressCheck, now:number, live:boolean): string | undefined {
  const started=check.startedAt?Date.parse(check.startedAt):undefined;
  const finished=check.finishedAt?Date.parse(check.finishedAt):live?now:undefined;
  const ms = check.elapsedMs ?? (started!==undefined&&finished!==undefined?finished-started:undefined);
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function ValidationProgressPanel({runId,progress,observations,running,autoCorrection,correcting,phase,correctionStage,onAutoCorrectionChange}:Props):React.ReactElement|null {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now,setNow] = useState(()=>Date.now());
  useEffect(()=>{
    if(!running)return;
    const timer=window.setInterval(()=>setNow(Date.now()),1000);
    return ()=>window.clearInterval(timer);
  },[running]);
  const checks = useMemo<ValidationProgressCheck[]>(() => {
    if (progress?.checks.length) return progress.checks;
    return (observations ?? []).map(obs => {
      const status:ValidationProgressCheck['status']=obs.timedOut||obs.passed===false?'failed'
        :obs.passed===true?'passed'
        :obs.exitCode===0&&!obs.timedOut&&!obs.outputTruncated?'passed'
        :obs.exitCode===null&&running?'running'
        :obs.exitCode===null?'queued':'failed';
      return {
        name: obs.name, command: obs.command, args: obs.args, output: obs.output,
        outputTruncated: obs.outputTruncated, status,
        startedAt: obs.startedAt, finishedAt: obs.finishedAt, exitCode: obs.exitCode, timedOut: obs.timedOut, network: obs.network,
      };
    });
  }, [progress, observations, running]);

  const counts = checks.reduce((result, check) => { result[check.status]++; return result; }, {queued:0,running:0,passed:0,failed:0});
  const status = correcting ? 'Correction in progress' : running ? 'Running' : counts.failed ? 'Failed' : checks.length && counts.passed === checks.length ? 'Passed' : phase && phase !== 'validating' && !checks.length ? 'Waiting for validation' : 'Validation';
  const transition = correcting && counts.failed > 0 && autoCorrection;

  const handleToggle = async (enabled: boolean) => {
    setBusy(true); setError('');
    try { await onAutoCorrectionChange(enabled); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not update automatic correction'); }
    finally { setBusy(false); }
  };

  return <section className="validation-progress" aria-label="Local validation" aria-busy={running || busy}>
    <div className="validation-progress-head">
      <div className="validation-progress-summary" role="status" aria-live="polite">
        <Badge tone={correcting || running ? 'running' : counts.failed ? 'failed' : counts.passed === checks.length && checks.length ? 'passed' : 'neutral'}>{status}</Badge>
        {checks.length > 0 && <span>{counts.passed} passed · {counts.failed} failed · {counts.running} running · {counts.queued} queued</span>}
        {running && !checks.length && <span>Starting configured checks…</span>}
      </div>
      <label className="validation-progress-mode">
        <input type="checkbox" checked={autoCorrection} disabled={busy} onChange={event=>void handleToggle(event.currentTarget.checked)} aria-label="Automatically ask the Orchestrator to correct validation failures" />
        <span>Automatic correction</span>
        <small>{autoCorrection ? 'On' : 'Off'}</small>
      </label>
    </div>
    <p className="validation-progress-message">
      {transition && correctionStage === 'dispatching' ? 'The Orchestrator prepared a bounded correction. Foreman is sending it to the Worker; checks will run again after the Worker applies it.'
        : transition ? 'A check failed. The Orchestrator is preparing a bounded correction for the Worker.'
        : correcting ? 'Checks will run again after the Worker applies the correction.'
        : !checks.length && phase && phase !== 'validating' ? 'Configured checks will start after the Worker change is verified.'
        : autoCorrection ? 'When a check fails, Foreman asks the Orchestrator for a bounded correction automatically.'
        : 'Manual mode: validation failures stop the run and wait for you to request a correction.'}
    </p>
    {error && <small role="alert">{error}</small>}
    {checks.length > 0 && <div className="validation-progress-list">
      {checks.map((check,index)=><details className={`validation-progress-check is-${check.status}`} key={`${runId}-${progress?.attemptId ?? 'recorded'}-${check.name}-${index}`}>
        <summary>
          <Badge tone={tone[check.status]}>{check.timedOut ? 'Timed out' : check.status[0]!.toUpperCase()+check.status.slice(1)}</Badge>
          <b>{check.name}</b>
          {check.network && <Badge tone="info" title="This check ran with network access" aria-label="Ran with network access">Network</Badge>}
          {elapsed(check,now,check.status==='running') && <small>{elapsed(check,now,check.status==='running')}</small>}
        </summary>
        <div className="validation-progress-detail">
          <code>$ {check.command} {check.args.join(' ')}</code>
          {check.exitCode !== undefined && <small>Exit {check.exitCode === null ? 'unavailable' : check.exitCode}{check.signal ? ` · ${check.signal}` : ''}{check.timedOut ? ' · timed out' : ''}</small>}
          {check.output ? <pre className="validation-progress-output">{check.output}{check.outputTruncated ? '\n… output truncated' : ''}</pre> : check.status==='running' ? <small role="status">Waiting for output…</small> : null}
        </div>
      </details>)}
    </div>}
  </section>;
}
