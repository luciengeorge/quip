import { createHmac, timingSafeEqual } from "node:crypto";

import { gatherSources, type CandidateSource } from "./candidates.ts";
import { demandClassificationCap } from "./config.ts";
import {
  classifyDemandCandidates,
  planDemandCandidates,
  type DemandAsk,
  type DemandCandidatePlan,
  type DemandClassificationResult,
} from "./demand-scan.ts";
import { leakGuardConfigFromEnv } from "./leak-guard.ts";
import {
  memoryFromEnv,
  type DemandCandidatePlanCompletion,
  type DemandCandidatePlanRecord,
} from "./memory.ts";
import { RedditDemandSource, redditDemandSourceFromEnv } from "./reddit.ts";
import {
  StackExchangeDemandSource,
  stackExchangeDemandSourceFromEnv,
} from "./stackexchange.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type DemandSourceStatus = "available" | "unavailable";

export interface DemandScanRecord {
  day: string;
  scannedAt: number;
  candidateCount: number;
  redditSourceStatus: DemandSourceStatus;
  stackExchangeSourceStatus: DemandSourceStatus;
}

export interface DemandAskUpsertResult {
  insertedCount: number;
  skippedCount: number;
  dedupedCount: number;
}

export interface DemandScanMemory {
  recordDemandScan(scan: DemandScanRecord): Promise<void>;
  storeDemandCandidatePlan(input: {
    plan: DemandCandidatePlan;
    seal: string;
    expiresAt: number;
  }): Promise<string>;
  loadDemandCandidatePlan(planId: string): Promise<DemandCandidatePlanRecord | null>;
  completeDemandCandidatePlan(input: {
    planId: string;
    asks: DemandAsk[];
    completedAt: number;
  }): Promise<DemandCandidatePlanCompletion>;
}

export interface DemandSourceSet {
  sources: CandidateSource[];
  initialMessages: string[];
  redditSourceConfigured: boolean;
  stackExchangeSourceConfigured: boolean;
  classificationCap: number;
}

export interface DemandSourceSetOptions {
  env?: Env;
  fetchImpl?: typeof globalThis.fetch;
}

export interface PreparedDemandSweep {
  planId: string | null;
  day: string;
  scannedAt: number;
  sourceStatus: DemandSourceStatus;
  redditSourceStatus: DemandSourceStatus;
  stackExchangeSourceStatus: DemandSourceStatus;
  plan: DemandCandidatePlan;
  seal: string;
  messages: string[];
}

export interface CompletedDemandSweep {
  asks: DemandAsk[];
  classification: DemandClassificationResult;
  messages: string[];
  persistence: DemandAskUpsertResult | null;
}

export const REDDIT_DEMAND_SOURCE_UNAVAILABLE_MESSAGE =
  "Reddit demand sweep was unavailable for this scan; trend sources remain available.";
export const STACKEXCHANGE_DEMAND_SOURCE_UNAVAILABLE_MESSAGE =
  "Stack Exchange demand sweep was unavailable for this scan; other demand sources may remain available.";
export const DEMAND_CANDIDATE_PLAN_TTL_MS = 48 * 60 * 60 * 1_000;

export function demandSweepSecretFromEnv(env: Env = process.env): string {
  const secret = env.CONVEX_APP_SECRET?.trim();
  if (!secret) throw new Error("CONVEX_APP_SECRET is not set");
  return secret;
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function demandStatus(
  configured: boolean,
  unavailablePrefix: string,
  messages: readonly string[],
): DemandSourceStatus {
  if (!configured) return "unavailable";
  return messages.some((message) => message.startsWith(unavailablePrefix))
    ? "unavailable"
    : "available";
}

function planPayload(plan: DemandCandidatePlan): string {
  return JSON.stringify({
    day: plan.day,
    cap: plan.cap,
    candidates: plan.candidates.map((candidate) => ({
      source: candidate.source,
      title: candidate.title,
      url: candidate.url,
      context: candidate.context,
      timestamp: candidate.timestamp,
      author: candidate.author,
      replyCount: candidate.replyCount,
      subreddit: candidate.subreddit,
      sourceText: candidate.sourceText,
    })),
  });
}

/** Seal fetched candidates before the model receives them, so persistence accepts only the fetched set. */
export function sealDemandCandidatePlan(plan: DemandCandidatePlan, secret: string): string {
  return createHmac("sha256", secret).update(planPayload(plan)).digest("hex");
}

export function verifiesDemandCandidatePlan(
  plan: DemandCandidatePlan,
  secret: string,
  seal: string,
): boolean {
  const expected = sealDemandCandidatePlan(plan, secret);
  if (!/^[a-f0-9]{64}$/u.test(seal)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(seal, "hex"));
}

/** Build independent Reddit and Stack Exchange sources without API calls. */
export function demandSourceSet(options: DemandSourceSetOptions = {}): DemandSourceSet {
  const env = options.env ?? process.env;
  const classificationCap = demandClassificationCap(env);
  const sources: CandidateSource[] = [];
  const initialMessages: string[] = [];
  let redditSourceConfigured = false;
  let stackExchangeSourceConfigured = false;
  try {
    sources.push(redditDemandSourceFromEnv(env, options.fetchImpl));
    redditSourceConfigured = true;
  } catch {
    initialMessages.push(REDDIT_DEMAND_SOURCE_UNAVAILABLE_MESSAGE);
  }
  try {
    sources.push(stackExchangeDemandSourceFromEnv(env, options.fetchImpl));
    stackExchangeSourceConfigured = true;
  } catch {
    initialMessages.push(STACKEXCHANGE_DEMAND_SOURCE_UNAVAILABLE_MESSAGE);
  }
  return {
    sources,
    initialMessages,
    redditSourceConfigured,
    stackExchangeSourceConfigured,
    classificationCap,
  };
}

/** Gather, boundary-check, cap, and seal one demand batch before the fresh classifier sees it. */
export async function prepareDemandSweep(options: {
  sourceSet: DemandSourceSet;
  memory: Pick<DemandScanMemory, "recordDemandScan" | "storeDemandCandidatePlan">;
  secret: string;
  now?: () => number;
  env?: Env;
}): Promise<PreparedDemandSweep> {
  const scannedAt = (options.now ?? Date.now)();
  const day = utcDay(scannedAt);
  const gathered = await gatherSources(options.sourceSet.sources);
  const messages = [...options.sourceSet.initialMessages, ...gathered.messages];
  const plan = planDemandCandidates(
    gathered.candidates,
    day,
    options.sourceSet.classificationCap,
    leakGuardConfigFromEnv(options.env),
  );
  if (plan.droppedCount > 0) {
    messages.push(`Demand sweep dropped ${plan.droppedCount} invalid candidates before classification.`);
  }
  if (plan.duplicateCount > 0) {
    messages.push(`Demand sweep dropped ${plan.duplicateCount} duplicate permalinks before classification.`);
  }
  if (plan.leakyCount > 0) {
    messages.push(`Demand sweep dropped ${plan.leakyCount} candidates blocked by the leak guard.`);
  }
  if (plan.cappedCount > 0) {
    messages.push(
      `Demand sweep limited classification to ${plan.cap} candidates and skipped ${plan.cappedCount} over the cap.`,
    );
  }
  const redditSourceStatus = demandStatus(
    options.sourceSet.redditSourceConfigured,
    "Reddit demand source was unavailable",
    messages,
  );
  const stackExchangeSourceStatus = demandStatus(
    options.sourceSet.stackExchangeSourceConfigured,
    "Stack Exchange demand source was unavailable",
    messages,
  );
  const sourceStatus =
    redditSourceStatus === "available" || stackExchangeSourceStatus === "available"
      ? "available"
      : "unavailable";
  try {
    await options.memory.recordDemandScan({
      day,
      scannedAt,
      candidateCount: plan.candidates.length,
      redditSourceStatus,
      stackExchangeSourceStatus,
    });
  } catch {
    messages.push("Demand scan record could not be written; no demand evidence was stored.");
  }
  const seal = sealDemandCandidatePlan(plan, options.secret);
  let planId: string | null = null;
  try {
    planId = await options.memory.storeDemandCandidatePlan({
      plan,
      seal,
      expiresAt: scannedAt + DEMAND_CANDIDATE_PLAN_TTL_MS,
    });
  } catch {
    messages.push("Demand candidate plan could not be stored; no classifier handoff was sent.");
  }
  return {
    planId,
    day,
    scannedAt,
    sourceStatus,
    redditSourceStatus,
    stackExchangeSourceStatus,
    plan,
    seal,
    messages,
  };
}

/** Execute one durable demand sweep using the configured source set. */
export async function runDemandSweepFromEnv(
  fetchImpl?: typeof globalThis.fetch,
): Promise<PreparedDemandSweep> {
  const env = process.env;
  return await prepareDemandSweep({
    sourceSet: demandSourceSet({ env, fetchImpl }),
    memory: memoryFromEnv(),
    secret: demandSweepSecretFromEnv(env),
    env,
  });
}

/** Revalidate sealed classifier results before storage. A bad seal is an empty, fail-closed result. */
export async function completeDemandSweep(options: {
  planId: string;
  classifications: readonly unknown[];
  memory: Pick<DemandScanMemory, "loadDemandCandidatePlan" | "completeDemandCandidatePlan">;
  secret: string;
  now?: () => number;
  env?: Env;
}): Promise<CompletedDemandSweep> {
  let stored: DemandCandidatePlanRecord | null;
  try {
    stored = await options.memory.loadDemandCandidatePlan(options.planId);
  } catch {
    return {
      asks: [],
      classification: emptyDemandClassification(),
      messages: ["Demand sweep results were rejected because the stored candidate plan could not be loaded."],
      persistence: null,
    };
  }
  if (!stored) {
    return {
      asks: [],
      classification: emptyDemandClassification(),
      messages: ["Demand sweep results were rejected because the stored candidate plan was not found."],
      persistence: null,
    };
  }
  if (!verifiesDemandCandidatePlan(stored.plan, options.secret, stored.seal)) {
    return {
      asks: [],
      classification: emptyDemandClassification(),
      messages: ["Demand sweep results were rejected because the stored candidate seal was invalid."],
      persistence: null,
    };
  }
  if (stored.status !== "pending") {
    return {
      asks: [],
      classification: emptyDemandClassification(),
      messages: [
        stored.status === "expired"
          ? "Demand sweep results were rejected because the stored candidate plan expired."
          : "Demand sweep results were rejected because the stored candidate plan was already completed.",
      ],
      persistence: null,
    };
  }
  if (stored.expiresAt <= (options.now ?? Date.now)()) {
    return {
      asks: [],
      classification: emptyDemandClassification(),
      messages: ["Demand sweep results were rejected because the stored candidate plan expired."],
      persistence: null,
    };
  }
  const classification = classifyDemandCandidates(
    stored.plan,
    options.classifications,
    (options.now ?? Date.now)(),
    leakGuardConfigFromEnv(options.env),
  );
  const messages: string[] = [];
  if (classification.malformedOutputCount > 0) {
    messages.push(
      `Demand sweep dropped ${classification.malformedOutputCount} malformed classifier outputs.`,
    );
  }
  if (classification.nonVerbatimQuoteCount > 0) {
    messages.push(
      `Demand sweep dropped ${classification.nonVerbatimQuoteCount} non-verbatim classifier quotes.`,
    );
  }
  if (classification.leakyCount > 0) {
    messages.push(`Demand sweep dropped ${classification.leakyCount} classifier outputs blocked by the leak guard.`);
  }
  try {
    const persistence = await options.memory.completeDemandCandidatePlan({
      planId: options.planId,
      asks: classification.asks,
      completedAt: (options.now ?? Date.now)(),
    });
    if (persistence.status !== "completed") {
      return {
        asks: [],
        classification,
        messages: [
          ...messages,
          persistence.status === "expired"
            ? "Demand ask persistence skipped because the stored candidate plan expired."
            : "Demand ask persistence skipped because the stored candidate plan was already used or missing.",
        ],
        persistence: null,
      };
    }
    if (persistence.skippedCount > 0) {
      messages.push(`Demand ask persistence skipped ${persistence.skippedCount} invalid rows.`);
    }
    if (persistence.dedupedCount > 0) {
      messages.push(`Demand ask persistence skipped ${persistence.dedupedCount} existing permalinks.`);
    }
    return { asks: classification.asks, classification, messages, persistence };
  } catch {
    return {
      asks: [],
      classification,
      messages: [...messages, "Demand ask persistence failed; no new demand evidence was stored."],
      persistence: null,
    };
  }
}

function emptyDemandClassification(): DemandClassificationResult {
  return {
    asks: [],
    malformedOutputCount: 0,
    nonBuyerCount: 0,
    nonVerbatimQuoteCount: 0,
    leakyCount: 0,
  };
}

export { RedditDemandSource, StackExchangeDemandSource };
