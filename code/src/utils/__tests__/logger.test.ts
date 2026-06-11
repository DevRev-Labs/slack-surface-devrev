/**
 * Tests for the leveled logger. We exercise both the level-filtering matrix
 * and the structured-context formatting so callers can rely on the output
 * shape (`[LEVEL] message  k=v`).
 */

import { getLogLevel, logger, setLogLevel, _resetLogLevelForTests } from '../logger';

describe('logger', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;

  beforeEach(() => {
    // Capture each console sink the logger may use; restore after each test
    // so unrelated tests aren't affected by spies leaking out.
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
    _resetLogLevelForTests();
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
    _resetLogLevelForTests();
  });

  describe('level filtering', () => {
    it('emits info / warn / error but suppresses debug at default level', () => {
      logger.error('e');
      logger.warn('w');
      logger.info('i');
      logger.debug('d');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(debugSpy).not.toHaveBeenCalled();
    });

    it('suppresses everything below error when level=error', () => {
      setLogLevel('error');
      logger.error('e');
      logger.warn('w');
      logger.info('i');
      logger.debug('d');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();
    });

    it('emits all four levels when level=debug', () => {
      setLogLevel('debug');
      logger.error('e');
      logger.warn('w');
      logger.info('i');
      logger.debug('d');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(debugSpy).toHaveBeenCalledTimes(1);
    });

    it('exposes current level via getLogLevel', () => {
      setLogLevel('warn');
      expect(getLogLevel()).toBe('warn');
    });
  });

  describe('formatting', () => {
    it('prefixes the level in upper-case and renders the message verbatim', () => {
      logger.info('hello world');
      expect(logSpy).toHaveBeenCalledWith('[INFO] hello world');
    });

    it('appends structured context as space-delimited key=value pairs', () => {
      logger.warn('webhook created', { id: 'wh_1', status: 'active' });
      expect(warnSpy).toHaveBeenCalledWith('[WARN] webhook created  id=wh_1  status=active');
    });

    it('JSON-stringifies object values without throwing', () => {
      logger.error('boom', { detail: { code: 42 } });
      expect(errorSpy).toHaveBeenCalledWith('[ERROR] boom  detail={"code":42}');
    });

    it('renders Error objects by their message', () => {
      logger.error('boom', { err: new Error('kaboom') });
      expect(errorSpy).toHaveBeenCalledWith('[ERROR] boom  err=kaboom');
    });

    it('handles undefined / null context values gracefully', () => {
      logger.info('mixed', { a: undefined, b: null, c: 0, d: false });
      expect(logSpy).toHaveBeenCalledWith('[INFO] mixed  a=undefined  b=null  c=0  d=false');
    });

    it('falls back to String() when JSON.stringify throws (circular)', () => {
      // Build a self-referential object that JSON.stringify would normally reject.
      const circ: Record<string, unknown> = {};
      circ['self'] = circ;
      expect(() => logger.info('cycle', { circ })).not.toThrow();
      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe('positional extras (mechanical console.* migration)', () => {
    it('coerces a single non-object extra into { detail: ... }', () => {
      logger.warn('boom', 'something went wrong');
      expect(warnSpy).toHaveBeenCalledWith('[WARN] boom  detail=something went wrong');
    });

    it('coerces multiple positional extras into arg0, arg1, ...', () => {
      logger.error('ctx', 'a', 42);
      expect(errorSpy).toHaveBeenCalledWith('[ERROR] ctx  arg0=a  arg1=42');
    });

    it('still treats an explicit object as structured context', () => {
      logger.info('hit', { method: 'GET', status: 200 });
      expect(logSpy).toHaveBeenCalledWith('[INFO] hit  method=GET  status=200');
    });

    it('treats an Error positional as { detail: <message> }', () => {
      logger.error('boom', new Error('oh no'));
      expect(errorSpy).toHaveBeenCalledWith('[ERROR] boom  detail=oh no');
    });
  });

  describe('robustness', () => {
    it('does not throw if the underlying sink throws', () => {
      logSpy.mockImplementation(() => {
        throw new Error('sink failure');
      });
      expect(() => logger.info('still safe')).not.toThrow();
    });
  });
});
