import { sourceResult, type Candidate, type CandidateSource, type SourceResult } from "./candidates.ts";
import { leakGuardConfigFromEnv, type LeakGuardConfig } from "./leak-guard.ts";

const GITHUB_API = "https://api.github.com";

interface GithubActivitySourceConfig {
  username: string;
  token?: string;
  fetchImpl?: typeof globalThis.fetch;
  leakGuard?: LeakGuardConfig;
}

interface GithubRepo {
  private?: unknown;
  visibility?: unknown;
  html_url?: unknown;
}

interface GithubEvent {
  type: string;
  createdAt: number;
  repoName: string;
  payload: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function timestamp(value: unknown): number | null {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function githubEvent(value: unknown): GithubEvent | null {
  const raw = record(value);
  const repo = record(raw?.repo);
  const payload = record(raw?.payload);
  const type = text(raw?.type);
  const createdAt = timestamp(raw?.created_at);
  const repoName = text(repo?.name);
  if (!type || createdAt === null || !repoName || !payload) return null;
  return { type, createdAt, repoName, payload };
}

/** Only an explicit positive public assertion may pass the GitHub leak guard. */
export function isPublicGithubRepo(repo: GithubRepo): boolean {
  return repo.private === false && repo.visibility === "public";
}

function repositoryName(repoName: string): string {
  return repoName.split("/").at(-1) ?? repoName;
}

function commitMessages(payload: Record<string, unknown>): string {
  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  return commits
    .map((commit) => text(record(commit)?.message))
    .filter((message): message is string => message !== null)
    .join("\n");
}

function mapGithubEvent(event: GithubEvent, repository: GithubRepo): Candidate | null {
  if (event.type === "PushEvent") {
    const head = text(event.payload.head);
    if (!head) return null;
    const commits = Array.isArray(event.payload.commits) ? event.payload.commits : [];
    const count = commits.length;
    return {
      source: "github",
      title: `Pushed ${count} commit${count === 1 ? "" : "s"} to ${repositoryName(event.repoName)}`,
      url: `https://github.com/${event.repoName}/commit/${head}`,
      context: commitMessages(event.payload),
      timestamp: event.createdAt,
    };
  }

  if (event.type === "PullRequestEvent") {
    const pullRequest = record(event.payload.pull_request);
    if (event.payload.action !== "closed" || pullRequest?.merged !== true) return null;
    const title = text(pullRequest.title);
    const url = text(pullRequest.html_url);
    if (!title || !url) return null;
    return {
      source: "github",
      title: `Merged PR: ${title}`,
      url,
      context: text(pullRequest.body) ?? "",
      timestamp: event.createdAt,
    };
  }

  if (event.type === "ReleaseEvent") {
    const release = record(event.payload.release);
    if (event.payload.action !== "published") return null;
    const title = text(release?.name) ?? text(release?.tag_name);
    const url = text(release?.html_url);
    if (!title || !url) return null;
    return {
      source: "github",
      title: `Released ${title}`,
      url,
      context: text(release?.body) ?? "",
      timestamp: event.createdAt,
    };
  }

  if (event.type === "CreateEvent" && event.payload.ref_type === "repository") {
    const url = text(repository.html_url);
    if (!url) return null;
    return {
      source: "github",
      title: `Created repository ${repositoryName(event.repoName)}`,
      url,
      context: "",
      timestamp: event.createdAt,
    };
  }

  return null;
}

async function responseJson(fetchImpl: typeof globalThis.fetch, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetchImpl(url, init);
  const body = await response.text();
  if (!response.ok) throw new Error(`GitHub request failed with status ${response.status}`);
  return JSON.parse(body) as unknown;
}

export class GithubActivitySource implements CandidateSource {
  private readonly username: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly leakGuard: LeakGuardConfig;

  constructor(config: GithubActivitySourceConfig) {
    this.username = config.username;
    this.token = config.token;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.leakGuard = config.leakGuard ?? {};
  }

  async gather(): Promise<SourceResult> {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const eventsUrl = new URL(`${GITHUB_API}/users/${this.username}/events/public`);
    eventsUrl.searchParams.set("per_page", "100");
    const rawEvents = await responseJson(this.fetchImpl, eventsUrl.toString(), { headers });
    const events = Array.isArray(rawEvents)
      ? rawEvents.map(githubEvent).filter((event): event is GithubEvent => event !== null)
      : [];
    const repositories = new Map<string, Promise<GithubRepo | null>>();
    const repositoryFor = (repoName: string): Promise<GithubRepo | null> => {
      const existing = repositories.get(repoName);
      if (existing) return existing;
      const request = responseJson(this.fetchImpl, `${GITHUB_API}/repos/${repoName}`, { headers })
        .then((value) => record(value) ?? {})
        .catch(() => null);
      repositories.set(repoName, request);
      return request;
    };

    const mapped = await Promise.all(
      events.map(async (event) => ({ event, repository: await repositoryFor(event.repoName) })),
    );
    const candidates: Candidate[] = [];
    const messages: string[] = [];
    for (const { event, repository } of mapped) {
      if (!repository || !isPublicGithubRepo(repository)) {
        messages.push(
          "GitHub activity was excluded because repository visibility was not explicitly public.",
        );
        continue;
      }
      const candidate = mapGithubEvent(event, repository);
      if (candidate) candidates.push(candidate);
    }
    return sourceResult(candidates, this.leakGuard, messages);
  }
}

/** Use only a GitHub token that has public read scope. */
export function githubFromEnv(fetchImpl?: typeof globalThis.fetch): GithubActivitySource {
  return new GithubActivitySource({
    username: process.env.GITHUB_USERNAME?.trim() || "luciengeorge",
    token: process.env.GITHUB_TOKEN,
    fetchImpl,
    leakGuard: leakGuardConfigFromEnv(),
  });
}
