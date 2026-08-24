import assert from "node:assert/strict";
import test from "node:test";

import { GithubTrendingSource } from "./github-trending.ts";
import { fakeFetch } from "./test-fetch.ts";

const trendingHtml = `
<article class="Box-row">
  <h2 class="h3 lh-condensed"><a href="/acme/fast-thing">acme / fast-thing</a></h2>
  <p>A useful release for developers.</p>
  <a href="/acme/fast-thing/stargazers">99,999 stars</a>
  <span>1,234 stars today</span>
</article>`;

test("GitHub trending source uses daily star velocity rather than lifetime stars", async () => {
  const fetch = fakeFetch((url) => {
    assert.equal(url, "https://github.com/trending?since=daily");
    return { body: trendingHtml };
  });
  const source = new GithubTrendingSource({
    fetchImpl: fetch.fetch,
    now: () => Date.parse("2026-08-24T12:00:00Z"),
  });

  const result = await source.gather();

  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(result.candidates, [
    {
      source: "github-trending",
      title: "acme/fast-thing",
      url: "https://github.com/acme/fast-thing",
      context: "1,234 stars today\nA useful release for developers.",
      timestamp: Date.parse("2026-08-24T12:00:00Z"),
    },
  ]);
  assert.deepEqual(result.messages, []);
});
