import assert from "node:assert/strict";
import test from "node:test";

import { ideaTopicHash, type ProposedIdea } from "./idea-gate.ts";
import {
  planResearchEscalations,
  resolveResearchEscalations,
} from "./research-escalation.ts";

function idea(index: number, overrides: Partial<ProposedIdea> = {}): ProposedIdea {
  return {
    title: `Idea ${index}`,
    trendTitle: `Trend ${index}`,
    mechanism: "Match verified buyers with specialist operators, then charge for completed introductions.",
    evidence: `https://example.com/trend-${index} ${100 + index} mentions, accelerating.`,
    moatClass: "network",
    buildComponents: ["auth"],
    ownerFit: "It matches the owner's public developer-tool work, an approximation from public activity.",
    ...overrides,
  };
}

function researchResponse(original: ProposedIdea) {
  return {
    revisedProposal: {
      ...original,
      mechanism:
        "Verify procurement intent from source citations, match it to specialist operators, and charge for completed introductions.",
      evidence: "https://example.com/research 42% of buyers reported this need, accelerating.",
      moatClass: "data",
      buildComponents: ["auth", "third-party API integration"],
    },
    researchSummary: "Research found a reported 42% buyer need and a public source that supports a data moat.",
    sources: [
      {
        url: "https://example.com/research",
        claim: "42% of buyers reported this need.",
      },
    ],
  };
}

test("research escalation skips duplicates and applies the configured cap in code", () => {
  const duplicate = idea(0);
  const invalidIdeas = Array.from({ length: 6 }, (_, index) =>
    idea(index + 1, { evidence: "No source supplied." }),
  );
  const plan = planResearchEscalations(
    [duplicate, ...invalidIdeas],
    new Set([ideaTopicHash(duplicate)]),
    5,
  );

  assert.equal(plan.researchRequests.length, 5);
  assert.deepEqual(
    plan.researchRequests.map((request) => request.original.title),
    ["Idea 1", "Idea 2", "Idea 3", "Idea 4", "Idea 5"],
  );
  assert.equal(plan.rejections[0]?.reason, "topic was already digested");
  assert.equal(plan.rejections[6]?.title, "Idea 6");
});

test("a valid research revision is resubmitted to the same deterministic gate", () => {
  const original = idea(1, { evidence: "No source supplied." });
  const plan = planResearchEscalations([original], new Set(), 5);
  const resolved = resolveResearchEscalations(plan, [
    { originalTitle: original.title, output: researchResponse(original) },
  ]);

  assert.equal(resolved.acceptedAfterResearch.length, 1);
  assert.equal(resolved.acceptedAfterResearch[0]?.buildDays, 2.5);
  assert.equal(resolved.acceptedAfterResearch[0]?.researchSummary.includes("42%"), true);
  assert.deepEqual(resolved.rejections, []);
});

test("malformed research fails closed and leaves the original idea rejected", () => {
  const original = idea(1, { evidence: "No source supplied." });
  const plan = planResearchEscalations([original], new Set(), 5);
  const resolved = resolveResearchEscalations(plan, [
    { originalTitle: original.title, output: { revisedProposal: "not an object" } },
  ]);

  assert.deepEqual(resolved.acceptedAfterResearch, []);
  assert.deepEqual(resolved.rejections, [
    {
      title: original.title,
      reason: "evidence must include a link, number, and direction; research returned no valid revision",
      researchAttempted: true,
    },
  ]);
});
