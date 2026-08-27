import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate } from "./candidates.ts";
import {
  classifyDemandCandidates,
  planDemandCandidates,
  type DemandCandidatePlan,
} from "./demand-scan.ts";
import { fakeApiKey } from "./test-secrets.ts";

const day = "2026-08-27";
const now = Date.parse("2026-08-27T12:00:00Z");

function candidate(index = 0, overrides: Partial<Candidate> = {}): Candidate {
  const url = `https://www.reddit.com/r/SaaS/comments/post_${index}/buyer_ask/`;
  return {
    source: "reddit",
    title: `Can anyone recommend a deployment preview tool ${index}?`,
    url,
    context: `Can anyone recommend a deployment preview tool ${index}?\nI need one for a small team.`,
    timestamp: now - 24 * 60 * 60 * 1_000,
    author: `buyer_${index}`,
    replyCount: 1,
    subreddit: "SaaS",
    sourceText: `Can anyone recommend a deployment preview tool ${index}?\nI need one for a small team.`,
    ...overrides,
  } as Candidate;
}

function stackExchangeCandidate(index = 0, overrides: Partial<Candidate> = {}): Candidate {
  const url = `https://softwarerecs.stackexchange.com/questions/${index}/deployment-preview-tool`;
  return {
    source: "stackexchange",
    title: `Can anyone recommend a deployment preview tool ${index}?`,
    url,
    context: `Can anyone recommend a deployment preview tool ${index}?\n<p>I need one for a small team.</p>`,
    timestamp: now - 24 * 60 * 60 * 1_000,
    author: `stack_buyer_${index}`,
    replyCount: 1,
    subreddit: "softwarerecs",
    sourceText: `Can anyone recommend a deployment preview tool ${index}?\n<p>I need one for a small team.</p>`,
    ...overrides,
  } as Candidate;
}

function buyerOutput(plan: DemandCandidatePlan, index = 0): unknown {
  const item = plan.candidates[index];
  assert.ok(item);
  return {
    buyerAsk: true,
    author: item.author,
    askedAt: item.timestamp,
    quote: item.title,
    replyCount: item.replyCount,
    permalink: item.url,
    subreddit: item.subreddit,
    askedFor: "deployment preview tooling for small teams",
  };
}

test("demand boundary drops blank and malformed Reddit fields before classification", () => {
  const result = planDemandCandidates(
    [
      candidate(),
      candidate(1, { title: " " }),
      candidate(2, { url: "" }),
      { ...candidate(3), author: "", replyCount: -1 } as Candidate,
    ],
    day,
    30,
  );

  assert.equal(result.candidates.length, 1);
  assert.equal(result.droppedCount, 3);
});

test("demand boundary drops blank and malformed Stack Exchange fields before classification", () => {
  const result = planDemandCandidates(
    [
      stackExchangeCandidate(),
      stackExchangeCandidate(1, { title: " " }),
      { ...stackExchangeCandidate(2), author: "" } as Candidate,
      { ...stackExchangeCandidate(3), sourceText: " " } as Candidate,
    ],
    day,
    30,
  );

  assert.equal(result.candidates.length, 1);
  assert.equal(result.droppedCount, 3);
});

test("a classifier quote that is not a verbatim source substring is dropped", () => {
  const plan = planDemandCandidates([candidate()], day, 30);
  const output = buyerOutput(plan) as Record<string, unknown>;
  output.quote = "Could someone suggest a deployment preview service?";

  const result = classifyDemandCandidates(plan, [output], now);

  assert.deepEqual(result.asks, []);
  assert.equal(result.nonVerbatimQuoteCount, 1);
});

test("a Stack Exchange classifier quote must be a verbatim title and body substring", () => {
  const plan = planDemandCandidates([stackExchangeCandidate()], day, 30);
  const output = buyerOutput(plan) as Record<string, unknown>;
  output.quote = "Could someone suggest a deployment preview service?";

  const result = classifyDemandCandidates(plan, [output], now);

  assert.deepEqual(result.asks, []);
  assert.equal(result.nonVerbatimQuoteCount, 1);
});

test("malformed classifier output fails closed as not a buyer ask", () => {
  const plan = planDemandCandidates([candidate()], day, 30);
  const result = classifyDemandCandidates(plan, [{ buyerAsk: true, quote: "missing source fields" }], now);

  assert.deepEqual(result.asks, []);
  assert.equal(result.malformedOutputCount, 1);
});

test("the classification cap is enforced before classifier results are considered", () => {
  const plan = planDemandCandidates(
    Array.from({ length: 31 }, (_, index) => candidate(index)),
    day,
    30,
  );
  const outputs = Array.from({ length: 31 }, (_, index) => buyerOutput(plan, Math.min(index, 29)));
  const result = classifyDemandCandidates(plan, outputs, now);

  assert.equal(plan.cap, 30);
  assert.equal(plan.candidates.length, 30);
  assert.equal(plan.cappedCount, 1);
  assert.equal(result.asks.length, 30);
});

test("leaky source or classifier text never becomes a demand ask", () => {
  const sourcePlan = planDemandCandidates(
    [candidate(0, { context: fakeApiKey() })],
    day,
    30,
  );
  assert.equal(sourcePlan.candidates.length, 0);
  assert.equal(sourcePlan.leakyCount, 1);

  const plan = planDemandCandidates([candidate()], day, 30);
  const output = buyerOutput(plan) as Record<string, unknown>;
  output.askedFor = fakeApiKey();
  const result = classifyDemandCandidates(plan, [output], now);

  assert.deepEqual(result.asks, []);
  assert.equal(result.leakyCount, 1);
});

test("valid classifier output retains the source facts and calculates an open-door score", () => {
  const plan = planDemandCandidates([candidate()], day, 30);
  const result = classifyDemandCandidates(plan, [buyerOutput(plan)], now);

  assert.deepEqual(result.asks, [
    {
      topicHash: result.asks[0]?.topicHash,
      day,
      quote: "Can anyone recommend a deployment preview tool 0?",
      permalink: "https://www.reddit.com/r/SaaS/comments/post_0/buyer_ask/",
      author: "buyer_0",
      askedAt: now - 24 * 60 * 60 * 1_000,
      replyCount: 1,
      score: 78.1,
      subreddit: "SaaS",
      source: "reddit",
      askedFor: "deployment preview tooling for small teams",
    },
  ]);
});
