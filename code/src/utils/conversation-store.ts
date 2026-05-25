/**
 * Conversation Reference helpers.
 *
 * Persistent state lives in DevRev custom objects via session-store.ts;
 * this module keeps only the lightweight ConversationReference type and
 * pure helpers used to build it from a raw Slack event.
 */

/**
 * Conversation Reference for Slack — the routing + identity metadata
 * required to deliver an AI Agent response back to the originating
 * channel/thread, plus the user/email/devrev linkage stored alongside
 * the session in DevRev.
 */
export interface ConversationReference {
  channel: string;        // Slack channel ID (e.g. "C0123456789")
  channelName?: string;   // Human-readable channel/DM label
  conversationType?: string; // "channel", "im", "mpim" (Slack channel type)
  userId: string;         // Slack user ID (e.g. "U0123456789")
  userName?: string;      // Slack display name / real name
  userEmail?: string;     // Resolved email address (when available)
  threadTs?: string;      // Thread timestamp (for threaded conversations)
  messageTs: string;      // Original message timestamp
  teamId?: string;        // Slack workspace ID
  botUserId?: string;     // The bot user ID that received the mention
  devrevUserId?: string;  // Resolved DevRev user DON (when available)
  timestamp: number;      // When this reference was created (epoch ms)
  tempMessageTs?: string; // Temporary "Searching..." message timestamp (for progress updates)
}

/**
 * Extract conversation reference from a Slack event payload.
 */
export function extractConversationReference(event: any): ConversationReference {
  return {
    channel: event.channel || '',
    channelName: event.channel_name || undefined,
    conversationType: event.channel_type || undefined,
    userId: event.user || '',
    threadTs: event.thread_ts,
    messageTs: event.ts || '',
    teamId: event.team,
    timestamp: Date.now(),
  };
}

/**
 * Generate a deterministic session ID from a Slack event.
 *
 * For threaded conversations, uses thread_ts so all messages in the thread
 * share the same session. For non-threaded messages, uses the message ts
 * (which becomes the thread_ts for any replies).
 */
export function generateSessionId(event: any): string {
  const threadIdentifier = event.thread_ts || event.ts || '';
  const channel = event.channel || '';
  return `slack-${channel}-${threadIdentifier}`.substring(0, 64);
}
