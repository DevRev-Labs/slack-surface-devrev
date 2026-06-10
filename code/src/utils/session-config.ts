/**
 * Session-management configuration constants and helpers.
 *
 * Values are read from snap-in global_values when available, otherwise
 * sensible defaults are used. All durations are exposed in milliseconds
 * so callers can do simple `Date.now() + ttl` math.
 */

import { DEFAULT_SESSION_ABSOLUTE_TTL_HOURS, DEFAULT_SESSION_IDLE_TTL_MINUTES } from '../config';

// Built-in DevRev leaf type that backs the session record. Sessions live as
// `conversation` objects with the Slack session fields attached as custom
// fields, rather than as a bespoke custom-leaf-type.
export const SESSION_LEAF_TYPE = 'conversation';

export const SESSION_LEAF_TYPE_DESCRIPTION =
  'Custom fields on conversation that capture Slack ↔ DevRev AI Agent session identity, expiry and audit data.';

export interface SessionTimingConfig {
  idleTtlMs: number;
  absoluteTtlMs: number;
}

// Aliases from the central config so all defaults live in one place.
const DEFAULT_IDLE_TTL_MIN = DEFAULT_SESSION_IDLE_TTL_MINUTES;
const DEFAULT_ABSOLUTE_TTL_HOURS = DEFAULT_SESSION_ABSOLUTE_TTL_HOURS;

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
    absoluteTtlMs: absHours * 60 * 60 * 1000,
    idleTtlMs: idleMin * 60 * 1000,
  };
}
