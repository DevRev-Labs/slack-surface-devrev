import { run } from '../index';
import * as convStore from '../../../utils/conversation-store';
import * as sessionStore from '../../../utils/session-store';
import * as slackClient from '../../../utils/slack-client';
import * as devrevAuth from '../../../utils/devrev-auth';
import { FunctionInput } from '../../../types';
import { SessionRecord } from '../../../utils/session-store';

jest.mock('../../../utils/conversation-store', () => {
  const actual = jest.requireActual('../../../utils/conversation-store');
  return {
    ...actual,
    extractConversationReference: jest.fn(),
    extractRoutingKeyParts: jest.fn(),
  };
});
jest.mock('../../../utils/session-store');
jest.mock('../../../utils/slack-client');
jest.mock('../../../utils/devrev-auth');
jest.mock('../../../utils/slack-signature-validator', () => ({
  validateSlackSignature: jest.fn(() => ({ valid: true })),
}));

// Mock the DevRev SDK so the AI agent call doesn't hit the network.
const mockExecuteAsync = jest.fn().mockResolvedValue(undefined);
jest.mock('@devrev/typescript-sdk', () => ({
  client: {
    setupBeta: () => ({
      aiAgentEventsExecuteAsync: mockExecuteAsync,
    }),
  },
}));

// Mirror the user's message into the conversation timeline. Stub away.
jest.mock('../../../utils/timeline', () => ({
  postTimelineComment: jest.fn().mockResolvedValue('ti-mock'),
}));

const mockedConvStore = convStore as jest.Mocked<typeof convStore>;
const mockedSessionStore = sessionStore as jest.Mocked<typeof sessionStore>;
const mockedSlackClient = slackClient as jest.Mocked<typeof slackClient>;
const mockedDevrevAuth = devrevAuth as jest.Mocked<typeof devrevAuth>;

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    objectId: 'co-1',
    sessionId: 'uuid-current',
    conversationKey: 'ck-1',
    channel: 'C0123456789',
    channelName: 'general',
    conversationType: 'channel',
    threadTs: '1705315800.000100',
    messageTs: '1705315800.000100',
    teamId: 'T0123456789',
    userId: 'U0123456789',
    userName: 'Alice',
    userEmail: 'user@example.com',
    botUserId: 'UBOT00000',
    devrevUserId: 'dev-user-123',
    tempMessageTs: '',
    status: 'active',
    generation: 0,
    previousSessionId: '',
    endReason: '',
    messageCount: 0,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    hardExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
    feedbackRating: 0,
    feedbackText: '',
    feedbackSubmittedAt: 0,
    lastDeliveredTurn: 0,
    ...overrides,
  };
}

describe('slack_handler', () => {
  const mockEvent: FunctionInput = {
    payload: {
      token: 'verification-token',
      team_id: 'T0123456789',
      api_app_id: 'A0123456789',
      authorizations: [{ user_id: 'UBOT00000' }],
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
    mockedConvStore.extractRoutingKeyParts.mockReturnValue({
      channel: 'C0123456789',
      threadTs: '1705315800.000100',
      userId: 'U0123456789',
    });

    mockedSessionStore.buildConversationKey.mockReturnValue('ck-1');
    mockedSessionStore.getActiveSession.mockResolvedValue(null);
    mockedSessionStore.createSession.mockImplementation(async (_, opts) => makeRecord({
      sessionId: 'uuid-new',
      conversationKey: opts.identity.conversationKey,
      generation: 0,
    }));
    mockedSessionStore.rotateSession.mockImplementation(async (_, prev) =>
      makeRecord({
        sessionId: 'uuid-rotated',
        previousSessionId: prev.sessionId,
        generation: (prev.generation || 0) + 1,
      })
    );
    mockedSessionStore.touchSession.mockImplementation(async (_c, record) => record);
    mockedSessionStore.isSessionExpired.mockReturnValue(null);

    mockedSlackClient.sendMessage.mockResolvedValue('1705315801.000200');
    mockedSlackClient.sendBlocksMessage.mockResolvedValue('1705315802.000300');
    mockedSlackClient.removeBotMention.mockImplementation((text) =>
      text.replace(/<@[A-Z0-9]+>/gi, '').trim()
    );
    mockedSlackClient.getUserProfile.mockResolvedValue({
      email: 'user@example.com',
      name: 'Alice',
    });
    mockedSlackClient.getChannelName.mockResolvedValue('general');

    mockedDevrevAuth.findUserByEmail.mockResolvedValue('dev-user-123');
    mockedDevrevAuth.getOrCreateActAsToken.mockResolvedValue('act-as-token');

    mockExecuteAsync.mockClear().mockResolvedValue(undefined);
  });

  test('processes Slack message, creates a session, and submits to AI Agent (async)', async () => {
    const result = await run([mockEvent]);

    expect(mockedSlackClient.removeBotMention).toHaveBeenCalled();
    expect(mockedSessionStore.createSession).toHaveBeenCalled();
    expect(mockedSessionStore.rotateSession).not.toHaveBeenCalled();

    expect(mockedSlackClient.sendMessage).toHaveBeenCalledWith(
      'C0123456789',
      '⏳ Searching...',
      'xoxb-test-bot-token',
      '1705315800.000100'
    );

    // session_object IS the session's conversation DON (record.objectId).
    expect(mockExecuteAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'don:core:dvrv-us-1:devo/123:ai_agent/456',
        session_object: 'co-1',
        client_metadata: expect.objectContaining({ session_id: 'uuid-new' }),
      })
    );

    expect(result.status).toBe('success');
    expect(result.mode).toBe('async');
    expect(result.session_id).toBe('uuid-new');
  });

  test('reuses an active session without rotating', async () => {
    mockedSessionStore.getActiveSession.mockResolvedValue(
      makeRecord({ sessionId: 'uuid-existing', messageCount: 2 })
    );

    const result = await run([mockEvent]);

    expect(mockedSessionStore.createSession).not.toHaveBeenCalled();
    expect(mockedSessionStore.rotateSession).not.toHaveBeenCalled();
    expect(result.session_id).toBe('uuid-existing');
  });

  test('rotates session on idle timeout', async () => {
    mockedSessionStore.getActiveSession.mockResolvedValue(
      makeRecord({ sessionId: 'uuid-old' })
    );
    mockedSessionStore.isSessionExpired.mockReturnValue('idle_timeout');

    await run([mockEvent]);

    expect(mockedSessionStore.rotateSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: 'uuid-old' }),
      'idle_timeout',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  test('feedback intent posts a button prompt and skips the AI Agent', async () => {
    mockedSlackClient.removeBotMention.mockReturnValue('I want to give a feedback');
    mockedSessionStore.getActiveSession.mockResolvedValue(
      makeRecord({ sessionId: 'uuid-current' })
    );

    const result = await run([mockEvent]);

    // Block-Kit prompt posted in-thread; AI Agent NOT invoked.
    expect(mockedSlackClient.sendBlocksMessage).toHaveBeenCalledWith(
      'C0123456789',
      expect.any(String),
      expect.any(Array),
      'xoxb-test-bot-token',
      '1705315800.000100'
    );
    expect(mockExecuteAsync).not.toHaveBeenCalled();
    expect(result.mode).toBe('feedback_prompt');
    expect(result.session_id).toBe('uuid-current');
  });

  test('reset intent ("/clear") rotates without calling the AI Agent', async () => {
    mockedSlackClient.removeBotMention.mockReturnValue('/clear');
    mockedSessionStore.getActiveSession.mockResolvedValue(
      makeRecord({ sessionId: 'uuid-old' })
    );

    const result = await run([mockEvent]);

    expect(mockedSessionStore.rotateSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: 'uuid-old' }),
      'user_reset',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );

    // Confirmation reply.
    expect(mockedSlackClient.sendMessage).toHaveBeenCalledWith(
      'C0123456789',
      'Started a new session. Send your next message to begin a fresh conversation.',
      'xoxb-test-bot-token',
      '1705315800.000100'
    );

    // No Searching... temp message, no AI Agent submission.
    expect(mockedSlackClient.sendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      '⏳ Searching...',
      expect.anything(),
      expect.anything()
    );
    expect(mockExecuteAsync).not.toHaveBeenCalled();

    expect(result).toEqual({
      status: 'success',
      mode: 'new_session',
      session_id: 'uuid-rotated',
    });
  });

  test('reset intent ("new session") with no prior creates a fresh session and confirms', async () => {
    mockedSlackClient.removeBotMention.mockReturnValue('new session');
    mockedSessionStore.getActiveSession.mockResolvedValue(null);

    const result = await run([mockEvent]);

    expect(mockedSessionStore.rotateSession).not.toHaveBeenCalled();
    expect(mockedSessionStore.createSession).toHaveBeenCalled();
    expect(mockExecuteAsync).not.toHaveBeenCalled();

    expect(result.mode).toBe('new_session');
  });

  test('ignores top-level channel messages without a bot mention (no session)', async () => {
    mockedSessionStore.getActiveSession.mockResolvedValue(null);
    const event = {
      ...mockEvent,
      payload: {
        ...mockEvent.payload,
        event: {
          ...mockEvent.payload.event,
          type: 'message',
          channel_type: 'channel',
          text: 'just chatting, no mention',
        },
      },
    };

    const result = await run([event]);

    expect(result.status).toBe('ignored');
    expect(result.reason).toBe('Channel message outside of an active bot session');
    expect(mockedSessionStore.createSession).not.toHaveBeenCalled();
    expect(mockedSessionStore.touchSession).not.toHaveBeenCalled();
    expect(mockExecuteAsync).not.toHaveBeenCalled();
  });

  test('continues an active thread session when user replies without re-mentioning the bot', async () => {
    mockedSessionStore.getActiveSession.mockResolvedValue(
      makeRecord({ sessionId: 'uuid-active', messageCount: 3 })
    );
    const event = {
      ...mockEvent,
      payload: {
        ...mockEvent.payload,
        event: {
          ...mockEvent.payload.event,
          type: 'message',
          channel_type: 'channel',
          thread_ts: '1705315700.000050',
          text: 'follow-up question, no mention',
        },
      },
    };

    const result = await run([event]);

    expect(result.status).toBe('success');
    expect(mockedSessionStore.createSession).not.toHaveBeenCalled();
    expect(mockExecuteAsync).toHaveBeenCalled();
    expect(result.session_id).toBe('uuid-active');
  });

  test('top-level @mention in a channel creates a new session with idle and hard TTLs', async () => {
    mockedSessionStore.getActiveSession.mockResolvedValue(null);

    // Top-level mention → no thread_ts on the event; routing uses event.ts.
    mockedConvStore.extractRoutingKeyParts.mockReturnValue({
      channel: 'C0123456789',
      threadTs: '1705315900.000100',
      userId: 'U0123456789',
    });

    const event = {
      ...mockEvent,
      payload: {
        ...mockEvent.payload,
        event: {
          ...mockEvent.payload.event,
          type: 'app_mention',
          ts: '1705315900.000100',
        },
      },
    };

    await run([event]);

    expect(mockedSessionStore.rotateSession).not.toHaveBeenCalled();
    expect(mockedSessionStore.createSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        identity: expect.objectContaining({ threadTs: '1705315900.000100' }),
      }),
      expect.objectContaining({
        idleTtlMs: expect.any(Number),
        absoluteTtlMs: expect.any(Number),
      })
    );
  });

  test('processes DM messages (channel_type=im) without requiring a mention', async () => {
    const event = {
      ...mockEvent,
      payload: {
        ...mockEvent.payload,
        event: {
          ...mockEvent.payload.event,
          type: 'message',
          channel_type: 'im',
          text: 'hey bot',
        },
      },
    };

    const result = await run([event]);

    expect(result.status).toBe('success');
    expect(mockedSessionStore.createSession).toHaveBeenCalled();
  });

  test('ignores non-message events', async () => {
    const event = {
      ...mockEvent,
      payload: { ...mockEvent.payload, event: { type: 'channel_created' } },
    };
    const result = await run([event]);
    expect(result.status).toBe('ignored');
  });

  test('ignores bot messages', async () => {
    const event = {
      ...mockEvent,
      payload: {
        ...mockEvent.payload,
        event: { ...mockEvent.payload.event, bot_id: 'B0123456789' },
      },
    };
    const result = await run([event]);
    expect(result.status).toBe('ignored');
    expect(result.reason).toBe('Bot message');
  });

  test('ignores empty messages', async () => {
    const event = {
      ...mockEvent,
      payload: {
        ...mockEvent.payload,
        event: { ...mockEvent.payload.event, text: '' },
      },
    };
    const result = await run([event]);
    expect(result.status).toBe('ignored');
  });

  test('rejects sender not in DevRev org', async () => {
    mockedDevrevAuth.findUserByEmail.mockResolvedValue(null);

    const result = await run([mockEvent]);

    expect(result.status).toBe('ignored');
    expect(result.reason).toBe('User not in DevRev org');
    expect(mockExecuteAsync).not.toHaveBeenCalled();
  });

  test('falls back to service token when email is unresolvable', async () => {
    mockedSlackClient.getUserProfile.mockResolvedValue({ email: null, name: 'Alice' });

    const result = await run([mockEvent]);
    expect(result.status).toBe('success');
    expect(mockExecuteAsync).toHaveBeenCalled();
  });

  test('returns error if AI Agent ID not configured', async () => {
    const event = {
      ...mockEvent,
      input_data: { ...mockEvent.input_data, global_values: { ai_agent_id: '' } },
    };
    const result = await run([event]);
    expect(result.status).toBe('error');
    expect(result.reason).toBe('AI Agent ID not configured');
  });

  test('returns error if Slack Bot Token not configured', async () => {
    const event = {
      ...mockEvent,
      input_data: { ...mockEvent.input_data, keyrings: {} },
    };
    const result = await run([event]);
    expect(result.status).toBe('error');
    expect(result.reason).toBe('Slack Bot Token not configured');
  });

  test('persists tempMessageTs onto the session via touchSession', async () => {
    await run([mockEvent]);

    const calls = mockedSessionStore.touchSession.mock.calls;
    const tempCall = calls.find((c) => c[3] && (c[3] as any).tempMessageTs === '1705315801.000200');
    expect(tempCall).toBeDefined();
  });

  test('returns 403 when signature validation fails', async () => {
    const validator = require('../../../utils/slack-signature-validator');
    validator.validateSlackSignature.mockReturnValueOnce({
      valid: false,
      reason: 'Missing X-Slack-Signature header',
    });

    const result = await run([mockEvent]);
    expect(result).toEqual({ status: 'forbidden', status_code: 403 });
    expect(mockedSlackClient.sendMessage).not.toHaveBeenCalled();
    expect(mockExecuteAsync).not.toHaveBeenCalled();
  });

  test('unwraps { body, headers } payload shape before processing', async () => {
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

    expect(validator.validateSlackSignature).toHaveBeenCalledWith(
      'test-signing-secret',
      expect.objectContaining({ 'x-slack-signature': expect.any(String) }),
      expect.objectContaining({ type: 'event_callback' }),
      undefined
    );
    expect(mockedSlackClient.removeBotMention).toHaveBeenCalled();
  });
});
