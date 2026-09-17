import { BUILD_COMPONENT_COSTS } from "./build-cost.ts";
import type { IncumbentCoverage, ThemeResearchOutput } from "./demand-themes.ts";
import { ExaTrendingSource } from "./exa.ts";
import type { JevClient } from "./jev.ts";
import type { LeakGuardConfig } from "./leak-guard.ts";

/**
 * Incumbent research with Jev: read what search returned, decide coverage per product, and let
 * code write the summary.
 *
 * WHAT THIS REPLACES. A language-model subagent read Exa's results and returned a prose summary,
 * a coverage word, a list of incumbents and a list of build components. The first production run
 * showed what that costs: a 600-character summary severed mid-word, eight incumbents in one
 * paragraph, and a component list whose names were not in the allowed set, which made the build
 * estimate unpriceable and printed "~0 days".
 *
 * Every one of those failures is a formatting failure around a judgement that is not itself
 * generative. "Does this product serve that want?" is a three-way choice over two short texts.
 * "Does a first version need payments?" is a yes or no. Jev answers both as calibrated
 * probabilities, one call covers all of them, and the summary is then assembled from the answers
 * rather than written, so it cannot run long, cannot be truncated, and cannot disagree with the
 * numbers beside it.
 *
 * The coverage rule stays where it already was: `verdictFor` in demand-themes.ts turns coverage
 * into a verdict. Nothing here decides whether to build anything.
 */

/** A search result to judge against the want. Whatever the search provider returned. */
export interface IncumbentCandidate {
  name: string;
  url: string;
  text: string;
}

/** Below this the product does not plausibly serve the want at all and is not an incumbent. */
export const INCUMBENT_MIN_RELEVANCE = 0.4;
/** At or above this on "serves it fully", the want is already met by something that exists. */
export const INCUMBENT_COVERS_AT = 0.6;
export const INCUMBENT_CONCURRENCY = 6;
/** Named in the report; more than this is a wall of text nobody finishes. */
export const INCUMBENT_MAX_REPORTED = 5;

export type BuildComponentName = Exclude<keyof typeof BUILD_COMPONENT_COSTS, "base app shell">;

/**
 * What a first version needs, asked one yes/no at a time.
 *
 * The component vocabulary is the pricing table's own keys, so an answer can never name something
 * the estimator cannot price. That was the "~0 days" bug: the model invented component names.
 */
export const BUILD_COMPONENT_QUESTIONS: Record<BuildComponentName, string> = {
  auth: "Would a first version need user accounts and sign-in?",
  payments: "Would a first version need to take payments?",
  "third-party API integration": "Would a first version need to integrate a third-party API or platform?",
  "scraping or crawling": "Would a first version need to scrape or crawl sites that offer no API?",
  "data pipeline or ETL": "Would a first version need an ongoing data pipeline, sync, or ETL?",
  "LLM feature": "Would a first version need a language-model feature to work?",
  realtime: "Would a first version need realtime updates, streaming, or live collaboration?",
  "browser extension": "Would a first version need to be a browser extension?",
  "mobile app": "Would a first version need a native mobile app?",
  "two-sided marketplace": "Would a first version need both suppliers and buyers before it is useful?",
  "manual ops bootstrap": "Would a first version need humans doing the work manually to start?",
  "regulated or compliance work": "Would a first version touch regulated data such as health, finance, or identity?",
};

/**
 * A search result whose title does not name a product.
 *
 * Exa returns whatever the page's title tag says, and plenty of pages say "Welcome to" or "Home".
 * A live run produced the incumbent line "Welcome to: serves this want as described", which tells
 * the reader nothing and makes a real finding look careless. The coverage verdict is unaffected
 * because it rests on the probabilities, not the titles, so these are dropped from what is NAMED
 * rather than from what is judged.
 */
const UNINFORMATIVE_NAME =
  /^(welcome(\s+to)?|home( ?page)?|index|untitled|page not found|404|loading|sign ?in|log ?in)\b/iu;

/**
 * Deliberately NOT a length rule. "X" and "Vi" are real product names, so a minimum length would
 * discard real incumbents to catch a handful of placeholder titles. What actually distinguishes a
 * placeholder is that it is a known page-furniture phrase, or has no letters or digits at all.
 */
export function namesAProduct(name: string): boolean {
  const trimmed = name.trim();
  if (UNINFORMATIVE_NAME.test(trimmed)) return false;
  return /[\p{L}\p{N}]/u.test(trimmed);
}

export interface IncumbentVerdict {
  name: string;
  url: string;
  /** Probability it serves the want fully. */
  serves: number;
  /** Probability it is even about the same problem. */
  relevant: number;
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

/** Judge one search result against the want. */
export async function judgeIncumbent(
  jev: JevClient,
  want: string,
  candidate: IncumbentCandidate,
): Promise<IncumbentVerdict> {
  const res = await jev.ask(
    { want, product: { name: candidate.name, description: candidate.text.slice(0, 900) } },
    {
      relevant: {
        type: "noul",
        instructions: "Is this product about the same problem the want describes?",
      },
      serves: {
        type: "noul",
        instructions: "Would this product, as described, already serve someone who wants that, without them needing something else built?",
        criteria: {
          true: "Someone with this want could use this product today and be satisfied.",
          false: "It is adjacent, partial, or solves a different part of the problem.",
        },
      },
    },
  );
  return { name: candidate.name, url: candidate.url, serves: res.answers.serves.noul, relevant: res.answers.relevant.noul };
}

/**
 * Coverage from the per-product verdicts.
 *
 * `covers` needs one product that actually serves the want. Several partial products are still
 * `partial`, however many there are: five things that each do a third of the job is a gap, and
 * the previous prose summary kept describing exactly that situation and calling it crowded.
 */
export function coverageFrom(verdicts: readonly IncumbentVerdict[]): IncumbentCoverage {
  const relevant = verdicts.filter((v) => v.relevant >= INCUMBENT_MIN_RELEVANCE);
  if (relevant.length === 0) return "none";
  return relevant.some((v) => v.serves >= INCUMBENT_COVERS_AT) ? "covers" : "partial";
}

/** One or two sentences, assembled from the numbers, so it cannot run long or drift from them. */
export function summaryFrom(
  want: string,
  coverage: IncumbentCoverage,
  relevant: readonly IncumbentVerdict[],
): string {
  if (coverage === "none") {
    return `Nothing found that addresses ${want}.`;
  }
  // Name the best product that can actually be named. Falling back to a count keeps the sentence
  // true when every relevant result had an uninformative title.
  const named = [...relevant].filter((v) => namesAProduct(v.name)).sort((a, b) => b.serves - a.serves);
  const best = named[0];
  if (coverage === "covers") {
    return best
      ? `${best.name} already serves this want as described, so building it again needs a reason this does not cover.`
      : "An existing product already serves this want, though the search result did not name it clearly.";
  }
  const count = relevant.length;
  const closest = best ? `; the closest is ${best.name}` : "";
  return `${count} ${count === 1 ? "product addresses" : "products address"} this space but none serves the want on its own${closest}.`;
}

export interface JevIncumbentResearch extends ThemeResearchOutput {
  model: string;
  judged: number;
}

/**
 * Judge every search result, decide coverage, pick the build components, and assemble the output
 * the existing `record_theme_research` path already expects.
 */
export async function researchIncumbentsWithJev(
  jev: JevClient,
  want: string,
  candidates: readonly IncumbentCandidate[],
  logger: Pick<Console, "warn"> = console,
): Promise<JevIncumbentResearch> {
  const verdicts: IncumbentVerdict[] = [];
  const judged = await mapBounded(candidates, INCUMBENT_CONCURRENCY, async (candidate) => {
    try {
      return await judgeIncumbent(jev, want, candidate);
    } catch (err) {
      logger.warn(`[jev] incumbent judgement failed for ${candidate.name}:`, err);
      return null;
    }
  });
  for (const v of judged) if (v) verdicts.push(v);

  const relevant = verdicts
    .filter((v) => v.relevant >= INCUMBENT_MIN_RELEVANCE)
    .sort((a, b) => b.serves - a.serves);
  const coverage = coverageFrom(verdicts);

  // Build components: one yes/no each, all in a single call.
  let buildComponents: string[] = [];
  let model = "none";
  try {
    const questions = Object.fromEntries(
      Object.entries(BUILD_COMPONENT_QUESTIONS).map(([component, instructions]) => [
        component,
        { type: "noul" as const, instructions },
      ]),
    );
    const res = await jev.ask({ want }, questions);
    model = res.model;
    buildComponents = Object.keys(BUILD_COMPONENT_QUESTIONS).filter(
      (component) => (res.answers as Record<string, { noul: number }>)[component]?.noul >= 0.5,
    );
  } catch (err) {
    // No estimate is honest; a wrong one is not. The renderer prints nothing when buildDays is
    // absent, which is what an empty component list produces downstream.
    logger.warn("[jev] build components unavailable:", err);
  }

  // Named separately from judged: a page titled "Welcome to" still counts toward coverage, it
  // just cannot be printed as the name of an incumbent.
  const nameable = relevant.filter((v) => namesAProduct(v.name));
  return {
    incumbentCoverage: coverage,
    incumbents: nameable.slice(0, INCUMBENT_MAX_REPORTED).map((v) => ({
      name: v.name,
      covers: v.serves >= INCUMBENT_COVERS_AT ? "serves this want as described" : "addresses the space but not the want itself",
    })),
    researchSummary: summaryFrom(want, coverage, relevant),
    sources: nameable.slice(0, INCUMBENT_MAX_REPORTED).map((v) => ({
      url: v.url,
      claim: `${v.name}: serves ${v.serves.toFixed(2)}, relevant ${v.relevant.toFixed(2)}`,
    })),
    buildComponents,
    model: model === "none" ? (verdicts.length > 0 ? "jev" : "none") : model,
    judged: verdicts.length,
  };
}


/**
 * Search for products that might already serve a want.
 *
 * Reuses the Exa source the weekly digest already uses, so there is one place that knows how to
 * talk to Exa and one leak guard on what comes back.
 */
export async function searchIncumbents(
  label: string,
  deps: { apiKey: string; leakGuard?: LeakGuardConfig; fetchImpl?: typeof globalThis.fetch; limit?: number },
): Promise<IncumbentCandidate[]> {
  const result = await new ExaTrendingSource({
    apiKey: deps.apiKey,
    query: `existing products, apps or services for: ${label}`,
    limit: deps.limit ?? 6,
    leakGuard: deps.leakGuard ?? {},
    fetchImpl: deps.fetchImpl,
  }).gather();
  return result.candidates.map((c) => ({ name: c.title, url: c.url, text: c.context }));
}
