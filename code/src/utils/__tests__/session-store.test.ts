import axios from 'axios';
import {
  buildConversationKey,
  createSession,
  deleteSession,
  endSession,
  getActiveSession,
  getSessionById,
  getSessionByDevrevConversationId,
  isSessionExpired,
  listHardExpiredSessions,
  listIdleExpiredSessions,
  patchSession,
  rotateSession,
  recordToConversationReference,
  touchSession,
  StoreConfig,
  SessionRecord,
  _resetSessionStoreCaches,
} from '../session-store';
import { SESSION_FIELD } from '../session-fields';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const timing = {
  idleTtlMs: 60 * 60 * 1000, // 1h
  absoluteTtlMs: 24 * 60 * 60 * 1000, // 24h
};

const config: StoreConfig = {
  devrevEndpoint: 'https://api.devrev.ai',
  serviceAccountToken: 'svc-token',
  timing,
};

const conversationKey = buildConversationKey('C0123456789', '1705315799.000050', 'U0123456789');

const identity = {
  conversationKey,
  channel: 'C0123456789',
  channelName: 'general',
  conversationType: 'channel',
  threadTs: '1705315799.000050',
  messageTs: '1705315800.000100',
  teamId: 'T0123456789',
  userId: 'U0123456789',
  userName: 'Alice',
  botUserId: 'UBOT00000',
};

interface FieldsOverrides {
  sessionId?: string;
  conversationKey?: string;
  devrevConversationId?: string;
  tempMessageTs?: string;
  status?: string;
  generation?: number;
  previousSessionId?: string;
  endReason?: string;
  messageCount?: number;
  createdAt?: number;
  lastUsedAt?: number;
  expiresAt?: number;
  hardExpiresAt?: number;
}

function fieldsForRecord(overrides: FieldsOverrides = {}) {
  const now = Date.now();
  return {
    [SESSION_FIELD.sessionId]: overrides.sessionId || 'uuid-1',
    [SESSION_FIELD.conversationKey]: overrides.conversationKey ?? conversationKey,
    [SESSION_FIELD.channel]: 'C0123456789',
    [SESSION_FIELD.channelName]: 'general',
    [SESSION_FIELD.conversationType]: 'channel',
    [SESSION_FIELD.threadTs]: '1705315799.000050',
    [SESSION_FIELD.messageTs]: '1705315800.000100',
    [SESSION_FIELD.teamId]: 'T0123456789',
    [SESSION_FIELD.userId]: 'U0123456789',
    [SESSION_FIELD.userName]: 'Alice',
    [SESSION_FIELD.userEmail]: 'alice@example.com',
    [SESSION_FIELD.botUserId]: 'UBOT00000',
    [SESSION_FIELD.devrevUserId]: 'don:identity:dvrv-us-1:devo/x:devu/y',
    [SESSION_FIELD.devrevConversationId]: overrides.devrevConversationId ?? '',
    [SESSION_FIELD.tempMessageTs]: overrides.tempMessageTs ?? '',
    [SESSION_FIELD.status]: overrides.status || 'active',
    [SESSION_FIELD.generation]: overrides.generation ?? 0,
    [SESSION_FIELD.previousSessionId]: overrides.previousSessionId ?? '',
    [SESSION_FIELD.endReason]: overrides.endReason ?? '',
    [SESSION_FIELD.messageCount]: overrides.messageCount ?? 0,
    [SESSION_FIELD.createdAtMs]: new Date(overrides.createdAt ?? now).toISOString(),
    [SESSION_FIELD.lastUsedAtMs]: new Date(overrides.lastUsedAt ?? now).toISOString(),
    [SESSION_FIELD.expiresAtMs]: new Date(
      overrides.expiresAt ?? now + timing.idleTtlMs
    ).toISOString(),
    [SESSION_FIELD.hardExpiresAtMs]: new Date(
      overrides.hardExpiresAt ?? now + timing.absoluteTtlMs
    ).toISOString(),
  };
}

describe('session-store state machine', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetSessionStoreCaches();
  });

  test('buildConversationKey is deterministic and 32 chars', () => {
    const a = buildConversationKey('c', 't', 'u');
    const b = buildConversationKey('c', 't', 'u');
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
    expect(buildConversationKey('c', 't', 'other')).not.toBe(a);
  });

  test('createSession writes a record with active status, gen=0, full TTL window', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { custom_object: { id: 'co-create' } } });
    const record = await createSession(config, { identity, devrevUserId: 'du-1', userEmail: 'a@x.com' });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toContain('/custom-objects.create');
    const create = body as any;
    expect(create.leaf_type).toBe('slack_ai_session');
    expect(create.unique_key).toBe(`slack_ai_session_${record.sessionId}`);
    expect(create.custom_fields[SESSION_FIELD.sessionId]).toBe(record.sessionId);
    expect(create.custom_fields[SESSION_FIELD.conversationKey]).toBe(conversationKey);
    expect(create.custom_fields[SESSION_FIELD.status]).toBe('active');
    expect(create.custom_fields[SESSION_FIELD.generation]).toBe(0);
    expect(create.custom_fields[SESSION_FIELD.messageCount]).toBe(0);
    expect(create.custom_fields[SESSION_FIELD.userEmail]).toBe('a@x.com');
    expect(create.custom_fields[SESSION_FIELD.devrevUserId]).toBe('du-1');
    expect(record.status).toBe('active');
    expect(record.generation).toBe(0);
    expect(record.objectId).toBe('co-create');
  });

  test('touchSession rolls TTLs forward, increments messageCount, omits immutable session_id', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { custom_object: { id: 'co-touch' } } });
    const record: SessionRecord = {
      objectId: 'co-touch',
      sessionId: 'uuid-touch',
      conversationKey,
      channel: 'C',
      channelName: 'general',
      conversationType: 'channel',
      threadTs: 't',
      messageTs: 'm',
      teamId: 'T',
      userId: 'U',
      userName: 'Alice',
      userEmail: '',
      botUserId: 'UBOT',
      devrevUserId: '',
      devrevConversationId: '',
      tempMessageTs: '',
      status: 'active',
      generation: 0,
      previousSessionId: '',
      endReason: '',
      messageCount: 3,
      createdAt: Date.now() - 60_000,
      lastUsedAt: Date.now() - 60_000,
      expiresAt: Date.now() - 60_000,
      hardExpiresAt: Date.now() + timing.absoluteTtlMs,
    };

    const updated = await touchSession(config, record, timing, {
      tempMessageTs: 'new-temp',
      devrevConversationId: 'don:core:dvrv-us-1:devo/x:conversation/abc',
    });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [, body] = mockedAxios.post.mock.calls[0];
    const update = body as any;
    expect(update.custom_fields[SESSION_FIELD.sessionId]).toBeUndefined();
    expect(update.custom_fields[SESSION_FIELD.tempMessageTs]).toBe('new-temp');
    expect(update.custom_fields[SESSION_FIELD.devrevConversationId]).toBe(
      'don:core:dvrv-us-1:devo/x:conversation/abc'
    );
    expect(update.custom_fields[SESSION_FIELD.messageCount]).toBe(4);
    expect(updated.messageCount).toBe(4);
    expect(updated.expiresAt).toBeGreaterThan(record.expiresAt);
  });

  test('patchSession applies routing patch without rolling TTLs or messageCount', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });
    const baseExpiry = Date.now() + 30_000;
    const record: SessionRecord = {
      objectId: 'co-p',
      sessionId: 'uuid-p',
      conversationKey,
      channel: 'C',
      channelName: '',
      conversationType: '',
      threadTs: '',
      messageTs: '',
      teamId: '',
      userId: 'U',
      userName: '',
      userEmail: '',
      botUserId: '',
      devrevUserId: '',
      devrevConversationId: '',
      tempMessageTs: 'old',
      status: 'active',
      generation: 0,
      previousSessionId: '',
      endReason: '',
      messageCount: 5,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      expiresAt: baseExpiry,
      hardExpiresAt: baseExpiry + 60_000,
    };

    const updated = await patchSession(config, record, { tempMessageTs: null });
    expect(updated.tempMessageTs).toBe('');
    expect(updated.messageCount).toBe(5);
    expect(updated.expiresAt).toBe(baseExpiry);
  });

  test('endSession flips active → expired with idle_timeout, sets endReason', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });
    const record: SessionRecord = {
      objectId: 'co-end',
      sessionId: 'uuid-end',
      conversationKey,
      channel: 'C',
      channelName: '',
      conversationType: '',
      threadTs: '',
      messageTs: '',
      teamId: '',
      userId: 'U',
      userName: '',
      userEmail: '',
      botUserId: '',
      devrevUserId: '',
      devrevConversationId: '',
      tempMessageTs: '',
      status: 'active',
      generation: 1,
      previousSessionId: 'uuid-prev',
      endReason: '',
      messageCount: 2,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      expiresAt: Date.now(),
      hardExpiresAt: Date.now() + 60_000,
    };

    const updated = await endSession(config, record, 'idle_timeout');
    expect(updated.status).toBe('expired');
    expect(updated.endReason).toBe('idle_timeout');

    const updated2 = await endSession(config, { ...record, status: 'active' }, 'user_reset');
    expect(updated2.status).toBe('ended');
    expect(updated2.endReason).toBe('user_reset');
  });

  test('rotateSession ends previous and creates new with gen+1 + previousSessionId linkage', async () => {
    // endSession update + createSession create
    mockedAxios.post
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { custom_object: { id: 'co-new' } } });

    const previous: SessionRecord = {
      objectId: 'co-prev',
      sessionId: 'uuid-prev',
      conversationKey,
      channel: 'C',
      channelName: 'general',
      conversationType: 'channel',
      threadTs: 't',
      messageTs: 'm',
      teamId: 'T',
      userId: 'U',
      userName: 'Alice',
      userEmail: 'a@x.com',
      botUserId: 'UBOT',
      devrevUserId: 'du-1',
      devrevConversationId: '',
      tempMessageTs: '',
      status: 'active',
      generation: 2,
      previousSessionId: 'uuid-grand',
      endReason: '',
      messageCount: 4,
      createdAt: Date.now() - 1000,
      lastUsedAt: Date.now() - 500,
      expiresAt: Date.now() + 1000,
      hardExpiresAt: Date.now() + timing.absoluteTtlMs,
    };

    const next = await rotateSession(config, previous, 'absolute_timeout', {}, timing, {
      devrevUserId: 'du-1',
      userEmail: 'a@x.com',
    });

    expect(next.generation).toBe(3);
    expect(next.previousSessionId).toBe('uuid-prev');
    expect(next.sessionId).not.toBe('uuid-prev');
    expect(next.conversationKey).toBe(conversationKey);

    const [endCall, createCall] = mockedAxios.post.mock.calls;
    expect(endCall[0]).toContain('/custom-objects.update');
    expect((endCall[1] as any).custom_fields[SESSION_FIELD.status]).toBe('expired');
    expect((endCall[1] as any).custom_fields[SESSION_FIELD.endReason]).toBe('absolute_timeout');
    expect(createCall[0]).toContain('/custom-objects.create');
    expect((createCall[1] as any).custom_fields[SESSION_FIELD.previousSessionId]).toBe('uuid-prev');
    expect((createCall[1] as any).custom_fields[SESSION_FIELD.generation]).toBe(3);
  });

  test('deleteSession calls /custom-objects.delete with the cached objectId', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });
    const record: SessionRecord = {
      objectId: 'co-del',
      sessionId: 'uuid-del',
      conversationKey,
      channel: '',
      channelName: '',
      conversationType: '',
      threadTs: '',
      messageTs: '',
      teamId: '',
      userId: '',
      userName: '',
      userEmail: '',
      botUserId: '',
      devrevUserId: '',
      devrevConversationId: '',
      tempMessageTs: '',
      status: 'expired',
      generation: 0,
      previousSessionId: '',
      endReason: 'absolute_timeout',
      messageCount: 0,
      createdAt: 0,
      lastUsedAt: 0,
      expiresAt: 0,
      hardExpiresAt: 0,
    };
    await deleteSession(config, record);
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toContain('/custom-objects.delete');
    expect((body as any).id).toBe('co-del');
  });

  test('isSessionExpired returns absolute_timeout when hardExpiresAt elapsed', () => {
    const past = Date.now() - 1000;
    const record: SessionRecord = {
      objectId: '',
      sessionId: '',
      conversationKey: '',
      channel: '',
      channelName: '',
      conversationType: '',
      threadTs: '',
      messageTs: '',
      teamId: '',
      userId: '',
      userName: '',
      userEmail: '',
      botUserId: '',
      devrevUserId: '',
      devrevConversationId: '',
      tempMessageTs: '',
      status: 'active',
      generation: 0,
      previousSessionId: '',
      endReason: '',
      messageCount: 0,
      createdAt: 0,
      lastUsedAt: 0,
      expiresAt: past - 1000,
      hardExpiresAt: past,
    };
    expect(isSessionExpired(record)).toBe('absolute_timeout');

    record.hardExpiresAt = Date.now() + 60_000;
    expect(isSessionExpired(record)).toBe('idle_timeout');

    record.expiresAt = Date.now() + 60_000;
    expect(isSessionExpired(record)).toBeNull();
  });

  test('getActiveSession lists records, filters by conversationKey + status=active, picks latest', async () => {
    const stale = {
      id: 'co-old',
      unique_key: 'slack_ai_session_uuid-old',
      custom_fields: fieldsForRecord({
        sessionId: 'uuid-old',
        status: 'active',
        lastUsedAt: 100,
      }),
    };
    const recent = {
      id: 'co-new',
      unique_key: 'slack_ai_session_uuid-new',
      custom_fields: fieldsForRecord({
        sessionId: 'uuid-new',
        status: 'active',
        lastUsedAt: 9_999_999_999_999,
      }),
    };
    const wrongKey = {
      id: 'co-wrong',
      unique_key: 'slack_ai_session_uuid-wrong',
      custom_fields: fieldsForRecord({
        sessionId: 'uuid-wrong',
        status: 'active',
        conversationKey: 'different-key',
      }),
    };
    const ended = {
      id: 'co-ended',
      unique_key: 'slack_ai_session_uuid-ended',
      custom_fields: fieldsForRecord({ sessionId: 'uuid-ended', status: 'ended' }),
    };

    mockedAxios.post.mockResolvedValueOnce({ data: { result: [stale, recent, wrongKey, ended] } });
    const found = await getActiveSession(config, conversationKey);
    expect(found?.sessionId).toBe('uuid-new');
  });

  test('getActiveSession returns null when no active record matches', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { result: [] } });
    expect(await getActiveSession(config, conversationKey)).toBeNull();
  });

  test('getSessionById hits /custom-objects.list to find by unique_key when not cached', async () => {
    const co = {
      id: 'co-by-id',
      unique_key: 'slack_ai_session_uuid-x',
      custom_fields: fieldsForRecord({ sessionId: 'uuid-x' }),
    };
    mockedAxios.post.mockResolvedValueOnce({ data: { result: [co] } });
    const r = await getSessionById(config, 'uuid-x');
    expect(r?.sessionId).toBe('uuid-x');
    expect(mockedAxios.post.mock.calls[0][0]).toContain('/custom-objects.list');
  });

  test('getSessionByDevrevConversationId filters by devrev_conversation_id', async () => {
    const matching = {
      id: 'co-match',
      unique_key: 'slack_ai_session_uuid-match',
      custom_fields: fieldsForRecord({
        sessionId: 'uuid-match',
        devrevConversationId: 'don:core:dvrv-us-1:devo/x:conversation/123',
      }),
    };
    const other = {
      id: 'co-other',
      unique_key: 'slack_ai_session_uuid-other',
      custom_fields: fieldsForRecord({ sessionId: 'uuid-other' }),
    };
    mockedAxios.post.mockResolvedValueOnce({ data: { result: [other, matching] } });
    const r = await getSessionByDevrevConversationId(
      config,
      'don:core:dvrv-us-1:devo/x:conversation/123'
    );
    expect(r?.sessionId).toBe('uuid-match');
  });

  test('listIdleExpiredSessions returns active rows whose idle TTL elapsed but not absolute', async () => {
    const past = Date.now() - 60_000;
    const future = Date.now() + 60_000;
    const idle = {
      id: 'co-idle',
      unique_key: 'slack_ai_session_uuid-idle',
      custom_fields: fieldsForRecord({
        sessionId: 'uuid-idle',
        status: 'active',
        expiresAt: past,
        hardExpiresAt: future,
      }),
    };
    const fresh = {
      id: 'co-fresh',
      unique_key: 'slack_ai_session_uuid-fresh',
      custom_fields: fieldsForRecord({
        sessionId: 'uuid-fresh',
        status: 'active',
        expiresAt: future,
        hardExpiresAt: future + 60_000,
      }),
    };
    const inactive = {
      id: 'co-inactive',
      unique_key: 'slack_ai_session_uuid-inactive',
      custom_fields: fieldsForRecord({
        sessionId: 'uuid-inactive',
        status: 'expired',
        expiresAt: past,
        hardExpiresAt: future,
      }),
    };
    mockedAxios.post.mockResolvedValueOnce({ data: { result: [idle, fresh, inactive] } });
    const res = await listIdleExpiredSessions(config);
    expect(res).toHaveLength(1);
    expect(res[0].sessionId).toBe('uuid-idle');
  });

  test('listHardExpiredSessions returns rows whose hard TTL elapsed regardless of status', async () => {
    const past = Date.now() - 60_000;
    const future = Date.now() + 60_000;
    const hardActive = {
      id: 'co-hard-a',
      unique_key: 'slack_ai_session_uuid-hard-a',
      custom_fields: fieldsForRecord({
        sessionId: 'uuid-hard-a',
        status: 'active',
        hardExpiresAt: past,
      }),
    };
    const hardExpired = {
      id: 'co-hard-e',
      unique_key: 'slack_ai_session_uuid-hard-e',
      custom_fields: fieldsForRecord({
        sessionId: 'uuid-hard-e',
        status: 'expired',
        hardExpiresAt: past - 1000,
      }),
    };
    const fresh = {
      id: 'co-fresh',
      unique_key: 'slack_ai_session_uuid-fresh',
      custom_fields: fieldsForRecord({
        sessionId: 'uuid-fresh',
        status: 'active',
        hardExpiresAt: future,
      }),
    };
    mockedAxios.post.mockResolvedValueOnce({ data: { result: [hardActive, hardExpired, fresh] } });
    const res = await listHardExpiredSessions(config);
    expect(res.map((r) => r.sessionId).sort()).toEqual(['uuid-hard-a', 'uuid-hard-e']);
  });

  test('recordToConversationReference maps SessionRecord to ConversationReference shape', () => {
    const record: SessionRecord = {
      objectId: 'co-x',
      sessionId: 'uuid-x',
      conversationKey,
      channel: 'C0123456789',
      channelName: 'general',
      conversationType: 'channel',
      threadTs: 't',
      messageTs: 'm',
      teamId: 'T0123456789',
      userId: 'U0123456789',
      userName: 'Alice',
      userEmail: 'a@x.com',
      botUserId: 'UBOT',
      devrevUserId: 'du-1',
      devrevConversationId: '',
      tempMessageTs: 'temp',
      status: 'active',
      generation: 0,
      previousSessionId: '',
      endReason: '',
      messageCount: 0,
      createdAt: 1700000000000,
      lastUsedAt: 1700000001000,
      expiresAt: 0,
      hardExpiresAt: 0,
    };
    const ref = recordToConversationReference(record);
    expect(ref.channel).toBe('C0123456789');
    expect(ref.channelName).toBe('general');
    expect(ref.userId).toBe('U0123456789');
    expect(ref.userEmail).toBe('a@x.com');
    expect(ref.tempMessageTs).toBe('temp');
    expect(ref.timestamp).toBe(1700000000000);
  });

  test('returns null when store is not configured', async () => {
    const result = await getSessionById(
      { devrevEndpoint: '', serviceAccountToken: '' },
      'uuid-z'
    );
    expect(result).toBeNull();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});
