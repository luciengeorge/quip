import { demandAskLine, flattenQuote, type ReportableDemandAsk } from "./demand-report.ts";
import {
  DEMAND_THEME_VERDICT_MIN_ASKERS,
  DEMAND_THEME_WINDOW_DAYS,
  distinctAskerCount,
  type DemandThemeRecord,
} from "./demand-themes.ts";
import { containsLeak } from "./leak-guard.ts";

/**
 * The daily message, led by conclusions.
 *
 * The previous report was a ranked list of individual posts, which asked the reader to do the
 * analysis. What a list of eight fragments cannot say is whether any of it is worth building, so
 * verdicts come first, the evidence that produced them sits underneath, and raw asks are last.
 */

const VERDICT_LABEL = {
  "worth-a-look": "WORTH A LOOK",
  "already-solved": "ALREADY SOLVED",
  unresearchable: "UNRESEARCHABLE",
} as const;

export interface DemandVerdictReportInput {
  day: string;
  themes: readonly DemandThemeRecord[];
  newAsks: readonly ReportableDemandAsk[];
  candidateCount: number;
  /** Asks stored across the whole theme window, which is the pool the verdicts are drawn from. */
  windowAskCount: number;
  generatedAt: number;
  notes?: readonly string[];
}

function themeAge(theme: DemandThemeRecord, generatedAt: number): string {
  const days = Math.max(0, Math.round((generatedAt - theme.firstSeenAt) / (24 * 60 * 60 * 1_000)));
  if (days === 0) return "today";
  return days === 1 ? "over 1 day" : `over ${days} days`;
}

function themeIsSafe(theme: DemandThemeRecord): boolean {
  const text = [theme.label, theme.researchSummary ?? "", ...(theme.incumbents ?? []).map((i) => `${i.name} ${i.covers}`)].join(" ");
  return !containsLeak(text).leaked;
}

function verdictBlock(theme: DemandThemeRecord, generatedAt: number): string[] {
  const askers = distinctAskerCount(theme);
  const lines = [
    `**${theme.label}** ${VERDICT_LABEL[theme.verdict ?? "unresearchable"]}`,
    `${theme.permalinks.length} ${theme.permalinks.length === 1 ? "ask" : "asks"}, ${askers} ${askers === 1 ? "asker" : "askers"}, ${themeAge(theme, generatedAt)}.`,
  ];
  if (theme.researchSummary) lines.push(flattenQuote(theme.researchSummary));

  const incumbents = theme.incumbents ?? [];
  if (incumbents.length > 0) {
    lines.push(
      `Incumbents: ${incumbents.map((one) => `${one.name} (${flattenQuote(one.covers)})`).join("; ")}.`,
    );
  } else if (theme.incumbentCoverage === "none") {
    lines.push("Incumbents: none found.");
  }

  // A build estimate for something that already exists is noise: the decision is already made.
  if (theme.buildDays !== undefined && theme.verdict !== "already-solved") {
    lines.push(`Build: ~${theme.buildDays} ${theme.buildDays === 1 ? "day" : "days"}${theme.buildBreakdown ? ` (${theme.buildBreakdown})` : ""}.`);
  }
  for (const source of (theme.sources ?? []).slice(0, 3)) lines.push(`  ${source.url}`);
  return lines;
}

/** Render the day's verdicts, the themes still gathering evidence, and the new raw asks. */
export function renderDemandVerdictReport(input: DemandVerdictReportInput): string {
  const safe = input.themes.filter(themeIsSafe);
  const judged = safe
    .filter((theme) => theme.verdict !== undefined)
    .sort((a, b) => distinctAskerCount(b) - distinctAskerCount(a));
  const tracked = safe
    .filter((theme) => theme.verdict === undefined)
    .sort((a, b) => b.permalinks.length - a.permalinks.length);

  const lines = [`# Quip demand, ${input.day}`, ""];

  lines.push("## Verdicts");
  if (judged.length === 0) {
    // Naming what it would take is the difference between "nothing today" and "nothing working".
    lines.push(
      `Nothing has reached ${DEMAND_THEME_VERDICT_MIN_ASKERS} distinct askers in ${DEMAND_THEME_WINDOW_DAYS} days yet.`,
    );
  } else {
    for (const theme of judged) {
      lines.push("", ...verdictBlock(theme, input.generatedAt));
    }
  }

  lines.push("", `## Tracked, not yet judged (${tracked.length})`);
  if (tracked.length === 0) {
    lines.push("Nothing tracked.");
  } else {
    lines.push(
      tracked
        .slice(0, 12)
        .map((theme) => `${theme.label} (${theme.permalinks.length})`)
        .join(", "),
    );
  }

  lines.push(
    "",
    `## New asks today (${input.newAsks.length})`,
    `From ${input.candidateCount} candidates scanned. ${input.windowAskCount} asks tracked over ${DEMAND_THEME_WINDOW_DAYS} days.`,
    "Evidence only. These are not people to reply to.",
  );
  const safeAsks = input.newAsks.filter((ask) => !containsLeak(`${ask.quote} ${ask.permalink} ${ask.askedFor}`).leaked);
  if (safeAsks.length === 0) {
    lines.push("- None.");
  } else {
    lines.push(...safeAsks.slice(0, 8).map((ask) => demandAskLine(ask, input.generatedAt)));
  }

  const notes = input.notes ?? [];
  if (notes.length > 0) lines.push("", ...notes.map((note) => `- ${note}`));
  return lines.join("\n");
}
