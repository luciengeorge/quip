import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveDigestDelivery } from "./digest-delivery.ts";

test("digest delivery has its own opt-in and ignores DRY_RUN", () => {
  assert.deepEqual(
    resolveDigestDelivery(
      { DIGEST_DELIVERY_ENABLED: "true", DRY_RUN: "true" },
      "C123",
    ),
    { mode: "slack", channelId: "C123" },
  );
  assert.deepEqual(
    resolveDigestDelivery(
      { DIGEST_DELIVERY_ENABLED: "false", DRY_RUN: "false" },
      "C123",
    ),
    { mode: "log", reason: "DIGEST_DELIVERY_ENABLED is false" },
  );

  const source = readFileSync(new URL("./digest-delivery.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /DRY_RUN/);
  const schedule = readFileSync(new URL("../schedules/weekly-trend-digest.ts", import.meta.url), "utf8");
  assert.doesNotMatch(schedule, /DRY_RUN/);
});
