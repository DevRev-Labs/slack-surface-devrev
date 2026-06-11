/**
 * Tiny leveled logger used everywhere instead of bare `console.*`.
 *
 * Why a custom logger and not pino/winston?
 *  - Snap-ins run inside a constrained sandbox where startup time and bundle
 *    size matter; a 100-line logger removes a transitive-dependency footprint.
 *  - All output ultimately flows to platform stdout/stderr, so we keep the
 *    underlying writer as `console.*`. The wrapper only adds level filtering,
 *    a uniform prefix, and structured-context formatting.
 *
 * Configuration:
 *  - LOG_LEVEL env var ('error' | 'warn' | 'info' | 'debug'). Default: 'info'.
 *  - Or call `setLogLevel(...)` programmatically (handy in tests / runtime).
 *
 * Conventions for callers:
 *  - error(): unrecoverable failures or boundary errors that need attention
 *  - warn():  recoverable / non-fatal issues we still want visibility on
 *  - info():  normal lifecycle events (start, success, key milestones)
 *  - debug(): verbose tracing useful when triaging — silent in prod by default
 *
 * The logger is intentionally side-effect-free at import time and never throws
 * — a logging failure must never crash request handling.
 */

/** Log severity levels, ordered most → least severe. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Numeric weight for each level so filtering is a simple comparison. */
const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 40,
  error: 10,
  info: 30,
  warn: 20,
};

/** Default level used when no env var / setter override is provided. */
const DEFAULT_LEVEL: LogLevel = 'info';

/**
 * Resolve the initial log level from the environment, falling back to
 * DEFAULT_LEVEL on any malformed / missing value. Case-insensitive.
 */
function resolveInitialLevel(): LogLevel {
  // Bracket access required by TS noPropertyAccessFromIndexSignature.
  const raw = (process.env['LOG_LEVEL'] || '').trim().toLowerCase();
  if (raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug') {
    return raw;
  }
  return DEFAULT_LEVEL;
}

/** Mutable runtime level. Module-private; mutate only via setLogLevel. */
let currentLevel: LogLevel = resolveInitialLevel();

/**
 * Override the active log level at runtime. Useful for:
 *  - `--log-level debug` style CLI flags
 *  - Tests asserting on debug output
 *  - Snap-in global-values driven config
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** Read the current log level (mostly for tests / introspection). */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** True if a message at `level` should be emitted under the current setting. */
function isEnabled(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] <= LEVEL_WEIGHT[currentLevel];
}

/**
 * Render an optional structured-context bag as a single space-prefixed
 * string. Keeps the line greppable while staying compact:
 *
 *   logger.info('webhook created', { id: 'wh_1', status: 'active' });
 *   → "[INFO] webhook created  id=wh_1  status=active"
 *
 * Falls back to JSON.stringify on objects so values like errors/Buffers
 * don't blow up the output.
 */
function formatContext(context?: Record<string, unknown>): string {
  if (!context) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.length ? `  ${parts.join('  ')}` : '';
}

/** Stringify a single context value safely; never throw. */
function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error) return value.message || value.name;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Choose the underlying console sink so error/warn go to stderr. */
function sinkFor(level: LogLevel): (...args: unknown[]) => void {
  switch (level) {
    case 'error':
      return console.error;
    case 'warn':
      return console.warn;
    case 'debug':
      return console.debug;
    default:
      return console.log;
  }
}

/**
 * Coerce a single positional extra into a structured-context entry. Lets
 * callers pass `console.error('msg', err)` style without losing the value,
 * while still getting structured output when an explicit object is passed.
 */
function normalizeExtras(extras: unknown[]): Record<string, unknown> | undefined {
  if (extras.length === 0) return undefined;
  if (extras.length === 1) {
    const only = extras[0];
    if (only !== null && typeof only === 'object' && !(only instanceof Error)) {
      return only as Record<string, unknown>;
    }
    return { detail: only };
  }
  // Multiple positional extras — collect under generic keys so nothing is
  // lost; keeps grep-friendly output without imposing a structure.
  const bag: Record<string, unknown> = {};
  extras.forEach((value, index) => {
    bag[`arg${index}`] = value;
  });
  return bag;
}

/** Emit a single log line. Wraps the sink in try/catch — never throws. */
function emit(level: LogLevel, message: string, extras: unknown[]): void {
  if (!isEnabled(level)) return;
  try {
    const context = normalizeExtras(extras);
    const line = `[${level.toUpperCase()}] ${message}${formatContext(context)}`;
    sinkFor(level)(line);
  } catch {
    // Logging itself failing must never bubble up to request handling.
  }
}

/**
 * Public logger surface. Each method accepts either:
 *   - `logger.info('event', { key: 'value', ... })` — structured context, OR
 *   - `logger.info('event', singleValue)`           — coerced into { detail }, OR
 *   - `logger.info('event', a, b, c)`               — coerced into { arg0, arg1, ... }
 *
 * The lax positional form keeps the migration from `console.*` mechanical
 * (a one-token replace), while still producing greppable output.
 */
export const logger = {
  /** Verbose tracing; silent by default in prod (LOG_LEVEL=info). */
  debug(message: string, ...extras: unknown[]): void {
    emit('debug', message, extras);
  },
  /** Unrecoverable / boundary failure; routes to stderr. */
  error(message: string, ...extras: unknown[]): void {
    emit('error', message, extras);
  },
  /** Normal lifecycle event — kept low-volume. */
  info(message: string, ...extras: unknown[]): void {
    emit('info', message, extras);
  },
  /** Recoverable issue worth surfacing; routes to stderr. */
  warn(message: string, ...extras: unknown[]): void {
    emit('warn', message, extras);
  },
};

/** Test-only export — reset the level back to env-derived default. */
export function _resetLogLevelForTests(): void {
  currentLevel = resolveInitialLevel();
}
