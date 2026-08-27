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
  '{ "type": "object", "additionalProperties": false, "required": ["classifications"], "properties": { "classifications": { "type": "array", "maxItems": 30, "items": { "oneOf": [ { "type": "object", "additionalProperties": false, "required": ["buyerAsk"], "properties": { "buyerAsk": { "const": false } } }, { "type": "object", "additionalProperties": false, "required": ["buyerAsk", "author", "askedAt", "quote", "replyCount", "permalink", "subreddit", "askedFor"], "properties": { "buyerAsk": { "const": true }, "author": { "type": "string" }, "askedAt": { "type": "integer" }, "quote": { "type": "string" }, "replyCount": { "type": "integer" }, "permalink": { "type": "string" }, "subreddit": { "type": "string" }, "askedFor": { "type": "string" } } } ] } } }';

export function demandSweepHandoffMessage(prepared: PreparedDemandSweep): string {
  return [
    "Run the buyer-intent demand classification as evidence only. Never draft a reply, send a message, post, or pitch a product.",
    "The prepared value below is sealed. Preserve it unchanged, classify only its candidates, and never add, remove, or edit a candidate.",
    "Prepared sweep:",
    "```json",
    JSON.stringify(prepared),
    "```",
    "1. Call demand_ask_classifier exactly once with the sealed plan candidates in order. Supply this strict output schema: " +
      CLASSIFIER_OUTPUT_SCHEMA +
      ". Do not call it for any candidate outside the sealed plan.",
    "2. Call complete_demand_sweep exactly once with the unchanged prepared value and the classifier's classifications.",
    "3. Return no public-facing text.",
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
    if (prepared.sourceStatus !== "available" || prepared.plan.candidates.length === 0) {
      logger.log(
        `[demand-sweep] classifier handoff skipped; status=${prepared.sourceStatus}; candidates=${prepared.plan.candidates.length}`,
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
