import { mutation, query } from "./_generated/server";
import schema, { candidateStatus } from "./schema";
import { assertSecret } from "./auth";
import { v } from "convex/values";

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
