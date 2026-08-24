export interface Logger {
  warn(message: string): void;
}

type Env = Readonly<Record<string, string | undefined>>;

const DEFAULT_WEEKLY_TARGET = 10;
const DEFAULT_DAILY_CAP = 2;
const DEFAULT_MIN_GAP_HOURS = 4;

function warnInvalidSetting(
  name: string,
  fallback: boolean | number,
  logger: Logger,
): void {
  logger.warn(`Invalid ${name}; using safe default ${fallback}.`);
}

function booleanSetting(
  name: string,
  value: string | undefined,
  fallback: boolean,
  logger: Logger,
): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  warnInvalidSetting(name, fallback, logger);
  return fallback;
}

function positiveIntegerSetting(
  name: string,
  value: string | undefined,
  fallback: number,
  logger: Logger,
): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) {
    warnInvalidSetting(name, fallback, logger);
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    warnInvalidSetting(name, fallback, logger);
    return fallback;
  }
  return parsed;
}

/** True unless DRY_RUN is explicitly set to the canonical value "false". */
export function isDryRun(env: Env = process.env, logger: Logger = console): boolean {
  return booleanSetting("DRY_RUN", env.DRY_RUN, true, logger);
}

/** False unless POSTING_ENABLED is explicitly set to the canonical value "true". */
export function isPostingEnabled(
  env: Env = process.env,
  logger: Logger = console,
): boolean {
  return booleanSetting("POSTING_ENABLED", env.POSTING_ENABLED, false, logger);
}

export function weeklyTarget(
  env: Env = process.env,
  logger: Logger = console,
): number {
  return positiveIntegerSetting(
    "TWEET_WEEKLY_TARGET",
    env.TWEET_WEEKLY_TARGET,
    DEFAULT_WEEKLY_TARGET,
    logger,
  );
}

export function dailyPostCap(
  env: Env = process.env,
  logger: Logger = console,
): number {
  return positiveIntegerSetting(
    "TWEET_DAILY_CAP",
    env.TWEET_DAILY_CAP,
    DEFAULT_DAILY_CAP,
    logger,
  );
}

export function minimumPostingGapMs(
  env: Env = process.env,
  logger: Logger = console,
): number {
  const hours = positiveIntegerSetting(
    "TWEET_MIN_GAP_HOURS",
    env.TWEET_MIN_GAP_HOURS,
    DEFAULT_MIN_GAP_HOURS,
    logger,
  );
  return hours * 60 * 60 * 1_000;
}
