/**
 * Thin wrapper around `/timeline-entries.create`.
 *
 * Used to mirror the Slack chat into the DevRev conversation:
 *  - The user's incoming message is posted as the user (act-as token).
 *  - The AI Agent's response is posted as the snap-in service account.
 *
 * Failures are logged and swallowed — Slack ↔ DevRev sync is best-effort,
 * and a timeline failure must never block the actual reply to Slack.
 */

import axios from 'axios';

import { logger } from './logger';

/**
 * Arguments for `postTimelineComment`. Bundled as an object to keep the
 * call-site readable (positional booleans / strings get hard to scan).
 */
export interface PostTimelineCommentArgs {
  /** Regional DevRev API endpoint, no trailing slash. */
  devrevEndpoint: string;
  /** Auth token. Use the user's act-as token to author as the user; the
   *  service-account token to author as the bot. */
  token: string;
  /** DevRev conversation DON the comment attaches to. */
  conversationId: string;
  /** Plaintext body. Multiline OK; DevRev preserves line breaks. */
  body: string;
  /** Optional dedup key — DevRev will reject a duplicate (object, ref) pair. */
  externalRef?: string;
}

/**
 * Post a `timeline_comment` entry on the given conversation.
 *
 * Best-effort by design: any failure is logged at warn and `null` is returned
 * so the caller (Slack reply) can continue uninterrupted.
 *
 * @returns The new timeline-entry id on success; `null` on any error or
 *          when required arguments are missing.
 */
export async function postTimelineComment(args: PostTimelineCommentArgs): Promise<string | null> {
  const { devrevEndpoint, token, conversationId, body, externalRef } = args;
  if (!devrevEndpoint || !token || !conversationId || !body) return null;

  const payload: Record<string, any> = {
    body,
    body_type: 'text',
    object: conversationId,
    type: 'timeline_comment',
  };
  if (externalRef) payload['external_ref'] = externalRef;

  try {
    const response = await axios.post(`${devrevEndpoint}/timeline-entries.create`, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data?.timeline_entry?.id || null;
  } catch (error: any) {
    logger.warn('[timeline] timeline_comment create failed', {
      conversation_id: conversationId,
      err_data: error?.response?.data,
      err_status: error?.response?.status,
    });
    return null;
  }
}
