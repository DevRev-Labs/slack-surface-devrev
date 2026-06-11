/**
 * Session-management configuration constants and helpers.
 *
 * Values are read from snap-in global_values when available, otherwise
 * sensible defaults are used. All durations are exposed in milliseconds
 * so callers can do simple `Date.now() + ttl` math.
 */

/**
 * Built-in DevRev leaf type that backs each session record. We attach the
 * Slack session fields as a tenant-fragment schema to this existing leaf
 * type rather than introducing a bespoke custom leaf.
 */
export const SESSION_LEAF_TYPE = 'conversation';

/** Human-readable description used by the schema-management endpoint. */
export const SESSION_LEAF_TYPE_DESCRIPTION =
  'Custom fields on conversation that capture Slack ↔ DevRev AI Agent session identity, expiry and audit data.';

/**
 * Idle vs absolute lifetime TTLs, both in milliseconds so callers can do
 * `Date.now() + ttl` math directly.
 *  - `idleTtlMs`: time without activity before the session is GC-marked expired.
 *  - `absoluteTtlMs`: hard ceiling regardless of activity; record is deleted.
 */
export interface SessionTimingConfig {
  idleTtlMs: number;
  absoluteTtlMs: number;
}

const DEFAULT_IDLE_TTL_MIN = 8 * 60;
const DEFAULT_ABSOLUTE_TTL_HOURS = 24;

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

/**
 * Resolve session-timing TTLs from the snap-in's `global_values`, falling back
 * to the documented defaults. Returns milliseconds — never validates against
 * `globalValues` having extra keys, by design.
 *
 * @param globalValues The `input_data.global_values` blob from FunctionInput.
 */
export function readSessionTimingConfig(globalValues: Record<string, any> = {}): SessionTimingConfig {
  const idleMin = readNumber(globalValues['session_idle_timeout_minutes'], DEFAULT_IDLE_TTL_MIN);
  const absHours = readNumber(globalValues['session_absolute_timeout_hours'], DEFAULT_ABSOLUTE_TTL_HOURS);

  return {
    absoluteTtlMs: absHours * 60 * 60 * 1000,
    idleTtlMs: idleMin * 60 * 1000,
  };
}
