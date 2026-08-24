export interface PacingInput {
  postsThisWeek: number;
  weeklyTarget: number;
  postsToday: number;
  dailyCap: number;
  lastPostAt: number | null;
  now: number;
  minGapMs: number;
}

export interface PacingDecision {
  post: boolean;
  reason: string;
}

export interface PacingBudgetInput {
  postsThisWeek: number;
  weeklyTarget: number;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Return the remaining weekly post capacity, never a negative value. */
export function pacingBudget(input: PacingBudgetInput): number;
export function pacingBudget(postsThisWeek: number, weeklyTarget: number): number;
export function pacingBudget(
  inputOrPostsThisWeek: PacingBudgetInput | number,
  maybeWeeklyTarget?: number,
): number {
  const { postsThisWeek, weeklyTarget } =
    typeof inputOrPostsThisWeek === "number"
      ? { postsThisWeek: inputOrPostsThisWeek, weeklyTarget: maybeWeeklyTarget ?? 0 }
      : inputOrPostsThisWeek;
  return Math.max(0, nonNegativeInteger(weeklyTarget) - nonNegativeInteger(postsThisWeek));
}

/** Apply pacing rules in priority order so logs state the exact decision. */
export function shouldPostNow(input: PacingInput): PacingDecision {
  if (input.postsThisWeek >= input.weeklyTarget) {
    return { post: false, reason: "weekly target met" };
  }
  if (input.postsToday >= input.dailyCap) {
    return { post: false, reason: "daily cap hit" };
  }
  if (input.lastPostAt !== null && input.now - input.lastPostAt < input.minGapMs) {
    return { post: false, reason: "minimum gap not elapsed" };
  }
  return { post: true, reason: "posting allowed" };
}
