/**
 * Tests for the env-driven config module. Because `defaults.ts` reads
 * `process.env` at module-load time, these tests use `jest.isolateModules`
 * to re-import with different env states.
 */

describe('config/defaults', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    // Clone so each test starts from a clean baseline; restore in afterEach.
    process.env = { ...ORIGINAL_ENV };
    delete process.env['WEBHOOK_MAX_WAIT_MS'];
    delete process.env['WEBHOOK_POLL_INTERVAL_MS'];
    delete process.env['ACT_AS_TOKEN_TTL_MINUTES'];
    delete process.env['SESSION_IDLE_TIMEOUT_MINUTES'];
    delete process.env['BLOCK_KIT_MAX_BLOCKS'];
    delete process.env['SLACK_API_BASE'];
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('falls back to documented defaults when env vars are unset', () => {
    jest.isolateModules(() => {
      // jest.isolateModules forces CJS require so each call re-evaluates
      // the module under a different process.env state.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const config = require('../defaults');
      expect(config.WEBHOOK_CONFIG.maxWaitMs).toBe(10_000);
      expect(config.WEBHOOK_CONFIG.pollIntervalMs).toBe(500);
      expect(config.ACT_AS_TOKEN_CONFIG.ttlMinutes).toBe(30);
      expect(config.SESSION_CONFIG.idleTtlMinutes).toBe(8 * 60);
      expect(config.SESSION_CONFIG.absoluteTtlHours).toBe(24);
      expect(config.RENDER_CONFIG.maxBlocks).toBe(50);
      expect(config.HTTP_CONFIG.slackApiBase).toBe('https://slack.com/api');
    });
  });

  it('honours overrides from env vars', () => {
    process.env['WEBHOOK_MAX_WAIT_MS'] = '20000';
    process.env['WEBHOOK_POLL_INTERVAL_MS'] = '750';
    process.env['ACT_AS_TOKEN_TTL_MINUTES'] = '15';
    process.env['SESSION_IDLE_TIMEOUT_MINUTES'] = '60';
    process.env['BLOCK_KIT_MAX_BLOCKS'] = '40';
    process.env['SLACK_API_BASE'] = 'https://slack.example.com/api';
    jest.isolateModules(() => {
      // jest.isolateModules forces CJS require so each call re-evaluates
      // the module under a different process.env state.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const config = require('../defaults');
      expect(config.WEBHOOK_CONFIG.maxWaitMs).toBe(20_000);
      expect(config.WEBHOOK_CONFIG.pollIntervalMs).toBe(750);
      expect(config.ACT_AS_TOKEN_CONFIG.ttlMinutes).toBe(15);
      expect(config.SESSION_CONFIG.idleTtlMinutes).toBe(60);
      expect(config.RENDER_CONFIG.maxBlocks).toBe(40);
      expect(config.HTTP_CONFIG.slackApiBase).toBe('https://slack.example.com/api');
    });
  });

  it('rejects non-numeric / non-positive numeric overrides and uses fallback', () => {
    process.env['WEBHOOK_MAX_WAIT_MS'] = 'not-a-number';
    process.env['WEBHOOK_POLL_INTERVAL_MS'] = '0';
    process.env['ACT_AS_TOKEN_TTL_MINUTES'] = '-5';
    jest.isolateModules(() => {
      // jest.isolateModules forces CJS require so each call re-evaluates
      // the module under a different process.env state.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const config = require('../defaults');
      expect(config.WEBHOOK_CONFIG.maxWaitMs).toBe(10_000);
      expect(config.WEBHOOK_CONFIG.pollIntervalMs).toBe(500);
      expect(config.ACT_AS_TOKEN_CONFIG.ttlMinutes).toBe(30);
    });
  });

  it('treats whitespace-only overrides as missing', () => {
    process.env['SLACK_API_BASE'] = '   ';
    jest.isolateModules(() => {
      // jest.isolateModules forces CJS require so each call re-evaluates
      // the module under a different process.env state.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const config = require('../defaults');
      expect(config.HTTP_CONFIG.slackApiBase).toBe('https://slack.com/api');
    });
  });

  it('CONFIG aggregate exposes the same values as the named groups', () => {
    jest.isolateModules(() => {
      // jest.isolateModules forces CJS require so each call re-evaluates
      // the module under a different process.env state.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const config = require('../defaults');
      expect(config.CONFIG.WEBHOOK).toBe(config.WEBHOOK_CONFIG);
      expect(config.CONFIG.HTTP).toBe(config.HTTP_CONFIG);
      expect(config.CONFIG.SESSION).toBe(config.SESSION_CONFIG);
    });
  });
});
