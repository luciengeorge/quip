import assert from "node:assert/strict";
import test from "node:test";

import { renderTrendDigest, type WeeklyTrend } from "./trend-digest.ts";

const trend: WeeklyTrend = {
  topicHash: "a".repeat(64),
  title: "Small teams are adopting local-first database tooling",
  url: "https://news.ycombinator.com/item?id=12345",
  source: "hn",
  activeDays: 4,
  totalSignals: 11,
  direction: "accelerating",
};

test("digest renders qualified ideas with evidence, moat, estimate, and owner-fit caveat", () => {
  const digest = renderTrendDigest({
    trends: [trend],
    ideas: [
      {
        title: "Migration leads for local-first adopters",
        mechanism: "Publish migration checks and sell verified handoffs to local-first consultancies.",
        evidence: "https://news.ycombinator.com/item?id=12345 11 signals across 4 days, accelerating.",
        moatClass: "distribution",
        buildDays: 6,
        ownerFit: "It matches the owner's public developer-tool work, an approximation from GitHub and past posts.",
      },
    ],
    rejections: [{ title: "Generic AI dashboard", reason: "idea restates the trend without a concrete mechanism" }],
    spend: { usedReads: 0, reservedReads: 0, capReads: 5_000, usedUsd: 0, capUsd: 25 },
    xDataAvailable: false,
  });

  assert.match(digest, /X data was unavailable this week/);
  assert.match(digest, /11 signals across 4 days, accelerating/);
  assert.match(digest, /Moat: distribution/);
  assert.match(digest, /Build: 6 days/);
  assert.match(digest, /Generic AI dashboard: idea restates/);
  assert.match(digest, /Owner-fit notes are an approximation/);
});

test("digest states plainly when zero ideas qualify", () => {
  const digest = renderTrendDigest({
    trends: [],
    ideas: [],
    rejections: [],
    spend: { usedReads: 0, reservedReads: 0, capReads: 5_000, usedUsd: 0, capUsd: 25 },
    xDataAvailable: false,
  });

  assert.match(digest, /No trends or ideas qualified this week\./);
  assert.match(digest, /No ideas passed the deterministic gate this week\./);
  assert.match(digest, /Read spend: \$0\.00 of \$25\.00/);
});

test("digest rounds read spend to cents instead of exposing floating-point precision", () => {
  const digest = renderTrendDigest({
    trends: [],
    ideas: [],
    rejections: [],
    spend: { usedReads: 167, reservedReads: 0, capReads: 5_000, usedUsd: 0.835, capUsd: 25 },
    xDataAvailable: false,
  });

  assert.match(digest, /Read spend: \$0\.84 of \$25\.00/);
});
