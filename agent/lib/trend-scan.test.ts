import assert from "node:assert/strict";
import test from "node:test";

import type { CandidateSource } from "./candidates.ts";
import { topicHash } from "./dedupe.ts";
import {
  X_SOURCE_UNAVAILABLE_MESSAGE,
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
      },
      async recordTrendScan(scan) {
        scans.push(scan);
      },
    },
    observations,
    scans,
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
