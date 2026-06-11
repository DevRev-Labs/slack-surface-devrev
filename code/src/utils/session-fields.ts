/**
 * Typed field definitions for the Slack session schema.
 *
 * Sessions live as DevRev `conversation` objects with these fields attached
 * via a tenant-fragment schema. Used by:
 *  - ensure_session_state_schema (creates the fragment via /schemas.custom-set
 *    using the un-prefixed names below)
 *  - session-store (reads/writes via custom_fields, which must reference the
 *    DevRev-applied `tnt__` data-name prefix)
 */

// Tenant-fragment custom fields are stored under their `data_name`, which
// DevRev derives by prefixing the schema field name with `tnt__`. Reads and
// writes against /conversations.* must use this prefixed form.
const TNT = 'tnt__';

/**
 * Map of session field name → DevRev `tnt__`-prefixed `data_name`.
 *
 * Use this object instead of string-literal field names so a typo becomes a
 * compile error and a refactor renames every callsite at once.
 */
export const SESSION_FIELD = {
  // Bot / DevRev linkage
  botUserId: `${TNT}bot_user_id`,

  channel: `${TNT}channel`,

  channelName: `${TNT}channel_name`,

  conversationKey: `${TNT}conversation_key`,

  conversationType: `${TNT}conversation_type`,

  // Timestamps
  createdAtMs: `${TNT}created_at_ms`,

  devrevUserId: `${TNT}devrev_user_id`,

  endReason: `${TNT}end_reason`,

  expiresAtMs: `${TNT}expires_at_ms`,

  // Slack ts of the "Submit your feedback" prompt posted by session_gc
  // when the session idle-expires. Stored so the GC's later hard-expiry
  // sweep can delete that prompt before the conversation goes away.
  feedbackPromptTs: `${TNT}feedback_prompt_ts`,

  // User feedback (1-5 rating + free-text comment) collected via the
  // Slack feedback form. Written when the user submits; stays empty
  // otherwise. One value per session — submitting again overwrites.
  feedbackRating: `${TNT}feedback_rating`,

  feedbackSubmittedAtMs: `${TNT}feedback_submitted_at_ms`,

  feedbackText: `${TNT}feedback_text`,

  generation: `${TNT}generation`,

  hardExpiresAtMs: `${TNT}hard_expires_at_ms`,

  // The most recent user-turn (matches messageCount) for which we have
  // already posted a final AI response to Slack. Used by
  // ai_response_handler to drop duplicate `message` events and late
  // `progress` events emitted by the AI Agent for the same turn.
  lastDeliveredTurn: `${TNT}last_delivered_turn`,

  lastUsedAtMs: `${TNT}last_used_at_ms`,

  messageCount: `${TNT}message_count`,

  messageTs: `${TNT}message_ts`,

  previousSessionId: `${TNT}previous_session_id`,

  // Identity
  sessionId: `${TNT}session_id`,

  // Lifecycle
  status: `${TNT}status`,

  teamId: `${TNT}team_id`,

  // Routing helpers
  tempMessageTs: `${TNT}temp_message_ts`,

  threadTs: `${TNT}thread_ts`,

  userEmail: `${TNT}user_email`,

  // Slack user
  userId: `${TNT}user_id`,

  userName: `${TNT}user_name`,
} as const;

const stripTnt = (name: string): string => (name.startsWith(TNT) ? name.slice(TNT.length) : name);

interface FieldSpec {
  name: string;
  field_type: 'text' | 'int' | 'timestamp';
  is_required?: boolean;
  is_filterable?: boolean;
  is_immutable?: boolean;
}

/**
 * Wire-format spec for every session field. Consumed by
 * `ensure_session_state_schema` to create / update the tenant-fragment via
 * `/schemas.custom-set`. Names use the un-prefixed form (DevRev applies
 * the `tnt__` prefix during creation).
 */
export const SESSION_FIELD_SPECS: FieldSpec[] = [
  // Identity
  {
    field_type: 'text',
    is_filterable: true,
    is_immutable: true,
    is_required: true,
    name: stripTnt(SESSION_FIELD.sessionId),
  },
  { field_type: 'text', is_filterable: true, is_required: true, name: stripTnt(SESSION_FIELD.conversationKey) },
  { field_type: 'text', is_filterable: true, is_required: true, name: stripTnt(SESSION_FIELD.channel) },
  { field_type: 'text', name: stripTnt(SESSION_FIELD.channelName) },
  { field_type: 'text', name: stripTnt(SESSION_FIELD.conversationType) },
  { field_type: 'text', name: stripTnt(SESSION_FIELD.threadTs) },
  { field_type: 'text', name: stripTnt(SESSION_FIELD.messageTs) },
  { field_type: 'text', name: stripTnt(SESSION_FIELD.teamId) },
  // Slack user
  { field_type: 'text', is_required: true, name: stripTnt(SESSION_FIELD.userId) },
  { field_type: 'text', name: stripTnt(SESSION_FIELD.userName) },
  { field_type: 'text', name: stripTnt(SESSION_FIELD.userEmail) },
  // Bot / DevRev linkage
  { field_type: 'text', name: stripTnt(SESSION_FIELD.botUserId) },
  { field_type: 'text', name: stripTnt(SESSION_FIELD.devrevUserId) },
  // Routing helpers
  { field_type: 'text', name: stripTnt(SESSION_FIELD.tempMessageTs) },
  // Lifecycle
  { field_type: 'text', is_filterable: true, name: stripTnt(SESSION_FIELD.status) },
  { field_type: 'int', name: stripTnt(SESSION_FIELD.generation) },
  { field_type: 'text', name: stripTnt(SESSION_FIELD.previousSessionId) },
  { field_type: 'text', name: stripTnt(SESSION_FIELD.endReason) },
  { field_type: 'int', name: stripTnt(SESSION_FIELD.messageCount) },
  // Timestamps
  { field_type: 'timestamp', name: stripTnt(SESSION_FIELD.createdAtMs) },
  { field_type: 'timestamp', is_filterable: true, name: stripTnt(SESSION_FIELD.lastUsedAtMs) },
  { field_type: 'timestamp', is_filterable: true, name: stripTnt(SESSION_FIELD.expiresAtMs) },
  { field_type: 'timestamp', name: stripTnt(SESSION_FIELD.hardExpiresAtMs) },
  // Feedback
  { field_type: 'int', name: stripTnt(SESSION_FIELD.feedbackRating) },
  { field_type: 'text', name: stripTnt(SESSION_FIELD.feedbackText) },
  { field_type: 'timestamp', name: stripTnt(SESSION_FIELD.feedbackSubmittedAtMs) },
  { field_type: 'int', name: stripTnt(SESSION_FIELD.lastDeliveredTurn) },
  { field_type: 'text', name: stripTnt(SESSION_FIELD.feedbackPromptTs) },
];

/** Re-exported for callers that build their own custom schemas. */
export type SchemaFieldSpec = FieldSpec;

/** Compute the set of `tnt__`-prefixed names that must never be patched. */
const immutableTntNames = (specs: FieldSpec[]): Set<string> =>
  new Set(specs.filter((f) => f.is_immutable).map((f) => `${TNT}${f.name}`));

/**
 * Pre-computed set of immutable field data-names — passed to `omitImmutable`
 * before any `/conversations.update` call so the API doesn't 400 on us.
 */
export const SESSION_IMMUTABLE_FIELDS = immutableTntNames(SESSION_FIELD_SPECS);

/**
 * Strip immutable fields from a custom_fields blob before sending an update.
 *
 * @param fields    custom_fields payload to filter (returned shallow-copied).
 * @param immutable Set of `tnt__`-prefixed field names to drop. See
 *                  {@link SESSION_IMMUTABLE_FIELDS}.
 */
export function omitImmutable(fields: Record<string, any>, immutable: Set<string>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!immutable.has(key)) result[key] = value;
  }
  return result;
}
