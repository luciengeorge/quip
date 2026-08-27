import assert from "node:assert/strict";
import test from "node:test";

import {
  REDDIT_MAX_SEARCH_REQUESTS_PER_SWEEP,
  RedditDemandSource,
  demandQueriesFromEnv,
  redditSubredditsFromEnv,
} from "./reddit.ts";
import { fakeFetch } from "./test-fetch.ts";

/**
 * Compute the expected HTTP Basic header from the fake credentials rather than pasting the encoded
 * literal. A hardcoded `Basic <base64>` string is flagged by secret scanners (GitGuardian failed CI
 * on exactly this one). Computing it also verifies the ENCODING rather than comparing one constant
 * to another, but only once the comparison happens where a failure can actually propagate.
 */
function basicAuth(id: string, secret: string): string {
  return Buffer.from(`${id}:${secret}`).toString("base64");
}


function source(fetchImpl: typeof globalThis.fetch): RedditDemandSource {
  return new RedditDemandSource({
    clientId: "client-id",
    clientSecret: "client-secret",
    userAgent: "server:quip:v1.0 (by /u/quip_owner)",
    subreddits: ["SaaS", "startups"],
    queries: ["can anyone recommend", "looking for something"],
    fetchImpl,
  });
}

test("Reddit demand source exchanges script credentials then searches configured subreddits", async () => {
  const searches = [
    ["/r/SaaS/search", "can anyone recommend"],
    ["/r/SaaS/search", "looking for something"],
    ["/r/startups/search", "can anyone recommend"],
    ["/r/startups/search", "looking for something"],
  ];
  let searchIndex = 0;
  let tokenHeaders: Record<string, string> | undefined;
  const fetch = fakeFetch((url, init) => {
    const request = new URL(url);
    if (request.origin === "https://www.reddit.com") {
      assert.equal(request.pathname, "/api/v1/access_token");
      assert.equal(init.method, "POST");
      assert.equal(init.body, "grant_type=client_credentials");
      // RECORDED, not asserted here. An assert thrown inside the injected fetch is caught by the
      // adapter's own degrade-on-error handling, so it never reaches the test runner and the
      // assertion silently never fires. Verified: corrupting the expected value produced zero
      // failures. Capture and assert AFTER gather() returns, where a failure actually propagates.
      tokenHeaders = init.headers as Record<string, string>;
      return { body: { access_token: "access-token", token_type: "bearer", expires_in: 3600 } };
    }
    assert.equal(request.origin, "https://oauth.reddit.com");
    const expected = searches[searchIndex];
    assert.ok(expected);
    assert.equal(request.pathname, expected[0]);
    assert.equal(request.searchParams.get("q"), expected[1]);
    assert.equal(request.searchParams.get("restrict_sr"), "on");
    assert.equal(request.searchParams.get("sort"), "new");
    assert.equal(request.searchParams.get("t"), "week");
    assert.equal(request.searchParams.get("type"), "link");
    assert.equal(request.searchParams.get("limit"), "25");
    assert.equal(request.searchParams.get("raw_json"), "1");
    assert.deepEqual(init.headers, {
      Authorization: "Bearer access-token",
      "User-Agent": "server:quip:v1.0 (by /u/quip_owner)",
    });
    searchIndex += 1;
    return {
      body: {
        data: {
          children: [
            {
              data: {
                title: "Can anyone recommend a deploy preview tool?",
                selftext: "I need something for a small team.",
                author: "buyer_one",
                created_utc: 1_724_500_000,
                num_comments: 2,
                permalink: "/r/SaaS/comments/example/deploy_preview/",
                subreddit: "SaaS",
              },
            },
          ],
        },
      },
    };
  });
  const result = await source(fetch.fetch).gather();

  assert.equal(fetch.calls.length, 5);
  assert.equal(searchIndex, 4);
  // Asserted HERE, after gather() returns, so a mismatch propagates to the runner instead of being
  // swallowed by the adapter's degrade-on-error path.
  assert.deepEqual(tokenHeaders, {
    Authorization: `Basic ${basicAuth("client-id", "client-secret")}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "server:quip:v1.0 (by /u/quip_owner)",
  });
  assert.deepEqual(result.candidates, [
    {
      source: "reddit",
      title: "Can anyone recommend a deploy preview tool?",
      url: "https://www.reddit.com/r/SaaS/comments/example/deploy_preview/",
      context: "Can anyone recommend a deploy preview tool?\nI need something for a small team.",
      timestamp: 1_724_500_000_000,
      author: "buyer_one",
      replyCount: 2,
      subreddit: "SaaS",
      sourceText: "Can anyone recommend a deploy preview tool?\nI need something for a small team.",
    },
    {
      source: "reddit",
      title: "Can anyone recommend a deploy preview tool?",
      url: "https://www.reddit.com/r/SaaS/comments/example/deploy_preview/",
      context: "Can anyone recommend a deploy preview tool?\nI need something for a small team.",
      timestamp: 1_724_500_000_000,
      author: "buyer_one",
      replyCount: 2,
      subreddit: "SaaS",
      sourceText: "Can anyone recommend a deploy preview tool?\nI need something for a small team.",
    },
    {
      source: "reddit",
      title: "Can anyone recommend a deploy preview tool?",
      url: "https://www.reddit.com/r/SaaS/comments/example/deploy_preview/",
      context: "Can anyone recommend a deploy preview tool?\nI need something for a small team.",
      timestamp: 1_724_500_000_000,
      author: "buyer_one",
      replyCount: 2,
      subreddit: "SaaS",
      sourceText: "Can anyone recommend a deploy preview tool?\nI need something for a small team.",
    },
    {
      source: "reddit",
      title: "Can anyone recommend a deploy preview tool?",
      url: "https://www.reddit.com/r/SaaS/comments/example/deploy_preview/",
      context: "Can anyone recommend a deploy preview tool?\nI need something for a small team.",
      timestamp: 1_724_500_000_000,
      author: "buyer_one",
      replyCount: 2,
      subreddit: "SaaS",
      sourceText: "Can anyone recommend a deploy preview tool?\nI need something for a small team.",
    },
  ]);
  assert.deepEqual(result.messages, []);
});

test("Reddit demand source reports malformed listings and contained API failures", async () => {
  let requestCount = 0;
  const fetch = fakeFetch((url) => {
    if (url === "https://www.reddit.com/api/v1/access_token") {
      return { body: { access_token: "access-token" } };
    }
    requestCount += 1;
    if (requestCount === 1) return { status: 503, body: { message: "unavailable" } };
    return { body: { data: { children: [{ data: { title: "missing fields" } }] } } };
  });

  const result = await source(fetch.fetch).gather();

  assert.equal(fetch.calls.length, 5);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.messages, [
    "Reddit demand source dropped 3 malformed search results.",
    "Reddit demand source was partially unavailable; demand data may be incomplete.",
  ]);
});

test("Reddit demand source caps request fanout and parse helpers reject malformed subreddits", () => {
  assert.deepEqual(redditSubredditsFromEnv("r/SaaS, startups\nnot/a/subreddit"), ["SaaS", "startups"]);
  assert.deepEqual(demandQueriesFromEnv("can anyone recommend\nlooking for something"), [
    "can anyone recommend",
    "looking for something",
  ]);
  assert.equal(REDDIT_MAX_SEARCH_REQUESTS_PER_SWEEP, 20);
});
