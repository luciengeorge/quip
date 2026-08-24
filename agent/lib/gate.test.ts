import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { checkDraft, type DraftGateOptions } from "./gate.ts";

function options(overrides: Partial<DraftGateOptions> = {}): DraftGateOptions {
  return {
    recent: [],
    config: { maxCharacters: 280, minimumCharacters: 10 },
    ...overrides,
  };
}

function rules(text: string, overrides: Partial<DraftGateOptions> = {}): string[] {
  return checkDraft(text, options(overrides)).failures.map((failure) => failure.rule);
}

test("checkDraft rejects text over the character limit", () => {
  assert.ok(rules("x".repeat(21), { config: { maxCharacters: 20 } }).includes("character-limit"));
});

test("checkDraft rejects an em dash character but permits a hyphen", () => {
  assert.ok(rules("A normal sentence with an \u2014 character.").includes("em-dash"));
  assert.deepEqual(checkDraft("A normal sentence with a hyphen.", options()).failures, []);
});

test("checkDraft rejects every configured banned phrase", () => {
  for (const phrase of [
    "game changer",
    "\u{1F9F5}",
    "Unpopular opinion:",
    "Let that sink in",
    "This changes everything",
  ]) {
    assert.ok(rules(`A public post says: ${phrase} today.`).includes("banned-phrase"), phrase);
  }
});

test("checkDraft rejects more than one hashtag", () => {
  assert.ok(rules("A detailed public post about #TypeScript and #Eve.").includes("hashtag-count"));
});

test("checkDraft rejects a URL used by a recent post", () => {
  assert.ok(
    rules("A considered post: https://example.com/repeated", {
      recent: [{ url: "https://example.com/repeated", topicHash: "different", postedAt: 1 }],
    }).includes("duplicate-url"),
  );
});

test("checkDraft rejects a topic hash used by a recent post", () => {
  assert.ok(
    rules("A considered public post.", {
      recent: [{ topicHash: "same-topic", postedAt: 1 }],
      config: { topicHash: "same-topic" },
    }).includes("duplicate-topic"),
  );
});

test("checkDraft applies the leak guard to generated text", () => {
  assert.ok(
    rules("This discusses private-project safely enough.", {
      config: { leakGuard: { internalTerms: ["private-project"] } },
    }).includes("leak"),
  );
});

test("checkDraft rejects empty and near-empty text", () => {
  assert.ok(rules("   ").includes("empty"));
  assert.ok(rules("too short").includes("empty"));
});

test("checkDraft reports every matching deterministic failure", () => {
  const result = checkDraft("Unpopular opinion: private-project #one #two \u2014", {
    recent: [{ topicHash: "same-topic", postedAt: 1 }],
    config: {
      maxCharacters: 20,
      topicHash: "same-topic",
      leakGuard: { internalTerms: ["private-project"] },
    },
  });

  assert.equal(result.pass, false);
  assert.deepEqual(
    result.failures.map((failure) => failure.rule),
    ["character-limit", "em-dash", "banned-phrase", "hashtag-count", "duplicate-topic", "leak"],
  );
});

test("checkDraft passes a clean, substantive draft", () => {
  assert.deepEqual(checkDraft("A concise observation about a public software release.", options()), {
    pass: true,
    failures: [],
  });
});

test("gate source imports no drafting or model modules", () => {
  const source = readFileSync(new URL("./gate.ts", import.meta.url), "utf8");
  const imports = source.match(/^import .*$/gm) ?? [];

  for (const statement of imports) {
    assert.doesNotMatch(statement, /(?:draft|model)/i, statement);
  }
});
