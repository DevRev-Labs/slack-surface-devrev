/**
 * Function registry — single source of truth for every entrypoint the
 * DevRev platform may invoke.
 *
 * Why a `const` map (not a class / dynamic require)?
 *  - The keys here are exposed to the platform via manifest.yaml. Keeping
 *    them in a typed `as const` map gives compile-time validation that the
 *    handler exists, plus `keyof typeof` for the discriminated dispatcher.
 *  - The runtime dispatcher in `test/runner.ts` and the security validator
 *    in the snap-in router both check incoming function names against
 *    `Object.keys(functionFactory)` — so adding a handler here is the
 *    single, audited extension point.
 */

import ai_response_handler from './functions/ai_response_handler';
import ensure_session_state_schema from './functions/ensure_session_state_schema';
import session_gc from './functions/session_gc';
import slack_handler from './functions/slack_handler';
import slack_interactivity from './functions/slack_interactivity';

/** Map of function-name → handler. Order is irrelevant; keys are public API. */
export const functionFactory = {
  /** Handles async AI Agent responses bound for Slack. */
  ai_response_handler,
  /** Activate-hook: ensures the session custom-fields schema exists. */
  ensure_session_state_schema,
  /** Cron-driven sweep: idle-expire and hard-delete stale sessions. */
  session_gc,
  /** Handles Slack events (mentions, DMs) — entry point for every chat. */
  slack_handler,
  /** Handles Slack interactivity + slash command (`/sda-agent-feedback`). */
  slack_interactivity,
} as const;

/** Union of valid function names — keep dispatchers' incoming strings narrow. */
export type FunctionFactoryType = keyof typeof functionFactory;
