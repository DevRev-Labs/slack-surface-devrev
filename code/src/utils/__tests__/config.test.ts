/**
 * Unit tests for the centralised configuration module (src/config.ts).
 *
 * These tests verify that:
 *   - All public constants are exported with the correct types and values.
 *   - Numeric constants stay within reasonable bounds (e.g. TTL > 0).
 *   - Session reset phrases are present and case-normalised.
 *   - The TENANT_FRAGMENT_SCHEMA_SPEC object has both required fields.
 *   - LOG_TAG keys map to non-empty strings and match the expected names.
 */

import {
  ACT_AS_TOKEN_EXPIRES_IN_SECONDS,
  ACT_AS_TOKEN_TTL_MINUTES,
  DEFAULT_SESSION_ABSOLUTE_TTL_HOURS,
  DEFAULT_SESSION_IDLE_TTL_MINUTES,
  DEVREV_API_BASE,
  DEVREV_CONVERSATION_TYPE,
  DEVREV_SOURCE_CHANNEL_SLACK,
  DEVREV_TEXT_FIELD_MAX_LENGTH,
  LOG_TAG,
  PROGRESS_SEARCHING_MESSAGE,
  SESSION_RESET_CONFIRMATION_MESSAGE,
  SESSION_RESET_PHRASES,
  SLACK_API_BASE,
  SLACK_SIGNATURE_MAX_AGE_SECONDS,
  TENANT_FRAGMENT_SCHEMA_SPEC,
  WEBHOOK_ACTIVE_POLL_INTERVAL_MS,
  WEBHOOK_ACTIVE_WAIT_MAX_MS,
} from '../../config';

describe('Slack constants', () => {
  it('SLACK_API_BASE is a valid HTTPS URL', () => {
    expect(SLACK_API_BASE).toMatch(/^https:\/\//);
  });

  it('SLACK_SIGNATURE_MAX_AGE_SECONDS is 300 (5 minutes)', () => {
    expect(SLACK_SIGNATURE_MAX_AGE_SECONDS).toBe(300);
  });

  it('SESSION_RESET_PHRASES contains "new session" and "/clear"', () => {
    expect(SESSION_RESET_PHRASES.has('new session')).toBe(true);
    expect(SESSION_RESET_PHRASES.has('/clear')).toBe(true);
  });

  it('PROGRESS_SEARCHING_MESSAGE is a non-empty string', () => {
    expect(typeof PROGRESS_SEARCHING_MESSAGE).toBe('string');
    expect(PROGRESS_SEARCHING_MESSAGE.length).toBeGreaterThan(0);
  });

  it('SESSION_RESET_CONFIRMATION_MESSAGE is a non-empty string', () => {
    expect(typeof SESSION_RESET_CONFIRMATION_MESSAGE).toBe('string');
    expect(SESSION_RESET_CONFIRMATION_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe('DevRev constants', () => {
  it('DEVREV_API_BASE is a valid HTTPS URL', () => {
    expect(DEVREV_API_BASE).toMatch(/^https:\/\//);
  });

  it('ACT_AS_TOKEN_TTL_MINUTES is a positive integer', () => {
    expect(ACT_AS_TOKEN_TTL_MINUTES).toBeGreaterThan(0);
    expect(Number.isInteger(ACT_AS_TOKEN_TTL_MINUTES)).toBe(true);
  });

  it('ACT_AS_TOKEN_EXPIRES_IN_SECONDS is 360', () => {
    expect(ACT_AS_TOKEN_EXPIRES_IN_SECONDS).toBe(360);
  });

  it('DEVREV_CONVERSATION_TYPE equals "support"', () => {
    expect(DEVREV_CONVERSATION_TYPE).toBe('support');
  });

  it('DEVREV_SOURCE_CHANNEL_SLACK equals "slack"', () => {
    expect(DEVREV_SOURCE_CHANNEL_SLACK).toBe('slack');
  });

  it('TENANT_FRAGMENT_SCHEMA_SPEC has tenant_fragment=true and validate_required_fields=true', () => {
    expect(TENANT_FRAGMENT_SCHEMA_SPEC.tenant_fragment).toBe(true);
    expect(TENANT_FRAGMENT_SCHEMA_SPEC.validate_required_fields).toBe(true);
  });

  it('DEVREV_TEXT_FIELD_MAX_LENGTH is 255', () => {
    expect(DEVREV_TEXT_FIELD_MAX_LENGTH).toBe(255);
  });
});

describe('Session defaults', () => {
  it('DEFAULT_SESSION_IDLE_TTL_MINUTES is 480 (8h)', () => {
    expect(DEFAULT_SESSION_IDLE_TTL_MINUTES).toBe(480);
  });

  it('DEFAULT_SESSION_ABSOLUTE_TTL_HOURS is 24', () => {
    expect(DEFAULT_SESSION_ABSOLUTE_TTL_HOURS).toBe(24);
  });
});

describe('Webhook polling constants', () => {
  it('WEBHOOK_ACTIVE_WAIT_MAX_MS is 10 seconds', () => {
    expect(WEBHOOK_ACTIVE_WAIT_MAX_MS).toBe(10_000);
  });

  it('WEBHOOK_ACTIVE_POLL_INTERVAL_MS is 500 ms', () => {
    expect(WEBHOOK_ACTIVE_POLL_INTERVAL_MS).toBe(500);
  });

  it('poll interval is less than max wait so at least one poll fires', () => {
    expect(WEBHOOK_ACTIVE_POLL_INTERVAL_MS).toBeLessThan(WEBHOOK_ACTIVE_WAIT_MAX_MS);
  });
});

describe('LOG_TAG', () => {
  it('all entries are non-empty strings', () => {
    for (const [key, value] of Object.entries(LOG_TAG)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('covers the primary subsystem tags used in the codebase', () => {
    const expected = ['AI', 'AUTH', 'CONV', 'STORE', 'MSG', 'TIMELINE', 'GC', 'FEEDBACK'];
    for (const tag of expected) {
      const found = Object.values(LOG_TAG).some(
        (v) => v.toUpperCase() === tag.toUpperCase()
      );
      expect(found).toBe(true);
    }
  });
});
