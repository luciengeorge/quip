import assert from "node:assert/strict";
import test from "node:test";

import { ExaTrendingSource } from "./exa.ts";
import { fakeFetch } from "./test-fetch.ts";

test("Exa trending source posts a bounded query and maps normalised candidates", async () => {
  const fetch = fakeFetch((url, init) => {
    assert.equal(url, "https://api.exa.ai/search");
    assert.equal(init.method, "POST");
    assert.equal((init.headers as Record<string, string>)["x-api-key"], "test-key");
    assert.deepEqual(JSON.parse(String(init.body)), {
      query: "developer tools",
      numResults: 5,
      contents: { text: { maxCharacters: 800 }, summary: true },
    });
    return {
      body: {
        results: [
          {
            title: "A developer tool release",
            url: "https://example.com/tool",
            publishedDate: "2026-08-20T10:00:00Z",
            text: "Full text",
            summary: "The summary",
          },
        ],
      },
    };
  });
  const source = new ExaTrendingSource({
    apiKey: "test-key",
    query: "developer tools",
    fetchImpl: fetch.fetch,
    limit: 5,
  });

  const result = await source.gather();

  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(result.candidates, [
    {
      source: "trending",
      title: "A developer tool release",
      url: "https://example.com/tool",
      context: "The summary\n\nFull text",
      timestamp: Date.parse("2026-08-20T10:00:00Z"),
    },
  ]);
  assert.deepEqual(result.messages, []);
});
