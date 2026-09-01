import type { DemandAskRecord, DemandScanRecord } from "./memory.ts";
import type { TrendDirection } from "./velocity.ts";
import { calculateVelocity } from "./velocity.ts";

export interface WeeklyDemandEvidence {
  topicHash: string;
  askedFor: string;
  permalink: string;
  distinctAskers: number;
  totalReplies: number;
  activeDays: number;
  askCount: number;
  direction: TrendDirection;
}

/** Keep the raw highest-opportunity asks separate from topic-level evidence for the idea gate. */
export function weeklyDemandAsks(asks: readonly DemandAskRecord[]): DemandAskRecord[] {
  return [...asks].sort(
    (left, right) =>
      right.score - left.score || right.askedAt - left.askedAt || left.permalink.localeCompare(right.permalink),
  );
}

/** Aggregate repeat buyer asks only when the complete scan window supports a direction. */
export function weeklyDemandEvidence(
  asks: readonly DemandAskRecord[],
  scans: readonly DemandScanRecord[],
  startDay: string,
  endDay: string,
): WeeklyDemandEvidence[] {
  const grouped = new Map<string, DemandAskRecord[]>();
  for (const ask of asks) {
    const group = grouped.get(ask.topicHash) ?? [];
    group.push(ask);
    grouped.set(ask.topicHash, group);
  }
  const scannedDays = scans
    .filter(
      (scan) =>
        scan.redditSourceStatus === "available" ||
        scan.stackExchangeSourceStatus === "available" ||
        scan.xSourceStatus === "configured-empty" ||
        scan.xSourceStatus === "contributed",
    )
    .map((scan) => scan.day);
  const evidence: WeeklyDemandEvidence[] = [];
  for (const [topicHash, topicAsks] of grouped) {
    const velocity = calculateVelocity(
      topicAsks.map((ask) => ({ day: ask.day, count: 1 })),
      { startDay, endDay, scannedDays },
    );
    if (!velocity.isTrend || !velocity.direction) continue;
    const topAsk = weeklyDemandAsks(topicAsks)[0];
    if (!topAsk) continue;
    evidence.push({
      topicHash,
      askedFor: topAsk.askedFor,
      permalink: topAsk.permalink,
      distinctAskers: new Set(topicAsks.map((ask) => ask.author)).size,
      totalReplies: topicAsks.reduce((total, ask) => total + ask.replyCount, 0),
      activeDays: velocity.counts.filter((count) => count > 0).length,
      askCount: topicAsks.length,
      direction: velocity.direction,
    });
  }
  return evidence.sort(
    (left, right) =>
      right.askCount - left.askCount ||
      right.distinctAskers - left.distinctAskers ||
      left.askedFor.localeCompare(right.askedFor),
  );
}
