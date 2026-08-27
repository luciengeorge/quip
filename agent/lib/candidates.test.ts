import assert from "node:assert/strict";
import test from "node:test";

import { ingestCandidates, type Candidate } from "./candidates.ts";
import { fakeApiKey } from "./test-secrets.ts";

const candidate: Candidate = {
  source: "drop",
  title: "A safe idea",
  url: "https://example.com/idea",
  context: "A short note.",
  timestamp: 1_700_000_000_000,
};

test("ingest drops candidates containing configured private material", () => {
  const result = ingestCandidates(
    [
      candidate,
      { ...candidate, title: "Notes from internal-project" },
      { ...candidate, context: `token ${fakeApiKey()}` },
    ],
    { internalTerms: ["internal-project"] },
  );

  assert.deepEqual(result.candidates, [candidate]);
  assert.equal(result.rejections.length, 2);
  assert.match(result.rejections[0]?.reason ?? "", /employer-internal term/);
  assert.match(result.rejections[1]?.reason ?? "", /credential-shaped text/);
});

test("ingest examines title, URL, and context before a candidate can be drafted", () => {
  const result = ingestCandidates(
    [
      { ...candidate, title: "private-repository launch" },
      { ...candidate, url: "https://example.com/private-repository" },
      { ...candidate, context: "Review private-repository first." },
    ],
    { privateRepoNames: ["private-repository"] },
  );

  assert.deepEqual(result.candidates, []);
  assert.equal(result.rejections.length, 3);
  for (const rejection of result.rejections) {
    assert.match(rejection.reason, /private repository name/);
  }
});
