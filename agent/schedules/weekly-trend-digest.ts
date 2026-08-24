import { defineSchedule } from "eve/schedules";

import slack from "../channels/slack.ts";
import { resolveDigestDelivery } from "../lib/digest-delivery.ts";
import { renderTrendDigest } from "../lib/trend-digest.ts";
import { weeklyTrendContextFromEnv } from "../lib/trend-runtime.ts";

const WEEKLY_DIGEST_PROMPT = [
  "Build this week's Quip trend digest.",
  "1. Call weekly_trend_context first.",
  "2. Propose zero to three ideas only from that measured context. Do not invent links, counts, or directions.",
  "3. Call build_weekly_trend_digest with the structured proposals. It applies the deterministic gate and persists topic hashes.",
  "4. Post exactly the returned digest and nothing else. If no idea passes, post its empty result without filling a slot.",
].join(" ");

// Sunday 18:35 UTC gives the daily series a full week and avoids poof's weekday schedules.
export default defineSchedule({
  cron: "35 18 * * 0",
  async run({ to, waitUntil, appAuth }) {
    let context;
    try {
      context = await weeklyTrendContextFromEnv();
    } catch (error) {
      console.warn("[trend-digest] weekly context failed cleanly:", error);
      return;
    }
    const fallbackDigest = renderTrendDigest({
      trends: context.trends,
      ideas: [],
      rejections: [],
      spend: context.spend,
      xDataAvailable: context.xDataAvailable,
    });
    const delivery = resolveDigestDelivery(process.env, process.env.SLACK_CHANNEL_ID);
    if (delivery.mode === "log") {
      console.warn(`[trend-digest] Slack delivery skipped: ${delivery.reason}. Full digest follows.`);
      console.log(fallbackDigest);
      return;
    }
    try {
      waitUntil(
        to(slack, { channelId: delivery.channelId })
          .send(WEEKLY_DIGEST_PROMPT, { auth: appAuth })
          .catch((error: unknown) => {
          console.warn("[trend-digest] Slack delivery failed cleanly:", error);
          }),
      );
    } catch (error) {
      console.warn("[trend-digest] Slack dispatch failed cleanly:", error);
      console.log(fallbackDigest);
    }
  },
});
