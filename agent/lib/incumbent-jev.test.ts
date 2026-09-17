import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { BUILD_COMPONENT_COSTS, calculateBuildEstimate } from "./build-cost.ts";
import {
  BUILD_COMPONENT_QUESTIONS,
  coverageFrom,
  INCUMBENT_COVERS_AT,
  INCUMBENT_MAX_REPORTED,
  INCUMBENT_MIN_RELEVANCE,
  judgeIncumbent,
  namesAProduct,
  researchIncumbentsWithJev,
  summaryFrom,
  type IncumbentCandidate,
  type IncumbentVerdict,
} from "./incumbent-jev.ts";
import type { JevClient, JevQuestion, JevResponse } from "./jev.ts";

const quiet = { warn: () => {} };

function verdict(over: Partial<IncumbentVerdict> = {}): IncumbentVerdict {
  return { name: "Helicone", url: "https://h", serves: 0.2, relevant: 0.9, ...over };
}

function product(name: string): IncumbentCandidate {
  return { name, url: `https://${name}`, text: `${name} does something` };
}

/** Answers keyed by question id; components default to no so a test names what it wants. */
function fakeJev(
  byProduct: Record<string, { serves: number; relevant: number }> = {},
  components: string[] = [],
  opts: { failProduct?: string; failComponents?: boolean } = {},
) {
  const asked: { state: unknown; ids: string[] }[] = [];
  const client: JevClient = {
    async ask(state, questions) {
      const ids = Object.keys(questions as Record<string, JevQuestion>);
      asked.push({ state, ids });
      const s = state as { product?: { name: string }; want?: string };
      if (s.product && opts.failProduct === s.product.name) throw new Error("jev 429");
      if (!s.product && opts.failComponents) throw new Error("jev down");
      const out: Record<string, unknown> = {};
      for (const id of ids) {
        if (s.product) {
          const v = byProduct[s.product.name] ?? { serves: 0.1, relevant: 0.9 };
          out[id] = { type: "noul", noul: id === "serves" ? v.serves : v.relevant };
        } else {
          out[id] = { type: "noul", noul: components.includes(id) ? 0.9 : 0.1 };
        }
      }
      return { model: "jev-1.13.0", answers: out, usage: { input_tokens: 1, output_tokens: 0 } } as JevResponse<
        typeof questions
      >;
    },
  };
  return { client, asked };
}

test("coverage needs one product that actually serves the want", () => {
  // Five products that each do a third of the job is a gap, however crowded it looks.
  assert.equal(coverageFrom([verdict({ serves: 0.5 }), verdict({ serves: 0.55 }), verdict({ serves: 0.4 })]), "partial");
  assert.equal(coverageFrom([verdict({ serves: INCUMBENT_COVERS_AT })]), "covers");
  assert.equal(coverageFrom([verdict({ serves: INCUMBENT_COVERS_AT - 0.01 })]), "partial");
});

test("an irrelevant result is not an incumbent at all", () => {
  assert.equal(coverageFrom([verdict({ relevant: INCUMBENT_MIN_RELEVANCE - 0.01, serves: 0.99 })]), "none");
  assert.equal(coverageFrom([]), "none");
});

test("the summary is assembled from the numbers, so it stays short and cannot be truncated", () => {
  const long = summaryFrom("a tool that shows where LLM tokens go", "partial", [
    verdict({ name: "Helicone", serves: 0.5 }),
    verdict({ name: "Langfuse", serves: 0.3 }),
  ]);
  // The subagent's prose ran to 600 characters and was severed mid-word.
  assert.ok(long.length < 200, `summary was ${long.length} chars`);
  assert.match(long, /Helicone/);
  assert.doesNotMatch(long, /\.\.\.$/u);
  assert.match(summaryFrom("x", "none", []), /^Nothing found/);
  assert.match(summaryFrom("x", "covers", [verdict({ name: "Shazam", serves: 0.9 })]), /Shazam already serves/);
});

test("every build question names a component the estimator can actually price", () => {
  // The "~0 days" bug was a model inventing component names the pricing table did not have.
  for (const component of Object.keys(BUILD_COMPONENT_QUESTIONS)) {
    assert.ok(component in BUILD_COMPONENT_COSTS, `${component} is not in the pricing table`);
  }
  // Each name individually prices. A list of ALL of them deliberately does NOT: that totals well
  // past the estimator's cap, which is the estimator correctly refusing to call a 23-day project
  // a quick build, and the renderer then prints no estimate rather than a wrong one.
  for (const component of Object.keys(BUILD_COMPONENT_QUESTIONS)) {
    assert.equal(calculateBuildEstimate([component]).ok, true, `${component} must price on its own`);
  }
  assert.equal(calculateBuildEstimate(Object.keys(BUILD_COMPONENT_QUESTIONS)).ok, false);
});

test("research judges each product and returns a priceable component list", async () => {
  const { client, asked } = fakeJev(
    { Helicone: { serves: 0.3, relevant: 0.9 }, Langfuse: { serves: 0.2, relevant: 0.8 } },
    ["auth", "third-party API integration"],
  );
  const out = await researchIncumbentsWithJev(client, "LLM token spend visibility", [product("Helicone"), product("Langfuse")], quiet);
  assert.equal(out.incumbentCoverage, "partial");
  assert.equal(out.judged, 2);
  assert.deepEqual(out.buildComponents.sort(), ["auth", "third-party API integration"]);
  assert.equal(calculateBuildEstimate(out.buildComponents).ok, true);
  assert.equal(out.incumbents.length, 2);
  assert.equal(out.sources.length, 2);
  // One call per product plus one for the whole component list.
  assert.equal(asked.length, 3);
});

test("one failed product is skipped and the rest still decide coverage", async () => {
  const { client } = fakeJev({ Good: { serves: 0.8, relevant: 0.9 } }, [], { failProduct: "Bad" });
  const out = await researchIncumbentsWithJev(client, "want", [product("Bad"), product("Good")], quiet);
  assert.equal(out.judged, 1);
  assert.equal(out.incumbentCoverage, "covers");
});

test("failed build questions leave the list empty rather than guessing", async () => {
  // An empty list produces no estimate downstream, and the renderer prints nothing. A wrong
  // estimate would print "~0 days", which reads as trivial to build.
  const { client } = fakeJev({ A: { serves: 0.2, relevant: 0.9 } }, [], { failComponents: true });
  const out = await researchIncumbentsWithJev(client, "want", [product("A")], quiet);
  assert.deepEqual(out.buildComponents, []);
  assert.equal(calculateBuildEstimate(out.buildComponents).ok, false);
});

test("the reported incumbent list is capped and ordered by how well it serves", async () => {
  const many = Array.from({ length: INCUMBENT_MAX_REPORTED + 3 }, (_v, i) => product(`P${i}`));
  const byProduct = Object.fromEntries(many.map((p, i) => [p.name, { serves: i / 100, relevant: 0.9 }]));
  const { client } = fakeJev(byProduct, []);
  const out = await researchIncumbentsWithJev(client, "want", many, quiet);
  assert.equal(out.incumbents.length, INCUMBENT_MAX_REPORTED);
  assert.equal(out.incumbents[0]?.name, `P${many.length - 1}`);
});

test("the want and the product description are what Jev is shown", async () => {
  const { client, asked } = fakeJev({ Helicone: { serves: 0.3, relevant: 0.9 } }, []);
  await judgeIncumbent(client, "LLM token spend visibility", product("Helicone"));
  const sent = JSON.stringify(asked[0]?.state);
  assert.match(sent, /LLM token spend visibility/);
  assert.match(sent, /Helicone/);
  assert.deepEqual(asked[0]?.ids.sort(), ["relevant", "serves"]);
});

test("the theme pass researches inline and removes those themes from the model's list (structural)", () => {
  // Mutation testing in this repo has shown unit tests alone do not prove wiring.
  const runtime = readFileSync(new URL("./demand-runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /researchIncumbentsWithJev\(/);
  assert.match(runtime, /searchIncumbents\(/);
  assert.match(runtime, /needing\.filter\(\(theme\) => !researchedKeys\.has\(theme\.themeKey\)\)/);
  // The subagent path stays for when Jev or Exa is unconfigured.
  const schedule = readFileSync(new URL("../schedules/demand-sweep.ts", import.meta.url), "utf8");
  assert.match(schedule, /demand_viability/);
});

test("a page title that names no product is not printed as an incumbent", () => {
  // A live run produced "Welcome to: serves this want as described".
  assert.equal(namesAProduct("Welcome to"), false);
  assert.equal(namesAProduct("Home"), false);
  assert.equal(namesAProduct("Untitled"), false);
  assert.equal(namesAProduct("404"), false);
  // Not a length rule: short real product names survive.
  assert.equal(namesAProduct("X"), true);
  assert.equal(namesAProduct("Vi"), true);
  assert.equal(namesAProduct("  "), false);
  assert.equal(namesAProduct("---"), false);
  assert.equal(namesAProduct("Synic – Offline Music Player"), true);
  assert.equal(namesAProduct("Helicone"), true);
});

test("an unnameable result still counts toward coverage, it just is not named", async () => {
  // Coverage rests on the probabilities, not the titles. Dropping the row entirely would change
  // the verdict because of a page's title tag, which is the wrong thing to be sensitive to.
  const { client } = fakeJev({ "Welcome to": { serves: 0.9, relevant: 0.9 } }, []);
  const out = await researchIncumbentsWithJev(client, "ad-free music apps", [product("Welcome to")], quiet);
  assert.equal(out.incumbentCoverage, "covers");
  assert.equal(out.judged, 1);
  assert.deepEqual(out.incumbents, []);
  assert.deepEqual(out.sources, []);
  assert.match(out.researchSummary, /did not name it clearly/);
});

test("the summary names the best product that can actually be named", async () => {
  const { client } = fakeJev(
    { "Welcome to": { serves: 0.95, relevant: 0.9 }, Synic: { serves: 0.8, relevant: 0.9 } },
    [],
  );
  const out = await researchIncumbentsWithJev(client, "want", [product("Welcome to"), product("Synic")], quiet);
  assert.match(out.researchSummary, /^Synic already serves/);
  assert.equal(out.incumbents.length, 1);
});

test("a partial summary stays true when nothing can be named", () => {
  const s = summaryFrom("want", "partial", [verdict({ name: "Home" }), verdict({ name: "Welcome to" })]);
  assert.match(s, /^2 products address this space but none serves the want on its own\.$/);
});

test("the summary counts every relevant product, including ones it cannot name", async () => {
  // Naming is cosmetic; the count is evidence. Filtering unnameable results out of the evidence
  // would understate how crowded a space is because of a page's title tag.
  const { client } = fakeJev(
    { "Welcome to": { serves: 0.3, relevant: 0.9 }, Synic: { serves: 0.4, relevant: 0.9 } },
    [],
  );
  const out = await researchIncumbentsWithJev(client, "want", [product("Welcome to"), product("Synic")], quiet);
  assert.equal(out.incumbentCoverage, "partial");
  assert.match(out.researchSummary, /^2 products address this space/);
  assert.match(out.researchSummary, /the closest is Synic\.$/);
  assert.equal(out.incumbents.length, 1);
});
