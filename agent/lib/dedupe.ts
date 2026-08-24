import { createHash } from "node:crypto";

import type { Candidate } from "./candidates.ts";

export const DEFAULT_DEDUPE_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;

export interface TopicHashInput {
  title: string;
  url: string;
}

export interface RecentItem {
  url?: string;
  topicHash?: string;
  timestamp?: number;
  postedAt?: number;
  createdAt?: number;
  text?: string;
}

export interface DedupeOptions {
  windowMs?: number;
}

const TITLE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

function titleKeywords(title: string): string[] {
  return [...new Set(title.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((word) => !TITLE_STOP_WORDS.has(word))
    .sort();
}

function urlHostAndPath(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.host.toLocaleLowerCase()}${path.toLocaleLowerCase()}`;
  } catch {
    return url.trim().toLocaleLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

/** Return a URL identity suitable for exact duplicate checks. */
export function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

/** Hash normalised title keywords and the URL host/path without query parameters. */
export function topicHash(candidate: TopicHashInput): string {
  const input = `${titleKeywords(candidate.title).join(" ")}\n${urlHostAndPath(candidate.url)}`;
  return createHash("sha256").update(input).digest("hex");
}

function timestampOf(item: RecentItem): number | null {
  for (const value of [item.timestamp, item.postedAt, item.createdAt]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function configuredWindow(windowMs: number | undefined): number {
  return typeof windowMs === "number" && Number.isFinite(windowMs) && windowMs >= 0
    ? windowMs
    : DEFAULT_DEDUPE_WINDOW_MS;
}

/** Return true for an exact URL match or a recent matching topic hash. */
export function isDuplicate(
  candidate: Candidate,
  recent: readonly RecentItem[],
  options: DedupeOptions = {},
): boolean {
  const candidateUrl = canonicalUrl(candidate.url);
  const candidateTopicHash = topicHash(candidate);
  const windowMs = configuredWindow(options.windowMs);

  return recent.some((item) => {
    if (item.url && canonicalUrl(item.url) === candidateUrl) return true;
    if (item.topicHash !== candidateTopicHash) return false;

    const timestamp = timestampOf(item);
    return timestamp !== null && Math.abs(candidate.timestamp - timestamp) <= windowMs;
  });
}
