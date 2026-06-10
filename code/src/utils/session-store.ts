/**
 * Session store — persists Slack ↔ DevRev AI sessions as DevRev `conversation`
 * objects.
 *
 * The Slack session fields (identity, expiry, audit trail, in-flight
 * placeholder timestamp) are attached to the built-in conversation leaf type
 * via a tenant-fragment custom schema; see ensure_session_state_schema.
 *
 * The active session for a (channel, thread, user) tuple is found by listing
 * `conversations` and filtering on `tnt__conversation_key` + `tnt__status` and
 * picking the most recently used record. An in-memory cache keyed on the
 * conversation key avoids the list call on hot paths.
 *
 * Lifecycle (mirrors microsoft-teams-surface-devrev):
 *   created → active → ended/expired → deleted
 *
 *   touchSession  rolls TTLs forward, ++messageCount
 *   endSession    flips to expired (idle/absolute) or ended (user_reset/manual)
 *   rotateSession endSession previous + createSession new (gen+1, prev linkage)
 *   deleteSession hard delete via /conversations.delete
 */

import axios from 'axios';
import { createHash, randomUUID } from 'crypto';

import { ConversationReference } from './conversation-store';
import { getOrCreateActAsToken } from './devrev-auth';
import { SessionTimingConfig } from './session-config';
import { omitImmutable, SESSION_FIELD, SESSION_IMMUTABLE_FIELDS } from './session-fields';

export type SessionStatus = 'active' | 'ended' | 'expired';

export type SessionEndReason = '' | 'idle_timeout' | 'absolute_timeout' | 'user_reset' | 'manual';

export interface SessionRecord {
  // DevRev conversation DON. This is also the conversation that backs the
  // session's timeline (user queries + AI responses are posted here).
  objectId: string;
  sessionId: string;
  conversationKey: string;
  channel: string;
  channelName: string;
  conversationType: string;
  threadTs: string;
  messageTs: string;
  teamId: string;
  userId: string;
  userName: string;
  userEmail: string;
  botUserId: string;
  devrevUserId: string;
  tempMessageTs: string;
  status: SessionStatus;
  generation: number;
  previousSessionId: string;
  endReason: SessionEndReason;
  messageCount: number;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  hardExpiresAt: number;
  feedbackRating: number;
  feedbackText: string;
  feedbackSubmittedAt: number;
  lastDeliveredTurn: number;
  feedbackPromptTs: string;
}

export interface StoreConfig {
  devrevEndpoint: string;
  serviceAccountToken: string;
  timing?: SessionTimingConfig;
}

export interface SessionIdentity {
  conversationKey: string;
  channel: string;
  channelName?: string;
  conversationType?: string;
  threadTs?: string;
  messageTs?: string;
  teamId?: string;
  userId: string;
  userName?: string;
  botUserId?: string;
}

export interface SessionUserOverrides {
  devrevUserId?: string;
  userEmail?: string;
}

export interface CreateSessionOptions {
  identity: SessionIdentity;
  devrevUserId?: string;
  userEmail?: string;
  generation?: number;
  previousSessionId?: string;
}

export interface SessionPatch {
  channelName?: string;
  conversationType?: string;
  threadTs?: string;
  messageTs?: string;
  teamId?: string;
  userName?: string;
  userEmail?: string;
  botUserId?: string;
  devrevUserId?: string;
  tempMessageTs?: string | null;
  feedbackRating?: number;
  feedbackText?: string;
  feedbackSubmittedAt?: number;
  lastDeliveredTurn?: number;
  feedbackPromptTs?: string | null;
}

// Maps `sessionId → DevRev conversation id`. Avoids the list-then-filter
// roundtrip that conversations.list requires.
const sessionObjectIdCache = new Map<string, string>();
// Maps conversationKey → sessionId for the currently active session.
const activeSessionByConversation = new Map<string, string>();

// Schema spec required by the conversation tenant-fragment endpoints.
// `validate_required_fields: true` matches the SDK guidance — DevRev returns
// a clean 400 with the missing field name instead of a generic error.
const TENANT_FRAGMENT_SCHEMA_SPEC = {
  tenant_fragment: true,
  validate_required_fields: true,
} as const;

// `conversations.create` requires a `type` and "support" is the only value
// the API accepts today.
const CONVERSATION_TYPE_SUPPORT = 'support';

// Marks the conversation as originating from Slack so the DevRev UI
// renders "Source: Slack" with the Slack icon/label instead of the
// default "chat". DevRev's platform recognises the token "slack".
const SOURCE_CHANNEL_SLACK = 'slack';

const DEFAULT_TIMING: SessionTimingConfig = {
  absoluteTtlMs: 24 * 60 * 60 * 1000,
  idleTtlMs: 8 * 60 * 60 * 1000,
};

// DevRev text fields cap at 255 chars — Slack IDs are short, but DevRev DONs
// can run long. Trim defensively.
const TEXT_FIELD_MAX = 255;

function isStoreConfigured(config: StoreConfig | undefined | null): boolean {
  return Boolean(config?.serviceAccountToken && config?.devrevEndpoint);
}

function authHeaders(config: StoreConfig) {
  return {
    headers: {
      Authorization: `Bearer ${config.serviceAccountToken}`,
      'Content-Type': 'application/json',
    },
  };
}

export function buildConversationKey(channel: string, threadTs: string, userId: string): string {
  return createHash('sha256').update(`${channel}::${threadTs}::${userId}`).digest('hex').slice(0, 32);
}

function epochMsToIso(epochMs: number | undefined | null): string | null {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs) || epochMs <= 0) return null;
  return new Date(epochMs).toISOString();
}

function asEpochMs(raw: any): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const parsedDate = Date.parse(raw);
    if (Number.isFinite(parsedDate)) return parsedDate;
    const parsedNum = Number(raw);
    if (Number.isFinite(parsedNum)) return parsedNum;
  }
  return undefined;
}

function asString(raw: any): string | undefined {
  if (typeof raw === 'string') return raw;
  return undefined;
}

function asNumber(raw: any): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

const trimText = (value: string | undefined | null): string => {
  if (!value) return '';
  return value.length > TEXT_FIELD_MAX ? value.slice(0, TEXT_FIELD_MAX) : value;
};

// DevRev's tenant-fragment validator rejects empty strings on optional text
// fields with "Specified value not permitted". Drop empty/null values so the
// key is absent from the payload instead.
function dropEmpty(fields: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === '' || value === null || value === undefined) continue;
    result[key] = value;
  }
  return result;
}

function describeChannel(record: SessionRecord): string {
  if (record.channelName) return record.channelName;
  const type = (record.conversationType || '').toLowerCase();
  if (type === 'im') return 'DM';
  if (type === 'mpim') return 'Group DM';
  if (type === 'channel') return record.channel || 'channel';
  return record.channel || 'unknown';
}

function buildSessionTitle(record: SessionRecord): string {
  const who = record.userEmail || record.userName || record.devrevUserId || record.userId || record.sessionId;
  const channel = describeChannel(record);
  const when = epochMsToIso(record.createdAt) || new Date().toISOString();
  const title = `${who} — ${channel} — ${when}`.trim();
  return (title || `slack session ${record.sessionId}`).slice(0, TEXT_FIELD_MAX);
}

function sessionCustomFields(record: SessionRecord): Record<string, any> {
  return dropEmpty({
    [SESSION_FIELD.sessionId]: trimText(record.sessionId),
    [SESSION_FIELD.conversationKey]: trimText(record.conversationKey),
    [SESSION_FIELD.channel]: trimText(record.channel),
    [SESSION_FIELD.channelName]: trimText(record.channelName),
    [SESSION_FIELD.conversationType]: trimText(record.conversationType),
    [SESSION_FIELD.threadTs]: record.threadTs,
    [SESSION_FIELD.messageTs]: record.messageTs,
    [SESSION_FIELD.teamId]: record.teamId,
    [SESSION_FIELD.userId]: trimText(record.userId),
    [SESSION_FIELD.userName]: trimText(record.userName),
    [SESSION_FIELD.userEmail]: trimText(record.userEmail),
    [SESSION_FIELD.botUserId]: trimText(record.botUserId),
    [SESSION_FIELD.devrevUserId]: trimText(record.devrevUserId),
    [SESSION_FIELD.tempMessageTs]: record.tempMessageTs,
    [SESSION_FIELD.status]: record.status,
    [SESSION_FIELD.generation]: record.generation,
    [SESSION_FIELD.previousSessionId]: trimText(record.previousSessionId),
    [SESSION_FIELD.endReason]: record.endReason,
    [SESSION_FIELD.messageCount]: record.messageCount,
    [SESSION_FIELD.createdAtMs]: epochMsToIso(record.createdAt),
    [SESSION_FIELD.lastUsedAtMs]: epochMsToIso(record.lastUsedAt),
    [SESSION_FIELD.expiresAtMs]: epochMsToIso(record.expiresAt),
    [SESSION_FIELD.hardExpiresAtMs]: epochMsToIso(record.hardExpiresAt),
    [SESSION_FIELD.feedbackRating]: record.feedbackRating || undefined,
    [SESSION_FIELD.feedbackText]: trimText(record.feedbackText),
    [SESSION_FIELD.feedbackSubmittedAtMs]: epochMsToIso(record.feedbackSubmittedAt),
    [SESSION_FIELD.lastDeliveredTurn]: record.lastDeliveredTurn || undefined,
    [SESSION_FIELD.feedbackPromptTs]: trimText(record.feedbackPromptTs),
  });
}

function recordFromConversation(conversation: any): SessionRecord | null {
  if (!conversation) return null;
  const fields = conversation.custom_fields || {};
  if (!fields || Object.keys(fields).length === 0) return null;
  return mergeRecord(conversation.id || '', {
    botUserId: asString(fields[SESSION_FIELD.botUserId]) || '',
    channel: asString(fields[SESSION_FIELD.channel]) || '',
    channelName: asString(fields[SESSION_FIELD.channelName]) || '',
    conversationKey: asString(fields[SESSION_FIELD.conversationKey]) || '',
    conversationType: asString(fields[SESSION_FIELD.conversationType]) || '',
    createdAt: asEpochMs(fields[SESSION_FIELD.createdAtMs]) ?? 0,
    devrevUserId: asString(fields[SESSION_FIELD.devrevUserId]) || '',
    endReason: (asString(fields[SESSION_FIELD.endReason]) as SessionEndReason) || '',
    expiresAt: asEpochMs(fields[SESSION_FIELD.expiresAtMs]) ?? 0,
    feedbackPromptTs: asString(fields[SESSION_FIELD.feedbackPromptTs]) || '',
    feedbackRating: asNumber(fields[SESSION_FIELD.feedbackRating]) ?? 0,
    feedbackSubmittedAt: asEpochMs(fields[SESSION_FIELD.feedbackSubmittedAtMs]) ?? 0,
    feedbackText: asString(fields[SESSION_FIELD.feedbackText]) || '',
    generation: asNumber(fields[SESSION_FIELD.generation]) ?? 0,
    hardExpiresAt: asEpochMs(fields[SESSION_FIELD.hardExpiresAtMs]) ?? 0,
    lastDeliveredTurn: asNumber(fields[SESSION_FIELD.lastDeliveredTurn]) ?? 0,
    lastUsedAt: asEpochMs(fields[SESSION_FIELD.lastUsedAtMs]) ?? 0,
    messageCount: asNumber(fields[SESSION_FIELD.messageCount]) ?? 0,
    messageTs: asString(fields[SESSION_FIELD.messageTs]) || '',
    previousSessionId: asString(fields[SESSION_FIELD.previousSessionId]) || '',
    sessionId: asString(fields[SESSION_FIELD.sessionId]) || '',
    status: (asString(fields[SESSION_FIELD.status]) as SessionStatus) || 'active',
    teamId: asString(fields[SESSION_FIELD.teamId]) || '',
    tempMessageTs: asString(fields[SESSION_FIELD.tempMessageTs]) || '',
    threadTs: asString(fields[SESSION_FIELD.threadTs]) || '',
    userEmail: asString(fields[SESSION_FIELD.userEmail]) || '',
    userId: asString(fields[SESSION_FIELD.userId]) || '',
    userName: asString(fields[SESSION_FIELD.userName]) || '',
  });
}

function mergeRecord(objectId: string, partial: Partial<SessionRecord>): SessionRecord {
  return {
    botUserId: partial.botUserId || '',
    channel: partial.channel || '',
    channelName: partial.channelName || '',
    conversationKey: partial.conversationKey || '',
    conversationType: partial.conversationType || '',
    createdAt: typeof partial.createdAt === 'number' ? partial.createdAt : Date.now(),
    devrevUserId: partial.devrevUserId || '',
    endReason: (partial.endReason as SessionEndReason) || '',
    expiresAt: typeof partial.expiresAt === 'number' ? partial.expiresAt : Date.now(),
    feedbackPromptTs: partial.feedbackPromptTs || '',
    feedbackRating: typeof partial.feedbackRating === 'number' ? partial.feedbackRating : 0,
    feedbackSubmittedAt: typeof partial.feedbackSubmittedAt === 'number' ? partial.feedbackSubmittedAt : 0,
    feedbackText: partial.feedbackText || '',
    generation: typeof partial.generation === 'number' ? partial.generation : 0,
    hardExpiresAt: typeof partial.hardExpiresAt === 'number' ? partial.hardExpiresAt : Date.now(),
    lastDeliveredTurn: typeof partial.lastDeliveredTurn === 'number' ? partial.lastDeliveredTurn : 0,
    lastUsedAt: typeof partial.lastUsedAt === 'number' ? partial.lastUsedAt : Date.now(),
    messageCount: typeof partial.messageCount === 'number' ? partial.messageCount : 0,
    messageTs: partial.messageTs || '',
    objectId,
    previousSessionId: partial.previousSessionId || '',
    sessionId: partial.sessionId || '',
    status: (partial.status as SessionStatus) || 'active',
    teamId: partial.teamId || '',
    tempMessageTs: partial.tempMessageTs || '',
    threadTs: partial.threadTs || '',
    userEmail: partial.userEmail || '',
    userId: partial.userId || '',
    userName: partial.userName || '',
  };
}

async function listConversations(config: StoreConfig, limit: number): Promise<any[]> {
  const body = { limit };
  try {
    const response = await axios.post(`${config.devrevEndpoint}/conversations.list`, body, authHeaders(config));
    return response.data?.conversations || [];
  } catch (error: any) {
    console.warn('[session-store] conversations.list failed', {
      err_data: error?.response?.data,
      err_status: error?.response?.status,
    });
    throw error;
  }
}

async function getById(config: StoreConfig, objectId: string): Promise<any | null> {
  try {
    const response = await axios.post(
      `${config.devrevEndpoint}/conversations.get`,
      { id: objectId },
      authHeaders(config)
    );
    return response.data?.conversation || null;
  } catch {
    return null;
  }
}

async function listSessionRecords(config: StoreConfig, limit = 200): Promise<SessionRecord[]> {
  if (!isStoreConfigured(config)) return [];
  // conversations.list does not accept arbitrary custom_fields equality
  // filters across all DevRev clusters, so we list-then-filter in memory and
  // skip anything missing our tnt__session_id (those are non-Slack conversations).
  const items = await listConversations(config, limit);
  const result: SessionRecord[] = [];
  for (const item of items) {
    const decoded = recordFromConversation(item);
    if (!decoded || !decoded.sessionId) continue;
    result.push(decoded);
  }
  return result;
}

// Schema-required custom fields. Mirror of `is_required: true` in
// SESSION_FIELD_SPECS so writeSession can surface a clear error before
// DevRev rejects the request with a generic 400.
const REQUIRED_CUSTOM_FIELDS: string[] = [
  SESSION_FIELD.sessionId,
  SESSION_FIELD.conversationKey,
  SESSION_FIELD.channel,
  SESSION_FIELD.userId,
];

function assertRequiredFieldsPresent(customFields: Record<string, any>): void {
  const missing = REQUIRED_CUSTOM_FIELDS.filter((key) => {
    const value = customFields[key];
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0) {
    throw new Error(`session-store: missing required custom fields: ${missing.join(', ')}`);
  }
}

async function writeSession(config: StoreConfig, record: SessionRecord, isCreate: boolean): Promise<SessionRecord> {
  if (!isStoreConfigured(config)) return record;
  const title = buildSessionTitle(record);
  const customFields = sessionCustomFields(record);
  if (isCreate) {
    assertRequiredFieldsPresent(customFields);
    const payload: Record<string, any> = {
      custom_fields: customFields,
      custom_schema_spec: TENANT_FRAGMENT_SCHEMA_SPEC,
      // Tells DevRev the conversation originated from Slack — the UI
      // renders "Source: Slack" with the Slack icon instead of "Chat".
      // We intentionally don't set `source_channel_v2`: it expects a
      // DevRev-internal Slack channel resource id (don:…/channels/…),
      // not the raw Slack channel id, and we don't have one.
      source_channel: SOURCE_CHANNEL_SLACK,
      title,
      type: CONVERSATION_TYPE_SUPPORT,
    };
    if (record.devrevUserId) {
      payload['members'] = [record.devrevUserId];
      payload['owned_by'] = [record.devrevUserId];
    }
    try {
      const created = await axios.post(`${config.devrevEndpoint}/conversations.create`, payload, authHeaders(config));
      const id = created.data?.conversation?.id;
      if (id) {
        sessionObjectIdCache.set(record.sessionId, id);
        record.objectId = id;
      }
      return record;
    } catch (error: any) {
      console.error('[session-store] conversations.create failed', {
        err_data: error?.response?.data,
        err_status: error?.response?.status,
        session_id: record.sessionId,
      });
      throw error;
    }
  }
  const updatePayload = {
    custom_fields: omitImmutable(customFields, SESSION_IMMUTABLE_FIELDS),
    custom_schema_spec: TENANT_FRAGMENT_SCHEMA_SPEC,
    id: record.objectId,
    title,
  };
  try {
    await axios.post(`${config.devrevEndpoint}/conversations.update`, updatePayload, authHeaders(config));
    return record;
  } catch (error: any) {
    console.error('[session-store] conversations.update failed', {
      err_data: error?.response?.data,
      err_status: error?.response?.status,
      session_id: record.sessionId,
    });
    throw error;
  }
}

export function isSessionExpired(record: SessionRecord, now: number = Date.now()): SessionEndReason | null {
  if (record.status !== 'active') return record.endReason || 'manual';
  if (record.hardExpiresAt && now >= record.hardExpiresAt) return 'absolute_timeout';
  if (record.expiresAt && now >= record.expiresAt) return 'idle_timeout';
  return null;
}

export async function getSessionById(config: StoreConfig, sessionId: string): Promise<SessionRecord | null> {
  if (!isStoreConfigured(config) || !sessionId) return null;
  const cachedId = sessionObjectIdCache.get(sessionId);
  if (cachedId) {
    const fetched = await getById(config, cachedId);
    if (fetched?.id) {
      const decoded = recordFromConversation(fetched);
      if (decoded) return decoded;
    }
    sessionObjectIdCache.delete(sessionId);
  }
  const all = await listSessionRecords(config);
  for (const record of all) {
    if (record.sessionId === sessionId) {
      sessionObjectIdCache.set(sessionId, record.objectId);
      return record;
    }
  }
  return null;
}

export async function getActiveSession(config: StoreConfig, conversationKey: string): Promise<SessionRecord | null> {
  if (!isStoreConfigured(config) || !conversationKey) return null;
  const cachedSessionId = activeSessionByConversation.get(conversationKey);
  if (cachedSessionId) {
    const cached = await getSessionById(config, cachedSessionId);
    if (cached && cached.status === 'active' && cached.conversationKey === conversationKey) {
      return cached;
    }
    activeSessionByConversation.delete(conversationKey);
  }
  const all = await listSessionRecords(config);
  let latest: SessionRecord | null = null;
  for (const record of all) {
    if (record.conversationKey !== conversationKey) continue;
    if (record.status !== 'active') continue;
    if (!latest || record.lastUsedAt > latest.lastUsedAt) latest = record;
  }
  if (!latest) return null;
  activeSessionByConversation.set(conversationKey, latest.sessionId);
  if (latest.objectId) sessionObjectIdCache.set(latest.sessionId, latest.objectId);
  return latest;
}

/**
 * Slash-command lookup: a `/sda-feedback` invocation has no thread_ts, so the
 * conversation_key path can't be used. Instead, scan active sessions for
 * (channel, userId) and return the most-recently-used. Returns null when
 * the user has no active session in this channel.
 */
export async function getLatestActiveSessionForUserInChannel(
  config: StoreConfig,
  channel: string,
  userId: string
): Promise<SessionRecord | null> {
  if (!isStoreConfigured(config) || !channel || !userId) return null;
  const all = await listSessionRecords(config);
  let latest: SessionRecord | null = null;
  for (const record of all) {
    if (record.status !== 'active') continue;
    if (record.channel !== channel) continue;
    if (record.userId !== userId) continue;
    if (!latest || record.lastUsedAt > latest.lastUsedAt) latest = record;
  }
  return latest;
}

/**
 * Find the active session whose backing DevRev conversation DON matches.
 * Used by the timeline_entry_created fallback path in ai_response_handler —
 * those events arrive without our client_metadata so the only handle is the
 * conversation DON, which IS our session's objectId.
 */
export async function getSessionByConversationId(
  config: StoreConfig,
  conversationId: string
): Promise<SessionRecord | null> {
  if (!isStoreConfigured(config) || !conversationId) return null;
  const cachedHit = await getById(config, conversationId);
  if (cachedHit?.id) {
    const decoded = recordFromConversation(cachedHit);
    if (decoded && decoded.sessionId) {
      sessionObjectIdCache.set(decoded.sessionId, decoded.objectId);
      return decoded;
    }
  }
  return null;
}

export async function createSession(
  config: StoreConfig,
  options: CreateSessionOptions,
  timing: SessionTimingConfig = config.timing || DEFAULT_TIMING
): Promise<SessionRecord> {
  const now = Date.now();
  const sessionId = randomUUID();
  const record: SessionRecord = mergeRecord('', {
    botUserId: options.identity.botUserId,
    channel: options.identity.channel,
    channelName: options.identity.channelName,
    conversationKey: options.identity.conversationKey,
    conversationType: options.identity.conversationType,
    createdAt: now,
    devrevUserId: options.devrevUserId || '',
    endReason: '',
    expiresAt: now + timing.idleTtlMs,
    generation: typeof options.generation === 'number' ? options.generation : 0,
    hardExpiresAt: now + timing.absoluteTtlMs,
    lastUsedAt: now,
    messageCount: 0,
    messageTs: options.identity.messageTs,
    previousSessionId: options.previousSessionId || '',
    sessionId,
    status: 'active',
    teamId: options.identity.teamId,
    threadTs: options.identity.threadTs,
    userEmail: options.userEmail || '',
    userId: options.identity.userId,
    userName: options.identity.userName,
  });
  await writeSession(config, record, true);
  if (record.conversationKey) {
    activeSessionByConversation.set(record.conversationKey, record.sessionId);
  }
  return record;
}

export async function touchSession(
  config: StoreConfig,
  record: SessionRecord,
  timing: SessionTimingConfig = config.timing || DEFAULT_TIMING,
  patch: SessionPatch = {}
): Promise<SessionRecord> {
  const now = Date.now();
  const updated: SessionRecord = {
    ...record,
    botUserId: patch.botUserId ?? record.botUserId,
    channelName: patch.channelName ?? record.channelName,
    conversationType: patch.conversationType ?? record.conversationType,
    devrevUserId: patch.devrevUserId ?? record.devrevUserId,
    expiresAt: now + timing.idleTtlMs,
    feedbackPromptTs: patch.feedbackPromptTs === null ? '' : patch.feedbackPromptTs ?? record.feedbackPromptTs,
    feedbackRating: patch.feedbackRating ?? record.feedbackRating,
    feedbackSubmittedAt: patch.feedbackSubmittedAt ?? record.feedbackSubmittedAt,
    feedbackText: patch.feedbackText ?? record.feedbackText,
    hardExpiresAt: record.hardExpiresAt || now + timing.absoluteTtlMs,
    lastDeliveredTurn: patch.lastDeliveredTurn ?? record.lastDeliveredTurn,
    lastUsedAt: now,
    messageCount: (record.messageCount || 0) + 1,
    messageTs: patch.messageTs ?? record.messageTs,
    teamId: patch.teamId ?? record.teamId,
    tempMessageTs: patch.tempMessageTs === null ? '' : patch.tempMessageTs ?? record.tempMessageTs,
    threadTs: patch.threadTs ?? record.threadTs,
    userEmail: patch.userEmail ?? record.userEmail,
    userName: patch.userName ?? record.userName,
  };
  await writeSession(config, updated, false);
  return updated;
}

/**
 * Apply routing-only updates (e.g. clearing tempMessageTs after the
 * AI response handler finishes). Does NOT roll TTLs forward and does NOT
 * increment messageCount.
 */
export async function patchSession(
  config: StoreConfig,
  record: SessionRecord,
  patch: SessionPatch
): Promise<SessionRecord> {
  const updated: SessionRecord = {
    ...record,
    botUserId: patch.botUserId ?? record.botUserId,
    channelName: patch.channelName ?? record.channelName,
    conversationType: patch.conversationType ?? record.conversationType,
    devrevUserId: patch.devrevUserId ?? record.devrevUserId,
    feedbackPromptTs: patch.feedbackPromptTs === null ? '' : patch.feedbackPromptTs ?? record.feedbackPromptTs,
    feedbackRating: patch.feedbackRating ?? record.feedbackRating,
    feedbackSubmittedAt: patch.feedbackSubmittedAt ?? record.feedbackSubmittedAt,
    feedbackText: patch.feedbackText ?? record.feedbackText,
    lastDeliveredTurn: patch.lastDeliveredTurn ?? record.lastDeliveredTurn,
    messageTs: patch.messageTs ?? record.messageTs,
    teamId: patch.teamId ?? record.teamId,
    tempMessageTs: patch.tempMessageTs === null ? '' : patch.tempMessageTs ?? record.tempMessageTs,
    threadTs: patch.threadTs ?? record.threadTs,
    userEmail: patch.userEmail ?? record.userEmail,
    userName: patch.userName ?? record.userName,
  };
  await writeSession(config, updated, false);
  return updated;
}

export async function endSession(
  config: StoreConfig,
  record: SessionRecord,
  reason: SessionEndReason
): Promise<SessionRecord> {
  const now = Date.now();
  const updated: SessionRecord = {
    ...record,
    endReason: reason,
    lastUsedAt: now,
    status: reason === 'idle_timeout' || reason === 'absolute_timeout' ? 'expired' : 'ended',
  };
  await writeSession(config, updated, false);
  if (record.conversationKey) {
    const cached = activeSessionByConversation.get(record.conversationKey);
    if (cached === record.sessionId) {
      activeSessionByConversation.delete(record.conversationKey);
    }
  }
  return updated;
}

export async function rotateSession(
  config: StoreConfig,
  previous: SessionRecord,
  reason: SessionEndReason,
  identityPatch: Partial<SessionIdentity> = {},
  timing: SessionTimingConfig = config.timing || DEFAULT_TIMING,
  identityExtras: SessionUserOverrides = {}
): Promise<SessionRecord> {
  await endSession(config, previous, reason);
  return createSession(
    config,
    {
      devrevUserId: identityExtras.devrevUserId || previous.devrevUserId,
      generation: (previous.generation || 0) + 1,
      identity: {
        botUserId: identityPatch.botUserId ?? previous.botUserId,
        channel: identityPatch.channel || previous.channel,
        channelName: identityPatch.channelName ?? previous.channelName,
        conversationKey: identityPatch.conversationKey || previous.conversationKey,
        conversationType: identityPatch.conversationType ?? previous.conversationType,
        messageTs: identityPatch.messageTs ?? previous.messageTs,
        teamId: identityPatch.teamId ?? previous.teamId,
        threadTs: identityPatch.threadTs ?? previous.threadTs,
        userId: identityPatch.userId || previous.userId,
        userName: identityPatch.userName ?? previous.userName,
      },
      previousSessionId: previous.sessionId,
      userEmail: identityExtras.userEmail || previous.userEmail,
    },
    timing
  );
}

export async function deleteSession(config: StoreConfig, record: SessionRecord): Promise<void> {
  if (!isStoreConfigured(config)) return;
  if (!record.objectId) return;

  // Conversations are created with `owned_by: [devrevUserId]`, so the raw
  // service-account token can't delete them — we must act as the owner when
  // we have one.
  let token = config.serviceAccountToken;
  if (record.devrevUserId) {
    const actAs = await getOrCreateActAsToken(
      record.devrevUserId,
      config.devrevEndpoint,
      config.serviceAccountToken
    ).catch(() => null);
    if (actAs) token = actAs;
  }

  try {
    await axios.post(
      `${config.devrevEndpoint}/conversations.delete`,
      { id: record.objectId },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.warn('[session-store] failed to delete session', {
      err_data: error?.response?.data,
      err_status: error?.response?.status,
      object_id: record.objectId,
      session_id: record.sessionId,
      used_act_as: token !== config.serviceAccountToken,
    });
    return;
  }
  sessionObjectIdCache.delete(record.sessionId);
  if (record.conversationKey) {
    const cached = activeSessionByConversation.get(record.conversationKey);
    if (cached === record.sessionId) {
      activeSessionByConversation.delete(record.conversationKey);
    }
  }
}

/**
 * Sessions currently `active` whose idle timeout has elapsed but whose
 * absolute timeout has not. GC marks these expired without deleting.
 */
export async function listIdleExpiredSessions(
  config: StoreConfig,
  now: number = Date.now(),
  limit = 200
): Promise<SessionRecord[]> {
  const all = await listSessionRecords(config, limit);
  return all.filter(
    (record) =>
      record.status === 'active' &&
      record.expiresAt > 0 &&
      now >= record.expiresAt &&
      (!record.hardExpiresAt || now < record.hardExpiresAt)
  );
}

/**
 * Sessions whose absolute timeout has elapsed regardless of status. GC
 * deletes these from DevRev.
 */
export async function listHardExpiredSessions(
  config: StoreConfig,
  now: number = Date.now(),
  limit = 200
): Promise<SessionRecord[]> {
  const all = await listSessionRecords(config, limit);
  return all.filter((record) => record.hardExpiresAt > 0 && now >= record.hardExpiresAt);
}

/**
 * Map a SessionRecord back to the legacy ConversationReference shape used by
 * the AI response handler.
 */
export function recordToConversationReference(record: SessionRecord): ConversationReference {
  return {
    botUserId: record.botUserId || undefined,
    channel: record.channel,
    channelName: record.channelName || undefined,
    conversationType: record.conversationType || undefined,
    devrevUserId: record.devrevUserId || undefined,
    messageTs: record.messageTs,
    teamId: record.teamId || undefined,
    tempMessageTs: record.tempMessageTs || undefined,
    threadTs: record.threadTs || undefined,
    timestamp: record.createdAt || Date.now(),
    userEmail: record.userEmail || undefined,
    userId: record.userId,
    userName: record.userName || undefined,
  };
}

export function _resetSessionStoreCaches(): void {
  sessionObjectIdCache.clear();
  activeSessionByConversation.clear();
}
