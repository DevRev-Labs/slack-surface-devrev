import { run } from '../index';
import * as sessionStore from '../../../utils/session-store';
import * as slackClient from '../../../utils/slack-client';
import { FunctionInput } from '../../../types';
import { SessionRecord } from '../../../utils/session-store';
import {
  ACTION_DISMISS_FEEDBACK_PROMPT,
  ACTION_OPEN_FEEDBACK,
  encodeContext,
  FEEDBACK_ACTION_RATING,
  FEEDBACK_ACTION_TEXT,
  FEEDBACK_BLOCK_RATING,
  FEEDBACK_BLOCK_TEXT,
  FEEDBACK_VIEW_CALLBACK,
} from '../../../utils/feedback';

jest.mock('../../../utils/session-store');
jest.mock('../../../utils/slack-client');
jest.mock('../../../utils/slack-signature-validator', () => ({
  validateSlackSignature: jest.fn(() => ({ valid: true })),
}));

const mockedSessionStore = sessionStore as jest.Mocked<typeof sessionStore>;
const mockedSlackClient = slackClient as jest.Mocked<typeof slackClient>;

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    objectId: 'co-1',
    sessionId: 'sess-1',
    conversationKey: 'ck',
    channel: 'C1',
    channelName: '',
    conversationType: '',
    threadTs: 't1',
    messageTs: '',
    teamId: '',
    userId: 'U1',
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

function makeBaseEvent(payload: any): FunctionInput {
  return {
    payload,
    execution_metadata: {
      request_id: 'req-int',
      devrev_endpoint: 'https://api.devrev.ai',
      function_name: 'slack_interactivity',
      event_type: 'custom:slack-interactivity',
    },
    input_data: {
      global_values: { ai_agent_id: '' },
      event_sources: {},
      keyrings: {
        slack_bot_token: 'xoxb-test',
        slack_signing_secret: 'sig',
      },
    },
    context: {
      dev_oid: 'd',
      source_id: 's',
      snap_in_id: 'si',
      snap_in_version_id: 'siv',
      service_account_id: 'sa',
      secrets: { service_account_token: 'sat' },
    },
  };
}

describe('slack_interactivity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSlackClient.openView.mockResolvedValue('view-id-1');
    mockedSlackClient.updateView.mockResolvedValue();
    mockedSlackClient.sendBlocksMessage.mockResolvedValue('ts');
    mockedSessionStore.getLatestActiveSessionForUserInChannel.mockResolvedValue(makeRecord());
    mockedSessionStore.getSessionById.mockResolvedValue(makeRecord());
    mockedSessionStore.patchSession.mockImplementation(async (_c, r) => r);
  });

  describe('slash command', () => {
    test('/sda-feedback: opens loading modal first, then resolves session, then updates with form', async () => {
      const result = await run([
        makeBaseEvent({
          command: '/sda-feedback',
          trigger_id: 'trig-1',
          user_id: 'U1',
          channel_id: 'C1',
        }),
      ]);
      // Stage 1: trigger_id consumed by views.open with the loading modal.
      expect(mockedSlackClient.openView).toHaveBeenCalledWith(
        'trig-1',
        expect.objectContaining({
          callback_id: FEEDBACK_VIEW_CALLBACK,
          // loading modal has no `submit` button, only `close`
          close: expect.anything(),
        }),
        'xoxb-test'
      );
      // Stage 2: session lookup happened.
      expect(mockedSessionStore.getLatestActiveSessionForUserInChannel).toHaveBeenCalledWith(
        expect.anything(),
        'C1',
        'U1'
      );
      // Stage 2: views.update swapped in the real form (which has `submit`).
      expect(mockedSlackClient.updateView).toHaveBeenCalledWith(
        'view-id-1',
        expect.objectContaining({
          callback_id: FEEDBACK_VIEW_CALLBACK,
          submit: expect.anything(),
        }),
        'xoxb-test'
      );
      expect(result.session_id).toBe('sess-1');
    });

    test('/sda-feedback: no active session → loading modal updated to friendly error', async () => {
      mockedSessionStore.getLatestActiveSessionForUserInChannel.mockResolvedValue(null);
      const result = await run([
        makeBaseEvent({
          command: '/sda-feedback',
          trigger_id: 'trig-2',
          user_id: 'U-no',
          channel_id: 'C-no',
        }),
      ]);
      expect(mockedSlackClient.openView).toHaveBeenCalled();
      // Error modal swapped in — no `submit` button.
      const updateCall = mockedSlackClient.updateView.mock.calls[0];
      expect(updateCall[0]).toBe('view-id-1');
      expect(updateCall[1].submit).toBeUndefined();
      expect(updateCall[1].blocks?.[0]?.text?.text).toMatch(/active conversation/i);
      expect(result.mode).toBe('feedback_no_session');
    });

    test('unknown slash commands are ignored', async () => {
      const result = await run([
        makeBaseEvent({
          command: '/somethingelse',
          trigger_id: 't',
          user_id: 'U',
          channel_id: 'C',
        }),
      ]);
      expect(result.status).toBe('ignored');
      expect(mockedSlackClient.openView).not.toHaveBeenCalled();
    });

    test('/feedback without trigger_id is rejected', async () => {
      const result = await run([
        makeBaseEvent({ command: '/sda-feedback', user_id: 'U1', channel_id: 'C1' }),
      ]);
      expect(result.status).toBe('error');
    });
  });

  describe('view_submission', () => {
    test('persists rating + comment to the session and posts a confirmation', async () => {
      const ctx = encodeContext({ sessionId: 'sess-1', channel: 'C1', threadTs: 't1' });
      await run([
        makeBaseEvent({
          type: 'view_submission',
          view: {
            callback_id: FEEDBACK_VIEW_CALLBACK,
            private_metadata: ctx,
            state: {
              values: {
                [FEEDBACK_BLOCK_RATING]: {
                  [FEEDBACK_ACTION_RATING]: { selected_option: { value: '4' } },
                },
                [FEEDBACK_BLOCK_TEXT]: { [FEEDBACK_ACTION_TEXT]: { value: 'nice' } },
              },
            },
          },
        }),
      ]);
      expect(mockedSessionStore.patchSession).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sessionId: 'sess-1' }),
        expect.objectContaining({ feedbackRating: 4, feedbackText: 'nice' })
      );
      expect(mockedSlackClient.sendBlocksMessage).toHaveBeenCalledWith(
        'C1',
        expect.any(String),
        expect.any(Array),
        'xoxb-test',
        't1'
      );
    });

    test('surfaces validation error when no rating selected', async () => {
      const ctx = encodeContext({ sessionId: 'sess-1', channel: 'C1' });
      const result = await run([
        makeBaseEvent({
          type: 'view_submission',
          view: {
            callback_id: FEEDBACK_VIEW_CALLBACK,
            private_metadata: ctx,
            state: { values: { [FEEDBACK_BLOCK_RATING]: {} } },
          },
        }),
      ]);
      expect(result.response_action).toBe('errors');
      expect(result.errors[FEEDBACK_BLOCK_RATING]).toMatch(/rating/i);
      expect(mockedSessionStore.patchSession).not.toHaveBeenCalled();
    });

    test('resolves session via (channel,user) when private_metadata has no sessionId', async () => {
      const ctx = encodeContext({ sessionId: '', channel: 'C1', userId: 'U1' });
      await run([
        makeBaseEvent({
          type: 'view_submission',
          view: {
            callback_id: FEEDBACK_VIEW_CALLBACK,
            private_metadata: ctx,
            state: {
              values: {
                [FEEDBACK_BLOCK_RATING]: {
                  [FEEDBACK_ACTION_RATING]: { selected_option: { value: '5' } },
                },
              },
            },
          },
        }),
      ]);
      expect(mockedSessionStore.getLatestActiveSessionForUserInChannel).toHaveBeenCalledWith(
        expect.anything(),
        'C1',
        'U1'
      );
      expect(mockedSessionStore.getSessionById).not.toHaveBeenCalled();
      expect(mockedSessionStore.patchSession).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sessionId: 'sess-1' }),
        expect.objectContaining({ feedbackRating: 5 })
      );
    });

    test('returns expired-session error when session not found', async () => {
      mockedSessionStore.getSessionById.mockResolvedValue(null);
      const ctx = encodeContext({ sessionId: 'gone', channel: 'C1' });
      const result = await run([
        makeBaseEvent({
          type: 'view_submission',
          view: {
            callback_id: FEEDBACK_VIEW_CALLBACK,
            private_metadata: ctx,
            state: {
              values: {
                [FEEDBACK_BLOCK_RATING]: {
                  [FEEDBACK_ACTION_RATING]: { selected_option: { value: '3' } },
                },
              },
            },
          },
        }),
      ]);
      expect(result.response_action).toBe('errors');
      expect(mockedSessionStore.patchSession).not.toHaveBeenCalled();
    });
  });

  test('rejects when signature validator fails', async () => {
    const validator = require('../../../utils/slack-signature-validator');
    validator.validateSlackSignature.mockReturnValueOnce({ valid: false, reason: 'bad' });

    const result = await run([
      makeBaseEvent({ command: '/sda-feedback', trigger_id: 't', user_id: 'U', channel_id: 'C' }),
    ]);
    expect(result).toEqual({ status: 'forbidden', status_code: 403 });
    expect(mockedSlackClient.openView).not.toHaveBeenCalled();
  });

  describe('block_actions: feedback prompt buttons', () => {
    test('open button click → opens the modal directly with the click trigger_id', async () => {
      mockedSlackClient.updateMessageBlocks.mockResolvedValue();
      const ctxValue = encodeContext({
        sessionId: 'sess-1',
        channel: 'C1',
        threadTs: 't1',
        userId: 'U1',
      });

      const result = await run([
        makeBaseEvent({
          type: 'block_actions',
          trigger_id: 'trig-click',
          container: { channel_id: 'C1', message_ts: 'mts-1' },
          actions: [{ action_id: ACTION_OPEN_FEEDBACK, value: ctxValue }],
        }),
      ]);

      expect(mockedSlackClient.openView).toHaveBeenCalledWith(
        'trig-click',
        expect.objectContaining({
          callback_id: FEEDBACK_VIEW_CALLBACK,
          submit: expect.anything(),
        }),
        'xoxb-test'
      );
      expect(result.session_id).toBe('sess-1');
    });

    test('dismiss button → updates the prompt message to a "skipped" notice', async () => {
      mockedSlackClient.updateMessageBlocks.mockResolvedValue();
      const ctxValue = encodeContext({ sessionId: 'sess-1', channel: 'C1' });

      const result = await run([
        makeBaseEvent({
          type: 'block_actions',
          trigger_id: 'trig-dismiss',
          container: { channel_id: 'C1', message_ts: 'mts-1' },
          actions: [{ action_id: ACTION_DISMISS_FEEDBACK_PROMPT, value: ctxValue }],
        }),
      ]);

      expect(mockedSlackClient.updateMessageBlocks).toHaveBeenCalledWith(
        'C1',
        'mts-1',
        expect.any(String),
        expect.any(Array),
        'xoxb-test'
      );
      expect(mockedSlackClient.openView).not.toHaveBeenCalled();
      expect(result.mode).toBe('feedback_prompt_dismissed');
    });
  });

  test('ignores view_closed', async () => {
    const r = await run([makeBaseEvent({ type: 'view_closed' })]);
    expect(r.status).toBe('ignored');
  });
});
