// Shared-secret gate for every public function in convex/memory.ts. The agent talks to
// Convex over ConvexHttpClient, which can only call public functions, so every call must
// carry a token that matches APP_SHARED_SECRET, configured as a Convex environment variable.
// Convex functions use a stricter TypeScript config without Node types, so declare only the
// process environment shape this module needs.
declare const process: { env: Record<string, string | undefined> };

export function assertSecret(token: string | undefined): void {
  const secret = process.env.APP_SHARED_SECRET;
  if (!secret || token !== secret) {
    throw new Error("Unauthenticated");
  }
}
