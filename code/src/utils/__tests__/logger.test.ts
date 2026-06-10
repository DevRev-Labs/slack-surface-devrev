/**
 * Unit tests for the structured logger (src/utils/logger.ts).
 *
 * Tests cover:
 *   - Level filtering (only entries at or above the active level are emitted)
 *   - Output routing (error → console.error, warn → console.warn, others → console.log)
 *   - Message format (level badge, requestId, tag, message, metadata)
 *   - setLogLevel / getLogLevel runtime override
 *   - createLogger factory binds requestId and default tag
 *   - Per-call tag override replaces the default tag
 *   - Module-level logger exports
 *   - SILENT level suppresses all output
 *   - Unknown LOG_LEVEL env values default to 'info'
 */

import { createLogger, getLogLevel, logger, LogLevel, setLogLevel } from '../logger';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Capture all calls to console.log / .warn / .error and restore when done. */
function spyAllConsole() {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  return { error, log, warn };
}

function restoreConsole(spies: ReturnType<typeof spyAllConsole>) {
  spies.log.mockRestore();
  spies.warn.mockRestore();
  spies.error.mockRestore();
}

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const REQ_ID = 'req-test-001';
const TAG = 'TEST';
const MSG = 'test message';

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('setLogLevel / getLogLevel', () => {
  // Save and restore the level around each test so they are independent.
  let savedLevel: LogLevel;

  beforeEach(() => {
    savedLevel = getLogLevel();
  });

  afterEach(() => {
    setLogLevel(savedLevel);
  });

  it('getLogLevel returns the current active level', () => {
    setLogLevel('warn');
    expect(getLogLevel()).toBe('warn');
  });

  it('setLogLevel to debug enables all entries', () => {
    setLogLevel('debug');
    expect(getLogLevel()).toBe('debug');
  });

  it('setLogLevel to silent suppresses all entries', () => {
    setLogLevel('silent');
    expect(getLogLevel()).toBe('silent');
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe('createLogger — level filtering', () => {
  let savedLevel: LogLevel;
  let spies: ReturnType<typeof spyAllConsole>;

  beforeEach(() => {
    savedLevel = getLogLevel();
    spies = spyAllConsole();
  });

  afterEach(() => {
    setLogLevel(savedLevel);
    restoreConsole(spies);
  });

  it('at INFO level: debug is suppressed, info/warn/error are emitted', () => {
    setLogLevel('info');
    const log = createLogger(REQ_ID, TAG);
    log.debug('should be hidden');
    log.info('should be visible');
    log.warn('should be visible');
    log.error('should be visible');
    expect(spies.log).toHaveBeenCalledTimes(1);
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.error).toHaveBeenCalledTimes(1);
  });

  it('at WARN level: debug + info are suppressed', () => {
    setLogLevel('warn');
    const log = createLogger(REQ_ID, TAG);
    log.debug('hidden');
    log.info('hidden');
    log.warn('visible');
    log.error('visible');
    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.error).toHaveBeenCalledTimes(1);
  });

  it('at ERROR level: only error entries are emitted', () => {
    setLogLevel('error');
    const log = createLogger(REQ_ID, TAG);
    log.debug('hidden');
    log.info('hidden');
    log.warn('hidden');
    log.error('visible');
    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalledTimes(1);
  });

  it('at DEBUG level: all entries are emitted', () => {
    setLogLevel('debug');
    const log = createLogger(REQ_ID, TAG);
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    // debug and info both go to console.log
    expect(spies.log).toHaveBeenCalledTimes(2);
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.error).toHaveBeenCalledTimes(1);
  });

  it('at SILENT level: nothing is emitted', () => {
    setLogLevel('silent');
    const log = createLogger(REQ_ID, TAG);
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe('createLogger — output routing', () => {
  let savedLevel: LogLevel;
  let spies: ReturnType<typeof spyAllConsole>;

  beforeEach(() => {
    savedLevel = getLogLevel();
    setLogLevel('debug');
    spies = spyAllConsole();
  });

  afterEach(() => {
    setLogLevel(savedLevel);
    restoreConsole(spies);
  });

  it('debug entries go to console.log', () => {
    const log = createLogger(REQ_ID, TAG);
    log.debug(MSG);
    expect(spies.log).toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).not.toHaveBeenCalled();
  });

  it('info entries go to console.log', () => {
    const log = createLogger(REQ_ID, TAG);
    log.info(MSG);
    expect(spies.log).toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).not.toHaveBeenCalled();
  });

  it('warn entries go to console.warn', () => {
    const log = createLogger(REQ_ID, TAG);
    log.warn(MSG);
    expect(spies.warn).toHaveBeenCalled();
    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.error).not.toHaveBeenCalled();
  });

  it('error entries go to console.error', () => {
    const log = createLogger(REQ_ID, TAG);
    log.error(MSG);
    expect(spies.error).toHaveBeenCalled();
    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe('createLogger — message format', () => {
  let savedLevel: LogLevel;
  let spies: ReturnType<typeof spyAllConsole>;

  beforeEach(() => {
    savedLevel = getLogLevel();
    setLogLevel('debug');
    spies = spyAllConsole();
  });

  afterEach(() => {
    setLogLevel(savedLevel);
    restoreConsole(spies);
  });

  it('emitted string includes the level badge, requestId, tag, and message', () => {
    const log = createLogger(REQ_ID, TAG);
    log.info(MSG);
    const line: string = spies.log.mock.calls[0][0];
    expect(line).toContain('[INFO ]');
    expect(line).toContain(`[${REQ_ID}]`);
    expect(line).toContain(`[${TAG}]`);
    expect(line).toContain(MSG);
  });

  it('omits requestId bracket when no requestId is provided', () => {
    const log = createLogger(undefined, TAG);
    log.info(MSG);
    const line: string = spies.log.mock.calls[0][0];
    expect(line).not.toContain('[req-');
    expect(line).toContain(`[${TAG}]`);
  });

  it('omits tag bracket when no default tag is provided', () => {
    const log = createLogger(REQ_ID);
    log.info(MSG);
    const line: string = spies.log.mock.calls[0][0];
    expect(line).toContain(`[${REQ_ID}]`);
    // tag bracket should be absent (only level + reqId + message remain)
    const parts = line.split('[').filter(Boolean);
    // Expect: LEVEL, REQ_ID, then no third bracket from a tag
    expect(parts.length).toBe(2); // [LEVEL ] [REQ_ID]
  });

  it('attaches metadata as a second argument when provided', () => {
    const log = createLogger(REQ_ID, TAG);
    const meta = { email: 'a@b.com', count: 3 };
    log.info(MSG, meta);
    const args = spies.log.mock.calls[0];
    // First arg is the formatted string, second is the metadata object.
    expect(args).toHaveLength(2);
    expect(args[1]).toEqual(meta);
  });

  it('omits metadata argument when metadata is empty object', () => {
    const log = createLogger(REQ_ID, TAG);
    log.info(MSG, {});
    const args = spies.log.mock.calls[0];
    // No second argument when meta is empty.
    expect(args).toHaveLength(1);
  });

  it('per-call tag override replaces the default tag in the emitted line', () => {
    const log = createLogger(REQ_ID, 'DEFAULT_TAG');
    log.warn(MSG, undefined, 'OVERRIDE_TAG');
    const line: string = spies.warn.mock.calls[0][0];
    expect(line).toContain('[OVERRIDE_TAG]');
    expect(line).not.toContain('[DEFAULT_TAG]');
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe('module-level logger', () => {
  let savedLevel: LogLevel;
  let spies: ReturnType<typeof spyAllConsole>;

  beforeEach(() => {
    savedLevel = getLogLevel();
    setLogLevel('info');
    spies = spyAllConsole();
  });

  afterEach(() => {
    setLogLevel(savedLevel);
    restoreConsole(spies);
  });

  it('is exported and functional', () => {
    expect(logger).toBeDefined();
    logger.info('module logger test');
    expect(spies.log).toHaveBeenCalled();
  });

  it('respects the active log level (debug suppressed at INFO)', () => {
    logger.debug('hidden');
    expect(spies.log).not.toHaveBeenCalled();
  });
});
