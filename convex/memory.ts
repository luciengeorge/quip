import { mutation, query } from "./_generated/server";
import schema, { candidateStatus, demandRedditSourceStatus, trendXSourceStatus } from "./schema";
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

function assertDay(day: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new Error("Invalid trend day");
}

interface TrendObservationInput {
  topicHash: string;
  day: string;
  title: string;
  url: string;
  source: string;
  count: number;
}

interface DemandAskInput {
  topicHash: string;
  day: string;
  quote: string;
  permalink: string;
  author: string;
  askedAt: number;
  replyCount: number;
  score: number;
  subreddit: string;
  source: string;
  askedFor: string;
}

function validTrendObservation(observation: TrendObservationInput): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(observation.day) &&
    Number.isInteger(observation.count) &&
    observation.count >= 1 &&
    observation.count <= 10_000 &&
    observation.topicHash.trim().length > 0 &&
    observation.title.trim().length > 0 &&
    observation.url.trim().length > 0 &&
    observation.source.trim().length > 0
  );
}

function validDemandAsk(ask: DemandAskInput): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(ask.day) &&
    Number.isFinite(ask.askedAt) &&
    Number.isInteger(ask.replyCount) &&
    ask.replyCount >= 0 &&
    Number.isFinite(ask.score) &&
    ask.score >= 0 &&
    ask.score <= 100 &&
    ask.topicHash.trim().length > 0 &&
    ask.quote.trim().length > 0 &&
    ask.permalink.trim().length > 0 &&
    ask.author.trim().length > 0 &&
    ask.subreddit.trim().length > 0 &&
    ask.source.trim().length > 0 &&
    ask.askedFor.trim().length > 0
  );
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

/** Persist only the shared topic hash for a digest idea, reusing the candidate store. */
export const recordDigestIdea = mutation({
  args: {
    token: v.string(),
    title: v.string(),
    url: v.string(),
    context: v.string(),
    topicHash: v.string(),
  },
  returns: v.object({ recorded: v.boolean() }),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    if (
      args.title.trim().length === 0 ||
      args.url.trim().length === 0 ||
      args.topicHash.trim().length === 0
    ) {
      throw new Error("Invalid digest idea");
    }
    const existing = await ctx.db
      .query("candidates")
      .withIndex("by_topicHash", (q) => q.eq("topicHash", args.topicHash))
      .take(1);
    if (existing.length > 0) return { recorded: false };
    await ctx.db.insert("candidates", {
      source: "trending",
      url: args.url,
      title: args.title,
      context: args.context,
      topicHash: args.topicHash,
      status: "new",
      createdAt: Date.now(),
    });
    return { recorded: true };
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

export const getXReadSpend = query({
  args: { token: v.string() },
  returns: v.object({
    month: v.string(),
    usedReads: v.number(),
    reservedReads: v.number(),
    capReads: v.number(),
    usedUsd: v.number(),
    capUsd: v.number(),
  }),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const month = currentMonth(Date.now());
    const budget = await ctx.db
      .query("xReadBudgets")
      .withIndex("by_month", (q) => q.eq("month", month))
      .unique();
    const usedReads = budget?.usedReads ?? 0;
    const reservedReads = budget?.reservedReads ?? 0;
    return {
      month,
      usedReads,
      reservedReads,
      capReads: X_MONTHLY_READ_CAP,
      usedUsd: usedReads * X_READ_PRICE_USD,
      capUsd: X_MONTHLY_READ_BUDGET_USD,
    };
  },
});

export const upsertTrendObservations = mutation({
  args: {
    token: v.string(),
    observations: v.array(
      v.object({
        topicHash: v.string(),
        day: v.string(),
        title: v.string(),
        url: v.string(),
        source: v.string(),
        count: v.number(),
      }),
    ),
  },
  returns: v.object({ skippedCount: v.number() }),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const seen = new Set<string>();
    let skippedCount = 0;
    for (const observation of args.observations) {
      if (!validTrendObservation(observation)) {
        skippedCount += 1;
        continue;
      }
      const key = `${observation.topicHash}\n${observation.day}`;
      if (seen.has(key)) throw new Error("Duplicate trend observation in batch");
      seen.add(key);
      const existing = await ctx.db
        .query("trendObservations")
        .withIndex("by_topicHash_and_day", (q) =>
          q.eq("topicHash", observation.topicHash).eq("day", observation.day),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, observation);
      } else {
        await ctx.db.insert("trendObservations", observation);
      }
    }
    return { skippedCount };
  },
});

export const recordTrendScan = mutation({
  args: {
    token: v.string(),
    day: v.string(),
    scannedAt: v.number(),
    candidateCount: v.number(),
    sources: v.array(v.string()),
    xSourceStatus: trendXSourceStatus,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    assertDay(args.day);
    if (
      !Number.isFinite(args.scannedAt) ||
      !Number.isInteger(args.candidateCount) ||
      args.candidateCount < 0 ||
      args.sources.some((source) => source.trim().length === 0)
    ) {
      throw new Error("Invalid trend scan");
    }
    const { token, ...scan } = args;
    const existing = await ctx.db
      .query("trendScans")
      .withIndex("by_day", (q) => q.eq("day", scan.day))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, scan);
    } else {
      await ctx.db.insert("trendScans", scan);
    }
    return null;
  },
});

export const trendObservationsInRange = query({
  args: { token: v.string(), startDay: v.string(), endDay: v.string() },
  returns: v.array(schema.doc("trendObservations")),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    assertDay(args.startDay);
    assertDay(args.endDay);
    if (args.endDay < args.startDay) throw new Error("Invalid trend date range");
    return await ctx.db
      .query("trendObservations")
      .withIndex("by_day", (q) => q.gte("day", args.startDay).lte("day", args.endDay))
      .collect();
  },
});

export const trendScansInRange = query({
  args: { token: v.string(), startDay: v.string(), endDay: v.string() },
  returns: v.array(schema.doc("trendScans")),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    assertDay(args.startDay);
    assertDay(args.endDay);
    if (args.endDay < args.startDay) throw new Error("Invalid trend date range");
    return await ctx.db
      .query("trendScans")
      .withIndex("by_day", (q) => q.gte("day", args.startDay).lte("day", args.endDay))
      .collect();
  },
});

export const upsertDemandAsks = mutation({
  args: {
    token: v.string(),
    asks: v.array(
      v.object({
        topicHash: v.string(),
        day: v.string(),
        quote: v.string(),
        permalink: v.string(),
        author: v.string(),
        askedAt: v.number(),
        replyCount: v.number(),
        score: v.number(),
        subreddit: v.string(),
        source: v.string(),
        askedFor: v.string(),
      }),
    ),
  },
  returns: v.object({ insertedCount: v.number(), skippedCount: v.number(), dedupedCount: v.number() }),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    let insertedCount = 0;
    let skippedCount = 0;
    let dedupedCount = 0;
    const seenPermalinks = new Set<string>();
    for (const ask of args.asks) {
      if (!validDemandAsk(ask)) {
        skippedCount += 1;
        continue;
      }
      if (seenPermalinks.has(ask.permalink)) {
        dedupedCount += 1;
        continue;
      }
      seenPermalinks.add(ask.permalink);
      const existing = await ctx.db
        .query("demandAsks")
        .withIndex("by_permalink", (q) => q.eq("permalink", ask.permalink))
        .unique();
      if (existing) {
        dedupedCount += 1;
        continue;
      }
      await ctx.db.insert("demandAsks", ask);
      insertedCount += 1;
    }
    return { insertedCount, skippedCount, dedupedCount };
  },
});

export const recordDemandScan = mutation({
  args: {
    token: v.string(),
    day: v.string(),
    scannedAt: v.number(),
    candidateCount: v.number(),
    redditSourceStatus: demandRedditSourceStatus,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    assertDay(args.day);
    if (
      !Number.isFinite(args.scannedAt) ||
      !Number.isInteger(args.candidateCount) ||
      args.candidateCount < 0
    ) {
      throw new Error("Invalid demand scan");
    }
    const { token, ...scan } = args;
    const existing = await ctx.db
      .query("demandScans")
      .withIndex("by_day", (q) => q.eq("day", scan.day))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, scan);
    } else {
      await ctx.db.insert("demandScans", scan);
    }
    return null;
  },
});

export const demandAsksInRange = query({
  args: { token: v.string(), startDay: v.string(), endDay: v.string() },
  returns: v.array(schema.doc("demandAsks")),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    assertDay(args.startDay);
    assertDay(args.endDay);
    if (args.endDay < args.startDay) throw new Error("Invalid demand date range");
    return await ctx.db
      .query("demandAsks")
      .withIndex("by_day", (q) => q.gte("day", args.startDay).lte("day", args.endDay))
      .take(1_000);
  },
});

export const demandScansInRange = query({
  args: { token: v.string(), startDay: v.string(), endDay: v.string() },
  returns: v.array(schema.doc("demandScans")),
  handler: async (ctx, args) => {
    assertSecret(args.token);
    assertDay(args.startDay);
    assertDay(args.endDay);
    if (args.endDay < args.startDay) throw new Error("Invalid demand date range");
    return await ctx.db
      .query("demandScans")
      .withIndex("by_day", (q) => q.gte("day", args.startDay).lte("day", args.endDay))
      .take(31);
  },
});
