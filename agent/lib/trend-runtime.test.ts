import assert from "node:assert/strict";
import test from "node:test";

import { XSearchSource } from "./x.ts";
import { trendSourceSet } from "./trend-runtime.ts";
import { fakeFetch } from "./test-fetch.ts";

const budget = {
  async reserveXReads() {
    return { allowed: false, reservationId: null, remainingReads: 0 };
  },
  async settleXReads() {},
};

test("trend source setup omits X without credentials but retains the free source set", () => {
  const fetch = fakeFetch(() => {
    throw new Error("source setup must not fetch");
  });
  const sources = trendSourceSet({ env: {}, budget, fetchImpl: fetch.fetch });

  assert.equal(sources.xSourceConfigured, false);
  assert.equal(sources.sources.some((source) => source instanceof XSearchSource), false);
  assert.equal(sources.sources.length, 2);
  assert.deepEqual(sources.initialMessages, [
    "X data was unavailable for this scan; free sources remain available.",
  ]);
  assert.equal(fetch.calls.length, 0);
});

test("trend source setup wires the existing budget-gated X source when credentials appear", () => {
  const sources = trendSourceSet({
    env: {
      EXA_API_KEY: "exa-key",
      EXA_TREND_QUERY: "developer tools",
      RSS_FEED_URLS: "https://feeds.example.com/dev.xml",
      X_BEARER_TOKEN: "x-token",
      X_TREND_QUERY: "developer tools",
    },
    budget,
  });

  assert.equal(sources.xSourceConfigured, true);
  assert.equal(sources.sources.some((source) => source instanceof XSearchSource), true);
  assert.deepEqual(sources.initialMessages, []);
  assert.equal(sources.sources.length, 5);
});
