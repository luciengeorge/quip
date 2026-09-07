import assert from "node:assert/strict";
import test from "node:test";

import {
  DAILY_DEMAND_REPORT_MAX_ASKS,
  demandSourceLabel,
  flattenQuote,
  renderDailyDemandReport,
  renderDemandSweepNotice,
  type ReportableDemandAsk,
} from "../lib/demand-report.ts";
import { fakeApiKey } from "../lib/test-secrets.ts";

const generatedAt = Date.parse("2026-09-07T08:35:00Z");

function ask(overrides: Partial<ReportableDemandAsk> = {}): ReportableDemandAsk {
  return {
    quote: "Is there an app that does this?",
    permalink: "https://x.com/i/web/status/1",
    askedAt: generatedAt - 3 * 60 * 60 * 1_000,
    replyCount: 0,
    score: 80,
    subreddit: "x",
    source: "x",
    askedFor: "An app that does this.",
    ...overrides,
  };
}

test("each source is named as its own platform, not as a subreddit", () => {
  // The single shared line hardcoded r/${subreddit}, so Stack Exchange rendered as
  // r/softwarerecs and X as r/x, next to permalinks that plainly were not subreddits.
  assert.equal(demandSourceLabel({ source: "reddit", subreddit: "webdev" }), "r/webdev");
  assert.equal(
    demandSourceLabel({ source: "stackexchange", subreddit: "softwarerecs" }),
    "softwarerecs.stackexchange.com",
  );
  assert.equal(demandSourceLabel({ source: "x", subreddit: "x" }), "X");
});

test("a multi-line quote is collapsed so one ask stays one bullet", () => {
  const report = renderDailyDemandReport({
    day: "2026-09-07",
    asks: [ask({ quote: "Is there a tool for this?\nI have no idea how." })],
    candidateCount: 30,
    generatedAt,
  });
  assert.match(report, /"Is there a tool for this\? I have no idea how\."/);
  assert.equal(flattenQuote("a\n\n  b \t c "), "a b c");
});

test("asks are ranked by score and capped", () => {
  const asks = Array.from({ length: DAILY_DEMAND_REPORT_MAX_ASKS + 4 }, (_value, index) =>
    ask({ score: index, permalink: `https://x.com/i/web/status/${index}` }),
  );
  const report = renderDailyDemandReport({
    day: "2026-09-07",
    asks,
    candidateCount: 30,
    generatedAt,
  });
  const bullets = report.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(bullets.length, DAILY_DEMAND_REPORT_MAX_ASKS);
  assert.match(bullets[0] ?? "", /score 11/);
  assert.match(report, new RegExp(`${DAILY_DEMAND_REPORT_MAX_ASKS} of ${asks.length} asks shown`));
});

test("a quiet day says so explicitly instead of rendering nothing", () => {
  // Posting nothing is indistinguishable from the cron never firing. That ambiguity is the
  // whole reason this report exists.
  const report = renderDailyDemandReport({
    day: "2026-09-07",
    asks: [],
    candidateCount: 30,
    generatedAt,
  });
  assert.match(report, /No buyer-intent asks qualified today, from 30 candidates scanned\./);
  assert.match(report, /# Quip buyer intent, 2026-09-07/);
});

test("the report states that asks are evidence, not people to contact", () => {
  const report = renderDailyDemandReport({
    day: "2026-09-07",
    asks: [ask()],
    candidateCount: 12,
    generatedAt,
  });
  assert.match(report, /Evidence only\. These are not people to reply to\./);
});

test("a credential-shaped ask is dropped before it can be posted", () => {
  const secret = fakeApiKey();
  const leaky = ask({ quote: `is this key valid ${secret}`, permalink: "https://x.com/i/web/status/9" });
  const report = renderDailyDemandReport({
    day: "2026-09-07",
    asks: [leaky, ask()],
    candidateCount: 4,
    generatedAt,
  });
  assert.equal(report.includes(secret), false);
  assert.match(report, /1 of 1 asks shown/);
});

test("classifier and persistence notes are carried through", () => {
  const report = renderDailyDemandReport({
    day: "2026-09-07",
    asks: [ask()],
    candidateCount: 5,
    generatedAt,
    notes: ["Demand sweep dropped 2 non-verbatim classifier quotes."],
  });
  assert.match(report, /- Demand sweep dropped 2 non-verbatim classifier quotes\./);
});

test("a dark day renders a notice naming the reason", () => {
  assert.equal(
    renderDemandSweepNotice("2026-09-07", "no demand source was available"),
    "# Quip buyer intent, 2026-09-07\nNo demand scan today: no demand source was available.",
  );
});
