import {
  storeConversationReference,
  getConversationReference,
  removeConversationReference,
  extractConversationReference,
  generateSessionId,
  ConversationReference,
} from '../conversation-store';

describe('conversation-store', () => {
  const sessionId = 'test-session';
  const reference: ConversationReference = {
    channel: 'C0123456789',
    userId: 'U0123456789',
    threadTs: '1705315800.000100',
    messageTs: '1705315800.000100',
    teamId: 'T0123456789',
    timestamp: Date.now(),
  };

  beforeEach(() => {
    removeConversationReference(sessionId);
  });

  test('should store and retrieve a conversation reference', () => {
    storeConversationReference(sessionId, reference);
    const retrieved = getConversationReference(sessionId);
    expect(retrieved).toEqual(reference);
  });

  test('should remove a conversation reference', () => {
    storeConversationReference(sessionId, reference);
    removeConversationReference(sessionId);
    const retrieved = getConversationReference(sessionId);
    expect(retrieved).toBeUndefined();
  });

  test('should extract conversation reference from Slack event', () => {
    const event = {
      channel: 'C0123456789',
      user: 'U0123456789',
      ts: '1705315800.000100',
      thread_ts: '1705315799.000050',
      team: 'T0123456789',
    };

    const extracted = extractConversationReference(event);
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

  test('should cleanup old references when storing new ones', () => {
    jest.useFakeTimers();
    const now = Date.now();
    jest.setSystemTime(now);

    const oldReference = { ...reference, timestamp: now };
    const oldSessionId = 'old-session';

    storeConversationReference(oldSessionId, oldReference);
    expect(getConversationReference(oldSessionId)).toEqual(oldReference);

    // Move time forward by 2 hours
    const futureTime = now + 2 * 60 * 60 * 1000;
    jest.setSystemTime(futureTime);

    // Update the new reference timestamp so it's not cleaned up immediately
    const newReference = { ...reference, timestamp: futureTime };

    // Storing a new reference should trigger cleanup of the old one
    storeConversationReference('new-session', newReference);
    expect(getConversationReference(oldSessionId)).toBeUndefined();
    expect(getConversationReference('new-session')).toEqual(newReference);

    jest.useRealTimers();
  });

  test('should store and retrieve tempMessageTs', () => {
    const refWithTemp: ConversationReference = {
      ...reference,
      tempMessageTs: '1705315801.000200',
    };

    storeConversationReference(sessionId, refWithTemp);
    const retrieved = getConversationReference(sessionId);
    expect(retrieved?.tempMessageTs).toBe('1705315801.000200');
  });
});
