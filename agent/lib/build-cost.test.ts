import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILD_COMPONENT_COSTS,
  calculateBuildEstimate,
  formatBuildBreakdown,
} from "./build-cost.ts";

test("build cost includes the base shell and every declared component", () => {
  const estimate = calculateBuildEstimate([
    "auth",
    "payments",
    "third-party API integration",
  ]);

  assert.deepEqual(estimate, {
    ok: true,
    buildDays: 3,
    breakdown: "shell + auth + payments + 1 integration",
  });
  assert.equal(BUILD_COMPONENT_COSTS["base app shell"], 1);
});

test("build cost rejects missing components and components outside the fixed taxonomy", () => {
  assert.deepEqual(calculateBuildEstimate([]), {
    ok: false,
    reason: "at least one build component must be declared",
  });
  assert.deepEqual(calculateBuildEstimate(["quantum computer"]), {
    ok: false,
    reason: "build component is not in the fixed taxonomy: quantum computer",
  });
});

test("build cost rejects a computed estimate beyond the two-week cap", () => {
  const estimate = calculateBuildEstimate([
    "regulated or compliance work",
    "mobile app",
    "two-sided marketplace",
    "manual ops bootstrap",
    "data pipeline or ETL",
  ]);

  assert.deepEqual(estimate, {
    ok: false,
    reason: "computed build estimate exceeds the 14 day cap (16.0 days)",
  });
});

test("build breakdown groups repeated integrations so the estimate is auditable", () => {
  assert.equal(
    formatBuildBreakdown(["third-party API integration", "third-party API integration"]),
    "shell + 2 integrations",
  );
});
