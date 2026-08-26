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

export interface TrendObservationUpsertResult {
  skippedCount: number;
}

export interface TrendScanMemory {
  upsertTrendObservations(
    observations: TrendObservation[],
  ): Promise<TrendObservationUpsertResult>;
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

export interface ObservationsForDayResult {
  observations: TrendObservation[];
  droppedCount: number;
}

/** Collapse one daily source pass into idempotent per-topic counts for durable velocity. */
export function observationsForDay(
  candidates: readonly Candidate[],
  day: string,
): ObservationsForDayResult {
  const observations = new Map<string, TrendObservation>();
  let droppedCount = 0;
  for (const candidate of candidates) {
    const title = candidate.title.trim();
    const url = candidate.url.trim();
    const source = candidate.source.trim();
    const hash = topicHash({ title, url }).trim();
    if (
      title.length === 0 ||
      url.length === 0 ||
      source.length === 0 ||
      hash.length === 0
    ) {
      droppedCount += 1;
      continue;
    }
    const previous = observations.get(hash);
    if (previous) {
      previous.count += 1;
      continue;
    }
    observations.set(hash, {
      topicHash: hash,
      day,
      title,
      url,
      source,
      count: 1,
    });
  }
  return { observations: [...observations.values()], droppedCount };
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
  const day = utcDay(scannedAt);
  const observationResult = observationsForDay(gathered.candidates, day);
  const observations = observationResult.observations;
  if (observationResult.droppedCount > 0) {
    messages.push(
      `Trend scan dropped ${observationResult.droppedCount} invalid candidates before persistence.`,
    );
  }
  const status = xSourceStatus(options.xSourceConfigured, messages);
  try {
    const { skippedCount } = await options.memory.upsertTrendObservations(observations);
    if (skippedCount > 0) {
      messages.push(`Trend observation persistence skipped ${skippedCount} invalid rows.`);
    }
  } catch {
    messages.push("Trend observation persistence failed; scan record was still written.");
  }
  await options.memory.recordTrendScan({
    day,
    scannedAt,
    candidateCount: gathered.candidates.length,
    sources: [...new Set(observations.map((observation) => observation.source))],
    xSourceStatus: status,
  });
  return {
    candidates: gathered.candidates,
    observations,
    messages,
    xSourceStatus: status,
  };
}
