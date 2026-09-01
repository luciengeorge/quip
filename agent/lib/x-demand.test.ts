import assert from "node:assert/strict";
import test from "node:test";

import { classifyDemandCandidates, planDemandCandidates } from "./demand-scan.ts";
import { demandAskScore } from "./demand-score.ts";
import { fakeFetch } from "./test-fetch.ts";
import {
  X_DEMAND_MAX_SEARCH_REQUESTS_PER_SWEEP,
  X_DEMAND_SEARCH_RESULTS_PER_REQUEST,
  XDemandSource,
  xDemandQueriesFromEnv,
} from "./x-demand.ts";
import type { XReadBudget } from "./x.ts";

const now = Date.parse("2026-08-27T12:00:00Z");

function budget(allowedReservations = Number.POSITIVE_INFINITY): {
  client: XReadBudget;
  reservations: number[];
  settlements: Array<{ reservationId: string; actualReads: number }>;
} {
  const reservations: number[] = [];
  const settlements: Array<{ reservationId: string; actualReads: number }> = [];
  return {
    client: {
      async reserveXReads(reads) {
        reservations.push(reads);
        const reservationNumber = reservations.length;
        return reservationNumber <= allowedReservations
          ? {
              allowed: true,
              reservationId: `reservation-${reservationNumber}`,
              remainingReads: 5_000 - reservationNumber * reads,
            }
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

function post(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "1895130251567000001",
    text: "Is there an app for manga similar to Letterboxd?",
    created_at: "2026-08-27T10:00:00.123Z",
    author_id: "user-1",
    public_metrics: { reply_count: 3 },
    ...overrides,
  };
}

function source(fetchImpl: typeof globalThis.fetch, meter = budget().client): XDemandSource {
  return new XDemandSource({
    bearerToken: "test-token",
    queries: ["is there an app lang:en -is:retweet"],
    budget: meter,
    fetchImpl,
  });
}

test("X demand maps RFC3339 milliseconds, reply_count, author expansion, and score inputs", async () => {
  const meter = budget();
  const observed: Array<{ request: URL; headers: HeadersInit | undefined }> = [];
  const fetch = fakeFetch((url, init) => {
    // Record request facts here. Assertions thrown in this callback are caught by adapter degradation.
    observed.push({ request: new URL(url), headers: init.headers });
    return {
      body: {
        data: [post()],
        includes: { users: [{ id: "user-1", username: "manga_buyer" }] },
      },
    };
  });

  const result = await source(fetch.fetch, meter.client).gather();

  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(meter.reservations, [X_DEMAND_SEARCH_RESULTS_PER_REQUEST]);
  assert.deepEqual(meter.settlements, [{ reservationId: "reservation-1", actualReads: 1 }]);
  assert.equal(observed.length, 1);
  const request = observed[0]?.request;
  assert.ok(request);
  assert.equal(request.origin, "https://api.x.com");
  assert.equal(request.pathname, "/2/tweets/search/recent");
  assert.equal(request.searchParams.get("query"), "is there an app lang:en -is:retweet");
  assert.equal(request.searchParams.get("max_results"), "10");
  assert.equal(request.searchParams.get("tweet.fields"), "created_at,author_id,public_metrics");
  assert.equal(request.searchParams.get("expansions"), "author_id");
  assert.equal(request.searchParams.get("user.fields"), "username");
  assert.deepEqual(observed[0]?.headers, { Authorization: "Bearer test-token" });
  const askedAt = Date.parse("2026-08-27T10:00:00.123Z");
  assert.deepEqual(result.candidates, [
    {
      source: "x",
      title: "Is there an app for manga similar to Letterboxd?",
      url: "https://x.com/i/web/status/1895130251567000001",
      context: "Is there an app for manga similar to Letterboxd?",
      timestamp: askedAt,
      author: "manga_buyer",
      replyCount: 3,
      subreddit: "x",
      sourceText: "Is there an app for manga similar to Letterboxd?",
    },
  ]);

  const plan = planDemandCandidates(result.candidates, "2026-08-27", 30);
  const candidate = plan.candidates[0];
  assert.ok(candidate);
  const classification = classifyDemandCandidates(
    plan,
    [
      {
        buyerAsk: true,
        author: candidate.author,
        askedAt: candidate.timestamp,
        quote: candidate.sourceText,
        replyCount: candidate.replyCount,
        permalink: candidate.url,
        subreddit: candidate.subreddit,
        askedFor: "a manga-tracking app similar to Letterboxd",
      },
    ],
    now,
  );
  assert.equal(classification.asks[0]?.replyCount, 3);
  assert.equal(
    classification.asks[0]?.score,
    demandAskScore({ askedAt, replyCount: 3 }, now),
  );
});

test("X demand drops and counts an ask whose author expansion cannot resolve a handle", async () => {
  const fetch = fakeFetch(() => ({
    body: {
      data: [post()],
      includes: { users: [{ id: "another-user", username: "not_the_author" }] },
    },
  }));

  const result = await source(fetch.fetch).gather();

  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.messages, [
    "X demand source dropped 1 results with an unresolvable author handle.",
  ]);
});

test("X demand drops and counts blank or malformed fields at the source boundary", async () => {
  const fetch = fakeFetch(() => ({
    body: {
      data: [
        post({ id: " " }),
        post({ text: " " }),
        post({ created_at: "not-a-date" }),
        post({ public_metrics: { reply_count: -1 } }),
      ],
      includes: { users: [{ id: "user-1", username: "manga_buyer" }] },
    },
  }));

  const result = await source(fetch.fetch).gather();

  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.messages, ["X demand source dropped 4 malformed search results."]);
});

test("X demand stops paid requests and degrades when the shared monthly budget is exhausted", async () => {
  const meter = budget(1);
  const fetch = fakeFetch(() => ({ body: { data: [] } }));
  const demand = new XDemandSource({
    bearerToken: "test-token",
    queries: ["first query", "second query", "third query"],
    budget: meter.client,
    fetchImpl: fetch.fetch,
  });

  const result = await demand.gather();

  assert.deepEqual(meter.reservations, [10, 10]);
  assert.deepEqual(meter.settlements, [{ reservationId: "reservation-1", actualReads: 0 }]);
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.messages, [
    "X demand source degraded because the monthly read budget is exhausted; it stopped the sweep.",
  ]);
});

test("X demand validates one non-empty query per line and enforces its per-sweep cap", async () => {
  assert.deepEqual(xDemandQueriesFromEnv("first query\nsecond query"), ["first query", "second query"]);
  assert.throws(
    () => xDemandQueriesFromEnv("first query\n\nthird query"),
    /one non-empty query per line/,
  );
  const meter = budget();
  const fetch = fakeFetch(() => ({ body: { data: [] } }));
  const demand = new XDemandSource({
    bearerToken: "test-token",
    queries: Array.from({ length: X_DEMAND_MAX_SEARCH_REQUESTS_PER_SWEEP + 1 }, (_, index) => `query ${index}`),
    budget: meter.client,
    fetchImpl: fetch.fetch,
  });

  const result = await demand.gather();

  assert.equal(fetch.calls.length, X_DEMAND_MAX_SEARCH_REQUESTS_PER_SWEEP);
  assert.equal(meter.reservations.length, X_DEMAND_MAX_SEARCH_REQUESTS_PER_SWEEP);
  assert.ok(
    result.messages.includes(
      "X demand source skipped 1 configured searches to stay within its per-sweep request cap.",
    ),
  );
});
