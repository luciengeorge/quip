import { defineTool } from "eve/tools";
import { z } from "zod";

import { checkIdeas, ideaTopicHash, type IdeaRejection, type ProposedIdea } from "../lib/idea-gate.ts";
import { containsLeak, leakGuardConfigFromEnv } from "../lib/leak-guard.ts";
import { memoryFromEnv } from "../lib/memory.ts";
import { renderTrendDigest } from "../lib/trend-digest.ts";
import { weeklyTrendContext } from "../lib/trend-runtime.ts";

const ideaSchema = z.object({
  title: z.string().trim().min(1).max(180),
  trendTitle: z.string().trim().min(1).max(240),
  mechanism: z.string().trim().min(1).max(700),
  evidence: z.string().trim().min(1).max(700),
  moatClass: z.string().trim().min(1).max(40),
  buildDays: z.number(),
  ownerFit: z.string().max(500),
});

function ideaText(idea: ProposedIdea): string {
  return [
    idea.title,
    idea.trendTitle,
    idea.mechanism,
    idea.evidence,
    idea.moatClass,
    idea.ownerFit,
  ].join("\n");
}

export default defineTool({
  description:
    "Run the deterministic weekly idea gate and render the final digest. Call weekly_trend_context " +
    "first. Submit at most three structured proposals. Every proposal needs an observed evidence " +
    "link, number, direction, one allowed non-code moat class, a 1 to 14 day estimate, a concrete " +
    "mechanism, and an owner-fit note explicitly labelled as an approximation. Return the digest " +
    "verbatim after this tool succeeds.",
  inputSchema: z.object({ ideas: z.array(ideaSchema).max(3) }),
  async execute({ ideas }) {
    const memory = memoryFromEnv();
    const [context, existing] = await Promise.all([
      weeklyTrendContext(memory),
      Promise.all(
        ideas.map(async (idea) => {
          const hash = ideaTopicHash(idea);
          return (await memory.candidateByTopicHash(hash)) ? hash : null;
        }),
      ),
    ]);
    const gate = checkIdeas(ideas, new Set(existing.filter((hash): hash is string => hash !== null)));
    const accepted = [];
    const rejections: IdeaRejection[] = [...gate.rejected];
    for (const idea of gate.accepted) {
      const leak = containsLeak(ideaText(idea), leakGuardConfigFromEnv());
      if (leak.leaked) {
        rejections.push({ title: idea.title, reason: `leak guard: ${leak.reason ?? "unsafe text"}` });
        continue;
      }
      const persisted = await memory.recordDigestIdea({
        title: idea.title,
        url: idea.evidence.match(/https?:\/\/[^\s\])}>]+/u)?.[0] ?? "",
        context: ideaText(idea),
        topicHash: idea.topicHash,
      });
      if (!persisted.recorded) {
        rejections.push({ title: idea.title, reason: "topic was already digested" });
        continue;
      }
      accepted.push(idea);
    }
    const digest = renderTrendDigest({
      trends: context.trends,
      ideas: accepted,
      rejections,
      spend: context.spend,
      xDataAvailable: context.xDataAvailable,
    });
    console.log(`[trend-digest] rendered weekly digest:\n${digest}`);
    return { digest, acceptedIdeas: accepted.length, rejections };
  },
  toModelOutput(output) {
    return { type: "text", value: output.digest };
  },
});
