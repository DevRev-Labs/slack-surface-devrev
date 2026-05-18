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
    };
  };
  error?: string;
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
  try {
    const response = await axios.get<SlackUserResponse>(
      `${SLACK_API_BASE}/users.info`,
      {
        params: { user: userId },
        headers: {
          'Authorization': `Bearer ${botToken}`,
        },
      }
    );

    if (!response.data.ok) {
      console.error(`Slack users.info error: ${response.data.error}`);
      return null;
    }

    return response.data.user?.profile?.email || null;
  } catch (error: any) {
    console.error('Slack getUserEmail error:', error.response?.data || error.message);
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
