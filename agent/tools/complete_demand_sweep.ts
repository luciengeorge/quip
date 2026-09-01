import { defineTool } from "eve/tools";
import { z } from "zod";

import { completeDemandSweep } from "../lib/demand-runtime.ts";
import { memoryFromEnv } from "../lib/memory.ts";

function demandSweepSecret(): string {
  const secret = process.env.CONVEX_APP_SECRET?.trim();
  if (!secret) throw new Error("CONVEX_APP_SECRET is not set");
  return secret;
}

export default defineTool({
  description:
    "Load one stored sealed candidate plan by id, fail closed on the fresh classifier's structured " +
    "output, and persist only genuine buyer asks with exact source quotes. This tool never drafts, " +
    "posts, or sends replies.",
  inputSchema: z
    .object({
      planId: z.string().min(1),
      classifications: z.array(z.unknown()).max(30),
    })
    .strict(),
  async execute({ planId, classifications }) {
    const memory = memoryFromEnv();
    return await completeDemandSweep({
      planId,
      classifications,
      memory,
      secret: demandSweepSecret(),
    });
  },
});
