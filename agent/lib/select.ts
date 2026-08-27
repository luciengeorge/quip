import type { Candidate } from "./candidates.ts";
import { isDuplicate, type RecentItem } from "./dedupe.ts";

export interface SelectionOptions {
  budget: number;
  recent: readonly RecentItem[];
}

const SOURCE_TIER: Record<Candidate["source"], number> = {
  drop: 0,
  github: 1,
  "github-trending": 2,
  hn: 2,
  rss: 2,
  exa: 3,
  x: 3,
  reddit: 3,
  trending: 3,
};

function clearsSelectionBar(candidate: Candidate): boolean {
  return (
    candidate.title.trim().length > 0 &&
    candidate.url.trim().length > 0 &&
    candidate.context.trim().length > 0 &&
    Number.isFinite(candidate.timestamp)
  );
}

function selectionBudget(budget: number): number {
  return Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
}

/** Rank eligible candidates by source tier, then freshness, within the available budget. */
export function selectCandidates(
  candidates: readonly Candidate[],
  options: SelectionOptions,
): Candidate[] {
  const budget = selectionBudget(options.budget);
  if (budget === 0) return [];

  const ranked = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => clearsSelectionBar(candidate))
    .sort((left, right) => {
      const tierDifference = SOURCE_TIER[left.candidate.source] - SOURCE_TIER[right.candidate.source];
      if (tierDifference !== 0) return tierDifference;
      const freshnessDifference = right.candidate.timestamp - left.candidate.timestamp;
      return freshnessDifference !== 0 ? freshnessDifference : left.index - right.index;
    });

  const selected: Candidate[] = [];
  for (const { candidate } of ranked) {
    if (isDuplicate(candidate, options.recent) || isDuplicate(candidate, selected)) continue;
    selected.push(candidate);
    if (selected.length === budget) break;
  }
  return selected;
}
