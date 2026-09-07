import assert from "node:assert/strict";
import test from "node:test";

import type { CronRunRecord } from "../lib/memory.ts";
import { runDailyTrendScanSchedule } from "../schedules/daily-trend-scan.ts";
import { runWeeklyTrendDigestSchedule } from "../schedules/weekly-trend-digest.ts";

/**
 * The schedule names here are the eve names derived from the file paths. They are asserted
 * literally because a renamed file silently changes what a later "did it fire?" query looks for.
 */

function recordingMemory() {
  const rows: CronRunRecord[] = [];
  return {
    rows,
    cronRun: {
      memory: {
        async recordCronRun(run: CronRunRecord) {
          rows.push(run);
          return `run-${rows.length}`;
        },
      },
      now: () => 4242,
    },
  };
}

function quietLogger() {
  return { log: () => {}, warn: () => {} };
}

function digestArgs(sends: string[]) {
  return {
    to() {
      return {
        send(message: string) {
          sends.push(message);
          return Promise.resolve();
        },
      };
    },
    waitUntil() {},
    appAuth: { authenticator: "app", principalId: "eve:app", principalType: "runtime" },
  } as unknown as Parameters<typeof runWeeklyTrendDigestSchedule>[0];
}

function weeklyContext() {
  return {
    startDay: "2026-09-01",
    endDay: "2026-09-07",
    generatedAt: Date.parse("2026-09-07T18:35:00Z"),
    trends: [],
    demandAsks: [],
    demandEvidence: [],
    spend: { usedReads: 0, reservedReads: 0, capReads: 5000, spentUsd: 0, budgetUsd: 25 },
    xSourceStatus: "contributed",
    demandDataAvailable: true,
  } as unknown as Awaited<ReturnType<Parameters<typeof runWeeklyTrendDigestSchedule>[1] extends
    { loadContext?: infer L } ? NonNullable<L> : never>>;
}

test("daily trend scan records a dispatched run under its schedule name", async () => {
  const { rows, cronRun } = recordingMemory();
  await runDailyTrendScanSchedule({
    logger: quietLogger(),
    runScan: async () => ({ observations: [], candidates: [], messages: [], xSourceStatus: "contributed" }) as never,
    cronRun,
  });
  assert.deepEqual(rows, [{ schedule: "daily-trend-scan", firedAt: 4242, dispatched: true }]);
});

test("a failed trend scan is recorded as fired but undispatched", async () => {
  const { rows, cronRun } = recordingMemory();
  await runDailyTrendScanSchedule({
    logger: quietLogger(),
    runScan: async () => {
      throw new Error("exa down");
    },
    cronRun,
  });
  assert.deepEqual(rows, [{ schedule: "daily-trend-scan", firedAt: 4242, dispatched: false }]);
});

test("weekly digest records a dispatched run when it sends to Slack", async () => {
  const { rows, cronRun } = recordingMemory();
  const sends: string[] = [];
  await runWeeklyTrendDigestSchedule(digestArgs(sends), {
    env: { DIGEST_DELIVERY_ENABLED: "true", SLACK_CHANNEL_ID: "C123" },
    logger: quietLogger(),
    loadContext: async () => weeklyContext(),
    cronRun,
  });
  assert.equal(sends.length, 1);
  assert.deepEqual(rows, [{ schedule: "weekly-trend-digest", firedAt: 4242, dispatched: true }]);
});

test("weekly digest with delivery disabled is recorded as fired but undispatched", async () => {
  const { rows, cronRun } = recordingMemory();
  const sends: string[] = [];
  await runWeeklyTrendDigestSchedule(digestArgs(sends), {
    env: { DIGEST_DELIVERY_ENABLED: "false", SLACK_CHANNEL_ID: "C123" },
    logger: quietLogger(),
    loadContext: async () => weeklyContext(),
    cronRun,
  });
  // This is the exact case that was unanswerable on 2026-09-07: nothing posted, and no way to
  // tell whether the cron had fired at all.
  assert.equal(sends.length, 0);
  assert.deepEqual(rows, [{ schedule: "weekly-trend-digest", firedAt: 4242, dispatched: false }]);
});

test("weekly digest records a run even when the context fails to load", async () => {
  const { rows, cronRun } = recordingMemory();
  const sends: string[] = [];
  await runWeeklyTrendDigestSchedule(digestArgs(sends), {
    env: { DIGEST_DELIVERY_ENABLED: "true", SLACK_CHANNEL_ID: "C123" },
    logger: quietLogger(),
    loadContext: async () => {
      throw new Error("convex unreachable");
    },
    cronRun,
  });
  assert.equal(sends.length, 0);
  assert.deepEqual(rows, [{ schedule: "weekly-trend-digest", firedAt: 4242, dispatched: false }]);
});
