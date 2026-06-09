import { FunctionInput } from '../../../types';
// eslint-disable-next-line simple-import-sort/imports
import {
  encodeContext,
  FEEDBACK_ACTION_RATING,
  FEEDBACK_ACTION_TEXT,
  FEEDBACK_BLOCK_RATING,
  FEEDBACK_BLOCK_TEXT,
  FEEDBACK_VIEW_CALLBACK,
} from '../../../utils/feedback';
import * as sessionStore from '../../../utils/session-store';
import { SessionRecord } from '../../../utils/session-store';
import * as slackClient from '../../../utils/slack-client';
import { run } from '../index';

jest.mock('../../../utils/session-store');
jest.mock('../../../utils/slack-client');
jest.mock('../../../utils/slack-signature-validator', () => ({
  validateSlackSignature: jest.fn(() => ({ valid: true })),
}));

const mockedSessionStore = sessionStore as jest.Mocked<typeof sessionStore>;
const mockedSlackClient = slackClient as jest.Mocked<typeof slackClient>;

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    botUserId: '',
    channel: 'C1',
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
    feedbackPromptTs: '',
    lastDeliveredTurn: 0,
    lastUsedAt: 0,
    messageCount: 0,
    messageTs: '',
    objectId: 'co-1',
    previousSessionId: '',
    sessionId: 'sess-1',
    status: 'active',
    teamId: '',
    tempMessageTs: '',
    threadTs: 't1',
    userEmail: '',
    userId: 'U1',
    userName: '',
    ...overrides,
  };
}

function makeBaseEvent(payload: any): FunctionInput {
  return {
    context: {
      dev_oid: 'd',
      secrets: { service_account_token: 'sat' },
      service_account_id: 'sa',
      snap_in_id: 'si',
      snap_in_version_id: 'siv',
      source_id: 's',
    },
    execution_metadata: {
      devrev_endpoint: 'https://api.devrev.ai',
      event_type: 'custom:slack-interactivity',
      function_name: 'slack_interactivity',
      request_id: 'req-int',
    },
    input_data: {
      event_sources: {},
      global_values: { ai_agent_id: '' },
      keyrings: {
        slack_bot_token: 'xoxb-test',
        slack_signing_secret: 'sig',
      },
    },
    payload,
  };
}

describe('slack_interactivity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSlackClient.openView.mockResolvedValue('view-id-1');
    mockedSlackClient.updateView.mockResolvedValue();
    mockedSlackClient.postEphemeral.mockResolvedValue();
    mockedSlackClient.deleteMessage.mockResolvedValue();
    mockedSessionStore.getLatestActiveSessionForUserInChannel.mockResolvedValue(makeRecord());
    mockedSessionStore.getSessionById.mockResolvedValue(makeRecord());
    mockedSessionStore.patchSession.mockImplementation(async (_c, r) => r);
  });

  describe('slash command', () => {
    test('/sda-feedback: opens loading modal first, then resolves session, then updates with form', async () => {
      const result = await run([
        makeBaseEvent({
          channel_id: 'C1',
          command: '/sda-feedback',
          trigger_id: 'trig-1',
          user_id: 'U1',
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
          channel_id: 'C-no',
          command: '/sda-feedback',
          trigger_id: 'trig-2',
          user_id: 'U-no',
        }),
      ]);
      expect(mockedSlackClient.openView).toHaveBeenCalled();
      // Error modal swapped in — no `submit` button.
      const updateCall = mockedSlackClient.updateView.mock.calls[0];
      expect(updateCall[0]).toBe('view-id-1');
      expect(updateCall[1].submit).toBeUndefined();
      expect(updateCall[1].blocks?.[0]?.text?.text).toMatch(/active.*conversation/i);
      expect(result.mode).toBe('feedback_no_session');
    });

    test('unknown slash commands are ignored', async () => {
      const result = await run([
        makeBaseEvent({
          channel_id: 'C',
          command: '/somethingelse',
          trigger_id: 't',
          user_id: 'U',
        }),
      ]);
      expect(result.status).toBe('ignored');
      expect(mockedSlackClient.openView).not.toHaveBeenCalled();
    });

    test('/feedback without trigger_id is rejected', async () => {
      const result = await run([makeBaseEvent({ channel_id: 'C1', command: '/sda-feedback', user_id: 'U1' })]);
      expect(result.status).toBe('error');
    });
  });

  describe('view_submission', () => {
    test('persists rating + comment, swaps modal to thanks, sends ephemeral confirmation only to submitter', async () => {
      const ctx = encodeContext({ channel: 'C1', sessionId: 'sess-1', threadTs: 't1' });
      const result = await run([
        makeBaseEvent({
          type: 'view_submission',
          user: { id: 'Usubmitter' },
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
      // 1. Feedback persisted onto the session.
      expect(mockedSessionStore.patchSession).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sessionId: 'sess-1' }),
        expect.objectContaining({ feedbackRating: 4, feedbackText: 'nice' })
      );
      // 2. Ephemeral message addressed to the submitter only, in the
      //    same channel + thread the session lives in.
      expect(mockedSlackClient.postEphemeral).toHaveBeenCalledWith(
        'C1',
        'Usubmitter',
        expect.any(String),
        expect.any(Array),
        'xoxb-test',
        't1'
      );
      // 4. Modal swapped to a thank-you view (private to submitter).
      expect(result.response_action).toBe('update');
      expect(result.view?.title?.text).toMatch(/feedback/i);
    });

    test('on submit: deletes the lingering feedback prompt and clears its ts', async () => {
      mockedSessionStore.getSessionById.mockResolvedValue(
        makeRecord({ feedbackPromptTs: 'prompt-ts-99', sessionId: 'sess-1' })
      );
      const ctx = encodeContext({ channel: 'C1', sessionId: 'sess-1' });
      await run([
        makeBaseEvent({
          type: 'view_submission',
          user: { id: 'Usubmitter' },
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
      // Persist clears the prompt-ts field.
      expect(mockedSessionStore.patchSession).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ feedbackPromptTs: null, feedbackRating: 5 })
      );
      // Slack message deleted.
      expect(mockedSlackClient.deleteMessage).toHaveBeenCalledWith('C1', 'prompt-ts-99', 'xoxb-test');
    });

    test('surfaces validation error when no rating selected', async () => {
      const ctx = encodeContext({ channel: 'C1', sessionId: 'sess-1' });
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
      const ctx = encodeContext({ channel: 'C1', sessionId: '', userId: 'U1' });
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
      const ctx = encodeContext({ channel: 'C1', sessionId: 'gone' });
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const validator = require('../../../utils/slack-signature-validator');
    validator.validateSlackSignature.mockReturnValueOnce({ reason: 'bad', valid: false });

    const result = await run([
      makeBaseEvent({ channel_id: 'C', command: '/sda-feedback', trigger_id: 't', user_id: 'U' }),
    ]);
    expect(result).toEqual({ status: 'forbidden', status_code: 403 });
    expect(mockedSlackClient.openView).not.toHaveBeenCalled();
  });

  test('ignores view_closed', async () => {
    const r = await run([makeBaseEvent({ type: 'view_closed' })]);
    expect(r.status).toBe('ignored');
  });

  test('ignores block_actions with no actions', async () => {
    const r = await run([makeBaseEvent({ actions: [], type: 'block_actions' })]);
    expect(r.status).toBe('ignored');
  });

  test('block_actions: feedback prompt button click opens the modal pre-bound to ctx', async () => {
    const ctxValue = encodeContext({ channel: 'C-ended', sessionId: 'sess-ended', userId: 'U1' });
    const result = await run([
      makeBaseEvent({
        actions: [{ action_id: 'feedback_open_from_prompt', value: ctxValue }],
        trigger_id: 'trig-click',
        type: 'block_actions',
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
    expect(result.session_id).toBe('sess-ended');
  });
});
