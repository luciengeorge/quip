import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { RssSource, parseFeed } from "./rss.ts";
import { fakeFetch } from "./test-fetch.ts";

const fixtureUrl = new URL("../../fixtures/sample-dev-feed.xml", import.meta.url);

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
