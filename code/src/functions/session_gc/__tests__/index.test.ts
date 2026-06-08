import { FunctionInput } from '../../../types';
import * as sessionStore from '../../../utils/session-store';
import { SessionRecord } from '../../../utils/session-store';
import { run } from '../index';

jest.mock('../../../utils/session-store');
const mockedSessionStore = sessionStore as jest.Mocked<typeof sessionStore>;

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    botUserId: '',
    channel: 'C',
    channelName: '',
    conversationKey: 'ck',
    conversationType: '',
    createdAt: 0,
    devrevUserId: '',
    endReason: '',
    expiresAt: 0,
    feedbackRating: 0,
    feedbackSubmittedAt: 0,
    feedbackText: '',
    generation: 0,
    hardExpiresAt: 0,
    lastDeliveredTurn: 0,
    lastUsedAt: 0,
    messageCount: 0,
    messageTs: '',
    objectId: 'co-1',
    previousSessionId: '',
    sessionId: 'uuid-1',
    status: 'active',
    teamId: '',
    tempMessageTs: '',
    threadTs: '',
    userEmail: '',
    userId: 'U',
    userName: '',
    ...overrides,
  };
}

const mockEvent: FunctionInput = {
  context: {
    dev_oid: 'dev-1',
    secrets: { service_account_token: 'svc-token' },
    service_account_id: 'svc-1',
    snap_in_id: 'snap-1',
    snap_in_version_id: 'ver-1',
    source_id: 'source-1',
  },
  execution_metadata: {
    devrev_endpoint: 'https://api.devrev.ai',
    event_type: 'timer.tick',
    function_name: 'session_gc',
    request_id: 'req-gc',
  },
  input_data: {
    event_sources: {},
    global_values: { ai_agent_id: '' },
    keyrings: {},
  },
  payload: { event_key: 'session-gc-tick' },
};

describe('session_gc', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSessionStore.listIdleExpiredSessions.mockResolvedValue([]);
    mockedSessionStore.listHardExpiredSessions.mockResolvedValue([]);
    mockedSessionStore.endSession.mockResolvedValue({} as any);
    mockedSessionStore.deleteSession.mockResolvedValue(undefined);
  });

  test('idle pass marks idle-expired sessions', async () => {
    const idle = makeRecord({ sessionId: 'uuid-idle', status: 'active' });
    mockedSessionStore.listIdleExpiredSessions.mockResolvedValue([idle]);

    const result = await run([mockEvent]);

    expect(mockedSessionStore.endSession).toHaveBeenCalledWith(expect.anything(), idle, 'idle_timeout');
    expect(mockedSessionStore.deleteSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({ idle_marked: 1, sessions_deleted: 0, status: 'success' });
  });

  test('hard pass deletes records past absolute timeout', async () => {
    const hard = makeRecord({
      endReason: 'idle_timeout',
      objectId: 'co-hard',
      sessionId: 'uuid-hard',
      status: 'expired',
    });
    mockedSessionStore.listHardExpiredSessions.mockResolvedValue([hard]);

    const result = await run([mockEvent]);

    expect(mockedSessionStore.deleteSession).toHaveBeenCalledWith(expect.anything(), hard);
    expect(result).toMatchObject({ idle_marked: 0, sessions_deleted: 1, status: 'success' });
  });

  test('runs both passes in one tick', async () => {
    const idle = makeRecord({ sessionId: 'uuid-idle' });
    const hard = makeRecord({ objectId: 'co-hard', sessionId: 'uuid-hard' });
    mockedSessionStore.listIdleExpiredSessions.mockResolvedValue([idle]);
    mockedSessionStore.listHardExpiredSessions.mockResolvedValue([hard]);

    const result = await run([mockEvent]);

    expect(mockedSessionStore.endSession).toHaveBeenCalledTimes(1);
    expect(mockedSessionStore.deleteSession).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ idle_marked: 1, sessions_deleted: 1, status: 'success' });
  });

  test('skips hard-expired records with no objectId (cannot delete)', async () => {
    const orphan = makeRecord({ objectId: '', sessionId: 'uuid-orphan' });
    mockedSessionStore.listHardExpiredSessions.mockResolvedValue([orphan]);

    const result = await run([mockEvent]);

    expect(mockedSessionStore.deleteSession).not.toHaveBeenCalled();
    expect(result.sessions_deleted).toBe(0);
  });

  test('returns success with zero counts when there is nothing to do', async () => {
    const result = await run([mockEvent]);
    expect(result).toMatchObject({ idle_marked: 0, sessions_deleted: 0, status: 'success' });
  });

  test('returns error when devrev config is missing', async () => {
    const event = {
      ...mockEvent,
      context: { ...mockEvent.context, secrets: { service_account_token: '' } },
      execution_metadata: { ...mockEvent.execution_metadata, devrev_endpoint: '' },
    };
    const result = await run([event]);
    expect(result.status).toBe('error');
    expect(result.reason).toContain('missing');
    expect(mockedSessionStore.listIdleExpiredSessions).not.toHaveBeenCalled();
  });
});
