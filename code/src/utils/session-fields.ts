/**
 * Typed field definitions for the slack_ai_session custom-object schema.
 *
 * Used by:
 *  - ensure_session_state_schema (creates the schema via /schemas.custom-set
 *    using the un-prefixed names below)
 *  - session-store (reads/writes via custom_fields, which must reference the
 *    DevRev-applied `tnt__` data-name prefix)
 */

// Tenant-fragment custom fields are stored under their `data_name`, which
// DevRev derives by prefixing the schema field name with `tnt__`. Reads and
// writes against /custom-objects.* must use this prefixed form.
const TNT = 'tnt__';

export const SESSION_FIELD = {
  // Identity
  sessionId: `${TNT}session_id`,
  channel: `${TNT}channel`,
  channelName: `${TNT}channel_name`,
  conversationType: `${TNT}conversation_type`,
  threadTs: `${TNT}thread_ts`,
  messageTs: `${TNT}message_ts`,
  teamId: `${TNT}team_id`,
  // Slack user
  userId: `${TNT}user_id`,
  userName: `${TNT}user_name`,
  userEmail: `${TNT}user_email`,
  // Bot / DevRev linkage
  botUserId: `${TNT}bot_user_id`,
  devrevUserId: `${TNT}devrev_user_id`,
  // Routing helpers
  tempMessageTs: `${TNT}temp_message_ts`,
  // Lifecycle
  status: `${TNT}status`,
  generation: `${TNT}generation`,
  previousSessionId: `${TNT}previous_session_id`,
  endReason: `${TNT}end_reason`,
  messageCount: `${TNT}message_count`,
  // Timestamps
  createdAtMs: `${TNT}created_at_ms`,
  lastUsedAtMs: `${TNT}last_used_at_ms`,
  expiresAtMs: `${TNT}expires_at_ms`,
  hardExpiresAtMs: `${TNT}hard_expires_at_ms`,
} as const;

const stripTnt = (name: string): string =>
  name.startsWith(TNT) ? name.slice(TNT.length) : name;

interface FieldSpec {
  name: string;
  field_type: 'text' | 'int' | 'timestamp';
  is_required?: boolean;
  is_filterable?: boolean;
  is_immutable?: boolean;
}

export const SESSION_FIELD_SPECS: FieldSpec[] = [
  // Identity
  { name: stripTnt(SESSION_FIELD.sessionId), field_type: 'text', is_required: true, is_immutable: true, is_filterable: true },
  { name: stripTnt(SESSION_FIELD.channel), field_type: 'text', is_required: true, is_filterable: true },
  { name: stripTnt(SESSION_FIELD.channelName), field_type: 'text' },
  { name: stripTnt(SESSION_FIELD.conversationType), field_type: 'text' },
  { name: stripTnt(SESSION_FIELD.threadTs), field_type: 'text' },
  { name: stripTnt(SESSION_FIELD.messageTs), field_type: 'text' },
  { name: stripTnt(SESSION_FIELD.teamId), field_type: 'text' },
  // Slack user
  { name: stripTnt(SESSION_FIELD.userId), field_type: 'text', is_required: true },
  { name: stripTnt(SESSION_FIELD.userName), field_type: 'text' },
  { name: stripTnt(SESSION_FIELD.userEmail), field_type: 'text' },
  // Bot / DevRev linkage
  { name: stripTnt(SESSION_FIELD.botUserId), field_type: 'text' },
  { name: stripTnt(SESSION_FIELD.devrevUserId), field_type: 'text' },
  // Routing helpers
  { name: stripTnt(SESSION_FIELD.tempMessageTs), field_type: 'text' },
  // Lifecycle
  { name: stripTnt(SESSION_FIELD.status), field_type: 'text', is_filterable: true },
  { name: stripTnt(SESSION_FIELD.generation), field_type: 'int' },
  { name: stripTnt(SESSION_FIELD.previousSessionId), field_type: 'text' },
  { name: stripTnt(SESSION_FIELD.endReason), field_type: 'text' },
  { name: stripTnt(SESSION_FIELD.messageCount), field_type: 'int' },
  // Timestamps
  { name: stripTnt(SESSION_FIELD.createdAtMs), field_type: 'timestamp' },
  { name: stripTnt(SESSION_FIELD.lastUsedAtMs), field_type: 'timestamp', is_filterable: true },
  { name: stripTnt(SESSION_FIELD.expiresAtMs), field_type: 'timestamp', is_filterable: true },
  { name: stripTnt(SESSION_FIELD.hardExpiresAtMs), field_type: 'timestamp' },
];

export type SchemaFieldSpec = FieldSpec;

const immutableTntNames = (specs: FieldSpec[]): Set<string> =>
  new Set(specs.filter((f) => f.is_immutable).map((f) => `${TNT}${f.name}`));

export const SESSION_IMMUTABLE_FIELDS = immutableTntNames(SESSION_FIELD_SPECS);

export function omitImmutable(
  fields: Record<string, any>,
  immutable: Set<string>
): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!immutable.has(key)) result[key] = value;
  }
  return result;
}
