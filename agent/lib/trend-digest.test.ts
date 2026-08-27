import assert from "node:assert/strict";
import test from "node:test";

import { sampleTrendDigestInput } from "./trend-digest.fixture.ts";
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
    demandAsks: [
      {
        topicHash: "demand-topic",
        day: "2026-08-24",
        quote: "Can anyone recommend a deployment preview tool?",
        permalink: "https://www.reddit.com/r/SaaS/comments/example/buyer_ask/",
        author: "buyer_one",
        askedAt: Date.parse("2026-08-24T10:00:00Z"),
        replyCount: 1,
        score: 78.1,
        subreddit: "SaaS",
        source: "reddit",
        askedFor: "deployment preview tooling for small teams",
      },
    ],
    ideas: [
      {
        title: "Migration leads for local-first adopters",
        mechanism: "Publish migration checks and sell verified handoffs to local-first consultancies.",
        evidence: "https://news.ycombinator.com/item?id=12345 11 signals across 4 days, accelerating.",
        moatClass: "distribution",
        buildDays: 3,
        buildBreakdown: "shell + auth + payments + 1 integration",
        ownerFit: "It matches the owner's public developer-tool work, an approximation from GitHub and past posts.",
        acceptance: "direct",
      },
    ],
    rejections: [{ title: "Generic AI dashboard", reason: "idea restates the trend without a concrete mechanism" }],
    spend: { usedReads: 0, reservedReads: 0, capReads: 5_000, usedUsd: 0, capUsd: 25 },
    xDataAvailable: false,
    demandDataAvailable: true,
    generatedAt: Date.parse("2026-08-24T12:00:00Z"),
  });

  assert.match(digest, /X data was unavailable this week/);
  assert.match(digest, /11 signals across 4 days, accelerating/);
  assert.match(digest, /Moat: distribution/);
  assert.match(digest, /Build: 3\.0 days \(shell \+ auth \+ payments \+ 1 integration\)/);
  assert.match(digest, /accepted directly/);
  assert.match(digest, /Build estimates cover construction only; distribution is usually the bottleneck/);
  assert.match(digest, /Generic AI dashboard: idea restates/);
  assert.match(digest, /Owner-fit notes are an approximation/);
  assert.match(digest, /## DEMAND/);
  assert.match(digest, /Can anyone recommend a deployment preview tool/);
  assert.match(digest, /2h old, 1 replies/);
});

test("digest states plainly when zero ideas qualify", () => {
  const digest = renderTrendDigest({
    trends: [],
    demandAsks: [],
    ideas: [],
    rejections: [],
    spend: { usedReads: 0, reservedReads: 0, capReads: 5_000, usedUsd: 0, capUsd: 25 },
    xDataAvailable: false,
    demandDataAvailable: false,
    generatedAt: Date.parse("2026-08-24T12:00:00Z"),
  });

  assert.match(digest, /No trends or ideas qualified this week\./);
  assert.match(digest, /No ideas passed the deterministic gate this week\./);
  assert.match(digest, /Read spend: \$0\.00 of \$25\.00/);
  assert.match(digest, /Buyer-intent demand sources were unavailable this week/);
});

test("digest rounds read spend to cents instead of exposing floating-point precision", () => {
  const digest = renderTrendDigest({
    trends: [],
    demandAsks: [],
    ideas: [],
    rejections: [],
    spend: { usedReads: 167, reservedReads: 0, capReads: 5_000, usedUsd: 0.835, capUsd: 25 },
    xDataAvailable: false,
    demandDataAvailable: false,
    generatedAt: Date.parse("2026-08-24T12:00:00Z"),
  });

  assert.match(digest, /Read spend: \$0\.84 of \$25\.00/);
});

test("digest makes research rescues and unsuccessful research visible", () => {
  const digest = renderTrendDigest(sampleTrendDigestInput);

  assert.match(digest, /accepted directly/);
  assert.match(digest, /ACCEPTED AFTER RESEARCH/);
  assert.match(digest, /Research supplied: Research supplied a reported 42% buyer need/);
  assert.match(digest, /Generic AI dashboard: idea restates.*Research was attempted/);
});
