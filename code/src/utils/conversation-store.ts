/**
 * Conversation Store
 * 
 * Stores conversation references for sending responses back to Slack.
 * This is an in-memory store - in production, consider using DevRev custom objects
 * or an external database for persistence across function invocations.
 */

/**
 * Conversation Reference interface for Slack.
 * 
 * Purpose: Defines the structure for storing Slack conversation metadata required for messaging.
 */
export interface ConversationReference {
  channel: string;        // Slack channel ID
  userId: string;         // Slack user ID
  threadTs?: string;      // Thread timestamp (for threaded conversations)
  messageTs: string;      // Original message timestamp
  teamId?: string;        // Slack workspace ID
  timestamp: number;      // When this reference was created
  tempMessageTs?: string; // Temporary "Searching..." message timestamp (for progress updates)
}

const conversationStore = new Map<string, ConversationReference>();

/**
 * Store a conversation reference for later messaging.
 * 
 * Purpose: Persists a Slack conversation reference in an in-memory store and performs periodic cleanup of expired entries.
 * Input Definitions:
 *  - sessionId: The unique identifier for the session.
 *  - reference: The conversation reference object to store.
 * Output Definitions:
 *  - void
 */
export function storeConversationReference(
  sessionId: string,
  reference: ConversationReference
): void {
  conversationStore.set(sessionId, reference);
  
  // Clean up old entries (older than 1 hour) to prevent memory leaks
  // Note: This only affects the local routing cache, not DevRev's conversation continuity
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [key, value] of conversationStore.entries()) {
    if (value.timestamp < oneHourAgo) {
      conversationStore.delete(key);
    }
  }
}

/**
 * Retrieve a conversation reference by session ID.
 * 
 * Purpose: Fetches a previously stored conversation reference from the in-memory store.
 * Input Definitions:
 *  - sessionId: The session identifier used as a key.
 * Output Definitions:
 *  - ConversationReference | undefined: The stored reference if found, otherwise undefined.
 */
export function getConversationReference(
  sessionId: string
): ConversationReference | undefined {
  return conversationStore.get(sessionId);
}

/**
 * Remove a conversation reference.
 * 
 * Purpose: Deletes a conversation reference from the in-memory store.
 * Input Definitions:
 *  - sessionId: The session identifier to remove.
 * Output Definitions:
 *  - void
 */
export function removeConversationReference(sessionId: string): void {
  conversationStore.delete(sessionId);
}

/**
 * Extract conversation reference from a Slack event payload.
 * 
 * Purpose: Parses a Slack event object into a structured ConversationReference.
 * Input Definitions:
 *  - event: The Slack event object (from event_callback payload).
 * Output Definitions:
 *  - ConversationReference: A structured reference object for messaging.
 */
export function extractConversationReference(event: any): ConversationReference {
  return {
    channel: event.channel || '',
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
 * Purpose: Creates a unique, deterministic session identifier based on the thread or message.
 * This allows DevRev to maintain conversation continuity across any time period.
 * 
 * Input Definitions:
 *  - event: The Slack event object.
 * Output Definitions:
 *  - string: A formatted session ID string.
 */
export function generateSessionId(event: any): string {
  // For threaded conversations, use thread_ts so all messages in the thread share the same session
  // For non-threaded messages, use the message ts (which becomes the thread_ts for any replies)
  const threadIdentifier = event.thread_ts || event.ts || '';
  const channel = event.channel || '';
  
  // Deterministic session ID - same thread always gets same session
  // This allows DevRev to maintain conversation context indefinitely
  return `slack-${channel}-${threadIdentifier}`.substring(0, 64);
}
