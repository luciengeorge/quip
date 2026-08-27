import { containsLeak, type LeakGuardConfig } from "./leak-guard.ts";

export type CandidateSourceName =
  | "github"
  | "github-trending"
  | "hn"
  | "rss"
  | "drop"
  | "exa"
  | "x"
  | "reddit"
  | "stackexchange"
  | "trending";

export interface Candidate {
  source: CandidateSourceName;
  title: string;
  url: string;
  context: string;
  timestamp: number;
}

export interface CandidateRejection {
  candidate: Candidate;
  reason: string;
}

export interface CandidateIngestResult {
  candidates: Candidate[];
  rejections: CandidateRejection[];
}

export interface SourceResult {
  candidates: Candidate[];
  messages: string[];
}

export interface CandidateSource {
  gather(): Promise<SourceResult>;
}

function candidateText(candidate: Candidate): string {
  return [candidate.title, candidate.url, candidate.context].join("\n");
}

/** Reject unsafe content before it enters the durable candidate pipeline. */
export function ingestCandidates(
  candidates: readonly Candidate[],
  leakGuard: LeakGuardConfig = {},
): CandidateIngestResult {
  const accepted: Candidate[] = [];
  const rejections: CandidateRejection[] = [];
  for (const candidate of candidates) {
    const check = containsLeak(candidateText(candidate), leakGuard);
    if (check.leaked) {
      rejections.push({ candidate, reason: check.reason ?? "leak guard" });
      continue;
    }
    accepted.push(candidate);
  }
  return { candidates: accepted, rejections };
}

export function sourceResult(
  candidates: readonly Candidate[],
  leakGuard: LeakGuardConfig = {},
  messages: readonly string[] = [],
): SourceResult {
  const ingested = ingestCandidates(candidates, leakGuard);
  return {
    candidates: ingested.candidates,
    messages: [
      ...messages,
      ...ingested.rejections.map(
        (rejection) => `Candidate rejected by leak guard: ${rejection.reason}.`,
      ),
    ],
  };
}

/** Gather every source independently so a degraded paid source cannot block free sources. */
export async function gatherSources(sources: readonly CandidateSource[]): Promise<SourceResult> {
  const outcomes = await Promise.allSettled(sources.map((source) => source.gather()));
  const candidates: Candidate[] = [];
  const messages: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled") {
      candidates.push(...outcome.value.candidates);
      messages.push(...outcome.value.messages);
      continue;
    }
    messages.push("A content source failed; other sources remain available.");
  }
  return { candidates, messages };
}
