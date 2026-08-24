import type { TrendDigestInput } from "./trend-digest.ts";

export const sampleTrendDigestInput: TrendDigestInput = {
  trends: [
    {
      topicHash: "b".repeat(64),
      title: "Small teams are adopting local-first database tooling",
      url: "https://news.ycombinator.com/item?id=12345",
      source: "hn",
      activeDays: 4,
      totalSignals: 11,
      direction: "accelerating",
    },
  ],
  ideas: [
    {
      title: "Migration leads for local-first adopters",
      mechanism: "Publish migration checks and sell verified handoffs to local-first consultancies.",
      evidence: "https://news.ycombinator.com/item?id=12345 11 signals across 4 days, accelerating.",
      moatClass: "distribution",
      buildDays: 2.5,
      buildBreakdown: "shell + auth + 1 integration",
      ownerFit: "It matches the owner's public developer-tool work, an approximation from GitHub and past posts.",
      acceptance: "direct",
    },
    {
      title: "Verified local-first procurement exchange",
      mechanism: "Verify buyer migration intent from source citations, match it with specialists, and charge for completed introductions.",
      evidence: "https://example.com/research 42% of buyers reported this need, accelerating.",
      moatClass: "data",
      buildDays: 3,
      buildBreakdown: "shell + auth + payments + 1 integration",
      ownerFit: "It fits the owner's public developer-tool work, an approximation from GitHub and past posts.",
      acceptance: "after-research",
      researchSummary: "Research supplied a reported 42% buyer need and a cited data moat.",
    },
  ],
  rejections: [
    {
      title: "Generic AI dashboard",
      reason: "idea restates the trend without a concrete mechanism",
      researchAttempted: true,
    },
  ],
  spend: { usedReads: 167, reservedReads: 0, capReads: 5_000, usedUsd: 0.835, capUsd: 25 },
  xDataAvailable: false,
};
