import assert from "node:assert/strict";
import test from "node:test";

import { proposedIdeaSchema } from "./trend-idea-schema.ts";

const validProposal = {
  title: "A verified buyer network for developer-tool procurement",
  trendTitle: "Open-source procurement tools are rising",
  mechanism:
    "Match maintainers seeking paid support with verified procurement leads, then charge for completed introductions.",
  evidence: "https://news.ycombinator.com/item?id=12345 860 comments, accelerating.",
  moatClass: "network",
  buildComponents: ["auth"],
  ownerFit: "It is an approximation from the owner's public developer-tool work.",
};

test("proposal input accepts declared components but rejects asserted build durations", () => {
  assert.equal(proposedIdeaSchema.safeParse(validProposal).success, true);
  assert.equal(proposedIdeaSchema.safeParse({ ...validProposal, buildDays: 3 }).success, false);
});
