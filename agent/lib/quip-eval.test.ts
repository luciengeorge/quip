import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { JevClient, JevQuestion, JevResponse } from "./jev.ts";
import {
  AUDIT_INTERVAL_MS,
  AUDIT_SAMPLE_SIZE,
  auditDue,
  auditSample,
  LABEL_GOOD_AT,
  LABEL_RUBRIC,
  scoreAudit,
  scoreThemeLabel,
  summariseLabelQuality,
} from "./quip-eval.ts";

const NOW = Date.parse("2026-09-17T12:00:00Z");
const quiet = { warn: () => {} };

function fakeJev(score = 2.7, fail = false) {
  const asked: { state: unknown; ids: string[] }[] = [];
  const client: JevClient = {
    async ask(state, questions) {
      asked.push({ state, ids: Object.keys(questions as Record<string, JevQuestion>) });
      if (fail) throw new Error("jev down");
      const probabilities: Record<string, number> = {};
      for (let i = 0; i < LABEL_RUBRIC.length; i += 1) probabilities[String(i)] = 1 / LABEL_RUBRIC.length;
      return {
        model: "jev-1.13.0",
        answers: { quality: { type: "score", score, legend: {}, probabilities, confidence: 0.8 } },
        usage: { input_tokens: 1, output_tokens: 0 },
      } as JevResponse<typeof questions>;
    },
  };
  return { client, asked };
}

test("a label is scored against the rubric, with the posts it has to group", async () => {
  const { client, asked } = fakeJev(2.8);
  const out = await scoreThemeLabel(client, { label: "LLM token spend visibility", quotes: ["where do my tokens go?"] }, quiet);
  assert.equal(out?.score, 2.8);
  assert.equal(out?.model, "jev-1.13.0");
  const sent = JSON.stringify(asked[0]?.state);
  assert.match(sent, /LLM token spend visibility/);
  assert.match(sent, /where do my tokens go/);
});

test("a Jev failure leaves the label unscored rather than scoring it zero", async () => {
  // Zero would read as a bad label. Unscored is the truth and keeps it out of the mean.
  const { client } = fakeJev(0, true);
  assert.equal(await scoreThemeLabel(client, { label: "x", quotes: [] }, quiet), undefined);
});

test("the summary separates usable labels from ones too vague to group by, and names them", () => {
  const s = summariseLabelQuality([
    { label: "LLM token spend visibility", labelQuality: 2.9 },
    { label: "Apps", labelQuality: 0.8 },
    { label: "is there an app for the cab?", labelQuality: 0.2 },
    { label: "unscored" },
  ]);
  assert.equal(s?.scored, 3);
  assert.equal(s?.good, 1);
  assert.equal(s?.poor, 2);
  // Worst first: the one most worth fixing is the one you see.
  assert.deepEqual(s?.poorLabels, ["is there an app for the cab?", "Apps"]);
  assert.ok((s?.meanScore ?? 0) < LABEL_GOOD_AT);
  assert.equal(summariseLabelQuality([{ label: "none" }]), null);
});

test("an audit is due only once a week", () => {
  // Literal days, not the constant: comparing the constant with itself passes whatever it is set
  // to, and the cadence is the point. Weekly keeps the auditor's cost negligible and its sample
  // meaningful; daily would audit the same handful of asks over and over.
  const DAY = 86_400_000;
  assert.equal(AUDIT_INTERVAL_MS, 7 * DAY);
  assert.equal(auditDue(undefined, NOW), true);
  assert.equal(auditDue(NOW - 7 * DAY, NOW), true);
  assert.equal(auditDue(NOW - 7 * DAY + 1, NOW), false);
  assert.equal(auditDue(NOW - 6 * DAY, NOW), false);
});

test("the sample is deterministic and spread across the window", () => {
  const asks = Array.from({ length: 40 }, (_v, i) => ({ permalink: `p${i}`, quote: `q${i}` }));
  const a = auditSample(asks);
  const b = auditSample(asks);
  assert.equal(a.length, AUDIT_SAMPLE_SIZE);
  // Deterministic, so two audits of the same asks can be compared with each other.
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map((s) => s.permalink)).size, AUDIT_SAMPLE_SIZE);
  assert.deepEqual(auditSample(asks.slice(0, 3)).length, 3);
});

test("the auditor disagreeing is the finding, and it is named", () => {
  const sample = [
    { permalink: "a", quote: "q" },
    { permalink: "b", quote: "q" },
    { permalink: "c", quote: "q" },
  ];
  const out = scoreAudit(sample, [
    { permalink: "a", buyerAsk: true },
    { permalink: "b", buyerAsk: false },
    { permalink: "c", buyerAsk: true },
  ]);
  assert.equal(out.sampled, 3);
  assert.equal(out.agreed, 2);
  assert.equal(out.agreementRate, 0.67);
  assert.deepEqual(out.disputed, ["b"]);
});

test("verdicts for asks outside the sample cannot move the rate", () => {
  const out = scoreAudit([{ permalink: "a", quote: "q" }], [
    { permalink: "a", buyerAsk: false },
    { permalink: "not-sampled", buyerAsk: true },
  ]);
  assert.equal(out.sampled, 1);
  assert.equal(out.agreed, 0);
  assert.equal(out.agreementRate, 0);
});

test("an audit that judged nothing is zero, never a perfect score", () => {
  // The tempting default is 1.0 ("no disagreements"). An audit that did not happen is not a pass.
  const out = scoreAudit([{ permalink: "a", quote: "q" }], []);
  assert.equal(out.sampled, 0);
  assert.equal(out.agreementRate, 0);
});

test("Jev never grades its own classification (structural)", () => {
  // The whole point of the audit. If this ever becomes a Jev call, the eval is self-marking.
  const runtime = readFileSync(new URL("./demand-runtime.ts", import.meta.url), "utf8");
  const auditFn = runtime.slice(runtime.indexOf("export async function classificationAuditSample"));
  const auditBody = auditFn.slice(0, auditFn.indexOf("export async function recordClassificationAudit"));
  // Match INVOCATIONS, not the word: the doc comment in that function explains this very rule.
  for (const call of [/jevFromEnv\(/, /\.ask\(/, /classifyDemandWithJev\(/, /scoreThemeLabel\(/, /researchIncumbentsWithJev\(/]) {
    assert.doesNotMatch(auditBody, call, `the audit path must not call Jev: found ${call}`);
  }
  // The label scorer is allowed to be Jev: a language model wrote the label.
  assert.match(runtime, /scoreThemeLabel\(labelJev/);
  const schedule = readFileSync(new URL("../schedules/demand-sweep.ts", import.meta.url), "utf8");
  assert.match(schedule, /classification_audit/);
  assert.match(schedule, /record_classification_audit/);
  assert.match(schedule, /Jev cannot be the judge/);
});
