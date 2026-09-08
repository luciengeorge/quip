/**
 * Turning individual asks into a judgement about whether something is worth building.
 *
 * A single post with no replies is close to zero evidence. "Or is there a tool for that?" scored 92
 * out of 100 under the ask score, which weighs only freshness and being unanswered, because those
 * are the properties of a fragment nobody bothered to answer. Ranking asks by that score put the
 * emptiest posts at the top of the report every day.
 *
 * Viability needs two things a single ask cannot supply: recurrence, meaning the same want from
 * different people over time, and an incumbent check, because a want that an existing product
 * already serves well is not an opportunity. A theme is the unit that can carry both.
 *
 * The recurrence threshold doubles as the junk filter. A fragment that names nothing cannot be
 * grouped with anything, so it never reaches two askers and never earns a verdict. That is a
 * better filter than a specificity heuristic, which would have to guess at meaning.
 */

export const DEMAND_THEME_WINDOW_DAYS = 14;
export const DEMAND_THEME_VERDICT_MIN_ASKERS = 2;
/** Re-research a theme only when the evidence grew, or when the cached answer is this stale. */
export const DEMAND_THEME_RESEARCH_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
/** New themes one run may create, so a bad classification cannot flood the table. */
export const DEMAND_THEME_MAX_NEW_PER_RUN = 12;

export type IncumbentCoverage = "covers" | "partial" | "none";
export type DemandVerdict = "worth-a-look" | "already-solved" | "unresearchable";

export interface DemandThemeRecord {
  themeKey: string;
  label: string;
  permalinks: string[];
  askers: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  researchedAt?: number;
  researchedAskerCount?: number;
  incumbentCoverage?: IncumbentCoverage;
  incumbents?: { name: string; covers: string }[];
  researchSummary?: string;
  sources?: { url: string; claim: string }[];
  buildDays?: number;
  buildBreakdown?: string;
  verdict?: DemandVerdict;
  verdictAt?: number;
}

/**
 * A stable key for a theme label.
 *
 * Themes only accumulate if the same want maps to the same key across days. Slugging the label
 * means two runs that phrase a label identically converge without needing the model to remember an
 * id, and a near-identical label at least collides often enough to be caught by the caller.
 */
export function demandThemeKey(label: string): string {
  const key = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return key.length > 0 ? key : "unlabelled";
}

export interface ThemeAssignment {
  permalink: string;
  /** Exactly one of these. An existing key joins a theme; a label opens one. */
  themeKey?: string;
  newLabel?: string;
}

export interface ValidatedAssignment {
  permalink: string;
  themeKey: string;
  label: string;
  isNew: boolean;
}

export interface AssignmentValidation {
  assignments: ValidatedAssignment[];
  messages: string[];
}

/**
 * Accept only assignments that refer to asks from this run and themes that exist or are being
 * opened. The model chooses the grouping; it never supplies the evidence, which comes from the
 * stored ask rows, so a wrong assignment can misfile an ask but cannot invent one.
 */
export function validateThemeAssignments(
  raw: readonly unknown[],
  askPermalinks: readonly string[],
  openThemes: readonly Pick<DemandThemeRecord, "themeKey" | "label">[],
): AssignmentValidation {
  const allowed = new Set(askPermalinks);
  const known = new Map(openThemes.map((theme) => [theme.themeKey, theme.label]));
  const assignments: ValidatedAssignment[] = [];
  const seen = new Set<string>();
  const messages: string[] = [];
  let malformed = 0;
  let unknownPermalink = 0;
  let duplicate = 0;
  let newThemes = 0;

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      malformed += 1;
      continue;
    }
    const { permalink, themeKey, newLabel } = entry as ThemeAssignment;
    if (typeof permalink !== "string" || !allowed.has(permalink)) {
      unknownPermalink += 1;
      continue;
    }
    if (seen.has(permalink)) {
      duplicate += 1;
      continue;
    }

    if (typeof themeKey === "string" && known.has(themeKey)) {
      seen.add(permalink);
      assignments.push({
        permalink,
        themeKey,
        label: known.get(themeKey) as string,
        isNew: false,
      });
      continue;
    }
    if (typeof newLabel === "string" && newLabel.trim().length > 0) {
      const label = newLabel.trim().slice(0, 120);
      const key = demandThemeKey(label);
      // A new label that slugs onto an existing theme is that theme, not a second copy of it.
      const existingLabel = known.get(key);
      if (existingLabel === undefined && newThemes >= DEMAND_THEME_MAX_NEW_PER_RUN) {
        messages.push(`Demand themes ignored a new theme past the ${DEMAND_THEME_MAX_NEW_PER_RUN} per run cap.`);
        continue;
      }
      if (existingLabel === undefined) {
        newThemes += 1;
        known.set(key, label);
      }
      seen.add(permalink);
      assignments.push({
        permalink,
        themeKey: key,
        label: existingLabel ?? label,
        isNew: existingLabel === undefined,
      });
      continue;
    }
    malformed += 1;
  }

  if (malformed > 0) messages.push(`Demand themes dropped ${malformed} malformed assignments.`);
  if (unknownPermalink > 0) {
    messages.push(`Demand themes dropped ${unknownPermalink} assignments for asks outside this run.`);
  }
  if (duplicate > 0) messages.push(`Demand themes dropped ${duplicate} duplicate assignments.`);
  return { assignments, messages };
}

/** Distinct askers is the recurrence signal. One person asking five times is still one person. */
export function distinctAskerCount(theme: Pick<DemandThemeRecord, "askers">): number {
  return new Set(theme.askers).size;
}

export function meetsVerdictBar(theme: Pick<DemandThemeRecord, "askers">): boolean {
  return distinctAskerCount(theme) >= DEMAND_THEME_VERDICT_MIN_ASKERS;
}

/**
 * Which themes are worth spending a research call on right now.
 *
 * Research is cached per theme, so a theme already answered costs nothing on later days. It is
 * re-run only when the evidence has actually grown, since a new asker can change whether a gap is
 * real, or when the cached answer has aged out.
 */
export function themesNeedingResearch(
  themes: readonly DemandThemeRecord[],
  now: number,
): DemandThemeRecord[] {
  return themes.filter((theme) => {
    if (!meetsVerdictBar(theme)) return false;
    if (theme.researchedAt === undefined) return true;
    if (now - theme.researchedAt >= DEMAND_THEME_RESEARCH_TTL_MS) return true;
    return distinctAskerCount(theme) > (theme.researchedAskerCount ?? 0);
  });
}

export interface ThemeResearchOutput {
  incumbentCoverage: IncumbentCoverage;
  incumbents: { name: string; covers: string }[];
  researchSummary: string;
  sources: { url: string; claim: string }[];
  buildComponents: string[];
}

/**
 * Decide the verdict in code from the structured research, never from the model's prose.
 *
 * The researcher reports what exists. Whether that makes something worth building is a rule, and a
 * rule belongs in code where it is the same every day and can be tested.
 */
export function verdictFor(coverage: IncumbentCoverage): DemandVerdict {
  return coverage === "covers" ? "already-solved" : "worth-a-look";
}

export function isIncumbentCoverage(value: unknown): value is IncumbentCoverage {
  return value === "covers" || value === "partial" || value === "none";
}
