import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate } from "./candidates.ts";
import {
  REDDIT_DEMAND_SOURCE_UNAVAILABLE_MESSAGE,
  completeDemandSweep,
  demandSourceSet,
  prepareDemandSweep,
  verifiesDemandCandidatePlan,
} from "./demand-runtime.ts";
import { fakeFetch } from "./test-fetch.ts";
import { renderTrendDigest } from "./trend-digest.ts";
import { fakeApiKey } from "./test-secrets.ts";

const now = Date.parse("2026-08-27T12:00:00Z");
const secret = "test-secret";

function candidate(): Candidate {
  return {
    source: "reddit",
    title: "Can anyone recommend a deployment preview tool?",
    url: "https://www.reddit.com/r/SaaS/comments/post/buyer_ask/",
    context: "Can anyone recommend a deployment preview tool?\nI need one for a small team.",
    timestamp: now - 24 * 60 * 60 * 1_000,
    author: "buyer_one",
    replyCount: 1,
    subreddit: "SaaS",
    sourceText: "Can anyone recommend a deployment preview tool?\nI need one for a small team.",
  } as Candidate;
}

function memory() {
  const scans: unknown[] = [];
  const stored: unknown[] = [];
  return {
    client: {
      async recordDemandScan(scan: unknown) {
        scans.push(scan);
      },
      async upsertDemandAsks(asks: unknown[]) {
        stored.push(...asks);
        return { insertedCount: asks.length, skippedCount: 0, dedupedCount: 0 };
      },
    },
    scans,
    stored,
  };
}

test("absent Reddit credentials omit the source, preserve the scan, and record unavailability", async () => {
  const fetch = fakeFetch(() => {
    throw new Error("unconfigured Reddit source must not fetch");
  });
  const sourceSet = demandSourceSet({ env: {}, fetchImpl: fetch.fetch });
  const store = memory();
  const prepared = await prepareDemandSweep({
    sourceSet,
    memory: store.client,
    secret,
    now: () => now,
    env: {},
  });

  assert.equal(sourceSet.redditSourceConfigured, false);
  assert.equal(sourceSet.sources.length, 0);
  assert.equal(fetch.calls.length, 0);
  assert.equal(prepared.sourceStatus, "unavailable");
  assert.ok(prepared.messages.includes(REDDIT_DEMAND_SOURCE_UNAVAILABLE_MESSAGE));
  assert.deepEqual(store.scans, [
    {
      day: "2026-08-27",
      scannedAt: now,
      candidateCount: 0,
      redditSourceStatus: "unavailable",
    },
  ]);
  const digest = renderTrendDigest({
    trends: [],
    demandAsks: [],
    ideas: [],
    rejections: [],
    spend: { usedReads: 0, reservedReads: 0, capReads: 5_000, usedUsd: 0, capUsd: 25 },
    xDataAvailable: false,
    demandDataAvailable: false,
    generatedAt: now,
  });
  assert.match(digest, /Reddit buyer-intent demand sweep was unavailable this week/);
});

test("sealed candidates can be classified once and source tampering fails closed", async () => {
  const store = memory();
  const sourceSet = {
    sources: [
      {
        async gather() {
          return { candidates: [candidate()], messages: [] };
        },
      },
    ],
    initialMessages: [],
    redditSourceConfigured: true as const,
    classificationCap: 30,
  };
  const prepared = await prepareDemandSweep({ sourceSet, memory: store.client, secret, now: () => now });
  const item = prepared.plan.candidates[0];
  assert.ok(item);
  assert.equal(verifiesDemandCandidatePlan(prepared.plan, secret, prepared.seal), true);
  const classifications = [
    {
      buyerAsk: true,
      author: item.author,
      askedAt: item.timestamp,
      quote: item.title,
      replyCount: item.replyCount,
      permalink: item.url,
      subreddit: item.subreddit,
      askedFor: "deployment preview tooling for small teams",
    },
  ];
  const complete = await completeDemandSweep({
    prepared,
    classifications,
    memory: store.client,
    secret,
    now: () => now,
  });

  assert.equal(complete.asks.length, 1);
  assert.equal(store.stored.length, 1);

  prepared.plan.candidates[0] = { ...item, author: "fabricated" };
  const tampered = await completeDemandSweep({
    prepared,
    classifications,
    memory: store.client,
    secret,
    now: () => now,
  });
  assert.deepEqual(tampered.asks, []);
  assert.deepEqual(store.stored.length, 1);
  assert.match(tampered.messages[0] ?? "", /seal was invalid/);
});

test("leaky classifier text never reaches demand storage", async () => {
  const store = memory();
  const sourceSet = {
    sources: [
      {
        async gather() {
          return { candidates: [candidate()], messages: [] };
        },
      },
    ],
    initialMessages: [],
    redditSourceConfigured: true as const,
    classificationCap: 30,
  };
  const prepared = await prepareDemandSweep({ sourceSet, memory: store.client, secret, now: () => now });
  const item = prepared.plan.candidates[0];
  assert.ok(item);
  const result = await completeDemandSweep({
    prepared,
    classifications: [
      {
        buyerAsk: true,
        author: item.author,
        askedAt: item.timestamp,
        quote: item.title,
        replyCount: item.replyCount,
        permalink: item.url,
        subreddit: item.subreddit,
        askedFor: fakeApiKey(),
      },
    ],
    memory: store.client,
    secret,
    now: () => now,
  });

  assert.deepEqual(result.asks, []);
  assert.deepEqual(store.stored, []);
  assert.match(result.messages[0] ?? "", /leak guard/);
});
