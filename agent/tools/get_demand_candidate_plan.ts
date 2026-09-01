import { defineTool } from "eve/tools";
import { z } from "zod";

import { verifiesDemandCandidatePlan } from "../lib/demand-runtime.ts";
import { memoryFromEnv } from "../lib/memory.ts";

function demandSweepSecret(): string {
  const secret = process.env.CONVEX_APP_SECRET?.trim();
  if (!secret) throw new Error("CONVEX_APP_SECRET is not set");
  return secret;
}

export default defineTool({
  description:
    "Read the bounded server-stored candidates for one pending sealed demand plan. Use them only " +
    "to classify buyer intent. Do not reproduce the plan in another tool call, draft, post, or send replies.",
  inputSchema: z.object({ planId: z.string().min(1) }).strict(),
  async execute({ planId }) {
    const stored = await memoryFromEnv().loadDemandCandidatePlan(planId);
    if (!stored || stored.status !== "pending" || stored.expiresAt <= Date.now()) {
      return { planId, candidates: [], reason: "plan is unavailable" };
    }
    if (!verifiesDemandCandidatePlan(stored.plan, demandSweepSecret(), stored.seal)) {
      return { planId, candidates: [], reason: "plan seal is invalid" };
    }
    return { planId, candidates: stored.plan.candidates, reason: null };
  },
});
