import assert from "node:assert/strict";
import test from "node:test";

import {
  dailyPostCap,
  isDryRun,
  isPostingEnabled,
  minimumPostingGapMs,
  weeklyTarget,
  type Logger,
} from "./config.ts";

type Env = Record<string, string | undefined>;

function warningLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    logger: { warn: (message) => warnings.push(message) },
    warnings,
  };
}

test("posting controls default to the safe state", () => {
  const { logger, warnings } = warningLogger();

  assert.equal(isDryRun({}, logger), true);
  assert.equal(isPostingEnabled({}, logger), false);
  assert.equal(weeklyTarget({}, logger), 10);
  assert.equal(dailyPostCap({}, logger), 2);
  assert.equal(minimumPostingGapMs({}, logger), 4 * 60 * 60 * 1_000);
  assert.deepEqual(warnings, []);
});

test("canonical boolean settings are accepted", () => {
  const { logger, warnings } = warningLogger();
  const env: Env = { DRY_RUN: "false", POSTING_ENABLED: "true" };

  assert.equal(isDryRun(env, logger), false);
  assert.equal(isPostingEnabled(env, logger), true);
  assert.deepEqual(warnings, []);
});

test("malformed boolean settings fall back safely and warn", () => {
  for (const [name, value] of [
    ["empty string", ""],
    ["whitespace", "   "],
    ["zero", "0"],
    ["non-numeric", "not-a-boolean"],
  ]) {
    const dryRun = warningLogger();
    const posting = warningLogger();

    assert.equal(isDryRun({ DRY_RUN: value }, dryRun.logger), true, name);
    assert.equal(
      isPostingEnabled({ POSTING_ENABLED: value }, posting.logger),
      false,
      name,
    );
    assert.match(dryRun.warnings[0] ?? "", /DRY_RUN/);
    assert.match(posting.warnings[0] ?? "", /POSTING_ENABLED/);
  }
});

for (const setting of [
  {
    name: "TWEET_WEEKLY_TARGET",
    read: weeklyTarget,
    expectedDefault: 10,
    valid: "15",
    expectedValid: 15,
  },
  {
    name: "TWEET_DAILY_CAP",
    read: dailyPostCap,
    expectedDefault: 2,
    valid: "3",
    expectedValid: 3,
  },
  {
    name: "TWEET_MIN_GAP_HOURS",
    read: (env: Env, logger: Logger) => minimumPostingGapMs(env, logger) / 3_600_000,
    expectedDefault: 4,
    valid: "6",
    expectedValid: 6,
  },
] as const) {
  test(`${setting.name} accepts a positive integer`, () => {
    const { logger, warnings } = warningLogger();

    assert.equal(setting.read({ [setting.name]: setting.valid }, logger), setting.expectedValid);
    assert.deepEqual(warnings, []);
  });

  for (const [caseName, value] of [
    ["empty string", ""],
    ["whitespace", "   "],
    ["zero", "0"],
    ["negative", "-1"],
    ["non-numeric", "not-a-number"],
  ]) {
    test(`${setting.name} rejects ${caseName}`, () => {
      const { logger, warnings } = warningLogger();

      assert.equal(
        setting.read({ [setting.name]: value }, logger),
        setting.expectedDefault,
      );
      assert.match(warnings[0] ?? "", new RegExp(setting.name));
    });
  }
}
