/**
 * Tests for the small slack-auth helpers extracted out of slack_handler.
 *
 * isValidEmail: weeds out clearly malformed strings the operator might paste
 * into the mock_email_address input. NOT a full RFC-5322 parser.
 *
 * resolveUserProfile: composes Slack's getUserProfile with an optional
 * mock-email override. Display name always comes from Slack so logs/audit
 * remain accurate to the real submitter.
 */

import * as slackClient from '../slack-client';
import { isValidEmail, resolveUserProfile } from '../slack-auth';

jest.mock('../slack-client');
const mockedSlackClient = slackClient as jest.Mocked<typeof slackClient>;

describe('isValidEmail', () => {
  it('accepts standard addresses', () => {
    expect(isValidEmail('alice@devrev.ai')).toBe(true);
    expect(isValidEmail('alice+tag@example.co.uk')).toBe(true);
  });

  it('rejects strings without an @', () => {
    expect(isValidEmail('alice.devrev.ai')).toBe(false);
    expect(isValidEmail('plain-string')).toBe(false);
  });

  it('rejects strings without a domain dot', () => {
    expect(isValidEmail('alice@localhost')).toBe(false);
  });

  it('rejects empty / whitespace strings', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('   ')).toBe(false);
  });

  it('rejects addresses containing spaces', () => {
    expect(isValidEmail('alice @devrev.ai')).toBe(false);
    expect(isValidEmail('alice@dev rev.ai')).toBe(false);
  });

  it('rejects strings missing the local part', () => {
    expect(isValidEmail('@devrev.ai')).toBe(false);
  });

  it('returns quickly on adversarial inputs (ReDoS regression)', () => {
    // CodeQL js/polynomial-redos previously flagged `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
    // because the two `[^\s@]+` ranges plus a literal `.` (which is itself in
    // the class) backtrack polynomially on inputs like `!@!.!.!.....`. Guard
    // against regressing back to that shape: a 5_000-char malicious string
    // must complete well under a second.
    const malicious = '!@' + '!.'.repeat(5_000);
    const start = Date.now();
    const result = isValidEmail(malicious);
    const elapsedMs = Date.now() - start;
    expect(typeof result).toBe('boolean');
    expect(elapsedMs).toBeLessThan(100);
  });
});

describe('resolveUserProfile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns Slack profile verbatim when mockEmail is null', async () => {
    mockedSlackClient.getUserProfile.mockResolvedValue({ email: 'alice@devrev.ai', name: 'Alice' });
    const result = await resolveUserProfile('U1', 'xoxb-test', null);
    expect(result).toEqual({ email: 'alice@devrev.ai', name: 'Alice' });
    expect(mockedSlackClient.getUserProfile).toHaveBeenCalledWith('U1', 'xoxb-test');
  });

  it('overrides email with mockEmail but keeps the real Slack display name', async () => {
    // Even when an operator forces a mock identity, audit logs should still
    // surface the real submitter's name.
    mockedSlackClient.getUserProfile.mockResolvedValue({ email: 'real@x.com', name: 'Real Name' });
    const result = await resolveUserProfile('U1', 'xoxb-test', 'mock@devrev.ai');
    expect(result).toEqual({ email: 'mock@devrev.ai', name: 'Real Name' });
  });

  it('returns mockEmail with name=null when Slack profile lookup yields nothing', async () => {
    mockedSlackClient.getUserProfile.mockResolvedValue({ email: null, name: null });
    const result = await resolveUserProfile('U1', 'xoxb-test', 'mock@devrev.ai');
    expect(result).toEqual({ email: 'mock@devrev.ai', name: null });
  });

  it('returns nulls when both Slack and mockEmail are absent', async () => {
    mockedSlackClient.getUserProfile.mockResolvedValue({ email: null, name: null });
    const result = await resolveUserProfile('U1', 'xoxb-test', null);
    expect(result).toEqual({ email: null, name: null });
  });
});
