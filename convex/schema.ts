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
export const trendXSourceStatus = v.union(
  v.literal("not-configured"),
  v.literal("configured-empty"),
  v.literal("contributed"),
  // Retain legacy values until the next seven-day reporting window has passed.
  v.literal("available"),
  v.literal("unavailable"),
);
export const demandRedditSourceStatus = v.union(v.literal("available"), v.literal("unavailable"));
export const demandStackExchangeSourceStatus = v.union(
  v.literal("available"),
  v.literal("unavailable"),
);
export const demandXSourceStatus = v.union(
  v.literal("not-configured"),
  v.literal("configured-empty"),
  v.literal("contributed"),
);
export const demandCandidatePlanStatus = v.union(
  v.literal("pending"),
  v.literal("completed"),
  v.literal("expired"),
);

const demandCandidate = v.object({
  source: v.union(v.literal("reddit"), v.literal("stackexchange"), v.literal("x")),
  title: v.string(),
  url: v.string(),
  context: v.string(),
  timestamp: v.number(),
  author: v.string(),
  replyCount: v.number(),
  subreddit: v.string(),
  sourceText: v.string(),
});

export const demandCandidatePlan = v.object({
  day: v.string(),
  candidates: v.array(demandCandidate),
  cap: v.number(),
  droppedCount: v.number(),
  duplicateCount: v.number(),
  leakyCount: v.number(),
  cappedCount: v.number(),
});

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

  /**
   * A recurring want, assembled from asks that describe the same thing.
   *
   * A single post with no replies is close to zero evidence, so viability is judged on the theme
   * rather than the ask: the same want, from different people, over time. Research is cached here
   * per theme so a repeat theme costs nothing to re-judge.
   */
  demandThemes: defineTable({
    themeKey: v.string(),
    label: v.string(),
    permalinks: v.array(v.string()),
    /** Distinct ask authors. Counted, never shown: the report is evidence, not a contact list. */
    askers: v.array(v.string()),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    // Everything below is filled once a theme clears the bar and gets researched.
    researchedAt: v.optional(v.number()),
    researchedAskerCount: v.optional(v.number()),
    incumbentCoverage: v.optional(
      v.union(v.literal("covers"), v.literal("partial"), v.literal("none")),
    ),
    incumbents: v.optional(v.array(v.object({ name: v.string(), covers: v.string() }))),
    researchSummary: v.optional(v.string()),
    sources: v.optional(v.array(v.object({ url: v.string(), claim: v.string() }))),
    buildDays: v.optional(v.number()),
    buildBreakdown: v.optional(v.string()),
    verdict: v.optional(
      v.union(v.literal("worth-a-look"), v.literal("already-solved"), v.literal("unresearchable")),
    ),
    verdictAt: v.optional(v.number()),
  })
    .index("by_themeKey", ["themeKey"])
    .index("by_lastSeenAt", ["lastSeenAt"]),

  demandAsks: defineTable({
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
  })
    .index("by_permalink", ["permalink"])
    .index("by_day", ["day"])
    .index("by_topicHash_and_day", ["topicHash", "day"]),

  demandScans: defineTable({
    day: v.string(),
    scannedAt: v.number(),
    candidateCount: v.number(),
    redditSourceStatus: demandRedditSourceStatus,
    stackExchangeSourceStatus: v.optional(demandStackExchangeSourceStatus),
    xSourceStatus: v.optional(demandXSourceStatus),
  }).index("by_day", ["day"]),

  demandCandidatePlans: defineTable({
    plan: demandCandidatePlan,
    seal: v.string(),
    status: demandCandidatePlanStatus,
    expiresAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_expiresAt", ["expiresAt"]),
});
