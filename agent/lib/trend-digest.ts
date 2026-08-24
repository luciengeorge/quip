import type { AcceptedIdea, IdeaRejection, MoatClass } from "./idea-gate.ts";
import type { TrendDirection } from "./velocity.ts";

export interface WeeklyTrend {
  topicHash: string;
  title: string;
  url: string;
  source: string;
  activeDays: number;
  totalSignals: number;
  direction: TrendDirection;
}

export interface DigestIdea {
  title: string;
  mechanism: string;
  evidence: string;
  moatClass: MoatClass;
  buildDays: number;
  buildBreakdown: string;
  ownerFit: string;
  acceptance: "direct" | "after-research";
  researchSummary?: string;
}

export interface ReadSpend {
  usedReads: number;
  reservedReads: number;
  capReads: number;
  usedUsd: number;
  capUsd: number;
}

export interface TrendDigestInput {
  trends: readonly WeeklyTrend[];
  ideas: readonly DigestIdea[];
  rejections: readonly IdeaRejection[];
  spend: ReadSpend;
  xDataAvailable: boolean;
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  hn: "Hacker News",
  "github-trending": "GitHub Trending",
  rss: "RSS",
  exa: "Exa",
  x: "X",
  trending: "Trend source",
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function trendLine(trend: WeeklyTrend): string {
  return `- **${trend.title}**: ${sourceLabel(trend.source)} recorded ${trend.totalSignals} signals across ${trend.activeDays} days, ${trend.direction}. ${trend.url}`;
}

function ideaLine(idea: DigestIdea): string {
  return [
    `- **${idea.title}** (${idea.acceptance === "after-research" ? "ACCEPTED AFTER RESEARCH" : "accepted directly"})`,
    `  Evidence: ${idea.evidence}`,
    `  Moat: ${idea.moatClass}. Build: ${idea.buildDays.toFixed(1)} days (${idea.buildBreakdown}).`,
    `  Mechanism: ${idea.mechanism}`,
    ...(idea.acceptance === "after-research" && idea.researchSummary
      ? [`  Research supplied: ${idea.researchSummary}`]
      : []),
    `  Why it suits the owner: ${idea.ownerFit}`,
  ].join("\n");
}

function asDigestIdeas(ideas: readonly DigestIdea[] | readonly AcceptedIdea[]): DigestIdea[] {
  return ideas.map((idea) => {
    if ("acceptance" in idea) return idea;
    const { title, mechanism, evidence, moatClass, buildDays, buildBreakdown, ownerFit } = idea;
    return {
      title,
      mechanism,
      evidence,
      moatClass,
      buildDays,
      buildBreakdown,
      ownerFit,
      acceptance: "direct",
    };
  });
}

function dollars(value: number): string {
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

/** Render the short weekly report only from measured trends and gate-approved ideas. */
export function renderTrendDigest(input: TrendDigestInput): string {
  const trends = input.trends.slice(0, 5);
  const ideas = asDigestIdeas(input.ideas).slice(0, 3);
  const lines = [
    "# Quip weekly trend digest",
    "Owner-fit notes are an approximation from public GitHub and past posts, not a claim to know the owner's interests.",
    "Build estimates cover construction only; distribution is usually the bottleneck, not building.",
    input.xDataAvailable
      ? "X data was available for at least one scan this week."
      : "X data was unavailable this week, so this digest is based on free sources rather than X.",
    "",
    "## Trends",
    ...(trends.length > 0 ? trends.map(trendLine) : ["- No qualifying multi-day trends."]),
    "",
    "## Ideas",
    ...(ideas.length > 0
      ? ideas.map(ideaLine)
      : ["No ideas passed the deterministic gate this week. That is expected, not a failure."]),
    "",
    "## Rejected",
    ...(input.rejections.length > 0
      ? input.rejections.map(
          (rejection) =>
            `- ${rejection.title}: ${rejection.reason}.${rejection.researchAttempted ? " Research was attempted." : ""}`,
        )
      : ["- Nothing was rejected after proposal review."]),
    "",
    `Read spend: $${dollars(input.spend.usedUsd)} of $${dollars(input.spend.capUsd)} (${input.spend.usedReads} used + ${input.spend.reservedReads} reserved of ${input.spend.capReads} reads).`,
  ];
  if (trends.length === 0 && ideas.length === 0) {
    lines.splice(3, 0, "No trends or ideas qualified this week.");
  }
  return lines.join("\n");
}
