import { defineTool } from "eve/tools";
import { z } from "zod";

import { runDemandSweepFromEnv } from "../lib/demand-runtime.ts";

export default defineTool({
  description:
    "Fetch and seal one bounded Reddit, Stack Exchange, and X buyer-intent batch for the demand classifier. " +
    "It never drafts, posts, or sends replies. Each unavailable source is recorded without blocking " +
    "the other sources.",
  inputSchema: z.object({}),
  async execute() {
    const prepared = await runDemandSweepFromEnv();
    return {
      planId: prepared.planId,
      candidateCount: prepared.plan.candidates.length,
      sourceStatus: prepared.sourceStatus,
      redditSourceStatus: prepared.redditSourceStatus,
      stackExchangeSourceStatus: prepared.stackExchangeSourceStatus,
      xSourceStatus: prepared.xSourceStatus,
      messages: prepared.messages,
    };
  },
});
