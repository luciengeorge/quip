import { isDigestDeliveryEnabled, type Logger } from "./config.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type DigestDelivery =
  | { mode: "slack"; channelId: string }
  | { mode: "log"; reason: string };

/** Delivery has a dedicated opt-in so private reporting can never enable public posting. */
export function resolveDigestDelivery(
  env: Env = process.env,
  channelId: string | undefined,
  logger: Logger = console,
): DigestDelivery {
  if (!isDigestDeliveryEnabled(env, logger)) {
    return { mode: "log", reason: "DIGEST_DELIVERY_ENABLED is false" };
  }
  const target = channelId?.trim();
  if (!target) return { mode: "log", reason: "SLACK_CHANNEL_ID is not set" };
  return { mode: "slack", channelId: target };
}
