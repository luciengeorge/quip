import { defineSchedule } from "eve/schedules";

import { recordScheduleRun, type RecordScheduleRunDependencies } from "../lib/cron-run.ts";
import { runDailyTrendScanFromEnv } from "../lib/trend-runtime.ts";

type TrendScanRunner = typeof runDailyTrendScanFromEnv;

interface DailyTrendScanScheduleDependencies {
  logger?: Pick<Console, "log" | "warn">;
  runScan?: TrendScanRunner;
  cronRun?: RecordScheduleRunDependencies;
}

export async function runDailyTrendScanSchedule(
  dependencies: DailyTrendScanScheduleDependencies = {},
): Promise<void> {
  const logger = dependencies.logger ?? console;
  const runScan = dependencies.runScan ?? runDailyTrendScanFromEnv;
  await recordScheduleRun(
    "daily-trend-scan",
    async () => {
      try {
        const result = await runScan();
        logger.log(
          `[trend-scan] stored ${result.observations.length} topic counts from ${result.candidates.length} candidates; x=${result.xSourceStatus}`,
        );
        for (const message of result.messages) logger.warn(`[trend-scan] ${message}`);
        return true;
      } catch (error) {
        logger.warn("[trend-scan] daily scan failed cleanly:", error);
        return false;
      }
    },
    dependencies.cronRun,
  );
}

// 08:20 UTC is clear of poof's 15:00 UTC weekday cycle and 21:00 UTC Friday scorecard.
export default defineSchedule({
  cron: "20 8 * * *",
  async run() {
    await runDailyTrendScanSchedule();
  },
});
