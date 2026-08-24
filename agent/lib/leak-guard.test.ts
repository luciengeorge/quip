import assert from "node:assert/strict";
import test from "node:test";

import { containsLeak, leakGuardConfigFromEnv } from "./leak-guard.ts";

const config = {
  privateRepoNames: ["private-repository"],
  internalTerms: ["internal-project"],
};

test("containsLeak finds configured private repository names without hardcoded terms", () => {
  assert.deepEqual(containsLeak("Worked on private-repository today.", config), {
    leaked: true,
    reason: "private repository name",
  });
});

test("containsLeak finds configured employer-internal terms without hardcoded terms", () => {
  assert.deepEqual(containsLeak("internal-project shipped an update", config), {
    leaked: true,
    reason: "employer-internal term",
  });
});

test("containsLeak detects credential-shaped text", () => {
  for (const text of [
    "sk-abcdefghijklmnopqrstuvwxyz1234567890",
    "-----BEGIN PRIVATE KEY-----",
    "a".repeat(40),
    "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg==",
  ]) {
    assert.deepEqual(containsLeak(text), {
      leaked: true,
      reason: "credential-shaped text",
    });
  }
});

test("containsLeak is pure and leaves ordinary public text alone", () => {
  const text = "I learned a useful TypeScript narrowing trick today.";
  assert.deepEqual(containsLeak(text, config), { leaked: false });
  assert.deepEqual(containsLeak(text, config), { leaked: false });
});

test("leak guard configuration reads comma or newline separated environment values", () => {
  assert.deepEqual(
    leakGuardConfigFromEnv({
      LEAK_GUARD_PRIVATE_REPOS: "private-repository,another-private-repository",
      LEAK_GUARD_INTERNAL_TERMS: "internal-project\ninternal-service",
    }),
    {
      privateRepoNames: ["private-repository", "another-private-repository"],
      internalTerms: ["internal-project", "internal-service"],
    },
  );
});
