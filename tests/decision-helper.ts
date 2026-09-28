import type { Controller } from '../src/controller.js';

/** The digest an operator would have fetched from GET /api/runs/:id/decision when the decision panel rendered. */
export async function decisionDigest(controller: Controller, runId: string): Promise<string> {
  return (await controller.decisionEvidence(runId)).evidenceDigest;
}
