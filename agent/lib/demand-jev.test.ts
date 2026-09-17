import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyDemandWithJev,
  DEMAND_ASK_KINDS,
  JEV_MAX_QUOTE_CHARS,
  JEV_MIN_BUYER_ASK,
  JEV_MIN_SPECIFICITY,
  quoteFromCandidate,
} from "./demand-jev.ts";
import type { DemandCandidate } from "./demand-scan.ts";
import type { JevClient, JevQuestion, JevResponse } from "./jev.ts";
import { fakeApiKey } from "./test-secrets.ts";

const NOW = Date.parse("2026-09-17T12:00:00Z");
const quiet = { warn: () => {} };

function candidate(over: Partial<DemandCandidate> = {}): DemandCandidate {
  return {
    source: "x",
    title: "Is there an app that tracks my LLM spend?",
    url: "https://x.com/i/web/status/1",
    context: "c",
    timestamp: NOW - 3 * 60 * 60 * 1_000,
    author: "asker_one",
    replyCount: 0,
    subreddit: "x",
    sourceText: "Is there an app that tracks my LLM spend? I keep blowing through my quota.",
    ...over,
  } as DemandCandidate;
}

function fakeJev(
  answers: Partial<{ buyerAsk: number; specific: number; kind: string }> = {},
  opts: { fail?: boolean; failCall?: number } = {},
) {
  const asked: { state: unknown; ids: string[] }[] = [];
  const client: JevClient = {
    async ask(state, questions) {
      asked.push({ state, ids: Object.keys(questions as Record<string, JevQuestion>) });
      if (opts.fail) throw new Error("jev down");
      if (opts.failCall === asked.length) throw new Error("jev 429");
      const out: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(questions as Record<string, JevQuestion>)) {
        if (q.type === "noul") {
          out[id] = { type: "noul", noul: id === "buyerAsk" ? answers.buyerAsk ?? 0.9 : answers.specific ?? 0.9 };
        } else {
          const options = Object.keys(q.criteria);
          const choice = answers.kind ?? "mobile app";
          const probabilities: Record<string, number> = {};
          for (const o of options) probabilities[o] = o === choice ? 0.8 : 0.2 / (options.length - 1);
          out[id] = { type: "choice", choice, probabilities, confidence: 0.8 };
        }
      }
      return { model: "jev-1.13.0", answers: out, usage: { input_tokens: 1, output_tokens: 0 } } as JevResponse<
        typeof questions
      >;
    },
  };
  return { client, asked };
}

test("the quote is the post's own text, so it cannot be non-verbatim", () => {
  const c = candidate();
  assert.equal(quoteFromCandidate(c), c.sourceText.replace(/\s+/gu, " "));
  // The old pipeline asked a model for a quote and then checked it was a substring. There is
  // nothing left to check: the quote IS the substring.
  assert.ok(c.sourceText.includes(quoteFromCandidate(c).replace(/\.\.\.$/u, "")));
});

test("a long post is trimmed on a word boundary, never mid-word", () => {
  const long = `${"word ".repeat(200)}end`;
  const q = quoteFromCandidate({ sourceText: long, title: "t" });
  assert.ok(q.length <= JEV_MAX_QUOTE_CHARS + 4, `got ${q.length}`);
  assert.match(q, /\.\.\.$/u);
  assert.doesNotMatch(q, / \.\.\.$/u);
});

test("the question state carries the post text, never the author or the permalink", async () => {
  // Jev is asked about the words, not about who wrote them: less to leak, and identity is not
  // evidence of demand.
  const { client, asked } = fakeJev();
  const c = candidate();
  await classifyDemandWithJev(client, [c], "2026-09-17", NOW, {}, quiet);
  const sent = JSON.stringify(asked[0]?.state);
  assert.match(sent, /LLM spend/);
  assert.equal(sent.includes(c.author), false);
  assert.equal(sent.includes(c.url), false);
});

test("a buyer ask becomes an ask with metadata taken from the stored candidate", async () => {
  const { client, asked } = fakeJev({ kind: "web app" });
  const c = candidate();
  const out = await classifyDemandWithJev(client, [c], "2026-09-17", NOW, {}, quiet);
  assert.equal(out.asks.length, 1);
  const ask = out.asks[0];
  // Every one of these was a field the LLM had to echo back correctly, and any mismatch dropped
  // the whole ask. They now come from the candidate and cannot disagree.
  assert.equal(ask?.author, c.author);
  assert.equal(ask?.askedAt, c.timestamp);
  assert.equal(ask?.replyCount, c.replyCount);
  assert.equal(ask?.permalink, c.url);
  assert.equal(ask?.subreddit, c.subreddit);
  assert.equal(ask?.source, c.source);
  assert.equal(ask?.day, "2026-09-17");
  assert.match(ask?.askedFor ?? "", /^web app: /);
  assert.equal(out.nonVerbatimQuoteCount, 0);
  assert.deepEqual(asked[0]?.ids.sort(), ["buyerAsk", "kind", "specific"]);
});

test("a post that is not asking for a product is a non-buyer, not an ask", async () => {
  const { client } = fakeJev({ buyerAsk: JEV_MIN_BUYER_ASK - 0.01 });
  const out = await classifyDemandWithJev(client, [candidate()], "2026-09-17", NOW, {}, quiet);
  assert.deepEqual(out.asks, []);
  assert.equal(out.nonBuyerCount, 1);
  assert.equal(out.vagueCount, 0);
});

test("a fragment that names nothing is counted as vague, separately from non-buyers", async () => {
  // "Or is there a tool for that?" scored 92 under the old freshness-and-silence score. This is
  // the first signal that can reject it on its first sighting.
  const { client } = fakeJev({ specific: JEV_MIN_SPECIFICITY - 0.01 });
  const out = await classifyDemandWithJev(
    client,
    [candidate({ sourceText: "Or is there a tool for that?" })],
    "2026-09-17",
    NOW,
    {},
    quiet,
  );
  assert.deepEqual(out.asks, []);
  assert.equal(out.vagueCount, 1);
  assert.equal(out.nonBuyerCount, 0);
});

test("the thresholds admit a post exactly at the line", async () => {
  const { client } = fakeJev({ buyerAsk: JEV_MIN_BUYER_ASK, specific: JEV_MIN_SPECIFICITY });
  const out = await classifyDemandWithJev(client, [candidate()], "2026-09-17", NOW, {}, quiet);
  assert.equal(out.asks.length, 1);
});

test("one failed candidate is counted and the rest of the sweep still classifies", async () => {
  const { client } = fakeJev({}, { failCall: 1 });
  const out = await classifyDemandWithJev(
    client,
    [candidate(), candidate({ url: "https://x.com/i/web/status/2", author: "two" })],
    "2026-09-17",
    NOW,
    {},
    quiet,
  );
  assert.equal(out.asks.length, 1);
  assert.equal(out.malformedOutputCount, 1);
});

test("a credential in the author's own text is still blocked before storage", async () => {
  const secret = fakeApiKey();
  const { client } = fakeJev();
  const out = await classifyDemandWithJev(
    client,
    [candidate({ sourceText: `is this key valid ${secret}` })],
    "2026-09-17",
    NOW,
    {},
    quiet,
  );
  assert.deepEqual(out.asks, []);
  assert.equal(out.leakyCount, 1);
});

test("two posts asking the same thing in the same words share a topic hash", async () => {
  const { client } = fakeJev();
  const out = await classifyDemandWithJev(
    client,
    [candidate(), candidate({ url: "https://x.com/i/web/status/2", author: "two" })],
    "2026-09-17",
    NOW,
    {},
    quiet,
  );
  assert.equal(out.asks.length, 2);
  assert.equal(out.asks[0]?.topicHash, out.asks[1]?.topicHash);
});

test("every ask kind in the taxonomy has a description Jev can choose from", () => {
  for (const [kind, description] of Object.entries(DEMAND_ASK_KINDS)) {
    assert.ok(description.length > 10, `${kind} needs a usable description`);
  }
});

test("the sweep classifies inline and the handoff skips the model classifier (structural)", () => {
  // Mutation testing in this repo has shown unit tests alone do not prove wiring.
  const runtime = readFileSync(new URL("./demand-runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /classifyDemandWithJev\(/);
  assert.match(runtime, /jevClassified/);
  const schedule = readFileSync(new URL("../schedules/demand-sweep.ts", import.meta.url), "utf8");
  assert.match(schedule, /demandSweepThemeOnlyMessage\(prepared\)/);
  // The language-model path stays as the fallback while Jev has no track record here.
  assert.match(schedule, /demandSweepHandoffMessage\(prepared\)/);
  assert.match(runtime, /the language-model path remains the fallback/);
});
