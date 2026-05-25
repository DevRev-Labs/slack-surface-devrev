import { createHmac } from 'crypto';
import { validateSlackSignature } from '../slack-signature-validator';

const HEX64 = 'a'.repeat(64);

function nowTs(offsetSec = 0): string {
  return String(Math.floor(Date.now() / 1000) + offsetSec);
}

function signSlack(secret: string, ts: string, rawBodyUtf8: string): string {
  const sigBase = `v0:${ts}:${rawBodyUtf8}`;
  return 'v0=' + createHmac('sha256', secret).update(sigBase).digest('hex');
}

describe('validateSlackSignature (header-presence gate)', () => {
  const sampleBody = { type: 'event_callback', event: { type: 'app_mention', text: 'hi' } };

  test('rejects when X-Slack-Signature header is absent', () => {
    const result = validateSlackSignature(undefined, { 'x-slack-request-timestamp': nowTs() }, sampleBody);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/X-Slack-Signature/i);
  });

  test('rejects when X-Slack-Request-Timestamp header is absent', () => {
    const result = validateSlackSignature(undefined, { 'x-slack-signature': `v0=${HEX64}` }, sampleBody);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Timestamp/i);
  });

  test('rejects when signature is not in v0=<hex64> form', () => {
    const result = validateSlackSignature(
      undefined,
      { 'x-slack-signature': 'v0=tooShort', 'x-slack-request-timestamp': nowTs() },
      sampleBody,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/v0=/i);
  });

  test('rejects when signature has wrong prefix', () => {
    const result = validateSlackSignature(
      undefined,
      { 'x-slack-signature': `v1=${HEX64}`, 'x-slack-request-timestamp': nowTs() },
      sampleBody,
    );
    expect(result.valid).toBe(false);
  });

  test('rejects when timestamp is older than 5 minutes', () => {
    const result = validateSlackSignature(
      undefined,
      { 'x-slack-signature': `v0=${HEX64}`, 'x-slack-request-timestamp': nowTs(-6 * 60) },
      sampleBody,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/replay|window/i);
  });

  test('rejects when timestamp is non-numeric', () => {
    const result = validateSlackSignature(
      undefined,
      { 'x-slack-signature': `v0=${HEX64}`, 'x-slack-request-timestamp': 'not-a-number' },
      sampleBody,
    );
    expect(result.valid).toBe(false);
  });

  test('accepts a well-formed Slack-style request', () => {
    const result = validateSlackSignature(
      undefined,
      { 'x-slack-signature': `v0=${HEX64}`, 'x-slack-request-timestamp': nowTs() },
      sampleBody,
    );
    expect(result.valid).toBe(true);
  });

  test('accepts headers regardless of casing (HTTP headers are case-insensitive)', () => {
    const result = validateSlackSignature(
      undefined,
      { 'X-Slack-Signature': `v0=${HEX64}`, 'X-Slack-Request-Timestamp': nowTs() },
      sampleBody,
    );
    expect(result.valid).toBe(true);
  });

  describe('HMAC verification (when body_raw + signing_secret are provided)', () => {
    const SECRET = 'test-signing-secret';
    const RAW = '{"type":"event_callback","event":{"type":"app_mention","text":"hi"}}';
    const RAW_B64 = Buffer.from(RAW, 'utf8').toString('base64');

    test('accepts a request with a correctly-computed HMAC', () => {
      const ts = nowTs();
      const sig = signSlack(SECRET, ts, RAW);
      const result = validateSlackSignature(
        SECRET,
        { 'x-slack-signature': sig, 'x-slack-request-timestamp': ts },
        sampleBody,
        RAW_B64,
      );
      expect(result.valid).toBe(true);
    });

    test('rejects a request with the wrong HMAC (forged signature)', () => {
      const ts = nowTs();
      const result = validateSlackSignature(
        SECRET,
        { 'x-slack-signature': `v0=${HEX64}`, 'x-slack-request-timestamp': ts },
        sampleBody,
        RAW_B64,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/HMAC/i);
    });

    test('rejects when body_raw is tampered after signing', () => {
      const ts = nowTs();
      const sig = signSlack(SECRET, ts, RAW);
      const tamperedRawB64 = Buffer.from(RAW + ' ', 'utf8').toString('base64');
      const result = validateSlackSignature(
        SECRET,
        { 'x-slack-signature': sig, 'x-slack-request-timestamp': ts },
        sampleBody,
        tamperedRawB64,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/HMAC/i);
    });

    test('rejects when signing secret is wrong', () => {
      const ts = nowTs();
      const sig = signSlack(SECRET, ts, RAW);
      const result = validateSlackSignature(
        'different-secret',
        { 'x-slack-signature': sig, 'x-slack-request-timestamp': ts },
        sampleBody,
        RAW_B64,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/HMAC/i);
    });

    test('falls back to header-presence gate when body_raw is absent', () => {
      const result = validateSlackSignature(
        SECRET,
        { 'x-slack-signature': `v0=${HEX64}`, 'x-slack-request-timestamp': nowTs() },
        sampleBody,
        undefined,
      );
      expect(result.valid).toBe(true);
    });
  });
});
