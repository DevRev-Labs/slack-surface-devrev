import axios from 'axios';
import {
  storeConversationReference,
  getConversationReference,
  removeConversationReference,
  StoreConfig,
  _resetSessionStoreCaches,
} from '../session-store';
import { SESSION_FIELD } from '../session-fields';
import { ConversationReference } from '../conversation-store';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const config: StoreConfig = {
  devrevEndpoint: 'https://api.devrev.ai',
  serviceAccountToken: 'svc-token',
  timing: {
    idleTtlMs: 60 * 60 * 1000,           // 1h
    absoluteTtlMs: 24 * 60 * 60 * 1000,  // 24h
  },
};

const ref: ConversationReference = {
  channel: 'C0123456789',
  channelName: 'general',
  conversationType: 'channel',
  userId: 'U0123456789',
  userName: 'Alice',
  userEmail: 'alice@example.com',
  threadTs: '1705315799.000050',
  messageTs: '1705315800.000100',
  teamId: 'T0123456789',
  botUserId: 'UBOT00000',
  devrevUserId: 'don:identity:dvrv-us-1:devo/x:devu/y',
  timestamp: 1700000000000,
  tempMessageTs: '1705315801.000200',
};

describe('session-store', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetSessionStoreCaches();
  });

  test('storeConversationReference creates a new custom object with full identity payload', async () => {
    // First call: list (no match). Second: create.
    mockedAxios.post
      .mockResolvedValueOnce({ data: { result: [] } })
      .mockResolvedValueOnce({ data: { custom_object: { id: 'co-1' } } });

    await storeConversationReference(config, 'session-1', ref);

    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    const [listCall, createCall] = mockedAxios.post.mock.calls;
    expect(listCall[0]).toContain('/custom-objects.list');
    expect(createCall[0]).toContain('/custom-objects.create');
    const createBody = createCall[1] as any;
    expect(createBody.leaf_type).toBe('slack_ai_session');
    expect(createBody.unique_key).toBe('slack_ai_session_session-1');
    // Title is human-readable: "<email|name|user> — <channel> — <iso>"
    expect(createBody.title).toContain('alice@example.com');
    expect(createBody.title).toContain('general');
    // Identity fields are persisted.
    const fields = createBody.custom_fields;
    expect(fields[SESSION_FIELD.sessionId]).toBe('session-1');
    expect(fields[SESSION_FIELD.channel]).toBe('C0123456789');
    expect(fields[SESSION_FIELD.channelName]).toBe('general');
    expect(fields[SESSION_FIELD.conversationType]).toBe('channel');
    expect(fields[SESSION_FIELD.userId]).toBe('U0123456789');
    expect(fields[SESSION_FIELD.userName]).toBe('Alice');
    expect(fields[SESSION_FIELD.userEmail]).toBe('alice@example.com');
    expect(fields[SESSION_FIELD.botUserId]).toBe('UBOT00000');
    expect(fields[SESSION_FIELD.devrevUserId]).toBe('don:identity:dvrv-us-1:devo/x:devu/y');
    expect(fields[SESSION_FIELD.tempMessageTs]).toBe('1705315801.000200');
    // Lifecycle defaults on first write.
    expect(fields[SESSION_FIELD.status]).toBe('active');
    expect(fields[SESSION_FIELD.generation]).toBe(0);
    expect(fields[SESSION_FIELD.messageCount]).toBe(1);
    // Expiry timestamps populated from timing.
    expect(typeof fields[SESSION_FIELD.expiresAtMs]).toBe('string');
    expect(typeof fields[SESSION_FIELD.hardExpiresAtMs]).toBe('string');
    expect(createBody.custom_schema_spec).toEqual({ tenant_fragment: true });
  });

  test('storeConversationReference updates existing object and increments message_count', async () => {
    // Initial create
    mockedAxios.post
      .mockResolvedValueOnce({ data: { result: [] } })
      .mockResolvedValueOnce({ data: { custom_object: { id: 'co-2' } } });
    await storeConversationReference(config, 'session-2', ref);

    mockedAxios.post.mockClear();

    // Second store: cached id resolved via custom-objects.get → update.
    // The get returns a payload that already records message_count = 1.
    const existingFields = {
      [SESSION_FIELD.sessionId]: 'session-2',
      [SESSION_FIELD.status]: 'active',
      [SESSION_FIELD.generation]: 0,
      [SESSION_FIELD.messageCount]: 1,
      [SESSION_FIELD.createdAtMs]: new Date(1700000000000).toISOString(),
    };
    mockedAxios.post
      .mockResolvedValueOnce({ data: { custom_object: { id: 'co-2', custom_fields: existingFields } } })
      .mockResolvedValueOnce({ data: { custom_object: { id: 'co-2' } } });

    await storeConversationReference(config, 'session-2', { ...ref, tempMessageTs: 'new-ts' });

    const [getCall, updateCall] = mockedAxios.post.mock.calls;
    expect(getCall[0]).toContain('/custom-objects.get');
    expect(updateCall[0]).toContain('/custom-objects.update');
    const updateBody = updateCall[1] as any;
    expect(updateBody.custom_fields[SESSION_FIELD.tempMessageTs]).toBe('new-ts');
    // message_count rolls forward.
    expect(updateBody.custom_fields[SESSION_FIELD.messageCount]).toBe(2);
    // session_id is immutable — must be omitted from update payloads.
    expect(updateBody.custom_fields[SESSION_FIELD.sessionId]).toBeUndefined();
  });

  test('getConversationReference returns undefined when nothing matches', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { result: [] } });
    const result = await getConversationReference(config, 'missing-session');
    expect(result).toBeUndefined();
  });

  test('getConversationReference decodes a stored custom object', async () => {
    const co = {
      id: 'co-3',
      unique_key: 'slack_ai_session_session-3',
      custom_fields: {
        [SESSION_FIELD.sessionId]: 'session-3',
        [SESSION_FIELD.channel]: 'C0123456789',
        [SESSION_FIELD.channelName]: 'general',
        [SESSION_FIELD.conversationType]: 'channel',
        [SESSION_FIELD.userId]: 'U0123456789',
        [SESSION_FIELD.userName]: 'Alice',
        [SESSION_FIELD.userEmail]: 'alice@example.com',
        [SESSION_FIELD.botUserId]: 'UBOT00000',
        [SESSION_FIELD.devrevUserId]: 'don:identity:dvrv-us-1:devo/x:devu/y',
        [SESSION_FIELD.threadTs]: '1705315799.000050',
        [SESSION_FIELD.messageTs]: '1705315800.000100',
        [SESSION_FIELD.teamId]: 'T0123456789',
        [SESSION_FIELD.tempMessageTs]: '1705315801.000200',
        [SESSION_FIELD.createdAtMs]: new Date(1700000000000).toISOString(),
      },
    };
    mockedAxios.post.mockResolvedValueOnce({ data: { result: [co] } });

    const result = await getConversationReference(config, 'session-3');
    expect(result).toEqual({
      channel: 'C0123456789',
      channelName: 'general',
      conversationType: 'channel',
      userId: 'U0123456789',
      userName: 'Alice',
      userEmail: 'alice@example.com',
      botUserId: 'UBOT00000',
      devrevUserId: 'don:identity:dvrv-us-1:devo/x:devu/y',
      threadTs: '1705315799.000050',
      messageTs: '1705315800.000100',
      teamId: 'T0123456789',
      tempMessageTs: '1705315801.000200',
      timestamp: 1700000000000,
    });
  });

  test('removeConversationReference deletes the located object', async () => {
    const co = {
      id: 'co-4',
      unique_key: 'slack_ai_session_session-4',
      custom_fields: { [SESSION_FIELD.sessionId]: 'session-4' },
    };
    mockedAxios.post
      .mockResolvedValueOnce({ data: { result: [co] } })
      .mockResolvedValueOnce({ data: {} });

    await removeConversationReference(config, 'session-4');

    const [, deleteCall] = mockedAxios.post.mock.calls;
    expect(deleteCall[0]).toContain('/custom-objects.delete');
    expect((deleteCall[1] as any).id).toBe('co-4');
  });

  test('returns undefined when store is not configured', async () => {
    const result = await getConversationReference(
      { devrevEndpoint: '', serviceAccountToken: '' },
      'session-5'
    );
    expect(result).toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});
