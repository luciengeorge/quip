import assert from "node:assert/strict";
import test from "node:test";

import { weeklyTrends } from "./weekly-trends.ts";

const scans = [
  "2026-08-18",
  "2026-08-19",
  "2026-08-20",
  "2026-08-21",
  "2026-08-22",
  "2026-08-23",
  "2026-08-24",
].map((day) => ({
  day,
  scannedAt: Date.parse(`${day}T08:20:00Z`),
  candidateCount: 1,
  sources: ["hn"],
  xSourceStatus: "unavailable" as const,
}));

test("weekly trends omit one-day spikes and retain repeated topics with a direction", () => {
  const trends = weeklyTrends(
    [
      { topicHash: "repeat", day: "2026-08-18", title: "Repeat signal", url: "https://example.com/repeat", source: "hn", count: 1 },
      { topicHash: "repeat", day: "2026-08-19", title: "Repeat signal", url: "https://example.com/repeat", source: "hn", count: 2 },
      { topicHash: "repeat", day: "2026-08-20", title: "Repeat signal", url: "https://example.com/repeat", source: "hn", count: 3 },
      { topicHash: "repeat", day: "2026-08-21", title: "Repeat signal", url: "https://example.com/repeat", source: "hn", count: 5 },
      { topicHash: "repeat", day: "2026-08-22", title: "Repeat signal", url: "https://example.com/repeat", source: "hn", count: 8 },
      { topicHash: "spike", day: "2026-08-21", title: "One day spike", url: "https://example.com/spike", source: "hn", count: 500 },
    ],
    scans,
    "2026-08-18",
    "2026-08-24",
  );

  assert.deepEqual(trends, [
    {
      topicHash: "repeat",
      title: "Repeat signal",
      url: "https://example.com/repeat",
      source: "hn",
      activeDays: 5,
      totalSignals: 19,
      direction: "accelerating",
    },
  ]);
});
