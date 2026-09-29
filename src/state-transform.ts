import { type State, type WorkerEvidence } from './domain.js';
import { type SnapshotEntry, type SnapshotChange } from './workspace-snapshot.js';

// Strip binary content from evidence before sending state to the UI.
// The targeted evidence endpoint (/api/runs/:id/evidence) serves the stored record on demand: exact bytes for every change,
// and the complete entries too on legacy records (newer records store only changes plus a snapshot digest, see fullSnapshotEntries).
function stripEntry(e:SnapshotEntry):SnapshotEntry{return {...e,contentBase64:''};}
function stripChange(c:SnapshotChange):SnapshotChange{return {...c,...(c.before?{before:stripEntry(c.before)}:{}),...(c.after?{after:stripEntry(c.after)}:{})};}
function stripEvidence(ev:WorkerEvidence):WorkerEvidence{return {...ev,...(ev.entries?{entries:[]}:{}),changes:ev.changes.map(stripChange)};}

// High-volume event types: keep only the most recent N to bound payload size.
// All other event types are kept in full so run-recovery logic is never starved of events.
export const HIGH_VOL_TYPES=new Set(['assignment.progress','assignment.reconciled','validation.check_output']);
// Persisted-state cap for the high-volume types (the UI payload above is trimmed further, to 200).
export const HIGH_VOL_RETAINED=500;
/**
 * Drop the oldest high-volume events in place so at most `keep` remain. Call inside the mutation that appends them.
 * Events are chronological; an event with no `seq` yet was appended by the current mutation and is never dropped.
 * Sequence numbers are persisted and monotonic, so removing old events cannot reuse or rewind them.
 */
export function pruneHighVolumeEvents(events:State['events'],keep=HIGH_VOL_RETAINED):void{
  let excess=-keep;for(const e of events)if(HIGH_VOL_TYPES.has(e.type))excess++;
  if(excess<=0)return;
  let write=0;
  for(const e of events){if(excess>0&&HIGH_VOL_TYPES.has(e.type)&&e.seq!==undefined){excess--;continue;}events[write++]=e;}
  events.length=write;
}
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
