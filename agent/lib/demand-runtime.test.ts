import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate } from "./candidates.ts";
import {
  REDDIT_DEMAND_SOURCE_UNAVAILABLE_MESSAGE,
  STACKEXCHANGE_DEMAND_SOURCE_UNAVAILABLE_MESSAGE,
  RedditDemandSource,
  StackExchangeDemandSource,
  completeDemandSweep,
  demandSourceSet,
  prepareDemandSweep,
  verifiesDemandCandidatePlan,
} from "./demand-runtime.ts";
import type { DemandAsk, DemandCandidatePlan } from "./demand-scan.ts";
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
  const plans = new Map<
    string,
    {
      plan: DemandCandidatePlan;
      seal: string;
      expiresAt: number;
      status: "pending" | "completed" | "expired";
    }
  >();
  let planSequence = 0;
  return {
    client: {
      async recordDemandScan(scan: unknown) {
        scans.push(scan);
      },
      async storeDemandCandidatePlan(input: {
        plan: DemandCandidatePlan;
        seal: string;
        expiresAt: number;
      }) {
        const id = `plan-${++planSequence}`;
        plans.set(id, { ...input, plan: structuredClone(input.plan), status: "pending" });
        return id;
      },
      async loadDemandCandidatePlan(planId: string) {
        const plan = plans.get(planId);
        return plan ? { _id: planId, ...structuredClone(plan) } : null;
      },
      async completeDemandCandidatePlan(input: {
        planId: string;
        asks: DemandAsk[];
        completedAt: number;
      }) {
        const plan = plans.get(input.planId);
        if (!plan) return { status: "missing" as const, insertedCount: 0, skippedCount: 0, dedupedCount: 0 };
        if (plan.status !== "pending") {
          return {
            status: plan.status === "expired" ? "expired" as const : "already-completed" as const,
            insertedCount: 0,
            skippedCount: 0,
            dedupedCount: 0,
          };
        }
        stored.push(...input.asks);
        plan.status = "completed";
        return { status: "completed" as const, insertedCount: input.asks.length, skippedCount: 0, dedupedCount: 0 };
      },
    },
    scans,
    stored,
    plans,
  };
}

test("both absent demand sources preserve the scan and record each unavailability", async () => {
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
  assert.equal(sourceSet.stackExchangeSourceConfigured, false);
  assert.equal(sourceSet.sources.length, 0);
  assert.equal(fetch.calls.length, 0);
  assert.equal(prepared.sourceStatus, "unavailable");
  assert.equal(prepared.redditSourceStatus, "unavailable");
  assert.equal(prepared.stackExchangeSourceStatus, "unavailable");
  assert.ok(prepared.messages.includes(REDDIT_DEMAND_SOURCE_UNAVAILABLE_MESSAGE));
  assert.ok(prepared.messages.includes(STACKEXCHANGE_DEMAND_SOURCE_UNAVAILABLE_MESSAGE));
  assert.deepEqual(store.scans, [
    {
      day: "2026-08-27",
      scannedAt: now,
      candidateCount: 0,
      redditSourceStatus: "unavailable",
      stackExchangeSourceStatus: "unavailable",
    },
  ]);
  const digest = renderTrendDigest({
    trends: [],
    demandAsks: [],
    ideas: [],
    rejections: [],
    spend: { usedReads: 0, reservedReads: 0, capReads: 5_000, usedUsd: 0, capUsd: 25 },
    xSourceStatus: "not-configured",
    demandDataAvailable: false,
    generatedAt: now,
  });
  assert.match(digest, /Buyer-intent demand sources were unavailable this week/);
});

test("demand source setup keeps Reddit and Stack Exchange independent", () => {
  const fetch = fakeFetch(() => {
    throw new Error("source setup must not fetch");
  });
  const stackOnly = demandSourceSet({ env: { DEMAND_QUERIES: "recommend tool" }, fetchImpl: fetch.fetch });
  const redditOnly = demandSourceSet({
    env: {
      DEMAND_QUERIES: "recommend tool",
      STACKEXCHANGE_SITES: "invalid/site",
      REDDIT_CLIENT_ID: "client-id",
      REDDIT_CLIENT_SECRET: "client-secret",
      REDDIT_USER_AGENT: "server:quip:v1.0 (by /u/quip_owner)",
      REDDIT_SUBREDDITS: "SaaS",
    },
    fetchImpl: fetch.fetch,
  });
  const both = demandSourceSet({
    env: {
      DEMAND_QUERIES: "recommend tool",
      REDDIT_CLIENT_ID: "client-id",
      REDDIT_CLIENT_SECRET: "client-secret",
      REDDIT_USER_AGENT: "server:quip:v1.0 (by /u/quip_owner)",
      REDDIT_SUBREDDITS: "SaaS",
    },
    fetchImpl: fetch.fetch,
  });

  assert.deepEqual(
    [stackOnly.redditSourceConfigured, stackOnly.stackExchangeSourceConfigured, stackOnly.sources.length],
    [false, true, 1],
  );
  assert.ok(stackOnly.sources[0] instanceof StackExchangeDemandSource);
  assert.deepEqual(
    [redditOnly.redditSourceConfigured, redditOnly.stackExchangeSourceConfigured, redditOnly.sources.length],
    [true, false, 1],
  );
  assert.ok(redditOnly.sources[0] instanceof RedditDemandSource);
  assert.deepEqual(
    [both.redditSourceConfigured, both.stackExchangeSourceConfigured, both.sources.length],
    [true, true, 2],
  );
  assert.equal(fetch.calls.length, 0);
});

test("an available Stack Exchange source continues a sweep when Reddit is absent", async () => {
  const fetch = fakeFetch(() => ({
    body: {
      quota_remaining: 299,
      items: [
        {
          title: "Can anyone recommend a deployment preview tool?",
          body: "<p>I need one for a small team.</p>",
          owner: { display_name: "stack_buyer" },
          answer_count: 1,
          creation_date: 1_724_500_000,
          link: "https://softwarerecs.stackexchange.com/questions/1234/deploy-preview-tool",
          is_answered: false,
        },
      ],
    },
  }));
  const sourceSet = demandSourceSet({
    env: { DEMAND_QUERIES: "recommend tool", STACKEXCHANGE_SITES: "softwarerecs" },
    fetchImpl: fetch.fetch,
  });
  const store = memory();
  const prepared = await prepareDemandSweep({ sourceSet, memory: store.client, secret, now: () => now });

  assert.equal(prepared.sourceStatus, "available");
  assert.equal(prepared.redditSourceStatus, "unavailable");
  assert.equal(prepared.stackExchangeSourceStatus, "available");
  assert.equal(prepared.plan.candidates[0]?.source, "stackexchange");
  assert.deepEqual(store.scans, [
    {
      day: "2026-08-27",
      scannedAt: now,
      candidateCount: 1,
      redditSourceStatus: "unavailable",
      stackExchangeSourceStatus: "available",
    },
  ]);
});

test("an available Reddit source continues a sweep when Stack Exchange is absent", async () => {
  const fetch = fakeFetch((url) => {
    if (url === "https://www.reddit.com/api/v1/access_token") {
      return { body: { access_token: "access-token" } };
    }
    return {
      body: {
        data: {
          children: [
            {
              data: {
                title: "Can anyone recommend a deployment preview tool?",
                selftext: "I need one for a small team.",
                author: "reddit_buyer",
                created_utc: 1_724_500_000,
                num_comments: 1,
                permalink: "/r/SaaS/comments/example/deploy_preview/",
                subreddit: "SaaS",
              },
            },
          ],
        },
      },
    };
  });
  const sourceSet = demandSourceSet({
    env: {
      DEMAND_QUERIES: "recommend tool",
      STACKEXCHANGE_SITES: "invalid/site",
      REDDIT_CLIENT_ID: "client-id",
      REDDIT_CLIENT_SECRET: "client-secret",
      REDDIT_USER_AGENT: "server:quip:v1.0 (by /u/quip_owner)",
      REDDIT_SUBREDDITS: "SaaS",
    },
    fetchImpl: fetch.fetch,
  });
  const prepared = await prepareDemandSweep({ sourceSet, memory: memory().client, secret, now: () => now });

  assert.equal(prepared.sourceStatus, "available");
  assert.equal(prepared.redditSourceStatus, "available");
  assert.equal(prepared.stackExchangeSourceStatus, "unavailable");
  assert.equal(prepared.plan.candidates[0]?.source, "reddit");
});

test("both available demand sources contribute to one sealed sweep", async () => {
  const fetch = fakeFetch((url) => {
    if (url === "https://www.reddit.com/api/v1/access_token") {
      return { body: { access_token: "access-token" } };
    }
    if (new URL(url).origin === "https://oauth.reddit.com") {
      return {
        body: {
          data: {
            children: [
              {
                data: {
                  title: "Can anyone recommend a deployment preview tool?",
                  selftext: "I need one for a small team.",
                  author: "reddit_buyer",
                  created_utc: 1_724_500_000,
                  num_comments: 1,
                  permalink: "/r/SaaS/comments/example/deploy_preview/",
                  subreddit: "SaaS",
                },
              },
            ],
          },
        },
      };
    }
    return {
      body: {
        quota_remaining: 299,
        items: [
          {
            title: "What deployment preview tool should I use?",
            body: "<p>I need one for a small team.</p>",
            owner: { display_name: "stack_buyer" },
            answer_count: 1,
            creation_date: 1_724_500_000,
            link: "https://softwarerecs.stackexchange.com/questions/1234/deploy-preview-tool",
            is_answered: false,
          },
        ],
      },
    };
  });
  const sourceSet = demandSourceSet({
    env: {
      DEMAND_QUERIES: "recommend tool",
      STACKEXCHANGE_SITES: "softwarerecs",
      REDDIT_CLIENT_ID: "client-id",
      REDDIT_CLIENT_SECRET: "client-secret",
      REDDIT_USER_AGENT: "server:quip:v1.0 (by /u/quip_owner)",
      REDDIT_SUBREDDITS: "SaaS",
    },
    fetchImpl: fetch.fetch,
  });
  const prepared = await prepareDemandSweep({ sourceSet, memory: memory().client, secret, now: () => now });

  assert.equal(prepared.sourceStatus, "available");
  assert.equal(prepared.redditSourceStatus, "available");
  assert.equal(prepared.stackExchangeSourceStatus, "available");
  assert.deepEqual(
    prepared.plan.candidates.map((item) => item.source).sort(),
    ["reddit", "stackexchange"],
  );
});

test("a prepared plan is stored and loaded by id without a model-owned serialization round trip", async () => {
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
    stackExchangeSourceConfigured: false as const,
    classificationCap: 30,
  };

  const prepared = await prepareDemandSweep({ sourceSet, memory: store.client, secret, now: () => now });
  assert.ok(prepared.planId);
  const loaded = await store.client.loadDemandCandidatePlan(prepared.planId);

  assert.ok(loaded);
  assert.notStrictEqual(loaded.plan, prepared.plan);
  assert.deepEqual(loaded.plan, prepared.plan);
  assert.equal(verifiesDemandCandidatePlan(loaded.plan, secret, loaded.seal), true);
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
    stackExchangeSourceConfigured: false as const,
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
    planId: prepared.planId ?? "",
    classifications,
    memory: store.client,
    secret,
    now: () => now,
  });

  assert.equal(complete.asks.length, 1);
  assert.equal(store.stored.length, 1);

  const storedPlan = store.plans.get(prepared.planId ?? "");
  assert.ok(storedPlan);
  storedPlan.plan.candidates[0] = { ...item, author: "fabricated" };
  const tampered = await completeDemandSweep({
    planId: prepared.planId ?? "",
    classifications,
    memory: store.client,
    secret,
    now: () => now,
  });
  assert.deepEqual(tampered.asks, []);
  assert.deepEqual(store.stored.length, 1);
  assert.match(tampered.messages[0] ?? "", /seal was invalid/);
});

test("the same stored plan cannot persist buyer asks twice", async () => {
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
    stackExchangeSourceConfigured: false as const,
    classificationCap: 30,
  };
  const prepared = await prepareDemandSweep({ sourceSet, memory: store.client, secret, now: () => now });
  const item = prepared.plan.candidates[0];
  assert.ok(item);
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

  const first = await completeDemandSweep({
    planId: prepared.planId ?? "",
    classifications,
    memory: store.client,
    secret,
    now: () => now,
  });
  const second = await completeDemandSweep({
    planId: prepared.planId ?? "",
    classifications,
    memory: store.client,
    secret,
    now: () => now,
  });

  assert.equal(first.asks.length, 1);
  assert.deepEqual(second.asks, []);
  assert.equal(store.stored.length, 1);
  assert.match(second.messages[0] ?? "", /already completed/);
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
    stackExchangeSourceConfigured: false as const,
    classificationCap: 30,
  };
  const prepared = await prepareDemandSweep({ sourceSet, memory: store.client, secret, now: () => now });
  const item = prepared.plan.candidates[0];
  assert.ok(item);
  const result = await completeDemandSweep({
    planId: prepared.planId ?? "",
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
