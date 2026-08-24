import assert from "node:assert/strict";
import test from "node:test";

import { checkIdeas, ideaTopicHash, type ProposedIdea } from "./idea-gate.ts";

function idea(overrides: Partial<ProposedIdea> = {}): ProposedIdea {
  return {
    title: "A verified buyer network for developer-tool procurement",
    trendTitle: "Open-source procurement tools are rising",
    mechanism:
      "Match maintainers seeking paid support with verified procurement leads, then charge for completed introductions.",
    evidence: "https://news.ycombinator.com/item?id=12345 860 comments, accelerating.",
    moatClass: "network",
    buildComponents: ["auth"],
    ownerFit: "It is adjacent to the owner's public developer-tool work, an approximation from GitHub and past posts.",
    ...overrides,
  };
}

test("idea gate accepts evidence, an allowed moat, a mechanism, and declared build components", () => {
  const result = checkIdeas([idea()], new Set());

  assert.deepEqual(result.accepted.map((accepted) => accepted.title), [
    "A verified buyer network for developer-tool procurement",
  ]);
  assert.deepEqual(result.rejected, []);
});

test("idea gate rejects an idea without parseable evidence", () => {
  const result = checkIdeas([idea({ evidence: "Developers are excited about this." })], new Set());

  assert.deepEqual(result.accepted, []);
  assert.equal(result.rejected[0]?.reason, "evidence must include a link, number, and direction");
});

test("idea gate does not mistake an evidence URL's numeric id for a measured number", () => {
  const result = checkIdeas(
    [idea({ evidence: "https://news.ycombinator.com/item?id=12345 accelerating." })],
    new Set(),
  );

  assert.deepEqual(result.accepted, []);
  assert.equal(result.rejected[0]?.reason, "evidence must include a link, number, and direction");
});

test("idea gate rejects code as the only moat because it is clonable", () => {
  const result = checkIdeas([idea({ moatClass: "code" })], new Set());

  assert.deepEqual(result.accepted, []);
  assert.equal(result.rejected[0]?.reason, "moat class must be exactly one accepted non-code moat");
});

test("idea gate requires exactly one moat class", () => {
  const result = checkIdeas([idea({ moatClass: "network, data" })], new Set());

  assert.deepEqual(result.accepted, []);
  assert.equal(result.rejected[0]?.reason, "moat class must be exactly one accepted non-code moat");
});

test("idea gate rejects an already-digested topic using the shared topic hash", () => {
  const candidate = idea();
  const result = checkIdeas([candidate], new Set([ideaTopicHash(candidate)]));

  assert.deepEqual(result.accepted, []);
  assert.equal(result.rejected[0]?.reason, "topic was already digested");
});

test("idea gate rejects a component outside the fixed taxonomy", () => {
  const result = checkIdeas([idea({ buildComponents: ["magic"] })], new Set());

  assert.deepEqual(result.accepted, []);
  assert.equal(
    result.rejected[0]?.reason,
    "build component is not in the fixed taxonomy: magic",
  );
});

test("idea gate rejects a computed estimate beyond two weeks", () => {
  const result = checkIdeas(
    [
      idea({
        buildComponents: [
          "regulated or compliance work",
          "mobile app",
          "two-sided marketplace",
          "manual ops bootstrap",
          "data pipeline or ETL",
        ],
      }),
    ],
    new Set(),
  );

  assert.deepEqual(result.accepted, []);
  assert.equal(result.rejected[0]?.reason, "computed build estimate exceeds the 14 day cap (16.0 days)");
});

test("idea gate rejects a trend restatement without a concrete mechanism", () => {
  const result = checkIdeas(
    [idea({ mechanism: "AI is big, build AI things for this trend." })],
    new Set(),
  );

  assert.deepEqual(result.accepted, []);
  assert.equal(result.rejected[0]?.reason, "idea restates the trend without a concrete mechanism");
});

test("idea gate rejects an idea that cannot explain its owner fit", () => {
  const result = checkIdeas([idea({ ownerFit: "" })], new Set());

  assert.deepEqual(result.accepted, []);
  assert.equal(result.rejected[0]?.reason, "owner fit must be stated as an approximation");
});
