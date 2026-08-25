import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { RSS_MAX_ENTRIES_PER_FEED, RssSource, parseFeed } from "./rss.ts";
import { fakeFetch } from "./test-fetch.ts";

const fixtureUrl = new URL("../../fixtures/sample-dev-feed.xml", import.meta.url);
const NOW = Date.parse("2026-08-25T12:00:00Z");
const FEED_URL = "https://feeds.example.com/dev.xml";

interface FeedItem {
  title: string;
  timestamp?: string;
}

function rss(items: readonly FeedItem[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>${items
    .map(
      (item, index) => `<item>
  <title>${item.title}</title>
  <link>https://example.com/${index}</link>
  <description>Context for ${item.title}</description>
  ${item.timestamp ? `<pubDate>${item.timestamp}</pubDate>` : ""}
</item>`,
    )
    .join("\n")}</channel></rss>`;
}

async function gather(xml: string) {
  const fetch = fakeFetch((url) => {
    assert.equal(url, FEED_URL);
    return { body: xml };
  });
  const source = new RssSource({
    feedUrls: [FEED_URL],
    fetchImpl: fetch.fetch,
    now: () => NOW,
  });

  const result = await source.gather();

  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(fetch.calls.map((call) => call.url), [FEED_URL]);
  return result;
}

test("parseFeed maps a saved RSS sample without a parser dependency", async () => {
  const xml = await readFile(fixtureUrl, "utf8");

  assert.deepEqual(parseFeed(xml), [
    {
      title: "Release & notes",
      url: "https://example.com/release",
      context: "A small release.",
      timestamp: Date.parse("Wed, 20 Aug 2026 10:00:00 GMT"),
    },
    {
      title: "Second post",
      url: "https://example.com/second",
      context: "Plain text",
      timestamp: Date.parse("Wed, 20 Aug 2026 11:00:00 GMT"),
    },
  ]);
});

test("RSS source fetches every configured feed and normalises entries", async () => {
  const xml = await readFile(fixtureUrl, "utf8");
  const fetch = fakeFetch(() => ({ body: xml }));
  const source = new RssSource({
    feedUrls: ["https://feeds.example.com/dev.xml", "https://feeds.example.com/second.xml"],
    fetchImpl: fetch.fetch,
    now: () => NOW,
  });

  const result = await source.gather();

  assert.deepEqual(
    fetch.calls.map((call) => call.url),
    ["https://feeds.example.com/dev.xml", "https://feeds.example.com/second.xml"],
  );
  assert.equal(result.candidates.length, 4);
  assert.equal(result.candidates[0]?.source, "rss");
  assert.deepEqual(result.messages, []);
});

test("RSS drops entries older than the recency window", async () => {
  const result = await gather(
    rss([{ title: "Old post", timestamp: "2026-08-18T11:59:59Z" }]),
  );

  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.messages, [
    "RSS source dropped 1 entries older than 7 days, 0 entries without a usable date, and 0 entries due to the per-feed cap.",
  ]);
});

test("RSS keeps entries inside the recency window", async () => {
  const timestamp = "2026-08-18T12:00:00Z";
  const result = await gather(rss([{ title: "Recent post", timestamp }]));

  assert.deepEqual(result.candidates, [
    {
      source: "rss",
      title: "Recent post",
      url: "https://example.com/0",
      context: "Context for Recent post",
      timestamp: Date.parse(timestamp),
    },
  ]);
  assert.deepEqual(result.messages, []);
});

test("RSS drops entries without a parseable date", async () => {
  const xml = rss([{ title: "Dateless post" }]);
  assert.ok(Number.isNaN(parseFeed(xml)[0]?.timestamp));

  const result = await gather(xml);

  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.messages, [
    "RSS source dropped 0 entries older than 7 days, 1 entries without a usable date, and 0 entries due to the per-feed cap.",
  ]);
});

test("RSS caps each feed and keeps its newest entries", async () => {
  const result = await gather(
    rss(
      Array.from({ length: 100 }, (_, index) => ({
        title: `Entry ${index}`,
        timestamp: new Date(NOW - (99 - index) * 60_000).toISOString(),
      })),
    ),
  );

  assert.equal(result.candidates.length, RSS_MAX_ENTRIES_PER_FEED);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.title),
    Array.from({ length: RSS_MAX_ENTRIES_PER_FEED }, (_, index) => `Entry ${99 - index}`),
  );
  assert.deepEqual(result.messages, [
    "RSS source dropped 0 entries older than 7 days, 0 entries without a usable date, and 75 entries due to the per-feed cap.",
  ]);
});

test("RSS reports all drop counts", async () => {
  const recentEntries = Array.from({ length: RSS_MAX_ENTRIES_PER_FEED + 1 }, (_, index) => ({
    title: `Recent ${index}`,
    timestamp: new Date(NOW - index * 60_000).toISOString(),
  }));
  const result = await gather(
    rss([
      { title: "Old post", timestamp: "2026-08-01T12:00:00Z" },
      { title: "Dateless post" },
      ...recentEntries,
    ]),
  );

  assert.equal(result.candidates.length, RSS_MAX_ENTRIES_PER_FEED);
  assert.deepEqual(result.messages, [
    "RSS source dropped 1 entries older than 7 days, 1 entries without a usable date, and 1 entries due to the per-feed cap.",
  ]);
});

test("RSS excludes historical archive entries from a feed spanning 2017 to today", async () => {
  const result = await gather(
    rss([
      { title: "Next.js 2.0", timestamp: "2017-03-27T12:00:00Z" },
      { title: "Next 3.0 Preview", timestamp: "2017-09-18T12:00:00Z" },
      { title: "Next.js 4", timestamp: "2018-02-12T12:00:00Z" },
      { title: "Today post", timestamp: "2026-08-25T11:00:00Z" },
      { title: "Yesterday post", timestamp: "2026-08-24T11:00:00Z" },
    ]),
  );

  assert.deepEqual(
    result.candidates.map((candidate) => candidate.title),
    ["Today post", "Yesterday post"],
  );
  assert.deepEqual(result.messages, [
    "RSS source dropped 3 entries older than 7 days, 0 entries without a usable date, and 0 entries due to the per-feed cap.",
  ]);
});
