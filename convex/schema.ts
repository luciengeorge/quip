import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const candidateStatus = v.union(
  v.literal("new"),
  v.literal("drafted"),
  v.literal("posted"),
  v.literal("rejected"),
  v.literal("stale"),
);

export const xReadReservationStatus = v.union(v.literal("pending"), v.literal("settled"));
export const trendXSourceStatus = v.union(v.literal("available"), v.literal("unavailable"));

export default defineSchema({
  candidates: defineTable({
    source: v.string(),
    url: v.string(),
    title: v.string(),
    context: v.string(),
    topicHash: v.string(),
    status: candidateStatus,
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_topicHash", ["topicHash"])
    .index("by_url", ["url"]),

  posts: defineTable({
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
    deletedAt: v.optional(v.number()),
  })
    .index("by_postedAt", ["postedAt"])
    .index("by_source", ["source"]),

  voiceProfile: defineTable({
    profile: v.string(),
    sampleTweetIds: v.array(v.string()),
    updatedAt: v.number(),
  }),

  cycles: defineTable({
    ranAt: v.number(),
    gathered: v.number(),
    drafted: v.number(),
    gateRejections: v.array(
      v.object({ text: v.string(), reason: v.string(), layer: v.string() }),
    ),
    posted: v.array(v.string()),
    decision: v.string(),
    rationale: v.string(),
  }),

  cronRuns: defineTable({
    schedule: v.string(),
    firedAt: v.number(),
    dispatched: v.boolean(),
  }).index("by_schedule", ["schedule"]),

  xReadBudgets: defineTable({
    month: v.string(),
    usedReads: v.number(),
    reservedReads: v.number(),
    updatedAt: v.number(),
  }).index("by_month", ["month"]),

  xReadReservations: defineTable({
    budgetId: v.id("xReadBudgets"),
    reservedReads: v.number(),
    actualReads: v.optional(v.number()),
    status: xReadReservationStatus,
    createdAt: v.number(),
    settledAt: v.optional(v.number()),
  }).index("by_budgetId", ["budgetId"]),

  trendObservations: defineTable({
    topicHash: v.string(),
    day: v.string(),
    title: v.string(),
    url: v.string(),
    source: v.string(),
    count: v.number(),
  })
    .index("by_topicHash_and_day", ["topicHash", "day"])
    .index("by_day", ["day"]),

  trendScans: defineTable({
    day: v.string(),
    scannedAt: v.number(),
    candidateCount: v.number(),
    sources: v.array(v.string()),
    xSourceStatus: trendXSourceStatus,
  }).index("by_day", ["day"]),
});
