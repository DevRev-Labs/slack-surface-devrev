/**
 * Auth helpers used by the Slack handler.
 *
 * Two pieces of logic that we want testable in isolation:
 *
 *   1. Email validation — used to gate the operator-supplied
 *      mock_email_address before it's allowed to override the real Slack
 *      lookup. A bad value must be rejected explicitly, not silently
 *      ignored, so the operator notices their typo.
 *
 *   2. Slack user profile resolution — fetch (email, displayName) from
 *      Slack with an optional mock-email override. Display name still
 *      comes from Slack even when the email is mocked, so log lines and
 *      session records remain accurate to the real submitter.
 *
 * These were inlined inside slack_handler/index.ts; pulling them here
 * removes ~30 lines from the 593-line handler and makes the logic
 * coverable by focused unit tests.
 */

import { getUserProfile } from './slack-client';

/**
 * Strict-enough email regex for input validation. Mirrors the one used
 * historically inside the handler so behaviour is unchanged.
 *
 * NOT meant for full RFC-5322 parsing — this only weeds out bare strings
 * like `"notanemail"` that operators sometimes paste into the mock-email
 * input by mistake. Real address-of-record validation happens server-side
 * in DevRev.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Result of resolving a Slack user identity. */
export interface SlackResolvedProfile {
  email: string | null;
  name: string | null;
}

/**
 * Resolve a Slack user's email + display name.
 *
 *  - If `mockEmail` is non-null, use it as the email — but ALWAYS pull the
 *    name from Slack so logs/session records reflect the real submitter.
 *  - If `mockEmail` is null, return Slack's profile verbatim.
 *
 * Never throws — `getUserProfile` already swallows API failures and
 * returns `{ email: null, name: null }` on error.
 *
 * @param slackUserId Slack user id (`U...`).
 * @param slackBotToken `xoxb-` token used to call `users.info`.
 * @param mockEmail Operator-supplied override; pass `null` for normal flow.
 */
export async function resolveUserProfile(
  slackUserId: string,
  slackBotToken: string,
  mockEmail: string | null
): Promise<SlackResolvedProfile> {
  const profile = await getUserProfile(slackUserId, slackBotToken);
  if (mockEmail) {
    return { email: mockEmail, name: profile.name };
  }
  return profile;
}
