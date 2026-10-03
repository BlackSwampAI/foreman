import { describe, expect, it } from 'vitest';
import { initialState } from '../src/domain.js';
import { stateForUi } from '../src/state-transform.js';

describe('stateForUi research counters', () => {
  it('derives historical usage for a legacy run without mutating stored state', () => {
    const createdAt = '2026-01-02T03:04:05.000Z';
    const run: any = {
      id: 'run_legacy', status: 'waiting_guidance', createdAt,
      sessions: { planner: { localId: 'planner' }, orchestrator: { localId: 'orchestrator' } },
      sessionHistory: [], roleConfigs: {}, guidance: [], assignments: [], reviews: [],
      researchEvidence: [12, 30].map((capturedBytes, index) => ({
        id: `research_${index}`, requestedUrl: `https://api.sleeper.app/${index}`,
        retrievedAt: createdAt, outcome: 'retrieved', capturedBytes,
      })),
    };
    const state: any = initialState();
    state.projects.push({
      id: 'project_legacy', name: 'Legacy', status: 'active', createdAt,
      defaultRoleConfigs: {}, tasks: [{
        id: 'task_legacy', title: 'Legacy task', goal: 'Legacy task', status: 'blocked',
        createdAt, suggestedAllowedPaths: [], runs: [run],
      }],
    });

    const displayed = stateForUi(state).projects[0]!.tasks[0]!.runs[0]!;
    expect(displayed).toMatchObject({
      researchBudget: { maxRequests: 6, maxBatchSize: 3 },
      researchHttpRequests: 2,
      researchBytesCaptured: 42,
      researchCacheHits: 0,
      roleTurnMaximum: 50,
    });
    expect(displayed.researchBudgetMaximum?.maxRequests).toBeGreaterThanOrEqual(24);
    expect(run).not.toHaveProperty('researchBudget');
    expect(run).not.toHaveProperty('researchHttpRequests');
    expect(run).not.toHaveProperty('researchBytesCaptured');
    expect(run).not.toHaveProperty('researchCacheHits');
  });
});
