import { randomBytes } from 'crypto';

import axios from 'axios';
import {
  createActAsToken,
  createWebhook,
  findUserByEmail,
  getEventSourceTriggerUrl,
  getOrCreateActAsToken,
  getOrCreateWebhookForEventSource,
  _clearActAsTokenCache,
  _clearWebhookCache,
} from '../devrev-auth';

// Generate fake-token strings per test run instead of hardcoding literals,
// so secret-looking values never appear as static strings in source.
const fakeToken = (label: string): string => `${label}-${randomBytes(8).toString('hex')}`;

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// findUserByEmail and createActAsToken use the DevRev SDK rather than
// raw axios. Mock the SDK's `client.setup(...)` factory so each test can
// configure devUsersList / authTokensCreate independently.
const mockDevUsersList = jest.fn();
const mockAuthTokensCreate = jest.fn();
jest.mock('@devrev/typescript-sdk', () => ({
  client: {
    setup: () => ({
      authTokensCreate: (...args: unknown[]) => mockAuthTokensCreate(...args),
      devUsersList: (...args: unknown[]) => mockDevUsersList(...args),
    }),
  },
  publicSDK: {
    AuthTokenGrantType: { UrnDevrevParamsOauthGrantTypeTokenIssue: 'urn:devrev:params:oauth:grant-type:token-issue' },
    AuthTokenRequestedTokenType: {
      UrnDevrevParamsOauthTokenTypePatActAs: 'urn:devrev:params:oauth:token-type:pat-act-as',
    },
  },
}));

describe('devrev-auth', () => {
  const endpoint = 'https://api.devrev.ai';
  const token = 'service-token';
  const email = 'test@example.com';
  const userId = 'user-123';

  beforeEach(() => {
    jest.clearAllMocks();
    _clearActAsTokenCache();
    _clearWebhookCache();
  });

  describe('findUserByEmail', () => {
    it('should return user ID when user is found', async () => {
      mockDevUsersList.mockResolvedValueOnce({
        data: { dev_users: [{ id: userId }] },
      });

      const result = await findUserByEmail(email, endpoint, token);
      expect(result).toBe(userId);
      expect(mockDevUsersList).toHaveBeenCalledWith({ email: [email] });
    });

    it('should return null when user is not found', async () => {
      mockDevUsersList.mockResolvedValueOnce({
        data: { dev_users: [] },
      });

      const result = await findUserByEmail(email, endpoint, token);
      expect(result).toBeNull();
    });

    it('should return null and log error on failure', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockDevUsersList.mockRejectedValueOnce(new Error('API Error'));

      const result = await findUserByEmail(email, endpoint, token);
      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('createActAsToken', () => {
    it('should return access token on success', async () => {
      const actAsToken = fakeToken('new-access');
      mockAuthTokensCreate.mockResolvedValueOnce({
        data: { access_token: actAsToken },
      });

      const result = await createActAsToken(userId, endpoint, token);
      expect(result).toBe(actAsToken);
      expect(mockAuthTokensCreate).toHaveBeenCalledWith(expect.objectContaining({ act_as: userId, expires_in: 360 }));
    });

    it('should return null and log error on failure', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockAuthTokensCreate.mockRejectedValueOnce(new Error('Auth Error'));

      const result = await createActAsToken(userId, endpoint, token);
      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('getOrCreateActAsToken', () => {
    it('should create and cache a new token', async () => {
      const actAsToken = fakeToken('fresh');
      mockAuthTokensCreate.mockResolvedValueOnce({
        data: { access_token: actAsToken },
      });

      const result = await getOrCreateActAsToken(userId, endpoint, token);
      expect(result).toBe(actAsToken);
      expect(mockAuthTokensCreate).toHaveBeenCalledTimes(1);
    });

    it('should return cached token if not expired', async () => {
      const actAsToken = fakeToken('cached');
      mockAuthTokensCreate.mockResolvedValueOnce({
        data: { access_token: actAsToken },
      });

      // First call to populate cache
      await getOrCreateActAsToken(userId, endpoint, token);

      // Second call should use cache
      const result = await getOrCreateActAsToken(userId, endpoint, token);
      expect(result).toBe(actAsToken);
      expect(mockAuthTokensCreate).toHaveBeenCalledTimes(1);
    });

    it('should create new token if cached one is expired', async () => {
      const oldToken = fakeToken('old');
      const newToken = fakeToken('new');

      mockAuthTokensCreate
        .mockResolvedValueOnce({ data: { access_token: oldToken } })
        .mockResolvedValueOnce({ data: { access_token: newToken } });

      // Mock Date.now to control expiration
      const realDateNow = Date.now;
      let mockTime = 1000000;
      global.Date.now = jest.fn(() => mockTime);

      await getOrCreateActAsToken(userId, endpoint, token, 10); // 10 min TTL

      // Advance time beyond TTL (10 min = 600,000 ms)
      mockTime += 11 * 60 * 1000;

      const result = await getOrCreateActAsToken(userId, endpoint, token);
      expect(result).toBe(newToken);
      expect(mockAuthTokensCreate).toHaveBeenCalledTimes(2);

      global.Date.now = realDateNow;
    });
  });

  describe('getEventSourceTriggerUrl', () => {
    const eventSourceId = 'don:integration:dvrv-us-1:devo/123:event_source/abc';

    it('should construct trigger URL from event source ID', () => {
      const result = getEventSourceTriggerUrl(eventSourceId, endpoint);
      expect(result).toBe(`${endpoint}/internal/event-sources.invoke?id=${encodeURIComponent(eventSourceId)}`);
    });

    it('should properly encode event source ID in URL', () => {
      const idWithSpecialChars = 'event:source/with+special&chars';
      const result = getEventSourceTriggerUrl(idWithSpecialChars, endpoint);
      expect(result).toBe(`${endpoint}/internal/event-sources.invoke?id=${encodeURIComponent(idWithSpecialChars)}`);
    });
  });

  describe('createWebhook', () => {
    const webhookUrl = 'https://trigger.devrev.ai/webhook/abc';
    const webhookId = 'don:integration:...:webhook/xyz';

    it('should return webhook ID when created with active status', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { webhook: { id: webhookId, status: 'active' } },
      });

      const result = await createWebhook(webhookUrl, endpoint, token);
      expect(result).toBe(webhookId);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        `${endpoint}/webhooks.create`,
        expect.objectContaining({ event_types: ['ai_agent_response'], url: webhookUrl }),
        expect.any(Object)
      );
    });

    it('should poll for active status when not immediately active', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation();

      // Mock webhook creation with pending status
      mockedAxios.post.mockResolvedValueOnce({
        data: { webhook: { id: webhookId, status: 'pending' } },
      });
      // Mock polling for status
      mockedAxios.get.mockResolvedValueOnce({
        data: { webhook: { status: 'active' } },
      });

      const result = await createWebhook(webhookUrl, endpoint, token);
      expect(result).toBe(webhookId);
      expect(mockedAxios.get).toHaveBeenCalled();
      logSpy.mockRestore();
    });

    it('should return null when webhook creation fails', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockedAxios.post.mockRejectedValueOnce(new Error('Create failed'));

      const result = await createWebhook(webhookUrl, endpoint, token);
      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should return null when webhook ID is missing in response', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockedAxios.post.mockResolvedValueOnce({
        data: { webhook: {} },
      });

      const result = await createWebhook(webhookUrl, endpoint, token);
      expect(result).toBeNull();
      consoleSpy.mockRestore();
    });
  });

  describe('getOrCreateWebhookForEventSource', () => {
    const eventSourceId = 'don:integration:...:event_source/456';
    const webhookId = 'don:integration:...:webhook/created';

    it('should create and cache a webhook for event source', async () => {
      // Mock webhook creation with active status
      mockedAxios.post.mockResolvedValueOnce({
        data: { webhook: { id: webhookId, status: 'active' } },
      });

      const result = await getOrCreateWebhookForEventSource(eventSourceId, endpoint, token);
      expect(result).toBe(webhookId);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        `${endpoint}/webhooks.create`,
        expect.objectContaining({
          url: expect.stringContaining(`/internal/event-sources.invoke?id=`),
        }),
        expect.any(Object)
      );
    });

    it('should return cached webhook ID on subsequent calls', async () => {
      // Mock webhook creation with active status
      mockedAxios.post.mockResolvedValueOnce({
        data: { webhook: { id: webhookId, status: 'active' } },
      });

      await getOrCreateWebhookForEventSource(eventSourceId, endpoint, token);
      const result = await getOrCreateWebhookForEventSource(eventSourceId, endpoint, token);

      expect(result).toBe(webhookId);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1); // Only once due to cache
    });

    it('should return null when webhook creation fails', async () => {
      _clearWebhookCache();
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      mockedAxios.post.mockRejectedValueOnce(new Error('Webhook creation failed'));

      const result = await getOrCreateWebhookForEventSource('new-event-source', endpoint, token);
      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
