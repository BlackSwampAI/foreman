/**
 * PrDraftPanel — shown in the GitHub delivery panel before "Open PR".
 * Allows generating, editing, and saving a pull-request title + body draft
 * before the PR is created on GitHub.
 */
import React, { useState } from 'react';
import { Badge } from './badge.js';

export interface PrDraftData {
  title: string;
  body: string;
  source: 'planner' | 'template' | 'edited';
  generatedAt: string;
  assignmentId?: string;
}

export interface PrDraftPanelProps {
  runId: string;
  draft?: PrDraftData;
  /** Whether PR has been generated yet. */
  pending?: boolean;
  onGenerate: () => void;
  onSave: (title: string, body: string) => void;
  /** True while an API call is in flight. */
  busy?: boolean;
  error?: string;
}

function sourceLabel(source: PrDraftData['source']): string {
  if (source === 'planner') return 'Planner';
  if (source === 'template') return 'Template';
  return 'Edited';
}

export function PrDraftPanel({ runId: _runId, draft, pending, onGenerate, onSave, busy, error }: PrDraftPanelProps): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(draft?.title ?? '');
  const [editBody, setEditBody] = useState(draft?.body ?? '');

  const startEdit = () => {
    setEditTitle(draft?.title ?? '');
    setEditBody(draft?.body ?? '');
    setEditing(true);
  };

  const cancelEdit = () => setEditing(false);

  const saveEdit = () => {
    onSave(editTitle.trim(), editBody.trim());
    setEditing(false);
  };

  if (!draft) {
    return (
      <div className="pr-draft-panel" aria-label="PR description draft">
        <p className="pr-draft-empty">No draft description yet.</p>
        <button type="button" className="outline small" disabled={!!pending || !!busy} onClick={onGenerate}>
          {busy ? 'Generating…' : 'Draft PR description with Planner'}
        </button>
        {error && <p className="pr-draft-error" role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <div className="pr-draft-panel" aria-label="PR description draft">
      {editing ? (
        <div className="pr-draft-edit">
          <input
            className="pr-draft-title-input"
            aria-label="PR title"
            value={editTitle}
            onChange={e => setEditTitle(e.target.value)}
            placeholder="PR title"
          />
          <textarea
            className="pr-draft-body-input"
            aria-label="PR description"
            value={editBody}
            onChange={e => setEditBody(e.target.value)}
            placeholder="PR description (Markdown)"
            rows={8}
          />
          <div className="pr-draft-edit-actions">
            <button type="button" className="primary small" onClick={saveEdit} disabled={!editTitle.trim() || !!busy}>
              {busy ? 'Saving…' : 'Save edit'}
            </button>
            <button type="button" className="outline small" onClick={cancelEdit} disabled={!!busy}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="pr-draft-view">
          <div className="pr-draft-header">
            <b className="pr-draft-title">{draft.title}</b>
            <Badge tone="info" className="pr-draft-source-pill" title={`Source: ${sourceLabel(draft.source)}`}>
              {sourceLabel(draft.source)}
            </Badge>
          </div>
          <pre className="pr-draft-body">{draft.body}</pre>
          <div className="pr-draft-actions">
            <button type="button" className="outline small" onClick={startEdit} disabled={!!busy}>Edit draft</button>
            <button type="button" className="outline small" onClick={onGenerate} disabled={!!busy}>
              {busy ? 'Regenerating…' : 'Regenerate with Planner'}
            </button>
          </div>
        </div>
      )}
      {error && <p className="pr-draft-error" role="alert">{error}</p>}
    </div>
  );
}
