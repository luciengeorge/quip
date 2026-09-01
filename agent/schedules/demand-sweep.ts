import { defineSchedule, type ScheduleHandlerArgs } from "eve/schedules";

import slack from "../channels/slack.ts";
import {
  runDemandSweepFromEnv,
  type PreparedDemandSweep,
} from "../lib/demand-runtime.ts";

type Env = Readonly<Record<string, string | undefined>>;
type ScheduleArgs = Pick<ScheduleHandlerArgs, "to" | "waitUntil" | "appAuth">;
type DemandSweepRunner = () => Promise<PreparedDemandSweep>;

interface DemandSweepScheduleDependencies {
  env?: Env;
  logger?: Pick<Console, "log" | "warn">;
  runDemandSweep?: DemandSweepRunner;
}

const CLASSIFIER_OUTPUT_SCHEMA =
  '{ "type": "object", "additionalProperties": false, "required": ["classifications"], "properties": { "classifications": { "type": "array", "maxItems": 30, "items": { "oneOf": [ { "type": "object", "additionalProperties": false, "required": ["buyerAsk", "permalink"], "properties": { "buyerAsk": { "const": false }, "permalink": { "type": "string" } } }, { "type": "object", "additionalProperties": false, "required": ["buyerAsk", "author", "askedAt", "quote", "replyCount", "permalink", "subreddit", "askedFor"], "properties": { "buyerAsk": { "const": true }, "author": { "type": "string" }, "askedAt": { "type": "integer" }, "quote": { "type": "string" }, "replyCount": { "type": "integer" }, "permalink": { "type": "string" }, "subreddit": { "type": "string" }, "askedFor": { "type": "string" } } } ] } } }';

export function demandSweepHandoffMessage(prepared: PreparedDemandSweep): string {
  if (!prepared.planId) throw new Error("Demand candidate plan was not stored");
  return [
    "Run the buyer-intent demand classification as evidence only. Never draft a reply, send a message, post, or pitch a product.",
    `The sealed candidate plan is stored server-side under id ${prepared.planId}. Do not reproduce, edit, or return the plan.`,
    "1. Call get_demand_candidate_plan exactly once with that id. It returns the bounded fetched candidates for classification only.",
    "2. Call demand_ask_classifier exactly once with those candidates. Classify every returned candidate once, keyed by its exact permalink. Supply this strict output schema: " +
      CLASSIFIER_OUTPUT_SCHEMA +
      ". Do not call it for any candidate outside the sealed plan.",
    `3. Call complete_demand_sweep exactly once with planId ${prepared.planId} and the classifier's classifications.`,
    "4. Return no public-facing text.",
  ].join("\n");
}

export async function runDemandSweepSchedule(
  { to, waitUntil, appAuth }: ScheduleArgs,
  dependencies: DemandSweepScheduleDependencies = {},
): Promise<void> {
  const env = dependencies.env ?? process.env;
  const logger = dependencies.logger ?? console;
  const runDemandSweep = dependencies.runDemandSweep ?? runDemandSweepFromEnv;
  try {
    const prepared = await runDemandSweep();
    logger.log(
      `[demand-sweep] stored ${prepared.plan.candidates.length} candidates; status=${prepared.sourceStatus}; reddit=${prepared.redditSourceStatus}; stackexchange=${prepared.stackExchangeSourceStatus}`,
    );
    for (const message of prepared.messages) logger.warn(`[demand-sweep] ${message}`);

    const channelId = env.SLACK_CHANNEL_ID?.trim();
    if (!channelId) {
      logger.warn("[demand-sweep] Slack handoff skipped: SLACK_CHANNEL_ID is not set.");
      return;
    }
    if (
      prepared.sourceStatus !== "available" ||
      prepared.plan.candidates.length === 0 ||
      !prepared.planId
    ) {
      logger.log(
        `[demand-sweep] classifier handoff skipped; status=${prepared.sourceStatus}; candidates=${prepared.plan.candidates.length}; stored=${Boolean(prepared.planId)}`,
      );
      return;
    }
    waitUntil(
      to(slack, { channelId })
        .send(demandSweepHandoffMessage(prepared), { auth: appAuth })
        .catch((error: unknown) => {
          logger.warn("[demand-sweep] Slack handoff failed cleanly:", error);
        }),
    );
  } catch (error) {
    logger.warn("[demand-sweep] daily sweep failed cleanly:", error);
  }
}

// 08:35 UTC is clear of poof's 15:00 UTC weekday cycle and 21:00 UTC Friday scorecard.
export default defineSchedule({
  cron: "35 8 * * *",
  async run(args) {
    await runDemandSweepSchedule(args);
  },
});
