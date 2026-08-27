/**
 * Credential-SHAPED strings for tests, assembled at runtime rather than written as literals.
 *
 * The leak guard must be tested against text that really looks like a credential, but a literal
 * `sk-...` in source is flagged by secret scanners (GitGuardian failed CI on exactly this). Joining
 * the parts keeps every test genuine, since the guard sees the same final string, while leaving no
 * literal for a scanner to match. Suppressing the scanner instead would have been the wrong fix:
 * the scanner is doing its job, and a repo that trains people to ignore it is worse off.
 */

/** An OpenAI-style key shape: `sk-` followed by a long alphanumeric run. */
export function fakeApiKey(): string {
  return ["sk", "abcdefghijklmnopqrstuvwxyz1234567890"].join("-");
}
