import { defineTool } from "eve/tools";
import { z } from "zod";

import { trendResearchEscalationCap } from "../lib/config.ts";
import { ideaTopicHash } from "../lib/idea-gate.ts";
import { memoryFromEnv } from "../lib/memory.ts";
import { planResearchEscalations } from "../lib/research-escalation.ts";
import { weeklyIdeaListSchema } from "../lib/trend-idea-schema.ts";

export default defineTool({
  description:
    "Apply the deterministic weekly idea gate before research. Submit the same zero to three " +
    "proposals that you will later finalize. The result lists acceptedDirect, every rejection, " +
    "and only the non-duplicate researchRequests permitted by the code-enforced cycle cap.",
  inputSchema: z.object({ ideas: weeklyIdeaListSchema }).strict(),
  async execute({ ideas }) {
    const memory = memoryFromEnv();
    const existing = await Promise.all(
      ideas.map(async (idea) => {
        const hash = ideaTopicHash(idea);
        return (await memory.candidateByTopicHash(hash)) ? hash : null;
      }),
    );
    return planResearchEscalations(
      ideas,
      new Set(existing.filter((hash): hash is string => hash !== null)),
      trendResearchEscalationCap(),
    );
  },
});
