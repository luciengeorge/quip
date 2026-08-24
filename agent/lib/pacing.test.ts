import assert from "node:assert/strict";
import test from "node:test";

import { pacingBudget, shouldPostNow, type PacingInput } from "./pacing.ts";

const HOUR_MS = 60 * 60 * 1_000;
const now = Date.parse("2026-08-24T12:00:00.000Z");

function input(overrides: Partial<PacingInput> = {}): PacingInput {
  return {
    postsThisWeek: 1,
    weeklyTarget: 3,
    postsToday: 0,
    dailyCap: 2,
    lastPostAt: now - 2 * HOUR_MS,
    now,
    minGapMs: HOUR_MS,
    ...overrides,
  };
}

test("shouldPostNow stops at the weekly target before considering later rules", () => {
  const decision = shouldPostNow(input({ postsThisWeek: 3, postsToday: 2, lastPostAt: now }));

  assert.deepEqual(decision, { post: false, reason: "weekly target met" });
});

test("shouldPostNow stops at the daily cap", () => {
  const decision = shouldPostNow(input({ postsToday: 2 }));

  assert.deepEqual(decision, { post: false, reason: "daily cap hit" });
});

test("shouldPostNow stops when the minimum gap has not elapsed", () => {
  const decision = shouldPostNow(input({ lastPostAt: now - HOUR_MS + 1 }));

  assert.deepEqual(decision, { post: false, reason: "minimum gap not elapsed" });
});

test("shouldPostNow permits a post after all pacing rules clear", () => {
  assert.deepEqual(shouldPostNow(input()), { post: true, reason: "posting allowed" });
});

test("a fresh week has a full pacing budget and can post again", () => {
  assert.equal(pacingBudget({ postsThisWeek: 0, weeklyTarget: 3 }), 3);
  assert.equal(shouldPostNow(input({ postsThisWeek: 0, postsToday: 0, lastPostAt: null })).post, true);
});

test("the weekly target blocks a perfect candidate", () => {
  const perfectCandidate = { title: "An excellent, timely idea" };
  const decision = shouldPostNow(input({ postsThisWeek: 3 }));

  assert.equal(perfectCandidate.title.length > 0, true);
  assert.equal(decision.post, false);
  assert.equal(decision.reason, "weekly target met");
});

test("pacingBudget never returns a negative number", () => {
  assert.equal(pacingBudget({ postsThisWeek: 5, weeklyTarget: 3 }), 0);
});
