import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate, CandidateSource } from "./candidates.ts";
import { topicHash } from "./dedupe.ts";
import {
  X_SOURCE_UNAVAILABLE_MESSAGE,
  observationsForDay,
  runDailyTrendScan,
  type TrendScanMemory,
} from "./trend-scan.ts";

function memory(): { client: TrendScanMemory; observations: unknown[]; scans: unknown[] } {
  const observations: unknown[] = [];
  const scans: unknown[] = [];
  return {
    client: {
      async upsertTrendObservations(items) {
        observations.push(...items);
        return { skippedCount: 0 };
      },
      async recordTrendScan(scan) {
        scans.push(scan);
      },
    },
    observations,
    scans,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    source: "hn",
    title: "A repeatable developer trend",
    url: "https://example.com/trend",
    context: "120 comments",
    timestamp: Date.parse("2026-08-24T10:00:00Z"),
    ...overrides,
  };
}

test("an absent X source keeps free sources running and records its unavailability", async () => {
  const freeSource: CandidateSource = {
    async gather() {
      return {
        candidates: [
          {
            source: "hn",
            title: "A repeatable developer trend",
            url: "https://example.com/trend",
            context: "120 comments",
            timestamp: Date.parse("2026-08-24T10:00:00Z"),
          },
        ],
        messages: [],
      };
    },
  };
  const store = memory();

  const result = await runDailyTrendScan({
    sources: [freeSource],
    memory: store.client,
    now: () => Date.parse("2026-08-24T12:00:00Z"),
    initialMessages: [X_SOURCE_UNAVAILABLE_MESSAGE],
    xSourceConfigured: false,
  });

  assert.equal(result.candidates.length, 1);
  assert.ok(result.messages.includes(X_SOURCE_UNAVAILABLE_MESSAGE));
  assert.deepEqual(store.observations, [
    {
      topicHash: topicHash({
        title: "A repeatable developer trend",
        url: "https://example.com/trend",
      }),
      day: "2026-08-24",
      title: "A repeatable developer trend",
      url: "https://example.com/trend",
      source: "hn",
      count: 1,
    },
  ]);
  assert.deepEqual(store.scans, [
    {
      day: "2026-08-24",
      scannedAt: Date.parse("2026-08-24T12:00:00Z"),
      candidateCount: 1,
      sources: ["hn"],
      xSourceStatus: "unavailable",
    },
  ]);
});

test("observationsForDay drops blank title, URL, and source candidates", () => {
  const result = observationsForDay(
    [
      candidate(),
      candidate({ title: "  " }),
      candidate({ url: "\n" }),
      candidate({ source: " " as Candidate["source"] }),
    ],
    "2026-08-24",
  );

  assert.equal(result.droppedCount, 3);
  assert.deepEqual(result.observations, [
    {
      topicHash: topicHash({
        title: "A repeatable developer trend",
        url: "https://example.com/trend",
      }),
      day: "2026-08-24",
      title: "A repeatable developer trend",
      url: "https://example.com/trend",
      source: "hn",
      count: 1,
    },
  ]);
});

test("a ten-candidate batch persists nine valid observations and reports one drop", async () => {
  const source: CandidateSource = {
    async gather() {
      return {
        candidates: Array.from({ length: 10 }, (_, index) =>
          candidate({
            title: index === 4 ? "" : `Trend ${index}`,
            url: `https://example.com/trend-${index}`,
          }),
        ),
        messages: [],
      };
    },
  };
  const store = memory();

  const result = await runDailyTrendScan({
    sources: [source],
    memory: store.client,
    now: () => Date.parse("2026-08-24T12:00:00Z"),
    xSourceConfigured: true,
  });

  assert.equal(store.observations.length, 9);
  assert.equal(result.observations.length, 9);
  assert.ok(result.messages.includes("Trend scan dropped 1 invalid candidates before persistence."));
});

test("a failed observation write still records the completed scan", async () => {
  const scans: unknown[] = [];
  const store: TrendScanMemory = {
    async upsertTrendObservations() {
      throw new Error("write failed");
    },
    async recordTrendScan(scan) {
      scans.push(scan);
    },
  };
  const source: CandidateSource = {
    async gather() {
      return { candidates: [candidate()], messages: [] };
    },
  };

  const result = await runDailyTrendScan({
    sources: [source],
    memory: store,
    now: () => Date.parse("2026-08-24T12:00:00Z"),
    xSourceConfigured: true,
  });

  assert.deepEqual(scans, [
    {
      day: "2026-08-24",
      scannedAt: Date.parse("2026-08-24T12:00:00Z"),
      candidateCount: 1,
      sources: ["hn"],
      xSourceStatus: "available",
    },
  ]);
  assert.ok(
    result.messages.includes("Trend observation persistence failed; scan record was still written."),
  );
});

test("the scan reports rows skipped by observation persistence", async () => {
  const store: TrendScanMemory = {
    async upsertTrendObservations() {
      return { skippedCount: 1 };
    },
    async recordTrendScan() {},
  };
  const source: CandidateSource = {
    async gather() {
      return { candidates: [candidate()], messages: [] };
    },
  };

  const result = await runDailyTrendScan({
    sources: [source],
    memory: store,
    now: () => Date.parse("2026-08-24T12:00:00Z"),
    xSourceConfigured: true,
  });

  assert.ok(result.messages.includes("Trend observation persistence skipped 1 invalid rows."));
});
