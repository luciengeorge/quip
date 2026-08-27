import assert from "node:assert/strict";
import test from "node:test";

import {
  demandSourceSet,
  prepareDemandSweep,
  type DemandScanRecord,
  type PreparedDemandSweep,
} from "../lib/demand-runtime.ts";
import { fakeFetch } from "../lib/test-fetch.ts";
import {
  demandSweepHandoffMessage,
  runDemandSweepSchedule,
} from "../schedules/demand-sweep.ts";

const now = Date.parse("2026-08-27T12:00:00Z");
const secret = "test-secret";

function demandMemory() {
  const scans: DemandScanRecord[] = [];
  return {
    memory: {
      async recordDemandScan(scan: DemandScanRecord) {
        scans.push(scan);
      },
    },
    scans,
  };
}

function stackExchangeEnv() {
  return {
    DEMAND_QUERIES: "recommend tool",
    STACKEXCHANGE_SITES: "softwarerecs",
  };
}

function stackExchangeCandidateResponse() {
  return {
    quota_remaining: 299,
    items: [
      {
        title: "Can anyone recommend a deployment preview tool?",
        body: "<p>I need one for a small team.</p>",
        owner: { display_name: "stack_buyer" },
        answer_count: 1,
        creation_date: 1_724_500_000,
        link: "https://softwarerecs.stackexchange.com/questions/1234/deploy-preview-tool",
        is_answered: false,
      },
    ],
  };
}

function stackExchangeSweep(store: ReturnType<typeof demandMemory>, body: unknown) {
  const fetch = fakeFetch((_url, _init) => ({ body }));
  let prepared: PreparedDemandSweep | null = null;
  return {
    fetch,
    getPrepared() {
      return prepared;
    },
    async run() {
      prepared = await prepareDemandSweep({
        sourceSet: demandSourceSet({ env: stackExchangeEnv(), fetchImpl: fetch.fetch }),
        memory: store.memory,
        secret,
        now: () => now,
        env: stackExchangeEnv(),
      });
      return prepared;
    },
  };
}

function handlerHarness() {
  const handoffs: Array<{ message: string; auth: unknown }> = [];
  const waits: Promise<unknown>[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  return {
    args: {
      to() {
        return {
          send(message: string, options: { auth: unknown }) {
            handoffs.push({ message, auth: options.auth });
            return Promise.resolve();
          },
        };
      },
      waitUntil(task: Promise<unknown>) {
        waits.push(task);
      },
      appAuth: { authenticator: "app", principalId: "eve:app", principalType: "runtime" },
    } as unknown as Parameters<typeof runDemandSweepSchedule>[0],
    handoffs,
    logs,
    logger: {
      log(...values: unknown[]) {
        logs.push(values.map(String).join(" "));
      },
      warn(...values: unknown[]) {
        warnings.push(values.map(String).join(" "));
      },
    },
    settle: async () => {
      await Promise.all(waits);
    },
    warnings,
  };
}

test("demand sweep handler records a row when both sources are unavailable", async () => {
  const store = demandMemory();
  const fetch = fakeFetch((_url, _init) => ({ body: {} }));
  const harness = handlerHarness();
  await runDemandSweepSchedule(harness.args, {
    env: { SLACK_CHANNEL_ID: "C123" },
    logger: harness.logger,
    runDemandSweep: async () =>
      await prepareDemandSweep({
        sourceSet: demandSourceSet({ env: {}, fetchImpl: fetch.fetch }),
        memory: store.memory,
        secret,
        now: () => now,
        env: {},
      }),
  });
  await harness.settle();

  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(store.scans, [
    {
      day: "2026-08-27",
      scannedAt: now,
      candidateCount: 0,
      redditSourceStatus: "unavailable",
      stackExchangeSourceStatus: "unavailable",
    },
  ]);
  assert.equal(harness.handoffs.length, 0);
  assert.match(harness.logs[0] ?? "", /status=unavailable/);
  assert.match(harness.logs[0] ?? "", /stored 0 candidates/);
});

test("demand sweep handler records a row when an available scan has zero candidates", async () => {
  const store = demandMemory();
  const sweep = stackExchangeSweep(store, { quota_remaining: 299, items: [] });
  const harness = handlerHarness();
  await runDemandSweepSchedule(harness.args, {
    env: { SLACK_CHANNEL_ID: "C123" },
    logger: harness.logger,
    runDemandSweep: sweep.run,
  });
  await harness.settle();

  assert.equal(sweep.fetch.calls.length, 1);
  assert.deepEqual(store.scans, [
    {
      day: "2026-08-27",
      scannedAt: now,
      candidateCount: 0,
      redditSourceStatus: "unavailable",
      stackExchangeSourceStatus: "available",
    },
  ]);
  assert.equal(harness.handoffs.length, 0);
  assert.match(harness.logs[0] ?? "", /status=available/);
  assert.match(harness.logs[0] ?? "", /stored 0 candidates/);
});

test("demand sweep handler records a row and skips handoff without SLACK_CHANNEL_ID", async () => {
  const store = demandMemory();
  const sweep = stackExchangeSweep(store, stackExchangeCandidateResponse());
  const harness = handlerHarness();
  await runDemandSweepSchedule(harness.args, {
    env: {},
    logger: harness.logger,
    runDemandSweep: sweep.run,
  });
  await harness.settle();

  assert.equal(sweep.fetch.calls.length, 1);
  assert.equal(store.scans[0]?.candidateCount, 1);
  assert.equal(harness.handoffs.length, 0);
  assert.ok(
    harness.warnings.some((warning) => warning.includes("SLACK_CHANNEL_ID is not set")),
  );
});

test("demand sweep handler hands off only available scans with candidates", async () => {
  const store = demandMemory();
  const sweep = stackExchangeSweep(store, stackExchangeCandidateResponse());
  const availableHarness = handlerHarness();
  await runDemandSweepSchedule(availableHarness.args, {
    env: { SLACK_CHANNEL_ID: "C123" },
    logger: availableHarness.logger,
    runDemandSweep: sweep.run,
  });
  await availableHarness.settle();

  assert.equal(availableHarness.handoffs.length, 1);
  const prepared = sweep.getPrepared();
  assert.ok(prepared);

  const unavailableHarness = handlerHarness();
  await runDemandSweepSchedule(unavailableHarness.args, {
    env: { SLACK_CHANNEL_ID: "C123" },
    logger: unavailableHarness.logger,
    runDemandSweep: async () => ({ ...prepared, sourceStatus: "unavailable" }),
  });
  await unavailableHarness.settle();

  assert.equal(unavailableHarness.handoffs.length, 0);
});

test("demand sweep handler catches a thrown sweep error without propagating", async () => {
  const harness = handlerHarness();
  await runDemandSweepSchedule(harness.args, {
    env: { SLACK_CHANNEL_ID: "C123" },
    logger: harness.logger,
    runDemandSweep: async () => {
      throw new Error("test sweep failure");
    },
  });
  await harness.settle();

  assert.equal(harness.handoffs.length, 0);
  assert.ok(
    harness.warnings.some((warning) => warning.includes("daily sweep failed cleanly")),
  );
});

test("demand sweep handler carries the sealed prepared value unchanged to the handoff", async () => {
  const store = demandMemory();
  const sweep = stackExchangeSweep(store, stackExchangeCandidateResponse());
  const harness = handlerHarness();
  await runDemandSweepSchedule(harness.args, {
    env: { SLACK_CHANNEL_ID: "C123" },
    logger: harness.logger,
    runDemandSweep: sweep.run,
  });
  await harness.settle();

  const prepared = sweep.getPrepared();
  const handoff = harness.handoffs[0];
  assert.ok(prepared);
  assert.ok(handoff);
  const prefix = "Prepared sweep:\n```json\n";
  const serialized = handoff.message.split(prefix)[1]?.split("\n```")[0];
  assert.equal(serialized, JSON.stringify(prepared));
  assert.deepEqual(JSON.parse(serialized ?? "null"), prepared);
  assert.equal(handoff.message, demandSweepHandoffMessage(prepared));
});
