import { run } from '../index';
import * as convStore from '../../../utils/conversation-store';
import * as slackClient from '../../../utils/slack-client';
import * as devrevAuth from '../../../utils/devrev-auth';
import axios from 'axios';
import { FunctionInput } from '../../../types';

jest.mock('../../../utils/conversation-store');
jest.mock('../../../utils/slack-client');
jest.mock('../../../utils/devrev-auth');
jest.mock('../../../utils/slack-signature-validator', () => ({
  validateSlackSignature: jest.fn(() => ({ valid: true })),
}));
jest.mock('axios');

const mockedConvStore = convStore as jest.Mocked<typeof convStore>;
const mockedSlackClient = slackClient as jest.Mocked<typeof slackClient>;
const mockedDevrevAuth = devrevAuth as jest.Mocked<typeof devrevAuth>;
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('slack_handler', () => {
  const mockEvent: FunctionInput = {
    payload: {
      token: 'verification-token',
      team_id: 'T0123456789',
      api_app_id: 'A0123456789',
      event: {
        type: 'app_mention',
        user: 'U0123456789',
        text: '<@U9876543210> What is the status of my ticket?',
        ts: '1705315800.000100',
        channel: 'C0123456789',
        event_ts: '1705315800.000100',
      },
      type: 'event_callback',
      event_id: 'Ev0123456789',
      event_time: 1705315800,
    },
    execution_metadata: {
      request_id: 'req-1',
      devrev_endpoint: 'https://api.devrev.ai',
      function_name: 'slack_handler',
      event_type: 'custom:slack-message',
    },
    input_data: {
      global_values: {
        ai_agent_id: 'don:core:dvrv-us-1:devo/123:ai_agent/456',
      },
      event_sources: {
        'ai-agent-events': 'event-source-id-456',
      },
      keyrings: {
        slack_bot_token: 'xoxb-test-bot-token',
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
        service_account_token: 'test-service-token',
      },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedConvStore.extractConversationReference.mockReturnValue({
      channel: 'C0123456789',
      userId: 'U0123456789',
      messageTs: '1705315800.000100',
      timestamp: Date.now(),
    });
    mockedConvStore.generateSessionId.mockReturnValue('slack-C0123456789-1705315800.000100');
    mockedSlackClient.sendMessage.mockResolvedValue('1705315801.000200');
    mockedSlackClient.removeBotMention.mockImplementation((text) => text.replace(/<@[A-Z0-9]+>/gi, '').trim());
    mockedSlackClient.getUserEmail.mockResolvedValue('user@example.com');
    mockedDevrevAuth.findUserByEmail.mockResolvedValue('dev-user-123');
    mockedDevrevAuth.getOrCreateActAsToken.mockResolvedValue('act-as-token');
    mockedAxios.post.mockResolvedValue({ data: { session: { id: 'session-123' } } });
  });

  test('should process Slack message and call AI Agent', async () => {
    const result = await run([mockEvent]);

    expect(mockedSlackClient.removeBotMention).toHaveBeenCalled();
    expect(mockedSlackClient.sendMessage).toHaveBeenCalledWith(
      'C0123456789',
      '⏳ Searching...',
      'xoxb-test-bot-token',
      '1705315800.000100'
    );
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining('/internal/ai-agents.events.execute-async'),
      expect.objectContaining({
        agent: 'don:core:dvrv-us-1:devo/123:ai_agent/456',
        session_object: 'slack-C0123456789-1705315800.000100',
      }),
      expect.any(Object)
    );
    expect(result.status).toBe('success');
    expect(result.mode).toBe('async');
  });

  test('should ignore non-message events', async () => {
    const event = {
      ...mockEvent,
      payload: {
        ...mockEvent.payload,
        event: { type: 'channel_created' },
      },
    };

    const result = await run([event]);
    expect(result.status).toBe('ignored');
  });

  test('should ignore bot messages', async () => {
    const event = {
      ...mockEvent,
      payload: {
        ...mockEvent.payload,
        event: {
          ...mockEvent.payload.event,
          bot_id: 'B0123456789',
        },
      },
    };

    const result = await run([event]);
    expect(result.status).toBe('ignored');
    expect(result.reason).toBe('Bot message');
  });

  test('should ignore empty messages', async () => {
    const event = {
      ...mockEvent,
      payload: {
        ...mockEvent.payload,
        event: {
          ...mockEvent.payload.event,
          text: '',
        },
      },
    };

    const result = await run([event]);
    expect(result.status).toBe('ignored');
  });

  test('should perform email-based user authentication', async () => {
    await run([mockEvent]);

    expect(mockedSlackClient.getUserEmail).toHaveBeenCalledWith('U0123456789', 'xoxb-test-bot-token');
    expect(mockedDevrevAuth.findUserByEmail).toHaveBeenCalledWith(
      'user@example.com',
      'https://api.devrev.ai',
      'test-service-token'
    );
    expect(mockedDevrevAuth.getOrCreateActAsToken).toHaveBeenCalledWith(
      'dev-user-123',
      'https://api.devrev.ai',
      'test-service-token'
    );
  });

  test('should fall back to service token when email auth fails', async () => {
    mockedSlackClient.getUserEmail.mockResolvedValue(null);

    const result = await run([mockEvent]);

    expect(result.status).toBe('success');
    // Should still call AI Agent with service token
    expect(mockedAxios.post).toHaveBeenCalled();
  });

  test('should return error if AI Agent ID not configured', async () => {
    const event = {
      ...mockEvent,
      input_data: {
        ...mockEvent.input_data,
        global_values: {
          ai_agent_id: '',
        },
      },
    };

    const result = await run([event]);
    expect(result.status).toBe('error');
    expect(result.reason).toBe('AI Agent ID not configured');
  });

  test('should return error if Slack Bot Token not configured', async () => {
    const event = {
      ...mockEvent,
      input_data: {
        ...mockEvent.input_data,
        keyrings: {},
      },
    };

    const result = await run([event]);
    expect(result.status).toBe('error');
    expect(result.reason).toBe('Slack Bot Token not configured');
  });

  test('should handle async API failure with sync fallback', async () => {
    // First call fails (async), second succeeds (sync)
    mockedAxios.post
      .mockRejectedValueOnce(new Error('Async API error'))
      .mockResolvedValueOnce({ data: { message: 'Sync response' } });

    const result = await run([mockEvent]);

    expect(result.status).toBe('success');
    expect(result.mode).toBe('sync_fallback');
  });

  test('should store temp message ts in conversation reference', async () => {
    await run([mockEvent]);

    expect(mockedConvStore.storeConversationReference).toHaveBeenCalledWith(
      'slack-C0123456789-1705315800.000100',
      expect.objectContaining({
        tempMessageTs: '1705315801.000200',
      })
    );
  });

  test('should return 403 when signature validation fails', async () => {
    const validator = require('../../../utils/slack-signature-validator');
    validator.validateSlackSignature.mockReturnValueOnce({
      valid: false,
      reason: 'Missing X-Slack-Signature header',
    });

    const result = await run([mockEvent]);
    expect(result).toEqual({ status: 'forbidden', status_code: 403 });
    // Must short-circuit before any downstream side effects.
    expect(mockedSlackClient.sendMessage).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  test('should unwrap { body, headers } payload shape before processing', async () => {
    const wrappedEvent: FunctionInput = {
      ...mockEvent,
      payload: {
        body: mockEvent.payload,
        headers: {
          'x-slack-signature': 'v0=deadbeef',
          'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
        },
      },
    };

    const validator = require('../../../utils/slack-signature-validator');
    validator.validateSlackSignature.mockClear();

    await run([wrappedEvent]);

    // Validator must be called with the headers map, the inner Slack body,
    // and (when present) body_raw — so HMAC computation matches Slack's input.
    expect(validator.validateSlackSignature).toHaveBeenCalledWith(
      'test-signing-secret',
      expect.objectContaining({ 'x-slack-signature': expect.any(String) }),
      expect.objectContaining({ type: 'event_callback' }),
      undefined,
    );
    // The handler must reach event-type handling (i.e. it unwrapped body.event).
    expect(mockedSlackClient.removeBotMention).toHaveBeenCalled();
  });
});
