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

export interface PostTimelineCommentArgs {
  devrevEndpoint: string;
  token: string;
  conversationId: string;
  body: string;
  externalRef?: string;
}

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
    console.warn('[timeline] timeline_comment create failed', {
      conversation_id: conversationId,
      err_data: error?.response?.data,
      err_status: error?.response?.status,
    });
    return null;
  }
}
