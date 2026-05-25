/**
 * Session store — persists Slack ↔ DevRev AI conversation references as
 * DevRev custom objects (leaf type: slack_ai_session).
 *
 * Replaces the previous in-memory Map so conversation routing survives
 * across function invocations / cold starts. An in-memory cache keyed on
 * sessionId avoids the custom-objects.list round-trip on hot paths.
 */

import axios from 'axios';
import {
  SESSION_LEAF_TYPE,
  SessionTimingConfig,
} from './session-config';
import { SESSION_FIELD, SESSION_IMMUTABLE_FIELDS, omitImmutable } from './session-fields';
import { ConversationReference } from './conversation-store';

export type SessionStatus = 'active' | 'ended' | 'expired';

export type SessionEndReason =
  | ''
  | 'idle_timeout'
  | 'absolute_timeout'
  | 'user_reset'
  | 'manual';

export interface StoreConfig {
  devrevEndpoint: string;
  serviceAccountToken: string;
  timing?: SessionTimingConfig;
}

const sessionObjectIdCache = new Map<string, string>();

const TENANT_FRAGMENT_SCHEMA_SPEC = { tenant_fragment: true } as const;

const DEFAULT_TIMING: SessionTimingConfig = {
  idleTtlMs: 8 * 60 * 60 * 1000,         // 8h
  absoluteTtlMs: 24 * 60 * 60 * 1000,    // 24h
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
// conversation DONs (used as session ids) can run long. Trim defensively.
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

function describeChannel(ref: ConversationReference): string {
  if (ref.channelName) return ref.channelName;
  const type = (ref.conversationType || '').toLowerCase();
  if (type === 'im') return 'DM';
  if (type === 'mpim') return 'Group DM';
  if (type === 'channel') return ref.channel || 'channel';
  return ref.channel || 'unknown';
}

function buildTitle(sessionId: string, ref: ConversationReference, createdAtMs: number): string {
  const who =
    ref.userEmail ||
    ref.userName ||
    ref.devrevUserId ||
    ref.userId ||
    sessionId;
  const channel = describeChannel(ref);
  const when = epochMsToIso(createdAtMs) || new Date().toISOString();
  const title = `${who} — ${channel} — ${when}`.trim();
  return (title || `slack session ${sessionId}`).slice(0, TEXT_FIELD_MAX);
}

interface SessionPersistOptions {
  status?: SessionStatus;
  generation?: number;
  previousSessionId?: string;
  endReason?: SessionEndReason;
  messageCount?: number;
  createdAtMs?: number;
}

function buildCustomFields(
  sessionId: string,
  ref: ConversationReference,
  timing: SessionTimingConfig,
  opts: SessionPersistOptions
): Record<string, any> {
  const now = Date.now();
  const createdAtMs = opts.createdAtMs ?? ref.timestamp ?? now;
  return dropEmpty({
    // Identity
    [SESSION_FIELD.sessionId]: trimText(sessionId),
    [SESSION_FIELD.channel]: trimText(ref.channel),
    [SESSION_FIELD.channelName]: trimText(ref.channelName),
    [SESSION_FIELD.conversationType]: trimText(ref.conversationType),
    [SESSION_FIELD.threadTs]: ref.threadTs,
    [SESSION_FIELD.messageTs]: ref.messageTs,
    [SESSION_FIELD.teamId]: ref.teamId,
    // Slack user
    [SESSION_FIELD.userId]: trimText(ref.userId),
    [SESSION_FIELD.userName]: trimText(ref.userName),
    [SESSION_FIELD.userEmail]: trimText(ref.userEmail),
    // Bot / DevRev linkage
    [SESSION_FIELD.botUserId]: trimText(ref.botUserId),
    [SESSION_FIELD.devrevUserId]: trimText(ref.devrevUserId),
    // Routing helpers
    [SESSION_FIELD.tempMessageTs]: ref.tempMessageTs,
    // Lifecycle
    [SESSION_FIELD.status]: opts.status ?? 'active',
    [SESSION_FIELD.generation]: opts.generation ?? 0,
    [SESSION_FIELD.previousSessionId]: trimText(opts.previousSessionId),
    [SESSION_FIELD.endReason]: opts.endReason ?? '',
    [SESSION_FIELD.messageCount]: opts.messageCount ?? 0,
    // Timestamps
    [SESSION_FIELD.createdAtMs]: epochMsToIso(createdAtMs),
    [SESSION_FIELD.lastUsedAtMs]: epochMsToIso(now),
    [SESSION_FIELD.expiresAtMs]: epochMsToIso(now + timing.idleTtlMs),
    [SESSION_FIELD.hardExpiresAtMs]: epochMsToIso(createdAtMs + timing.absoluteTtlMs),
  });
}

function refFromCustomObject(co: any): ConversationReference | null {
  if (!co) return null;
  const fields = co.custom_fields || {};
  if (!fields || Object.keys(fields).length === 0) return null;
  const createdAt = asEpochMs(fields[SESSION_FIELD.createdAtMs]) ?? 0;
  return {
    channel: asString(fields[SESSION_FIELD.channel]) || '',
    channelName: asString(fields[SESSION_FIELD.channelName]),
    conversationType: asString(fields[SESSION_FIELD.conversationType]),
    userId: asString(fields[SESSION_FIELD.userId]) || '',
    userName: asString(fields[SESSION_FIELD.userName]),
    userEmail: asString(fields[SESSION_FIELD.userEmail]),
    threadTs: asString(fields[SESSION_FIELD.threadTs]),
    messageTs: asString(fields[SESSION_FIELD.messageTs]) || '',
    teamId: asString(fields[SESSION_FIELD.teamId]),
    botUserId: asString(fields[SESSION_FIELD.botUserId]),
    devrevUserId: asString(fields[SESSION_FIELD.devrevUserId]),
    tempMessageTs: asString(fields[SESSION_FIELD.tempMessageTs]),
    timestamp: createdAt,
  };
}

async function findUniqueByKey(
  config: StoreConfig,
  uniqueKey: string
): Promise<any | null> {
  if (!isStoreConfigured(config)) return null;
  const t = Date.now();
  try {
    const response = await axios.post(
      `${config.devrevEndpoint}/custom-objects.list`,
      { leaf_type: SESSION_LEAF_TYPE, limit: 200 },
      authHeaders(config)
    );
    const list = response.data?.result || response.data?.custom_objects || [];
    const hit = list.find((obj: any) => obj?.unique_key === uniqueKey) || null;
    console.log(`[SessionStore] list done items=${list.length} match=${hit ? hit.id : 'null'} for unique_key=${uniqueKey} status=${response.status} ms=${Date.now() - t}`);
    return hit;
  } catch (error: any) {
    const body = JSON.stringify(error?.response?.data || error?.message || String(error));
    console.error(`[SessionStore] list failed unique_key=${uniqueKey} status=${error?.response?.status} ms=${Date.now() - t} body=${body}`);
    throw error;
  }
}

async function getById(config: StoreConfig, objectId: string): Promise<any | null> {
  const t = Date.now();
  try {
    const response = await axios.post(
      `${config.devrevEndpoint}/custom-objects.get`,
      { id: objectId },
      authHeaders(config)
    );
    const co = response.data?.custom_object || null;
    console.log(`[SessionStore] get done id=${objectId} found=${Boolean(co?.id)} status=${response.status} ms=${Date.now() - t}`);
    return co;
  } catch (error: any) {
    const body = JSON.stringify(error?.response?.data || error?.message || String(error));
    console.warn(`[SessionStore] get failed id=${objectId} status=${error?.response?.status} ms=${Date.now() - t} body=${body}`);
    return null;
  }
}

async function locate(
  config: StoreConfig,
  sessionId: string
): Promise<{ id: string; raw: any } | null> {
  const cachedId = sessionObjectIdCache.get(sessionId);
  if (cachedId) {
    console.log(`[SessionStore] locate cache hit sessionId=${sessionId} cached_id=${cachedId}`);
    const fetched = await getById(config, cachedId);
    if (fetched?.id) return { id: fetched.id, raw: fetched };
    console.warn(`[SessionStore] locate cache stale sessionId=${sessionId} cached_id=${cachedId} (cleared)`);
    sessionObjectIdCache.delete(sessionId);
  }
  console.log(`[SessionStore] locate fallback list sessionId=${sessionId}`);
  const found = await findUniqueByKey(config, sessionUniqueKey(sessionId));
  if (!found?.id) return null;
  sessionObjectIdCache.set(sessionId, found.id);
  return { id: found.id, raw: found };
}

function readLifecycle(co: any): SessionPersistOptions {
  const fields = co?.custom_fields || {};
  return {
    status: (asString(fields[SESSION_FIELD.status]) as SessionStatus) || 'active',
    generation: asNumber(fields[SESSION_FIELD.generation]) ?? 0,
    previousSessionId: asString(fields[SESSION_FIELD.previousSessionId]) || '',
    endReason: (asString(fields[SESSION_FIELD.endReason]) as SessionEndReason) || '',
    messageCount: asNumber(fields[SESSION_FIELD.messageCount]) ?? 0,
    createdAtMs: asEpochMs(fields[SESSION_FIELD.createdAtMs]),
  };
}

/**
 * Persist a conversation reference for `sessionId`. Creates the custom
 * object on first call, updates in place thereafter. On update, the
 * lifecycle counters are preserved and `message_count` is incremented;
 * `last_used_at_ms` and `expires_at_ms` roll forward.
 */
export async function storeConversationReference(
  config: StoreConfig,
  sessionId: string,
  ref: ConversationReference
): Promise<void> {
  if (!isStoreConfigured(config) || !sessionId) {
    console.warn(`[SessionStore] store skipped: configured=${isStoreConfigured(config)} sessionId=${sessionId || '(empty)'}`);
    return;
  }
  const timing = config.timing || DEFAULT_TIMING;
  const uniqueKey = sessionUniqueKey(sessionId);
  console.log(`[SessionStore] store start sessionId=${sessionId} uniqueKey=${uniqueKey} leaf_type=${SESSION_LEAF_TYPE} endpoint=${config.devrevEndpoint}`);

  const t0 = Date.now();
  const existing = await locate(config, sessionId);
  console.log(`[SessionStore] locate done existing=${existing ? existing.id : 'null'} ms=${Date.now() - t0}`);

  if (existing) {
    const lifecycle = readLifecycle(existing.raw);
    const customFields = buildCustomFields(sessionId, ref, timing, {
      ...lifecycle,
      messageCount: (lifecycle.messageCount ?? 0) + 1,
    });
    const title = buildTitle(sessionId, ref, lifecycle.createdAtMs ?? Date.now());
    const updateFields = omitImmutable(customFields, SESSION_IMMUTABLE_FIELDS);
    const fieldKeys = Object.keys(updateFields);
    console.log(`[SessionStore] update prepared id=${existing.id} field_count=${fieldKeys.length} fields=${fieldKeys.join(',')} message_count=${updateFields[SESSION_FIELD.messageCount]} title_len=${title.length}`);
    const tUpdate = Date.now();
    try {
      const resp = await axios.post(
        `${config.devrevEndpoint}/custom-objects.update`,
        {
          id: existing.id,
          title,
          custom_fields: updateFields,
          custom_schema_spec: TENANT_FRAGMENT_SCHEMA_SPEC,
        },
        authHeaders(config)
      );
      console.log(`[SessionStore] update done id=${existing.id} status=${resp.status} ms=${Date.now() - tUpdate}`);
    } catch (error: any) {
      const body = JSON.stringify(error?.response?.data || error?.message || String(error));
      console.error(`[SessionStore] update failed id=${existing.id} status=${error?.response?.status} ms=${Date.now() - tUpdate} body=${body}`);
      throw error;
    }
    return;
  }

  const createdAtMs = ref.timestamp || Date.now();
  const customFields = buildCustomFields(sessionId, ref, timing, {
    status: 'active',
    generation: 0,
    messageCount: 1,
    createdAtMs,
  });
  const title = buildTitle(sessionId, ref, createdAtMs);
  const fieldKeys = Object.keys(customFields);
  console.log(`[SessionStore] create prepared unique_key=${uniqueKey} field_count=${fieldKeys.length} fields=${fieldKeys.join(',')} title_len=${title.length} title="${title.slice(0, 80)}"`);

  const tCreate = Date.now();
  try {
    const created = await axios.post(
      `${config.devrevEndpoint}/custom-objects.create`,
      {
        leaf_type: SESSION_LEAF_TYPE,
        unique_key: uniqueKey,
        title,
        custom_fields: customFields,
        custom_schema_spec: TENANT_FRAGMENT_SCHEMA_SPEC,
      },
      authHeaders(config)
    );
    const id = created.data?.custom_object?.id;
    if (id) sessionObjectIdCache.set(sessionId, id);
    console.log(`[SessionStore] create done id=${id || 'null'} status=${created.status} ms=${Date.now() - tCreate}`);
  } catch (error: any) {
    const body = JSON.stringify(error?.response?.data || error?.message || String(error));
    console.error(`[SessionStore] create failed unique_key=${uniqueKey} status=${error?.response?.status} ms=${Date.now() - tCreate} body=${body}`);
    throw error;
  }
}

/**
 * Fetch a conversation reference by sessionId, or undefined if missing.
 */
export async function getConversationReference(
  config: StoreConfig,
  sessionId: string
): Promise<ConversationReference | undefined> {
  if (!isStoreConfigured(config) || !sessionId) return undefined;
  const located = await locate(config, sessionId);
  if (!located) return undefined;
  const decoded = refFromCustomObject(located.raw);
  return decoded || undefined;
}

/**
 * Delete the custom object for `sessionId` if present. Best-effort: errors
 * are logged and swallowed so cleanup paths don't surface to users.
 */
export async function removeConversationReference(
  config: StoreConfig,
  sessionId: string
): Promise<void> {
  if (!isStoreConfigured(config) || !sessionId) return;
  const located = await locate(config, sessionId);
  if (!located) return;
  try {
    await axios.post(
      `${config.devrevEndpoint}/custom-objects.delete`,
      { id: located.id },
      authHeaders(config)
    );
  } catch (error: any) {
    const body = JSON.stringify(error?.response?.data || error?.message || String(error));
    console.warn(`[SessionStore] delete failed status=${error?.response?.status} body=${body}`);
  }
  sessionObjectIdCache.delete(sessionId);
}

export function _resetSessionStoreCaches(): void {
  sessionObjectIdCache.clear();
}
