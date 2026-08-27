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
import { RedditDemandSource, redditDemandSourceFromEnv } from "./reddit.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type RedditDemandSourceStatus = "available" | "unavailable";

export interface DemandScanRecord {
  day: string;
  scannedAt: number;
  candidateCount: number;
  redditSourceStatus: RedditDemandSourceStatus;
}

export interface DemandAskUpsertResult {
  insertedCount: number;
  skippedCount: number;
  dedupedCount: number;
}

export interface DemandScanMemory {
  recordDemandScan(scan: DemandScanRecord): Promise<void>;
  upsertDemandAsks(asks: DemandAsk[]): Promise<DemandAskUpsertResult>;
}

export interface DemandSourceSet {
  sources: CandidateSource[];
  initialMessages: string[];
  redditSourceConfigured: boolean;
  classificationCap: number;
}

export interface DemandSourceSetOptions {
  env?: Env;
  fetchImpl?: typeof globalThis.fetch;
}

export interface PreparedDemandSweep {
  day: string;
  scannedAt: number;
  sourceStatus: RedditDemandSourceStatus;
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

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function demandStatus(configured: boolean, messages: readonly string[]): RedditDemandSourceStatus {
  if (!configured) return "unavailable";
  return messages.some((message) => message.startsWith("Reddit demand source was unavailable"))
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

/** Build the Reddit-only source set without an API call. Missing credentials deliberately omit it. */
export function demandSourceSet(options: DemandSourceSetOptions = {}): DemandSourceSet {
  const env = options.env ?? process.env;
  const classificationCap = demandClassificationCap(env);
  try {
    const source = redditDemandSourceFromEnv(env, options.fetchImpl);
    return {
      sources: [source],
      initialMessages: [],
      redditSourceConfigured: true,
      classificationCap,
    };
  } catch {
    return {
      sources: [],
      initialMessages: [REDDIT_DEMAND_SOURCE_UNAVAILABLE_MESSAGE],
      redditSourceConfigured: false,
      classificationCap,
    };
  }
}

/** Gather, boundary-check, cap, and seal one demand batch before the fresh classifier sees it. */
export async function prepareDemandSweep(options: {
  sourceSet: DemandSourceSet;
  memory: Pick<DemandScanMemory, "recordDemandScan">;
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
  const sourceStatus = demandStatus(options.sourceSet.redditSourceConfigured, messages);
  try {
    await options.memory.recordDemandScan({
      day,
      scannedAt,
      candidateCount: plan.candidates.length,
      redditSourceStatus: sourceStatus,
    });
  } catch {
    messages.push("Demand scan record could not be written; no demand evidence was stored.");
  }
  return {
    day,
    scannedAt,
    sourceStatus,
    plan,
    seal: sealDemandCandidatePlan(plan, options.secret),
    messages,
  };
}

/** Revalidate sealed classifier results before storage. A bad seal is an empty, fail-closed result. */
export async function completeDemandSweep(options: {
  prepared: PreparedDemandSweep;
  classifications: readonly unknown[];
  memory: Pick<DemandScanMemory, "upsertDemandAsks">;
  secret: string;
  now?: () => number;
  env?: Env;
}): Promise<CompletedDemandSweep> {
  if (!verifiesDemandCandidatePlan(options.prepared.plan, options.secret, options.prepared.seal)) {
    return {
      asks: [],
      classification: {
        asks: [],
        malformedOutputCount: 0,
        nonBuyerCount: 0,
        nonVerbatimQuoteCount: 0,
        leakyCount: 0,
      },
      messages: ["Demand sweep results were rejected because their fetched candidate seal was invalid."],
      persistence: null,
    };
  }
  const classification = classifyDemandCandidates(
    options.prepared.plan,
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
    const persistence = await options.memory.upsertDemandAsks(classification.asks);
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

export { RedditDemandSource };
