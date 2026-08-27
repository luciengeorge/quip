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
