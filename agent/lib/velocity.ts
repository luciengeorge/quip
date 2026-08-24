export type TrendDirection = "accelerating" | "flat" | "cooling";

export interface DailyCount {
  day: string;
  count: number;
}

export interface TrendWindow {
  startDay: string;
  endDay: string;
  scannedDays: readonly string[];
}

export interface VelocityResult {
  isTrend: boolean;
  direction: TrendDirection | null;
  reason: "insufficient-history" | "incomplete-series" | "single-day-spike" | null;
  counts: number[];
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function dayTimestamp(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return null;
  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function daysInWindow(window: TrendWindow): string[] {
  const start = dayTimestamp(window.startDay);
  const end = dayTimestamp(window.endDay);
  if (start === null || end === null || end < start) return [];
  const days: string[] = [];
  for (let timestamp = start; timestamp <= end; timestamp += DAY_MS) {
    days.push(new Date(timestamp).toISOString().slice(0, 10));
  }
  return days;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Measure a topic's derivative only across a fully scanned daily window. Missing scans are
 * unknown data, while a scanned day with no observation is a real zero.
 */
export function calculateVelocity(
  observations: readonly DailyCount[],
  window: TrendWindow,
): VelocityResult {
  const days = daysInWindow(window);
  if (days.length < 2) {
    return { isTrend: false, direction: null, reason: "insufficient-history", counts: [] };
  }

  const scannedDays = new Set(window.scannedDays);
  if (days.some((day) => !scannedDays.has(day))) {
    return { isTrend: false, direction: null, reason: "incomplete-series", counts: [] };
  }

  const countByDay = new Map<string, number>();
  for (const observation of observations) {
    if (!days.includes(observation.day) || !Number.isFinite(observation.count) || observation.count < 0) {
      continue;
    }
    countByDay.set(observation.day, (countByDay.get(observation.day) ?? 0) + observation.count);
  }
  const counts = days.map((day) => countByDay.get(day) ?? 0);
  const activeDays = counts.filter((count) => count > 0).length;
  if (activeDays < 2) {
    return { isTrend: false, direction: null, reason: "single-day-spike", counts };
  }

  const split = Math.floor(counts.length / 2);
  const earlier = mean(counts.slice(0, split));
  const later = mean(counts.slice(split));
  const direction: TrendDirection =
    later > earlier * 1.15
      ? "accelerating"
      : later < earlier * 0.85
        ? "cooling"
        : "flat";
  return { isTrend: true, direction, reason: null, counts };
}
