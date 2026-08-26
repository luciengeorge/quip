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
