import assert from "node:assert/strict";
import test from "node:test";

import { selectCandidates } from "./select.ts";
import { topicHash, type RecentItem } from "./dedupe.ts";
import type { Candidate } from "./candidates.ts";

const now = Date.parse("2026-08-24T12:00:00.000Z");

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    source: "trending",
    title: "A useful public software idea",
    url: "https://example.com/useful",
    context: "Public context for a considered post.",
    timestamp: now,
    ...overrides,
  };
}

test("selectCandidates ranks source tiers before freshness", () => {
  const selected = selectCandidates(
    [
      candidate({ source: "trending", title: "Trending", url: "https://example.com/trending", timestamp: now + 5 }),
      candidate({ source: "hn", title: "HN", url: "https://example.com/hn", timestamp: now + 4 }),
      candidate({ source: "rss", title: "RSS", url: "https://example.com/rss", timestamp: now + 6 }),
      candidate({ source: "github", title: "GitHub", url: "https://example.com/github", timestamp: now + 2 }),
      candidate({ source: "drop", title: "Drop", url: "https://example.com/drop", timestamp: now }),
    ],
    { budget: 5, recent: [] },
  );

  assert.deepEqual(selected.map((item) => item.title), ["Drop", "GitHub", "RSS", "HN", "Trending"]);
});

test("selectCandidates prefers fresher candidates within a source tier", () => {
  const selected = selectCandidates(
    [
      candidate({ source: "github", title: "Older", url: "https://example.com/older", timestamp: now - 1 }),
      candidate({ source: "github", title: "Newer", url: "https://example.com/newer", timestamp: now }),
    ],
    { budget: 2, recent: [] },
  );

  assert.deepEqual(selected.map((item) => item.title), ["Newer", "Older"]);
});

test("selectCandidates removes recent duplicates before applying its budget", () => {
  const duplicate = candidate({ source: "drop", title: "Duplicate" });
  const recent: RecentItem[] = [
    { url: duplicate.url, topicHash: topicHash(duplicate), postedAt: now - 1 },
  ];

  const selected = selectCandidates(
    [duplicate, candidate({ source: "github", title: "Fresh", url: "https://example.com/fresh" })],
    { budget: 1, recent },
  );

  assert.deepEqual(selected.map((item) => item.title), ["Fresh"]);
});

test("selectCandidates returns an empty list when no candidate clears the bar", () => {
  const selected = selectCandidates(
    [candidate({ title: "", context: "" })],
    { budget: 1, recent: [] },
  );

  assert.deepEqual(selected, []);
});

test("selectCandidates returns an empty list for a quiet cycle", () => {
  assert.deepEqual(selectCandidates([], { budget: 1, recent: [] }), []);
});
