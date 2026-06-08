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
  channel: string; // Slack channel ID (e.g. "C0123456789")
  channelName?: string; // Human-readable channel/DM label
  conversationType?: string; // "channel", "im", "mpim" (Slack channel type)
  userId: string; // Slack user ID (e.g. "U0123456789")
  userName?: string; // Slack display name / real name
  userEmail?: string; // Resolved email address (when available)
  threadTs?: string; // Thread timestamp (for threaded conversations)
  messageTs: string; // Original message timestamp
  teamId?: string; // Slack workspace ID
  botUserId?: string; // The bot user ID that received the mention
  devrevUserId?: string; // Resolved DevRev user DON (when available)
  timestamp: number; // When this reference was created (epoch ms)
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
    messageTs: event.ts || '',
    teamId: event.team,
    threadTs: event.thread_ts,
    timestamp: Date.now(),
    userId: event.user || '',
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

/**
 * Routing key parts for a Slack event. Used by session-store to derive a
 * stable conversation_key (sha256 hash of channel::threadTs::userId) so that
 * a (channel, thread, user) tuple maps to at most one active session.
 *
 * Channel-type-aware so each surface gets the right session granularity:
 *
 *   im (1:1 DM):
 *     One persistent session per (channel, user). Slack DMs have no "new chat"
 *     affordance — the same DM channel lives forever — so every top-level DM
 *     message and every in-thread reply collapses onto the same session.
 *     The user can still rotate explicitly via `/clear` or "new session".
 *
 *   channel / mpim (group DM):
 *     Per-thread sessions. A new top-level post starts a new session
 *     (threadTs = event.ts, which becomes the thread root for any replies).
 *     A reply inside an existing thread reuses that thread's session
 *     (threadTs = event.thread_ts).
 */
export function extractRoutingKeyParts(event: any): {
  channel: string;
  threadTs: string;
  userId: string;
} {
  const channel = event.channel || '';
  const userId = event.user || '';
  const channelType = (event.channel_type || '').toLowerCase();

  if (channelType === 'im') {
    return { channel, threadTs: 'dm', userId };
  }

  return { channel, threadTs: event.thread_ts || event.ts || '', userId };
}
