/**
 * Unit tests for session-config helpers (src/utils/session-config.ts).
 *
 * Tests cover:
 *   - Default timing values when no global_values are provided.
 *   - Override via numeric global_values.
 *   - Override via string global_values.
 *   - Invalid / zero / negative values fall back to defaults.
 *   - SESSION_LEAF_TYPE and description are exported constants.
 */

import {
  readSessionTimingConfig,
  SESSION_LEAF_TYPE,
  SESSION_LEAF_TYPE_DESCRIPTION,
} from '../session-config';

describe('SESSION_LEAF_TYPE', () => {
  it('equals "conversation"', () => {
    expect(SESSION_LEAF_TYPE).toBe('conversation');
  });

  it('SESSION_LEAF_TYPE_DESCRIPTION is a non-empty string', () => {
    expect(typeof SESSION_LEAF_TYPE_DESCRIPTION).toBe('string');
    expect(SESSION_LEAF_TYPE_DESCRIPTION.length).toBeGreaterThan(0);
  });
});

describe('readSessionTimingConfig', () => {
  it('returns defaults when called with no arguments', () => {
    const timing = readSessionTimingConfig();
    // Default idle = 480 min = 8h in ms
    expect(timing.idleTtlMs).toBe(480 * 60 * 1000);
    // Default absolute = 24h in ms
    expect(timing.absoluteTtlMs).toBe(24 * 60 * 60 * 1000);
  });

  it('returns defaults when called with an empty object', () => {
    const timing = readSessionTimingConfig({});
    expect(timing.idleTtlMs).toBe(480 * 60 * 1000);
    expect(timing.absoluteTtlMs).toBe(24 * 60 * 60 * 1000);
  });

  it('uses numeric overrides from globalValues', () => {
    const timing = readSessionTimingConfig({
      session_absolute_timeout_hours: 48,
      session_idle_timeout_minutes: 60,
    });
    expect(timing.idleTtlMs).toBe(60 * 60 * 1000);
    expect(timing.absoluteTtlMs).toBe(48 * 60 * 60 * 1000);
  });

  it('parses string numeric overrides', () => {
    const timing = readSessionTimingConfig({
      session_absolute_timeout_hours: '12',
      session_idle_timeout_minutes: '30',
    });
    expect(timing.idleTtlMs).toBe(30 * 60 * 1000);
    expect(timing.absoluteTtlMs).toBe(12 * 60 * 60 * 1000);
  });

  it('falls back to default when idle timeout is 0', () => {
    const timing = readSessionTimingConfig({ session_idle_timeout_minutes: 0 });
    expect(timing.idleTtlMs).toBe(480 * 60 * 1000);
  });

  it('falls back to default when absolute timeout is negative', () => {
    const timing = readSessionTimingConfig({ session_absolute_timeout_hours: -1 });
    expect(timing.absoluteTtlMs).toBe(24 * 60 * 60 * 1000);
  });

  it('falls back to default when idle timeout is a non-numeric string', () => {
    const timing = readSessionTimingConfig({ session_idle_timeout_minutes: 'invalid' });
    expect(timing.idleTtlMs).toBe(480 * 60 * 1000);
  });

  it('falls back to default when override is null', () => {
    const timing = readSessionTimingConfig({ session_idle_timeout_minutes: null });
    expect(timing.idleTtlMs).toBe(480 * 60 * 1000);
  });
});
