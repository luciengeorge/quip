import { sourceResult, type Candidate, type CandidateSource, type SourceResult } from "./candidates.ts";
import { leakGuardConfigFromEnv, type LeakGuardConfig } from "./leak-guard.ts";
import {
  X_RECENT_SEARCH_API,
  xBearerAuthorization,
  type XReadBudget,
  type XReadReservation,
} from "./x.ts";

/** Recent search accepts 10 to 100 results. Ten keeps each buyer-intent query inexpensive. */
export const X_DEMAND_SEARCH_RESULTS_PER_REQUEST = 10;
/** A hard cap bounds paid searches even when X_DEMAND_QUERIES has many lines. */
export const X_DEMAND_MAX_SEARCH_REQUESTS_PER_SWEEP = 5;
/** Keep one unusually long post from consuming the classifier batch. */
export const X_DEMAND_MAX_SOURCE_TEXT_LENGTH = 6_000;

export interface XDemandCandidate extends Candidate {
  source: "x";
  author: string;
  replyCount: number;
  /** Reuses the demand-candidate shape. X is the platform, not a subreddit. */
  subreddit: "x";
  sourceText: string;
}

interface XDemandSourceConfig {
  bearerToken: string;
  queries: readonly string[];
  budget: XReadBudget;
  fetchImpl?: typeof globalThis.fetch;
  maxResults?: number;
  leakGuard?: LeakGuardConfig;
}

interface SearchResult {
  candidates: XDemandCandidate[];
  malformedCount: number;
  unresolvableAuthorCount: number;
}

type SearchAttempt =
  | { kind: "available"; result: SearchResult }
  | { kind: "budget-exhausted" }
  | { kind: "failed" };

type Env = Readonly<Record<string, string | undefined>>;

type TweetResult =
  | { kind: "candidate"; candidate: XDemandCandidate }
  | { kind: "malformed" | "unresolvable-author" };

function configured(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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

function xTweetId(value: unknown): string | null {
  const id = nonBlankString(value);
  return id && /^\d+$/u.test(id) ? id : null;
}

function rfc3339Milliseconds(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  ) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** X demand queries are one complete X query per non-empty line, never comma-separated. */
export function xDemandQueriesFromEnv(value: string | undefined): string[] {
  if (value === undefined) return [];
  const queries = value.split(/\r?\n/u).map((line) => line.trim());
  if (queries.length === 0 || queries.some((query) => query.length === 0)) {
    throw new Error("X_DEMAND_QUERIES must contain one non-empty query per line");
  }
  return queries;
}

function authorHandles(value: unknown): Map<string, string> {
  const root = record(value);
  const includes = root ? record(root.includes) : null;
  const users = includes?.users;
  const handles = new Map<string, string>();
  if (!Array.isArray(users)) return handles;
  for (const user of users) {
    const raw = record(user);
    const id = raw ? nonBlankString(raw.id) : null;
    const username = raw ? nonBlankString(raw.username) : null;
    if (id && username) handles.set(id, username);
  }
  return handles;
}

function tweetCandidate(value: unknown, handles: ReadonlyMap<string, string>): TweetResult {
  const raw = record(value);
  if (!raw) return { kind: "malformed" };
  const id = xTweetId(raw.id);
  const text = nonBlankString(raw.text);
  const askedAt = rfc3339Milliseconds(raw.created_at);
  const authorId = nonBlankString(raw.author_id);
  const metrics = record(raw.public_metrics);
  const replyCount = metrics ? nonNegativeInteger(metrics.reply_count) : null;
  if (
    !id ||
    !text ||
    text.length > X_DEMAND_MAX_SOURCE_TEXT_LENGTH ||
    askedAt === null ||
    !authorId ||
    replyCount === null
  ) {
    return { kind: "malformed" };
  }
  const author = handles.get(authorId);
  if (!author) return { kind: "unresolvable-author" };
  return {
    kind: "candidate",
    candidate: {
      source: "x",
      title: text,
      url: `https://x.com/i/web/status/${id}`,
      context: text,
      timestamp: askedAt,
      author,
      replyCount,
      subreddit: "x",
      sourceText: text,
    },
  };
}

function listing(value: unknown): SearchResult | null {
  const root = record(value);
  if (!root) return null;
  const data = root.data;
  if (data !== undefined && !Array.isArray(data)) return null;
  const handles = authorHandles(root);
  let malformedCount = 0;
  let unresolvableAuthorCount = 0;
  const candidates: XDemandCandidate[] = [];
  for (const item of data ?? []) {
    const parsed = tweetCandidate(item, handles);
    if (parsed.kind === "candidate") {
      candidates.push(parsed.candidate);
      continue;
    }
    if (parsed.kind === "unresolvable-author") {
      unresolvableAuthorCount += 1;
      continue;
    }
    malformedCount += 1;
  }
  return { candidates, malformedCount, unresolvableAuthorCount };
}

function maxResults(value: number | undefined): number {
  const requested = value ?? X_DEMAND_SEARCH_RESULTS_PER_REQUEST;
  if (!Number.isInteger(requested) || requested < 10 || requested > 100) {
    throw new Error("X demand maxResults must be an integer between 10 and 100");
  }
  return requested;
}

/** Paid X buyer-intent source using the shared Convex read reservation and settlement meter. */
export class XDemandSource implements CandidateSource {
  private readonly bearerToken: string;
  private readonly queries: readonly string[];
  private readonly budget: XReadBudget;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxResults: number;
  private readonly leakGuard: LeakGuardConfig;

  constructor(config: XDemandSourceConfig) {
    this.bearerToken = config.bearerToken;
    this.queries = config.queries;
    this.budget = config.budget;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.maxResults = maxResults(config.maxResults);
    this.leakGuard = config.leakGuard ?? {};
  }

  private async settle(reservationId: string, actualReads: number): Promise<boolean> {
    try {
      await this.budget.settleXReads(reservationId, actualReads);
      return true;
    } catch {
      return false;
    }
  }

  private async search(query: string): Promise<SearchAttempt> {
    let reservation: XReadReservation;
    try {
      reservation = await this.budget.reserveXReads(this.maxResults);
    } catch {
      return { kind: "failed" };
    }
    if (!reservation.allowed || !reservation.reservationId) return { kind: "budget-exhausted" };

    const url = new URL(X_RECENT_SEARCH_API);
    url.searchParams.set("query", query);
    url.searchParams.set("max_results", String(this.maxResults));
    url.searchParams.set("tweet.fields", "created_at,author_id,public_metrics");
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("user.fields", "username");
    try {
      const response = await this.fetchImpl(url.toString(), {
        headers: { Authorization: xBearerAuthorization(this.bearerToken) },
      });
      if (!response.ok) {
        await this.settle(reservation.reservationId, 0);
        return { kind: "failed" };
      }
      const payload = (await response.json()) as unknown;
      const root = record(payload);
      const rawData = root?.data;
      if (!root || (rawData !== undefined && !Array.isArray(rawData))) {
        await this.settle(reservation.reservationId, this.maxResults);
        return { kind: "failed" };
      }
      const result = listing(root);
      if (!result || !(await this.settle(reservation.reservationId, rawData?.length ?? 0))) {
        return { kind: "failed" };
      }
      return { kind: "available", result };
    } catch {
      await this.settle(reservation.reservationId, this.maxResults);
      return { kind: "failed" };
    }
  }

  async gather(): Promise<SourceResult> {
    const selectedQueries = this.queries.slice(0, X_DEMAND_MAX_SEARCH_REQUESTS_PER_SWEEP);
    const available: SearchResult[] = [];
    let budgetExhausted = false;
    let failed = false;

    // Sequential requests stop immediately when the shared paid-read meter denies a reservation.
    for (const query of selectedQueries) {
      const attempt = await this.search(query);
      if (attempt.kind === "available") {
        available.push(attempt.result);
        continue;
      }
      if (attempt.kind === "budget-exhausted") budgetExhausted = true;
      else failed = true;
      break;
    }

    const malformedCount = available.reduce((total, result) => total + result.malformedCount, 0);
    const unresolvableAuthorCount = available.reduce(
      (total, result) => total + result.unresolvableAuthorCount,
      0,
    );
    const messages: string[] = [];
    if (malformedCount > 0) {
      messages.push(`X demand source dropped ${malformedCount} malformed search results.`);
    }
    if (unresolvableAuthorCount > 0) {
      messages.push(
        `X demand source dropped ${unresolvableAuthorCount} results with an unresolvable author handle.`,
      );
    }
    if (this.queries.length > selectedQueries.length) {
      messages.push(
        `X demand source skipped ${this.queries.length - selectedQueries.length} configured searches to stay within its per-sweep request cap.`,
      );
    }
    if (budgetExhausted) {
      messages.push(
        "X demand source degraded because the monthly read budget is exhausted; it stopped the sweep.",
      );
    }
    if (failed) {
      messages.push("X demand source was partially unavailable; demand data may be incomplete.");
    }
    return sourceResult(available.flatMap((result) => result.candidates), this.leakGuard, messages);
  }
}

/** Construct the paid X demand source only with credentials and one non-empty query per line. */
export function xDemandSourceFromEnv(
  budget: XReadBudget,
  env: Env = process.env,
  fetchImpl?: typeof globalThis.fetch,
): XDemandSource {
  const bearerToken = configured(env.X_BEARER_TOKEN);
  const queries = xDemandQueriesFromEnv(env.X_DEMAND_QUERIES);
  if (!bearerToken || queries.length === 0) throw new Error("X demand source is not configured");
  return new XDemandSource({
    bearerToken,
    queries,
    budget,
    fetchImpl,
    leakGuard: leakGuardConfigFromEnv(env),
  });
}
