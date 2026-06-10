import axios from 'axios';
import { SESSION_FIELD } from '../session-fields';
import {
  buildConversationKey,
  createSession,
  deleteSession,
  endSession,
  getActiveSession,
  getSessionByConversationId,
  getSessionById,
  isSessionExpired,
  listHardExpiredSessions,
  listIdleExpiredSessions,
  patchSession,
  recordToConversationReference,
  rotateSession,
  SessionRecord,
  StoreConfig,
  touchSession,
  _resetSessionStoreCaches,
} from '../session-store';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../devrev-auth', () => ({
  findUserByEmail: jest.fn(),
  getOrCreateActAsToken: jest.fn().mockResolvedValue(null),
}));

const timing = {
  // 1h
  absoluteTtlMs: 24 * 60 * 60 * 1000,
  idleTtlMs: 60 * 60 * 1000, // 24h
};

const config: StoreConfig = {
  devrevEndpoint: 'https://api.devrev.ai',
  serviceAccountToken: 'svc-token',
  timing,
};

const conversationKey = buildConversationKey('C0123456789', '1705315799.000050', 'U0123456789');

const identity = {
  botUserId: 'UBOT00000',
  channel: 'C0123456789',
  channelName: 'general',
  conversationKey,
  conversationType: 'channel',
  messageTs: '1705315800.000100',
  teamId: 'T0123456789',
  threadTs: '1705315799.000050',
  userId: 'U0123456789',
  userName: 'Alice',
};

interface FieldsOverrides {
  sessionId?: string;
  conversationKey?: string;
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
    [SESSION_FIELD.tempMessageTs]: overrides.tempMessageTs ?? '',
    [SESSION_FIELD.status]: overrides.status || 'active',
    [SESSION_FIELD.generation]: overrides.generation ?? 0,
    [SESSION_FIELD.previousSessionId]: overrides.previousSessionId ?? '',
    [SESSION_FIELD.endReason]: overrides.endReason ?? '',
    [SESSION_FIELD.messageCount]: overrides.messageCount ?? 0,
    [SESSION_FIELD.createdAtMs]: new Date(overrides.createdAt ?? now).toISOString(),
    [SESSION_FIELD.lastUsedAtMs]: new Date(overrides.lastUsedAt ?? now).toISOString(),
    [SESSION_FIELD.expiresAtMs]: new Date(overrides.expiresAt ?? now + timing.idleTtlMs).toISOString(),
    [SESSION_FIELD.hardExpiresAtMs]: new Date(overrides.hardExpiresAt ?? now + timing.absoluteTtlMs).toISOString(),
  };
}

function emptyRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    botUserId: '',
    channel: '',
    channelName: '',
    conversationKey,
    conversationType: '',
    createdAt: 0,
    devrevUserId: '',
    endReason: '',
    expiresAt: 0,
    feedbackPromptTs: '',
    feedbackRating: 0,
    feedbackSubmittedAt: 0,
    feedbackText: '',
    generation: 0,
    hardExpiresAt: 0,
    lastDeliveredTurn: 0,
    lastUsedAt: 0,
    messageCount: 0,
    messageTs: '',
    objectId: '',
    previousSessionId: '',
    sessionId: '',
    status: 'active',
    teamId: '',
    tempMessageTs: '',
    threadTs: '',
    userEmail: '',
    userId: '',
    userName: '',
    ...overrides,
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

  test('createSession writes a conversation with active status, gen=0, full TTL window', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { conversation: { id: 'conv-create' } } });
    const record = await createSession(config, { devrevUserId: 'du-1', identity, userEmail: 'a@x.com' });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toContain('/conversations.create');
    const create = body as any;
    expect(create.type).toBe('support');
    expect(create.custom_schema_spec).toEqual({ tenant_fragment: true, validate_required_fields: true });
    expect(create.custom_fields[SESSION_FIELD.sessionId]).toBe(record.sessionId);
    expect(create.custom_fields[SESSION_FIELD.conversationKey]).toBe(conversationKey);
    expect(create.custom_fields[SESSION_FIELD.status]).toBe('active');
    expect(create.custom_fields[SESSION_FIELD.generation]).toBe(0);
    expect(create.custom_fields[SESSION_FIELD.userEmail]).toBe('a@x.com');
    expect(create.custom_fields[SESSION_FIELD.devrevUserId]).toBe('du-1');
    expect(create.members).toEqual(['du-1']);
    expect(create.owned_by).toEqual(['du-1']);
    expect(record.status).toBe('active');
    expect(record.generation).toBe(0);
    expect(record.objectId).toBe('conv-create');
  });

  test('touchSession rolls TTLs forward, increments messageCount, omits immutable session_id', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });
    const record = emptyRecord({
      botUserId: 'UBOT',
      channel: 'C',
      channelName: 'general',
      conversationType: 'channel',
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() - 60_000,
      hardExpiresAt: Date.now() + timing.absoluteTtlMs,
      lastUsedAt: Date.now() - 60_000,
      messageCount: 3,
      messageTs: 'm',
      objectId: 'conv-touch',
      sessionId: 'uuid-touch',
      teamId: 'T',
      threadTs: 't',
      userId: 'U',
      userName: 'Alice',
    });

    const updated = await touchSession(config, record, timing, {
      tempMessageTs: 'new-temp',
    });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toContain('/conversations.update');
    const update = body as any;
    expect(update.id).toBe('conv-touch');
    expect(update.custom_fields[SESSION_FIELD.sessionId]).toBeUndefined();
    expect(update.custom_fields[SESSION_FIELD.tempMessageTs]).toBe('new-temp');
    expect(update.custom_fields[SESSION_FIELD.messageCount]).toBe(4);
    expect(updated.messageCount).toBe(4);
    expect(updated.expiresAt).toBeGreaterThan(record.expiresAt);
  });

  test('patchSession applies routing patch without rolling TTLs or messageCount', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });
    const baseExpiry = Date.now() + 30_000;
    const record = emptyRecord({
      channel: 'C',
      createdAt: Date.now(),
      expiresAt: baseExpiry,
      hardExpiresAt: baseExpiry + 60_000,
      lastUsedAt: Date.now(),
      messageCount: 5,
      objectId: 'conv-p',
      sessionId: 'uuid-p',
      tempMessageTs: 'old',
      userId: 'U',
    });

    const updated = await patchSession(config, record, { tempMessageTs: null });
    expect(updated.tempMessageTs).toBe('');
    expect(updated.messageCount).toBe(5);
    expect(updated.expiresAt).toBe(baseExpiry);
  });

  test('endSession flips active → expired with idle_timeout, sets endReason', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });
    const record = emptyRecord({
      channel: 'C',
      createdAt: Date.now(),
      expiresAt: Date.now(),
      generation: 1,
      hardExpiresAt: Date.now() + 60_000,
      lastUsedAt: Date.now(),
      messageCount: 2,
      objectId: 'conv-end',
      previousSessionId: 'uuid-prev',
      sessionId: 'uuid-end',
      userId: 'U',
    });

    const updated = await endSession(config, record, 'idle_timeout');
    expect(updated.status).toBe('expired');
    expect(updated.endReason).toBe('idle_timeout');

    mockedAxios.post.mockResolvedValueOnce({ data: {} });
    const updated2 = await endSession(config, { ...record, status: 'active' }, 'user_reset');
    expect(updated2.status).toBe('ended');
    expect(updated2.endReason).toBe('user_reset');
  });

  test('rotateSession ends previous and creates new with gen+1 + previousSessionId linkage', async () => {
    // endSession update + createSession create
    mockedAxios.post
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { conversation: { id: 'conv-new' } } });

    const previous = emptyRecord({
      botUserId: 'UBOT',
      channel: 'C',
      channelName: 'general',
      conversationType: 'channel',
      createdAt: Date.now() - 1000,
      devrevUserId: 'du-1',
      expiresAt: Date.now() + 1000,
      generation: 2,
      hardExpiresAt: Date.now() + timing.absoluteTtlMs,
      lastUsedAt: Date.now() - 500,
      messageCount: 4,
      messageTs: 'm',
      objectId: 'conv-prev',
      previousSessionId: 'uuid-grand',
      sessionId: 'uuid-prev',
      teamId: 'T',
      threadTs: 't',
      userEmail: 'a@x.com',
      userId: 'U',
      userName: 'Alice',
    });

    const next = await rotateSession(config, previous, 'absolute_timeout', {}, timing, {
      devrevUserId: 'du-1',
      userEmail: 'a@x.com',
    });

    expect(next.generation).toBe(3);
    expect(next.previousSessionId).toBe('uuid-prev');
    expect(next.sessionId).not.toBe('uuid-prev');
    expect(next.conversationKey).toBe(conversationKey);

    const [endCall, createCall] = mockedAxios.post.mock.calls;
    expect(endCall[0]).toContain('/conversations.update');
    expect((endCall[1] as any).custom_fields[SESSION_FIELD.status]).toBe('expired');
    expect((endCall[1] as any).custom_fields[SESSION_FIELD.endReason]).toBe('absolute_timeout');
    expect(createCall[0]).toContain('/conversations.create');
    expect((createCall[1] as any).custom_fields[SESSION_FIELD.previousSessionId]).toBe('uuid-prev');
    expect((createCall[1] as any).custom_fields[SESSION_FIELD.generation]).toBe(3);
  });

  test('deleteSession calls /conversations.delete with the cached objectId', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });
    const record = emptyRecord({
      endReason: 'absolute_timeout',
      objectId: 'conv-del',
      sessionId: 'uuid-del',
      status: 'expired',
    });
    await deleteSession(config, record);
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toContain('/conversations.delete');
    expect((body as any).id).toBe('conv-del');
  });

  test('isSessionExpired returns absolute_timeout when hardExpiresAt elapsed', () => {
    const past = Date.now() - 1000;
    const record = emptyRecord({
      expiresAt: past - 1000,
      hardExpiresAt: past,
    });
    expect(isSessionExpired(record)).toBe('absolute_timeout');

    record.hardExpiresAt = Date.now() + 60_000;
    expect(isSessionExpired(record)).toBe('idle_timeout');

    record.expiresAt = Date.now() + 60_000;
    expect(isSessionExpired(record)).toBeNull();
  });

  test('getActiveSession lists conversations, filters by conversationKey + status=active, picks latest', async () => {
    const stale = {
      custom_fields: fieldsForRecord({
        lastUsedAt: 100,
        sessionId: 'uuid-old',
        status: 'active',
      }),
      id: 'conv-old',
    };
    const recent = {
      custom_fields: fieldsForRecord({
        lastUsedAt: 9_999_999_999_999,
        sessionId: 'uuid-new',
        status: 'active',
      }),
      id: 'conv-new',
    };
    const wrongKey = {
      custom_fields: fieldsForRecord({
        conversationKey: 'different-key',
        sessionId: 'uuid-wrong',
        status: 'active',
      }),
      id: 'conv-wrong',
    };
    const ended = {
      custom_fields: fieldsForRecord({ sessionId: 'uuid-ended', status: 'ended' }),
      id: 'conv-ended',
    };

    mockedAxios.post.mockResolvedValueOnce({ data: { conversations: [stale, recent, wrongKey, ended] } });
    const found = await getActiveSession(config, conversationKey);
    expect(found?.sessionId).toBe('uuid-new');
  });

  test('getActiveSession returns null when no active record matches', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { conversations: [] } });
    expect(await getActiveSession(config, conversationKey)).toBeNull();
  });

  test('getSessionById hits /conversations.list to find by tnt__session_id when not cached', async () => {
    const conv = {
      custom_fields: fieldsForRecord({ sessionId: 'uuid-x' }),
      id: 'conv-by-id',
    };
    mockedAxios.post.mockResolvedValueOnce({ data: { conversations: [conv] } });
    const r = await getSessionById(config, 'uuid-x');
    expect(r?.sessionId).toBe('uuid-x');
    expect(mockedAxios.post.mock.calls[0][0]).toContain('/conversations.list');
  });

  test('getSessionByConversationId hits /conversations.get with the DON', async () => {
    const matching = {
      custom_fields: fieldsForRecord({
        sessionId: 'uuid-match',
      }),
      id: 'don:core:dvrv-us-1:devo/x:conversation/123',
    };
    mockedAxios.post.mockResolvedValueOnce({ data: { conversation: matching } });
    const r = await getSessionByConversationId(config, 'don:core:dvrv-us-1:devo/x:conversation/123');
    expect(r?.sessionId).toBe('uuid-match');
    expect(mockedAxios.post.mock.calls[0][0]).toContain('/conversations.get');
    expect((mockedAxios.post.mock.calls[0][1] as any).id).toBe('don:core:dvrv-us-1:devo/x:conversation/123');
  });

  test('listIdleExpiredSessions returns active rows whose idle TTL elapsed but not absolute', async () => {
    const past = Date.now() - 60_000;
    const future = Date.now() + 60_000;
    const idle = {
      custom_fields: fieldsForRecord({
        expiresAt: past,
        hardExpiresAt: future,
        sessionId: 'uuid-idle',
        status: 'active',
      }),
      id: 'conv-idle',
    };
    const fresh = {
      custom_fields: fieldsForRecord({
        expiresAt: future,
        hardExpiresAt: future + 60_000,
        sessionId: 'uuid-fresh',
        status: 'active',
      }),
      id: 'conv-fresh',
    };
    const inactive = {
      custom_fields: fieldsForRecord({
        expiresAt: past,
        hardExpiresAt: future,
        sessionId: 'uuid-inactive',
        status: 'expired',
      }),
      id: 'conv-inactive',
    };
    mockedAxios.post.mockResolvedValueOnce({ data: { conversations: [idle, fresh, inactive] } });
    const res = await listIdleExpiredSessions(config);
    expect(res).toHaveLength(1);
    expect(res[0].sessionId).toBe('uuid-idle');
  });

  test('listHardExpiredSessions returns rows whose hard TTL elapsed regardless of status', async () => {
    const past = Date.now() - 60_000;
    const future = Date.now() + 60_000;
    const hardActive = {
      custom_fields: fieldsForRecord({
        hardExpiresAt: past,
        sessionId: 'uuid-hard-a',
        status: 'active',
      }),
      id: 'conv-hard-a',
    };
    const hardExpired = {
      custom_fields: fieldsForRecord({
        hardExpiresAt: past - 1000,
        sessionId: 'uuid-hard-e',
        status: 'expired',
      }),
      id: 'conv-hard-e',
    };
    const fresh = {
      custom_fields: fieldsForRecord({
        hardExpiresAt: future,
        sessionId: 'uuid-fresh',
        status: 'active',
      }),
      id: 'conv-fresh',
    };
    mockedAxios.post.mockResolvedValueOnce({ data: { conversations: [hardActive, hardExpired, fresh] } });
    const res = await listHardExpiredSessions(config);
    expect(res.map((r) => r.sessionId).sort()).toEqual(['uuid-hard-a', 'uuid-hard-e']);
  });

  test('recordToConversationReference maps SessionRecord to ConversationReference shape', () => {
    const record = emptyRecord({
      botUserId: 'UBOT',
      channel: 'C0123456789',
      channelName: 'general',
      conversationType: 'channel',
      createdAt: 1700000000000,
      devrevUserId: 'du-1',
      lastUsedAt: 1700000001000,
      messageTs: 'm',
      objectId: 'conv-x',
      sessionId: 'uuid-x',
      teamId: 'T0123456789',
      tempMessageTs: 'temp',
      threadTs: 't',
      userEmail: 'a@x.com',
      userId: 'U0123456789',
      userName: 'Alice',
    });
    const ref = recordToConversationReference(record);
    expect(ref.channel).toBe('C0123456789');
    expect(ref.channelName).toBe('general');
    expect(ref.userId).toBe('U0123456789');
    expect(ref.userEmail).toBe('a@x.com');
    expect(ref.tempMessageTs).toBe('temp');
    expect(ref.timestamp).toBe(1700000000000);
  });

  test('returns null when store is not configured', async () => {
    const result = await getSessionById({ devrevEndpoint: '', serviceAccountToken: '' }, 'uuid-z');
    expect(result).toBeNull();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});
