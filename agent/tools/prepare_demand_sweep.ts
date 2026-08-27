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
    "Fetch and seal one bounded Reddit buyer-intent batch for the demand classifier. It never " +
    "drafts, posts, or sends replies. If Reddit is unconfigured, it records that unavailability " +
    "and returns no candidates.",
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
