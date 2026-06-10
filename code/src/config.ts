/**
 * Centralised configuration constants for the Slack Surface snap-in.
 *
 * All values that can plausibly differ between environments (dev / staging /
 * production) or between snap-in installs live here. Values that are truly
 * fixed protocol constants (e.g. Slack API base URL) are kept near their
 * usage sites to avoid the config file becoming a dumping ground.
 *
 * Env-var overrides (loaded from .env via dotenv in local development):
 *   LOG_LEVEL                Override the minimum log level at runtime.
 *   SLACK_API_BASE           Override the Slack REST API base URL.
 *   DEVREV_API_BASE          Override the DevRev REST API base URL.
 *   ACT_AS_TOKEN_TTL_MINUTES Override the act-as token cache TTL.
 *
 * None of these env vars carry secrets — secrets are always read from
 * event.context.secrets or event.input_data.keyrings at invocation time.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Slack
// ──────────────────────────────────────────────────────────────────────────────

/** Base URL for the Slack Web API. Overridable via SLACK_API_BASE env var. */
export const SLACK_API_BASE: string =
  process.env['SLACK_API_BASE'] ?? 'https://slack.com/api';

/**
 * Maximum age (in seconds) of an inbound Slack request timestamp before
 * it is rejected as a potential replay attack.
 * Slack's own recommendation is 5 minutes (300 seconds).
 */
export const SLACK_SIGNATURE_MAX_AGE_SECONDS: number = 5 * 60;

/**
 * Phrases that a user can send to explicitly start a new AI session.
 * Comparison is lower-cased and trimmed before checking.
 */
export const SESSION_RESET_PHRASES: ReadonlySet<string> = new Set(['new session', '/clear']);

// ──────────────────────────────────────────────────────────────────────────────
// DevRev
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Default DevRev API base URL used when no endpoint is available from the
 * snap-in execution metadata (e.g. unit tests running outside the runtime).
 */
export const DEVREV_API_BASE: string =
  process.env['DEVREV_API_BASE'] ?? 'https://api.devrev.ai';

/**
 * TTL in minutes for cached act-as (user impersonation) tokens.
 * DevRev tokens are valid for `expires_in` seconds (360 s = 6 min) — we
 * refresh one minute before that window closes to avoid races.
 */
export const ACT_AS_TOKEN_TTL_MINUTES: number = parseInt(
  process.env['ACT_AS_TOKEN_TTL_MINUTES'] ?? '5',
  10
);

/**
 * DevRev auth-tokens.create `expires_in` value (seconds).
 * Intentionally short (6 minutes) — act-as tokens are scoped to a single
 * user and cached separately.
 */
export const ACT_AS_TOKEN_EXPIRES_IN_SECONDS: number = 360;

/**
 * Conversation type value sent to /conversations.create.
 * "support" is the only type the DevRev platform accepts today.
 */
export const DEVREV_CONVERSATION_TYPE: string = 'support';

/**
 * Source channel marker written on each conversation so DevRev's UI
 * renders "Source: Slack" with the Slack icon instead of the default "Chat".
 */
export const DEVREV_SOURCE_CHANNEL_SLACK: string = 'slack';

/**
 * tenant-fragment schema spec passed with every conversations.create /
 * conversations.update call. Enables custom_fields for session state.
 */
export const TENANT_FRAGMENT_SCHEMA_SPEC = {
  tenant_fragment: true,
  validate_required_fields: true,
} as const;

// ──────────────────────────────────────────────────────────────────────────────
// Session defaults (overridden by snap-in global_values at runtime)
// ──────────────────────────────────────────────────────────────────────────────

/** Default idle TTL in minutes — overridden by `session_idle_timeout_minutes`. */
export const DEFAULT_SESSION_IDLE_TTL_MINUTES: number = 8 * 60; // 8 hours

/** Default absolute TTL in hours — overridden by `session_absolute_timeout_hours`. */
export const DEFAULT_SESSION_ABSOLUTE_TTL_HOURS: number = 24; // 24 hours

/** Maximum character length for DevRev text custom fields. */
export const DEVREV_TEXT_FIELD_MAX_LENGTH: number = 255;

// ──────────────────────────────────────────────────────────────────────────────
// Webhook / polling
// ──────────────────────────────────────────────────────────────────────────────

/** Maximum time (ms) to wait for a newly created webhook to become active. */
export const WEBHOOK_ACTIVE_WAIT_MAX_MS: number = 10_000;

/** Polling interval (ms) when waiting for webhook activation. */
export const WEBHOOK_ACTIVE_POLL_INTERVAL_MS: number = 500;

// ──────────────────────────────────────────────────────────────────────────────
// Progress message labels (sent back to Slack while AI works)
// ──────────────────────────────────────────────────────────────────────────────

/** Initial placeholder message posted immediately after a user message arrives. */
export const PROGRESS_SEARCHING_MESSAGE: string = '⏳ Searching...';

/** Session-reset confirmation sent back to the user after "/clear". */
export const SESSION_RESET_CONFIRMATION_MESSAGE: string =
  'Started a new session. Send your next message to begin a fresh conversation.';

// ──────────────────────────────────────────────────────────────────────────────
// Logging
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Log-level tags used throughout the codebase.
 * Keeping them in one place prevents typo-drift and makes grep easy.
 */
export const LOG_TAG = {
  AI: 'AI',
  AI_RESP: 'AI_RESP',
  AUTH: 'AUTH',
  CHAN: 'CHAN',
  CONFIG: 'CONFIG',
  CONV: 'CONV',
  FEEDBACK: 'FEEDBACK',
  GC: 'gc',
  INTERACTIVITY: 'interactivity',
  MSG: 'MSG',
  SESSION: 'session',
  SLASH: 'slash',
  SLACK: 'SLACK',
  STORE: 'STORE',
  TIMELINE: 'TIMELINE',
} as const;
