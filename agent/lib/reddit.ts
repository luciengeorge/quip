import { sourceResult, type Candidate, type CandidateSource, type SourceResult } from "./candidates.ts";
import { leakGuardConfigFromEnv, type LeakGuardConfig } from "./leak-guard.ts";

const REDDIT_ACCESS_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_OAUTH_ORIGIN = "https://oauth.reddit.com";

/** Reddit listings accept at most 100, but 25 keeps one weekly sweep deliberately narrow. */
export const REDDIT_SEARCH_RESULTS_PER_REQUEST = 25;
/** Leave substantial headroom below Reddit's 100 QPM free OAuth limit. */
export const REDDIT_MAX_SEARCH_REQUESTS_PER_SWEEP = 20;
/** Drop unusually long posts rather than allowing one result to consume the classifier batch. */
export const REDDIT_MAX_SOURCE_TEXT_LENGTH = 6_000;

export interface RedditDemandCandidate extends Candidate {
  source: "reddit";
  author: string;
  replyCount: number;
  subreddit: string;
  sourceText: string;
}

interface RedditDemandSourceConfig {
  clientId: string;
  clientSecret: string;
  userAgent: string;
  subreddits: readonly string[];
  queries: readonly string[];
  fetchImpl?: typeof globalThis.fetch;
  leakGuard?: LeakGuardConfig;
}

interface SearchResult {
  candidates: RedditDemandCandidate[];
  malformedCount: number;
}

type Env = Readonly<Record<string, string | undefined>>;

function configured(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function listSetting(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Parse only normal subreddit names so a configuration value cannot alter the request path. */
export function redditSubredditsFromEnv(value: string | undefined): string[] {
  return listSetting(value)
    .map((item) => item.replace(/^r\//iu, ""))
    .filter((item) => /^[A-Za-z0-9_]{2,21}$/u.test(item));
}

export function demandQueriesFromEnv(value: string | undefined): string[] {
  return listSetting(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function redditCandidate(value: unknown): RedditDemandCandidate | null {
  const child = record(value);
  const raw = child ? record(child.data) : null;
  if (!raw) return null;
  const title = nonBlankString(raw.title);
  const selftext = typeof raw.selftext === "string" ? raw.selftext : "";
  const author = nonBlankString(raw.author);
  const permalink = nonBlankString(raw.permalink);
  const subreddit = nonBlankString(raw.subreddit);
  const createdAtSeconds = typeof raw.created_utc === "number" ? raw.created_utc : Number.NaN;
  const replyCount = typeof raw.num_comments === "number" ? raw.num_comments : Number.NaN;
  if (
    !title ||
    !author ||
    !permalink ||
    !subreddit ||
    !permalink.startsWith("/") ||
    !Number.isFinite(createdAtSeconds) ||
    createdAtSeconds <= 0 ||
    !Number.isInteger(replyCount) ||
    replyCount < 0
  ) {
    return null;
  }
  const sourceText = selftext.length > 0 ? `${title}\n${selftext}` : title;
  if (sourceText.length > REDDIT_MAX_SOURCE_TEXT_LENGTH) return null;
  return {
    source: "reddit",
    title,
    url: new URL(permalink, "https://www.reddit.com").toString(),
    context: sourceText,
    timestamp: Math.round(createdAtSeconds * 1_000),
    author,
    replyCount,
    subreddit,
    sourceText,
  };
}

function listing(value: unknown): SearchResult | null {
  const root = record(value);
  const data = root ? record(root.data) : null;
  if (!data || !Array.isArray(data.children)) return null;
  let malformedCount = 0;
  const candidates: RedditDemandCandidate[] = [];
  for (const child of data.children) {
    const candidate = redditCandidate(child);
    if (!candidate) {
      malformedCount += 1;
      continue;
    }
    candidates.push(candidate);
  }
  return { candidates, malformedCount };
}

function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

function searchUrl(subreddit: string, query: string): string {
  const url = new URL(`/r/${subreddit}/search`, REDDIT_OAUTH_ORIGIN);
  url.searchParams.set("q", query);
  url.searchParams.set("restrict_sr", "on");
  url.searchParams.set("sort", "new");
  url.searchParams.set("t", "week");
  url.searchParams.set("type", "link");
  url.searchParams.set("limit", String(REDDIT_SEARCH_RESULTS_PER_REQUEST));
  url.searchParams.set("raw_json", "1");
  return url.toString();
}

/** Credential-gated Reddit buyer-intent source. It contains failures instead of blocking other work. */
export class RedditDemandSource implements CandidateSource {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly userAgent: string;
  private readonly subreddits: readonly string[];
  private readonly queries: readonly string[];
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly leakGuard: LeakGuardConfig;

  constructor(config: RedditDemandSourceConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.userAgent = config.userAgent;
    this.subreddits = config.subreddits;
    this.queries = config.queries;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.leakGuard = config.leakGuard ?? {};
  }

  private async accessToken(): Promise<string | null> {
    try {
      const response = await this.fetchImpl(REDDIT_ACCESS_TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: basicAuthorization(this.clientId, this.clientSecret),
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": this.userAgent,
        },
        body: "grant_type=client_credentials",
      });
      if (!response.ok) return null;
      const payload = record(await response.json());
      return payload ? nonBlankString(payload.access_token) : null;
    } catch {
      return null;
    }
  }

  private async search(
    subreddit: string,
    query: string,
    accessToken: string,
  ): Promise<SearchResult | null> {
    try {
      const response = await this.fetchImpl(searchUrl(subreddit, query), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": this.userAgent,
        },
      });
      if (!response.ok) return null;
      return listing(await response.json());
    } catch {
      return null;
    }
  }

  async gather(): Promise<SourceResult> {
    const accessToken = await this.accessToken();
    if (!accessToken) {
      return sourceResult([], this.leakGuard, [
        "Reddit demand source was unavailable; continuing without demand data.",
      ]);
    }
    const requests = this.subreddits.flatMap((subreddit) =>
      this.queries.map((query) => ({ subreddit, query })),
    );
    const selectedRequests = requests.slice(0, REDDIT_MAX_SEARCH_REQUESTS_PER_SWEEP);
    const results = await Promise.all(
      selectedRequests.map(({ subreddit, query }) => this.search(subreddit, query, accessToken)),
    );
    const available = results.filter((result): result is SearchResult => result !== null);
    if (available.length === 0) {
      return sourceResult([], this.leakGuard, [
        "Reddit demand source was unavailable; continuing without demand data.",
      ]);
    }
    const failedCount = results.length - available.length;
    const malformedCount = available.reduce((total, result) => total + result.malformedCount, 0);
    const messages: string[] = [];
    if (malformedCount > 0) {
      messages.push(`Reddit demand source dropped ${malformedCount} malformed search results.`);
    }
    if (requests.length > selectedRequests.length) {
      messages.push(
        `Reddit demand source skipped ${requests.length - selectedRequests.length} configured searches to stay within its per-sweep request cap.`,
      );
    }
    if (failedCount > 0) {
      messages.push("Reddit demand source was partially unavailable; demand data may be incomplete.");
    }
    return sourceResult(available.flatMap((result) => result.candidates), this.leakGuard, messages);
  }
}

/** Construct the Reddit source only when every required credential and search setting is present. */
export function redditDemandSourceFromEnv(
  env: Env = process.env,
  fetchImpl?: typeof globalThis.fetch,
): RedditDemandSource {
  const clientId = configured(env.REDDIT_CLIENT_ID);
  const clientSecret = configured(env.REDDIT_CLIENT_SECRET);
  const userAgent = configured(env.REDDIT_USER_AGENT);
  const subreddits = redditSubredditsFromEnv(env.REDDIT_SUBREDDITS);
  const queries = demandQueriesFromEnv(env.DEMAND_QUERIES);
  if (!clientId || !clientSecret || !userAgent || subreddits.length === 0 || queries.length === 0) {
    throw new Error("Reddit demand source is not configured");
  }
  return new RedditDemandSource({
    clientId,
    clientSecret,
    userAgent,
    subreddits,
    queries,
    fetchImpl,
    leakGuard: leakGuardConfigFromEnv(env),
  });
}
