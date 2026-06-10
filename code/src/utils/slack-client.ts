/**
 * Slack Web API Client
 *
 * Handles sending messages, updating messages, and fetching user information from Slack.
 */

import axios from 'axios';

import { LOG_TAG, SLACK_API_BASE } from '../config';
import { createLogger } from './logger';

// Module-level logger for all Slack Web API calls.
const log = createLogger(undefined, LOG_TAG.SLACK);

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
export async function sendMessage(channel: string, text: string, botToken: string, threadTs?: string): Promise<string> {
  const payload: any = {
    channel,
    text,
  };

  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  try {
    const response = await axios.post<SlackMessageResponse>(`${SLACK_API_BASE}/chat.postMessage`, payload, {
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.data.ok) {
      throw new Error(`Slack API error: ${response.data.error}`);
    }

    return response.data.ts ?? '';
  } catch (error: any) {
    log.error('sendMessage failed', { err_data: error.response?.data, err_message: error.message });
    throw new Error(`Failed to send message to Slack: ${error.message}`);
  }
}

/**
 * Send an ephemeral message — visible ONLY to the target user, never
 * to others in the channel/thread. Backed by `chat.postEphemeral`.
 *
 * Used for the feedback confirmation so the submitter's rating and
 * comment aren't broadcast to everyone in the conversation.
 */
export async function postEphemeral(
  channel: string,
  user: string,
  text: string,
  blocks: any[] | undefined,
  botToken: string,
  threadTs?: string
): Promise<void> {
  const payload: any = { channel, text, user };
  if (blocks && blocks.length > 0) payload.blocks = blocks;
  if (threadTs) payload.thread_ts = threadTs;

  try {
    const response = await axios.post<SlackMessageResponse>(`${SLACK_API_BASE}/chat.postEphemeral`, payload, {
      headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
    });
    if (!response.data.ok) {
      throw new Error(`Slack API error: ${response.data.error}`);
    }
  } catch (error: any) {
    log.error('postEphemeral failed', { err_data: error.response?.data, err_message: error.message });
    throw new Error(`Failed to send ephemeral message: ${error.message}`);
  }
}

/**
 * Open a Slack modal via views.open. `triggerId` comes from a slash
 * command or block_actions payload and is single-use with a ~3-second
 * freshness window. Returns the view id so the caller can later
 * `updateView` to swap the modal contents.
 */
export async function openView(triggerId: string, view: any, botToken: string): Promise<string> {
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
    log.error('openView failed', { err_data: error.response?.data, err_message: error.message });
    throw new Error(`Failed to open Slack view: ${error.message}`);
  }
}

/**
 * Replace an open modal's contents via views.update. Used to swap the
 * loading modal for the real form (or for an error modal) after async
 * work completes.
 */
export async function updateView(viewId: string, view: any, botToken: string): Promise<void> {
  try {
    const response = await axios.post<{ ok: boolean; error?: string }>(
      `${SLACK_API_BASE}/views.update`,
      { view, view_id: viewId },
      { headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' } }
    );
    if (!response.data.ok) {
      throw new Error(`Slack API error: ${response.data.error}`);
    }
  } catch (error: any) {
    log.error('updateView failed', { err_data: error.response?.data, err_message: error.message });
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
export async function updateMessage(channel: string, ts: string, text: string, botToken: string): Promise<void> {
  try {
    const response = await axios.post<SlackMessageResponse>(
      `${SLACK_API_BASE}/chat.update`,
      {
        channel,
        text,
        ts,
      },
      {
        headers: {
          Authorization: `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.data.ok) {
      throw new Error(`Slack API error: ${response.data.error}`);
    }
  } catch (error: any) {
    log.error('updateMessage failed', { err_data: error.response?.data, err_message: error.message });
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
export async function deleteMessage(channel: string, ts: string, botToken: string): Promise<void> {
  try {
    const response = await axios.post<SlackMessageResponse>(
      `${SLACK_API_BASE}/chat.delete`,
      {
        channel,
        ts,
      },
      {
        headers: {
          Authorization: `Bearer ${botToken}`,
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
    log.error('deleteMessage failed', { err_data: error.response?.data, err_message: error.message });
    // Don't throw for delete failures - it's not critical
  }
}

/**
 * Get the Slack user's profile (email + display name) in a single users.info call.
 * Returns nulls for fields that aren't available rather than throwing.
 */
export async function getUserProfile(userId: string, botToken: string): Promise<SlackUserProfile> {
  try {
    const response = await axios.get<SlackUserResponse>(`${SLACK_API_BASE}/users.info`, {
      headers: { Authorization: `Bearer ${botToken}` },
      params: { user: userId },
    });

    if (!response.data.ok) {
      log.error('users.info API error', { error: response.data.error });
      return { email: null, name: null };
    }

    const user = response.data.user;
    const name = user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name || null;
    return {
      email: user?.profile?.email || null,
      name: name && name.trim() ? name.trim() : null,
    };
  } catch (error: any) {
    log.error('getUserProfile failed', { err_data: error.response?.data, err_message: error.message });
    return { email: null, name: null };
  }
}

/**
 * Resolve a Slack channel/conversation's human-readable name via conversations.info.
 * Returns null for DMs (no `name`) or on error.
 */
export async function getChannelName(channelId: string, botToken: string): Promise<string | null> {
  if (!channelId) return null;
  try {
    const response = await axios.get<SlackConversationResponse>(`${SLACK_API_BASE}/conversations.info`, {
      headers: { Authorization: `Bearer ${botToken}` },
      params: { channel: channelId },
    });

    if (!response.data.ok) {
      log.warn('conversations.info API error', { channel_id: channelId, error: response.data.error });
      return null;
    }

    return response.data.channel?.name || null;
  } catch (error: any) {
    log.warn('getChannelName failed', { err_data: error.response?.data, err_message: error.message });
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
