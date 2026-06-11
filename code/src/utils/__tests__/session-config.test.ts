/**
 * Tests for readSessionTimingConfig — the small helper that reads idle and
 * absolute TTLs from the snap-in's `global_values`, falling back to the
 * documented defaults.
 *
 * The function is the single source of truth for "what counts as an idle
 * session", so the input-validation matrix here directly maps to the
 * runtime behavior we promise in defaults.ts.
 */

import { readSessionTimingConfig } from '../session-config';

const MS_PER_MIN = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MIN;

const DEFAULT_IDLE_MS = 8 * 60 * MS_PER_MIN;
const DEFAULT_ABSOLUTE_MS = 24 * MS_PER_HOUR;

describe('readSessionTimingConfig', () => {
  it('returns documented defaults when global_values is empty', () => {
    expect(readSessionTimingConfig({})).toEqual({
      absoluteTtlMs: DEFAULT_ABSOLUTE_MS,
      idleTtlMs: DEFAULT_IDLE_MS,
    });
  });

  it('returns defaults when global_values is omitted entirely', () => {
    expect(readSessionTimingConfig()).toEqual({
      absoluteTtlMs: DEFAULT_ABSOLUTE_MS,
      idleTtlMs: DEFAULT_IDLE_MS,
    });
  });

  it('honours numeric overrides for both fields', () => {
    const result = readSessionTimingConfig({
      session_absolute_timeout_hours: 12,
      session_idle_timeout_minutes: 90,
    });
    expect(result.idleTtlMs).toBe(90 * MS_PER_MIN);
    expect(result.absoluteTtlMs).toBe(12 * MS_PER_HOUR);
  });

  it('parses string-numeric overrides (snap-in inputs sometimes serialize as text)', () => {
    const result = readSessionTimingConfig({
      session_absolute_timeout_hours: '6',
      session_idle_timeout_minutes: '15',
    });
    expect(result.idleTtlMs).toBe(15 * MS_PER_MIN);
    expect(result.absoluteTtlMs).toBe(6 * MS_PER_HOUR);
  });

  it('rejects non-numeric strings and falls back to defaults', () => {
    const result = readSessionTimingConfig({
      session_absolute_timeout_hours: 'forever',
      session_idle_timeout_minutes: 'not-a-number',
    });
    expect(result.idleTtlMs).toBe(DEFAULT_IDLE_MS);
    expect(result.absoluteTtlMs).toBe(DEFAULT_ABSOLUTE_MS);
  });

  it('rejects zero and negative values (must be > 0) and falls back', () => {
    const result = readSessionTimingConfig({
      session_absolute_timeout_hours: 0,
      session_idle_timeout_minutes: -10,
    });
    expect(result.idleTtlMs).toBe(DEFAULT_IDLE_MS);
    expect(result.absoluteTtlMs).toBe(DEFAULT_ABSOLUTE_MS);
  });

  it('rejects NaN / non-finite numbers and falls back', () => {
    const result = readSessionTimingConfig({
      session_absolute_timeout_hours: Number.POSITIVE_INFINITY,
      session_idle_timeout_minutes: Number.NaN,
    });
    expect(result.idleTtlMs).toBe(DEFAULT_IDLE_MS);
    expect(result.absoluteTtlMs).toBe(DEFAULT_ABSOLUTE_MS);
  });

  it('treats an empty / whitespace string as missing and falls back', () => {
    const result = readSessionTimingConfig({
      session_absolute_timeout_hours: '   ',
      session_idle_timeout_minutes: '',
    });
    expect(result.idleTtlMs).toBe(DEFAULT_IDLE_MS);
    expect(result.absoluteTtlMs).toBe(DEFAULT_ABSOLUTE_MS);
  });

  it('lets one valid override coexist with one invalid (per-field fallback)', () => {
    const result = readSessionTimingConfig({
      session_absolute_timeout_hours: 'oops',
      session_idle_timeout_minutes: 30,
    });
    expect(result.idleTtlMs).toBe(30 * MS_PER_MIN);
    expect(result.absoluteTtlMs).toBe(DEFAULT_ABSOLUTE_MS);
  });

  it('ignores unrelated keys in global_values', () => {
    const result = readSessionTimingConfig({
      ai_agent_id: 'don:core:dvrv-us-1:devo/x:ai_agent/y',
      mock_email_address: 'someone@devrev.ai',
    });
    expect(result).toEqual({
      absoluteTtlMs: DEFAULT_ABSOLUTE_MS,
      idleTtlMs: DEFAULT_IDLE_MS,
    });
  });
});
