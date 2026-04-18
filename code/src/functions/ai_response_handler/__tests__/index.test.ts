import { run } from '../index';
import * as convStore from '../../../utils/conversation-store';
import * as slackClient from '../../../utils/slack-client';
import { FunctionInput } from '../../../types';

jest.mock('../../../utils/conversation-store');
jest.mock('../../../utils/slack-client');

const mockedConvStore = convStore as jest.Mocked<typeof convStore>;
const mockedSlackClient = slackClient as jest.Mocked<typeof slackClient>;

describe('ai_response_handler', () => {
  const getMockConversationRef = () => ({
    channel: 'C0123456789',
    userId: 'U0123456789',
    threadTs: '1705315800.000100',
    messageTs: '1705315800.000100',
    teamId: 'T0123456789',
    timestamp: Date.now(),
  });

  const mockEvent: FunctionInput = {
    payload: {
      client_metadata: { 
        session_id: 'session-1',
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
      secrets: {
        service_account_token: 'token-1',
      },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedConvStore.getConversationReference.mockImplementation(() => getMockConversationRef());
    mockedSlackClient.sendMessage.mockResolvedValue('new-message-ts');
    mockedSlackClient.updateMessage.mockResolvedValue(undefined);
    mockedSlackClient.deleteMessage.mockResolvedValue(undefined);
  });

  test('should process AI response and send to Slack', async () => {
    const result = await run([mockEvent]);

    expect(mockedConvStore.getConversationReference).toHaveBeenCalledWith('session-1');
    expect(mockedSlackClient.sendMessage).toHaveBeenCalledWith(
      'C0123456789',
      'AI response content',
      'xoxb-test-token',
      '1705315800.000100'
    );
    expect(result).toEqual({
      status: 'success',
      message: 'AI response sent to Slack',
      session_id: 'session-1',
    });
  });

  test('should handle progress events and update temp message', async () => {
    const progressEvent = {
      ...mockEvent,
      payload: {
        ai_agent_response: {
          agent_response: 'progress',
          progress: {
            progress_state: 'skill_triggered',
            skill_triggered: { skill_name: 'hybrid_search' }
          },
          client_metadata: { session_id: 'session-1', slack_bot_token: 'xoxb-test-token' }
        }
      }
    };

    // Case: Has temp message, should update it
    const convWithTemp = { ...getMockConversationRef(), tempMessageTs: '1705315801.000200' };
    mockedConvStore.getConversationReference.mockReturnValue(convWithTemp);
    
    await run([progressEvent]);
    expect(mockedSlackClient.updateMessage).toHaveBeenCalledWith(
      'C0123456789',
      '1705315801.000200',
      expect.stringContaining('Hybrid Search'),
      'xoxb-test-token'
    );
  });

  test('should handle progress events without temp message', async () => {
    const progressEvent = {
      ...mockEvent,
      payload: {
        ai_agent_response: {
          agent_response: 'progress',
          progress: {
            progress_state: 'skill_triggered',
            skill_triggered: { skill_name: 'HybridSearch' }
          },
          client_metadata: { session_id: 'session-1', slack_bot_token: 'xoxb-test-token' }
        }
      }
    };

    // No temp message, should send new one
    await run([progressEvent]);
    expect(mockedSlackClient.sendMessage).toHaveBeenCalled();
  });

  test('should handle AI Agent error events', async () => {
    const errorEvent = {
      ...mockEvent,
      payload: {
        ai_agent_response: {
          agent_response: 'error',
          error: { error: 'Something went wrong' },
          client_metadata: { session_id: 'session-1', slack_bot_token: 'xoxb-test-token' }
        }
      }
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

  test('should delete temp message and send final response', async () => {
    const convWithTemp = { ...getMockConversationRef(), tempMessageTs: '1705315801.000200' };
    mockedConvStore.getConversationReference.mockReturnValue(convWithTemp);

    await run([mockEvent]);

    // Should delete temp message first
    expect(mockedSlackClient.deleteMessage).toHaveBeenCalledWith(
      'C0123456789',
      '1705315801.000200',
      'xoxb-test-token'
    );
    // Then send final response
    expect(mockedSlackClient.sendMessage).toHaveBeenCalledWith(
      'C0123456789',
      'AI response content',
      'xoxb-test-token',
      '1705315800.000100'
    );
  });

  test('should handle missing session ID', async () => {
    const event = {
      ...mockEvent,
      payload: { text: 'no session' },
    };

    const result = await run([event]);

    expect(result).toEqual({
      status: 'error',
      reason: 'No session ID in response',
    });
  });

  test('should handle missing conversation reference', async () => {
    mockedConvStore.getConversationReference.mockReturnValue(undefined);

    const result = await run([mockEvent]);

    expect(result).toEqual({
      status: 'error',
      reason: 'Conversation reference not found',
    });
  });

  test('should return error if Slack Bot Token is not configured', async () => {
    const event = {
      ...mockEvent,
      payload: {
        client_metadata: { session_id: 'session-1' }, // No slack_bot_token
        text: 'AI response content',
      },
      input_data: {
        ...mockEvent.input_data,
        keyrings: {}, // No slack_bot_token
      },
    };

    const result = await run([event]);

    expect(result).toEqual({
      status: 'error',
      reason: 'Slack Bot Token not configured',
    });
  });

  test('should extract text from various payload fields', async () => {
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
        payload: { ...payload, client_metadata: { session_id: 'session-1', slack_bot_token: 'xoxb-test-token' } },
      };
      await run([event]);
      expect(mockedSlackClient.sendMessage).toHaveBeenCalled();
    }
  });

  test('should handle sending error with fallback', async () => {
    // First call fails, second succeeds (fallback)
    mockedSlackClient.sendMessage
      .mockRejectedValueOnce(new Error('Slack API error'))
      .mockResolvedValueOnce('fallback-ts');

    const result = await run([mockEvent]);

    expect(result.status).toBe('success');
    expect(result.message).toContain('fallback');
  });

  test('should handle unexpected errors in handleAIResponse', async () => {
    const result = await run([null as any]);
    expect(result.status).toBe('error');
  });

  test('should ignore suggestions events', async () => {
    const suggestionsEvent = {
      ...mockEvent,
      payload: {
        ai_agent_response: {
          agent_response: 'suggestions',
          suggestions: ['suggestion 1', 'suggestion 2'],
          client_metadata: { session_id: 'session-1', slack_bot_token: 'xoxb-test-token' }
        }
      }
    };

    const result = await run([suggestionsEvent]);
    expect(result.status).toBe('ignored');
    expect(result.reason).toBe('Suggestions event');
  });
});
