import assert from "node:assert/strict";
import test from "node:test";

import type { ReportableDemandAsk } from "../lib/demand-report.ts";
import type { DemandThemeRecord } from "../lib/demand-themes.ts";
import {
  renderDemandVerdictReport,
  VERDICT_MAX_SUMMARY_CHARS,
} from "../lib/demand-verdict-report.ts";
import { fakeApiKey } from "../lib/test-secrets.ts";

const generatedAt = Date.parse("2026-09-08T08:35:00Z");

function theme(overrides: Partial<DemandThemeRecord> = {}): DemandThemeRecord {
  return {
    themeKey: "llm-token-spend-visibility",
    label: "LLM token spend visibility",
    permalinks: ["https://x.com/i/web/status/1", "https://x.com/i/web/status/2"],
    askers: ["one", "two"],
    firstSeenAt: generatedAt - 6 * 24 * 60 * 60 * 1_000,
    lastSeenAt: generatedAt,
    ...overrides,
  };
}

function judged(overrides: Partial<DemandThemeRecord> = {}): DemandThemeRecord {
  return theme({
    researchedAt: generatedAt,
    researchedAskerCount: 2,
    incumbentCoverage: "partial",
    incumbents: [{ name: "Helicone", covers: "API key usage, not subscription seats" }],
    researchSummary: "Founders on subscription plans cannot see where usage goes.",
    sources: [{ url: "https://example.com/helicone", claim: "Helicone meters API keys" }],
    buildDays: 4,
    buildBreakdown: "shell + integration",
    verdict: "worth-a-look",
    ...overrides,
  });
}

function ask(): ReportableDemandAsk {
  return {
    quote: "is there a tool that shows where all those tokens are actually going?",
    permalink: "https://x.com/i/web/status/3",
    askedAt: generatedAt - 3 * 60 * 60 * 1_000,
    replyCount: 0,
    score: 93,
    subreddit: "x",
    source: "x",
    askedFor: "A tool that shows LLM token spend.",
  };
}

function render(overrides: Partial<Parameters<typeof renderDemandVerdictReport>[0]> = {}) {
  return renderDemandVerdictReport({
    day: "2026-09-08",
    themes: [],
    newAsks: [],
    candidateCount: 30,
    windowAskCount: 40,
    generatedAt,
    ...overrides,
  });
}

test("a verdict leads with the conclusion and shows what produced it", () => {
  const report = render({ themes: [judged()], newAsks: [ask()] });
  assert.match(report, /\*\*LLM token spend visibility\*\* WORTH A LOOK/);
  assert.match(report, /2 asks, 2 askers, over 6 days\./);
  assert.match(report, /Incumbents: Helicone \(API key usage, not subscription seats\)\./);
  assert.match(report, /Build: ~4 days \(shell \+ integration\)\./);
  assert.match(report, /https:\/\/example\.com\/helicone/);
});

test("an already-solved theme is labelled as such", () => {
  const report = render({ themes: [judged({ incumbentCoverage: "covers", verdict: "already-solved" })] });
  assert.match(report, /ALREADY SOLVED/);
  assert.doesNotMatch(report, /WORTH A LOOK/);
});

test("a theme below the bar is tracked, never given a verdict", () => {
  const report = render({ themes: [theme({ askers: ["one"], permalinks: ["a"] })] });
  assert.match(report, /Nothing has reached 2 distinct askers in 14 days yet\./);
  assert.match(report, /## Tracked, not yet judged \(1\)/);
  assert.match(report, /LLM token spend visibility \(1\)/);
});

test("verdicts are ordered by how many people asked", () => {
  const report = render({
    themes: [
      judged({ themeKey: "small", label: "Small theme", askers: ["one", "two"] }),
      judged({ themeKey: "big", label: "Big theme", askers: ["one", "two", "three"] }),
    ],
  });
  assert.ok(report.indexOf("Big theme") < report.indexOf("Small theme"));
});

test("no incumbents found is stated rather than left blank", () => {
  const report = render({ themes: [judged({ incumbentCoverage: "none", incumbents: [] })] });
  assert.match(report, /Incumbents: none found\./);
});

test("the report still says asks are evidence, not people to contact", () => {
  const report = render({ newAsks: [ask()] });
  assert.match(report, /Evidence only\. These are not people to reply to\./);
  assert.match(report, /## New asks today \(1\)/);
  assert.match(report, /40 asks tracked over 14 days/);
});

test("a quiet day is explicit in every section", () => {
  const report = render();
  assert.match(report, /Nothing has reached 2 distinct askers/);
  assert.match(report, /Nothing tracked\./);
  assert.match(report, /## New asks today \(0\)/);
  assert.match(report, /- None\./);
});

test("a credential-shaped theme is dropped before it can be posted", () => {
  const secret = fakeApiKey();
  const report = render({
    themes: [judged({ themeKey: "leaky", label: "Leaky", researchSummary: `key ${secret}` }), judged()],
  });
  assert.equal(report.includes(secret), false);
  assert.doesNotMatch(report, /Leaky/);
});

test("an already-solved theme omits the build estimate", () => {
  // How long it takes to build something that already exists is not a decision input.
  const report = render({
    themes: [judged({ incumbentCoverage: "covers", verdict: "already-solved", buildDays: 6 })],
  });
  assert.doesNotMatch(report, /Build: ~/);
  assert.match(report, /ALREADY SOLVED/);
});

test("an unpriceable component list shows no estimate rather than zero days", () => {
  // "~0 days" reads as trivial to build when it actually means the components could not be priced.
  const report = render({ themes: [judged({ buildDays: undefined, buildBreakdown: undefined })] });
  assert.doesNotMatch(report, /Build:/);
  assert.match(report, /WORTH A LOOK/);
});

test("a long research summary is clipped on a word boundary", () => {
  const long = `${"Existing tools meter API keys rather than subscription seats. ".repeat(12)}`;
  const report = render({ themes: [judged({ researchSummary: long })] });
  const line = report.split("\n").find((l) => l.startsWith("Existing tools")) ?? "";
  assert.ok(line.length <= VERDICT_MAX_SUMMARY_CHARS + 4, `summary line was ${line.length}`);
  assert.match(line, /\.\.\.$/);
  assert.doesNotMatch(line, / \.\.\.$/);
});

test("a long incumbent list is capped with a count of the rest", () => {
  const many = Array.from({ length: 8 }, (_v, i) => ({ name: `Product ${i}`, covers: "does the thing" }));
  const report = render({ themes: [judged({ incumbents: many })] });
  assert.match(report, /Incumbents: Product 0 \(does the thing\); Product 1 \(does the thing\); Product 2 \(does the thing\), and 5 more\./);
  assert.doesNotMatch(report, /Product 7/);
});

test("a zero-day estimate is treated as no estimate", () => {
  // The cheapest real build is the base app shell at one day, so zero can only mean unpriceable.
  // Stored rows already carried a zero, so the renderer has to reject the value, not just absence.
  const report = render({ themes: [judged({ buildDays: 0, buildBreakdown: "unrecognised components" })] });
  assert.doesNotMatch(report, /Build:/);
  assert.doesNotMatch(report, /unrecognised/);
});
