import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveReactionLevel,
  type ReactionLevel,
  type ResolvedReactionLevel,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";

export type WhatsAppReactionLevel = ReactionLevel;
export type ResolvedWhatsAppReactionLevel = ResolvedReactionLevel;

/**
 * Resolve the effective reaction level and its implications for WhatsApp.
 *
 * Levels:
 * - "off": No reactions at all
 * - "ack": Only automatic ack reactions, no agent reactions
 * - "minimal": Agent can react, but sparingly
 * - "extensive": Agent can react liberally (default)
 */
export function resolveWhatsAppReactionLevel(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedWhatsAppReactionLevel {
  const account = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  return resolveReactionLevel({
    value: account.reactionLevel,
    defaultLevel: "minimal",
    invalidFallback: "minimal",
  });
}
