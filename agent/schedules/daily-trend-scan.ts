import { defineSchedule } from "eve/schedules";

import { runDailyTrendScanFromEnv } from "../lib/trend-runtime.ts";

// 08:20 UTC is clear of poof's 15:00 UTC weekday cycle and 21:00 UTC Friday scorecard.
export default defineSchedule({
  cron: "20 8 * * *",
  async run() {
    try {
      const result = await runDailyTrendScanFromEnv();
      console.log(
        `[trend-scan] stored ${result.observations.length} topic counts from ${result.candidates.length} candidates; x=${result.xSourceStatus}`,
      );
      for (const message of result.messages) console.warn(`[trend-scan] ${message}`);
    } catch (error) {
      console.warn("[trend-scan] daily scan failed cleanly:", error);
    }
  },
});
