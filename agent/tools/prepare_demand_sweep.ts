import { defineTool } from "eve/tools";
import { z } from "zod";

import { demandSourceSet, prepareDemandSweep } from "../lib/demand-runtime.ts";
import { memoryFromEnv } from "../lib/memory.ts";

function demandSweepSecret(): string {
  const secret = process.env.CONVEX_APP_SECRET?.trim();
  if (!secret) throw new Error("CONVEX_APP_SECRET is not set");
  return secret;
}

export default defineTool({
  description:
    "Fetch and seal one bounded Reddit and Stack Exchange buyer-intent batch for the demand classifier. " +
    "It never drafts, posts, or sends replies. Each unavailable source is recorded without blocking " +
    "the other source.",
  inputSchema: z.object({}),
  async execute() {
    const memory = memoryFromEnv();
    const prepared = await prepareDemandSweep({
      sourceSet: demandSourceSet(),
      memory,
      secret: demandSweepSecret(),
    });
    return prepared;
  },
});
