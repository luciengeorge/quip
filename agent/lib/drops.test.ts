import assert from "node:assert/strict";
import test from "node:test";

import { SlackDropSource } from "./drops.ts";
import { fakeFetch } from "./test-fetch.ts";

test("Slack drop source keeps bare URLs and short own ideas", async () => {
  const fetch = fakeFetch((url) => {
    assert.equal(url, "https://slack.com/api/conversations.history?channel=C123&limit=20");
    return {
      body: {
        ok: true,
        messages: [
          { text: "https://example.com/useful", ts: "1700000000.000100" },
          { text: "Build a narrower tool before adding the model", ts: "1700000001.000100" },
          { text: "This is deliberately much too long to be treated as a short idea because it contains context that belongs in Slack rather than a public draft.", ts: "1700000002.000100" },
        ],
      },
    };
  });
  const source = new SlackDropSource({
    token: "test-token",
    channelId: "C123",
    fetchImpl: fetch.fetch,
    limit: 20,
  });

  const result = await source.gather();

  assert.equal(fetch.calls.length, 1);
  assert.equal(
    (fetch.calls[0]?.init.headers as Record<string, string>).Authorization,
    "Bearer test-token",
  );
  assert.deepEqual(result.candidates, [
    {
      source: "drop",
      title: "https://example.com/useful",
      url: "https://example.com/useful",
      context: "https://example.com/useful",
      timestamp: 1_700_000_000_000,
    },
    {
      source: "drop",
      title: "Build a narrower tool before adding the model",
      url: "slack://channel/C123/message/1700000001.000100",
      context: "Build a narrower tool before adding the model",
      timestamp: 1_700_000_001_000,
    },
  ]);
  assert.deepEqual(result.messages, []);
});
