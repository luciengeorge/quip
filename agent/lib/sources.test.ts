import assert from "node:assert/strict";
import test from "node:test";

import { gatherSources, type CandidateSource } from "./candidates.ts";

test("source gathering retains free candidates when a paid source degrades", async () => {
  const freeSource: CandidateSource = {
    async gather() {
      return {
        candidates: [
          {
            source: "hn",
            title: "Free source result",
            url: "https://example.com/free",
            context: "",
            timestamp: 1,
          },
        ],
        messages: [],
      };
    },
  };
  const paidSource: CandidateSource = {
    async gather() {
      return {
        candidates: [],
        messages: [
          "X source skipped because the monthly read budget is exhausted; free sources remain available.",
        ],
      };
    },
  };

  const result = await gatherSources([freeSource, paidSource]);

  assert.deepEqual(result.candidates, [
    {
      source: "hn",
      title: "Free source result",
      url: "https://example.com/free",
      context: "",
      timestamp: 1,
    },
  ]);
  assert.deepEqual(result.messages, [
    "X source skipped because the monthly read budget is exhausted; free sources remain available.",
  ]);
});
