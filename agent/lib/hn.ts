import { sourceResult, type Candidate, type CandidateSource, type SourceResult } from "./candidates.ts";
import { leakGuardConfigFromEnv, type LeakGuardConfig } from "./leak-guard.ts";

const HN_API = "https://hacker-news.firebaseio.com/v0";
const SOFTWARE_TERMS = [
  "api",
  "coding",
  "database",
  "developer",
  "framework",
  "github",
  "open source",
  "programming",
  "rust",
  "software",
  "typescript",
  "javascript",
  "web",
];

interface HackerNewsSourceConfig {
  fetchImpl?: typeof globalThis.fetch;
  ranking?: "top" | "best";
  limit?: number;
  leakGuard?: LeakGuardConfig;
}

interface HnStory {
  id: number;
  title: string;
  url: string;
  text: string;
  timestamp: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function story(value: unknown): HnStory | null {
  const raw = record(value);
  if (
    raw?.type !== "story" ||
    typeof raw.id !== "number" ||
    typeof raw.title !== "string" ||
    typeof raw.time !== "number"
  ) {
    return null;
  }
  return {
    id: raw.id,
    title: raw.title,
    url: typeof raw.url === "string" ? raw.url : `https://news.ycombinator.com/item?id=${raw.id}`,
    text: typeof raw.text === "string" ? raw.text : "",
    timestamp: raw.time * 1_000,
  };
}

/** Cheap deterministic relevance filter for general-interest HN stories. */
export function isSoftwareRelevant(title: string, url: string): boolean {
  const haystack = `${title}\n${url}`.toLocaleLowerCase();
  return SOFTWARE_TERMS.some((term) => haystack.includes(term));
}

async function responseJson(fetchImpl: typeof globalThis.fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url);
  const body = await response.text();
  if (!response.ok) throw new Error(`Hacker News request failed with status ${response.status}`);
  return JSON.parse(body) as unknown;
}

export class HackerNewsSource implements CandidateSource {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly ranking: "top" | "best";
  private readonly limit: number;
  private readonly leakGuard: LeakGuardConfig;

  constructor(config: HackerNewsSourceConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.ranking = config.ranking ?? "top";
    this.limit = Math.min(Math.max(config.limit ?? 20, 1), 100);
    this.leakGuard = config.leakGuard ?? {};
  }

  async gather(): Promise<SourceResult> {
    const rawIds = await responseJson(this.fetchImpl, `${HN_API}/${this.ranking}stories.json`);
    const ids = Array.isArray(rawIds)
      ? rawIds.filter((id): id is number => typeof id === "number").slice(0, this.limit)
      : [];
    const stories = await Promise.all(
      ids.map(async (id) => story(await responseJson(this.fetchImpl, `${HN_API}/item/${id}.json`))),
    );
    const candidates: Candidate[] = stories
      .filter((item): item is HnStory => item !== null)
      .filter((item) => isSoftwareRelevant(item.title, item.url))
      .map((item) => ({
        source: "hn",
        title: item.title,
        url: item.url,
        context: item.text,
        timestamp: item.timestamp,
      }));
    return sourceResult(candidates, this.leakGuard);
  }
}

export function hackerNewsFromEnv(fetchImpl?: typeof globalThis.fetch): HackerNewsSource {
  return new HackerNewsSource({ fetchImpl, leakGuard: leakGuardConfigFromEnv() });
}
