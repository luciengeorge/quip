/** Asks newer than seven days receive freshness credit because their need is more likely unresolved. */
export const DEMAND_OPEN_DOOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
/** Three replies or fewer receives unanswered credit because a heavily answered ask is often closed. */
export const DEMAND_OPEN_DOOR_MAX_REPLY_COUNT = 3;
export const DEMAND_FRESHNESS_WEIGHT = 60;
export const DEMAND_UNANSWERED_WEIGHT = 40;

export interface DemandScoreInput {
  askedAt: number;
  replyCount: number;
}

function remainingFraction(value: number, maximum: number): number {
  return Math.max(0, 1 - value / maximum);
}

/** Score open buyer intent from recency and an absence of replies, on a 0 to 100 scale. */
export function demandAskScore(input: DemandScoreInput, now: number): number {
  if (!Number.isFinite(input.askedAt) || !Number.isInteger(input.replyCount) || input.replyCount < 0) {
    throw new Error("Invalid demand ask score input");
  }
  if (!Number.isFinite(now)) throw new Error("Invalid demand score time");
  const ageMs = Math.max(0, now - input.askedAt);
  const score =
    DEMAND_FRESHNESS_WEIGHT * remainingFraction(ageMs, DEMAND_OPEN_DOOR_MAX_AGE_MS) +
    DEMAND_UNANSWERED_WEIGHT *
      remainingFraction(input.replyCount, DEMAND_OPEN_DOOR_MAX_REPLY_COUNT);
  return Math.round(score * 100) / 100;
}
