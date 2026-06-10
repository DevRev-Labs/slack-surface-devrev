/**
 * Structured logger with configurable log levels.
 *
 * Log level is controlled by the LOG_LEVEL environment variable (or by
 * calling setLogLevel() at runtime). Valid values are case-insensitive:
 *   DEBUG | INFO | WARN | ERROR | SILENT
 *
 * Default level: INFO — debug messages are suppressed unless explicitly enabled.
 *
 * Usage:
 *   import { createLogger } from '../utils/logger';
 *   const log = createLogger('req-abc', 'AUTH');
 *   log.info('User resolved', { email: 'alice@example.com' });
 *   log.warn('Fallback to service account');
 *   log.error('Token creation failed', { userId });
 *   log.debug('Full payload', { payload });   // only visible when LOG_LEVEL=debug
 *
 * Module-level logger (no request ID):
 *   import { logger } from '../utils/logger';
 *   logger.info('Module initialised');
 */

// ──────────────────────────────────────────────────────────────────────────────
// Level definitions
// ──────────────────────────────────────────────────────────────────────────────

/** All supported log levels ordered from most to least verbose. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/**
 * Numeric priorities so we can compare levels with a simple integer compare.
 * Higher number = less verbose; SILENT suppresses all output.
 */
const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  error: 3,
  info: 1,
  silent: Infinity,
  warn: 2,
};

// ──────────────────────────────────────────────────────────────────────────────
// Runtime level state (module-scoped so all logger instances share it)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Parse a raw string into a valid LogLevel, defaulting to 'info'.
 * Accepts any casing (e.g. 'DEBUG', 'Warn').
 */
function parseLogLevel(raw: string | undefined): LogLevel {
  // Normalise to lower-case and check against the known level keys.
  const normalised = (raw ?? '').toLowerCase().trim() as LogLevel;
  return normalised in LEVEL_PRIORITY ? normalised : 'info';
}

/** Active minimum log level — read from env at module load time. */
let _activeLevel: LogLevel = parseLogLevel(process.env['LOG_LEVEL']);

/**
 * Override the active log level at runtime.
 * Useful in unit tests to switch between DEBUG and SILENT.
 *
 * @param level - New minimum log level.
 */
export function setLogLevel(level: LogLevel): void {
  _activeLevel = level;
}

/** Return the currently active minimum log level. */
export function getLogLevel(): LogLevel {
  return _activeLevel;
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal emit helper
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Format and emit a single log entry to the appropriate console channel.
 * The entry is silently dropped when the entry's level is below the
 * active minimum level.
 *
 * Output format:
 *   [LEVEL] [requestId] [tag] message  {optional metadata JSON}
 *
 * @param level     - The severity of this entry.
 * @param requestId - Optional per-request correlation ID.
 * @param tag       - Short label for the subsystem (e.g. 'AUTH', 'STORE').
 * @param message   - Human-readable description of the event.
 * @param meta      - Optional structured metadata to include after the message.
 */
function emit(
  level: Exclude<LogLevel, 'silent'>,
  requestId: string | undefined,
  tag: string | undefined,
  message: string,
  meta?: Record<string, unknown>
): void {
  // Drop entries below the configured minimum level.
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[_activeLevel]) return;

  // Build the prefix: "[LEVEL] [requestId] [tag]"
  const parts: string[] = [`[${level.toUpperCase().padEnd(5)}]`];
  if (requestId) parts.push(`[${requestId}]`);
  if (tag) parts.push(`[${tag}]`);
  parts.push(message);

  const formattedLine = parts.join(' ');

  // Route to the correct console channel so external log aggregators can
  // filter by severity (e.g. DevRev's built-in snap-in log viewer).
  const consoleFn =
    level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  // Attach metadata inline when present — one console call keeps entries
  // atomically grouped in log viewers.
  if (meta && Object.keys(meta).length > 0) {
    consoleFn(formattedLine, meta);
  } else {
    consoleFn(formattedLine);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Public logger factory
// ──────────────────────────────────────────────────────────────────────────────

/**
 * A logger instance bound to an optional requestId and/or tag.
 * Each method accepts an optional per-call tag override so a single logger
 * instance can write to multiple subsystem tags.
 */
export interface Logger {
  /** High-volume diagnostic messages — suppressed unless LOG_LEVEL=debug. */
  debug(message: string, meta?: Record<string, unknown>, tag?: string): void;
  /** Normal operational events (session created, message sent, etc.). */
  info(message: string, meta?: Record<string, unknown>, tag?: string): void;
  /** Unexpected but recoverable conditions (fallback path taken, retry). */
  warn(message: string, meta?: Record<string, unknown>, tag?: string): void;
  /** Hard failures that prevented an operation from completing. */
  error(message: string, meta?: Record<string, unknown>, tag?: string): void;
}

/**
 * Create a Logger bound to the given requestId and optional default tag.
 * Any call that provides its own `tag` argument overrides the default tag
 * for that individual entry.
 *
 * @param requestId  - Correlation ID from execution_metadata.request_id.
 * @param defaultTag - Default subsystem label (e.g. 'STORE', 'AUTH').
 * @returns A Logger instance.
 *
 * @example
 *   const log = createLogger(event.execution_metadata.request_id, 'AUTH');
 *   log.info('User resolved', { email, devrevUserId });
 *   log.warn('act-as failed, using service account');
 */
export function createLogger(requestId?: string, defaultTag?: string): Logger {
  return {
    // Debug — fine-grained diagnostic data; off by default.
    debug: (message, meta?, tag?) => emit('debug', requestId, tag ?? defaultTag, message, meta),
    // Error — failures that should be investigated.
    error: (message, meta?, tag?) => emit('error', requestId, tag ?? defaultTag, message, meta),
    // Info — normal operational milestones.
    info: (message, meta?, tag?) => emit('info', requestId, tag ?? defaultTag, message, meta),
    // Warn — degraded-but-functional conditions.
    warn: (message, meta?, tag?) => emit('warn', requestId, tag ?? defaultTag, message, meta),
  };
}

/**
 * Module-level logger with no requestId.
 * Use this for top-level module initialisation messages or utility functions
 * where no per-request context is available.
 */
export const logger: Logger = createLogger();
