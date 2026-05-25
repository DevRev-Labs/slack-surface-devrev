import {
  extractConversationReference,
  generateSessionId,
  ConversationReference,
} from '../conversation-store';

describe('conversation-store helpers', () => {
  test('should extract conversation reference from Slack event', () => {
    const event = {
      channel: 'C0123456789',
      user: 'U0123456789',
      ts: '1705315800.000100',
      thread_ts: '1705315799.000050',
      team: 'T0123456789',
    };

    const extracted: ConversationReference = extractConversationReference(event);
    expect(extracted.channel).toBe('C0123456789');
    expect(extracted.userId).toBe('U0123456789');
    expect(extracted.messageTs).toBe('1705315800.000100');
    expect(extracted.threadTs).toBe('1705315799.000050');
    expect(extracted.teamId).toBe('T0123456789');
    expect(extracted.timestamp).toBeGreaterThan(0);
  });

  test('should generate deterministic session ID from Slack event', () => {
    const event = {
      channel: 'C0123456789',
      ts: '1705315800.000100',
    };

    const sid = generateSessionId(event);
    expect(sid).toBe('slack-C0123456789-1705315800.000100');
  });

  test('should use thread_ts for session ID when in a thread', () => {
    const event = {
      channel: 'C0123456789',
      ts: '1705315800.000100',
      thread_ts: '1705315799.000050',
    };

    const sid = generateSessionId(event);
    // Should use thread_ts for session continuity within threads
    expect(sid).toBe('slack-C0123456789-1705315799.000050');
  });

  test('should handle missing fields in event extraction', () => {
    const event = {};
    const extracted = extractConversationReference(event);
    expect(extracted.channel).toBe('');
    expect(extracted.userId).toBe('');
    expect(extracted.messageTs).toBe('');
  });
});
