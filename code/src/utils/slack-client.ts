/**
 * Slack Web API Client
 * 
 * Handles sending messages, updating messages, and fetching user information from Slack.
 */

import axios from 'axios';

const SLACK_API_BASE = 'https://slack.com/api';

/**
 * Response from Slack API chat methods.
 */
interface SlackMessageResponse {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
}

/**
 * Response from Slack API users.info method.
 */
interface SlackUserResponse {
  ok: boolean;
  user?: {
    id: string;
    name: string;
    real_name?: string;
    profile?: {
      email?: string;
      display_name?: string;
      real_name?: string;
    };
  };
  error?: string;
}

/**
 * Response from Slack API conversations.info method.
 */
interface SlackConversationResponse {
  ok: boolean;
  channel?: {
    id: string;
    name?: string;
    is_im?: boolean;
    is_mpim?: boolean;
    is_channel?: boolean;
    is_group?: boolean;
  };
  error?: string;
}

export interface SlackUserProfile {
  email: string | null;
  name: string | null;
}

/**
 * Send a message to a Slack channel.
 *
 * @param channel The channel ID to send to.
 * @param text The message text.
 * @param botToken The Slack bot token.
 * @param threadTs Optional thread timestamp to reply in a thread.
 * @returns The message timestamp (ts) which serves as the message ID.
 */
export async function sendMessage(
  channel: string,
  text: string,
  botToken: string,
  threadTs?: string
): Promise<string> {
  const payload: any = {
    channel,
    text,
  };

  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  try {
    const response = await axios.post<SlackMessageResponse>(
      `${SLACK_API_BASE}/chat.postMessage`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.data.ok) {
      throw new Error(`Slack API error: ${response.data.error}`);
    }

    return response.data.ts!;
  } catch (error: any) {
    console.error('Slack sendMessage error:', error.response?.data || error.message);
    throw new Error(`Failed to send message to Slack: ${error.message}`);
  }
}

/**
 * Send a Block-Kit message. `text` is used as the fallback (notification)
 * text shown in alerts and accessibility readers — Slack rejects messages
 * with blocks but no fallback.
 */
export async function sendBlocksMessage(
  channel: string,
  text: string,
  blocks: any[],
  botToken: string,
  threadTs?: string
): Promise<string> {
  const payload: any = { channel, text, blocks };
  if (threadTs) payload.thread_ts = threadTs;

  try {
    const response = await axios.post<SlackMessageResponse>(
      `${SLACK_API_BASE}/chat.postMessage`,
      payload,
      { headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' } }
    );
    if (!response.data.ok) {
      throw new Error(`Slack API error: ${response.data.error}`);
    }
    return response.data.ts!;
  } catch (error: any) {
    console.error('Slack sendBlocksMessage error:', error.response?.data || error.message);
    throw new Error(`Failed to send blocks message to Slack: ${error.message}`);
  }
}

/**
 * Replace an existing message's blocks (and fallback text). Used to
 * collapse the feedback prompt into a confirmation/cancellation note
 * after the user submits or cancels the modal.
 */
export async function updateMessageBlocks(
  channel: string,
  ts: string,
  text: string,
  blocks: any[],
  botToken: string
): Promise<void> {
  try {
    const response = await axios.post<SlackMessageResponse>(
      `${SLACK_API_BASE}/chat.update`,
      { channel, ts, text, blocks },
      { headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' } }
    );
    if (!response.data.ok) {
      throw new Error(`Slack API error: ${response.data.error}`);
    }
  } catch (error: any) {
    console.error('Slack updateMessageBlocks error:', error.response?.data || error.message);
    throw new Error(`Failed to update blocks message: ${error.message}`);
  }
}

/**
 * Open a Slack modal via views.open. `triggerId` comes from a slash
 * command or block_actions payload and is single-use with a ~3-second
 * freshness window. Returns the view id so the caller can later
 * `updateView` to swap the modal contents.
 */
export async function openView(
  triggerId: string,
  view: any,
  botToken: string
): Promise<string> {
  try {
    const response = await axios.post<{
      ok: boolean;
      error?: string;
      view?: { id?: string };
    }>(
      `${SLACK_API_BASE}/views.open`,
      { trigger_id: triggerId, view },
      { headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' } }
    );
    if (!response.data.ok) {
      throw new Error(`Slack API error: ${response.data.error}`);
    }
    return response.data.view?.id || '';
  } catch (error: any) {
    console.error('Slack openView error:', error.response?.data || error.message);
    throw new Error(`Failed to open Slack view: ${error.message}`);
  }
}

/**
 * Replace an open modal's contents via views.update. Used to swap the
 * loading modal for the real form (or for an error modal) after async
 * work completes.
 */
export async function updateView(
  viewId: string,
  view: any,
  botToken: string
): Promise<void> {
  try {
    const response = await axios.post<{ ok: boolean; error?: string }>(
      `${SLACK_API_BASE}/views.update`,
      { view_id: viewId, view },
      { headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' } }
    );
    if (!response.data.ok) {
      throw new Error(`Slack API error: ${response.data.error}`);
    }
  } catch (error: any) {
    console.error('Slack updateView error:', error.response?.data || error.message);
    throw new Error(`Failed to update Slack view: ${error.message}`);
  }
}

/**
 * Update an existing message in Slack.
 * 
 * @param channel The channel ID where the message is.
 * @param ts The timestamp of the message to update.
 * @param text The new message text.
 * @param botToken The Slack bot token.
 */
export async function updateMessage(
  channel: string,
  ts: string,
  text: string,
  botToken: string
): Promise<void> {
  try {
    const response = await axios.post<SlackMessageResponse>(
      `${SLACK_API_BASE}/chat.update`,
      {
        channel,
        ts,
        text,
      },
      {
        headers: {
          'Authorization': `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.data.ok) {
      throw new Error(`Slack API error: ${response.data.error}`);
    }
  } catch (error: any) {
    console.error('Slack updateMessage error:', error.response?.data || error.message);
    throw new Error(`Failed to update message in Slack: ${error.message}`);
  }
}

/**
 * Delete a message from Slack.
 * 
 * @param channel The channel ID where the message is.
 * @param ts The timestamp of the message to delete.
 * @param botToken The Slack bot token.
 */
export async function deleteMessage(
  channel: string,
  ts: string,
  botToken: string
): Promise<void> {
  try {
    const response = await axios.post<SlackMessageResponse>(
      `${SLACK_API_BASE}/chat.delete`,
      {
        channel,
        ts,
      },
      {
        headers: {
          'Authorization': `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.data.ok) {
      // Don't throw on message_not_found - it may have already been deleted
      if (response.data.error !== 'message_not_found') {
        throw new Error(`Slack API error: ${response.data.error}`);
      }
    }
  } catch (error: any) {
    console.error('Slack deleteMessage error:', error.response?.data || error.message);
    // Don't throw for delete failures - it's not critical
  }
}

/**
 * Get user information from Slack, including their email address.
 *
 * @param userId The Slack user ID.
 * @param botToken The Slack bot token.
 * @returns The user's email address, or null if not found.
 */
export async function getUserEmail(
  userId: string,
  botToken: string
): Promise<string | null> {
  return (await getUserProfile(userId, botToken)).email;
}

/**
 * Get the Slack user's profile (email + display name) in a single users.info call.
 * Returns nulls for fields that aren't available rather than throwing.
 */
export async function getUserProfile(
  userId: string,
  botToken: string
): Promise<SlackUserProfile> {
  try {
    const response = await axios.get<SlackUserResponse>(
      `${SLACK_API_BASE}/users.info`,
      {
        params: { user: userId },
        headers: { 'Authorization': `Bearer ${botToken}` },
      }
    );

    if (!response.data.ok) {
      console.error(`Slack users.info error: ${response.data.error}`);
      return { email: null, name: null };
    }

    const user = response.data.user;
    const name =
      user?.profile?.display_name ||
      user?.profile?.real_name ||
      user?.real_name ||
      user?.name ||
      null;
    return {
      email: user?.profile?.email || null,
      name: name && name.trim() ? name.trim() : null,
    };
  } catch (error: any) {
    console.error('Slack getUserProfile error:', error.response?.data || error.message);
    return { email: null, name: null };
  }
}

/**
 * Resolve a Slack channel/conversation's human-readable name via conversations.info.
 * Returns null for DMs (no `name`) or on error.
 */
export async function getChannelName(
  channelId: string,
  botToken: string
): Promise<string | null> {
  if (!channelId) return null;
  try {
    const response = await axios.get<SlackConversationResponse>(
      `${SLACK_API_BASE}/conversations.info`,
      {
        params: { channel: channelId },
        headers: { 'Authorization': `Bearer ${botToken}` },
      }
    );

    if (!response.data.ok) {
      console.warn(`Slack conversations.info error for ${channelId}: ${response.data.error}`);
      return null;
    }

    return response.data.channel?.name || null;
  } catch (error: any) {
    console.warn('Slack getChannelName error:', error.response?.data || error.message);
    return null;
  }
}

/**
 * Remove bot mention from message text.
 * Slack formats bot mentions as <@BOT_ID>.
 * 
 * @param text The message text with potential bot mention.
 * @returns The cleaned message text.
 */
export function removeBotMention(text: string): string {
  // Remove <@USER_ID> patterns (bot mentions)
  return text.replace(/<@[A-Z0-9]+>/gi, '').trim();
}
