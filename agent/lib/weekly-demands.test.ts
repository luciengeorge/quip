import assert from "node:assert/strict";
import test from "node:test";

import type { DemandAskRecord, DemandScanRecord } from "./memory.ts";
import { weeklyDemandAsks, weeklyDemandEvidence } from "./weekly-demands.ts";

const scans: DemandScanRecord[] = [
  "2026-08-18",
  "2026-08-19",
  "2026-08-20",
  "2026-08-21",
  "2026-08-22",
  "2026-08-23",
  "2026-08-24",
].map((day) => ({
  day,
  scannedAt: Date.parse(`${day}T08:35:00Z`),
  candidateCount: 1,
  redditSourceStatus: "available",
}));

function ask(day: string, author: string, score: number): DemandAskRecord {
  return {
    topicHash: "deployment-preview",
    day,
    quote: "Can anyone recommend a deployment preview tool?",
    permalink: `https://www.reddit.com/r/SaaS/comments/${day}/${author}/`,
    author,
    askedAt: Date.parse(`${day}T10:00:00Z`),
    replyCount: 1,
    score,
    subreddit: "SaaS",
    source: "reddit",
    askedFor: "deployment preview tooling for small teams",
  };
}

test("weekly demand evidence carries reply and distinct-asker numbers plus a measured direction", () => {
  const asks = scans.flatMap((scan, dayIndex) =>
    Array.from({ length: dayIndex + 1 }, (_, askIndex) =>
      ask(scan.day, `buyer_${dayIndex}_${askIndex}`, dayIndex * 10 + askIndex),
    ),
  );
  const evidence = weeklyDemandEvidence(asks, scans, "2026-08-18", "2026-08-24");

  assert.deepEqual(evidence, [
    {
      topicHash: "deployment-preview",
      askedFor: "deployment preview tooling for small teams",
      permalink: "https://www.reddit.com/r/SaaS/comments/2026-08-24/buyer_6_6/",
      distinctAskers: 28,
      totalReplies: 28,
      activeDays: 7,
      askCount: 28,
      direction: "accelerating",
    },
  ]);
  assert.equal(weeklyDemandAsks(asks)[0]?.score, 66);
});
