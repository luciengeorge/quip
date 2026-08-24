import type { TrendObservationRecord, TrendScanRecord } from "./memory.ts";
import type { WeeklyTrend } from "./trend-digest.ts";
import { calculateVelocity } from "./velocity.ts";

/** Convert durable daily observations into reportable multi-day trends only. */
export function weeklyTrends(
  observations: readonly TrendObservationRecord[],
  scans: readonly TrendScanRecord[],
  startDay: string,
  endDay: string,
): WeeklyTrend[] {
  const grouped = new Map<string, TrendObservationRecord[]>();
  for (const observation of observations) {
    const topic = grouped.get(observation.topicHash) ?? [];
    topic.push(observation);
    grouped.set(observation.topicHash, topic);
  }
  const scanDays = scans.map((scan) => scan.day);
  const trends: WeeklyTrend[] = [];
  for (const [topicHash, topicObservations] of grouped) {
    const velocity = calculateVelocity(topicObservations, { startDay, endDay, scannedDays: scanDays });
    if (!velocity.isTrend || !velocity.direction) continue;
    const latest = [...topicObservations].sort((left, right) => right.day.localeCompare(left.day))[0];
    if (!latest) continue;
    trends.push({
      topicHash,
      title: latest.title,
      url: latest.url,
      source: latest.source,
      activeDays: velocity.counts.filter((count) => count > 0).length,
      totalSignals: velocity.counts.reduce((total, count) => total + count, 0),
      direction: velocity.direction,
    });
  }
  return trends.sort(
    (left, right) =>
      right.totalSignals - left.totalSignals ||
      right.activeDays - left.activeDays ||
      left.title.localeCompare(right.title),
  );
}
