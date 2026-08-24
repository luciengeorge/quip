import assert from "node:assert/strict";
import test from "node:test";

import { HackerNewsSource, isSoftwareRelevant } from "./hn.ts";
import { fakeFetch } from "./test-fetch.ts";

test("software relevance uses simple title and domain heuristics", () => {
  assert.equal(isSoftwareRelevant("A new TypeScript compiler trick", "https://example.com"), true);
  assert.equal(isSoftwareRelevant("A surprising launch", "https://github.com/example/project"), true);
  assert.equal(isSoftwareRelevant("Storm damages local bridge", "https://weather.example"), false);
});

test("HN source fetches a bounded top-story list and returns software candidates", async () => {
  const fetch = fakeFetch((url) => {
    if (url.endsWith("/topstories.json")) return { body: [101, 102, 103] };
    if (url.endsWith("/item/101.json")) {
      return {
        body: {
          id: 101,
          type: "story",
          title: "A new TypeScript compiler trick",
          url: "https://example.com/typescript",
          text: "Compiler notes",
          time: 1_700_000_000,
        },
      };
    }
    if (url.endsWith("/item/102.json")) {
      return {
        body: {
          id: 102,
          type: "story",
          title: "Storm damages local bridge",
          url: "https://weather.example/storm",
          time: 1_700_000_100,
        },
      };
    }
    if (url.endsWith("/item/103.json")) {
      return {
        body: {
          id: 103,
          type: "story",
          title: "An open source database update",
          time: 1_700_000_200,
        },
      };
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  const source = new HackerNewsSource({ fetchImpl: fetch.fetch, limit: 3 });

  const result = await source.gather();

  assert.equal(fetch.calls.length, 4);
  assert.equal(fetch.calls[0]?.url, "https://hacker-news.firebaseio.com/v0/topstories.json");
  assert.deepEqual(result.candidates, [
    {
      source: "hn",
      title: "A new TypeScript compiler trick",
      url: "https://example.com/typescript",
      context: "Compiler notes",
      timestamp: 1_700_000_000_000,
    },
    {
      source: "hn",
      title: "An open source database update",
      url: "https://news.ycombinator.com/item?id=103",
      context: "",
      timestamp: 1_700_000_200_000,
    },
  ]);
  assert.deepEqual(result.messages, []);
});
