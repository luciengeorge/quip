import assert from "node:assert/strict";
import test from "node:test";

import { XSearchSource, type XReadBudget } from "./x.ts";
import { fakeFetch } from "./test-fetch.ts";

function budget(allowed: boolean): {
  client: XReadBudget;
  reservations: number[];
  settlements: { reservationId: string; actualReads: number }[];
} {
  const reservations: number[] = [];
  const settlements: { reservationId: string; actualReads: number }[] = [];
  return {
    client: {
      async reserveXReads(reads) {
        reservations.push(reads);
        return allowed
          ? { allowed: true, reservationId: "reservation-1", remainingReads: 5_000 - reads }
          : { allowed: false, reservationId: null, remainingReads: 0 };
      },
      async settleXReads(reservationId, actualReads) {
        settlements.push({ reservationId, actualReads });
      },
    },
    reservations,
    settlements,
  };
}

test("X search reserves the maximum possible reads before its paid request and settles actual reads", async () => {
  const meter = budget(true);
  const fetch = fakeFetch((url, init) => {
    const request = new URL(url);
    assert.equal(request.origin, "https://api.x.com");
    assert.equal(request.pathname, "/2/tweets/search/recent");
    assert.equal(request.searchParams.get("query"), "developer tools lang:en -is:retweet");
    assert.equal(request.searchParams.get("max_results"), "10");
    assert.equal(request.searchParams.get("tweet.fields"), "created_at");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-token");
    return {
      body: {
        data: [
          { id: "111", text: "A good developer-tools take", created_at: "2026-08-20T10:00:00Z" },
          { id: "222", text: "Another useful point", created_at: "2026-08-20T11:00:00Z" },
        ],
      },
    };
  });
  const source = new XSearchSource({
    bearerToken: "test-token",
    query: "developer tools lang:en -is:retweet",
    budget: meter.client,
    fetchImpl: fetch.fetch,
    maxResults: 10,
  });

  const result = await source.gather();

  assert.deepEqual(meter.reservations, [10]);
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(meter.settlements, [{ reservationId: "reservation-1", actualReads: 2 }]);
  assert.deepEqual(result.candidates, [
    {
      source: "trending",
      title: "A good developer-tools take",
      url: "https://x.com/i/web/status/111",
      context: "A good developer-tools take",
      timestamp: Date.parse("2026-08-20T10:00:00Z"),
    },
    {
      source: "trending",
      title: "Another useful point",
      url: "https://x.com/i/web/status/222",
      context: "Another useful point",
      timestamp: Date.parse("2026-08-20T11:00:00Z"),
    },
  ]);
  assert.deepEqual(result.messages, []);
});

test("X search skips its paid request and reports free-source degradation when the cap is exhausted", async () => {
  const meter = budget(false);
  const fetch = fakeFetch(() => {
    throw new Error("A paid request must not run after budget denial");
  });
  const source = new XSearchSource({
    bearerToken: "test-token",
    query: "developer tools",
    budget: meter.client,
    fetchImpl: fetch.fetch,
    maxResults: 10,
  });

  const result = await source.gather();

  assert.deepEqual(meter.reservations, [10]);
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(meter.settlements, []);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.messages, [
    "X source skipped because the monthly read budget is exhausted; free sources remain available.",
  ]);
});

test("X search holds its full reservation after an ambiguous transport failure", async () => {
  const meter = budget(true);
  const fetch = fakeFetch(() => {
    throw new Error("socket closed after request");
  });
  const source = new XSearchSource({
    bearerToken: "test-token",
    query: "developer tools",
    budget: meter.client,
    fetchImpl: fetch.fetch,
    maxResults: 10,
  });

  const result = await source.gather();

  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(meter.settlements, [{ reservationId: "reservation-1", actualReads: 10 }]);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.messages, [
    "X source failed after reserving reads; the reservation remains charged and free sources remain available.",
  ]);
});
