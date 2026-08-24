import { sourceResult, type Candidate, type CandidateSource, type SourceResult } from "./candidates.ts";
import { leakGuardConfigFromEnv, type LeakGuardConfig } from "./leak-guard.ts";

const SLACK_API = "https://slack.com/api";
const MAX_DROP_TEXT_LENGTH = 120;
const BARE_URL = /^https?:\/\/\S+$/;

interface SlackDropSourceConfig {
  token: string;
  channelId: string;
  fetchImpl?: typeof globalThis.fetch;
  limit?: number;
  leakGuard?: LeakGuardConfig;
}

interface SlackMessage {
  text: string;
  timestamp: number;
  ts: string;
}

function message(value: unknown): SlackMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.text !== "string" || typeof raw.ts !== "string") return null;
  const timestamp = Math.floor(Number(raw.ts) * 1_000);
  if (!Number.isFinite(timestamp)) return null;
  return { text: raw.text.trim(), timestamp, ts: raw.ts };
}

function dropCandidate(message: SlackMessage, channelId: string): Candidate | null {
  if (message.text.length === 0) return null;
  if (BARE_URL.test(message.text)) {
    return {
      source: "drop",
      title: message.text,
      url: message.text,
      context: message.text,
      timestamp: message.timestamp,
    };
  }
  if (message.text.length > MAX_DROP_TEXT_LENGTH) return null;
  return {
    source: "drop",
    title: message.text,
    url: `slack://channel/${channelId}/message/${message.ts}`,
    context: message.text,
    timestamp: message.timestamp,
  };
}

export class SlackDropSource implements CandidateSource {
  private readonly token: string;
  private readonly channelId: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly limit: number;
  private readonly leakGuard: LeakGuardConfig;

  constructor(config: SlackDropSourceConfig) {
    this.token = config.token;
    this.channelId = config.channelId;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.limit = Math.min(Math.max(config.limit ?? 50, 1), 100);
    this.leakGuard = config.leakGuard ?? {};
  }

  async gather(): Promise<SourceResult> {
    const url = new URL(`${SLACK_API}/conversations.history`);
    url.searchParams.set("channel", this.channelId);
    url.searchParams.set("limit", String(this.limit));
    const response = await this.fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok || typeof payload !== "object" || payload === null) {
      throw new Error(`Slack request failed with status ${response.status}`);
    }
    const raw = payload as Record<string, unknown>;
    if (raw.ok !== true) throw new Error("Slack conversations.history returned an error");
    const candidates = (Array.isArray(raw.messages) ? raw.messages : [])
      .map(message)
      .filter((item): item is SlackMessage => item !== null)
      .map((item) => dropCandidate(item, this.channelId))
      .filter((item): item is Candidate => item !== null);
    return sourceResult(candidates, this.leakGuard);
  }
}

export function slackDropsFromEnv(fetchImpl?: typeof globalThis.fetch): SlackDropSource {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || token.trim().length === 0) throw new Error("SLACK_BOT_TOKEN is not set");
  const channelId = process.env.SLACK_X_CHANNEL_ID;
  if (!channelId || channelId.trim().length === 0) {
    throw new Error("SLACK_X_CHANNEL_ID is not set");
  }
  return new SlackDropSource({
    token,
    channelId,
    fetchImpl,
    leakGuard: leakGuardConfigFromEnv(),
  });
}
