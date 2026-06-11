import { FunctionInput } from '../../../types';
import * as sessionStore from '../../../utils/session-store';
import { SessionRecord } from '../../../utils/session-store';
import * as slackClient from '../../../utils/slack-client';
import { run } from '../index';

jest.mock('../../../utils/session-store');
jest.mock('../../../utils/slack-client');
const mockedSessionStore = sessionStore as jest.Mocked<typeof sessionStore>;
const mockedSlackClient = slackClient as jest.Mocked<typeof slackClient>;

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
    keyrings: { slack_bot_token: 'xoxb-test' },
  },
  payload: { event_key: 'session-gc-tick' },
};

describe('session_gc', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSessionStore.listIdleExpiredSessions.mockResolvedValue([]);
    mockedSessionStore.listHardExpiredSessions.mockResolvedValue([]);
    // endSession echoes the record back so the GC has access to its
    // freshly-updated fields when deciding to post a feedback prompt.
    mockedSessionStore.endSession.mockImplementation(async (_c, r) => ({
      ...r,
      endReason: 'idle_timeout',
      status: 'expired',
    }));
    mockedSessionStore.deleteSession.mockResolvedValue(undefined);
    mockedSessionStore.patchSession.mockImplementation(async (_c, r) => r);
    mockedSlackClient.sendBlocksMessage.mockResolvedValue('prompt-ts-1');
    mockedSlackClient.deleteMessage.mockResolvedValue();
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

  test('on idle expiry: posts feedback prompt + persists its ts on the session', async () => {
    const idle = makeRecord({
      channel: 'C-idle',
      sessionId: 'uuid-idle',
      threadTs: 't-idle',
      userId: 'U-idle',
    });
    mockedSessionStore.listIdleExpiredSessions.mockResolvedValue([idle]);

    await run([mockEvent]);

    expect(mockedSlackClient.sendBlocksMessage).toHaveBeenCalledWith(
      'C-idle',
      expect.any(String),
      expect.any(Array),
      'xoxb-test',
      't-idle'
    );
    expect(mockedSessionStore.patchSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: 'uuid-idle' }),
      expect.objectContaining({ feedbackPromptTs: 'prompt-ts-1' })
    );
  });

  test('idle expiry: skips prompt when feedback already submitted', async () => {
    const idle = makeRecord({ channel: 'C', feedbackRating: 4, sessionId: 'uuid-rated' });
    mockedSessionStore.listIdleExpiredSessions.mockResolvedValue([idle]);

    await run([mockEvent]);

    expect(mockedSlackClient.sendBlocksMessage).not.toHaveBeenCalled();
  });

  test('idle expiry: skips prompt when one already exists (idempotent on re-run)', async () => {
    const idle = makeRecord({ channel: 'C', feedbackPromptTs: 'already-there', sessionId: 'uuid-pre' });
    mockedSessionStore.listIdleExpiredSessions.mockResolvedValue([idle]);

    await run([mockEvent]);

    expect(mockedSlackClient.sendBlocksMessage).not.toHaveBeenCalled();
  });

  test('hard expiry: deletes the lingering feedback prompt before nuking the session', async () => {
    const hard = makeRecord({
      channel: 'C-hard',
      feedbackPromptTs: 'prompt-old-ts',
      objectId: 'co-hard',
      sessionId: 'uuid-hard',
      status: 'expired',
    });
    mockedSessionStore.listHardExpiredSessions.mockResolvedValue([hard]);

    await run([mockEvent]);

    expect(mockedSlackClient.deleteMessage).toHaveBeenCalledWith('C-hard', 'prompt-old-ts', 'xoxb-test');
    expect(mockedSessionStore.deleteSession).toHaveBeenCalledWith(expect.anything(), hard);
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

  test('listIdleExpiredSessions failure is logged and the hard pass still runs', async () => {
    // The catch block in runGc must isolate idle-list failures so the hard
    // sweep is not blocked by them — otherwise a transient list error
    // would prevent any cleanup that tick.
    const errSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockedSessionStore.listIdleExpiredSessions.mockRejectedValueOnce(new Error('idle list down'));
    const hard = makeRecord({ objectId: 'co-h', sessionId: 'uuid-h' });
    mockedSessionStore.listHardExpiredSessions.mockResolvedValueOnce([hard]);

    const result = await run([mockEvent]);

    expect(result.status).toBe('success');
    expect(result.sessions_deleted).toBe(1);
    errSpy.mockRestore();
  });

  test('listHardExpiredSessions failure does not prevent reporting the idle pass', async () => {
    const errSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const idle = makeRecord({ sessionId: 'uuid-i' });
    mockedSessionStore.listIdleExpiredSessions.mockResolvedValueOnce([idle]);
    mockedSessionStore.listHardExpiredSessions.mockRejectedValueOnce(new Error('hard list down'));

    const result = await run([mockEvent]);

    expect(result.idle_marked).toBe(1);
    expect(result.sessions_deleted).toBe(0);
    errSpy.mockRestore();
  });

  test('endSession failure on one record does not block subsequent records', async () => {
    const errSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = makeRecord({ sessionId: 'uuid-a' });
    const b = makeRecord({ sessionId: 'uuid-b' });
    mockedSessionStore.listIdleExpiredSessions.mockResolvedValueOnce([a, b]);
    mockedSessionStore.endSession
      .mockRejectedValueOnce(new Error('boom on a'))
      .mockResolvedValueOnce({ ...b, endReason: 'idle_timeout', status: 'expired' });

    const result = await run([mockEvent]);

    // Both records were attempted; the failure on `a` did not abort the loop.
    expect(mockedSessionStore.endSession).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('success');
    errSpy.mockRestore();
  });

  test('feedback-prompt post failure is swallowed so the GC keeps running', async () => {
    const errSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const idle = makeRecord({ channel: 'C', sessionId: 'uuid-prompt-fail' });
    mockedSessionStore.listIdleExpiredSessions.mockResolvedValueOnce([idle]);
    mockedSlackClient.sendBlocksMessage.mockRejectedValueOnce(new Error('slack 500'));

    const result = await run([mockEvent]);

    // Even though prompt post failed, endSession succeeded and the GC reports
    // a healthy result — Slack is best-effort.
    expect(result.status).toBe('success');
    expect(result.idle_marked).toBe(1);
    errSpy.mockRestore();
  });

  test('skips feedback prompt when slack_bot_token is not configured', async () => {
    const idle = makeRecord({ channel: 'C', sessionId: 'uuid-no-token' });
    mockedSessionStore.listIdleExpiredSessions.mockResolvedValueOnce([idle]);
    const eventNoSlack = {
      ...mockEvent,
      input_data: { ...mockEvent.input_data, keyrings: {} },
    };

    await run([eventNoSlack]);

    expect(mockedSlackClient.sendBlocksMessage).not.toHaveBeenCalled();
  });

  test('skips feedback prompt when the session has no channel routing info', async () => {
    const idle = makeRecord({ channel: '', sessionId: 'uuid-no-channel' });
    mockedSessionStore.listIdleExpiredSessions.mockResolvedValueOnce([idle]);

    await run([mockEvent]);

    expect(mockedSlackClient.sendBlocksMessage).not.toHaveBeenCalled();
  });

  test('hard expiry: deleteMessage failure does not block the session delete', async () => {
    const errSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const hard = makeRecord({
      channel: 'C',
      feedbackPromptTs: 'old-ts',
      objectId: 'co-h',
      sessionId: 'uuid-h',
    });
    mockedSessionStore.listHardExpiredSessions.mockResolvedValueOnce([hard]);
    mockedSlackClient.deleteMessage.mockRejectedValueOnce(new Error('not found'));

    const result = await run([mockEvent]);

    expect(mockedSessionStore.deleteSession).toHaveBeenCalledWith(expect.anything(), hard);
    expect(result.sessions_deleted).toBe(1);
    errSpy.mockRestore();
  });

  test('runs across multiple events, returning per-event results when >1', async () => {
    // The default export reduces to the single result for one event but
    // returns an array when more than one is delivered in the batch.
    const result = await run([mockEvent, mockEvent]);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  test('top-level rejection inside runGc is caught and reported as error', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Force an unhandled rejection by making the first store call synchronous-throw.
    mockedSessionStore.listIdleExpiredSessions.mockImplementationOnce(() => {
      throw new Error('synchronous boom');
    });

    const result = await run([mockEvent]);

    expect(result.status).toBe('error');
    expect(typeof result.reason).toBe('string');
    errSpy.mockRestore();
  });
});
