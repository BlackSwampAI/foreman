/**
 * ChecksPipeline — a horizontal (wrapping on mobile) sequence of check "stations".
 * Each station shows the name, tone-coloured status icon, optional duration,
 * and for test-runner checks a parsed summary like "17 passed · 1 failed of 18".
 * Clicking a station expands the per-check details inline.
 */
import React from 'react';
import { parseChecksSummary } from './check-output.js';
import { Badge, type Tone } from './badge.js';

// Minimal type mirrors ValidationObservation in main.tsx.
export interface StationObservation {
  name: string;
  command: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  outputTruncated: boolean;
  passed?: boolean;
  startedAt?: string;
  finishedAt?: string;
}

export interface CiJobFailure {
  jobName: string;
  stepName: string;
  excerpt: string;
}

export interface GithubCheckEntry {
  name: string;
  status?: string;
  conclusion?: string;
  detailsUrl?: string;
  summary?: string;
  /** Failure details from the CI failure log, if available. */
  failures?: CiJobFailure[];
}

export interface ChecksPipelineProps {
  /** Local Foreman validation observations (may be empty while running). */
  observations: StationObservation[];
  /** If true, validation is still in progress — show running spinner. */
  running?: boolean;
  /** Remote GitHub CI checks, if available. */
  ciChecks?: GithubCheckEntry[];
  /**
   * Names of CI checks that run in GitHub but are not configured in Foreman.
   * When provided, a note is shown suggesting they be added.
   */
  ciChecksNotConfigured?: string[];
  /**
   * Names of the local Foreman validation checks (for comparing against CI
   * failure step names to identify gaps in local coverage).
   */
  localCheckNames?: string[];
}

function durationLabel(startedAt?: string, finishedAt?: string): string | undefined {
  if (!startedAt || !finishedAt) return undefined;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ciConclusion(check: GithubCheckEntry): 'passed' | 'failed' | 'running' | 'skipped' | 'queued' {
  if (check.status === 'in_progress' || check.status === 'queued') return check.status === 'queued' ? 'queued' : 'running';
  if (check.conclusion === 'success') return 'passed';
  if (check.conclusion === 'failure' || check.conclusion === 'timed_out' || check.conclusion === 'cancelled') return 'failed';
  if (check.conclusion === 'skipped' || check.conclusion === 'neutral') return 'skipped';
  return 'queued';
}

type StationStatus = 'queued' | 'running' | 'passed' | 'failed' | 'skipped';

function stationTone(status: StationStatus): Tone {
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  if (status === 'running') return 'running';
  return 'neutral';
}
const statusToneClass = (status: StationStatus): string => `tone-${stationTone(status)}`;

function statusLabel(status: StationStatus, timedOut?: boolean): string {
  if (timedOut) return 'Timed out';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function ChecksPipeline({ observations, running, ciChecks, ciChecksNotConfigured, localCheckNames }: ChecksPipelineProps): React.ReactElement | null {
  if (observations.length === 0 && !running && (!ciChecks || ciChecks.length === 0)) return null;

  // Determine station status for each observation.
  const localStations = observations.map((obs): { obs: StationObservation; status: StationStatus; summary?: string } => {
    const status: StationStatus =
      obs.timedOut ? 'failed'
      : obs.passed === true ? 'passed'
      : obs.passed === false ? 'failed'
      : running ? 'running'
      : 'queued';
    const summary = (obs.passed === false || obs.passed === true) && obs.output
      ? parseChecksSummary(obs.output) ?? undefined
      : undefined;
    return { obs, status, summary };
  });

  // If running and no observations yet, synthesise a single running station.
  const showRunningPlaceholder = running && observations.length === 0;

  const hasLocalHeader = localStations.length > 0 || showRunningPlaceholder;
  const hasCi = ciChecks && ciChecks.length > 0;

  return (
    <div className="checks-pipeline">
      {hasLocalHeader && <span className="checks-pipeline-label" aria-hidden="true">Foreman checks (local)</span>}
      <div className="checks-stations" role="list">
        {showRunningPlaceholder && (
          <div className="check-station tone-running" role="listitem" aria-label="Validation running…">
            <span className="station-name">Validating…</span>
            <Badge tone="running" aria-label="Status: Running">Running</Badge>
          </div>
        )}
        {localStations.map(({ obs, status, summary }) => {
          const dur = durationLabel(obs.startedAt, obs.finishedAt);
          const ariaLabel = `${obs.name}: ${statusLabel(status, obs.timedOut)}${summary ? ` — ${summary}` : ''}`;
          return (
            <details className={`check-station check-station-detail ${statusToneClass(status)}`} key={obs.name} role="listitem">
              <summary aria-label={ariaLabel}>
                <span className="station-name">{obs.name}</span>
                {dur && <span className="station-duration">{dur}</span>}
                <Badge tone={stationTone(status)} aria-label={`Status: ${statusLabel(status, obs.timedOut)}`}>
                  {statusLabel(status, obs.timedOut)}
                </Badge>
              </summary>
              <div className="station-details">
                <code>$ {obs.command} {obs.args.join(' ')}</code>
                <small>Exit {obs.exitCode === null ? 'unavailable' : obs.exitCode}{obs.timedOut ? ' · timed out' : ''}</small>
                {summary && <span className="station-test-summary">{summary}</span>}
                {obs.output && (
                  <pre className="station-output">{obs.output}{obs.outputTruncated ? '\n… output truncated' : ''}</pre>
                )}
              </div>
            </details>
          );
        })}
      </div>

      {hasCi && (
        <div className="checks-ci-row">
          <span className="checks-pipeline-label" aria-hidden="true">GitHub CI (remote)</span>
          <div className="checks-stations" role="list">
            {ciChecks!.map((check) => {
              const ciStatus = ciConclusion(check);
              const hasFailures = check.failures && check.failures.length > 0;
              const ariaLabel = `${check.name}: ${statusLabel(ciStatus)}`;
              if (hasFailures) {
                return (
                  <details className={`check-station check-station-detail ${statusToneClass(ciStatus)}`} key={check.name} role="listitem">
                    <summary aria-label={ariaLabel}>
                      <span className="station-name">{check.name}</span>
                      <Badge tone={stationTone(ciStatus)} aria-label={`Status: ${statusLabel(ciStatus)}`}>
                        {statusLabel(ciStatus)}
                      </Badge>
                    </summary>
                    <div className="station-details">
                      {check.failures!.map((failure, idx) => {
                        const stepUncovered = localCheckNames && !localCheckNames.some(name =>
                          name.toLowerCase().includes(failure.stepName.toLowerCase()) ||
                          failure.stepName.toLowerCase().includes(name.toLowerCase())
                        );
                        return (
                          <div className="ci-failure-item" key={idx}>
                            <small className="ci-failure-step">
                              <strong>{failure.jobName}</strong> / {failure.stepName}
                            </small>
                            {failure.excerpt && (
                              <pre className="station-output">{failure.excerpt}</pre>
                            )}
                            {stepUncovered && (
                              <p className="ci-failure-hint" role="note">
                                This step is not in Foreman's local checks — add it to catch failures before the PR.
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </details>
                );
              }
              return (
                <div className={`check-station ${statusToneClass(ciStatus)}`} key={check.name} role="listitem" aria-label={ariaLabel}>
                  <span className="station-name">{check.name}</span>
                  <Badge tone={stationTone(ciStatus)} aria-label={`Status: ${statusLabel(ciStatus)}`}>
                    {statusLabel(ciStatus)}
                  </Badge>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {ciChecksNotConfigured && ciChecksNotConfigured.length > 0 && (
        <p className="checks-ci-unconfigured" role="note">
          CI also runs: {ciChecksNotConfigured.join(', ')} — add them to this repository's checks so Foreman catches failures before the PR.
        </p>
      )}
    </div>
  );
}
