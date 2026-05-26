/**
 * Session-management configuration constants and helpers.
 *
 * Values are read from snap-in global_values when available, otherwise
 * sensible defaults are used. All durations are exposed in milliseconds
 * so callers can do simple `Date.now() + ttl` math.
 */

export const SESSION_LEAF_TYPE = 'slack_ai_session';
export const SESSION_LEAF_TYPE_ID_PREFIX = 'SLSES';
export const SESSION_LEAF_TYPE_DESCRIPTION =
  'Persistent record of a Slack ↔ DevRev AI Agent session, including identity, expiry and audit fields.';

export interface SessionTimingConfig {
  idleTtlMs: number;
  absoluteTtlMs: number;
}

const DEFAULT_IDLE_TTL_MIN = 8 * 60;       // 8 hours
const DEFAULT_ABSOLUTE_TTL_HOURS = 24;     // 24 hours

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

export function readSessionTimingConfig(globalValues: Record<string, any> = {}): SessionTimingConfig {
  const idleMin = readNumber(globalValues['session_idle_timeout_minutes'], DEFAULT_IDLE_TTL_MIN);
  const absHours = readNumber(globalValues['session_absolute_timeout_hours'], DEFAULT_ABSOLUTE_TTL_HOURS);

  return {
    idleTtlMs: idleMin * 60 * 1000,
    absoluteTtlMs: absHours * 60 * 60 * 1000,
  };
}
