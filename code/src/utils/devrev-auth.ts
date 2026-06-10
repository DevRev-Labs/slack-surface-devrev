/**
 * DevRev Authentication Utilities
 *
 * Handles user lookup, token impersonation (act-as), and webhook management.
 */

import { client, publicSDK } from '@devrev/typescript-sdk';
import axios from 'axios';

import {
  ACT_AS_TOKEN_EXPIRES_IN_SECONDS,
  LOG_TAG,
  WEBHOOK_ACTIVE_POLL_INTERVAL_MS,
  WEBHOOK_ACTIVE_WAIT_MAX_MS,
} from '../config';
import { createLogger } from './logger';

// Module-level logger for all auth and webhook operations.
const log = createLogger(undefined, LOG_TAG.AUTH);

/**
 * Token Cache interface for act-as tokens.
 */
interface ActAsTokenCache {
  token: string;
  expiresAt: number;
}

const actAsTokenCache = new Map<string, ActAsTokenCache>();

/**
 * Webhook cache - maps event source ID to webhook ID
 */
const webhookCache = new Map<string, string>();

/**
 * Clear the act-as token cache. Primarily used for testing.
 */
export function _clearActAsTokenCache(): void {
  actAsTokenCache.clear();
}

/**
 * Clear the webhook cache. Primarily used for testing.
 */
export function _clearWebhookCache(): void {
  webhookCache.clear();
}

/**
 * Invalidate a cached webhook for a specific event source.
 * Call this when a webhook is found to be inactive so a new one can be created.
 *
 * @param eventSourceId The event source ID whose cached webhook should be invalidated.
 */
export function invalidateWebhookCache(eventSourceId: string): void {
  const removed = webhookCache.delete(eventSourceId);
  if (removed) {
    log.info('Invalidated cached webhook', { event_source_id: eventSourceId });
  }
}

/**
 * Find a DevRev user by their email address.
 *
 * @param email The user's email address.
 * @param endpoint The DevRev API endpoint.
 * @param token The service account token.
 * @returns The DevRev user ID or null if not found.
 */
export async function findUserByEmail(email: string, endpoint: string, token: string): Promise<string | null> {
  try {
    const sdk = client.setup({ endpoint, token });
    const response = await sdk.devUsersList({ email: [email] });
    const user = response.data.dev_users?.[0];
    return user ? user.id : null;
  } catch (error: any) {
    log.error('Error looking up user by email', {
      email,
      err_data: error.response?.data,
      err_message: error.message,
    });
    return null;
  }
}

/**
 * Create an impersonated (act-as) token for a specific DevRev user.
 *
 * @param userId The DevRev user ID to impersonate.
 * @param endpoint The DevRev API endpoint.
 * @param serviceToken The service account token.
 * @returns The new access token.
 */
export async function createActAsToken(userId: string, endpoint: string, serviceToken: string): Promise<string | null> {
  log.info('Creating act-as token', { user_id: userId });
  try {
    const sdk = client.setup({ endpoint, token: serviceToken });
    const response = await sdk.authTokensCreate({
      act_as: userId,
      // TTL sourced from config so it can be tuned per deployment via env var.
      expires_in: ACT_AS_TOKEN_EXPIRES_IN_SECONDS,
      grant_type: publicSDK.AuthTokenGrantType.UrnDevrevParamsOauthGrantTypeTokenIssue,
      requested_token_type: publicSDK.AuthTokenRequestedTokenType.UrnDevrevParamsOauthTokenTypePatActAs,
    });
    log.info('act-as token created successfully', { user_id: userId });
    return response.data.access_token;
  } catch (error: any) {
    log.error('act-as token creation failed', {
      err_data: error.response?.data,
      err_message: error.message,
      err_status: error.response?.status,
      user_id: userId,
    });
    return null;
  }
}

/**
 * Get or create an act-as token with caching.
 *
 * Purpose: Returns a cached token if valid, otherwise creates a new one and caches it.
 *
 * @param userId The DevRev user ID to impersonate.
 * @param endpoint The DevRev API endpoint.
 * @param serviceToken The service account token.
 * @param ttlMinutes Cache TTL in minutes (default: 30).
 * @returns The access token (cached or newly created).
 */
export async function getOrCreateActAsToken(
  userId: string,
  endpoint: string,
  serviceToken: string,
  ttlMinutes = 30
): Promise<string | null> {
  const cacheKey = `${userId}:${endpoint}`;
  const cached = actAsTokenCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const token = await createActAsToken(userId, endpoint, serviceToken);

  if (token) {
    actAsTokenCache.set(cacheKey, {
      expiresAt: Date.now() + ttlMinutes * 60 * 1000,
      token,
    });
  }

  return token;
}

/**
 * Get the trigger URL for an event source.
 *
 * For snap-in event sources, the trigger URL follows a standard pattern:
 * https://api.devrev.ai/internal/event-sources.invoke?id=<event_source_id>
 *
 * @param eventSourceId The event source ID.
 * @param endpoint The DevRev API endpoint.
 * @returns The trigger URL.
 */
export function getEventSourceTriggerUrl(eventSourceId: string, endpoint: string): string {
  return `${endpoint}/internal/event-sources.invoke?id=${encodeURIComponent(eventSourceId)}`;
}

/**
 * Get the current status of a webhook.
 *
 * @param webhookId The webhook ID.
 * @param endpoint The DevRev API endpoint.
 * @param token The service account token.
 * @returns The webhook status or null if retrieval failed.
 */
export async function getWebhookStatus(webhookId: string, endpoint: string, token: string): Promise<string | null> {
  try {
    const response = await axios.get(`${endpoint}/webhooks.get`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { id: webhookId },
    });
    return response.data.webhook?.status || null;
  } catch (error: any) {
    log.error('Error getting webhook status', {
      err_data: error.response?.data,
      err_message: error.message,
      webhook_id: webhookId,
    });
    return null;
  }
}

/**
 * Wait for a webhook to become active.
 *
 * @param webhookId The webhook ID.
 * @param endpoint The DevRev API endpoint.
 * @param token The service account token.
 * @param maxWaitMs Maximum time to wait in milliseconds (default: 10 seconds).
 * @param pollIntervalMs Polling interval in milliseconds (default: 500ms).
 * @returns true if webhook became active, false if timeout or error.
 */
export async function waitForWebhookActive(
  webhookId: string,
  endpoint: string,
  token: string,
  // Default values sourced from config so they can be tuned via env vars.
  maxWaitMs = WEBHOOK_ACTIVE_WAIT_MAX_MS,
  pollIntervalMs = WEBHOOK_ACTIVE_POLL_INTERVAL_MS
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const status = await getWebhookStatus(webhookId, endpoint, token);

    if (status === 'active') {
      log.info('Webhook is now active', { webhook_id: webhookId });
      return true;
    }

    if (status === 'error' || status === 'disabled') {
      log.error('Webhook has unexpected status', { status, webhook_id: webhookId });
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  log.warn('Timeout waiting for webhook to become active', { webhook_id: webhookId });
  return false;
}

/**
 * Create a webhook pointing to a URL and wait for it to become active.
 *
 * @param url The URL the webhook should point to.
 * @param endpoint The DevRev API endpoint.
 * @param token The service account token.
 * @returns The webhook ID if created and active, null otherwise.
 */
export async function createWebhook(url: string, endpoint: string, token: string): Promise<string | null> {
  try {
    const response = await axios.post(
      `${endpoint}/webhooks.create`,
      {
        event_types: ['ai_agent_response'],
        url: url,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const webhook = response.data.webhook;
    const webhookId = webhook?.id;
    const status = webhook?.status;

    if (!webhookId) {
      log.error('No webhook ID in response from webhooks.create');
      return null;
    }

    if (status === 'active') {
      return webhookId;
    }

    const isActive = await waitForWebhookActive(webhookId, endpoint, token);

    if (!isActive) {
      log.error('Webhook did not become active in time', { webhook_id: webhookId });
      return null;
    }

    return webhookId;
  } catch (error: any) {
    log.error('Error creating webhook', {
      err_data: error.response?.data,
      err_message: error.message,
    });
    return null;
  }
}

/**
 * Get or create a webhook for an event source.
 *
 * This creates a DevRev webhook that points to the event source's trigger URL.
 * The webhook ID can then be used with the AI Agent async API.
 *
 * @param eventSourceId The event source ID from the snap-in.
 * @param endpoint The DevRev API endpoint.
 * @param token The service account token.
 * @returns The webhook ID or null if creation failed.
 */
export async function getOrCreateWebhookForEventSource(
  eventSourceId: string,
  endpoint: string,
  token: string
): Promise<string | null> {
  const cached = webhookCache.get(eventSourceId);
  if (cached) {
    return cached;
  }

  const triggerUrl = getEventSourceTriggerUrl(eventSourceId, endpoint);

  const webhookId = await createWebhook(triggerUrl, endpoint, token);

  if (webhookId) {
    webhookCache.set(eventSourceId, webhookId);
  }

  return webhookId;
}
