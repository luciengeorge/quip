export interface LeakGuardConfig {
  privateRepoNames?: readonly string[];
  internalTerms?: readonly string[];
}

export interface LeakCheck {
  leaked: boolean;
  reason?: "private repository name" | "employer-internal term" | "credential-shaped text";
}

type Env = Readonly<Record<string, string | undefined>>;

const SECRET_KEY_PREFIX = /\bsk-[A-Za-z0-9_-]{20,}\b/;
const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;
const LONG_HEX = /\b[a-f0-9]{32,}\b/i;
const BASE64_CANDIDATE = /[A-Za-z0-9+/]{40,}={0,2}/g;

function configuredTermInText(text: string, terms: readonly string[] | undefined): boolean {
  const normalised = text.toLocaleLowerCase();
  return (terms ?? []).some((term) => {
    const value = term.trim().toLocaleLowerCase();
    return value.length > 0 && normalised.includes(value);
  });
}

function hasBase64Blob(text: string): boolean {
  for (const token of text.match(BASE64_CANDIDATE) ?? []) {
    const core = token.replace(/=+$/, "");
    const mixedAlphanumeric = /[A-Z]/.test(core) && /[a-z]/.test(core) && /\d/.test(core);
    if (/[+/=]/.test(token) || mixedAlphanumeric) return true;
  }
  return false;
}

function hasCredentialShape(text: string): boolean {
  return (
    SECRET_KEY_PREFIX.test(text) ||
    PEM_PRIVATE_KEY.test(text) ||
    LONG_HEX.test(text) ||
    hasBase64Blob(text)
  );
}

/** Pure deterministic guard used before ingestion and again by the later code gate. */
export function containsLeak(text: string, config: LeakGuardConfig = {}): LeakCheck {
  if (configuredTermInText(text, config.privateRepoNames)) {
    return { leaked: true, reason: "private repository name" };
  }
  if (configuredTermInText(text, config.internalTerms)) {
    return { leaked: true, reason: "employer-internal term" };
  }
  if (hasCredentialShape(text)) {
    return { leaked: true, reason: "credential-shaped text" };
  }
  return { leaked: false };
}

function listSetting(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Load non-secret leak terms from environment without making the guard itself impure. */
export function leakGuardConfigFromEnv(env: Env = process.env): LeakGuardConfig {
  return {
    privateRepoNames: listSetting(env.LEAK_GUARD_PRIVATE_REPOS),
    internalTerms: listSetting(env.LEAK_GUARD_INTERNAL_TERMS),
  };
}
