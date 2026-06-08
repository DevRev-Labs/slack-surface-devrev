import { run } from '../index';
import * as sessionStore from '../../../utils/session-store';
import { FunctionInput } from '../../../types';
import { SessionRecord } from '../../../utils/session-store';

jest.mock('../../../utils/session-store');
const mockedSessionStore = sessionStore as jest.Mocked<typeof sessionStore>;

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    objectId: 'co-1',
    sessionId: 'uuid-1',
    conversationKey: 'ck',
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
    tempMessageTs: '',
    status: 'active',
    generation: 0,
    previousSessionId: '',
    endReason: '',
    messageCount: 0,
    createdAt: 0,
    lastUsedAt: 0,
    expiresAt: 0,
    hardExpiresAt: 0,
    feedbackRating: 0,
    feedbackText: '',
    feedbackSubmittedAt: 0,
    lastDeliveredTurn: 0,
    ...overrides,
  };
}

const mockEvent: FunctionInput = {
  payload: { event_key: 'session-gc-tick' },
  execution_metadata: {
    request_id: 'req-gc',
    devrev_endpoint: 'https://api.devrev.ai',
    function_name: 'session_gc',
    event_type: 'timer.tick',
  },
  input_data: {
    global_values: { ai_agent_id: '' },
    event_sources: {},
    keyrings: {},
  },
  context: {
    dev_oid: 'dev-1',
    source_id: 'source-1',
    snap_in_id: 'snap-1',
    snap_in_version_id: 'ver-1',
    service_account_id: 'svc-1',
    secrets: { service_account_token: 'svc-token' },
  },
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

    expect(mockedSessionStore.endSession).toHaveBeenCalledWith(
      expect.anything(),
      idle,
      'idle_timeout'
    );
    expect(mockedSessionStore.deleteSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'success', idle_marked: 1, sessions_deleted: 0 });
  });

  test('hard pass deletes records past absolute timeout', async () => {
    const hard = makeRecord({
      objectId: 'co-hard',
      sessionId: 'uuid-hard',
      status: 'expired',
      endReason: 'idle_timeout',
    });
    mockedSessionStore.listHardExpiredSessions.mockResolvedValue([hard]);

    const result = await run([mockEvent]);

    expect(mockedSessionStore.deleteSession).toHaveBeenCalledWith(expect.anything(), hard);
    expect(result).toMatchObject({ status: 'success', idle_marked: 0, sessions_deleted: 1 });
  });

  test('runs both passes in one tick', async () => {
    const idle = makeRecord({ sessionId: 'uuid-idle' });
    const hard = makeRecord({ objectId: 'co-hard', sessionId: 'uuid-hard' });
    mockedSessionStore.listIdleExpiredSessions.mockResolvedValue([idle]);
    mockedSessionStore.listHardExpiredSessions.mockResolvedValue([hard]);

    const result = await run([mockEvent]);

    expect(mockedSessionStore.endSession).toHaveBeenCalledTimes(1);
    expect(mockedSessionStore.deleteSession).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'success', idle_marked: 1, sessions_deleted: 1 });
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
    expect(result).toMatchObject({ status: 'success', idle_marked: 0, sessions_deleted: 0 });
  });

  test('returns error when devrev config is missing', async () => {
    const event = {
      ...mockEvent,
      execution_metadata: { ...mockEvent.execution_metadata, devrev_endpoint: '' },
      context: { ...mockEvent.context, secrets: { service_account_token: '' } },
    };
    const result = await run([event]);
    expect(result.status).toBe('error');
    expect(result.reason).toContain('missing');
    expect(mockedSessionStore.listIdleExpiredSessions).not.toHaveBeenCalled();
  });
});
