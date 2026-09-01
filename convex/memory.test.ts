/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const token = "test-secret";

function observation(overrides: Partial<{ title: string; url: string }> = {}) {
  return {
    topicHash: "topic-hash",
    day: "2026-08-24",
    title: "A valid observation",
    url: "https://example.com/valid",
    source: "exa",
    count: 1,
    ...overrides,
  };
}

function demandAsk(overrides: Partial<{ permalink: string; quote: string }> = {}) {
  return {
    topicHash: "demand-topic-hash",
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
    ...overrides,
  };
}

function demandCandidatePlan() {
  return {
    day: "2026-08-24",
    candidates: [
      {
        source: "reddit" as const,
        title: "Can anyone recommend a deployment preview tool?",
        url: "https://www.reddit.com/r/SaaS/comments/example/buyer_ask/",
        context: "I need one for a small team.",
        timestamp: Date.parse("2026-08-24T10:00:00Z"),
        author: "buyer_one",
        replyCount: 1,
        subreddit: "SaaS",
        sourceText: "Can anyone recommend a deployment preview tool?\nI need one for a small team.",
      },
    ],
    cap: 30,
    droppedCount: 0,
    duplicateCount: 0,
    leakyCount: 0,
    cappedCount: 0,
  };
}

test("upsertTrendObservations skips invalid rows and returns the skipped count", async () => {
  vi.stubEnv("APP_SHARED_SECRET", token);
  const t = convexTest(schema, modules);

  const result = await t.mutation(api.memory.upsertTrendObservations, {
    token,
    observations: [observation(), observation({ title: " " })],
  });
  const rows = await t.query(api.memory.trendObservationsInRange, {
    token,
    startDay: "2026-08-24",
    endDay: "2026-08-24",
  });

  expect(result).toEqual({ skippedCount: 1 });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject(observation());
  vi.unstubAllEnvs();
});

test("upsertTrendObservations still throws for a duplicate valid row in one batch", async () => {
  vi.stubEnv("APP_SHARED_SECRET", token);
  const t = convexTest(schema, modules);
  const item = observation();

  await expect(
    t.mutation(api.memory.upsertTrendObservations, {
      token,
      observations: [item, item],
    }),
  ).rejects.toThrow("Duplicate trend observation in batch");
  vi.unstubAllEnvs();
});

test("demand asks are secret-gated, skip malformed rows, and dedupe permalinks across scans", async () => {
  vi.stubEnv("APP_SHARED_SECRET", token);
  const t = convexTest(schema, modules);
  const ask = demandAsk();

  await expect(
    t.mutation(api.memory.upsertDemandAsks, { token: "wrong-secret", asks: [ask] }),
  ).rejects.toThrow();
  const first = await t.mutation(api.memory.upsertDemandAsks, {
    token,
    asks: [ask, demandAsk({ quote: " " })],
  });
  const second = await t.mutation(api.memory.upsertDemandAsks, { token, asks: [ask] });
  const rows = await t.query(api.memory.demandAsksInRange, {
    token,
    startDay: "2026-08-24",
    endDay: "2026-08-24",
  });

  expect(first).toEqual({ insertedCount: 1, skippedCount: 1, dedupedCount: 0 });
  expect(second).toEqual({ insertedCount: 0, skippedCount: 0, dedupedCount: 1 });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject(ask);
  vi.unstubAllEnvs();
});

test("a stored demand plan is atomically completed once", async () => {
  vi.stubEnv("APP_SHARED_SECRET", token);
  const t = convexTest(schema, modules);
  const planId = await t.mutation(api.memory.storeDemandCandidatePlan, {
    token,
    plan: demandCandidatePlan(),
    seal: "a".repeat(64),
    expiresAt: Date.now() + 60_000,
  });
  const loaded = await t.query(api.memory.loadDemandCandidatePlan, { token, planId });
  const first = await t.mutation(api.memory.completeDemandCandidatePlan, {
    token,
    planId,
    asks: [demandAsk()],
    completedAt: Date.now(),
  });
  const second = await t.mutation(api.memory.completeDemandCandidatePlan, {
    token,
    planId,
    asks: [demandAsk()],
    completedAt: Date.now(),
  });
  const asks = await t.query(api.memory.demandAsksInRange, {
    token,
    startDay: "2026-08-24",
    endDay: "2026-08-24",
  });

  expect(loaded).toMatchObject({ status: "pending", plan: demandCandidatePlan() });
  expect(first).toEqual({ status: "completed", insertedCount: 1, skippedCount: 0, dedupedCount: 0 });
  expect(second).toEqual({ status: "already-completed", insertedCount: 0, skippedCount: 0, dedupedCount: 0 });
  expect(asks).toHaveLength(1);
  vi.unstubAllEnvs();
});

test("trend scan records distinguish X configuration, empty contribution, and contribution", async () => {
  vi.stubEnv("APP_SHARED_SECRET", token);
  const t = convexTest(schema, modules);
  const scan = {
    scannedAt: Date.parse("2026-08-24T08:20:00Z"),
    candidateCount: 1,
    sources: ["hn"],
  };
  for (const [index, xSourceStatus] of ([
    "not-configured",
    "configured-empty",
    "contributed",
  ] as const).entries()) {
    const day = `2026-08-${String(24 + index).padStart(2, "0")}`;
    await t.mutation(api.memory.recordTrendScan, { token, ...scan, day, xSourceStatus });
  }
  const rows = await t.query(api.memory.trendScansInRange, {
    token,
    startDay: "2026-08-24",
    endDay: "2026-08-26",
  });

  expect(rows.map((row) => row.xSourceStatus)).toEqual([
    "not-configured",
    "configured-empty",
    "contributed",
  ]);
  vi.unstubAllEnvs();
});

test("demand scans are secret-gated and retain each demand source status", async () => {
  vi.stubEnv("APP_SHARED_SECRET", token);
  const t = convexTest(schema, modules);
  const scan = {
    day: "2026-08-24",
    scannedAt: Date.parse("2026-08-24T08:35:00Z"),
    candidateCount: 1,
    redditSourceStatus: "unavailable" as const,
    stackExchangeSourceStatus: "available" as const,
  };

  await expect(t.mutation(api.memory.recordDemandScan, { token: "wrong-secret", ...scan })).rejects.toThrow();
  await t.mutation(api.memory.recordDemandScan, { token, ...scan });
  const rows = await t.query(api.memory.demandScansInRange, {
    token,
    startDay: "2026-08-24",
    endDay: "2026-08-24",
  });

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject(scan);
  vi.unstubAllEnvs();
});
