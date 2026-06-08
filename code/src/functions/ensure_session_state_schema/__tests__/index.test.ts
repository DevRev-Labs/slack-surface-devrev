import { FunctionInput } from '../../../types';
import { run } from '../index';

const mockCustomSchemaFragmentsSet = jest.fn();
let mockSetupBeta: jest.Mock;

jest.mock('@devrev/typescript-sdk', () => ({
  client: {
    setupBeta: (...args: any[]) => mockSetupBeta(...args),
  },
}));

beforeEach(() => {
  mockSetupBeta = jest.fn((_options: any) => ({
    customSchemaFragmentsSet: mockCustomSchemaFragmentsSet,
  }));
});

describe('ensure_session_state_schema', () => {
  const activateEvent: FunctionInput = {
    context: {
      dev_oid: 'dev-1',
      secrets: {
        service_account_token: 'token-1',
      },
      service_account_id: 'service-1',
      snap_in_id: 'snap-1',
      snap_in_version_id: 'version-1',
      source_id: 'source-1',
    },
    execution_metadata: {
      devrev_endpoint: 'https://api.devrev.ai',
      event_type: 'hook:snap_in_activate',
      function_name: 'ensure_session_state_schema',
      request_id: 'req-activate',
    },
    input_data: {
      event_sources: {},
      global_values: {
        ai_agent_id: 'agent-1',
      },
      keyrings: {
        slack_bot_token: 'xoxb-test',
        slack_signing_secret: 'shh',
      },
    },
    payload: {},
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('attaches the Slack session fields to the conversation leaf type on activate hook', async () => {
    mockCustomSchemaFragmentsSet.mockResolvedValue({ data: { id: 'schema-id' } });

    const result = await run([activateEvent]);

    expect(mockSetupBeta).toHaveBeenCalledWith({
      endpoint: 'https://api.devrev.ai',
      token: 'token-1',
    });
    expect(mockCustomSchemaFragmentsSet).toHaveBeenCalledTimes(1);
    const call = mockCustomSchemaFragmentsSet.mock.calls[0][0];
    expect(call.leaf_type).toBe('conversation');
    expect(call.is_custom_leaf_type).toBe(false);
    // Field names must include all the slack-specific routing fields.
    const fieldNames = call.fields.map((f: any) => f.name);
    expect(fieldNames).toEqual(
      expect.arrayContaining([
        'session_id',
        'channel',
        'channel_name',
        'conversation_type',
        'thread_ts',
        'message_ts',
        'team_id',
        'user_id',
        'user_name',
        'user_email',
        'bot_user_id',
        'devrev_user_id',
        'temp_message_ts',
        'status',
        'generation',
        'previous_session_id',
        'end_reason',
        'message_count',
        'created_at_ms',
        'last_used_at_ms',
        'expires_at_ms',
        'hard_expires_at_ms',
      ])
    );
    // session_id is immutable; everything else is mutable.
    const sessionIdField = call.fields.find((f: any) => f.name === 'session_id');
    expect(sessionIdField.is_immutable).toBe(true);
    for (const field of call.fields) {
      if (field.name !== 'session_id') {
        expect(field.is_immutable).toBe(false);
      }
    }
    expect(result).toEqual(
      expect.objectContaining({
        schemas: expect.any(Array),
        status: 'active',
      })
    );
  });

  test('reports error when schema creation fails', async () => {
    mockCustomSchemaFragmentsSet.mockRejectedValueOnce(new Error('boom'));

    const result = await run([activateEvent]);

    expect(result.status).toBe('error');
    expect(result.schemas.some((s: any) => s.status === 'error')).toBe(true);
  });

  test('ignores non-activate events', async () => {
    const result = await run([
      {
        ...activateEvent,
        execution_metadata: {
          ...activateEvent.execution_metadata,
          event_type: 'ai_agent_response',
        },
      },
    ]);

    expect(result).toEqual(expect.objectContaining({ status: 'ignored' }));
    expect(mockCustomSchemaFragmentsSet).not.toHaveBeenCalled();
  });
});
