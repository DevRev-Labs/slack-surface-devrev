/**
 * Tests for the body-parsing helpers extracted from slack_interactivity.
 *
 * These helpers exist because Slack's `application/x-www-form-urlencoded`
 * bodies arrive in three different shapes through the DevRev gateway:
 *  1. Already-parsed object with form fields as keys
 *  2. Raw URL-encoded string
 *  3. Empty object whose bytes are in `body_raw` (base64)
 *
 * Each helper handles one of those shape transitions purely.
 */

import { bodyHasUsefulKey, decodeBase64BodyRaw, parseFormUrlEncoded, tryPromotePayloadField } from '../slack-form-body';

describe('parseFormUrlEncoded', () => {
  it('parses a Slack-style slash-command body', () => {
    const raw = 'command=%2Fsda-agent-feedback&user_id=U123&channel_id=C456&trigger_id=trig.001';
    expect(parseFormUrlEncoded(raw)).toEqual({
      channel_id: 'C456',
      command: '/sda-agent-feedback',
      trigger_id: 'trig.001',
      user_id: 'U123',
    });
  });

  it('decodes "+" as space (Slack convention)', () => {
    expect(parseFormUrlEncoded('text=hello+world')).toEqual({ text: 'hello world' });
  });

  it('handles a bare key with no value', () => {
    expect(parseFormUrlEncoded('foo')).toEqual({ foo: '' });
  });

  it('handles a key with empty value', () => {
    expect(parseFormUrlEncoded('foo=')).toEqual({ foo: '' });
  });

  it('skips empty segments from leading/trailing/duplicate ampersands', () => {
    expect(parseFormUrlEncoded('&&a=1&&b=2&')).toEqual({ a: '1', b: '2' });
  });

  it('survives malformed percent-encoding by keeping raw bytes', () => {
    // %ZZ is not a valid escape; we keep the raw key/value pair verbatim
    // rather than throwing — one bad pair must not kill the whole parse.
    const result = parseFormUrlEncoded('a=ok&b=%ZZbroken');
    expect(result['a']).toBe('ok');
    expect(result['b']).toBe('%ZZbroken');
  });

  it('returns an empty object for an empty input', () => {
    expect(parseFormUrlEncoded('')).toEqual({});
  });

  it('uses last-write-wins for duplicate keys (matches URLSearchParams)', () => {
    expect(parseFormUrlEncoded('k=first&k=second')).toEqual({ k: 'second' });
  });
});

describe('bodyHasUsefulKey', () => {
  it('accepts bodies with a `command` field (slash command)', () => {
    expect(bodyHasUsefulKey({ command: '/sda-agent-feedback' })).toBe(true);
  });

  it('accepts bodies with a `type` field (Block-Kit interactivity)', () => {
    expect(bodyHasUsefulKey({ type: 'view_submission' })).toBe(true);
  });

  it('accepts bodies with a `payload` field (legacy form-encoded wrapper)', () => {
    expect(bodyHasUsefulKey({ payload: '{"type":"block_actions"}' })).toBe(true);
  });

  it('rejects bodies missing all three discriminators', () => {
    expect(bodyHasUsefulKey({ user: 'U1' })).toBe(false);
    expect(bodyHasUsefulKey({})).toBe(false);
  });

  it('rejects null / undefined / non-objects', () => {
    expect(bodyHasUsefulKey(null)).toBe(false);
    expect(bodyHasUsefulKey(undefined)).toBe(false);
    expect(bodyHasUsefulKey('a string')).toBe(false);
    expect(bodyHasUsefulKey(42)).toBe(false);
  });

  it('rejects when the discriminator is present but not a string', () => {
    expect(bodyHasUsefulKey({ type: 42 })).toBe(false);
    expect(bodyHasUsefulKey({ command: null })).toBe(false);
  });
});

describe('decodeBase64BodyRaw', () => {
  it('decodes a valid base64 form body to UTF-8', () => {
    const raw = Buffer.from('command=/sda-agent-feedback', 'utf8').toString('base64');
    expect(decodeBase64BodyRaw(raw)).toBe('command=/sda-agent-feedback');
  });

  it('returns null on invalid base64', () => {
    // Buffer.from is permissive (it ignores invalid chars), so we exercise
    // the catch branch by passing a non-string value cast as string. In
    // practice, callers only see this when bodyRaw arrives mangled.
    expect(decodeBase64BodyRaw(undefined as unknown as string)).toBeNull();
  });

  it('returns an empty string for empty input (not null)', () => {
    // Distinguish "no input" (handled by caller via the `if (bodyRaw)` guard)
    // from "valid but empty after decoding".
    expect(decodeBase64BodyRaw('')).toBe('');
  });
});

describe('tryPromotePayloadField', () => {
  it('parses and returns the payload JSON when present', () => {
    const body = { payload: JSON.stringify({ type: 'view_submission', user: { id: 'U1' } }) };
    const promoted = tryPromotePayloadField(body);
    expect(promoted).toEqual({ type: 'view_submission', user: { id: 'U1' } });
  });

  it('returns null when payload field is absent', () => {
    expect(tryPromotePayloadField({ command: '/sda-agent-feedback' })).toBeNull();
  });

  it('returns null when payload field is present but not a string', () => {
    expect(tryPromotePayloadField({ payload: 42 })).toBeNull();
  });

  it('returns null when payload is malformed JSON (caller decides what to do)', () => {
    // Caller can fall back to the original body so signature verification
    // still sees the bytes Slack actually sent.
    expect(tryPromotePayloadField({ payload: '{not json' })).toBeNull();
  });

  it('returns null on null / non-objects', () => {
    expect(tryPromotePayloadField(null)).toBeNull();
    expect(tryPromotePayloadField('a string')).toBeNull();
    expect(tryPromotePayloadField(undefined)).toBeNull();
  });
});
