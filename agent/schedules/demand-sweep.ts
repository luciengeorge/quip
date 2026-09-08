import { defineSchedule, type ScheduleHandlerArgs } from "eve/schedules";

import slack from "../channels/slack.ts";
import { recordScheduleRun, type RecordScheduleRunDependencies } from "../lib/cron-run.ts";
import { renderDemandSweepNotice } from "../lib/demand-report.ts";
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
  cronRun?: RecordScheduleRunDependencies;
}

const CLASSIFIER_OUTPUT_SCHEMA =
  '{ "type": "object", "additionalProperties": false, "required": ["classifications"], "properties": { "classifications": { "type": "array", "maxItems": 30, "items": { "oneOf": [ { "type": "object", "additionalProperties": false, "required": ["buyerAsk", "permalink"], "properties": { "buyerAsk": { "const": false }, "permalink": { "type": "string" } } }, { "type": "object", "additionalProperties": false, "required": ["buyerAsk", "author", "askedAt", "quote", "replyCount", "permalink", "subreddit", "askedFor"], "properties": { "buyerAsk": { "const": true }, "author": { "type": "string" }, "askedAt": { "type": "integer" }, "quote": { "type": "string" }, "replyCount": { "type": "integer" }, "permalink": { "type": "string" }, "subreddit": { "type": "string" }, "askedFor": { "type": "string" } } } ] } } }';

export function demandSweepHandoffMessage(prepared: PreparedDemandSweep): string {
  if (!prepared.planId) throw new Error("Demand candidate plan was not stored");
  return [
    "Run the buyer-intent demand classification as evidence only. Never draft a reply, contact an asker, post publicly, or pitch a product. The only text you may produce is the report this run returns to you.",
    `The sealed candidate plan is stored server-side under id ${prepared.planId}. Do not reproduce, edit, or return the plan.`,
    "1. Call get_demand_candidate_plan exactly once with that id. It returns the bounded fetched candidates for classification only.",
    "2. Call demand_ask_classifier exactly once with those candidates. Classify every returned candidate once, keyed by its exact permalink. Supply this strict output schema: " +
      CLASSIFIER_OUTPUT_SCHEMA +
      ". Do not call it for any candidate outside the sealed plan.",
    `3. Call complete_demand_sweep exactly once with planId ${prepared.planId} and the classifier's classifications.`,
    "4. Call assign_demand_themes once. Group every ask it returned in `newAsks` into a recurring want. Prefer an existing `themeKey` from `openThemes` whenever the want matches; open a `newLabel` only when none fits. A label names the want, not the post, for example \"LLM token spend visibility\", not \"someone asked about tokens\". An ask too vague to name a want gets its own label and will simply never recur.",
    "5. For each and only each entry in the returned `themesNeedingResearch`, delegate exactly once to the demand_viability subagent. Give it the theme label and its quotes. Set outputSchema to an object with all of: incumbentCoverage (one of \"covers\", \"partial\", \"none\"), incumbents (array of {name, covers}), researchSummary (string), sources (array of {url, claim}), buildComponents (array of strings). Do not research a theme outside that list and do not retry.",
    "6. Call record_theme_research once per researched theme with that themeKey and the subagent's output verbatim. The verdict is computed there, not by you.",
    "7. Call build_demand_report once, with no arguments.",
    "8. Post its returned `report` field exactly as given, and nothing else. Do not summarise it, reorder it, add to it, or comment on it.",
  ].join("\n");
}

/**
 * The handoff used when a sweep produced nothing to classify.
 *
 * A dark day used to be logged and nothing was posted, which is indistinguishable from the cron
 * never firing. That ambiguity is the reason this reporting exists, so a scan that found nothing
 * says so out loud.
 */
export function demandSweepNoticeMessage(day: string, reason: string): string {
  return [
    "Post the following text exactly as given, and nothing else. Do not summarise it, add to it, or comment on it.",
    "",
    renderDemandSweepNotice(day, reason),
  ].join("\n");
}

export async function runDemandSweepSchedule(
  { to, waitUntil, appAuth }: ScheduleArgs,
  dependencies: DemandSweepScheduleDependencies = {},
): Promise<void> {
  const env = dependencies.env ?? process.env;
  const logger = dependencies.logger ?? console;
  const runDemandSweep = dependencies.runDemandSweep ?? runDemandSweepFromEnv;
  await recordScheduleRun(
    "demand-sweep",
    async () => {
      try {
        const prepared = await runDemandSweep();
        logger.log(
          `[demand-sweep] stored ${prepared.plan.candidates.length} candidates; status=${prepared.sourceStatus}; reddit=${prepared.redditSourceStatus}; stackexchange=${prepared.stackExchangeSourceStatus}`,
        );
        for (const message of prepared.messages) logger.warn(`[demand-sweep] ${message}`);

        const channelId = env.SLACK_CHANNEL_ID?.trim();
        if (!channelId) {
          logger.warn("[demand-sweep] Slack handoff skipped: SLACK_CHANNEL_ID is not set.");
          return false;
        }
        const nothingToClassify =
          prepared.sourceStatus !== "available" ||
          prepared.plan.candidates.length === 0 ||
          !prepared.planId;
        if (nothingToClassify) {
          logger.log(
            `[demand-sweep] classifier handoff skipped; status=${prepared.sourceStatus}; candidates=${prepared.plan.candidates.length}; stored=${Boolean(prepared.planId)}`,
          );
        }
        const message = nothingToClassify
          ? demandSweepNoticeMessage(
              prepared.plan.day,
              prepared.sourceStatus !== "available"
                ? "no demand source was available"
                : prepared.plan.candidates.length === 0
                  ? "the sources returned no candidates"
                  : "the candidate plan could not be stored",
            )
          : demandSweepHandoffMessage(prepared);
        waitUntil(
          to(slack, { channelId })
            .send(message, { auth: appAuth })
            .catch((error: unknown) => {
              logger.warn("[demand-sweep] Slack handoff failed cleanly:", error);
            }),
        );
        return true;
      } catch (error) {
        logger.warn("[demand-sweep] daily sweep failed cleanly:", error);
        return false;
      }
    },
    dependencies.cronRun,
  );
}

// 08:35 UTC is clear of poof's 15:00 UTC weekday cycle and 21:00 UTC Friday scorecard.
export default defineSchedule({
  cron: "35 8 * * *",
  async run(args) {
    await runDemandSweepSchedule(args);
  },
});
