/**
 * DecisionPanel — a prominent panel shown at the top of the run view when
 * human input is expected (awaiting approval, post-approval guidance, etc.).
 *
 * Shows a 3-item checklist, an Approve/Reject pair, a one-sentence disclaimer,
 * and a stepper showing the current position in the Review→Merge lifecycle.
 */
import React from 'react';
import { ChecksPipeline, type StationObservation, type GithubCheckEntry } from './checks-pipeline.js';
import { Badge, type Tone } from './badge.js';

export interface DecisionPanelProps {
  /** Number of files changed (from workerEvidence.changes.length). */
  filesChanged: number;
  /** Allowed scope paths. */
  allowedScope: string[];
  /** Number of validation checks that passed. */
  validationPassedCount: number;
  /** Total number of validation checks. */
  validationTotalCount: number;
  /** Whether all validation checks passed. */
  validationPassed: boolean;
  /** Raw validation observations for the ChecksPipeline view. */
  observations: StationObservation[];
  /** Reviewer verdict, or undefined if no recommendation yet. */
  reviewerVerdict: 'recommend' | 'request_changes' | 'reject' | 'unparsed' | undefined;
  /** First sentence of the Reviewer's rationale, for context. */
  reviewerRationaleSnippet: string | undefined;
  /** Whether the approve button should be enabled. */
  approvable: boolean;
  /** Whether the Reviewer recommends approving (governs button style). */
  reviewerRecommends: boolean;
  /** True while an API request is in flight. */
  pending: boolean;
  /** Fire when the user clicks Approve. */
  onApprove: () => void;
  /** Fire when the user clicks Reject. */
  onReject: () => void;

  // ── Stepper state ──────────────────────────────────────────────────────────
  /** Whether the run has a human approval recorded. */
  approved: boolean;
  /** Whether the run has been promoted to a local git commit. */
  promoted: boolean;
  /** Name of the promoted branch, if available. */
  promotedBranch?: string;
  /** Whether the promoted branch has been pushed to the remote. */
  branchPushed: boolean;
  /** Whether a pull request is open on GitHub. */
  prOpen: boolean;
  /** URL of the PR if open. */
  prUrl?: string;
  /** Whether the PR has been merged. */
  prMerged: boolean;

  // ── GitHub CI (remote) ─────────────────────────────────────────────────────
  /** Remote CI checks from GitHub status, if available. */
  ciChecks?: GithubCheckEntry[];
  /**
   * Names of CI checks that run in GitHub but are not configured locally.
   * When provided, a note is shown urging the user to add them to Foreman.
   */
  ciChecksNotConfigured?: string[];
}

type StepStatus = 'done' | 'current' | 'upcoming';

interface StepperStep {
  id: string;
  label: string;
  status: StepStatus;
  hint?: string;
}

function buildStepper(props: DecisionPanelProps): StepperStep[] {
  const { approved, promoted, branchPushed, prOpen, prMerged } = props;
  // Review is always done when we show this panel.
  const steps: StepperStep[] = [
    { id: 'review',   label: 'Review',  status: 'done' },
    { id: 'approve',  label: 'Approve', status: approved ? 'done' : 'current' },
    { id: 'promote',  label: 'Promote', status: approved ? (promoted ? 'done' : 'current') : 'upcoming',
      hint: approved && !promoted ? 'Creates a local commit and branch; your checkout is unchanged' : undefined },
    { id: 'push',     label: 'Push',    status: promoted ? (branchPushed ? 'done' : 'current') : 'upcoming' },
    { id: 'pr',       label: 'PR',      status: branchPushed ? (prOpen ? 'done' : 'current') : 'upcoming' },
    { id: 'merge',    label: 'Merge',   status: prOpen ? (prMerged ? 'done' : 'current') : 'upcoming' },
  ];
  return steps;
}

function verdictText(verdict: DecisionPanelProps['reviewerVerdict']): string {
  if (verdict === 'recommend')       return 'Reviewer recommends approving';
  if (verdict === 'request_changes') return 'Reviewer asks for changes';
  if (verdict === 'reject')          return 'Reviewer recommends rejecting';
  if (verdict === 'unparsed')        return "Reviewer answer couldn't be read";
  return 'No Reviewer recommendation yet';
}

function verdictTone(verdict: DecisionPanelProps['reviewerVerdict']): Tone {
  if (verdict === 'recommend') return 'passed';
  if (verdict === 'request_changes' || verdict === 'reject') return 'failed';
  return 'warning';
}

/** Short badge text for the Reviewer row; the full sentence stays in the row label. */
function verdictBadge(verdict: DecisionPanelProps['reviewerVerdict']): string {
  if (verdict === 'recommend')       return 'Recommends';
  if (verdict === 'request_changes') return 'Requests changes';
  if (verdict === 'reject')          return 'Rejects';
  if (verdict === 'unparsed')        return 'Unreadable';
  return 'Pending';
}

export function DecisionPanel(props: DecisionPanelProps): React.ReactElement {
  const {
    filesChanged, allowedScope, validationPassedCount, validationTotalCount,
    validationPassed, observations, reviewerVerdict, reviewerRationaleSnippet,
    approvable, reviewerRecommends, pending, onApprove, onReject,
    approved, promotedBranch, branchPushed, prOpen, prUrl, prMerged,
    ciChecks, ciChecksNotConfigured,
  } = props;

  const steps = buildStepper(props);
  const currentStep = steps.find(s => s.status === 'current');

  const changesTone: Tone = filesChanged > 0 ? 'passed' : 'neutral';
  const checksTone: Tone  = validationPassed ? 'passed' : validationTotalCount > 0 ? 'failed' : 'neutral';
  const reviewTone  = verdictTone(reviewerVerdict);

  return (
    <section className="decision-panel card" aria-labelledby="decision-panel-title">
      <div className="card-title">
        <h2 id="decision-panel-title">Ready for your review</h2>
        <div className="decision-stepper" aria-label="Delivery progress">
          {steps.map((step) => (
            <div
              key={step.id}
              className={`stepper-step stepper-${step.status}`}
              aria-current={step.status === 'current' ? 'step' : undefined}
              title={step.hint}
            >
              <span className="stepper-icon" aria-hidden="true">
                {step.status === 'done' ? '✓' : step.status === 'current' ? '●' : '○'}
              </span>
              <span className="stepper-label">{step.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Next-step hint for the current stepper step */}
      {currentStep && currentStep.id !== 'approve' && (
        <p className="decision-next-step" role="status">
          {currentStep.id === 'promote' && <>Next: <strong>Promote approved result</strong> — creates a local commit and branch; your checkout is unchanged{promotedBranch ? ` (branch: ${promotedBranch})` : ''}.</>}
          {currentStep.id === 'push'    && <>Next: push the branch{promotedBranch ? ` <code>${promotedBranch}</code>` : ''} to your remote, then open a pull request on GitHub, or merge the branch locally.</>}
          {currentStep.id === 'pr'      && <>Next: open a pull request on GitHub. The promoted commit must be in your local checkout first.</>}
          {currentStep.id === 'merge'   && <>PR {prUrl ? <a href={prUrl} target="_blank" rel="noreferrer">is open</a> : 'is open'} — review and merge when ready.</>}
          {currentStep.id === 'review'  && null}
        </p>
      )}

      {/* 3-item checklist — only when awaiting approval */}
      {!approved && (
        <ul className="decision-checklist" aria-label="Review checklist">
          <li className="decision-check-item">
            <Badge tone={changesTone} aria-label={`Changes: ${filesChanged > 0 ? 'present' : 'none'}`}>
              {filesChanged > 0 ? 'Present' : 'None'}
            </Badge>
            <span className="decision-check-label">
              <strong>Changes</strong>
              {' — '}
              {filesChanged} file{filesChanged !== 1 ? 's' : ''} changed within allowed scope
              {allowedScope.length > 0 && <span className="decision-check-scope"> ({allowedScope.join(', ')})</span>}
            </span>
            {/* "View diff" link — scrolls to the diff evidence block */}
            {filesChanged > 0 && (
              <a href="#" className="decision-check-link" onClick={(e) => { e.preventDefault(); document.querySelector('.diff-block')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} aria-label="View diff">
                View diff ↓
              </a>
            )}
          </li>

          <li className="decision-check-item">
            <Badge tone={checksTone} aria-label={`Checks: ${validationPassed ? 'passed' : 'failed'}`}>
              {validationPassed ? 'Passed' : validationTotalCount > 0 ? 'Failed' : 'None'}
            </Badge>
            <span className="decision-check-label">
              <strong>Checks</strong>
              {' — '}
              <a href="#" className="decision-check-link" onClick={(e) => { e.preventDefault(); document.getElementById('controller-validation')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} aria-label="View checks">
                {validationPassedCount} of {validationTotalCount} check{validationTotalCount !== 1 ? 's' : ''} passed
              </a>
            </span>
          </li>

          <li className="decision-check-item">
            <Badge tone={reviewTone} aria-label={`Reviewer: ${verdictText(reviewerVerdict)}`}>
              {verdictBadge(reviewerVerdict)}
            </Badge>
            <span className="decision-check-label">
              <strong>Reviewer</strong>
              {' — '}
              {verdictText(reviewerVerdict)}
              {reviewerRationaleSnippet && <span className="decision-reviewer-snippet"> — {reviewerRationaleSnippet}</span>}
            </span>
          </li>
        </ul>
      )}

      {/* Checks pipeline overview (validation stations) */}
      {!approved && observations.length > 0 && (
        <ChecksPipeline
          observations={observations}
          ciChecks={ciChecks}
          ciChecksNotConfigured={ciChecksNotConfigured}
        />
      )}

      {/* Approve / Reject controls — only when awaiting approval */}
      {!approved && (
        <div className="decision-approve-row">
          <button
            type="button"
            className={reviewerRecommends ? 'primary' : 'outline'}
            disabled={pending || !approvable}
            onClick={onApprove}
            aria-label={reviewerRecommends ? 'Approve result' : 'Approve result despite Reviewer recommendation'}
          >
            {pending ? 'Approving…' : 'Approve result'}
          </button>
          <button
            type="button"
            className="outline"
            disabled={pending || !approvable}
            onClick={onReject}
            aria-label="Reject result"
          >
            Reject result
          </button>
          <p className="decision-approve-note">
            {reviewerRecommends
              ? 'Approving records your decision only. Nothing is committed to Git until you promote it.'
              : 'The Reviewer has not recommended approving. Approving accepts the current result as-is.'}
          </p>
        </div>
      )}

      {/* Advisory note */}
      <p className="decision-advisory">The Reviewer only advises; you decide.</p>
    </section>
  );
}
