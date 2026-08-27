import assert from "node:assert/strict";
import test from "node:test";

import {
  DEMAND_OPEN_DOOR_MAX_AGE_MS,
  DEMAND_OPEN_DOOR_MAX_REPLY_COUNT,
  demandAskScore,
} from "./demand-score.ts";

const now = Date.parse("2026-08-27T12:00:00Z");

test("recent asks with few replies rank above old asks with many replies", () => {
  const recentAndQuiet = demandAskScore(
    { askedAt: now - 24 * 60 * 60 * 1_000, replyCount: 1 },
    now,
  );
  const oldAndAnswered = demandAskScore(
    { askedAt: now - 14 * 24 * 60 * 60 * 1_000, replyCount: 20 },
    now,
  );

  assert.ok(recentAndQuiet > oldAndAnswered);
  assert.equal(oldAndAnswered, 0);
});

test("demand score pins the explicit recency and reply boundaries", () => {
  assert.equal(
    demandAskScore({ askedAt: now - DEMAND_OPEN_DOOR_MAX_AGE_MS, replyCount: 0 }, now),
    40,
  );
  assert.equal(
    demandAskScore({ askedAt: now, replyCount: DEMAND_OPEN_DOOR_MAX_REPLY_COUNT }, now),
    60,
  );
  assert.equal(
    demandAskScore(
      {
        askedAt: now - DEMAND_OPEN_DOOR_MAX_AGE_MS,
        replyCount: DEMAND_OPEN_DOOR_MAX_REPLY_COUNT,
      },
      now,
    ),
    0,
  );
});
