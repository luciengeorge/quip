import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_STACKEXCHANGE_SITES,
  STACKEXCHANGE_MAX_SEARCH_REQUESTS_PER_SWEEP,
  STACKEXCHANGE_QUOTA_FLOOR,
  StackExchangeDemandSource,
  stackExchangeDemandSourceFromEnv,
  stackExchangeSitesFromEnv,
} from "./stackexchange.ts";
import { fakeFetch } from "./test-fetch.ts";

const now = Date.parse("2026-08-27T12:00:00Z");

function question(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Can anyone recommend a deployment preview tool?",
    body: "<p>I need one for a small team.</p>",
    owner: { display_name: "buyer_one" },
    answer_count: 2,
    creation_date: 1_724_500_000,
    link: "https://softwarerecs.stackexchange.com/questions/1234/deploy-preview-tool",
    is_answered: false,
    ...overrides,
  };
}

function source(fetchImpl: typeof globalThis.fetch): StackExchangeDemandSource {
  return new StackExchangeDemandSource({
    sites: ["softwarerecs", "stackoverflow"],
    queries: ["can anyone recommend", "looking for something"],
    fetchImpl,
    now: () => now,
  });
}

test("Stack Exchange demand source maps source facts and sends compressed bounded searches", async () => {
  const observed: Array<{ request: URL; headers: HeadersInit | undefined }> = [];
  const fetch = fakeFetch((url, init) => {
    // Record request facts here. Assertions thrown in this callback are caught by adapter degradation.
    observed.push({ request: new URL(url), headers: init.headers });
    return { body: { quota_remaining: 299, items: [question()] } };
  });

  const result = await source(fetch.fetch).gather();

  assert.equal(fetch.calls.length, 4);
  assert.equal(observed.length, 4);
  // Assert after gather so a mismatch reaches the test runner. The mutation check proves this is live.
  assert.deepEqual(
    observed.map(({ request }) => [request.searchParams.get("site"), request.searchParams.get("q")]),
    [
      ["softwarerecs", "can anyone recommend"],
      ["softwarerecs", "looking for something"],
      ["stackoverflow", "can anyone recommend"],
      ["stackoverflow", "looking for something"],
    ],
  );
  for (const { request, headers } of observed) {
    assert.equal(request.origin, "https://api.stackexchange.com");
    assert.equal(request.pathname, "/2.3/search/advanced");
    assert.equal(request.searchParams.get("order"), "desc");
    assert.equal(request.searchParams.get("sort"), "creation");
    assert.equal(request.searchParams.get("closed"), "false");
    assert.equal(request.searchParams.get("fromdate"), String((now - 7 * 24 * 60 * 60 * 1_000) / 1_000));
    assert.equal(request.searchParams.get("filter"), "withbody");
    assert.equal(request.searchParams.get("pagesize"), "25");
    assert.deepEqual(headers, { "Accept-Encoding": "gzip" });
  }
  assert.deepEqual(result.candidates, [
    {
      source: "stackexchange",
      title: "Can anyone recommend a deployment preview tool?",
      url: "https://softwarerecs.stackexchange.com/questions/1234/deploy-preview-tool",
      context: "Can anyone recommend a deployment preview tool?\n<p>I need one for a small team.</p>",
      timestamp: 1_724_500_000_000,
      author: "buyer_one",
      replyCount: 2,
      subreddit: "softwarerecs",
      sourceText: "Can anyone recommend a deployment preview tool?\n<p>I need one for a small team.</p>",
    },
    {
      source: "stackexchange",
      title: "Can anyone recommend a deployment preview tool?",
      url: "https://softwarerecs.stackexchange.com/questions/1234/deploy-preview-tool",
      context: "Can anyone recommend a deployment preview tool?\n<p>I need one for a small team.</p>",
      timestamp: 1_724_500_000_000,
      author: "buyer_one",
      replyCount: 2,
      subreddit: "softwarerecs",
      sourceText: "Can anyone recommend a deployment preview tool?\n<p>I need one for a small team.</p>",
    },
    {
      source: "stackexchange",
      title: "Can anyone recommend a deployment preview tool?",
      url: "https://softwarerecs.stackexchange.com/questions/1234/deploy-preview-tool",
      context: "Can anyone recommend a deployment preview tool?\n<p>I need one for a small team.</p>",
      timestamp: 1_724_500_000_000,
      author: "buyer_one",
      replyCount: 2,
      subreddit: "stackoverflow",
      sourceText: "Can anyone recommend a deployment preview tool?\n<p>I need one for a small team.</p>",
    },
    {
      source: "stackexchange",
      title: "Can anyone recommend a deployment preview tool?",
      url: "https://softwarerecs.stackexchange.com/questions/1234/deploy-preview-tool",
      context: "Can anyone recommend a deployment preview tool?\n<p>I need one for a small team.</p>",
      timestamp: 1_724_500_000_000,
      author: "buyer_one",
      replyCount: 2,
      subreddit: "stackoverflow",
      sourceText: "Can anyone recommend a deployment preview tool?\n<p>I need one for a small team.</p>",
    },
  ]);
  assert.deepEqual(result.messages, []);
});

test("Stack Exchange demand source excludes answered, closed, and duplicate questions with counts", async () => {
  const fetch = fakeFetch(() => ({
    body: {
      quota_remaining: 299,
      items: [
        question({ is_answered: true }),
        question({ closed_date: 1_724_500_100 }),
        question({ closed_reason: "duplicate" }),
        question({ owner: undefined }),
        question(),
      ],
    },
  }));
  const result = await new StackExchangeDemandSource({
    sites: ["softwarerecs"],
    queries: ["recommend tool"],
    fetchImpl: fetch.fetch,
    now: () => now,
  }).gather();

  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.messages, [
    "Stack Exchange demand source dropped 1 malformed search results.",
    "Stack Exchange demand source excluded 1 answered questions.",
    "Stack Exchange demand source excluded 1 closed questions.",
    "Stack Exchange demand source excluded 1 duplicate questions.",
  ]);
});

test("Stack Exchange demand source stops when quota reaches its floor", async () => {
  const fetch = fakeFetch(() => ({ body: { quota_remaining: STACKEXCHANGE_QUOTA_FLOOR - 1, items: [] } }));
  const result = await source(fetch.fetch).gather();

  assert.equal(fetch.calls.length, 1);
  assert.ok(
    result.messages.includes(
      `Stack Exchange demand source degraded because quota_remaining fell to ${STACKEXCHANGE_QUOTA_FLOOR - 1}, below its ${STACKEXCHANGE_QUOTA_FLOOR} floor; it stopped the sweep.`,
    ),
  );
});

test("Stack Exchange demand source honors a backoff response by stopping the sweep", async () => {
  const fetch = fakeFetch(() => ({ body: { quota_remaining: 299, backoff: 12, items: [] } }));
  const result = await source(fetch.fetch).gather();

  assert.equal(fetch.calls.length, 1);
  assert.ok(
    result.messages.includes(
      "Stack Exchange demand source degraded after an API backoff of 12 seconds; it stopped the sweep.",
    ),
  );
});

test("Stack Exchange sites default to Software Recommendations and source setup reuses demand queries", () => {
  assert.deepEqual(stackExchangeSitesFromEnv(undefined), [...DEFAULT_STACKEXCHANGE_SITES]);
  assert.deepEqual(stackExchangeSitesFromEnv("softwarerecs,stackoverflow\ninvalid/site"), [
    "softwarerecs",
    "stackoverflow",
  ]);
  const configured = stackExchangeDemandSourceFromEnv({ DEMAND_QUERIES: "recommend tool" });

  assert.ok(configured instanceof StackExchangeDemandSource);
  assert.equal(STACKEXCHANGE_MAX_SEARCH_REQUESTS_PER_SWEEP, 20);
});
