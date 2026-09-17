/**
 * Minimal client for TypeSafe's System One endpoint (the model is "Jev").
 *
 * WHAT IT IS FOR HERE. Jev answers typed questions over text and returns calibrated probabilities
 * at $0.042 per million input tokens with free output. Quip's pipeline is almost entirely such
 * questions: is this post someone asking for a product, does this product cover that want, is this
 * lesson durable. Those do not need a model that writes prose, and a model that writes prose has
 * repeatedly cost us evidence: the LLM classifier had to echo six stored fields back verbatim and
 * we dropped real asks whenever it paraphrased one.
 *
 * WHAT IT IS NOT FOR. Anything genuinely generative. Jev cannot name a theme, so that one step
 * keeps a language model. Everything Jev returns is either a decision a rule then acts on, or an
 * annotation recorded for comparison.
 *
 * Raw fetch rather than the SDK, matching how every other provider in agent/lib is wired: one
 * fewer dependency, and the whole request shape is visible in this file.
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/**
 * Pinned, not the `jev-latest` alias. We are MEASURING calibration, and a measurement against a
 * model that can change underneath us without a change on our side is not a measurement. The
 * response also reports which version answered, and that is stored beside every shadow forecast.
 */
export const JEV_MODEL = "jev-1.13.0";
export const JEV_TIMEOUT_MS = 8_000;

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

/** An ordered rubric. `criteria` is the level descriptions, lowest first, at least two. */
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted across the levels, so it can land between them. */
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevResponse<Q extends Record<string, JevQuestion>> {
  model: string;
  answers: {
    [K in keyof Q]: Q[K] extends NoulQuestion
      ? NoulAnswer
      : Q[K] extends ScoreQuestion
        ? ScoreAnswer
        : ChoiceAnswer;
  };
  usage: { input_tokens: number; output_tokens: number };
}

/** Text-only, as the API requires: a string, or an object/array of strings. */
export type JevState = string | Record<string, unknown> | unknown[];

export interface JevClient {
  ask<Q extends Record<string, JevQuestion>>(state: JevState, questions: Q): Promise<JevResponse<Q>>;
}

export class JevError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "JevError";
    this.status = status;
  }
}

function isFiniteUnit(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
}

/**
 * Validate the answer for one question. A malformed answer is an error, not a default: a missing
 * probability quietly becoming 0.5 would be recorded as a forecast and scored as one.
 */
function validateAnswer(id: string, question: JevQuestion, raw: unknown): JevAnswer {
  if (typeof raw !== "object" || raw === null) throw new JevError(`answer ${id}: not an object`);
  const a = raw as Record<string, unknown>;
  if (question.type === "noul") {
    if (a.type !== "noul" || !isFiniteUnit(a.noul)) throw new JevError(`answer ${id}: malformed noul`);
    return { type: "noul", noul: a.noul };
  }
  if (question.type === "score") {
    if (a.type !== "score" || typeof a.score !== "number" || !Number.isFinite(a.score) || !isFiniteUnit(a.confidence)) {
      throw new JevError(`answer ${id}: malformed score`);
    }
    // The score must land inside the rubric it was given. A value outside it is not a level.
    if (a.score < 0 || a.score > question.criteria.length - 1) {
      throw new JevError(`answer ${id}: score ${a.score} outside the rubric`);
    }
    const probs: Record<string, number> = {};
    const raw = (a.probabilities ?? {}) as Record<string, unknown>;
    for (let level = 0; level < question.criteria.length; level += 1) {
      const p = raw[String(level)];
      if (!isFiniteUnit(p)) throw new JevError(`answer ${id}: probability missing for level ${level}`);
      probs[String(level)] = p;
    }
    return {
      type: "score",
      score: a.score,
      legend: (a.legend ?? {}) as Record<string, string>,
      probabilities: probs,
      confidence: a.confidence,
    };
  }
  if (a.type !== "choice" || typeof a.choice !== "string" || !isFiniteUnit(a.confidence)) {
    throw new JevError(`answer ${id}: malformed choice`);
  }
  const probabilities = a.probabilities;
  if (typeof probabilities !== "object" || probabilities === null) {
    throw new JevError(`answer ${id}: missing probabilities`);
  }
  const probs: Record<string, number> = {};
  for (const option of Object.keys(question.criteria)) {
    const p = (probabilities as Record<string, unknown>)[option];
    if (!isFiniteUnit(p)) throw new JevError(`answer ${id}: probability missing for ${option}`);
    probs[option] = p;
  }
  if (!(a.choice in question.criteria)) throw new JevError(`answer ${id}: choice outside criteria`);
  return { type: "choice", choice: a.choice, probabilities: probs, confidence: a.confidence };
}

export class HttpJevClient implements JevClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(
    apiKey: string,
    fetchImpl: typeof fetch = fetch,
    model: string = JEV_MODEL,
    timeoutMs: number = JEV_TIMEOUT_MS,
  ) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async ask<Q extends Record<string, JevQuestion>>(state: JevState, questions: Q): Promise<JevResponse<Q>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ state, model: this.model, questions }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new JevError(`Jev HTTP ${res.status}`, res.status);
    const body = (await res.json()) as { model?: unknown; answers?: unknown; usage?: unknown };
    if (typeof body.model !== "string" || typeof body.answers !== "object" || body.answers === null) {
      throw new JevError("Jev response missing model or answers");
    }
    const answers: Record<string, JevAnswer> = {};
    for (const [id, question] of Object.entries(questions)) {
      answers[id] = validateAnswer(id, question, (body.answers as Record<string, unknown>)[id]);
    }
    const usage = (body.usage ?? {}) as { input_tokens?: unknown; output_tokens?: unknown };
    return {
      model: body.model,
      answers: answers as JevResponse<Q>["answers"],
      usage: {
        input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
        output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      },
    };
  }
}

/**
 * Null when unconfigured. Every caller treats null as "no annotation" and carries on, the same
 * way an absent X or Exa key degrades elsewhere: Jev is an observer here and its absence must
 * never change what the agent can do.
 */
export function jevFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl?: typeof fetch,
): JevClient | null {
  const key = env.TYPESAFE_API_KEY?.trim();
  if (!key) return null;
  return new HttpJevClient(key, fetchImpl);
}
