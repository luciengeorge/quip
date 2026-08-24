/**
 * Estimates are calibrated for an experienced developer working with an LLM:
 * ordinary CRUD, auth, and payment plumbing are typically hours, not the
 * human-only timelines found in training data. They cover build work only;
 * distribution is usually the larger bottleneck for these ideas.
 */
export const BUILD_COMPONENT_COSTS = {
  "base app shell": 1,
  auth: 0.5,
  payments: 0.5,
  "third-party API integration": 1,
  "scraping or crawling": 1.5,
  "data pipeline or ETL": 2,
  "LLM feature": 1,
  realtime: 1.5,
  "browser extension": 1.5,
  "mobile app": 3,
  "two-sided marketplace": 3,
  "manual ops bootstrap": 2,
  "regulated or compliance work": 5,
} as const;

export type BuildComponent = Exclude<keyof typeof BUILD_COMPONENT_COSTS, "base app shell">;

const BASE_APP_SHELL: keyof typeof BUILD_COMPONENT_COSTS = "base app shell";
const MAX_BUILD_DAYS = 14;

const COMPONENT_LABELS: Readonly<
  Record<BuildComponent, { singular: string; plural: string }>
> = {
  auth: { singular: "auth", plural: "auth components" },
  payments: { singular: "payments", plural: "payment flows" },
  "third-party API integration": { singular: "integration", plural: "integrations" },
  "scraping or crawling": { singular: "scraping", plural: "scrapers" },
  "data pipeline or ETL": { singular: "data pipeline", plural: "data pipelines" },
  "LLM feature": { singular: "LLM feature", plural: "LLM features" },
  realtime: { singular: "realtime", plural: "realtime features" },
  "browser extension": { singular: "browser extension", plural: "browser extensions" },
  "mobile app": { singular: "mobile app", plural: "mobile apps" },
  "two-sided marketplace": { singular: "two-sided marketplace", plural: "two-sided marketplaces" },
  "manual ops bootstrap": { singular: "manual ops", plural: "manual ops bootstraps" },
  "regulated or compliance work": { singular: "compliance", plural: "compliance workstreams" },
};

export type BuildEstimate =
  | { ok: true; buildDays: number; breakdown: string }
  | { ok: false; reason: string };

function isBuildComponent(value: string): value is BuildComponent {
  return Object.hasOwn(BUILD_COMPONENT_COSTS, value) && value !== BASE_APP_SHELL;
}

function roundToOneDecimal(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

/** Format the declared component list so a reader can audit every cost in the total. */
export function formatBuildBreakdown(components: readonly BuildComponent[]): string {
  const counts = new Map<BuildComponent, number>();
  for (const component of components) {
    counts.set(component, (counts.get(component) ?? 0) + 1);
  }
  const labels = ["shell"];
  for (const [component, count] of counts) {
    const label = COMPONENT_LABELS[component];
    labels.push(
      component === "third-party API integration"
        ? `${count} ${count === 1 ? label.singular : label.plural}`
        : count === 1
          ? label.singular
          : `${count} ${label.plural}`,
    );
  }
  return labels.join(" + ");
}

/** Compute the estimate from the fixed taxonomy instead of accepting a model-supplied duration. */
export function calculateBuildEstimate(components: readonly string[]): BuildEstimate {
  if (components.length === 0) {
    return { ok: false, reason: "at least one build component must be declared" };
  }
  for (const component of components) {
    if (!isBuildComponent(component)) {
      return {
        ok: false,
        reason: `build component is not in the fixed taxonomy: ${component}`,
      };
    }
  }
  const typedComponents = components as readonly BuildComponent[];
  const buildDays = roundToOneDecimal(
    BUILD_COMPONENT_COSTS[BASE_APP_SHELL] +
      typedComponents.reduce((total, component) => total + BUILD_COMPONENT_COSTS[component], 0),
  );
  if (buildDays > MAX_BUILD_DAYS) {
    return {
      ok: false,
      reason: `computed build estimate exceeds the ${MAX_BUILD_DAYS} day cap (${buildDays.toFixed(1)} days)`,
    };
  }
  return { ok: true, buildDays, breakdown: formatBuildBreakdown(typedComponents) };
}
