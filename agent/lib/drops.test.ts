import assert from "node:assert/strict";
import test from "node:test";

import { SlackDropSource } from "./drops.ts";

test("Slack drop source keeps bare URLs and short own ideas", async () => {
  const calls: Array<{ operation: string; body: unknown }> = [];
  const source = new SlackDropSource({
    botToken: "connect-managed-token",
    channelId: "C123",
    limit: 20,
    callSlackApi: async ({ operation, body }) => {
      calls.push({ operation, body });
      assert.equal(operation, "conversations.history");
      assert.deepEqual(body, { channel: "C123", limit: 20 });
      return {
        ok: true,
        messages: [
          { text: "https://example.com/useful", ts: "1700000000.000100" },
          { text: "Build a narrower tool before adding the model", ts: "1700000001.000100" },
          { text: "This is deliberately much too long to be treated as a short idea because it contains context that belongs in Slack rather than a public draft.", ts: "1700000002.000100" },
        ],
      };
    },
  });

  const result = await source.gather();

  assert.equal(calls.length, 1);
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

test("Slack drop source contains authorization and network failures", async () => {
  const source = new SlackDropSource({
    botToken: "connect-managed-token",
    channelId: "C123",
    callSlackApi: async () => {
      throw new Error("connector unavailable");
    },
  });

  const originalWarn = console.warn;
  console.warn = () => {};
  let result: Awaited<ReturnType<typeof source.gather>>;
  try {
    result = await source.gather();
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.messages, ["Slack drop source was unavailable; continuing without drops."]);
});
