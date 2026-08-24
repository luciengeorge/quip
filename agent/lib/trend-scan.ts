import { gatherSources, type Candidate, type CandidateSource } from "./candidates.ts";
import { topicHash } from "./dedupe.ts";

export type XSourceStatus = "available" | "unavailable";

export interface TrendObservation {
  topicHash: string;
  day: string;
  title: string;
  url: string;
  source: string;
  count: number;
}

export interface TrendScanRecord {
  day: string;
  scannedAt: number;
  candidateCount: number;
  sources: string[];
  xSourceStatus: XSourceStatus;
}

export interface TrendScanMemory {
  upsertTrendObservations(observations: TrendObservation[]): Promise<void>;
  recordTrendScan(scan: TrendScanRecord): Promise<void>;
}

export interface DailyTrendScanOptions {
  sources: readonly CandidateSource[];
  memory: TrendScanMemory;
  now?: () => number;
  initialMessages?: readonly string[];
  xSourceConfigured: boolean;
}

export interface DailyTrendScanResult {
  candidates: Candidate[];
  observations: TrendObservation[];
  messages: string[];
  xSourceStatus: XSourceStatus;
}

export const X_SOURCE_UNAVAILABLE_MESSAGE =
  "X data was unavailable for this scan; free sources remain available.";

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** Collapse one daily source pass into idempotent per-topic counts for durable velocity. */
export function observationsForDay(candidates: readonly Candidate[], day: string): TrendObservation[] {
  const observations = new Map<string, TrendObservation>();
  for (const candidate of candidates) {
    const hash = topicHash(candidate);
    const previous = observations.get(hash);
    if (previous) {
      previous.count += 1;
      continue;
    }
    observations.set(hash, {
      topicHash: hash,
      day,
      title: candidate.title,
      url: candidate.url,
      source: candidate.source,
      count: 1,
    });
  }
  return [...observations.values()];
}

function xSourceStatus(configured: boolean, messages: readonly string[]): XSourceStatus {
  if (!configured) return "unavailable";
  return messages.some((message) => message.startsWith("X source")) ? "unavailable" : "available";
}

/** Run every configured source without allowing a missing paid source to block the free scan. */
export async function runDailyTrendScan(
  options: DailyTrendScanOptions,
): Promise<DailyTrendScanResult> {
  const now = options.now ?? Date.now;
  const scannedAt = now();
  const gathered = await gatherSources(options.sources);
  const messages = [...(options.initialMessages ?? []), ...gathered.messages];
  const observations = observationsForDay(gathered.candidates, utcDay(scannedAt));
  const status = xSourceStatus(options.xSourceConfigured, messages);
  await options.memory.upsertTrendObservations(observations);
  await options.memory.recordTrendScan({
    day: utcDay(scannedAt),
    scannedAt,
    candidateCount: gathered.candidates.length,
    sources: [...new Set(gathered.candidates.map((candidate) => candidate.source))],
    xSourceStatus: status,
  });
  return {
    candidates: gathered.candidates,
    observations,
    messages,
    xSourceStatus: status,
  };
}
