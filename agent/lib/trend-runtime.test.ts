import assert from "node:assert/strict";
import test from "node:test";

import { XSearchSource } from "./x.ts";
import { trendSourceSet, weeklyTrendContext } from "./trend-runtime.ts";
import { fakeFetch } from "./test-fetch.ts";

const budget = {
  async reserveXReads() {
    return { allowed: false, reservationId: null, remainingReads: 0 };
  },
  async settleXReads() {},
};

test("trend source setup omits X without credentials but retains the free source set", () => {
  const fetch = fakeFetch(() => {
    throw new Error("source setup must not fetch");
  });
  const sources = trendSourceSet({ env: {}, budget, fetchImpl: fetch.fetch });

  assert.equal(sources.xSourceConfigured, false);
  assert.equal(sources.sources.some((source) => source instanceof XSearchSource), false);
  assert.equal(sources.sources.length, 2);
  assert.deepEqual(sources.initialMessages, [
    "X data was unavailable for this scan; free sources remain available.",
  ]);
  assert.equal(fetch.calls.length, 0);
});

test("trend source setup wires the existing budget-gated X source when credentials appear", () => {
  const sources = trendSourceSet({
    env: {
      EXA_API_KEY: "exa-key",
      EXA_TREND_QUERY: "developer tools",
      RSS_FEED_URLS: "https://feeds.example.com/dev.xml",
      X_BEARER_TOKEN: "x-token",
      X_TREND_QUERY: "developer tools",
    },
    budget,
  });

  assert.equal(sources.xSourceConfigured, true);
  assert.equal(sources.sources.some((source) => source instanceof XSearchSource), true);
  assert.deepEqual(sources.initialMessages, []);
  assert.equal(sources.sources.length, 5);
});

test("weekly context keeps demand asks separate from trends and exposes their availability", async () => {
  const context = await weeklyTrendContext(
    {
      async trendObservationsInRange() {
        return [];
      },
      async trendScansInRange() {
        return [];
      },
      async getXReadSpend() {
        return {
          month: "2026-08",
          usedReads: 0,
          reservedReads: 0,
          capReads: 5_000,
          usedUsd: 0,
          capUsd: 25,
        };
      },
      async demandAsksInRange() {
        return [
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
        ];
      },
      async demandScansInRange() {
        return [
          {
            day: "2026-08-24",
            scannedAt: Date.parse("2026-08-24T08:35:00Z"),
            candidateCount: 1,
            redditSourceStatus: "available" as const,
          },
        ];
      },
    },
    () => Date.parse("2026-08-24T12:00:00Z"),
  );

  assert.deepEqual(context.trends, []);
  assert.equal(context.demandAsks.length, 1);
  assert.equal(context.demandEvidence.length, 0);
  assert.equal(context.demandDataAvailable, true);
});
