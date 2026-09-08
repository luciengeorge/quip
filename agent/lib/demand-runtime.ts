import { createHmac, timingSafeEqual } from "node:crypto";

import { gatherSources, type CandidateSource } from "./candidates.ts";
import { demandClassificationCap } from "./config.ts";
import { renderDailyDemandReport, renderDemandSweepNotice } from "./demand-report.ts";
import {
  DEMAND_THEME_WINDOW_DAYS,
  distinctAskerCount,
  isIncumbentCoverage,
  themesNeedingResearch,
  unassignedAsks,
  validateThemeAssignments,
  verdictFor,
} from "./demand-themes.ts";
import { renderDemandVerdictReport } from "./demand-verdict-report.ts";
import { calculateBuildEstimate } from "./build-cost.ts";
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
  type DemandAskRecord,
  type DemandCandidatePlanCompletion,
  type DemandCandidatePlanRecord,
  type StoredDemandTheme,
  type StoredThemeResearch,
} from "./memory.ts";
import { RedditDemandSource, redditDemandSourceFromEnv } from "./reddit.ts";
import {
  StackExchangeDemandSource,
  stackExchangeDemandSourceFromEnv,
} from "./stackexchange.ts";
import { XDemandSource, xDemandSourceFromEnv } from "./x-demand.ts";
import type { XReadBudget } from "./x.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type DemandSourceStatus = "available" | "unavailable";
export type XDemandSourceStatus = "not-configured" | "configured-empty" | "contributed";

export interface DemandScanRecord {
  day: string;
  scannedAt: number;
  candidateCount: number;
  redditSourceStatus: DemandSourceStatus;
  stackExchangeSourceStatus: DemandSourceStatus;
  xSourceStatus: XDemandSourceStatus;
}

export interface DemandAskUpsertResult {
  insertedCount: number;
  skippedCount: number;
  dedupedCount: number;
  /** Permalinks stored by this call. A repeat ask is evidence, but it is not news. */
  insertedPermalinks: string[];
}

/** Everything the theme pass reads and writes, so tests can supply it without a network. */
export interface DemandThemeMemory {
  demandAsksInRange(startDay: string, endDay: string): Promise<DemandAskRecord[]>;
  demandScansInRange(startDay: string, endDay: string): Promise<{ candidateCount: number }[]>;
  openDemandThemes(since: number): Promise<StoredDemandTheme[]>;
  applyDemandThemeAssignments(input: {
    at: number;
    assignments: { themeKey: string; label: string; permalink: string; author: string }[];
  }): Promise<{ createdCount: number; updatedCount: number }>;
  recordDemandThemeResearch(input: StoredThemeResearch): Promise<"recorded" | "missing">;
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
  xSourceConfigured: boolean;
  classificationCap: number;
}

export interface DemandSourceSetOptions {
  env?: Env;
  budget?: XReadBudget;
  fetchImpl?: typeof globalThis.fetch;
}

export interface PreparedDemandSweep {
  planId: string | null;
  day: string;
  scannedAt: number;
  sourceStatus: DemandSourceStatus;
  redditSourceStatus: DemandSourceStatus;
  stackExchangeSourceStatus: DemandSourceStatus;
  xSourceStatus: XDemandSourceStatus;
  plan: DemandCandidatePlan;
  seal: string;
  messages: string[];
}

export interface CompletedDemandSweep {
  asks: DemandAsk[];
  classification: DemandClassificationResult;
  messages: string[];
  persistence: DemandAskUpsertResult | null;
  /** Asks stored by this run, reported as the day's news. */
  newAsks: { permalink: string; quote: string; askedFor: string }[];
  /** Every ask in the window with no theme yet, which is what the grouping pass works from. */
  asksToGroup: { permalink: string; quote: string; askedFor: string }[];
  /** Themes still inside the window, so a recurring want joins its theme instead of forking one. */
  openThemes: { themeKey: string; label: string }[];
}

/** What the sealed-result path establishes, before themes and the report are derived from it. */
type CompletedDemandSweepOutcome = Omit<
  CompletedDemandSweep,
  "newAsks" | "asksToGroup" | "openThemes"
> & {
  /** Null when no verified plan was in scope, so no day can be trusted. */
  day: string | null;
  candidateCount: number;
};

export const REDDIT_DEMAND_SOURCE_UNAVAILABLE_MESSAGE =
  "Reddit demand sweep was unavailable for this scan; trend sources remain available.";
export const STACKEXCHANGE_DEMAND_SOURCE_UNAVAILABLE_MESSAGE =
  "Stack Exchange demand sweep was unavailable for this scan; other demand sources may remain available.";
export const X_DEMAND_SOURCE_NOT_CONFIGURED_MESSAGE =
  "X demand source was not configured for this scan; other demand sources remain available.";
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

function xDemandSourceStatus(
  configured: boolean,
  candidates: readonly { source: string }[],
): XDemandSourceStatus {
  if (!configured) return "not-configured";
  return candidates.some((candidate) => candidate.source === "x")
    ? "contributed"
    : "configured-empty";
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

/** Build independent demand sources without API calls. X is present only with credentials and a meter. */
export function demandSourceSet(options: DemandSourceSetOptions = {}): DemandSourceSet {
  const env = options.env ?? process.env;
  const classificationCap = demandClassificationCap(env);
  const sources: CandidateSource[] = [];
  const initialMessages: string[] = [];
  let redditSourceConfigured = false;
  let stackExchangeSourceConfigured = false;
  let xSourceConfigured = false;
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
  if (options.budget) {
    try {
      sources.push(xDemandSourceFromEnv(options.budget, env, options.fetchImpl));
      xSourceConfigured = true;
    } catch {
      initialMessages.push(X_DEMAND_SOURCE_NOT_CONFIGURED_MESSAGE);
    }
  } else {
    initialMessages.push(X_DEMAND_SOURCE_NOT_CONFIGURED_MESSAGE);
  }
  return {
    sources,
    initialMessages,
    redditSourceConfigured,
    stackExchangeSourceConfigured,
    xSourceConfigured,
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
  const xSourceStatus = xDemandSourceStatus(options.sourceSet.xSourceConfigured, plan.candidates);
  const sourceStatus =
    redditSourceStatus === "available" ||
    stackExchangeSourceStatus === "available" ||
    xSourceStatus !== "not-configured"
      ? "available"
      : "unavailable";
  try {
    await options.memory.recordDemandScan({
      day,
      scannedAt,
      candidateCount: plan.candidates.length,
      redditSourceStatus,
      stackExchangeSourceStatus,
      xSourceStatus,
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
    xSourceStatus,
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
  const memory = memoryFromEnv();
  return await prepareDemandSweep({
    sourceSet: demandSourceSet({ env, budget: memory, fetchImpl }),
    memory,
    secret: demandSweepSecretFromEnv(env),
    env,
  });
}

/** Revalidate sealed classifier results before storage. A bad seal is an empty, fail-closed result. */
async function completeDemandSweepOutcome(options: {
  planId: string;
  classifications: readonly unknown[];
  memory: Pick<DemandScanMemory, "loadDemandCandidatePlan" | "completeDemandCandidatePlan">;
  secret: string;
  now?: () => number;
  env?: Env;
}): Promise<CompletedDemandSweepOutcome> {
  let stored: DemandCandidatePlanRecord | null;
  try {
    stored = await options.memory.loadDemandCandidatePlan(options.planId);
  } catch {
    return {
      asks: [],
      classification: emptyDemandClassification(),
      messages: ["Demand sweep results were rejected because the stored candidate plan could not be loaded."],
      persistence: null,
      day: null,
      candidateCount: 0,
    };
  }
  if (!stored) {
    return {
      asks: [],
      classification: emptyDemandClassification(),
      messages: ["Demand sweep results were rejected because the stored candidate plan was not found."],
      persistence: null,
      day: null,
      candidateCount: 0,
    };
  }
  if (!verifiesDemandCandidatePlan(stored.plan, options.secret, stored.seal)) {
    return {
      asks: [],
      classification: emptyDemandClassification(),
      messages: ["Demand sweep results were rejected because the stored candidate seal was invalid."],
      persistence: null,
      day: null,
      candidateCount: 0,
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
      day: stored.plan.day,
      candidateCount: stored.plan.candidates.length,
    };
  }
  if (stored.expiresAt <= (options.now ?? Date.now)()) {
    return {
      asks: [],
      classification: emptyDemandClassification(),
      messages: ["Demand sweep results were rejected because the stored candidate plan expired."],
      persistence: null,
      day: stored.plan.day,
      candidateCount: stored.plan.candidates.length,
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
        day: stored.plan.day,
        candidateCount: stored.plan.candidates.length,
      };
    }
    if (persistence.skippedCount > 0) {
      messages.push(`Demand ask persistence skipped ${persistence.skippedCount} invalid rows.`);
    }
    if (persistence.dedupedCount > 0) {
      messages.push(`Demand ask persistence skipped ${persistence.dedupedCount} existing permalinks.`);
    }
    return {
      asks: classification.asks,
      classification,
      messages,
      persistence,
      day: stored.plan.day,
      candidateCount: stored.plan.candidates.length,
    };
  } catch {
    return {
      asks: [],
      classification,
      messages: [...messages, "Demand ask persistence failed; no new demand evidence was stored."],
      persistence: null,
      day: stored.plan.day,
      candidateCount: stored.plan.candidates.length,
    };
  }
}

/**
 * Revalidate sealed classifier results, store them, and render the day's report.
 *
 * The report text is produced here from persisted values, then posted verbatim. Describing the
 * evidence to a model and asking it to write the summary is how a report ends up disagreeing
 * with the data it claims to describe.
 */
export async function completeDemandSweep(options: {
  planId: string;
  classifications: readonly unknown[];
  memory: Pick<DemandScanMemory, "loadDemandCandidatePlan" | "completeDemandCandidatePlan">;
  secret: string;
  now?: () => number;
  env?: Env;
  themeMemory?: Pick<DemandThemeMemory, "openDemandThemes" | "demandAsksInRange">;
}): Promise<CompletedDemandSweep> {
  const now = options.now ?? Date.now;
  const outcome = await completeDemandSweepOutcome(options);
  // Hand on only what this run stored. Persistence dedupes by permalink while classification
  // returns everything seen, so grouping the full set would re-file asks already in a theme and
  // inflate the recurrence count that decides a verdict.
  const stored = new Set(outcome.persistence?.insertedPermalinks ?? []);
  const newAsks = outcome.asks
    .filter((ask) => stored.has(ask.permalink))
    .map((ask) => ({ permalink: ask.permalink, quote: ask.quote, askedFor: ask.askedFor }));

  let openThemes: { themeKey: string; label: string }[] = [];
  let asksToGroup: { permalink: string; quote: string; askedFor: string }[] = [];
  try {
    const themeMemory = options.themeMemory ?? memoryFromEnv();
    const at = now();
    const themes = await themeMemory.openDemandThemes(themeWindowStart(at));
    openThemes = themes.map((theme) => ({ themeKey: theme.themeKey, label: theme.label }));
    const { startDay, endDay } = askWindowDays(at);
    const windowAsks = await themeMemory.demandAsksInRange(startDay, endDay);
    asksToGroup = unassignedAsks(windowAsks, themes).map((ask) => ({
      permalink: ask.permalink,
      quote: ask.quote,
      askedFor: ask.askedFor,
    }));
  } catch (error) {
    console.warn("[demand-sweep] theme context unavailable; grouping skipped:", error);
  }

  return {
    asks: outcome.asks,
    classification: outcome.classification,
    messages: outcome.messages,
    persistence: outcome.persistence,
    newAsks,
    asksToGroup,
    openThemes,
  };
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

export { RedditDemandSource, StackExchangeDemandSource, XDemandSource };

/**
 * Theme assignment, research, and reporting.
 *
 * The model chooses only the grouping and reports what it found. Every value that reaches the
 * report comes from stored rows, and the verdict is a rule applied in code, so a persuasive
 * research summary cannot change an outcome and a misgrouped ask cannot invent evidence.
 */

function themeWindowStart(now: number): number {
  return now - DEMAND_THEME_WINDOW_DAYS * 24 * 60 * 60 * 1_000;
}

function askWindowDays(now: number): { startDay: string; endDay: string } {
  return { startDay: utcDay(themeWindowStart(now)), endDay: utcDay(now) };
}

export interface ThemeAssignmentResult {
  assignedCount: number;
  createdCount: number;
  messages: string[];
  themesNeedingResearch: {
    themeKey: string;
    label: string;
    askerCount: number;
    quotes: string[];
  }[];
}

export async function applyDemandThemeAssignments(
  raw: readonly unknown[],
  options: { memory?: DemandThemeMemory; now?: () => number } = {},
): Promise<ThemeAssignmentResult> {
  const now = (options.now ?? Date.now)();
  const memory = options.memory ?? memoryFromEnv();
  const { startDay, endDay } = askWindowDays(now);
  const windowAsks = await memory.demandAsksInRange(startDay, endDay);
  const openThemes = await memory.openDemandThemes(themeWindowStart(now));
  // Only asks with no theme yet are assignable. Re-filing an assigned ask would place it under a
  // second theme and count the same person twice toward two different verdicts.
  const groupable = unassignedAsks(windowAsks, openThemes);

  const validation = validateThemeAssignments(
    raw,
    groupable.map((ask) => ask.permalink),
    openThemes,
  );
  const authorByPermalink = new Map(windowAsks.map((ask) => [ask.permalink, ask.author]));
  const applied = await memory.applyDemandThemeAssignments({
    at: now,
    assignments: validation.assignments.map((assignment) => ({
      themeKey: assignment.themeKey,
      label: assignment.label,
      permalink: assignment.permalink,
      author: authorByPermalink.get(assignment.permalink) ?? "",
    })),
  });

  // Re-read rather than reasoning about what the write did: the recurrence count decides whether
  // a research call is spent, and it must come from the stored set, not from a local guess.
  const refreshed = await memory.openDemandThemes(themeWindowStart(now));
  const quoteByPermalink = new Map(windowAsks.map((ask) => [ask.permalink, ask.quote]));
  const needing = themesNeedingResearch(refreshed, now).map((theme) => ({
    themeKey: theme.themeKey,
    label: theme.label,
    askerCount: distinctAskerCount(theme),
    quotes: theme.permalinks
      .map((permalink) => quoteByPermalink.get(permalink))
      .filter((quote): quote is string => typeof quote === "string")
      .slice(0, 5),
  }));

  return {
    assignedCount: validation.assignments.length,
    createdCount: applied.createdCount,
    messages: validation.messages,
    themesNeedingResearch: needing,
  };
}

export async function recordThemeResearch(
  input: {
    themeKey: string;
    incumbentCoverage: string;
    incumbents: { name: string; covers: string }[];
    researchSummary: string;
    sources: { url: string; claim: string }[];
    buildComponents: string[];
  },
  options: { memory?: DemandThemeMemory; now?: () => number } = {},
): Promise<{ status: string; verdict?: string; buildDays?: number }> {
  const now = (options.now ?? Date.now)();
  const memory = options.memory ?? memoryFromEnv();
  if (!isIncumbentCoverage(input.incumbentCoverage)) {
    return { status: "rejected-coverage" };
  }
  const themes = await memory.openDemandThemes(themeWindowStart(now));
  const theme = themes.find((candidate) => candidate.themeKey === input.themeKey);
  if (!theme) return { status: "unknown-theme" };

  const estimate = calculateBuildEstimate(input.buildComponents);
  const verdict = verdictFor(input.incumbentCoverage);
  const status = await memory.recordDemandThemeResearch({
    themeKey: input.themeKey,
    researchedAt: now,
    researchedAskerCount: distinctAskerCount(theme),
    incumbentCoverage: input.incumbentCoverage,
    incumbents: input.incumbents,
    researchSummary: input.researchSummary,
    sources: input.sources,
    buildDays: estimate.ok ? estimate.buildDays : 0,
    buildBreakdown: estimate.ok ? estimate.breakdown : "unrecognised components",
    verdict,
  });
  return {
    status,
    verdict,
    buildDays: estimate.ok ? estimate.buildDays : 0,
  };
}

export async function buildDemandReport(
  options: { memory?: DemandThemeMemory; now?: () => number } = {},
): Promise<{ report: string }> {
  const now = (options.now ?? Date.now)();
  const memory = options.memory ?? memoryFromEnv();
  const today = utcDay(now);
  const { startDay, endDay } = askWindowDays(now);
  const [todaysAsks, windowAsks, themes, scans] = await Promise.all([
    memory.demandAsksInRange(today, today),
    memory.demandAsksInRange(startDay, endDay),
    memory.openDemandThemes(themeWindowStart(now)),
    memory.demandScansInRange(today, today),
  ]);
  const candidateCount = scans.reduce((total, scan) => total + scan.candidateCount, 0);
  return {
    report: renderDemandVerdictReport({
      day: today,
      themes,
      newAsks: todaysAsks,
      candidateCount,
      windowAskCount: windowAsks.length,
      generatedAt: now,
    }),
  };
}
