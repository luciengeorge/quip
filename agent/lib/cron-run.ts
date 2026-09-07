import { memoryFromEnv, type CronRunRecord } from "./memory.ts";

/**
 * Record that a schedule fired, and whether it handed any work off.
 *
 * THE GAP THIS CLOSES. Every schedule here swallows its own errors so that one bad run cannot
 * take the app down. The cost of that is that "never fired" and "fired and quietly did nothing"
 * look identical from outside. On 2026-09-07 there was no way to answer whether the previous
 * evening's weekly digest had failed or had simply never been invoked: Vercel's Hobby plan had
 * purged the runtime logs about an hour after the run, and nothing durable had been written.
 *
 * The `cronRuns` table, the `recordCronRun` mutation and the client wrapper all already existed.
 * Nothing ever called them, so the table was empty and the question was unanswerable.
 *
 * A row per run answers "did it fire?" from durable storage, and `dispatched` answers the
 * follow-up that actually matters: a run that fired and delivered is not the same event as a run
 * that fired and produced nothing, and reporting them as one is what made a silent miss
 * invisible. A skipped delivery and a thrown body are both `dispatched: false`.
 */

type Logger = Pick<Console, "warn">;

interface CronRunMemory {
  recordCronRun(run: CronRunRecord): Promise<string>;
}

export interface RecordScheduleRunDependencies {
  memory?: CronRunMemory;
  now?: () => number;
  logger?: Logger;
}

/**
 * Run a schedule body and record exactly one row for the attempt.
 *
 * `run` resolves true only when the schedule reached its intended handoff. The row is written in
 * a `finally` so that a throwing body is still recorded, and the error is then left to propagate
 * to the caller's own handling.
 */
export async function recordScheduleRun(
  schedule: string,
  run: () => Promise<boolean>,
  dependencies: RecordScheduleRunDependencies = {},
): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const logger = dependencies.logger ?? console;
  const firedAt = now();
  let dispatched = false;
  try {
    dispatched = await run();
  } finally {
    // Bookkeeping must never be able to fail a schedule, and resolving the memory client is part
    // of the bookkeeping: memoryFromEnv() throws on missing configuration, so building it here
    // rather than in the argument list keeps a config gap from destroying a run that succeeded.
    try {
      const memory = dependencies.memory ?? memoryFromEnv();
      await memory.recordCronRun({ schedule, firedAt, dispatched });
    } catch (error) {
      logger.warn(`[cron-run] could not record ${schedule}:`, error);
    }
  }
}
