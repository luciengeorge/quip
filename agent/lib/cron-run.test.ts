import assert from "node:assert/strict";
import test from "node:test";

import { recordScheduleRun } from "../lib/cron-run.ts";
import type { CronRunRecord } from "../lib/memory.ts";

function recordingMemory() {
  const rows: CronRunRecord[] = [];
  return {
    rows,
    memory: {
      async recordCronRun(run: CronRunRecord) {
        rows.push(run);
        return `run-${rows.length}`;
      },
    },
  };
}

function silentLogger() {
  const warnings: string[] = [];
  return { warnings, logger: { warn: (message: string) => warnings.push(message) } };
}

test("a delivered run is recorded once as dispatched", async () => {
  const { rows, memory } = recordingMemory();
  await recordScheduleRun("demand-sweep", async () => true, {
    memory,
    now: () => 1000,
  });
  assert.deepEqual(rows, [{ schedule: "demand-sweep", firedAt: 1000, dispatched: true }]);
});

test("a run that fires but delivers nothing is still recorded, as undispatched", async () => {
  const { rows, memory } = recordingMemory();
  await recordScheduleRun("weekly-trend-digest", async () => false, {
    memory,
    now: () => 2000,
  });
  // The distinction this table exists for: the schedule ran, so silence is not a missed cron.
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.dispatched, false);
  assert.equal(rows[0]?.schedule, "weekly-trend-digest");
});

test("a throwing body is recorded before the error propagates", async () => {
  const { rows, memory } = recordingMemory();
  await assert.rejects(
    recordScheduleRun(
      "daily-trend-scan",
      async () => {
        throw new Error("scan exploded");
      },
      { memory, now: () => 3000 },
    ),
    /scan exploded/,
  );
  assert.deepEqual(rows, [{ schedule: "daily-trend-scan", firedAt: 3000, dispatched: false }]);
});

test("a failing recording warns instead of failing the schedule", async () => {
  const { warnings, logger } = silentLogger();
  let ran = false;
  await recordScheduleRun(
    "demand-sweep",
    async () => {
      ran = true;
      return true;
    },
    {
      memory: {
        async recordCronRun() {
          throw new Error("convex unreachable");
        },
      },
      logger,
    },
  );
  assert.equal(ran, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /could not record demand-sweep/);
});

test("firedAt is captured before the body runs, not after", async () => {
  const { rows, memory } = recordingMemory();
  let clock = 500;
  await recordScheduleRun(
    "demand-sweep",
    async () => {
      clock = 9999;
      return true;
    },
    { memory, now: () => clock },
  );
  assert.equal(rows[0]?.firedAt, 500);
});
