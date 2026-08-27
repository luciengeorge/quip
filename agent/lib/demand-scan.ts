import { canonicalUrl, topicHash } from "./dedupe.ts";
import { demandAskScore } from "./demand-score.ts";
import { containsLeak, type LeakGuardConfig } from "./leak-guard.ts";
import type { Candidate } from "./candidates.ts";
import type { RedditDemandCandidate } from "./reddit.ts";
import type { StackExchangeDemandCandidate } from "./stackexchange.ts";

export type DemandCandidate = RedditDemandCandidate | StackExchangeDemandCandidate;

export interface DemandAsk {
  topicHash: string;
  day: string;
  quote: string;
  permalink: string;
  author: string;
  askedAt: number;
  replyCount: number;
  score: number;
  subreddit: string;
  source: DemandCandidate["source"];
  askedFor: string;
}

export interface DemandCandidatePlan {
  day: string;
  candidates: DemandCandidate[];
  cap: number;
  droppedCount: number;
  duplicateCount: number;
  leakyCount: number;
  cappedCount: number;
}

export interface DemandClassificationResult {
  asks: DemandAsk[];
  malformedOutputCount: number;
  nonBuyerCount: number;
  nonVerbatimQuoteCount: number;
  leakyCount: number;
}

interface ClassifiedBuyerAsk {
  buyerAsk: true;
  author: string;
  askedAt: number;
  quote: string;
  replyCount: number;
  permalink: string;
  subreddit: string;
  askedFor: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonBlankString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum
    ? value.trim()
    : null;
}

function exactQuote(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1_200
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function isDemandDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(day);
}

function validClassificationCap(cap: number): boolean {
  return Number.isSafeInteger(cap) && cap >= 1 && cap <= 30;
}

function asDemandCandidate(candidate: Candidate): DemandCandidate | null {
  const raw = candidate as Partial<DemandCandidate>;
  const author = nonBlankString(raw.author, 80);
  const subreddit = nonBlankString(raw.subreddit, 80);
  const replyCount = nonNegativeInteger(raw.replyCount);
  const sourceText = typeof raw.sourceText === "string" && raw.sourceText.trim().length > 0
    ? raw.sourceText
    : null;
  if (
    (candidate.source !== "reddit" && candidate.source !== "stackexchange") ||
    candidate.title.trim().length === 0 ||
    candidate.url.trim().length === 0 ||
    candidate.context.trim().length === 0 ||
    !author ||
    !subreddit ||
    !sourceText ||
    !Number.isFinite(candidate.timestamp) ||
    replyCount === null
  ) {
    return null;
  }
  return {
    source: candidate.source,
    title: candidate.title.trim(),
    url: candidate.url.trim(),
    context: candidate.context,
    timestamp: candidate.timestamp,
    author,
    replyCount,
    subreddit,
    sourceText,
  };
}

function candidateText(candidate: DemandCandidate): string {
  return [
    candidate.title,
    candidate.url,
    candidate.context,
    candidate.author,
    candidate.subreddit,
    candidate.sourceText,
  ].join("\n");
}

/** Give all source results one defensive boundary before a model can see or store them. */
export function planDemandCandidates(
  candidates: readonly Candidate[],
  day: string,
  cap: number,
  leakGuard: LeakGuardConfig = {},
): DemandCandidatePlan {
  if (!isDemandDay(day)) throw new Error("Invalid demand day");
  if (!validClassificationCap(cap)) throw new Error("Invalid demand classification cap");
  let droppedCount = 0;
  let duplicateCount = 0;
  let leakyCount = 0;
  const seenPermalinks = new Set<string>();
  const valid: DemandCandidate[] = [];
  for (const candidate of candidates) {
    const demandCandidate = asDemandCandidate(candidate);
    if (!demandCandidate) {
      droppedCount += 1;
      continue;
    }
    const permalink = canonicalUrl(demandCandidate.url);
    if (seenPermalinks.has(permalink)) {
      duplicateCount += 1;
      continue;
    }
    seenPermalinks.add(permalink);
    if (containsLeak(candidateText(demandCandidate), leakGuard).leaked) {
      leakyCount += 1;
      continue;
    }
    valid.push({ ...demandCandidate, url: permalink });
  }
  return {
    day,
    candidates: valid.slice(0, cap),
    cap,
    droppedCount,
    duplicateCount,
    leakyCount,
    cappedCount: Math.max(0, valid.length - cap),
  };
}

function parsedBuyerAsk(value: unknown): ClassifiedBuyerAsk | false | null {
  const raw = record(value);
  if (!raw || typeof raw.buyerAsk !== "boolean") return null;
  if (raw.buyerAsk === false) return false;
  const author = nonBlankString(raw.author, 80);
  const quote = exactQuote(raw.quote);
  const permalink = nonBlankString(raw.permalink, 700);
  const subreddit = nonBlankString(raw.subreddit, 80);
  const askedFor = nonBlankString(raw.askedFor, 280);
  const askedAt = finiteInteger(raw.askedAt);
  const replyCount = nonNegativeInteger(raw.replyCount);
  if (
    !author ||
    !quote ||
    !permalink ||
    !subreddit ||
    !askedFor ||
    askedAt === null ||
    replyCount === null
  ) {
    return null;
  }
  return { buyerAsk: true, author, askedAt, quote, replyCount, permalink, subreddit, askedFor };
}

function matchesSource(
  output: ClassifiedBuyerAsk,
  candidate: DemandCandidate,
): boolean {
  return (
    output.author === candidate.author &&
    output.askedAt === candidate.timestamp &&
    output.replyCount === candidate.replyCount &&
    output.permalink === candidate.url &&
    output.subreddit === candidate.subreddit
  );
}

function demandTopicHash(askedFor: string): string {
  return topicHash({ title: askedFor, url: "demand://buyer-intent" });
}

function classifiedText(output: ClassifiedBuyerAsk): string {
  return [
    output.author,
    String(output.askedAt),
    output.quote,
    String(output.replyCount),
    output.permalink,
    output.subreddit,
    output.askedFor,
  ].join("\n");
}

/**
 * Treat classifier output as untrusted. A malformed answer, source mismatch, or paraphrased quote
 * is not buyer evidence. The caller can provide more output than needed, but only the sealed cap is read.
 */
export function classifyDemandCandidates(
  plan: DemandCandidatePlan,
  classifications: readonly unknown[],
  now: number,
  leakGuard: LeakGuardConfig = {},
): DemandClassificationResult {
  if (!Number.isFinite(now)) throw new Error("Invalid demand classification time");
  const asks: DemandAsk[] = [];
  let malformedOutputCount = 0;
  let nonBuyerCount = 0;
  let nonVerbatimQuoteCount = 0;
  let leakyCount = 0;
  for (const [index, candidate] of plan.candidates.entries()) {
    const output = parsedBuyerAsk(classifications[index]);
    if (output === false) {
      nonBuyerCount += 1;
      continue;
    }
    if (!output || !matchesSource(output, candidate)) {
      malformedOutputCount += 1;
      continue;
    }
    if (!candidate.sourceText.includes(output.quote)) {
      nonVerbatimQuoteCount += 1;
      continue;
    }
    if (containsLeak(classifiedText(output), leakGuard).leaked) {
      leakyCount += 1;
      continue;
    }
    asks.push({
      topicHash: demandTopicHash(output.askedFor),
      day: plan.day,
      quote: output.quote,
      permalink: output.permalink,
      author: output.author,
      askedAt: output.askedAt,
      replyCount: output.replyCount,
      score: demandAskScore({ askedAt: output.askedAt, replyCount: output.replyCount }, now),
      subreddit: output.subreddit,
      source: candidate.source,
      askedFor: output.askedFor,
    });
  }
  return { asks, malformedOutputCount, nonBuyerCount, nonVerbatimQuoteCount, leakyCount };
}
