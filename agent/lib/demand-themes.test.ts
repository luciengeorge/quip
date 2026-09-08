import assert from "node:assert/strict";
import test from "node:test";

import {
  DEMAND_THEME_MAX_ASKS_PER_RUN,
  DEMAND_THEME_MAX_NEW_PER_RUN,
  DEMAND_THEME_RESEARCH_TTL_MS,
  demandThemeKey,
  distinctAskerCount,
  meetsVerdictBar,
  themesNeedingResearch,
  unassignedAsks,
  validateThemeAssignments,
  verdictFor,
  type DemandThemeRecord,
} from "../lib/demand-themes.ts";

const now = Date.parse("2026-09-08T08:35:00Z");

function theme(overrides: Partial<DemandThemeRecord> = {}): DemandThemeRecord {
  return {
    themeKey: "llm-token-spend-visibility",
    label: "LLM token spend visibility",
    permalinks: ["https://x.com/i/web/status/1"],
    askers: ["one"],
    firstSeenAt: now - 3 * 24 * 60 * 60 * 1_000,
    lastSeenAt: now,
    ...overrides,
  };
}

test("the same label always produces the same key", () => {
  // Themes only accumulate if a want maps to one key across days.
  assert.equal(demandThemeKey("LLM token spend visibility"), "llm-token-spend-visibility");
  assert.equal(demandThemeKey("  LLM token spend visibility!  "), "llm-token-spend-visibility");
  assert.equal(demandThemeKey("!!!"), "unlabelled");
});

test("an ask outside this run cannot be assigned", () => {
  const { assignments, messages } = validateThemeAssignments(
    [{ permalink: "https://x.com/i/web/status/999", newLabel: "Injected theme" }],
    ["https://x.com/i/web/status/1"],
    [],
  );
  assert.deepEqual(assignments, []);
  assert.match(messages.join(" "), /asks outside this run/);
});

test("an existing theme key is joined rather than duplicated", () => {
  const { assignments } = validateThemeAssignments(
    [{ permalink: "https://x.com/i/web/status/1", themeKey: "llm-token-spend-visibility" }],
    ["https://x.com/i/web/status/1"],
    [{ themeKey: "llm-token-spend-visibility", label: "LLM token spend visibility" }],
  );
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0]?.isNew, false);
  assert.equal(assignments[0]?.label, "LLM token spend visibility");
});

test("a new label that slugs onto an existing theme joins it", () => {
  // Otherwise a rephrased label silently forks the theme and the recurrence count never grows.
  const { assignments } = validateThemeAssignments(
    [{ permalink: "https://x.com/i/web/status/1", newLabel: "LLM Token Spend Visibility" }],
    ["https://x.com/i/web/status/1"],
    [{ themeKey: "llm-token-spend-visibility", label: "LLM token spend visibility" }],
  );
  assert.equal(assignments[0]?.themeKey, "llm-token-spend-visibility");
  assert.equal(assignments[0]?.isNew, false);
  assert.equal(assignments[0]?.label, "LLM token spend visibility");
});

test("one ask cannot be assigned twice", () => {
  const { assignments, messages } = validateThemeAssignments(
    [
      { permalink: "https://x.com/i/web/status/1", newLabel: "First" },
      { permalink: "https://x.com/i/web/status/1", newLabel: "Second" },
    ],
    ["https://x.com/i/web/status/1"],
    [],
  );
  assert.equal(assignments.length, 1);
  assert.match(messages.join(" "), /duplicate assignments/);
});

test("new themes per run are capped", () => {
  const permalinks = Array.from({ length: DEMAND_THEME_MAX_NEW_PER_RUN + 3 }, (_v, i) => `https://x.com/i/web/status/${i}`);
  const { assignments, messages } = validateThemeAssignments(
    permalinks.map((permalink, i) => ({ permalink, newLabel: `Theme number ${i}` })),
    permalinks,
    [],
  );
  assert.equal(assignments.length, DEMAND_THEME_MAX_NEW_PER_RUN);
  assert.match(messages.join(" "), /per run cap/);
});

test("recurrence counts people, not posts", () => {
  // One person asking five times is one person, and a verdict rests on the number of people.
  const repeated = theme({ askers: ["one", "one", "one"], permalinks: ["a", "b", "c"] });
  assert.equal(distinctAskerCount(repeated), 1);
  assert.equal(meetsVerdictBar(repeated), false);
  assert.equal(meetsVerdictBar(theme({ askers: ["one", "two"] })), true);
});

test("research is spent only on themes that cleared the bar and are not cached", () => {
  const belowBar = theme({ themeKey: "below", askers: ["one"] });
  const fresh = theme({ themeKey: "fresh", askers: ["one", "two"] });
  const cached = theme({
    themeKey: "cached",
    askers: ["one", "two"],
    researchedAt: now - 1_000,
    researchedAskerCount: 2,
  });
  const needing = themesNeedingResearch([belowBar, fresh, cached], now);
  assert.deepEqual(needing.map((t) => t.themeKey), ["fresh"]);
});

test("a theme is re-researched when the evidence grows or the answer goes stale", () => {
  const grown = theme({
    themeKey: "grown",
    askers: ["one", "two", "three"],
    researchedAt: now - 1_000,
    researchedAskerCount: 2,
  });
  const stale = theme({
    themeKey: "stale",
    askers: ["one", "two"],
    researchedAt: now - DEMAND_THEME_RESEARCH_TTL_MS - 1,
    researchedAskerCount: 2,
  });
  assert.deepEqual(
    themesNeedingResearch([grown, stale], now).map((t) => t.themeKey),
    ["grown", "stale"],
  );
});

test("the verdict follows the coverage rule, not the researcher's tone", () => {
  assert.equal(verdictFor("covers"), "already-solved");
  assert.equal(verdictFor("partial"), "worth-a-look");
  assert.equal(verdictFor("none"), "worth-a-look");
});

test("grouping works from every unthemed ask in the window, not just today's", () => {
  // 73 asks predated this feature. Offering only the current run's asks would leave them
  // permanently ungrouped, and a run that failed part way would strand its asks the same way.
  const asks = [
    { permalink: "a" },
    { permalink: "b" },
    { permalink: "c" },
  ];
  const themed = [{ permalinks: ["b"] }];
  assert.deepEqual(
    unassignedAsks(asks, themed).map((ask) => ask.permalink),
    ["a", "c"],
  );
});

test("the per-run grouping set is capped so a backlog drains instead of flooding", () => {
  const asks = Array.from({ length: DEMAND_THEME_MAX_ASKS_PER_RUN + 15 }, (_v, i) => ({
    permalink: `p${i}`,
  }));
  assert.equal(unassignedAsks(asks, []).length, DEMAND_THEME_MAX_ASKS_PER_RUN);
});
