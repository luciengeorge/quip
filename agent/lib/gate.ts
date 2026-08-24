import { containsLeak, type LeakGuardConfig } from "./leak-guard.ts";
import { canonicalUrl, topicHash, type RecentItem } from "./dedupe.ts";

export const DEFAULT_MAX_CHARACTERS = 280;
export const DEFAULT_MINIMUM_CHARACTERS = 10;

export interface DraftGateConfig {
  maxCharacters?: number;
  minimumCharacters?: number;
  topicHash?: string;
  leakGuard?: LeakGuardConfig;
}

export interface DraftGateOptions {
  recent: readonly RecentItem[];
  config?: DraftGateConfig;
}

export interface DraftFailure {
  rule:
    | "character-limit"
    | "em-dash"
    | "banned-phrase"
    | "hashtag-count"
    | "duplicate-url"
    | "duplicate-topic"
    | "leak"
    | "empty";
  detail: string;
}

export interface DraftGateResult {
  pass: boolean;
  failures: DraftFailure[];
}

const BANNED_PHRASES = [
  "game changer",
  "\u{1F9F5}",
  "unpopular opinion:",
  "let that sink in",
  "this changes everything",
] as const;
const URL_PATTERN = /https?:\/\/[^\s<>()]+/gu;
const HASHTAG_PATTERN = /(?:^|[\s(])#[\p{L}\p{N}_]+/gu;

function configuredLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_PATTERN)].map((match) => match[0].replace(/[.,!?;:]+$/, ""));
}

function recentUrls(item: RecentItem): string[] {
  return [...(item.url ? [item.url] : []), ...(item.text ? urlsIn(item.text) : [])];
}

function draftTopicHash(text: string, urls: readonly string[], config: DraftGateConfig): string {
  return config.topicHash ?? topicHash({ title: text, url: urls[0] ?? "" });
}

/** Apply every deterministic layer-one rule and report each failure. */
export function checkDraft(text: string, options: DraftGateOptions): DraftGateResult {
  const config = options.config ?? {};
  const maxCharacters = configuredLimit(config.maxCharacters, DEFAULT_MAX_CHARACTERS);
  const minimumCharacters = configuredLimit(
    config.minimumCharacters,
    DEFAULT_MINIMUM_CHARACTERS,
  );
  const failures: DraftFailure[] = [];

  if (text.length > maxCharacters) {
    failures.push({
      rule: "character-limit",
      detail: `${text.length} characters exceeds the ${maxCharacters} character limit`,
    });
  }
  if (/\u2014/u.test(text)) {
    failures.push({ rule: "em-dash", detail: "contains an em dash character" });
  }

  const normalisedText = text.toLocaleLowerCase();
  const bannedPhrase = BANNED_PHRASES.find((phrase) => normalisedText.includes(phrase));
  if (bannedPhrase) {
    failures.push({ rule: "banned-phrase", detail: `contains banned phrase: ${bannedPhrase}` });
  }

  const hashtags = text.match(HASHTAG_PATTERN) ?? [];
  if (hashtags.length > 1) {
    failures.push({ rule: "hashtag-count", detail: `contains ${hashtags.length} hashtags` });
  }

  const urls = urlsIn(text);
  const duplicateUrl = urls.find((url) =>
    options.recent.some((item) =>
      recentUrls(item).some((recentUrl) => canonicalUrl(recentUrl) === canonicalUrl(url)),
    ),
  );
  if (duplicateUrl) {
    failures.push({ rule: "duplicate-url", detail: `reuses recent URL: ${duplicateUrl}` });
  }

  const hash = draftTopicHash(text, urls, config);
  if (options.recent.some((item) => item.topicHash === hash)) {
    failures.push({ rule: "duplicate-topic", detail: "matches a recent topic hash" });
  }

  const leak = containsLeak(text, config.leakGuard);
  if (leak.leaked) {
    failures.push({ rule: "leak", detail: leak.reason ?? "leak guard rejected draft" });
  }
  if (text.trim().length < minimumCharacters) {
    failures.push({
      rule: "empty",
      detail: `contains fewer than ${minimumCharacters} non-whitespace characters`,
    });
  }

  return { pass: failures.length === 0, failures };
}
