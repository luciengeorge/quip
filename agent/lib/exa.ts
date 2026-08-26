import { sourceResult, type Candidate, type CandidateSource, type SourceResult } from "./candidates.ts";
import { leakGuardConfigFromEnv, type LeakGuardConfig } from "./leak-guard.ts";

const EXA_API = "https://api.exa.ai/search";

interface ExaTrendingSourceConfig {
  apiKey: string;
  query: string;
  fetchImpl?: typeof globalThis.fetch;
  limit?: number;
  leakGuard?: LeakGuardConfig;
}

interface ExaResult {
  title: string;
  url: string;
  context: string;
  timestamp: number;
}

function result(value: unknown): ExaResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== "string" || typeof raw.url !== "string") return null;
  const context = [raw.summary, raw.text]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n");
  const timestamp = typeof raw.publishedDate === "string" ? Date.parse(raw.publishedDate) : 0;
  return {
    title: raw.title,
    url: raw.url,
    context,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
  };
}

export class ExaTrendingSource implements CandidateSource {
  private readonly apiKey: string;
  private readonly query: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly limit: number;
  private readonly leakGuard: LeakGuardConfig;

  constructor(config: ExaTrendingSourceConfig) {
    this.apiKey = config.apiKey;
    this.query = config.query;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.limit = Math.min(Math.max(config.limit ?? 10, 1), 100);
    this.leakGuard = config.leakGuard ?? {};
  }

  async gather(): Promise<SourceResult> {
    const response = await this.fetchImpl(EXA_API, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: this.query,
        numResults: this.limit,
        contents: { text: { maxCharacters: 800 }, summary: true },
      }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Exa request failed with status ${response.status}`);
    const payload = JSON.parse(body) as { results?: unknown };
    const candidates: Candidate[] = [];
    let droppedBlankTitleOrUrl = 0;
    for (const value of Array.isArray(payload.results) ? payload.results : []) {
      const item = result(value);
      if (!item) continue;
      const title = item.title.trim();
      const url = item.url.trim();
      if (title.length === 0 || url.length === 0) {
        droppedBlankTitleOrUrl += 1;
        continue;
      }
      candidates.push({ ...item, title, url, source: "exa" });
    }
    const messages =
      droppedBlankTitleOrUrl === 0
        ? []
        : [`Exa source dropped ${droppedBlankTitleOrUrl} results with a blank title or URL.`];
    return sourceResult(candidates, this.leakGuard, messages);
  }
}

export function exaTrendingFromEnv(fetchImpl?: typeof globalThis.fetch): ExaTrendingSource {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) throw new Error("EXA_API_KEY is not set");
  const query = process.env.EXA_TREND_QUERY;
  if (!query || query.trim().length === 0) throw new Error("EXA_TREND_QUERY is not set");
  return new ExaTrendingSource({ apiKey, query, fetchImpl, leakGuard: leakGuardConfigFromEnv() });
}
