import { run } from '../index';
import * as sessionStore from '../../../utils/session-store';
import * as slackClient from '../../../utils/slack-client';
import { FunctionInput } from '../../../types';
import { SessionRecord } from '../../../utils/session-store';

jest.mock('../../../utils/session-store');
jest.mock('../../../utils/slack-client');
jest.mock('../../../utils/timeline', () => ({
  postTimelineComment: jest.fn().mockResolvedValue('ti-mock'),
}));

const mockedSessionStore = sessionStore as jest.Mocked<typeof sessionStore>;
const mockedSlackClient = slackClient as jest.Mocked<typeof slackClient>;

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    objectId: 'co-1',
    sessionId: 'uuid-resp',
    conversationKey: 'ck-1',
    channel: 'C0123456789',
    channelName: 'general',
    conversationType: 'channel',
    threadTs: '1705315800.000100',
    messageTs: '1705315800.000100',
    teamId: 'T0123456789',
    userId: 'U0123456789',
    userName: 'Alice',
    userEmail: 'alice@example.com',
    botUserId: 'UBOT00000',
    devrevUserId: 'dev-user-123',
    tempMessageTs: '',
    status: 'active',
    generation: 0,
    previousSessionId: '',
    endReason: '',
    messageCount: 1,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    hardExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

describe('ai_response_handler', () => {
  const mockEvent: FunctionInput = {
    payload: {
      client_metadata: {
        session_id: 'uuid-resp',
        slack_bot_token: 'xoxb-test-token',
      },
      text: 'AI response content',
    },
    execution_metadata: {
      request_id: 'req-2',
      devrev_endpoint: 'https://api.devrev.ai',
      function_name: 'ai_response_handler',
      event_type: 'ai_agent_response',
    },
    input_data: {
      global_values: {
        ai_agent_id: 'agent-1',
      },
      event_sources: {
        'ai-agent-events': 'event-source-id-456',
      },
      keyrings: {
        slack_bot_token: 'xoxb-test-token',
        slack_signing_secret: 'test-signing-secret',
      },
    },
    context: {
      dev_oid: 'dev-1',
      source_id: 'source-1',
      snap_in_id: 'snap-1',
      snap_in_version_id: 'ver-1',
      service_account_id: 'svc-1',
      secrets: { service_account_token: 'token-1' },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedSessionStore.getSessionById.mockImplementation(async () => makeRecord());
    mockedSessionStore.getSessionByConversationId.mockResolvedValue(null);
    mockedSessionStore.patchSession.mockImplementation(async (_c, record) => record);
    mockedSessionStore.recordToConversationReference.mockImplementation((record) => ({
      channel: record.channel,
      channelName: record.channelName || undefined,
      userId: record.userId,
      userName: record.userName || undefined,
      userEmail: record.userEmail || undefined,
      threadTs: record.threadTs || undefined,
      messageTs: record.messageTs,
      teamId: record.teamId || undefined,
      tempMessageTs: record.tempMessageTs || undefined,
      timestamp: record.createdAt,
    }));

    mockedSlackClient.sendMessage.mockResolvedValue('new-message-ts');
    mockedSlackClient.updateMessage.mockResolvedValue(undefined);
    mockedSlackClient.deleteMessage.mockResolvedValue(undefined);
  });

  test('processes final AI response and sends to Slack', async () => {
    const result = await run([mockEvent]);

    expect(mockedSessionStore.getSessionById).toHaveBeenCalledWith(
      expect.objectContaining({
        devrevEndpoint: 'https://api.devrev.ai',
        serviceAccountToken: 'token-1',
      }),
      'uuid-resp'
    );
    expect(mockedSlackClient.sendMessage).toHaveBeenCalledWith(
      'C0123456789',
      'AI response content',
      'xoxb-test-token',
      '1705315800.000100'
    );
    expect(result).toEqual({
      status: 'success',
      message: 'AI response sent to Slack',
      session_id: 'uuid-resp',
    });
  });

  test('updates temp message on progress events', async () => {
    mockedSessionStore.getSessionById.mockResolvedValue(
      makeRecord({ tempMessageTs: '1705315801.000200' })
    );
    const progressEvent = {
      ...mockEvent,
      payload: {
        ...mockEvent.payload,
        ai_agent_response: {
          agent_response: 'progress',
          progress: {
            progress_state: 'skill_triggered',
            skill_triggered: { skill_name: 'hybrid_search' },
          },
        },
      },
    };

    await run([progressEvent]);
    expect(mockedSlackClient.updateMessage).toHaveBeenCalledWith(
      'C0123456789',
      '1705315801.000200',
      expect.stringContaining('Hybrid Search'),
      'xoxb-test-token'
    );
  });

  test('sends new progress message and patches session when no temp message present', async () => {
    const progressEvent = {
      ...mockEvent,
      payload: {
        ...mockEvent.payload,
        ai_agent_response: {
          agent_response: 'progress',
          progress: {
            progress_state: 'skill_triggered',
            skill_triggered: { skill_name: 'HybridSearch' },
          },
        },
      },
    };

    await run([progressEvent]);
    expect(mockedSlackClient.sendMessage).toHaveBeenCalled();
    expect(mockedSessionStore.patchSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ tempMessageTs: 'new-message-ts' })
    );
  });

  test('handles AI Agent error events', async () => {
    const errorEvent = {
      ...mockEvent,
      payload: {
        ...mockEvent.payload,
        ai_agent_response: {
          agent_response: 'error',
          error: { error: 'Something went wrong' },
        },
      },
    };

    const result = await run([errorEvent]);
    expect(mockedSlackClient.sendMessage).toHaveBeenCalledWith(
      'C0123456789',
      expect.stringContaining('Error: Something went wrong'),
      'xoxb-test-token',
      '1705315800.000100'
    );
    expect(result.status).toBe('error');
  });

  test('deletes temp message and patches session before sending final response', async () => {
    mockedSessionStore.getSessionById.mockResolvedValue(
      makeRecord({ tempMessageTs: '1705315801.000200' })
    );

    await run([mockEvent]);

    expect(mockedSlackClient.deleteMessage).toHaveBeenCalledWith(
      'C0123456789',
      '1705315801.000200',
      'xoxb-test-token'
    );
    expect(mockedSessionStore.patchSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ tempMessageTs: null })
    );
    expect(mockedSlackClient.sendMessage).toHaveBeenCalledWith(
      'C0123456789',
      'AI response content',
      'xoxb-test-token',
      '1705315800.000100'
    );
  });

  test('falls back to client_metadata.conversation_reference when no session row found', async () => {
    mockedSessionStore.getSessionById.mockResolvedValue(null);
    const event = {
      ...mockEvent,
      payload: {
        ...mockEvent.payload,
        client_metadata: {
          ...mockEvent.payload.client_metadata,
          conversation_reference: {
            channel: 'C-FALLBACK',
            userId: 'U-FALLBACK',
            messageTs: 't-fallback',
            timestamp: 1700000000000,
          },
        },
      },
    };

    const result = await run([event]);
    expect(result.status).toBe('success');
    expect(mockedSlackClient.sendMessage).toHaveBeenCalledWith(
      'C-FALLBACK',
      expect.any(String),
      'xoxb-test-token',
      't-fallback'
    );
  });

  test('returns error when no session reference at all', async () => {
    mockedSessionStore.getSessionById.mockResolvedValue(null);
    const event = {
      ...mockEvent,
      payload: { text: 'no session' },
    };
    const result = await run([event]);
    expect(result).toEqual({
      status: 'error',
      reason: 'Conversation reference not found',
    });
  });

  test('returns error if Slack Bot Token is not configured', async () => {
    const event = {
      ...mockEvent,
      payload: {
        client_metadata: { session_id: 'uuid-resp' }, // No slack_bot_token
        text: 'AI response content',
      },
      input_data: { ...mockEvent.input_data, keyrings: {} },
    };

    const result = await run([event]);
    expect(result).toEqual({
      status: 'error',
      reason: 'Slack Bot Token not configured',
    });
  });

  test('extracts text from various payload fields', async () => {
    const payloads = [
      { response: 'field-response' },
      { message: 'field-message' },
      { output: 'field-output' },
      { result: { text: 'field-result-text' } },
      { data: { message: 'field-data-message' } },
      { ai_agent_response: { text: 'field-agent-text' } },
    ];

    for (const payload of payloads) {
      mockedSlackClient.sendMessage.mockClear();
      const event = {
        ...mockEvent,
        payload: {
          ...payload,
          client_metadata: { session_id: 'uuid-resp', slack_bot_token: 'xoxb-test-token' },
        },
      };
      await run([event]);
      expect(mockedSlackClient.sendMessage).toHaveBeenCalled();
    }
  });

  test('handles unexpected errors gracefully', async () => {
    const result = await run([null as any]);
    expect(result.status).toBe('error');
  });

  test('ignores suggestions events', async () => {
    const suggestionsEvent = {
      ...mockEvent,
      payload: {
        ...mockEvent.payload,
        ai_agent_response: {
          agent_response: 'suggestions',
          suggestions: ['suggestion 1'],
        },
      },
    };
    const result = await run([suggestionsEvent]);
    expect(result.status).toBe('ignored');
    expect(result.reason).toBe('Suggestions event');
  });

});
