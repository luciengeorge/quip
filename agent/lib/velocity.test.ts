import assert from "node:assert/strict";
import test from "node:test";

import { calculateVelocity, type DailyCount, type TrendWindow } from "./velocity.ts";

const completeWeek: TrendWindow = {
  startDay: "2026-08-18",
  endDay: "2026-08-24",
  scannedDays: [
    "2026-08-18",
    "2026-08-19",
    "2026-08-20",
    "2026-08-21",
    "2026-08-22",
    "2026-08-23",
    "2026-08-24",
  ],
};

function observations(counts: readonly number[]): DailyCount[] {
  return counts
    .map((count, index) => ({ day: completeWeek.scannedDays[index] ?? "", count }))
    .filter((item) => item.count > 0);
}

test("velocity rejects a single-day spike even when its count is large", () => {
  const result = calculateVelocity(observations([0, 0, 0, 500, 0, 0, 0]), completeWeek);

  assert.equal(result.isTrend, false);
  assert.equal(result.reason, "single-day-spike");
  assert.equal(result.direction, null);
});

test("velocity requires more than one day of scan history", () => {
  const result = calculateVelocity(
    [{ day: "2026-08-24", count: 10 }],
    { startDay: "2026-08-24", endDay: "2026-08-24", scannedDays: ["2026-08-24"] },
  );

  assert.equal(result.isTrend, false);
  assert.equal(result.reason, "insufficient-history");
});

test("velocity refuses to infer direction across a missed daily scan", () => {
  const result = calculateVelocity(
    [
      { day: "2026-08-18", count: 3 },
      { day: "2026-08-20", count: 9 },
    ],
    {
      startDay: "2026-08-18",
      endDay: "2026-08-20",
      scannedDays: ["2026-08-18", "2026-08-20"],
    },
  );

  assert.equal(result.isTrend, false);
  assert.equal(result.reason, "incomplete-series");
});

test("velocity reports cooling when a topic appears then vanishes", () => {
  const result = calculateVelocity(observations([8, 6, 3, 0, 0, 0, 0]), completeWeek);

  assert.equal(result.isTrend, true);
  assert.equal(result.direction, "cooling");
  assert.deepEqual(result.counts, [8, 6, 3, 0, 0, 0, 0]);
});

test("velocity reports acceleration from repeated daily observations", () => {
  const result = calculateVelocity(observations([1, 1, 2, 3, 5, 8, 13]), completeWeek);

  assert.equal(result.isTrend, true);
  assert.equal(result.direction, "accelerating");
});
