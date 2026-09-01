import { type CandidateSource } from "./candidates.ts";
import { ExaTrendingSource } from "./exa.ts";
import { GithubTrendingSource } from "./github-trending.ts";
import { HackerNewsSource } from "./hn.ts";
import { leakGuardConfigFromEnv } from "./leak-guard.ts";
import {
  memoryFromEnv,
  type DemandAskRecord,
  type DemandScanRecord,
  type Memory,
  type StoredXSourceStatus,
  type XReadSpend,
  type XSourceStatus,
} from "./memory.ts";
import { RssSource, feedUrlsFromEnv } from "./rss.ts";
import {
  X_SOURCE_UNAVAILABLE_MESSAGE,
  runDailyTrendScan,
  type DailyTrendScanResult,
  type TrendScanMemory,
} from "./trend-scan.ts";
import { type WeeklyTrend } from "./trend-digest.ts";
import { weeklyTrends } from "./weekly-trends.ts";
import { weeklyDemandAsks, weeklyDemandEvidence, type WeeklyDemandEvidence } from "./weekly-demands.ts";
import { XSearchSource, type XReadBudget } from "./x.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface TrendSourceSet {
  sources: CandidateSource[];
  initialMessages: string[];
  xSourceConfigured: boolean;
}

export interface TrendSourceSetOptions {
  env?: Env;
  budget: XReadBudget;
  fetchImpl?: typeof globalThis.fetch;
}

export interface WeeklyTrendContext {
  startDay: string;
  endDay: string;
  generatedAt: number;
  trends: WeeklyTrend[];
  demandAsks: DemandAskRecord[];
  demandEvidence: WeeklyDemandEvidence[];
  spend: XReadSpend;
  xSourceStatus: XSourceStatus;
  demandDataAvailable: boolean;
}

function configured(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function offsetDay(timestamp: number, offset: number): string {
  return utcDay(timestamp + offset * 24 * 60 * 60 * 1_000);
}

function weeklyXSourceStatus(scans: readonly { xSourceStatus: StoredXSourceStatus }[]): XSourceStatus {
  if (scans.some((scan) => scan.xSourceStatus === "contributed")) return "contributed";
  if (
    scans.some(
      (scan) =>
        scan.xSourceStatus === "configured-empty" || scan.xSourceStatus === "available",
    )
  ) {
    return "configured-empty";
  }
  return "not-configured";
}

/** Build the source set without calling an API. X is present only when both credentials exist. */
export function trendSourceSet(options: TrendSourceSetOptions): TrendSourceSet {
  const env = options.env ?? process.env;
  const leakGuard = leakGuardConfigFromEnv(env);
  const sources: CandidateSource[] = [
    new HackerNewsSource({ fetchImpl: options.fetchImpl, leakGuard }),
    new GithubTrendingSource({ fetchImpl: options.fetchImpl, leakGuard }),
  ];
  const exaKey = configured(env.EXA_API_KEY);
  const exaQuery = configured(env.EXA_TREND_QUERY);
  if (exaKey && exaQuery) {
    sources.push(
      new ExaTrendingSource({
        apiKey: exaKey,
        query: exaQuery,
        fetchImpl: options.fetchImpl,
        leakGuard,
      }),
    );
  }
  const feedUrls = feedUrlsFromEnv(env.RSS_FEED_URLS);
  if (feedUrls.length > 0) {
    sources.push(new RssSource({ feedUrls, fetchImpl: options.fetchImpl, leakGuard }));
  }

  const bearerToken = configured(env.X_BEARER_TOKEN);
  const xQuery = configured(env.X_TREND_QUERY);
  if (!bearerToken || !xQuery) {
    return {
      sources,
      initialMessages: [X_SOURCE_UNAVAILABLE_MESSAGE],
      xSourceConfigured: false,
    };
  }
  sources.push(
    new XSearchSource({
      bearerToken,
      query: xQuery,
      budget: options.budget,
      fetchImpl: options.fetchImpl,
      leakGuard,
    }),
  );
  return { sources, initialMessages: [], xSourceConfigured: true };
}

/** Execute one durable daily scan using the configured source set. */
export async function runDailyTrendScanFromEnv(
  fetchImpl?: typeof globalThis.fetch,
): Promise<DailyTrendScanResult> {
  const memory = memoryFromEnv();
  const sourceSet = trendSourceSet({ budget: memory, fetchImpl });
  return await runDailyTrendScan({
    ...sourceSet,
    memory: memory as TrendScanMemory,
  });
}

type WeeklyTrendMemory = Pick<
  Memory,
  | "trendObservationsInRange"
  | "trendScansInRange"
  | "getXReadSpend"
  | "demandAsksInRange"
  | "demandScansInRange"
>;

/** Load one complete seven-day window for the weekly renderer. */
export async function weeklyTrendContext(
  memory: WeeklyTrendMemory,
  now: () => number = Date.now,
): Promise<WeeklyTrendContext> {
  const timestamp = now();
  const endDay = utcDay(timestamp);
  const startDay = offsetDay(timestamp, -6);
  const [observations, scans, spend, demandAsks, demandScans] = await Promise.all([
    memory.trendObservationsInRange(startDay, endDay),
    memory.trendScansInRange(startDay, endDay),
    memory.getXReadSpend(),
    memory.demandAsksInRange(startDay, endDay),
    memory.demandScansInRange(startDay, endDay),
  ]);
  return {
    startDay,
    endDay,
    generatedAt: timestamp,
    trends: weeklyTrends(observations, scans, startDay, endDay),
    demandAsks: weeklyDemandAsks(demandAsks),
    demandEvidence: weeklyDemandEvidence(demandAsks, demandScans, startDay, endDay),
    spend,
    xSourceStatus: weeklyXSourceStatus(scans),
    demandDataAvailable: demandScans.some(
      (scan) =>
        scan.redditSourceStatus === "available" || scan.stackExchangeSourceStatus === "available",
    ),
  };
}

export async function weeklyTrendContextFromEnv(): Promise<WeeklyTrendContext> {
  return await weeklyTrendContext(memoryFromEnv());
}
