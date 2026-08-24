import { mutation, query } from "./_generated/server";
import schema, { candidateStatus } from "./schema";
import { assertSecret } from "./auth";
import { v } from "convex/values";

export const X_READ_PRICE_USD = 0.005;
export const X_MONTHLY_READ_BUDGET_USD = 25;
export const X_MONTHLY_READ_CAP = Math.floor(X_MONTHLY_READ_BUDGET_USD / X_READ_PRICE_USD);
const MAX_X_READS_PER_REQUEST = 100;

function currentMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

function assertReadCount(reads: number, maximum: number): void {
  if (!Number.isInteger(reads) || reads < 0 || reads > maximum) {
    throw new Error("Invalid X read count");
  }
}

export const recordCandidate = mutation({
  args: {
    token: v.string(),
    source: v.string(),
    url: v.string(),
    title: v.string(),
    context: v.string(),
    topicHash: v.string(),
    status: candidateStatus,
  },
  returns: v.id("candidates"),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    return await ctx.db.insert("candidates", { ...rest, createdAt: Date.now() });
  },
});

export const candidateByUrl = query({
  args: { token: v.string(), url: v.string() },
  returns: v.union(v.null(), schema.doc("candidates")),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    return await ctx.db
      .query("candidates")
      .withIndex("by_url", (q) => q.eq("url", rest.url))
      .unique();
  },
});

export const candidateByTopicHash = query({
  args: { token: v.string(), topicHash: v.string() },
  returns: v.union(v.null(), schema.doc("candidates")),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    return await ctx.db
      .query("candidates")
      .withIndex("by_topicHash", (q) => q.eq("topicHash", rest.topicHash))
      .unique();
  },
});

export const updateCandidateStatus = mutation({
  args: {
    token: v.string(),
    candidateId: v.id("candidates"),
    status: candidateStatus,
  },
  returns: v.id("candidates"),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    await ctx.db.patch("candidates", rest.candidateId, { status: rest.status });
    return rest.candidateId;
  },
});

export const recordPost = mutation({
  args: {
    token: v.string(),
    tweetId: v.string(),
    text: v.string(),
    source: v.string(),
    topicHash: v.string(),
    postedAt: v.number(),
    metrics: v.optional(
      v.object({
        likes: v.number(),
        reposts: v.number(),
        impressions: v.number(),
        replies: v.number(),
      }),
    ),
  },
  returns: v.id("posts"),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    return await ctx.db.insert("posts", { ...rest });
  },
});

export const saveVoiceProfile = mutation({
  args: {
    token: v.string(),
    profile: v.string(),
    sampleTweetIds: v.array(v.string()),
  },
  returns: v.id("voiceProfile"),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    const existing = (await ctx.db.query("voiceProfile").take(1))[0];
    const update = { ...rest, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch("voiceProfile", existing._id, update);
      return existing._id;
    }
    return await ctx.db.insert("voiceProfile", update);
  },
});

export const getVoiceProfile = query({
  args: { token: v.string() },
  returns: v.union(v.null(), schema.doc("voiceProfile")),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    const rows = await ctx.db.query("voiceProfile").take(1);
    return rows[0] ?? null;
  },
});

export const recordCycle = mutation({
  args: {
    token: v.string(),
    ranAt: v.number(),
    gathered: v.number(),
    drafted: v.number(),
    gateRejections: v.array(
      v.object({ text: v.string(), reason: v.string(), layer: v.string() }),
    ),
    posted: v.array(v.string()),
    decision: v.string(),
    rationale: v.string(),
  },
  returns: v.id("cycles"),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    return await ctx.db.insert("cycles", { ...rest });
  },
});

export const recordCronRun = mutation({
  args: {
    token: v.string(),
    schedule: v.string(),
    firedAt: v.number(),
    dispatched: v.boolean(),
  },
  returns: v.id("cronRuns"),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    return await ctx.db.insert("cronRuns", { ...rest });
  },
});

export const latestCronRun = query({
  args: { token: v.string(), schedule: v.string() },
  returns: v.union(v.null(), schema.doc("cronRuns")),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, ...rest } = args;
    const rows = await ctx.db
      .query("cronRuns")
      .withIndex("by_schedule", (q) => q.eq("schedule", rest.schedule))
      .order("desc")
      .take(1);
    return rows[0] ?? null;
  },
});

/**
 * Reserve the maximum number of X posts a request could return before calling the paid API.
 * This mutation is the hard budget boundary: Convex runs its read, cap check, and write as one
 * transaction, so concurrent cycles cannot reserve more than the monthly cap together.
 */
export const reserveXReads = mutation({
  args: { token: v.string(), reads: v.number() },
  returns: v.object({
    allowed: v.boolean(),
    reservationId: v.union(v.null(), v.id("xReadReservations")),
    remainingReads: v.number(),
  }),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    assertReadCount(args.reads, MAX_X_READS_PER_REQUEST);
    if (args.reads === 0) throw new Error("X read reservation must be positive");
    const now = Date.now();
    const month = currentMonth(now);
    const existing = await ctx.db
      .query("xReadBudgets")
      .withIndex("by_month", (q) => q.eq("month", month))
      .unique();
    const usedReads = existing?.usedReads ?? 0;
    const reservedReads = existing?.reservedReads ?? 0;
    const remainingReads = Math.max(0, X_MONTHLY_READ_CAP - usedReads - reservedReads);
    if (args.reads > remainingReads) {
      return { allowed: false, reservationId: null, remainingReads };
    }
    const budgetId = existing
      ? existing._id
      : await ctx.db.insert("xReadBudgets", {
          month,
          usedReads: 0,
          reservedReads: 0,
          updatedAt: now,
        });
    await ctx.db.patch("xReadBudgets", budgetId, {
      reservedReads: reservedReads + args.reads,
      updatedAt: now,
    });
    const reservationId = await ctx.db.insert("xReadReservations", {
      budgetId,
      reservedReads: args.reads,
      status: "pending",
      createdAt: now,
    });
    return {
      allowed: true,
      reservationId,
      remainingReads: remainingReads - args.reads,
    };
  },
});

/**
 * Convert an already-held reservation into actual paid reads and release its unused capacity.
 * Repeating the same settlement is idempotent so an interrupted tool retry cannot double count.
 */
export const settleXReads = mutation({
  args: { token: v.string(), reservationId: v.id("xReadReservations"), actualReads: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const reservation = await ctx.db.get("xReadReservations", args.reservationId);
    if (!reservation) throw new Error("Unknown X read reservation");
    assertReadCount(args.actualReads, reservation.reservedReads);
    if (reservation.status === "settled") {
      if (reservation.actualReads !== args.actualReads) {
        throw new Error("X read reservation was already settled differently");
      }
      return null;
    }
    const budget = await ctx.db.get("xReadBudgets", reservation.budgetId);
    if (!budget) throw new Error("X read budget is missing");
    const nextUsedReads = budget.usedReads + args.actualReads;
    const nextReservedReads = budget.reservedReads - reservation.reservedReads;
    if (nextUsedReads > X_MONTHLY_READ_CAP || nextReservedReads < 0) {
      throw new Error("X read budget invariant failed");
    }
    const now = Date.now();
    await ctx.db.patch("xReadBudgets", budget._id, {
      usedReads: nextUsedReads,
      reservedReads: nextReservedReads,
      updatedAt: now,
    });
    await ctx.db.patch("xReadReservations", reservation._id, {
      status: "settled",
      actualReads: args.actualReads,
      settledAt: now,
    });
    return null;
  },
});
