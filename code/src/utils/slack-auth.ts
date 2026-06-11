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
 * Strict-enough email validation for the operator-supplied mock-email input.
 *
 * NOT meant for full RFC-5322 parsing — this only weeds out bare strings
 * like `"notanemail"` that operators sometimes paste into the mock-email
 * input by mistake. Real address-of-record validation happens server-side
 * in DevRev.
 *
 * Implemented as linear-time index/character checks rather than the
 * historical `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` regex: that regex's two
 * overlapping `[^\s@]+` quantifiers (with the literal `.` itself in the
 * `[^\s@]` class) are polynomial-time on adversarial inputs of the form
 * `!@!.!.!....` (CodeQL js/polynomial-redos). The replacement preserves
 * the original accept/reject set.
 */
export function isValidEmail(email: string): boolean {
  if (typeof email !== 'string' || email.length === 0) return false;
  // Whitespace anywhere is rejected — matches the historical `[^\s@]` class.
  // A single character-class test is O(n) with no backtracking.
  if (/\s/.test(email)) return false;
  const atIdx = email.indexOf('@');
  // Exactly one '@', not at the start, not at the end.
  if (atIdx <= 0) return false;
  if (atIdx !== email.lastIndexOf('@')) return false;
  if (atIdx === email.length - 1) return false;
  // Domain must contain at least one '.', not immediately after '@' and not
  // at the very end (so both labels around the dot are non-empty).
  const domainStart = atIdx + 1;
  const firstDotIdx = email.indexOf('.', domainStart);
  if (firstDotIdx <= domainStart) return false;
  if (firstDotIdx === email.length - 1) return false;
  return true;
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
