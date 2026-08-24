import { sourceResult, type Candidate, type CandidateSource, type SourceResult } from "./candidates.ts";
import { leakGuardConfigFromEnv, type LeakGuardConfig } from "./leak-guard.ts";

export interface FeedEntry {
  title: string;
  url: string;
  context: string;
  timestamp: number;
}

interface RssSourceConfig {
  feedUrls: readonly string[];
  fetchImpl?: typeof globalThis.fetch;
  leakGuard?: LeakGuardConfig;
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)]]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function tagValue(fragment: string, tag: string): string | null {
  const match = fragment.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match?.[1] === undefined ? null : decodeXml(match[1]);
}

function linkValue(fragment: string): string | null {
  const atomLink = fragment.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)?.[1];
  return atomLink ? decodeXml(atomLink) : tagValue(fragment, "link");
}

function entryTimestamp(fragment: string): number {
  const date = tagValue(fragment, "pubDate") ?? tagValue(fragment, "updated") ?? tagValue(fragment, "published");
  const parsed = date ? Date.parse(date) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function entries(xml: string, tag: "item" | "entry"): string[] {
  return Array.from(xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"))).map(
    (match) => match[1] ?? "",
  );
}

/** Small RSS and Atom parser for a known list of trusted developer feeds. */
export function parseFeed(xml: string): FeedEntry[] {
  const fragments = entries(xml, "item");
  const feedEntries = fragments.length > 0 ? fragments : entries(xml, "entry");
  return feedEntries.flatMap((fragment) => {
    const title = tagValue(fragment, "title");
    const url = linkValue(fragment) ?? tagValue(fragment, "guid") ?? tagValue(fragment, "id");
    if (!title || !url) return [];
    return [
      {
        title,
        url,
        context:
          tagValue(fragment, "description") ??
          tagValue(fragment, "summary") ??
          tagValue(fragment, "content") ??
          "",
        timestamp: entryTimestamp(fragment),
      },
    ];
  });
}

function feedUrlsFromEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\n,]/)
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

export class RssSource implements CandidateSource {
  private readonly feedUrls: readonly string[];
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly leakGuard: LeakGuardConfig;

  constructor(config: RssSourceConfig) {
    this.feedUrls = config.feedUrls;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.leakGuard = config.leakGuard ?? {};
  }

  async gather(): Promise<SourceResult> {
    const entriesByFeed = await Promise.all(
      this.feedUrls.map(async (url) => {
        const response = await this.fetchImpl(url);
        const xml = await response.text();
        if (!response.ok) throw new Error(`RSS request failed with status ${response.status}`);
        return parseFeed(xml);
      }),
    );
    const candidates: Candidate[] = entriesByFeed.flat().map((entry) => ({
      source: "rss",
      title: entry.title,
      url: entry.url,
      context: entry.context,
      timestamp: entry.timestamp,
    }));
    return sourceResult(candidates, this.leakGuard);
  }
}

export function rssFromEnv(fetchImpl?: typeof globalThis.fetch): RssSource {
  const feedUrls = feedUrlsFromEnv(process.env.RSS_FEED_URLS);
  if (feedUrls.length === 0) throw new Error("RSS_FEED_URLS is not set");
  return new RssSource({ feedUrls, fetchImpl, leakGuard: leakGuardConfigFromEnv() });
}
