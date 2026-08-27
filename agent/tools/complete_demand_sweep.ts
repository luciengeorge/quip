import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  completeDemandSweep,
  type PreparedDemandSweep,
} from "../lib/demand-runtime.ts";
import type { DemandCandidatePlan } from "../lib/demand-scan.ts";
import { memoryFromEnv } from "../lib/memory.ts";

const candidateSchema = z
  .object({
    source: z.literal("reddit"),
    title: z.string(),
    url: z.string(),
    context: z.string(),
    timestamp: z.number(),
    author: z.string(),
    replyCount: z.number(),
    subreddit: z.string(),
    sourceText: z.string(),
  })
  .strict();

const planSchema = z
  .object({
    day: z.string(),
    candidates: z.array(candidateSchema).max(30),
    cap: z.number().int().min(1).max(30),
    droppedCount: z.number().int().nonnegative(),
    duplicateCount: z.number().int().nonnegative(),
    leakyCount: z.number().int().nonnegative(),
    cappedCount: z.number().int().nonnegative(),
  })
  .strict();

const preparedSchema = z
  .object({
    day: z.string(),
    scannedAt: z.number(),
    sourceStatus: z.enum(["available", "unavailable"]),
    plan: planSchema,
    seal: z.string(),
    messages: z.array(z.string()),
  })
  .strict();

function demandSweepSecret(): string {
  const secret = process.env.CONVEX_APP_SECRET?.trim();
  if (!secret) throw new Error("CONVEX_APP_SECRET is not set");
  return secret;
}

export default defineTool({
  description:
    "Fail closed on the fresh classifier's structured output, verify its sealed fetched candidates, " +
    "and persist only genuine buyer asks with exact source quotes. This tool never drafts, posts, " +
    "or sends replies.",
  inputSchema: z
    .object({
      prepared: preparedSchema,
      classifications: z.array(z.unknown()).max(30),
    })
    .strict(),
  async execute({ prepared, classifications }) {
    const memory = memoryFromEnv();
    return await completeDemandSweep({
      prepared: {
        ...prepared,
        plan: prepared.plan as DemandCandidatePlan,
      } as PreparedDemandSweep,
      classifications,
      memory,
      secret: demandSweepSecret(),
    });
  },
});
