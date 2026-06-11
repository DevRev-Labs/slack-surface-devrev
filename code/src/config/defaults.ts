/**
 * Centralized runtime configuration.
 *
 * Anything that might reasonably differ between dev / staging / prod or that
 * an operator should be able to tune without a code change lives here. Each
 * value:
 *  - has a hard-coded default (matches today's behavior so this module is
 *    drop-in safe),
 *  - can be overridden via an environment variable (documented in
 *    `.env.example` at the repo root).
 *
 * Why an explicit module instead of a YAML/JSON properties file?
 *  - Snap-ins run inside a sandbox where reading a file at startup is more
 *    costly than reading `process.env`, and the platform already exposes
 *    operator inputs as env vars.
 *  - A typed module gives editor autocomplete + compile-time validation
 *    that callers reference real keys; a JSON blob does not.
 *
 * Naming convention for env vars: SCREAMING_SNAKE_CASE, scoped by feature
 * (`HTTP_*`, `WEBHOOK_*`, `SESSION_*`).
 *
 * This module is import-time pure: env vars are read once when first imported,
 * which makes behavior predictable and avoids surprise re-reads mid-request.
 * Tests that need to override values should call the corresponding setters
 * (none today — add per-feature helpers as needs arise).
 */

/** Parse an integer env var, falling back when missing / unparseable. */
function readPositiveInt(envValue: string | undefined, fallback: number): number {
  if (envValue === undefined || envValue === null) return fallback;
  const trimmed = String(envValue).trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/** Parse a string env var, returning fallback for empty / unset. */
function readString(envValue: string | undefined, fallback: string): string {
  if (envValue === undefined || envValue === null) return fallback;
  const trimmed = String(envValue).trim();
  return trimmed || fallback;
}

/**
 * HTTP-client knobs used by the Slack/DevRev API wrappers. Defaults match
 * the values previously hard-coded in `slack-client.ts` and `devrev-auth.ts`.
 */
export const HTTP_CONFIG = {
  /** Base URL for the Slack Web API. */
  slackApiBase: readString(process.env['SLACK_API_BASE'], 'https://slack.com/api'),
} as const;

/**
 * Webhook lifecycle settings used by `devrev-auth.createWebhook`. Polling
 * starts at `pollIntervalMs` and gives up after `maxWaitMs`.
 */
export const WEBHOOK_CONFIG = {
  /** Maximum time we'll wait for a freshly-created webhook to go active. */
  maxWaitMs: readPositiveInt(process.env['WEBHOOK_MAX_WAIT_MS'], 10_000),
  /** Interval between webhook-status polls during the wait. */
  pollIntervalMs: readPositiveInt(process.env['WEBHOOK_POLL_INTERVAL_MS'], 500),
} as const;

/**
 * act-as token caching. Tokens are minted once per (userId, endpoint) pair
 * and reused until the cache TTL expires (with a safety margin so we never
 * hand out a token that's about to die).
 */
export const ACT_AS_TOKEN_CONFIG = {
  /** Token freshness margin: refresh this far in advance of expiry. */
  refreshMarginMs: readPositiveInt(process.env['ACT_AS_TOKEN_REFRESH_MARGIN_MS'], 60_000),
  /** Default TTL for cached act-as tokens. Operators can override per env. */
  ttlMinutes: readPositiveInt(process.env['ACT_AS_TOKEN_TTL_MINUTES'], 30),
} as const;

/**
 * Slack signature-verification rules. The 5-minute timestamp window is the
 * value Slack itself recommends for replay protection.
 */
export const SLACK_SIGNATURE_CONFIG = {
  /** Acceptable clock-skew window for the X-Slack-Request-Timestamp header. */
  timestampSkewSeconds: readPositiveInt(process.env['SLACK_TIMESTAMP_SKEW_SECONDS'], 5 * 60),
} as const;

/**
 * Session-lifecycle defaults. These mirror the existing `session-config.ts`
 * defaults; the snap-in's global_values still take precedence at runtime.
 */
export const SESSION_CONFIG = {
  /** Hard absolute lifetime ceiling, regardless of activity. */
  absoluteTtlHours: readPositiveInt(process.env['SESSION_ABSOLUTE_TIMEOUT_HOURS'], 24),
  /** Idle TTL before a session is GC'd. Falls back to global_values first. */
  idleTtlMinutes: readPositiveInt(process.env['SESSION_IDLE_TIMEOUT_MINUTES'], 8 * 60),
} as const;

/**
 * Block-Kit rendering caps. DevRev/Slack rejects oversize payloads; the
 * format-text utility uses these to chunk long AI responses safely.
 */
export const RENDER_CONFIG = {
  /** Block-Kit hard cap for a section header's `text`. */
  headerTextLimit: readPositiveInt(process.env['BLOCK_KIT_HEADER_TEXT_LIMIT'], 150),
  /** Slack rejects messages with more than 50 blocks; pad slightly. */
  maxBlocks: readPositiveInt(process.env['BLOCK_KIT_MAX_BLOCKS'], 50),
  /** Block-Kit hard cap for a section's `text.text`. */
  sectionTextLimit: readPositiveInt(process.env['BLOCK_KIT_SECTION_TEXT_LIMIT'], 3_000),
  /** Cap on a single AI "thought" line so verbose plans don't break Slack. */
  thoughtMaxLength: readPositiveInt(process.env['AI_THOUGHT_MAX_LENGTH'], 250),
} as const;

/**
 * Convenience aggregate so callers can `import { CONFIG } from '...'` and
 * pick the section they care about. Prefer named imports of the specific
 * group (e.g. `WEBHOOK_CONFIG`) for readability.
 */
export const CONFIG = {
  ACT_AS_TOKEN: ACT_AS_TOKEN_CONFIG,
  HTTP: HTTP_CONFIG,
  RENDER: RENDER_CONFIG,
  SESSION: SESSION_CONFIG,
  SLACK_SIGNATURE: SLACK_SIGNATURE_CONFIG,
  WEBHOOK: WEBHOOK_CONFIG,
} as const;
