import { ConvexHttpClient } from "convex/browser";
import { anyApi, type FunctionReference } from "convex/server";

/** Minimal Convex client surface the memory layer needs. Injectable for tests. */
export interface ConvexLike {
  mutation(
    ref: FunctionReference<"mutation">,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  query(
    ref: FunctionReference<"query">,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

export type CandidateStatus = "new" | "drafted" | "posted" | "rejected" | "stale";

export interface CandidateRecord {
  source: string;
  url: string;
  title: string;
  context: string;
  topicHash: string;
  status: CandidateStatus;
}

export interface StoredCandidate extends CandidateRecord {
  _id: string;
  createdAt: number;
}

export interface PostMetrics {
  likes: number;
  reposts: number;
  impressions: number;
  replies: number;
}

export interface PostRecord {
  tweetId: string;
  text: string;
  source: string;
  topicHash: string;
  postedAt: number;
  metrics?: PostMetrics;
}

export interface VoiceProfileRecord {
  profile: string;
  sampleTweetIds: string[];
}

export interface StoredVoiceProfile extends VoiceProfileRecord {
  _id: string;
  updatedAt: number;
}

export interface GateRejection {
  text: string;
  reason: string;
  layer: string;
}

export interface CycleRecord {
  ranAt: number;
  gathered: number;
  drafted: number;
  gateRejections: GateRejection[];
  posted: string[];
  decision: string;
  rationale: string;
}

export interface CronRunRecord {
  schedule: string;
  firedAt: number;
  dispatched: boolean;
}

export interface StoredCronRun extends CronRunRecord {
  _id: string;
}

export interface XReadReservation {
  allowed: boolean;
  reservationId: string | null;
  remainingReads: number;
}

export interface XReadSpend {
  month: string;
  usedReads: number;
  reservedReads: number;
  capReads: number;
  usedUsd: number;
  capUsd: number;
}

export type XSourceStatus = "available" | "unavailable";

export interface TrendObservationRecord {
  topicHash: string;
  day: string;
  title: string;
  url: string;
  source: string;
  count: number;
}

export interface TrendObservationUpsertResult {
  skippedCount: number;
}

export interface TrendScanRecord {
  day: string;
  scannedAt: number;
  candidateCount: number;
  sources: string[];
  xSourceStatus: XSourceStatus;
}

export interface DigestIdeaRecord {
  title: string;
  url: string;
  context: string;
  topicHash: string;
}

const fns = anyApi.memory;

function ref(name: string): FunctionReference<"mutation"> & FunctionReference<"query"> {
  return fns[name] as unknown as FunctionReference<"mutation"> &
    FunctionReference<"query">;
}

export class Memory {
  private readonly client: ConvexLike;
  private readonly token: string;

  constructor(client: ConvexLike, token: string) {
    this.client = client;
    this.token = token;
  }

  private mutation(name: string, args: object): Promise<unknown> {
    const payload: Record<string, unknown> = { token: this.token, ...args };
    return this.client.mutation(ref(name), payload);
  }

  private query(name: string, args: object): Promise<unknown> {
    const payload: Record<string, unknown> = { token: this.token, ...args };
    return this.client.query(ref(name), payload);
  }

  recordCandidate(candidate: CandidateRecord): Promise<string> {
    return this.mutation("recordCandidate", candidate) as Promise<string>;
  }

  recordDigestIdea(idea: DigestIdeaRecord): Promise<{ recorded: boolean }> {
    return this.mutation("recordDigestIdea", idea) as Promise<{ recorded: boolean }>;
  }

  candidateByUrl(url: string): Promise<StoredCandidate | null> {
    return this.query("candidateByUrl", { url }) as Promise<StoredCandidate | null>;
  }

  candidateByTopicHash(topicHash: string): Promise<StoredCandidate | null> {
    return this.query("candidateByTopicHash", { topicHash }) as Promise<
      StoredCandidate | null
    >;
  }

  updateCandidateStatus(candidateId: string, status: CandidateStatus): Promise<string> {
    return this.mutation("updateCandidateStatus", { candidateId, status }) as Promise<string>;
  }

  recordPost(post: PostRecord): Promise<string> {
    return this.mutation("recordPost", post) as Promise<string>;
  }

  saveVoiceProfile(profile: VoiceProfileRecord): Promise<string> {
    return this.mutation("saveVoiceProfile", profile) as Promise<string>;
  }

  getVoiceProfile(): Promise<StoredVoiceProfile | null> {
    return this.query("getVoiceProfile", {}) as Promise<StoredVoiceProfile | null>;
  }

  recordCycle(cycle: CycleRecord): Promise<string> {
    return this.mutation("recordCycle", cycle) as Promise<string>;
  }

  recordCronRun(run: CronRunRecord): Promise<string> {
    return this.mutation("recordCronRun", run) as Promise<string>;
  }

  latestCronRun(schedule: string): Promise<StoredCronRun | null> {
    return this.query("latestCronRun", { schedule }) as Promise<StoredCronRun | null>;
  }

  reserveXReads(reads: number): Promise<XReadReservation> {
    return this.mutation("reserveXReads", { reads }) as Promise<XReadReservation>;
  }

  async settleXReads(reservationId: string, actualReads: number): Promise<void> {
    await this.mutation("settleXReads", { reservationId, actualReads });
  }

  getXReadSpend(): Promise<XReadSpend> {
    return this.query("getXReadSpend", {}) as Promise<XReadSpend>;
  }

  upsertTrendObservations(
    observations: TrendObservationRecord[],
  ): Promise<TrendObservationUpsertResult> {
    return this.mutation("upsertTrendObservations", { observations }) as Promise<TrendObservationUpsertResult>;
  }

  async recordTrendScan(scan: TrendScanRecord): Promise<void> {
    await this.mutation("recordTrendScan", scan);
  }

  trendObservationsInRange(
    startDay: string,
    endDay: string,
  ): Promise<TrendObservationRecord[]> {
    return this.query("trendObservationsInRange", { startDay, endDay }) as Promise<
      TrendObservationRecord[]
    >;
  }

  trendScansInRange(startDay: string, endDay: string): Promise<TrendScanRecord[]> {
    return this.query("trendScansInRange", { startDay, endDay }) as Promise<TrendScanRecord[]>;
  }
}

/** Build the durable-memory client from environment variables without exposing values. */
export function memoryFromEnv(client?: ConvexLike): Memory {
  const token = process.env.CONVEX_APP_SECRET;
  if (!token || token.trim().length === 0) {
    throw new Error("CONVEX_APP_SECRET is not set");
  }
  if (client) return new Memory(client, token);

  const url = process.env.CONVEX_URL;
  if (!url || url.trim().length === 0) {
    throw new Error("CONVEX_URL is not set");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("CONVEX_URL is invalid");
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error("CONVEX_URL is invalid");
  }

  return new Memory(new ConvexHttpClient(url) as unknown as ConvexLike, token);
}
