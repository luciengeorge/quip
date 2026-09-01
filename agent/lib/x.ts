import { sourceResult, type Candidate, type CandidateSource, type SourceResult } from "./candidates.ts";
import { leakGuardConfigFromEnv, type LeakGuardConfig } from "./leak-guard.ts";

export const X_RECENT_SEARCH_API = "https://api.x.com/2/tweets/search/recent";

export interface XReadReservation {
  allowed: boolean;
  reservationId: string | null;
  remainingReads: number;
}

/** The only budget surface the paid X adapter needs. Backed by an atomic Convex mutation. */
export interface XReadBudget {
  reserveXReads(reads: number): Promise<XReadReservation>;
  settleXReads(reservationId: string, actualReads: number): Promise<void>;
}

/** Keep all X recent-search adapters on the same bearer-token authentication shape. */
export function xBearerAuthorization(bearerToken: string): string {
  return `Bearer ${bearerToken}`;
}

interface XSearchSourceConfig {
  bearerToken: string;
  query: string;
  budget: XReadBudget;
  fetchImpl?: typeof globalThis.fetch;
  maxResults?: number;
  leakGuard?: LeakGuardConfig;
  now?: () => number;
}

interface XPost {
  id: string;
  text: string;
  timestamp: number;
}

function xPost(value: unknown, now: () => number): XPost | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.text !== "string") return null;
  const parsed = typeof raw.created_at === "string" ? Date.parse(raw.created_at) : Number.NaN;
  return {
    id: raw.id,
    text: raw.text,
    timestamp: Number.isFinite(parsed) ? parsed : now(),
  };
}

function maxResults(value: number | undefined): number {
  const requested = value ?? 10;
  if (!Number.isInteger(requested) || requested < 10 || requested > 100) {
    throw new Error("X maxResults must be an integer between 10 and 100");
  }
  return requested;
}

export class XSearchSource implements CandidateSource {
  private readonly bearerToken: string;
  private readonly query: string;
  private readonly budget: XReadBudget;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxResults: number;
  private readonly leakGuard: LeakGuardConfig;
  private readonly now: () => number;

  constructor(config: XSearchSourceConfig) {
    this.bearerToken = config.bearerToken;
    this.query = config.query;
    this.budget = config.budget;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.maxResults = maxResults(config.maxResults);
    this.leakGuard = config.leakGuard ?? {};
    this.now = config.now ?? Date.now;
  }

  private async settle(reservationId: string, actualReads: number): Promise<boolean> {
    try {
      await this.budget.settleXReads(reservationId, actualReads);
      return true;
    } catch {
      return false;
    }
  }

  async gather(): Promise<SourceResult> {
    let reservation: XReadReservation;
    try {
      reservation = await this.budget.reserveXReads(this.maxResults);
    } catch {
      return {
        candidates: [],
        messages: ["X source could not reserve monthly reads; free sources remain available."],
      };
    }
    if (!reservation.allowed || !reservation.reservationId) {
      return {
        candidates: [],
        messages: [
          "X source skipped because the monthly read budget is exhausted; free sources remain available.",
        ],
      };
    }

    const url = new URL(X_RECENT_SEARCH_API);
    url.searchParams.set("query", this.query);
    url.searchParams.set("max_results", String(this.maxResults));
    url.searchParams.set("tweet.fields", "created_at");
    try {
      const response = await this.fetchImpl(url.toString(), {
        headers: { Authorization: xBearerAuthorization(this.bearerToken) },
      });
      if (!response.ok) {
        const settled = await this.settle(reservation.reservationId, 0);
        return {
          candidates: [],
          messages: [
            settled
              ? "X source request failed; free sources remain available."
              : "X source request failed and its read reservation remains held; free sources remain available.",
          ],
        };
      }
      const payload = (await response.json()) as unknown;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        await this.settle(reservation.reservationId, this.maxResults);
        return {
          candidates: [],
          messages: [
            "X source returned an unrecognised response; its full read reservation remains charged and free sources remain available.",
          ],
        };
      }
      const rawData = (payload as Record<string, unknown>).data;
      if (rawData !== undefined && !Array.isArray(rawData)) {
        await this.settle(reservation.reservationId, this.maxResults);
        return {
          candidates: [],
          messages: [
            "X source returned an unrecognised response; its full read reservation remains charged and free sources remain available.",
          ],
        };
      }
      const posts = (rawData ?? []).map((value) => xPost(value, this.now)).filter(
        (post): post is XPost => post !== null,
      );
      const actualReads = Array.isArray(rawData) ? rawData.length : 0;
      if (!(await this.settle(reservation.reservationId, actualReads))) {
        return {
          candidates: [],
          messages: [
            "X results were withheld because their usage could not be recorded; the reservation remains held and free sources remain available.",
          ],
        };
      }
      const candidates: Candidate[] = posts.map((post) => ({
        source: "x",
        title: post.text,
        url: `https://x.com/i/web/status/${post.id}`,
        context: post.text,
        timestamp: post.timestamp,
      }));
      return sourceResult(candidates, this.leakGuard);
    } catch {
      await this.settle(reservation.reservationId, this.maxResults);
      return {
        candidates: [],
        messages: [
          "X source failed after reserving reads; the reservation remains charged and free sources remain available.",
        ],
      };
    }
  }
}

export function xSearchFromEnv(
  budget: XReadBudget,
  fetchImpl?: typeof globalThis.fetch,
): XSearchSource {
  const bearerToken = process.env.X_BEARER_TOKEN;
  if (!bearerToken || bearerToken.trim().length === 0) throw new Error("X_BEARER_TOKEN is not set");
  const query = process.env.X_TREND_QUERY;
  if (!query || query.trim().length === 0) throw new Error("X_TREND_QUERY is not set");
  return new XSearchSource({
    bearerToken,
    query,
    budget,
    fetchImpl,
    leakGuard: leakGuardConfigFromEnv(),
  });
}
