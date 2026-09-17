import type { JevClient } from "./jev.ts";

/**
 * Quip's first eval, and the rule that decides what Jev is allowed to grade.
 *
 * WHO PRODUCED WHAT. Jev now classifies buyer asks and judges incumbents; a language model names
 * themes; code computes the verdict and renders the report. An eval is only worth anything when
 * the grader did not produce the thing being graded, so:
 *
 *   theme labels      produced by the LLM   -> Jev grades them. This file.
 *   classification    produced by Jev       -> Jev must NOT grade it. See auditSample below: the
 *                                             LLM classifier re-decides a sample and the two are
 *                                             compared. A grader marking its own work always
 *                                             looks excellent.
 *   verdict, report   produced by code      -> nothing to grade; they are rules, and tests pin them.
 *
 * WHY LABEL QUALITY IS THE ONE THAT MATTERS. A theme label is not decoration. Grouping happens by
 * label, recurrence is counted per theme, and the two-asker threshold is what turns evidence into
 * a verdict. A label like "is there an app for the cab?" cannot collect a second asker, so a bad
 * label silently removes a want from the funnel and looks exactly like an absence of demand.
 */

/** Lowest level first: Jev returns a probability-weighted position along this rubric. */
export const LABEL_RUBRIC = [
  "Names nothing: a fragment, a pronoun, or a restatement of one post's wording.",
  "Names a very broad category that many unrelated wants would fall into.",
  "Names a recognisable want, but loosely enough that the boundary is unclear.",
  "Names one specific want precisely enough to group other posts by it.",
] as const;

/** At or above this on the rubric, the label can do its job of collecting a second asker. */
export const LABEL_GOOD_AT = 2;

export interface LabelQuality {
  /** Position along LABEL_RUBRIC, 0 to 3, can land between levels. */
  score: number;
  confidence: number;
  model: string;
}

export async function scoreThemeLabel(
  jev: JevClient,
  input: { label: string; quotes: readonly string[] },
  logger: Pick<Console, "warn"> = console,
): Promise<LabelQuality | undefined> {
  try {
    const res = await jev.ask(
      { label: input.label, posts: input.quotes.slice(0, 5) },
      {
        quality: {
          type: "score",
          instructions:
            "How well does this label name the want shared by these posts, judged by whether a future post asking for the same thing could be grouped under it?",
          criteria: [...LABEL_RUBRIC],
        },
      },
    );
    return { score: res.answers.quality.score, confidence: res.answers.quality.confidence, model: res.model };
  } catch (err) {
    logger.warn(`[jev] label quality unavailable for "${input.label}":`, err);
    return undefined;
  }
}

export interface LabelQualitySummary {
  scored: number;
  meanScore: number;
  good: number;
  poor: number;
  poorLabels: string[];
}

/** Aggregate for the report. A mean on its own hides one broken label among nine good ones. */
export function summariseLabelQuality(
  themes: readonly { label: string; labelQuality?: number }[],
): LabelQualitySummary | null {
  const scored = themes.filter(
    (t): t is { label: string; labelQuality: number } => typeof t.labelQuality === "number",
  );
  if (scored.length === 0) return null;
  const poor = scored.filter((t) => t.labelQuality < LABEL_GOOD_AT);
  const mean = scored.reduce((sum, t) => sum + t.labelQuality, 0) / scored.length;
  return {
    scored: scored.length,
    meanScore: Math.round(mean * 100) / 100,
    good: scored.length - poor.length,
    poor: poor.length,
    // Named, not just counted: a bad label is fixable only if you can see which one it is.
    poorLabels: poor
      .sort((a, b) => a.labelQuality - b.labelQuality)
      .slice(0, 5)
      .map((t) => t.label),
  };
}

/** How often the independent auditor must re-check what Jev classified. */
export const AUDIT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;
export const AUDIT_SAMPLE_SIZE = 10;

export function auditDue(lastAuditAt: number | undefined, now: number): boolean {
  return lastAuditAt === undefined || now - lastAuditAt >= AUDIT_INTERVAL_MS;
}

export interface AuditCandidate {
  permalink: string;
  quote: string;
}

/**
 * A sample of what Jev accepted, for the language model to re-decide.
 *
 * Deterministic by position rather than random, so a rerun audits the same asks and an agreement
 * rate can be compared with the previous one instead of moving for two reasons at once.
 */
export function auditSample(
  asks: readonly { permalink: string; quote: string }[],
  size: number = AUDIT_SAMPLE_SIZE,
): AuditCandidate[] {
  if (asks.length <= size) return asks.map((a) => ({ permalink: a.permalink, quote: a.quote }));
  const step = asks.length / size;
  return Array.from({ length: size }, (_v, i) => {
    const a = asks[Math.floor(i * step)] as { permalink: string; quote: string };
    return { permalink: a.permalink, quote: a.quote };
  });
}

export interface AuditResult {
  sampled: number;
  agreed: number;
  agreementRate: number;
  /** Asks the auditor says are not buyer intent at all. These are the ones worth reading. */
  disputed: string[];
}

/**
 * Compare the auditor's verdicts with Jev's. Every sampled ask was accepted by Jev, so the
 * auditor saying "not a buyer ask" is a disagreement and nothing else needs inferring.
 */
export function scoreAudit(
  sample: readonly AuditCandidate[],
  verdicts: readonly unknown[],
): AuditResult {
  const byPermalink = new Map<string, boolean>();
  for (const value of verdicts) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as { permalink?: unknown; buyerAsk?: unknown };
    if (typeof v.permalink === "string" && typeof v.buyerAsk === "boolean") {
      byPermalink.set(v.permalink, v.buyerAsk);
    }
  }
  const judged = sample.filter((s) => byPermalink.has(s.permalink));
  const disputed = judged.filter((s) => byPermalink.get(s.permalink) === false);
  return {
    sampled: judged.length,
    agreed: judged.length - disputed.length,
    // An audit with nothing judged is not agreement, it is an audit that did not happen.
    agreementRate: judged.length === 0 ? 0 : Math.round(((judged.length - disputed.length) / judged.length) * 100) / 100,
    disputed: disputed.map((s) => s.permalink),
  };
}
