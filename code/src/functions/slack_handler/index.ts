/**
 * Slack Handler Function
 *
 * Handles incoming messages from Slack and forwards them to DevRev AI Agents.
 *
 * Each Slack ↔ DevRev session is backed by a single DevRev `conversation`
 * object. That conversation's DON serves as both the AI Agent's
 * `session_object` (server-side context handle) and the place where the
 * user's queries and the AI Agent's responses are mirrored as timeline
 * entries.
 */

import { client } from '@devrev/typescript-sdk';

import { FunctionInput } from '../../types';
import {
  ConversationReference,
  extractConversationReference,
  extractRoutingKeyParts,
} from '../../utils/conversation-store';
import { findUserByEmail, getOrCreateActAsToken } from '../../utils/devrev-auth';
import { logger } from '../../utils/logger';
import { readSessionTimingConfig, SessionTimingConfig } from '../../utils/session-config';
import {
  buildConversationKey,
  createSession,
  getActiveSession,
  isSessionExpired,
  rotateSession,
  SessionIdentity,
  SessionRecord,
  SessionUserOverrides,
  StoreConfig,
  touchSession,
} from '../../utils/session-store';
import { isValidEmail, resolveUserProfile } from '../../utils/slack-auth';
import { getChannelName, removeBotMention, sendMessage, updateMessage } from '../../utils/slack-client';
import { validateSlackSignature } from '../../utils/slack-signature-validator';
import { postTimelineComment } from '../../utils/timeline';

const FORBIDDEN_RESPONSE = { status: 'forbidden', status_code: 403 };

const RESET_INTENT_PHRASES = new Set(['new session', '/clear']);

function readSlackHeader(headers: Record<string, any> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
    }
  }
  return undefined;
}

/**
 * Find or create the right session for this Slack message.
 *
 * - reset intent → rotate existing (or create) with reason `user_reset`.
 * - normal flow → reuse active, rotate on idle/absolute expiry, else create.
 */
async function resolveSession(
  storeConfig: StoreConfig,
  timing: SessionTimingConfig,
  identity: SessionIdentity,
  userOverrides: SessionUserOverrides,
  intent: 'message' | 'reset',
  requestId: string
): Promise<SessionRecord> {
  const existing = await getActiveSession(storeConfig, identity.conversationKey);

  if (intent === 'reset') {
    if (existing) {
      const rotated = await rotateSession(storeConfig, existing, 'user_reset', identity, timing, userOverrides);
      logger.info(`[${requestId}] [session] rotated user_reset old=${existing.sessionId} new=${rotated.sessionId}`);
      return rotated;
    }
    const fresh = await createSession(storeConfig, { identity, ...userOverrides }, timing);
    logger.info(`[${requestId}] [session] created (after reset, no prior) ${fresh.sessionId}`);
    return fresh;
  }

  if (!existing) {
    const fresh = await createSession(storeConfig, { identity, ...userOverrides }, timing);
    logger.info(`[${requestId}] [session] created ${fresh.sessionId} gen=${fresh.generation}`);
    return fresh;
  }

  const expiredReason = isSessionExpired(existing);
  if (expiredReason) {
    const rotated = await rotateSession(storeConfig, existing, expiredReason, identity, timing, userOverrides);
    logger.info(
      `[${requestId}] [session] rotated reason=${expiredReason} old=${existing.sessionId} new=${rotated.sessionId} gen=${rotated.generation}`
    );
    return rotated;
  }

  logger.info(
    `[${requestId}] [session] reused ${existing.sessionId} gen=${existing.generation} msgs=${existing.messageCount}`
  );
  return existing;
}

/**
 * Main handler for Slack messages.
 *
 * Purpose: Processes incoming messages from Slack, manages session lifecycle, and invokes the AI Agent.
 */
async function handleSlackMessage(event: FunctionInput): Promise<any> {
  const payload = event.payload;
  const requestId = event.execution_metadata.request_id;

  // The Rego policy now wraps inbound requests as { body, headers } so the
  // function can verify the Slack signature. Older payload shape (the parsed
  // Slack event directly) is preserved for backwards-compatible test fixtures.
  const wrapped = payload && typeof payload === 'object' && 'body' in payload && 'headers' in payload ? payload : null;
  const slackBody = wrapped ? wrapped.body : payload;
  const requestHeaders: Record<string, any> | undefined = wrapped ? wrapped.headers : undefined;
  const bodyRaw: string | undefined =
    wrapped && typeof (wrapped as any).body_raw === 'string' ? (wrapped as any).body_raw : undefined;

  const signingSecret = event.input_data.keyrings?.['slack_signing_secret'];
  const sigCheck = validateSlackSignature(signingSecret, requestHeaders, slackBody, bodyRaw);
  if (!sigCheck.valid) {
    logger.warn(`[${requestId}] [auth] Slack signature rejected: ${sigCheck.reason}`);
    return FORBIDDEN_RESPONSE;
  }

  // Slack retries Events API delivery if it doesn't get a 200 within ~3s.
  // Cold-start latency can blow that budget on the first call; the retry
  // then races the original invocation and produces a duplicate placeholder
  // + a duplicate AI-Agent submission. The original is still in-flight, so
  // we ack the retry with 200 and exit before any Slack call or session
  // write happens.
  const retryNum = readSlackHeader(requestHeaders, 'x-slack-retry-num');
  if (retryNum) {
    const retryReason = readSlackHeader(requestHeaders, 'x-slack-retry-reason');
    logger.info(
      `[${requestId}] [retry] dropping Slack retry attempt=${retryNum} reason=${retryReason ?? 'unspecified'}`
    );
    return { reason: 'Slack retry — original in flight', status: 'ignored' };
  }

  const slackEvent = slackBody?.event;

  if (!slackEvent) {
    return { reason: 'No event in payload', status: 'ignored' };
  }

  if (slackEvent.type !== 'app_mention' && slackEvent.type !== 'message') {
    return { reason: `Unsupported event type: ${slackEvent.type}`, status: 'ignored' };
  }

  if (slackEvent.bot_id || slackEvent.subtype === 'bot_message') {
    return { reason: 'Bot message', status: 'ignored' };
  }

  // In channels and group DMs, the bot ONLY responds when it is explicitly
  // @-mentioned (`app_mention`) — top-level posts AND thread replies alike.
  // Plain `message` events without a mention are ignored even if a prior
  // session exists for the thread. DMs (`channel_type === 'im'`) still treat
  // every message as in-scope.
  if (slackEvent.type === 'message' && slackEvent.channel_type !== 'im') {
    return { reason: 'Channel message without mention', status: 'ignored' };
  }

  const messageText = slackEvent.text?.trim();
  if (!messageText) {
    return { reason: 'Empty message', status: 'ignored' };
  }

  const cleanedMessage = removeBotMention(messageText);
  if (!cleanedMessage) {
    return { reason: 'Empty message after removing mention', status: 'ignored' };
  }

  const isResetIntent = RESET_INTENT_PHRASES.has(cleanedMessage.trim().toLowerCase());

  const config = extractConfig(event);

  if (!config.aiAgentId) {
    logger.error(`[${requestId}] AI Agent ID not configured`);
    return { reason: 'AI Agent ID not configured', status: 'error' };
  }

  if (!config.slackBotToken) {
    logger.error(`[${requestId}] Slack Bot Token not configured`);
    return { reason: 'Slack Bot Token not configured', status: 'error' };
  }

  // If mock email was entered but has invalid format, reject immediately — don't silently fall back
  if (config.mockEmailRaw && !config.mockEmailAddress) {
    logger.error(`[${requestId}] [CONFIG] Mock email address has invalid format: "${config.mockEmailRaw}"`);
    await sendMessage(
      extractConversationReference(slackEvent).channel,
      `Sorry, something went wrong. Please try again or contact your admin.`,
      config.slackBotToken,
      slackEvent.thread_ts || undefined
    ).catch(() => {
      /* swallow */
    });
    return { reason: 'Invalid mock email address format in config', status: 'error' };
  }

  const conversationRef = extractConversationReference(slackEvent);

  if (!conversationRef.channelName && conversationRef.channel) {
    try {
      const resolvedChannelName = await getChannelName(conversationRef.channel, config.slackBotToken);
      if (resolvedChannelName) {
        conversationRef.channelName = resolvedChannelName;
        logger.info(
          `[${requestId}] [CHAN] Resolved channel name: ${resolvedChannelName} for ${conversationRef.channel}`
        );
      }
    } catch (chanErr: any) {
      logger.warn(
        `[${requestId}] [CHAN] Failed to resolve channel name for ${conversationRef.channel}: ${
          chanErr?.message || chanErr
        }`
      );
    }
  }

  // Determine thread_ts for replies — use existing thread or start a new one.
  const threadTs = slackEvent.thread_ts || slackEvent.ts;
  conversationRef.threadTs = threadTs;

  const timing = readSessionTimingConfig(event.input_data.global_values);
  const storeConfig: StoreConfig = {
    devrevEndpoint: config.devrevEndpointInternal,
    serviceAccountToken: config.serviceAccountToken,
    timing,
  };

  // Stamp the bot user id (the recipient of the @mention) onto the ref so it
  // ends up on the persisted session record. Slack puts the bot in
  // event.authorizations[0].user_id for events the bot was authorized for.
  const botUserId = slackBody?.authorizations?.[0]?.user_id || slackBody?.api_app_id || undefined;
  if (botUserId) {
    conversationRef.botUserId = botUserId;
  }

  // Verify user is in DevRev org and get act-as token for user-scoped AI execution
  let userToken = config.serviceAccountToken;
  let tokenType = 'service_account';
  let devrevUserId: string | null = null;
  let resolvedEmail: string | undefined;

  logger.info(
    `[${requestId}] [MSG] Incoming message from Slack user: ${slackEvent.user}, channel: ${
      conversationRef.channel
    }, text: "${cleanedMessage.substring(0, 100)}"`
  );

  try {
    logger.info(
      `[${requestId}] [AUTH] Resolving profile for Slack user: ${slackEvent.user}${
        config.mockEmailAddress ? ' (mock email override active)' : ''
      }`
    );
    const profile = await resolveUserProfile(slackEvent.user, config.slackBotToken, config.mockEmailAddress);
    if (profile.name) {
      conversationRef.userName = profile.name;
      logger.info(`[${requestId}] [AUTH] Resolved user name: ${profile.name}`);
    }

    if (profile.email) {
      logger.info(
        `[${requestId}] [AUTH] Resolved user email: ${profile.email}${config.mockEmailAddress ? ' [MOCKED]' : ''}`
      );
      conversationRef.userEmail = profile.email;
      resolvedEmail = profile.email;
      const found = await findUserByEmail(profile.email, config.devrevEndpointInternal, config.serviceAccountToken);

      if (!found) {
        logger.warn(`[${requestId}] [AUTH] User ${profile.email} is not in DevRev org — rejecting`);
        await sendMessage(
          conversationRef.channel,
          `Sorry, something went wrong. Please try again or contact your admin.`,
          config.slackBotToken,
          slackEvent.thread_ts || undefined
        ).catch(() => {
          /* swallow */
        });
        return { reason: 'User not in DevRev org', status: 'ignored' };
      }

      devrevUserId = found;
      logger.info(`[${requestId}] [AUTH] User verified in DevRev org: ${devrevUserId}, attempting act-as token`);
      conversationRef.devrevUserId = devrevUserId;
      const actAsToken = await getOrCreateActAsToken(
        devrevUserId,
        config.devrevEndpointInternal,
        config.serviceAccountToken
      );
      if (actAsToken) {
        userToken = actAsToken;
        tokenType = 'act_as (user PAT)';
        logger.info(`[${requestId}] [AUTH] Using act-as (user PAT) for user-scoped AI execution: ${profile.email}`);
      } else {
        logger.warn(`[${requestId}] [AUTH] act-as token failed, falling back to service account PAT`);
      }
    } else {
      logger.warn(
        `[${requestId}] [AUTH] Could not resolve email for Slack user: ${slackEvent.user} — using service account PAT`
      );
    }
  } catch (authError: any) {
    logger.warn(`[${requestId}] [AUTH] Auth lookup failed, using service account PAT:`, authError.message);
  }

  logger.info(`[${requestId}] [AUTH] Token selected: ${tokenType}`);

  // Build session identity from the routing tuple + resolved metadata.
  const routing = extractRoutingKeyParts(slackEvent);
  const conversationKey = buildConversationKey(routing.channel, routing.threadTs, routing.userId);
  const identity: SessionIdentity = {
    botUserId: conversationRef.botUserId,
    channel: conversationRef.channel,
    channelName: conversationRef.channelName,
    conversationKey,
    conversationType: conversationRef.conversationType,
    messageTs: conversationRef.messageTs,
    teamId: conversationRef.teamId,
    threadTs,
    userId: conversationRef.userId,
    userName: conversationRef.userName,
  };
  const userOverrides: SessionUserOverrides = {
    devrevUserId: devrevUserId || undefined,
    userEmail: resolvedEmail,
  };

  let sessionRecord: SessionRecord;
  try {
    sessionRecord = await resolveSession(
      storeConfig,
      timing,
      identity,
      userOverrides,
      isResetIntent ? 'reset' : 'message',
      requestId
    );
  } catch (resolveErr: any) {
    logger.error(`[${requestId}] [session] resolveSession failed: ${resolveErr?.message || resolveErr}`);
    return { details: resolveErr?.message, reason: 'Failed to resolve session', status: 'error' };
  }

  if (isResetIntent) {
    await sendMessage(
      conversationRef.channel,
      'Started a new session. Send your next message to begin a fresh conversation.',
      config.slackBotToken,
      threadTs
    ).catch((error: any) => {
      logger.warn(`[${requestId}] Failed to send new session confirmation: ${error?.message ?? error}`);
    });
    return { mode: 'new_session', session_id: sessionRecord.sessionId, status: 'success' };
  }

  try {
    logger.info(
      `[${requestId}] [SLACK] Sending initial 'Searching...' message to channel: ${conversationRef.channel}, thread: ${threadTs}`
    );
    const tempMessageTs = await sendMessage(conversationRef.channel, '⏳ Searching...', config.slackBotToken, threadTs);
    logger.info(`[${requestId}] [SLACK] Temp message sent, ts: ${tempMessageTs}`);

    conversationRef.tempMessageTs = tempMessageTs;

    // Persist routing patches onto the session — tempMessageTs lets the AI
    // response handler update/delete the placeholder, and the rest keep the
    // record current with whatever was resolved this turn. For collapsed
    // DM sessions, threadTs/messageTs roll forward so the AI response goes
    // to the latest message instead of the first DM ever.
    try {
      sessionRecord = await touchSession(storeConfig, sessionRecord, timing, {
        botUserId: conversationRef.botUserId,
        channelName: conversationRef.channelName,
        devrevUserId: devrevUserId || undefined,
        messageTs: conversationRef.messageTs,
        tempMessageTs,
        threadTs,
        userEmail: resolvedEmail,
      });
    } catch (touchErr: any) {
      logger.warn(`[${requestId}] [STORE] touchSession failed (post-temp): ${touchErr?.message || touchErr}`);
    }

    // Mirror the user's Slack message into the session's DevRev conversation
    // timeline. Authored as the resolved DevU via the act-as token; failures
    // don't block the AI invocation.
    if (sessionRecord.objectId) {
      await postTimelineComment({
        body: cleanedMessage,
        conversationId: sessionRecord.objectId,
        devrevEndpoint: config.devrevEndpointInternal,
        externalRef: `slack-user-${conversationRef.messageTs}`,
        token: userToken,
      });
    }

    // The session's DevRev conversation DON IS the AI Agent's server-side
    // context handle. Fall back to the session UUID only if conversation
    // creation failed and we have no objectId.
    const sessionObject = sessionRecord.objectId || sessionRecord.sessionId;
    logger.info(
      `[${requestId}] [CONV] session_object: ${sessionObject} (${
        sessionRecord.objectId ? 'conversation DON' : 'fallback session UUID'
      }); routing session_id: ${sessionRecord.sessionId}`
    );

    logger.info(
      `[${requestId}] [AI] Sending message to agent: agentId=${config.aiAgentId}, sessionObject=${sessionObject}, sessionId=${sessionRecord.sessionId}, tokenType=${tokenType}`
    );
    logger.info(`[${requestId}] [AI] Message to agent: "${cleanedMessage.substring(0, 200)}"`);
    await callAIAgentAsync(cleanedMessage, sessionObject, sessionRecord.sessionId, conversationRef, config, userToken);
    logger.info(`[${requestId}] [AI] Message submitted to AI Agent successfully`);

    return {
      message: 'Request submitted, responses will be sent via ai_agent_response events',
      mode: 'async',
      session_id: sessionRecord.sessionId,
      session_object: sessionObject,
      status: 'success',
    };
  } catch (error: any) {
    logger.error(`[${requestId}] [AI] Async API error: ${error.message}`);

    // Replace the "⏳ Searching..." placeholder in place with the
    // error text so we don't leave an orphaned placeholder + a
    // separate error message in the channel. If we never posted a
    // placeholder, fall back to a fresh message.
    if (config.slackBotToken) {
      const errorText = 'Sorry, I encountered an error processing your request. Please try again.';
      const placeholderTs = conversationRef.tempMessageTs;
      if (placeholderTs) {
        try {
          await updateMessage(conversationRef.channel, placeholderTs, errorText, config.slackBotToken);
        } catch (updateErr: any) {
          logger.warn(
            `[${requestId}] [AI] failed to overwrite placeholder with error (${
              updateErr?.message || updateErr
            }); sending fresh message`
          );
          await sendMessage(conversationRef.channel, errorText, config.slackBotToken, threadTs).catch(() => {
            /* swallow */
          });
        }
      } else {
        await sendMessage(conversationRef.channel, errorText, config.slackBotToken, threadTs).catch(() => {
          /* swallow */
        });
      }
    }

    return {
      details: error.message,
      reason: 'Failed to get AI Agent response',
      status: 'error',
    };
  }
}

/**
 * Extract configuration from event.
 */
function extractConfig(event: FunctionInput): any {
  const { input_data, execution_metadata, context } = event;
  const mockEmail = (input_data.global_values['mock_email_address'] || '').trim();
  return {
    aiAgentEventsSourceId: input_data.event_sources?.['ai-agent-events'],
    aiAgentId: input_data.global_values.ai_agent_id,
    devrevEndpoint: execution_metadata.devrev_endpoint.replace(/\/$/, '').replace(/\/internal$/, ''),
    devrevEndpointInternal: execution_metadata.devrev_endpoint.replace(/\/$/, ''),
    mockEmailAddress: isValidEmail(mockEmail) ? mockEmail : (null as string | null),
    mockEmailRaw: mockEmail || null,
    serviceAccountToken: context.secrets.service_account_token,
    slackBotToken: input_data.keyrings['slack_bot_token'],
    slackSigningSecret: input_data.keyrings['slack_signing_secret'],
  };
}

/**
 * Call the AI Agent API asynchronously using the DevRev SDK.
 *
 * `sessionObject` goes to DevRev as the AI Agent's server-side context handle
 * (the conversation DON that backs the session). `sessionId` is OUR routing
 * identity (our UUID) and is what the response handler keys on via
 * client_metadata.
 */
async function callAIAgentAsync(
  message: string,
  sessionObject: string,
  sessionId: string,
  conversationRef: ConversationReference,
  config: any,
  token: string
): Promise<void> {
  if (!config.aiAgentEventsSourceId) {
    throw new Error('ai-agent-events event source ID not available');
  }

  logger.info(
    `[AI Agent] Using endpoint: ${config.devrevEndpoint}, token type: ${
      token === config.serviceAccountToken ? 'service_account' : 'act_as'
    }`
  );
  const sdk = client.setupBeta({ endpoint: config.devrevEndpoint, token });

  const payload: any = {
    agent: config.aiAgentId,
    client_metadata: {
      conversation_reference: conversationRef,
      session_id: sessionId,
      slack_bot_token: config.slackBotToken,
    },
    event: { input_message: { message } },
    event_source_target: {
      event_source: config.aiAgentEventsSourceId,
    },
    session_object: sessionObject,
    target: 'event_source_target',
  };

  try {
    await sdk.aiAgentEventsExecuteAsync(payload);
  } catch (error: any) {
    logger.error(`[AI Agent Error Async] Status: ${error.response?.status}`);
    logger.error(`[AI Agent Error Response] ${JSON.stringify(error.response?.data, null, 2)}`);
    throw error;
  }
}

/**
 * Exported run function — entry point for the snap-in function.
 */
export const run = async (events: FunctionInput[]): Promise<any> => {
  const results = await Promise.all(
    events.map(async (event) => {
      try {
        return await handleSlackMessage(event);
      } catch (error: any) {
        logger.error(`[${event.execution_metadata.request_id}] Error processing Slack message:`, error);
        return {
          reason: error.message || 'Unknown error',
          status: 'error',
        };
      }
    })
  );

  return results.length === 1 ? results[0] : results;
};

export default run;
