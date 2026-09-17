import { canonicalUrl, topicHash } from "./dedupe.ts";
import { demandAskScore } from "./demand-score.ts";
import type { DemandAsk, DemandCandidate, DemandClassificationResult } from "./demand-scan.ts";
import type { JevClient } from "./jev.ts";
import { containsLeak, type LeakGuardConfig } from "./leak-guard.ts";

/**
 * Buyer-intent classification with Jev instead of a language model.
 *
 * WHAT THIS REPLACES. The LLM classifier had to return, for every candidate, the author, the
 * timestamp, the reply count, the permalink, the subreddit and a verbatim quote, all of which
 * were already sitting in the stored candidate it had just been handed. Every one of those was a
 * chance to be wrong: `matchesSource` drops the whole ask when any echoed field differs, and the
 * verbatim-substring guard drops it when the quote is paraphrased. Two asks a day were lost that
 * way, and the entire sealed-plan HMAC exists because a model sat in the middle of the data.
 *
 * Jev answers questions; it does not hand values back. So the metadata comes from the stored
 * candidate and cannot disagree with itself, and the quote is the candidate's own text, verbatim
 * by construction rather than by inspection. The classes of loss above simply stop existing.
 *
 * WHAT IS NEW. Because it costs almost nothing to ask more questions in the same call, each
 * candidate also gets a specificity reading. "Or is there a tool for that?" scored 92 on the
 * freshness-and-silence score, because those are exactly the properties of a fragment nobody
 * bothered to answer. Specificity is the first signal that measures whether a post names
 * anything at all, and unlike the two-asker threshold it works on the first sighting.
 */

/** Below this, the post names nothing concrete and is not evidence of demand for anything. */
export const JEV_MIN_SPECIFICITY = 0.45;
/** Below this, it is not someone looking for a product. */
export const JEV_MIN_BUYER_ASK = 0.6;
/** Concurrent Jev calls. Far under its 1,200 rpm; bounded so file descriptors stay sane. */
export const JEV_CLASSIFY_CONCURRENCY = 8;
/** A quote is the post's own text. Long posts are trimmed for the report, never reworded. */
export const JEV_MAX_QUOTE_CHARS = 280;

/** The kind of thing being asked for, used for grouping and for build estimates later. */
export const DEMAND_ASK_KINDS = {
  "mobile app": "An app installed on a phone or tablet.",
  "web app": "A website or web service you log into.",
  "browser extension": "Something that adds to an existing browser or app.",
  "desktop tool": "Software run on a computer, including a CLI.",
  "service or marketplace": "A human service, agency, or a place to find providers.",
  "data or API": "A dataset, feed, or programmatic interface.",
  other: "Something else, or too unclear to place.",
} as const;

export interface JevDemandClassification extends DemandClassificationResult {
  /** Candidates Jev judged too vague to name anything. Counted separately from non-buyers. */
  vagueCount: number;
  model: string;
}

/**
 * The post's own words, trimmed on a word boundary.
 *
 * Verbatim by construction. The old pipeline asked a model for a quote and then checked it was a
 * substring of the source; this takes the substring directly, so there is nothing to check.
 */
export function quoteFromCandidate(candidate: Pick<DemandCandidate, "sourceText" | "title">): string {
  const text = (candidate.sourceText || candidate.title).replace(/\s+/gu, " ").trim();
  if (text.length <= JEV_MAX_QUOTE_CHARS) return text;
  const cut = text.slice(0, JEV_MAX_QUOTE_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > JEV_MAX_QUOTE_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut}...`;
}

async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

interface CandidateVerdict {
  buyerAsk: number;
  specific: number;
  kind: string;
  model: string;
}

async function classifyOne(jev: JevClient, candidate: DemandCandidate): Promise<CandidateVerdict> {
  const res = await jev.ask(
    {
      post: candidate.sourceText || candidate.title,
      title: candidate.title,
      where: candidate.subreddit,
      replies: candidate.replyCount,
    },
    {
      buyerAsk: {
        type: "noul",
        instructions:
          "Is the author looking for a product, tool, app or service that they want to find or want to exist?",
        criteria: {
          true: "They are asking for a recommendation, or wishing a product existed.",
          false: "They are discussing, announcing, complaining, joking, or asking something that is not about finding a product.",
        },
      },
      specific: {
        type: "noul",
        instructions:
          "Does this post name a specific thing the author wants, clearly enough that someone could build or recommend it without seeing any other post?",
        criteria: {
          true: "The want is identifiable on its own, for example a tool that shows where LLM tokens are spent.",
          false: "It is a fragment or a bare pronoun, for example \"or is there a tool for that?\".",
        },
      },
      kind: {
        type: "choice",
        instructions: "What kind of thing is the author asking for?",
        criteria: { ...DEMAND_ASK_KINDS },
      },
    },
  );
  return {
    buyerAsk: res.answers.buyerAsk.noul,
    specific: res.answers.specific.noul,
    kind: res.answers.kind.choice,
    model: res.model,
  };
}

/**
 * Classify every candidate in the plan. Each candidate is independent, so one failure costs one
 * candidate: it is counted as malformed and the rest of the sweep proceeds.
 */
export async function classifyDemandWithJev(
  jev: JevClient,
  candidates: readonly DemandCandidate[],
  day: string,
  now: number,
  leakGuard: LeakGuardConfig = {},
  logger: Pick<Console, "warn"> = console,
): Promise<JevDemandClassification> {
  if (!Number.isFinite(now)) throw new Error("Invalid demand classification time");
  const asks: DemandAsk[] = [];
  let malformedOutputCount = 0;
  let nonBuyerCount = 0;
  let vagueCount = 0;
  let leakyCount = 0;
  let model = "none";

  const verdicts = await mapBounded(candidates, JEV_CLASSIFY_CONCURRENCY, async (candidate) => {
    try {
      return { candidate, verdict: await classifyOne(jev, candidate) };
    } catch (err) {
      logger.warn(`[jev] demand classification failed for ${candidate.url}:`, err);
      return { candidate, verdict: null };
    }
  });

  for (const { candidate, verdict } of verdicts) {
    if (!verdict) {
      malformedOutputCount += 1;
      continue;
    }
    model = verdict.model;
    if (verdict.buyerAsk < JEV_MIN_BUYER_ASK) {
      nonBuyerCount += 1;
      continue;
    }
    if (verdict.specific < JEV_MIN_SPECIFICITY) {
      vagueCount += 1;
      continue;
    }
    const quote = quoteFromCandidate(candidate);
    // The leak guard still runs. The text is the author's, not a model's, but an author can post
    // a credential just as easily, and this is the last point before it reaches durable storage.
    if (containsLeak([quote, candidate.url, candidate.author, candidate.subreddit].join("\n"), leakGuard).leaked) {
      leakyCount += 1;
      continue;
    }
    asks.push({
      // Grouped on the post's own words plus the kind, since there is no model-written summary
      // to hash any more. Two posts asking the same thing in the same words still collide.
      topicHash: topicHash({ title: `${verdict.kind}: ${quote}`, url: "demand://buyer-intent" }),
      day,
      quote,
      permalink: canonicalUrl(candidate.url),
      author: candidate.author,
      askedAt: candidate.timestamp,
      replyCount: candidate.replyCount,
      score: demandAskScore({ askedAt: candidate.timestamp, replyCount: candidate.replyCount }, now),
      subreddit: candidate.subreddit,
      source: candidate.source,
      // No model wrote this. It is the kind Jev chose plus the author's own words, which is what
      // "what they asked for" actually means.
      askedFor: `${verdict.kind}: ${quote}`,
    });
  }

  return { asks, malformedOutputCount, nonBuyerCount, nonVerbatimQuoteCount: 0, vagueCount, leakyCount, model };
}
