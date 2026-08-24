import assert from "node:assert/strict";
import test from "node:test";

import { isDuplicate, topicHash, type RecentItem } from "./dedupe.ts";
import type { Candidate } from "./candidates.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const now = Date.parse("2026-08-24T12:00:00.000Z");

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    source: "rss",
    title: "Quip launches a useful TypeScript helper",
    url: "https://example.com/tools/quip?source=rss",
    context: "A public release note.",
    timestamp: now,
    ...overrides,
  };
}

test("topicHash is stable across title casing, whitespace, and URL query parameters", () => {
  const first = candidate();
  const second = candidate({
    title: "  QUIP launches the useful typescript helper  ",
    url: "https://EXAMPLE.com/tools/quip?source=hn",
  });

  assert.equal(topicHash(first), topicHash(second));
});

test("isDuplicate collapses an identical URL even when titles differ", () => {
  const item = candidate();
  const recent: RecentItem[] = [
    { url: item.url, topicHash: "other-topic", postedAt: now - DAY_MS },
  ];

  assert.equal(isDuplicate(candidate({ title: "A completely different title" }), recent), true);
});

test("isDuplicate collapses the same tool discussed inside the default window", () => {
  const item = candidate();
  const recent: RecentItem[] = [
    {
      url: "https://example.com/tools/quip?source=hn",
      topicHash: topicHash(item),
      postedAt: now - 13 * DAY_MS,
    },
  ];

  assert.equal(isDuplicate(item, recent), true);
});

test("isDuplicate allows the same topic after the default window", () => {
  const item = candidate();
  const recent: RecentItem[] = [
    {
      url: "https://example.com/tools/quip?source=hn",
      topicHash: topicHash(item),
      postedAt: now - 14 * DAY_MS - 1,
    },
  ];

  assert.equal(isDuplicate(item, recent), false);
});

test("isDuplicate does not collide unrelated items", () => {
  const recent: RecentItem[] = [
    {
      url: "https://other.example.com/tools/other",
      topicHash: topicHash(
        candidate({
          title: "Another project has a different release",
          url: "https://other.example.com/tools/other",
        }),
      ),
      postedAt: now - DAY_MS,
    },
  ];

  assert.equal(isDuplicate(candidate(), recent), false);
});
