import { topicHash } from "./dedupe.ts";
import { calculateBuildEstimate, type BuildComponent } from "./build-cost.ts";
import type { TrendDirection } from "./velocity.ts";

export type MoatClass = "network" | "trust" | "data" | "distribution" | "switching cost";

export interface ProposedIdea {
  title: string;
  trendTitle: string;
  mechanism: string;
  evidence: string;
  moatClass: string;
  buildComponents: string[];
  ownerFit: string;
}

export interface AcceptedIdea extends ProposedIdea {
  moatClass: MoatClass;
  topicHash: string;
  buildDays: number;
  buildBreakdown: string;
}

export interface IdeaRejection {
  title: string;
  reason: string;
  researchAttempted?: boolean;
}

export interface IdeaGateResult {
  accepted: AcceptedIdea[];
  rejected: IdeaRejection[];
}

const MOAT_CLASSES = new Set<MoatClass>([
  "network",
  "trust",
  "data",
  "distribution",
  "switching cost",
]);
const DIRECTION_PATTERN = /\b(accelerating|flat|cooling)\b/iu;
const URL_PATTERN = /https?:\/\/[^\s\])}>]+/giu;
const GENERIC_MECHANISM =
  /\bai is big\b|\bbuild\s+(?:an?\s+)?ai\s+things?\b|^(?:build|make|create)\s+(?:an?\s+)?(?:ai|dashboard|tool|app)\b/iu;

function evidenceUrl(evidence: string): string | null {
  const url = evidence.match(URL_PATTERN)?.[0];
  return url ? url.replace(/[.,;:!?]+$/u, "") : null;
}

function hasEvidence(evidence: string): boolean {
  const prose = evidence.replace(URL_PATTERN, " ");
  return (
    evidenceUrl(evidence) !== null &&
    /\b\d[\d,.]*\b/u.test(prose) &&
    DIRECTION_PATTERN.test(prose)
  );
}

function isMechanism(mechanism: string): boolean {
  const words = mechanism.trim().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length >= 6 && !GENERIC_MECHANISM.test(mechanism.trim());
}

/** Reuse plan 003's topic hasher so repeat ideas are rejected across weekly digests. */
export function ideaTopicHash(idea: Pick<ProposedIdea, "trendTitle" | "evidence">): string {
  return topicHash({ title: idea.trendTitle, url: evidenceUrl(idea.evidence) ?? "" });
}

function moatClass(value: string): MoatClass | null {
  const normalised = value.trim().toLocaleLowerCase();
  return MOAT_CLASSES.has(normalised as MoatClass) ? (normalised as MoatClass) : null;
}

/** Deterministic anti-slop gate. Every returned idea has independently checkable basics. */
export function checkIdeas(
  ideas: readonly ProposedIdea[],
  alreadyDigested: ReadonlySet<string>,
): IdeaGateResult {
  const accepted: AcceptedIdea[] = [];
  const rejected: IdeaRejection[] = [];
  const seen = new Set(alreadyDigested);

  for (const idea of ideas) {
    if (!hasEvidence(idea.evidence)) {
      rejected.push({ title: idea.title, reason: "evidence must include a link, number, and direction" });
      continue;
    }
    const moat = moatClass(idea.moatClass);
    if (!moat) {
      rejected.push({ title: idea.title, reason: "moat class must be exactly one accepted non-code moat" });
      continue;
    }
    const estimate = calculateBuildEstimate(idea.buildComponents);
    if (!estimate.ok) {
      rejected.push({ title: idea.title, reason: estimate.reason });
      continue;
    }
    const hash = ideaTopicHash(idea);
    if (seen.has(hash)) {
      rejected.push({ title: idea.title, reason: "topic was already digested" });
      continue;
    }
    if (!isMechanism(idea.mechanism)) {
      rejected.push({ title: idea.title, reason: "idea restates the trend without a concrete mechanism" });
      continue;
    }
    if (!/\bapproximation\b/iu.test(idea.ownerFit)) {
      rejected.push({ title: idea.title, reason: "owner fit must be stated as an approximation" });
      continue;
    }
    seen.add(hash);
    accepted.push({
      ...idea,
      buildComponents: [...idea.buildComponents] as BuildComponent[],
      moatClass: moat,
      topicHash: hash,
      buildDays: estimate.buildDays,
      buildBreakdown: estimate.breakdown,
    });
  }
  return { accepted, rejected };
}

export function directions(): readonly TrendDirection[] {
  return ["accelerating", "flat", "cooling"];
}
