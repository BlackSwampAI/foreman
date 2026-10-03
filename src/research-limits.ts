import defaults from './research-limits.json' with { type: 'json' };

export interface ResearchLimits {
  network: {
    defaultRequestsPerRun: number;
    maximumRequestsPerRun: number;
    defaultRequestsPerBatch: number;
    maximumRequestsPerBatch: number;
    maxResponseBytes: number;
    maximumResponseBytes: number;
    defaultTotalResponseBytes: number;
    maximumTotalResponseBytes: number;
    defaultExcerptBytes: number;
    maximumExcerptBytes: number;
    timeoutMs: number;
    maximumTimeoutMs: number;
  };
  handoff: {
    promptBytes: number;
    workerResearchBytes: number;
    reviewPackageBytes: number;
    reviewDiffBytes: number;
    apiBodyBytes: number;
    cliOutputBytes: number;
    proposalBytes: number;
  };
}

function envLimit(name: string, fallback: number, minimum: number, maximum: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

/** Read at use time because the application loads its .env after ESM imports. */
export function getResearchLimits(env: NodeJS.ProcessEnv = process.env): ResearchLimits {
  return { network: {
    ...defaults.network,
    defaultRequestsPerRun: envLimit('FOREMAN_RESEARCH_REQUESTS', defaults.network.defaultRequestsPerRun, 1, defaults.network.maximumRequestsPerRun, env),
    defaultRequestsPerBatch: envLimit('FOREMAN_RESEARCH_BATCH', defaults.network.defaultRequestsPerBatch, 1, defaults.network.maximumRequestsPerBatch, env),
    maxResponseBytes: envLimit('FOREMAN_RESEARCH_RESPONSE_BYTES', defaults.network.maxResponseBytes, 1_024, defaults.network.maximumResponseBytes, env),
    defaultTotalResponseBytes: envLimit('FOREMAN_RESEARCH_BYTES', defaults.network.defaultTotalResponseBytes, 1_048_576, defaults.network.maximumTotalResponseBytes, env),
    defaultExcerptBytes: envLimit('FOREMAN_RESEARCH_EXCERPT_BYTES', defaults.network.defaultExcerptBytes, 1_024, defaults.network.maximumExcerptBytes, env),
    timeoutMs: envLimit('FOREMAN_RESEARCH_TIMEOUT_MS', defaults.network.timeoutMs, 1_000, defaults.network.maximumTimeoutMs, env),
  },
  handoff: {
    ...defaults.handoff,
    promptBytes: envLimit('FOREMAN_PROMPT_BYTES', defaults.handoff.promptBytes, 16_000, 1_048_576, env),
    workerResearchBytes: envLimit('FOREMAN_WORKER_RESEARCH_BYTES', defaults.handoff.workerResearchBytes, 4_096, 786_432, env),
    reviewPackageBytes: envLimit('FOREMAN_REVIEW_PACKAGE_BYTES', defaults.handoff.reviewPackageBytes, 68_000, 4_194_304, env),
    reviewDiffBytes: envLimit('FOREMAN_REVIEW_DIFF_BYTES', defaults.handoff.reviewDiffBytes, 48_000, 1_048_576, env),
    apiBodyBytes: envLimit('FOREMAN_UHP_BODY_BYTES', defaults.handoff.apiBodyBytes, 256_000, 16_777_216, env),
    cliOutputBytes: envLimit('FOREMAN_UHP_OUTPUT_BYTES', defaults.handoff.cliOutputBytes, 64_000, 2_097_152, env),
    proposalBytes: envLimit('FOREMAN_PROPOSAL_BYTES', defaults.handoff.proposalBytes, 8_000, 262_144, env),
  } };
}

export interface RunResearchBudget {
  maxRequests: number;
  maxBatchSize: number;
  maxResponseBytes: number;
  maxTotalResponseBytes: number;
  maxExcerptBytes: number;
  timeoutMs: number;
}

export type RunResearchBudgetOverrides = Partial<RunResearchBudget>;

export function defaultRunResearchBudget(overrides: RunResearchBudgetOverrides = {}): RunResearchBudget {
  const limits = getResearchLimits().network;
  const budget: RunResearchBudget = {
    maxRequests: overrides.maxRequests ?? limits.defaultRequestsPerRun,
    maxBatchSize: overrides.maxBatchSize ?? limits.defaultRequestsPerBatch,
    maxResponseBytes: overrides.maxResponseBytes ?? limits.maxResponseBytes,
    maxTotalResponseBytes: overrides.maxTotalResponseBytes ?? limits.defaultTotalResponseBytes,
    maxExcerptBytes: overrides.maxExcerptBytes ?? limits.defaultExcerptBytes,
    timeoutMs: overrides.timeoutMs ?? limits.timeoutMs,
  };
  const ranges: Array<[keyof RunResearchBudget, number, number]> = [
    ['maxRequests', 1, limits.maximumRequestsPerRun],
    ['maxBatchSize', 1, limits.maximumRequestsPerBatch],
    ['maxResponseBytes', 1_024, limits.maximumResponseBytes],
    ['maxTotalResponseBytes', 1_048_576, limits.maximumTotalResponseBytes],
    ['maxExcerptBytes', 1_024, limits.maximumExcerptBytes],
    ['timeoutMs', 1_000, limits.maximumTimeoutMs],
  ];
  for (const [key, minimum, maximum] of ranges) {
    const value = budget[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw Object.assign(new Error(`Research budget ${key} must be an integer between ${minimum} and ${maximum}`), { statusCode: 422 });
    }
  }
  if (budget.maxResponseBytes > budget.maxTotalResponseBytes) {
    throw Object.assign(new Error('Research budget maxResponseBytes cannot exceed maxTotalResponseBytes'), { statusCode: 422 });
  }
  if (budget.maxBatchSize > budget.maxRequests) {
    throw Object.assign(new Error('Research budget maxBatchSize cannot exceed maxRequests'), { statusCode: 422 });
  }
  return budget;
}
