import { defineSchedule, type ScheduleHandlerArgs } from "eve/schedules";

import slack from "../channels/slack.ts";
import { recordScheduleRun, type RecordScheduleRunDependencies } from "../lib/cron-run.ts";
import { resolveDigestDelivery } from "../lib/digest-delivery.ts";
import { renderTrendDigest } from "../lib/trend-digest.ts";
import { weeklyTrendContextFromEnv } from "../lib/trend-runtime.ts";

const WEEKLY_DIGEST_PROMPT = [
  "Build this week's Quip trend digest.",
  "1. Call weekly_trend_context first.",
  "2. Propose zero to three ideas only from that measured context. Demand asks are evidence only, never an invitation to draft a reply, message a person, or pitch a product. When using demand evidence, use its permalink, reply total, distinct-asker total, and measured direction exactly as returned. Do not invent links, counts, or directions.",
  "3. Call screen_weekly_trend_ideas with those exact proposals. Its code-enforced researchRequests list excludes duplicates and is capped for this cycle.",
  "4. For each and only each researchRequest, delegate exactly once to the idea_research subagent. Give it the original proposal and rejection verbatim. Set outputSchema to a JSON-schema oneOf: either {revisedProposal:{title,trendTitle,mechanism,evidence,moatClass,buildComponents,ownerFit},researchSummary,sources:[{url,claim}]} with all fields required, or {noRevision:true,reason} with both fields required. Do not research a duplicate, do not retry, and do not call the subagent outside this list.",
  "5. Call build_weekly_trend_digest with the original proposals and researchAttempts shaped as {originalTitle, output}. It re-runs the same deterministic gate for every revision, persists topic hashes, and renders the final digest.",
  "6. Post exactly the returned digest and nothing else. If no idea passes, post its empty result without filling a slot.",
].join(" ");

type Env = Readonly<Record<string, string | undefined>>;
type ScheduleArgs = Pick<ScheduleHandlerArgs, "to" | "waitUntil" | "appAuth">;

interface WeeklyTrendDigestScheduleDependencies {
  env?: Env;
  logger?: Pick<Console, "log" | "warn">;
  loadContext?: typeof weeklyTrendContextFromEnv;
  cronRun?: RecordScheduleRunDependencies;
}

export async function runWeeklyTrendDigestSchedule(
  { to, waitUntil, appAuth }: ScheduleArgs,
  dependencies: WeeklyTrendDigestScheduleDependencies = {},
): Promise<void> {
  const env = dependencies.env ?? process.env;
  const logger = dependencies.logger ?? console;
  const loadContext = dependencies.loadContext ?? weeklyTrendContextFromEnv;
  await recordScheduleRun(
    "weekly-trend-digest",
    async () => {
      let context;
      try {
        context = await loadContext();
      } catch (error) {
        logger.warn("[trend-digest] weekly context failed cleanly:", error);
        return false;
      }
      const fallbackDigest = renderTrendDigest({
        trends: context.trends,
        demandAsks: context.demandAsks,
        ideas: [],
        rejections: [],
        spend: context.spend,
        xSourceStatus: context.xSourceStatus,
        demandDataAvailable: context.demandDataAvailable,
        generatedAt: context.generatedAt,
      });
      const delivery = resolveDigestDelivery(env, env.SLACK_CHANNEL_ID, logger);
      if (delivery.mode === "log") {
        logger.warn(
          `[trend-digest] Slack delivery skipped: ${delivery.reason}. Full digest follows.`,
        );
        logger.log(fallbackDigest);
        return false;
      }
      try {
        waitUntil(
          to(slack, { channelId: delivery.channelId })
            .send(WEEKLY_DIGEST_PROMPT, { auth: appAuth })
            .catch((error: unknown) => {
              logger.warn("[trend-digest] Slack delivery failed cleanly:", error);
            }),
        );
        return true;
      } catch (error) {
        logger.warn("[trend-digest] Slack dispatch failed cleanly:", error);
        logger.log(fallbackDigest);
        return false;
      }
    },
    dependencies.cronRun,
  );
}

// Sunday 18:35 UTC gives the daily series a full week and avoids poof's weekday schedules.
export default defineSchedule({
  cron: "35 18 * * 0",
  async run(args) {
    await runWeeklyTrendDigestSchedule(args);
  },
});
