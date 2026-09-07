import { containsLeak } from "./leak-guard.ts";

/**
 * Daily buyer-intent reporting.
 *
 * Demand asks are scored on freshness and on being unanswered, because a two-day-old question
 * with no replies is the whole signal. Until now the only surface that showed them was the
 * Sunday digest, so an ask found on Monday was six days stale before anyone read it. Reporting
 * the day's asks the day they are found is the point of the scoring.
 *
 * This renders from persisted values only. It never drafts a reply, never addresses an asker,
 * and never proposes contacting anyone: it is a private report to the owner's own channel.
 */

export const DAILY_DEMAND_REPORT_MAX_ASKS = 8;

export interface ReportableDemandAsk {
  quote: string;
  permalink: string;
  askedAt: number;
  replyCount: number;
  score: number;
  subreddit: string;
  source: string;
  askedFor: string;
}

export interface DailyDemandReportInput {
  day: string;
  asks: readonly ReportableDemandAsk[];
  candidateCount: number;
  generatedAt: number;
  /** Classifier and persistence drops, already worded by the runtime. */
  notes?: readonly string[];
}

/**
 * Name the platform an ask came from.
 *
 * The single shared line used to hardcode `r/${subreddit}`, which is correct only for Reddit.
 * Stack Exchange asks rendered as `r/softwarerecs` and X asks as `r/x`, so two of the three
 * sources were mislabelled as subreddits next to a permalink that plainly was not one.
 */
export function demandSourceLabel(ask: Pick<ReportableDemandAsk, "source" | "subreddit">): string {
  if (ask.source === "reddit") return `r/${ask.subreddit}`;
  if (ask.source === "stackexchange") return `${ask.subreddit}.stackexchange.com`;
  if (ask.source === "x") return "X";
  return ask.source;
}

/**
 * Collapse a quote to a single line.
 *
 * Quotes are verbatim source text, so they carry the newlines people typed. A raw newline
 * breaks the one-bullet-per-ask format and makes the rest of the ask look like separate items.
 */
export function flattenQuote(quote: string): string {
  return quote.replace(/\s+/g, " ").trim();
}

export function demandAge(askedAt: number, generatedAt: number): string {
  const hours = Math.floor(Math.max(0, generatedAt - askedAt) / (60 * 60 * 1_000));
  return hours < 48 ? `${hours}h old` : `${Math.floor(hours / 24)}d old`;
}

export function demandAskLine(ask: ReportableDemandAsk, generatedAt: number): string {
  const replies = ask.replyCount === 1 ? "1 reply" : `${ask.replyCount} replies`;
  return `- "${flattenQuote(ask.quote)}" (${demandAge(ask.askedAt, generatedAt)}, ${replies}, ${demandSourceLabel(ask)}, score ${Math.round(ask.score)}): ${ask.permalink}`;
}

function askText(ask: ReportableDemandAsk): string {
  return [ask.quote, ask.permalink, ask.askedFor, ask.subreddit].join(" ");
}

/** Render the day's buyer-intent asks, or say plainly that there were none. */
export function renderDailyDemandReport(input: DailyDemandReportInput): string {
  const safe = input.asks.filter((ask) => !containsLeak(askText(ask)).leaked);
  const ranked = [...safe].sort((a, b) => b.score - a.score).slice(0, DAILY_DEMAND_REPORT_MAX_ASKS);
  const lines = [`# Quip buyer intent, ${input.day}`];

  if (ranked.length === 0) {
    // An explicit zero is the point. Posting nothing on a quiet day is indistinguishable from
    // the sweep never running, which is the exact ambiguity this report exists to remove.
    lines.push(
      `No buyer-intent asks qualified today, from ${input.candidateCount} candidates scanned.`,
    );
  } else {
    lines.push(
      `${ranked.length} of ${safe.length} asks shown, from ${input.candidateCount} candidates scanned.`,
      "Evidence only. These are not people to reply to.",
      "",
      ...ranked.map((ask) => demandAskLine(ask, input.generatedAt)),
    );
  }

  const notes = input.notes ?? [];
  if (notes.length > 0) lines.push("", ...notes.map((note) => `- ${note}`));
  return lines.join("\n");
}

/** The notice posted when a sweep produced nothing to classify, so a dark day is still visible. */
export function renderDemandSweepNotice(day: string, reason: string): string {
  return [`# Quip buyer intent, ${day}`, `No demand scan today: ${reason}.`].join("\n");
}
