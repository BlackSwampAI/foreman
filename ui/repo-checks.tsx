/**
 * Validation command list of the open-repository dialog.
 * Validation runs offline: each command carries a Network switch that is off unless the suggestion needs the network (dependency installs, smoke and install-running scripts, cargo, go).
 */
import React from 'react';
import { Badge } from './badge.js';

export interface RepoCheck { name: string; command: string; args: string; source?: 'ci' | 'package-script'; network?: boolean }
export interface RepoCheckSuggestion { name: string; command: string; args: string[]; source?: 'ci' | 'package-script'; network?: boolean }
export interface SubmittedValidationCommand { name: string; command: string; args: string[]; network: boolean }

/** Editable rows from the inspector's suggestions; Network starts from the suggestion and is off when it says nothing. */
export const checksFromSuggestions = (suggestions: RepoCheckSuggestion[]): RepoCheck[] =>
  suggestions.map(c => ({ name: c.name, command: c.command, args: c.args.join(' '), source: c.source, network: c.network === true }));

/** The validation commands submitted with the workspace setup; every command states its Network choice. */
export const validationCommandsPayload = (checks: RepoCheck[]): SubmittedValidationCommand[] =>
  checks.filter(c => c.command.trim()).map(c => ({ name: c.name || c.command, command: c.command.trim(), args: c.args.trim() ? c.args.trim().split(/\s+/) : [], network: c.network === true }));

export function NetworkToggle({ checked, onChange }: { checked: boolean; onChange: (network: boolean) => void }): React.ReactElement {
  return (
    <label className="repo-check-network" title="Let this command use the network">
      <input type="checkbox" aria-label="Network access" checked={checked} onChange={e => onChange(e.target.checked)} />
      Network
    </label>
  );
}

export function RepoChecksEditor({ checks, onChange, ciScripts = [] }: { checks: RepoCheck[]; onChange: (next: RepoCheck[]) => void; ciScripts?: string[] }): React.ReactElement {
  const update = (index: number, patch: Partial<RepoCheck>) => onChange(checks.map((check, j) => (j === index ? { ...check, ...patch } : check)));
  return (
    <div>
      <b>Validation checks</b>
      <small>These commands run on the proposed changes. Add a real test or check for this repository.</small>
      <small>Network is off by default so a check cannot reach services on this computer or cloud credentials. Turn it on only for commands that download dependencies.</small>
      {checks.map((check, i) => (
        <div className="repo-check" key={`check-${i}`}>
          {check.source === 'ci' && <Badge tone="info" title="Detected from CI configuration">from CI</Badge>}
          <input aria-label="Check name" value={check.name} placeholder="Test suite" onChange={e => update(i, { name: e.target.value })} />
          <input aria-label="Executable" value={check.command} placeholder="pnpm" onChange={e => update(i, { command: e.target.value })} />
          <input aria-label="Arguments" value={check.args} placeholder="test" onChange={e => update(i, { args: e.target.value })} />
          <NetworkToggle checked={check.network === true} onChange={network => update(i, { network })} />
          <button className="outline small" type="button" onClick={() => onChange(checks.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      {!checks.some(c => c.command.trim()) && <small className="repo-note">No test command was detected. Add the test command your project uses to continue.</small>}
      {ciScripts.length > 0 && !checks.some(c => c.source === 'ci') && (
        <p className="repo-ci-warning" role="alert">CI scripts detected ({ciScripts.join(', ')}) are not in your validation checks — add them so Foreman catches failures before the PR.</p>
      )}
      <button className="outline small" type="button" onClick={() => onChange([...checks, { name: '', command: '', args: '', network: false }])}>Add check</button>
    </div>
  );
}
