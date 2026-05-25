import { validateSlackSignature } from '../slack-signature-validator';

const HEX64 = 'a'.repeat(64);

function nowTs(offsetSec = 0): string {
  return String(Math.floor(Date.now() / 1000) + offsetSec);
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
});
