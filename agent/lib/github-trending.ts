import { sourceResult, type Candidate, type CandidateSource, type SourceResult } from "./candidates.ts";
import { leakGuardConfigFromEnv, type LeakGuardConfig } from "./leak-guard.ts";

const GITHUB_TRENDING_URL = "https://github.com/trending?since=daily";

interface GithubTrendingSourceConfig {
  fetchImpl?: typeof globalThis.fetch;
  limit?: number;
  leakGuard?: LeakGuardConfig;
  now?: () => number;
}

interface TrendingRepository {
  name: string;
  url: string;
  description: string;
  starVelocity: string;
}

function textFromHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function articleRepository(article: string): TrendingRepository | null {
  const hrefs = [...article.matchAll(/href=["']([^"']+)["']/gi)].map((match) => match[1] ?? "");
  const path = hrefs.find((href) => /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(href));
  const velocity = article.match(/([\d,.]+)\s+stars?\s+today\b/iu)?.[1];
  if (!path || !velocity) return null;

  const name = path.slice(1);
  const description = textFromHtml(article.match(/<p\b[^>]*>([\s\S]*?)<\/p>/iu)?.[1] ?? "");
  return {
    name,
    url: `https://github.com${path}`,
    description,
    starVelocity: `${velocity} stars today`,
  };
}

/** Parse GitHub's daily Trending page, retaining the daily-star signal and not lifetime stars. */
export function parseGithubTrending(html: string): TrendingRepository[] {
  return [...html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/giu)]
    .map((match) => articleRepository(match[0]))
    .filter((repository): repository is TrendingRepository => repository !== null);
}

export class GithubTrendingSource implements CandidateSource {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly limit: number;
  private readonly leakGuard: LeakGuardConfig;
  private readonly now: () => number;

  constructor(config: GithubTrendingSourceConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.limit = Math.min(Math.max(config.limit ?? 20, 1), 100);
    this.leakGuard = config.leakGuard ?? {};
    this.now = config.now ?? Date.now;
  }

  async gather(): Promise<SourceResult> {
    const response = await this.fetchImpl(GITHUB_TRENDING_URL, {
      headers: { Accept: "text/html" },
    });
    const html = await response.text();
    if (!response.ok) throw new Error(`GitHub Trending request failed with status ${response.status}`);
    const candidates: Candidate[] = parseGithubTrending(html)
      .slice(0, this.limit)
      .map((repository) => ({
        source: "github-trending",
        title: repository.name,
        url: repository.url,
        context: [repository.starVelocity, repository.description].filter(Boolean).join("\n"),
        timestamp: this.now(),
      }));
    return sourceResult(candidates, this.leakGuard);
  }
}

export function githubTrendingFromEnv(fetchImpl?: typeof globalThis.fetch): GithubTrendingSource {
  return new GithubTrendingSource({ fetchImpl, leakGuard: leakGuardConfigFromEnv() });
}
