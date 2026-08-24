import { connectSlackCredentials } from "@vercel/connect/eve";
import { callSlackApi, type SlackBotToken } from "eve/channels/slack";

import { sourceResult, type Candidate, type CandidateSource, type SourceResult } from "./candidates.ts";
import { leakGuardConfigFromEnv, type LeakGuardConfig } from "./leak-guard.ts";

const MAX_DROP_TEXT_LENGTH = 120;
const BARE_URL = /^https?:\/\/\S+$/;

interface SlackDropSourceConfig {
  botToken: SlackBotToken | undefined;
  channelId: string | undefined;
  callSlackApi?: typeof callSlackApi;
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
  private readonly botToken: SlackBotToken | undefined;
  private readonly channelId: string | undefined;
  private readonly callSlackApi: typeof callSlackApi;
  private readonly limit: number;
  private readonly leakGuard: LeakGuardConfig;

  constructor(config: SlackDropSourceConfig) {
    this.botToken = config.botToken;
    this.channelId = config.channelId;
    this.callSlackApi = config.callSlackApi ?? callSlackApi;
    this.limit = Math.min(Math.max(config.limit ?? 50, 1), 100);
    this.leakGuard = config.leakGuard ?? {};
  }

  async gather(): Promise<SourceResult> {
    const channelId = this.channelId?.trim();
    if (!channelId) {
      console.warn("[trend-digest] Slack drops skipped: SLACK_CHANNEL_ID is not set.");
      return sourceResult([], this.leakGuard, ["Slack drops were skipped because the channel is not set."]);
    }
    try {
      const response = await this.callSlackApi({
        botToken: this.botToken,
        operation: "conversations.history",
        body: { channel: channelId, limit: this.limit },
      });
      if (response.ok !== true) {
        console.warn("[trend-digest] Slack drops unavailable:", response.error);
        return sourceResult([], this.leakGuard, ["Slack drop source was unavailable; continuing without drops."]);
      }
      const raw = response as Record<string, unknown>;
      const candidates = (Array.isArray(raw.messages) ? raw.messages : [])
        .map(message)
        .filter((item): item is SlackMessage => item !== null)
        .map((item) => dropCandidate(item, channelId))
        .filter((item): item is Candidate => item !== null);
      return sourceResult(candidates, this.leakGuard);
    } catch (error) {
      console.warn("[trend-digest] Slack drops failed cleanly:", error);
      return sourceResult([], this.leakGuard, ["Slack drop source was unavailable; continuing without drops."]);
    }
  }
}

export function slackDropsFromEnv(): SlackDropSource {
  const { botToken } = connectSlackCredentials("slack/quip");
  return new SlackDropSource({
    botToken,
    channelId: process.env.SLACK_CHANNEL_ID,
    leakGuard: leakGuardConfigFromEnv(),
  });
}
