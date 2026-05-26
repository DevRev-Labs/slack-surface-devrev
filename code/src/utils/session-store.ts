/**
 * Session store — persists Slack ↔ DevRev AI sessions as DevRev custom objects
 * (leaf type: slack_ai_session).
 *
 * One record per logical AI conversation. The active session for a
 * (channel, thread, user) tuple is found by listing slack_ai_session records
 * and filtering by conversation_key + status=active. An in-memory cache keyed
 * on conversation_key avoids the list call on hot paths.
 *
 * Lifecycle (mirrors microsoft-teams-surface-devrev):
 *   created → active → ended/expired → deleted
 *
 *   touchSession  rolls TTLs forward, ++messageCount
 *   endSession    flips to expired (idle/absolute) or ended (user_reset/manual)
 *   rotateSession endSession previous + createSession new (gen+1, prev linkage)
 *   deleteSession hard delete via /custom-objects.delete
 */

import axios from 'axios';
import { createHash, randomUUID } from 'crypto';
import {
  SESSION_LEAF_TYPE,
  SessionTimingConfig,
} from './session-config';
import {
  SESSION_FIELD,
  SESSION_IMMUTABLE_FIELDS,
  omitImmutable,
} from './session-fields';
import { ConversationReference } from './conversation-store';

export type SessionStatus = 'active' | 'ended' | 'expired';

export type SessionEndReason =
  | ''
  | 'idle_timeout'
  | 'absolute_timeout'
  | 'user_reset'
  | 'manual';

export interface SessionRecord {
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
  devrevConversationId: string;
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
  devrevConversationId?: string;
  tempMessageTs?: string | null;
}

const sessionObjectIdCache = new Map<string, string>();
// Maps conversationKey → sessionId for the currently active session.
const activeSessionByConversation = new Map<string, string>();

const TENANT_FRAGMENT_SCHEMA_SPEC = { tenant_fragment: true } as const;

const DEFAULT_TIMING: SessionTimingConfig = {
  idleTtlMs: 8 * 60 * 60 * 1000,
  absoluteTtlMs: 24 * 60 * 60 * 1000,
};

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

export function buildConversationKey(
  channel: string,
  threadTs: string,
  userId: string
): string {
  return createHash('sha256')
    .update(`${channel}::${threadTs}::${userId}`)
    .digest('hex')
    .slice(0, 32);
}

function sessionUniqueKey(sessionId: string): string {
  return `slack_ai_session_${sessionId}`;
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

// DevRev text fields cap at 255 chars — Slack IDs are short, but DevRev
// conversation DONs can run long. Trim defensively.
const TEXT_FIELD_MAX = 255;
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
  const who =
    record.userEmail ||
    record.userName ||
    record.devrevUserId ||
    record.userId ||
    record.sessionId;
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
    [SESSION_FIELD.devrevConversationId]: trimText(record.devrevConversationId),
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
  });
}

function recordFromCustomObject(co: any): SessionRecord | null {
  if (!co) return null;
  const fields = co.custom_fields || {};
  if (!fields || Object.keys(fields).length === 0) return null;
  return mergeRecord(co.id || '', {
    sessionId: asString(fields[SESSION_FIELD.sessionId]) || '',
    conversationKey: asString(fields[SESSION_FIELD.conversationKey]) || '',
    channel: asString(fields[SESSION_FIELD.channel]) || '',
    channelName: asString(fields[SESSION_FIELD.channelName]) || '',
    conversationType: asString(fields[SESSION_FIELD.conversationType]) || '',
    threadTs: asString(fields[SESSION_FIELD.threadTs]) || '',
    messageTs: asString(fields[SESSION_FIELD.messageTs]) || '',
    teamId: asString(fields[SESSION_FIELD.teamId]) || '',
    userId: asString(fields[SESSION_FIELD.userId]) || '',
    userName: asString(fields[SESSION_FIELD.userName]) || '',
    userEmail: asString(fields[SESSION_FIELD.userEmail]) || '',
    botUserId: asString(fields[SESSION_FIELD.botUserId]) || '',
    devrevUserId: asString(fields[SESSION_FIELD.devrevUserId]) || '',
    devrevConversationId: asString(fields[SESSION_FIELD.devrevConversationId]) || '',
    tempMessageTs: asString(fields[SESSION_FIELD.tempMessageTs]) || '',
    status: (asString(fields[SESSION_FIELD.status]) as SessionStatus) || 'active',
    generation: asNumber(fields[SESSION_FIELD.generation]) ?? 0,
    previousSessionId: asString(fields[SESSION_FIELD.previousSessionId]) || '',
    endReason: (asString(fields[SESSION_FIELD.endReason]) as SessionEndReason) || '',
    messageCount: asNumber(fields[SESSION_FIELD.messageCount]) ?? 0,
    createdAt: asEpochMs(fields[SESSION_FIELD.createdAtMs]) ?? 0,
    lastUsedAt: asEpochMs(fields[SESSION_FIELD.lastUsedAtMs]) ?? 0,
    expiresAt: asEpochMs(fields[SESSION_FIELD.expiresAtMs]) ?? 0,
    hardExpiresAt: asEpochMs(fields[SESSION_FIELD.hardExpiresAtMs]) ?? 0,
  });
}

function mergeRecord(objectId: string, partial: Partial<SessionRecord>): SessionRecord {
  return {
    objectId,
    sessionId: partial.sessionId || '',
    conversationKey: partial.conversationKey || '',
    channel: partial.channel || '',
    channelName: partial.channelName || '',
    conversationType: partial.conversationType || '',
    threadTs: partial.threadTs || '',
    messageTs: partial.messageTs || '',
    teamId: partial.teamId || '',
    userId: partial.userId || '',
    userName: partial.userName || '',
    userEmail: partial.userEmail || '',
    botUserId: partial.botUserId || '',
    devrevUserId: partial.devrevUserId || '',
    devrevConversationId: partial.devrevConversationId || '',
    tempMessageTs: partial.tempMessageTs || '',
    status: (partial.status as SessionStatus) || 'active',
    generation: typeof partial.generation === 'number' ? partial.generation : 0,
    previousSessionId: partial.previousSessionId || '',
    endReason: (partial.endReason as SessionEndReason) || '',
    messageCount: typeof partial.messageCount === 'number' ? partial.messageCount : 0,
    createdAt: typeof partial.createdAt === 'number' ? partial.createdAt : Date.now(),
    lastUsedAt: typeof partial.lastUsedAt === 'number' ? partial.lastUsedAt : Date.now(),
    expiresAt: typeof partial.expiresAt === 'number' ? partial.expiresAt : Date.now(),
    hardExpiresAt: typeof partial.hardExpiresAt === 'number' ? partial.hardExpiresAt : Date.now(),
  };
}

async function listSessionRecords(config: StoreConfig, limit: number = 200): Promise<SessionRecord[]> {
  if (!isStoreConfigured(config)) return [];
  const response = await axios.post(
    `${config.devrevEndpoint}/custom-objects.list`,
    { leaf_type: SESSION_LEAF_TYPE, limit },
    authHeaders(config)
  );
  const items = response.data?.result || response.data?.custom_objects || [];
  const result: SessionRecord[] = [];
  for (const item of items) {
    const decoded = recordFromCustomObject(item);
    if (decoded) result.push(decoded);
  }
  return result;
}

async function findUniqueByKey(
  config: StoreConfig,
  uniqueKey: string
): Promise<any | null> {
  if (!isStoreConfigured(config)) return null;
  const response = await axios.post(
    `${config.devrevEndpoint}/custom-objects.list`,
    { leaf_type: SESSION_LEAF_TYPE, limit: 200 },
    authHeaders(config)
  );
  const list = response.data?.result || response.data?.custom_objects || [];
  return list.find((obj: any) => obj?.unique_key === uniqueKey) || null;
}

async function getById(config: StoreConfig, objectId: string): Promise<any | null> {
  try {
    const response = await axios.post(
      `${config.devrevEndpoint}/custom-objects.get`,
      { id: objectId },
      authHeaders(config)
    );
    return response.data?.custom_object || null;
  } catch {
    return null;
  }
}

async function writeSession(
  config: StoreConfig,
  record: SessionRecord,
  isCreate: boolean
): Promise<SessionRecord> {
  if (!isStoreConfigured(config)) return record;
  const title = buildSessionTitle(record);
  const customFields = sessionCustomFields(record);
  if (isCreate) {
    const created = await axios.post(
      `${config.devrevEndpoint}/custom-objects.create`,
      {
        leaf_type: SESSION_LEAF_TYPE,
        unique_key: sessionUniqueKey(record.sessionId),
        title,
        custom_fields: customFields,
        custom_schema_spec: TENANT_FRAGMENT_SCHEMA_SPEC,
      },
      authHeaders(config)
    );
    const id = created.data?.custom_object?.id;
    if (id) {
      sessionObjectIdCache.set(record.sessionId, id);
      record.objectId = id;
    }
    return record;
  }
  await axios.post(
    `${config.devrevEndpoint}/custom-objects.update`,
    {
      id: record.objectId,
      title,
      custom_fields: omitImmutable(customFields, SESSION_IMMUTABLE_FIELDS),
      custom_schema_spec: TENANT_FRAGMENT_SCHEMA_SPEC,
    },
    authHeaders(config)
  );
  return record;
}

export function isSessionExpired(
  record: SessionRecord,
  now: number = Date.now()
): SessionEndReason | null {
  if (record.status !== 'active') return record.endReason || 'manual';
  if (record.hardExpiresAt && now >= record.hardExpiresAt) return 'absolute_timeout';
  if (record.expiresAt && now >= record.expiresAt) return 'idle_timeout';
  return null;
}

export async function getSessionById(
  config: StoreConfig,
  sessionId: string
): Promise<SessionRecord | null> {
  if (!isStoreConfigured(config) || !sessionId) return null;
  const cachedId = sessionObjectIdCache.get(sessionId);
  if (cachedId) {
    const fetched = await getById(config, cachedId);
    if (fetched?.id) {
      const decoded = recordFromCustomObject(fetched);
      if (decoded) return decoded;
    }
    sessionObjectIdCache.delete(sessionId);
  }
  const found = await findUniqueByKey(config, sessionUniqueKey(sessionId));
  if (!found?.id) return null;
  sessionObjectIdCache.set(sessionId, found.id);
  return recordFromCustomObject(found);
}

export async function getActiveSession(
  config: StoreConfig,
  conversationKey: string
): Promise<SessionRecord | null> {
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
 * Find the active session whose `devrev_conversation_id` matches. Used by the
 * timeline_entry_created fallback path in ai_response_handler — those events
 * arrive without our client_metadata so the only handle is the conversation
 * DON we stamped on the session record.
 */
export async function getSessionByDevrevConversationId(
  config: StoreConfig,
  devrevConversationId: string
): Promise<SessionRecord | null> {
  if (!isStoreConfigured(config) || !devrevConversationId) return null;
  const all = await listSessionRecords(config);
  let latest: SessionRecord | null = null;
  for (const record of all) {
    if (record.devrevConversationId !== devrevConversationId) continue;
    if (record.status !== 'active') continue;
    if (!latest || record.lastUsedAt > latest.lastUsedAt) latest = record;
  }
  return latest;
}

export async function createSession(
  config: StoreConfig,
  options: CreateSessionOptions,
  timing: SessionTimingConfig = config.timing || DEFAULT_TIMING
): Promise<SessionRecord> {
  const now = Date.now();
  const sessionId = randomUUID();
  const record: SessionRecord = mergeRecord('', {
    sessionId,
    conversationKey: options.identity.conversationKey,
    channel: options.identity.channel,
    channelName: options.identity.channelName,
    conversationType: options.identity.conversationType,
    threadTs: options.identity.threadTs,
    messageTs: options.identity.messageTs,
    teamId: options.identity.teamId,
    userId: options.identity.userId,
    userName: options.identity.userName,
    botUserId: options.identity.botUserId,
    devrevUserId: options.devrevUserId || '',
    userEmail: options.userEmail || '',
    status: 'active',
    generation: typeof options.generation === 'number' ? options.generation : 0,
    previousSessionId: options.previousSessionId || '',
    endReason: '',
    messageCount: 0,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: now + timing.idleTtlMs,
    hardExpiresAt: now + timing.absoluteTtlMs,
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
    lastUsedAt: now,
    expiresAt: now + timing.idleTtlMs,
    hardExpiresAt: record.hardExpiresAt || now + timing.absoluteTtlMs,
    messageCount: (record.messageCount || 0) + 1,
    channelName: patch.channelName ?? record.channelName,
    conversationType: patch.conversationType ?? record.conversationType,
    threadTs: patch.threadTs ?? record.threadTs,
    messageTs: patch.messageTs ?? record.messageTs,
    teamId: patch.teamId ?? record.teamId,
    userName: patch.userName ?? record.userName,
    userEmail: patch.userEmail ?? record.userEmail,
    botUserId: patch.botUserId ?? record.botUserId,
    devrevUserId: patch.devrevUserId ?? record.devrevUserId,
    devrevConversationId: patch.devrevConversationId ?? record.devrevConversationId,
    tempMessageTs:
      patch.tempMessageTs === null ? '' : patch.tempMessageTs ?? record.tempMessageTs,
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
    channelName: patch.channelName ?? record.channelName,
    conversationType: patch.conversationType ?? record.conversationType,
    threadTs: patch.threadTs ?? record.threadTs,
    messageTs: patch.messageTs ?? record.messageTs,
    teamId: patch.teamId ?? record.teamId,
    userName: patch.userName ?? record.userName,
    userEmail: patch.userEmail ?? record.userEmail,
    botUserId: patch.botUserId ?? record.botUserId,
    devrevUserId: patch.devrevUserId ?? record.devrevUserId,
    devrevConversationId: patch.devrevConversationId ?? record.devrevConversationId,
    tempMessageTs:
      patch.tempMessageTs === null ? '' : patch.tempMessageTs ?? record.tempMessageTs,
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
    status: reason === 'idle_timeout' || reason === 'absolute_timeout' ? 'expired' : 'ended',
    endReason: reason,
    lastUsedAt: now,
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
      identity: {
        conversationKey: identityPatch.conversationKey || previous.conversationKey,
        channel: identityPatch.channel || previous.channel,
        channelName: identityPatch.channelName ?? previous.channelName,
        conversationType: identityPatch.conversationType ?? previous.conversationType,
        threadTs: identityPatch.threadTs ?? previous.threadTs,
        messageTs: identityPatch.messageTs ?? previous.messageTs,
        teamId: identityPatch.teamId ?? previous.teamId,
        userId: identityPatch.userId || previous.userId,
        userName: identityPatch.userName ?? previous.userName,
        botUserId: identityPatch.botUserId ?? previous.botUserId,
      },
      devrevUserId: identityExtras.devrevUserId || previous.devrevUserId,
      userEmail: identityExtras.userEmail || previous.userEmail,
      generation: (previous.generation || 0) + 1,
      previousSessionId: previous.sessionId,
    },
    timing
  );
}

export async function deleteSession(
  config: StoreConfig,
  record: SessionRecord
): Promise<void> {
  if (!isStoreConfigured(config)) return;
  if (!record.objectId) return;
  try {
    await axios.post(
      `${config.devrevEndpoint}/custom-objects.delete`,
      { id: record.objectId },
      authHeaders(config)
    );
  } catch (error: any) {
    console.warn(
      '[SessionStore] Failed to delete session:',
      error?.response?.data || error?.message || error
    );
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
  limit: number = 200
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
  limit: number = 200
): Promise<SessionRecord[]> {
  const all = await listSessionRecords(config, limit);
  return all.filter(
    (record) => record.hardExpiresAt > 0 && now >= record.hardExpiresAt
  );
}

/**
 * Map a SessionRecord back to the legacy ConversationReference shape used by
 * the AI response handler.
 */
export function recordToConversationReference(record: SessionRecord): ConversationReference {
  return {
    channel: record.channel,
    channelName: record.channelName || undefined,
    conversationType: record.conversationType || undefined,
    userId: record.userId,
    userName: record.userName || undefined,
    userEmail: record.userEmail || undefined,
    threadTs: record.threadTs || undefined,
    messageTs: record.messageTs,
    teamId: record.teamId || undefined,
    botUserId: record.botUserId || undefined,
    devrevUserId: record.devrevUserId || undefined,
    tempMessageTs: record.tempMessageTs || undefined,
    timestamp: record.createdAt || Date.now(),
  };
}

export function _resetSessionStoreCaches(): void {
  sessionObjectIdCache.clear();
  activeSessionByConversation.clear();
}
