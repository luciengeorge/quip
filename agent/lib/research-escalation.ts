import {
  checkIdeas,
  ideaTopicHash,
  type AcceptedIdea,
  type IdeaRejection,
  type ProposedIdea,
} from "./idea-gate.ts";

export interface ResearchRequest {
  original: ProposedIdea;
  rejection: IdeaRejection;
}

export interface ResearchEscalationPlan {
  acceptedDirect: AcceptedIdea[];
  rejections: IdeaRejection[];
  researchRequests: ResearchRequest[];
  cap: number;
  existingTopicHashes: string[];
}

export interface ResearchAttempt {
  originalTitle: string;
  output: unknown;
}

export interface ResearchSource {
  url: string;
  claim: string;
}

export interface ResearchRevision {
  revisedProposal: ProposedIdea;
  researchSummary: string;
  sources: ResearchSource[];
}

export interface ResearchAcceptedIdea extends AcceptedIdea {
  researchSummary: string;
  researchSources: ResearchSource[];
}

export interface ResearchEscalationResult {
  acceptedAfterResearch: ResearchAcceptedIdea[];
  rejections: IdeaRejection[];
}

function isDuplicateRejection(rejection: IdeaRejection): boolean {
  return rejection.reason === "topic was already digested";
}

function string(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum
    ? value.trim()
    : null;
}

function proposedIdea(value: unknown): ProposedIdea | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const title = string(raw.title, 180);
  const trendTitle = string(raw.trendTitle, 240);
  const mechanism = string(raw.mechanism, 700);
  const evidence = string(raw.evidence, 700);
  const moatClass = string(raw.moatClass, 40);
  const ownerFit = string(raw.ownerFit, 500);
  if (
    !title ||
    !trendTitle ||
    !mechanism ||
    !evidence ||
    !moatClass ||
    !ownerFit ||
    !Array.isArray(raw.buildComponents) ||
    !raw.buildComponents.every((component) => typeof component === "string" && component.length > 0)
  ) {
    return null;
  }
  return {
    title,
    trendTitle,
    mechanism,
    evidence,
    moatClass,
    buildComponents: [...raw.buildComponents],
    ownerFit,
  };
}

function researchSources(value: unknown): ResearchSource[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) return null;
  const sources: ResearchSource[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
    const raw = candidate as Record<string, unknown>;
    const url = string(raw.url, 700);
    const claim = string(raw.claim, 500);
    if (!url || !claim || !/^https?:\/\//iu.test(url) || !/\b\d[\d,.]*\b/u.test(claim)) return null;
    sources.push({ url, claim });
  }
  return sources;
}

/** Reject malformed subagent output rather than attempting to infer a revision from prose. */
export function parseResearchRevision(value: unknown): ResearchRevision | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const revisedProposal = proposedIdea(raw.revisedProposal);
  const researchSummary = string(raw.researchSummary, 700);
  const sources = researchSources(raw.sources);
  if (!revisedProposal || !researchSummary || !sources) return null;
  return { revisedProposal, researchSummary, sources };
}

/**
 * Run the deterministic gate one proposal at a time so each rejection remains
 * paired with its original proposal. The cap is code, not an instruction: no
 * later stage can turn a non-requested rejection into a researched admission.
 */
export function planResearchEscalations(
  ideas: readonly ProposedIdea[],
  alreadyDigested: ReadonlySet<string>,
  cap: number,
): ResearchEscalationPlan {
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("Invalid research escalation cap");
  const seen = new Set(alreadyDigested);
  const acceptedDirect: AcceptedIdea[] = [];
  const rejections: IdeaRejection[] = [];
  const researchRequests: ResearchRequest[] = [];
  for (const idea of ideas) {
    const gate = checkIdeas([idea], seen);
    const accepted = gate.accepted[0];
    if (accepted) {
      acceptedDirect.push(accepted);
      seen.add(accepted.topicHash);
      continue;
    }
    const rejection = gate.rejected[0];
    if (!rejection) throw new Error("Idea gate returned no decision");
    rejections.push(rejection);
    if (!isDuplicateRejection(rejection) && researchRequests.length < cap) {
      researchRequests.push({ original: idea, rejection });
    }
  }
  return {
    acceptedDirect,
    rejections,
    researchRequests,
    cap,
    existingTopicHashes: [...alreadyDigested],
  };
}

/**
 * Accept research only after its complete revised proposal passes the same
 * deterministic gate. Research contributes facts; it never supplies an
 * admission verdict or a bypass for duplicates.
 */
export function resolveResearchEscalations(
  plan: ResearchEscalationPlan,
  attempts: readonly ResearchAttempt[],
): ResearchEscalationResult {
  if (attempts.length > plan.cap) throw new Error("Research escalation cap exceeded");
  const requestsByTitle = new Map(
    plan.researchRequests.map((request) => [request.original.title, request]),
  );
  const attemptsByTitle = new Map<string, ResearchAttempt>();
  for (const attempt of attempts) {
    if (!requestsByTitle.has(attempt.originalTitle) || attemptsByTitle.has(attempt.originalTitle)) {
      throw new Error("Research attempt did not match one requested rejected idea");
    }
    attemptsByTitle.set(attempt.originalTitle, attempt);
  }

  const seen = new Set(plan.existingTopicHashes);
  for (const accepted of plan.acceptedDirect) seen.add(accepted.topicHash);
  const acceptedAfterResearch: ResearchAcceptedIdea[] = [];
  const rejections = plan.rejections.filter(
    (rejection) => !requestsByTitle.has(rejection.title),
  );
  for (const request of plan.researchRequests) {
    const attempt = attemptsByTitle.get(request.original.title);
    const revision = attempt ? parseResearchRevision(attempt.output) : null;
    if (!revision) {
      rejections.push({
        title: request.original.title,
        reason: `${request.rejection.reason}; research returned no valid revision`,
        researchAttempted: true,
      });
      continue;
    }
    const gate = checkIdeas([revision.revisedProposal], seen);
    const accepted = gate.accepted[0];
    if (!accepted) {
      rejections.push({
        title: request.original.title,
        reason: `${gate.rejected[0]?.reason ?? "research revision did not pass the gate"}; research revision rejected`,
        researchAttempted: true,
      });
      continue;
    }
    seen.add(accepted.topicHash);
    acceptedAfterResearch.push({
      ...accepted,
      researchSummary: revision.researchSummary,
      researchSources: revision.sources,
    });
  }
  return { acceptedAfterResearch, rejections };
}

/** Exposed for callers that need the exact shared duplicate hash before a memory lookup. */
export const researchIdeaTopicHash = ideaTopicHash;
