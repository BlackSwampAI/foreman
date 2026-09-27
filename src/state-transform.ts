import { type State, type WorkerEvidence } from './domain.js';
import { type SnapshotEntry, type SnapshotChange } from './workspace-snapshot.js';

// Strip binary content from evidence before sending state to the UI.
// The targeted evidence endpoint (/api/runs/:id/evidence) serves the full payload on demand.
function stripEntry(e:SnapshotEntry):SnapshotEntry{return {...e,contentBase64:''};}
function stripChange(c:SnapshotChange):SnapshotChange{return {...c,...(c.before?{before:stripEntry(c.before)}:{}),...(c.after?{after:stripEntry(c.after)}:{})};}
function stripEvidence(ev:WorkerEvidence):WorkerEvidence{return {...ev,entries:[],changes:ev.changes.map(stripChange)};}

// High-volume event types: keep only the most recent N to bound payload size.
// All other event types are kept in full so run-recovery logic is never starved of events.
export const HIGH_VOL_TYPES=new Set(['assignment.progress','assignment.reconciled']);
export function eventsForUi(events:State['events']):State['events']{
  const recent=events.filter(e=>HIGH_VOL_TYPES.has(e.type)).slice(-200);
  const recentSet=new Set(recent);
  return events.filter(e=>!HIGH_VOL_TYPES.has(e.type)||recentSet.has(e));
}

export function stateForUi(state:State):State{
  return {
    ...state,
    events:eventsForUi(state.events),
    projects:state.projects.map(p=>({
      ...p,
      tasks:p.tasks.map(t=>({
        ...t,
        runs:t.runs.map(r=>({
          ...r,
          ...(r.workerEvidence?{workerEvidence:stripEvidence(r.workerEvidence)}:{}),
          ...(r.workerEvidenceHistory?.length?{workerEvidenceHistory:r.workerEvidenceHistory.map(stripEvidence)}:{}),
        })),
      })),
    })),
  };
}
