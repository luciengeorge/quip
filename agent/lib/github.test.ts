import assert from "node:assert/strict";
import test from "node:test";

import { GithubActivitySource, isPublicGithubRepo } from "./github.ts";
import { fakeFetch } from "./test-fetch.ts";

test("isPublicGithubRepo requires explicit public visibility", () => {
  assert.equal(isPublicGithubRepo({ private: false, visibility: "public" }), true);
  assert.equal(isPublicGithubRepo({ private: true, visibility: "private" }), false);
  assert.equal(isPublicGithubRepo({ private: false }), false);
  assert.equal(isPublicGithubRepo({ visibility: "public" }), false);
  assert.equal(isPublicGithubRepo({ private: false, visibility: "internal" }), false);
});

test("GitHub source keeps only activity with an explicitly public repository", async () => {
  const fetch = fakeFetch((url) => {
    if (url.includes("/events/public")) {
      return {
        body: [
          {
            type: "PushEvent",
            created_at: "2026-08-20T10:00:00Z",
            repo: { name: "luciengeorge/public-repository" },
            payload: {
              head: "abc123",
              commits: [{ message: "Ship a useful feature" }],
            },
          },
          {
            type: "PushEvent",
            created_at: "2026-08-20T11:00:00Z",
            repo: { name: "luciengeorge/private-repository" },
            payload: { head: "def456", commits: [{ message: "Never publish this" }] },
          },
          {
            type: "PushEvent",
            created_at: "2026-08-20T12:00:00Z",
            repo: { name: "luciengeorge/unknown-repository" },
            payload: { head: "ghi789", commits: [{ message: "Visibility is missing" }] },
          },
        ],
      };
    }
    if (url.endsWith("/repos/luciengeorge/public-repository")) {
      return { body: { private: false, visibility: "public", html_url: "https://github.com/luciengeorge/public-repository" } };
    }
    if (url.endsWith("/repos/luciengeorge/private-repository")) {
      return { body: { private: true, visibility: "private" } };
    }
    if (url.endsWith("/repos/luciengeorge/unknown-repository")) {
      return { body: { private: false } };
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  const source = new GithubActivitySource({
    username: "luciengeorge",
    fetchImpl: fetch.fetch,
  });

  const result = await source.gather();

  assert.equal(fetch.calls.length, 4);
  assert.equal(
    fetch.calls[0]?.url,
    "https://api.github.com/users/luciengeorge/events/public?per_page=100",
  );
  assert.deepEqual(result.candidates, [
    {
      source: "github",
      title: "Pushed 1 commit to public-repository",
      url: "https://github.com/luciengeorge/public-repository/commit/abc123",
      context: "Ship a useful feature",
      timestamp: Date.parse("2026-08-20T10:00:00Z"),
    },
  ]);
  assert.deepEqual(result.messages, [
    "GitHub activity was excluded because repository visibility was not explicitly public.",
    "GitHub activity was excluded because repository visibility was not explicitly public.",
  ]);
});

test("GitHub source applies the leak guard during candidate ingest", async () => {
  const fetch = fakeFetch((url) => {
    if (url.includes("/events/public")) {
      return {
        body: [
          {
            type: "PushEvent",
            created_at: "2026-08-20T10:00:00Z",
            repo: { name: "luciengeorge/public-repository" },
            payload: { head: "abc123", commits: [{ message: "Discuss internal-project" }] },
          },
        ],
      };
    }
    return {
      body: { private: false, visibility: "public", html_url: "https://github.com/luciengeorge/public-repository" },
    };
  });
  const source = new GithubActivitySource({
    username: "luciengeorge",
    fetchImpl: fetch.fetch,
    leakGuard: { internalTerms: ["internal-project"] },
  });

  const result = await source.gather();

  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.messages, ["Candidate rejected by leak guard: employer-internal term."]);
});
