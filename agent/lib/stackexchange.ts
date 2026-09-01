import { sourceResult, type Candidate, type CandidateSource, type SourceResult } from "./candidates.ts";
import { demandQueriesFromEnv } from "./reddit.ts";
import { leakGuardConfigFromEnv, type LeakGuardConfig } from "./leak-guard.ts";

const STACKEXCHANGE_API_ORIGIN = "https://api.stackexchange.com";
const DEMAND_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000;

/** The public API permits pages of up to 100, but a narrow batch protects the classifier. */
export const STACKEXCHANGE_SEARCH_RESULTS_PER_REQUEST = 25;
/** A hard cap prevents a broad query configuration from exhausting the unauthenticated quota. */
export const STACKEXCHANGE_MAX_SEARCH_REQUESTS_PER_SWEEP = 20;
/** Stop before the public quota is exhausted, leaving room for operational diagnostics. */
export const STACKEXCHANGE_QUOTA_FLOOR = 25;
export const DEFAULT_STACKEXCHANGE_SITES = ["softwarerecs"] as const;
/** Keep one oversized response from consuming the classifier batch. */
export const STACKEXCHANGE_MAX_SOURCE_TEXT_LENGTH = 6_000;

export interface StackExchangeDemandCandidate extends Candidate {
  source: "stackexchange";
  author: string;
  replyCount: number;
  /** Reuses the existing demand shape. For this source it is the API site parameter. */
  subreddit: string;
  sourceText: string;
}

interface StackExchangeDemandSourceConfig {
  sites: readonly string[];
  queries: readonly string[];
  fetchImpl?: typeof globalThis.fetch;
  leakGuard?: LeakGuardConfig;
  now?: () => number;
}

interface SearchResult {
  candidates: StackExchangeDemandCandidate[];
  malformedCount: number;
  answeredCount: number;
  closedCount: number;
  duplicateCount: number;
  quotaRemaining: number;
  backoffSeconds: number | null;
}

type Env = Readonly<Record<string, string | undefined>>;

type QuestionResult =
  | { kind: "candidate"; candidate: StackExchangeDemandCandidate }
  | { kind: "answered" | "closed" | "duplicate" | "malformed" };

function listSetting(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function externalUrl(value: unknown): string | null {
  const link = nonBlankString(value);
  if (!link) return null;
  try {
    const parsed = new URL(link);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Parse only normal site identifiers so configuration cannot alter request paths. */
export function stackExchangeSitesFromEnv(value: string | undefined): string[] {
  const configured = value?.trim();
  const sites = configured ? listSetting(configured) : [...DEFAULT_STACKEXCHANGE_SITES];
  return sites.filter((site) => /^[A-Za-z0-9.-]{2,100}$/u.test(site));
}

function questionCandidate(value: unknown, site: string): QuestionResult {
  const raw = record(value);
  if (!raw) return { kind: "malformed" };
  if (raw.is_answered === true) return { kind: "answered" };
  if (raw.closed_reason === "duplicate") return { kind: "duplicate" };
  if (raw.closed_date !== undefined) return { kind: "closed" };

  const title = nonBlankString(raw.title);
  const body = nonBlankString(raw.body);
  const link = externalUrl(raw.link);
  const creationDate = positiveInteger(raw.creation_date);
  const replyCount = nonNegativeInteger(raw.answer_count);
  const owner = record(raw.owner);
  const author = owner ? nonBlankString(owner.display_name) : null;
  if (
    raw.is_answered !== false ||
    !title ||
    !body ||
    !link ||
    creationDate === null ||
    replyCount === null ||
    !author
  ) {
    return { kind: "malformed" };
  }
  const sourceText = `${title}\n${body}`;
  if (sourceText.length > STACKEXCHANGE_MAX_SOURCE_TEXT_LENGTH) return { kind: "malformed" };
  return {
    kind: "candidate",
    candidate: {
      source: "stackexchange",
      title,
      url: link,
      context: sourceText,
      // Stack Exchange dates are Unix epoch seconds. Demand scoring operates in milliseconds.
      timestamp: creationDate * 1_000,
      author,
      replyCount,
      subreddit: site,
      sourceText,
    },
  };
}

function listing(value: unknown, site: string): SearchResult | null {
  const root = record(value);
  if (!root || !Array.isArray(root.items)) return null;
  const quotaRemaining = nonNegativeInteger(root.quota_remaining);
  if (quotaRemaining === null) return null;
  const backoff = root.backoff;
  const backoffSeconds =
    backoff === undefined ? null : nonNegativeInteger(backoff);
  if (backoff !== undefined && backoffSeconds === null) return null;

  let malformedCount = 0;
  let answeredCount = 0;
  let closedCount = 0;
  let duplicateCount = 0;
  const candidates: StackExchangeDemandCandidate[] = [];
  for (const item of root.items) {
    const parsed = questionCandidate(item, site);
    if (parsed.kind === "candidate") {
      candidates.push(parsed.candidate);
      continue;
    }
    if (parsed.kind === "answered") answeredCount += 1;
    if (parsed.kind === "closed") closedCount += 1;
    if (parsed.kind === "duplicate") duplicateCount += 1;
    if (parsed.kind === "malformed") malformedCount += 1;
  }
  return {
    candidates,
    malformedCount,
    answeredCount,
    closedCount,
    duplicateCount,
    quotaRemaining,
    backoffSeconds,
  };
}

function searchUrl(site: string, query: string, fromDate: number): string {
  const url = new URL("/2.3/search/advanced", STACKEXCHANGE_API_ORIGIN);
  url.searchParams.set("order", "desc");
  url.searchParams.set("sort", "creation");
  url.searchParams.set("q", query);
  url.searchParams.set("site", site);
  url.searchParams.set("closed", "false");
  url.searchParams.set("fromdate", String(fromDate));
  url.searchParams.set("filter", "withbody");
  url.searchParams.set("pagesize", String(STACKEXCHANGE_SEARCH_RESULTS_PER_REQUEST));
  return url.toString();
}

/** Public, unauthenticated demand source with quota and backoff enforcement in the adapter. */
export class StackExchangeDemandSource implements CandidateSource {
  private readonly sites: readonly string[];
  private readonly queries: readonly string[];
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly leakGuard: LeakGuardConfig;
  private readonly now: () => number;

  constructor(config: StackExchangeDemandSourceConfig) {
    this.sites = config.sites;
    this.queries = config.queries;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.leakGuard = config.leakGuard ?? {};
    this.now = config.now ?? Date.now;
  }

  private async search(site: string, query: string, fromDate: number): Promise<SearchResult | null> {
    try {
      const response = await this.fetchImpl(searchUrl(site, query, fromDate), {
        // Equivalent to curl --compressed. Node fetch transparently decodes the API's gzip body.
        headers: { "Accept-Encoding": "gzip" },
      });
      if (!response.ok) return null;
      return listing(await response.json(), site);
    } catch {
      return null;
    }
  }

  async gather(): Promise<SourceResult> {
    const fromDate = Math.floor((this.now() - DEMAND_LOOKBACK_MS) / 1_000);
    const requests = this.sites.flatMap((site) => this.queries.map((query) => ({ site, query })));
    const selectedRequests = requests.slice(0, STACKEXCHANGE_MAX_SEARCH_REQUESTS_PER_SWEEP);
    const available: SearchResult[] = [];
    let failed = false;
    let quotaStop: number | null = null;
    let backoffStop: number | null = null;

    // Sequential requests are deliberate: each wrapper's quota and backoff can stop the next one.
    for (const { site, query } of selectedRequests) {
      const result = await this.search(site, query, fromDate);
      if (!result) {
        failed = true;
        break;
      }
      available.push(result);
      if (result.backoffSeconds !== null && result.backoffSeconds > 0) {
        backoffStop = result.backoffSeconds;
        break;
      }
      if (result.quotaRemaining < STACKEXCHANGE_QUOTA_FLOOR) {
        quotaStop = result.quotaRemaining;
        break;
      }
    }

    if (available.length === 0) {
      return sourceResult([], this.leakGuard, [
        "Stack Exchange demand source was unavailable; continuing without Stack Exchange demand data.",
      ]);
    }
    const malformedCount = available.reduce((total, result) => total + result.malformedCount, 0);
    const answeredCount = available.reduce((total, result) => total + result.answeredCount, 0);
    const closedCount = available.reduce((total, result) => total + result.closedCount, 0);
    const duplicateCount = available.reduce((total, result) => total + result.duplicateCount, 0);
    const messages: string[] = [];
    if (malformedCount > 0) {
      messages.push(`Stack Exchange demand source dropped ${malformedCount} malformed search results.`);
    }
    if (answeredCount > 0) {
      messages.push(`Stack Exchange demand source excluded ${answeredCount} answered questions.`);
    }
    if (closedCount > 0) {
      messages.push(`Stack Exchange demand source excluded ${closedCount} closed questions.`);
    }
    if (duplicateCount > 0) {
      messages.push(`Stack Exchange demand source excluded ${duplicateCount} duplicate questions.`);
    }
    if (requests.length > selectedRequests.length) {
      messages.push(
        `Stack Exchange demand source skipped ${requests.length - selectedRequests.length} configured searches to stay within its per-sweep request cap.`,
      );
    }
    if (quotaStop !== null) {
      messages.push(
        `Stack Exchange demand source degraded because quota_remaining fell to ${quotaStop}, below its ${STACKEXCHANGE_QUOTA_FLOOR} floor; it stopped the sweep.`,
      );
    }
    if (backoffStop !== null) {
      messages.push(
        `Stack Exchange demand source degraded after an API backoff of ${backoffStop} seconds; it stopped the sweep.`,
      );
    }
    if (failed) {
      messages.push("Stack Exchange demand source was partially unavailable; demand data may be incomplete.");
    }
    return sourceResult(available.flatMap((result) => result.candidates), this.leakGuard, messages);
  }
}

/** Construct the free source when demand queries and valid site settings are present. */
export function stackExchangeDemandSourceFromEnv(
  env: Env = process.env,
  fetchImpl?: typeof globalThis.fetch,
): StackExchangeDemandSource {
  const sites = stackExchangeSitesFromEnv(env.STACKEXCHANGE_SITES);
  const queries = demandQueriesFromEnv(env.DEMAND_QUERIES);
  if (sites.length === 0 || queries.length === 0) {
    throw new Error("Stack Exchange demand source is not configured");
  }
  return new StackExchangeDemandSource({
    sites,
    queries,
    fetchImpl,
    leakGuard: leakGuardConfigFromEnv(env),
  });
}
