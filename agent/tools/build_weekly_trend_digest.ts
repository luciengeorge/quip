import { defineTool } from "eve/tools";
import { z } from "zod";

import { trendResearchEscalationCap } from "../lib/config.ts";
import { ideaTopicHash, type AcceptedIdea, type IdeaRejection } from "../lib/idea-gate.ts";
import { containsLeak, leakGuardConfigFromEnv } from "../lib/leak-guard.ts";
import { memoryFromEnv } from "../lib/memory.ts";
import {
  planResearchEscalations,
  resolveResearchEscalations,
  type ResearchAcceptedIdea,
} from "../lib/research-escalation.ts";
import { renderTrendDigest, type DigestIdea } from "../lib/trend-digest.ts";
import { weeklyIdeaListSchema } from "../lib/trend-idea-schema.ts";
import { weeklyTrendContext } from "../lib/trend-runtime.ts";

const researchAttemptSchema = z
  .object({
    originalTitle: z.string().trim().min(1).max(180),
    output: z.unknown(),
  })
  .strict();

function ideaText(idea: AcceptedIdea): string {
  return [
    idea.title,
    idea.trendTitle,
    idea.mechanism,
    idea.evidence,
    idea.moatClass,
    idea.ownerFit,
  ].join("\n");
}

function digestIdea(idea: AcceptedIdea, researchSummary?: string): DigestIdea {
  return {
    title: idea.title,
    mechanism: idea.mechanism,
    evidence: idea.evidence,
    moatClass: idea.moatClass,
    buildDays: idea.buildDays,
    buildBreakdown: idea.buildBreakdown,
    ownerFit: idea.ownerFit,
    acceptance: researchSummary ? "after-research" : "direct",
    ...(researchSummary ? { researchSummary } : {}),
  };
}

function rejectionFor(idea: AcceptedIdea, reason: string, researched: boolean): IdeaRejection {
  return {
    title: idea.title,
    reason,
    ...(researched ? { researchAttempted: true } : {}),
  };
}

export default defineTool({
  description:
    "Finalize the weekly trend digest from the original screened proposals and one structured " +
    "research result for each permitted rejection. The deterministic gate remains authoritative: " +
    "research revisions are parsed fail-closed and submitted to that same gate. This tool " +
    "persists only gate-approved ideas. Return the digest verbatim after it succeeds.",
  inputSchema: z
    .object({
      ideas: weeklyIdeaListSchema,
      researchAttempts: z.array(researchAttemptSchema),
    })
    .strict(),
  async execute({ ideas, researchAttempts }) {
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
    const plan = planResearchEscalations(
      ideas,
      new Set(existing.filter((hash): hash is string => hash !== null)),
      trendResearchEscalationCap(),
    );
    const research = resolveResearchEscalations(plan, researchAttempts);
    const accepted: Array<{ idea: AcceptedIdea; researchSummary?: string }> = [
      ...plan.acceptedDirect.map((idea) => ({ idea })),
      ...research.acceptedAfterResearch.map((idea: ResearchAcceptedIdea) => ({
        idea,
        researchSummary: idea.researchSummary,
      })),
    ];
    const rejections: IdeaRejection[] = [...research.rejections];
    const digestIdeas: DigestIdea[] = [];
    for (const { idea, researchSummary } of accepted) {
      const leak = containsLeak(ideaText(idea), leakGuardConfigFromEnv());
      if (leak.leaked) {
        rejections.push(
          rejectionFor(idea, `leak guard: ${leak.reason ?? "unsafe text"}`, Boolean(researchSummary)),
        );
        continue;
      }
      const persisted = await memory.recordDigestIdea({
        title: idea.title,
        url: idea.evidence.match(/https?:\/\/[^\s\])}>]+/u)?.[0] ?? "",
        context: ideaText(idea),
        topicHash: idea.topicHash,
      });
      if (!persisted.recorded) {
        rejections.push(rejectionFor(idea, "topic was already digested", Boolean(researchSummary)));
        continue;
      }
      digestIdeas.push(digestIdea(idea, researchSummary));
    }
    const digest = renderTrendDigest({
      trends: context.trends,
      ideas: digestIdeas,
      rejections,
      spend: context.spend,
      xDataAvailable: context.xDataAvailable,
    });
    console.log(`[trend-digest] rendered weekly digest:\n${digest}`);
    return {
      digest,
      acceptedIdeas: digestIdeas.length,
      acceptedDirect: plan.acceptedDirect.length,
      acceptedAfterResearch: research.acceptedAfterResearch.length,
      rejections,
    };
  },
  toModelOutput(output) {
    return { type: "text", value: output.digest };
  },
});
