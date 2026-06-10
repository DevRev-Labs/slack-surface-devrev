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

import {
  LOG_TAG,
  PROGRESS_SEARCHING_MESSAGE,
  SESSION_RESET_CONFIRMATION_MESSAGE,
  SESSION_RESET_PHRASES,
} from '../../config';
import { FunctionInput } from '../../types';
import {
  ConversationReference,
  extractConversationReference,
  extractRoutingKeyParts,
} from '../../utils/conversation-store';
import { findUserByEmail, getOrCreateActAsToken } from '../../utils/devrev-auth';
import { createLogger } from '../../utils/logger';
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
import { getChannelName, getUserProfile, removeBotMention, sendMessage } from '../../utils/slack-client';
import { validateSlackSignature } from '../../utils/slack-signature-validator';
import { postTimelineComment } from '../../utils/timeline';

const FORBIDDEN_RESPONSE = { status: 'forbidden', status_code: 403 };

// Reuse the central set so the list of reset phrases is maintained in one place.
const RESET_INTENT_PHRASES = SESSION_RESET_PHRASES;

/**
 * Find or create the right session for this Slack message.
 *
 * - reset intent → rotate existing (or create) with reason `user_reset`.
 * - normal flow → reuse active, rotate on idle/absolute expiry, else create.
 *
 * `requireExistingSession=true` (used for unmentioned thread replies) skips
 * session creation when no active row is found — the caller treats that as
 * "ignore this message".
 */
async function resolveSession(
  storeConfig: StoreConfig,
  timing: SessionTimingConfig,
  identity: SessionIdentity,
  userOverrides: SessionUserOverrides,
  intent: 'message' | 'reset',
  requestId: string,
  requireExistingSession = false
): Promise<SessionRecord | null> {
  // Per-request logger scoped to the SESSION subsystem.
  const log = createLogger(requestId, LOG_TAG.SESSION);
  const existing = await getActiveSession(storeConfig, identity.conversationKey);

  if (intent === 'reset') {
    if (existing) {
      const rotated = await rotateSession(storeConfig, existing, 'user_reset', identity, timing, userOverrides);
      log.info('rotated user_reset', { new_session: rotated.sessionId, old_session: existing.sessionId });
      return rotated;
    }
    const fresh = await createSession(storeConfig, { identity, ...userOverrides }, timing);
    log.info('created (after reset, no prior)', { session_id: fresh.sessionId });
    return fresh;
  }

  if (!existing) {
    if (requireExistingSession) {
      log.info('no active session for thread reply — ignoring');
      return null;
    }
    const fresh = await createSession(storeConfig, { identity, ...userOverrides }, timing);
    log.info('created', { generation: fresh.generation, session_id: fresh.sessionId });
    return fresh;
  }

  const expiredReason = isSessionExpired(existing);
  if (expiredReason) {
    if (requireExistingSession) {
      log.info('active session expired for thread reply — ignoring', { reason: expiredReason });
      return null;
    }
    const rotated = await rotateSession(storeConfig, existing, expiredReason, identity, timing, userOverrides);
    log.info('rotated', {
      generation: rotated.generation,
      new_session: rotated.sessionId,
      old_session: existing.sessionId,
      reason: expiredReason,
    });
    return rotated;
  }

  log.info('reused', {
    message_count: existing.messageCount,
    generation: existing.generation,
    session_id: existing.sessionId,
  });
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
  // Per-request logger — subsystem tag overridden per call site below.
  const log = createLogger(requestId, LOG_TAG.MSG);

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
    log.warn('Slack signature rejected', { reason: sigCheck.reason }, LOG_TAG.AUTH);
    return FORBIDDEN_RESPONSE;
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

  // In channels and group DMs, the bot only kicks off a fresh session when it
  // is explicitly @-mentioned (`app_mention`). Plain `message` events are
  // processed only if they are continuing an *existing* session for this
  // (channel, thread, user) — i.e. follow-up replies inside a thread the bot
  // is already part of. A top-level channel message without a mention starts
  // no session, so it falls through and is ignored downstream. DMs
  // (`channel_type === 'im'`) treat every message as in-scope.
  const isChannelMessageWithoutMention = slackEvent.type === 'message' && slackEvent.channel_type !== 'im';

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
    log.error('AI Agent ID not configured');
    return { reason: 'AI Agent ID not configured', status: 'error' };
  }

  if (!config.slackBotToken) {
    log.error('Slack Bot Token not configured');
    return { reason: 'Slack Bot Token not configured', status: 'error' };
  }

  // If mock email was entered but has invalid format, reject immediately — don't silently fall back
  if (config.mockEmailRaw && !config.mockEmailAddress) {
    log.error('Mock email address has invalid format', { mock_email_raw: config.mockEmailRaw }, LOG_TAG.CONFIG);
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
        log.info('Resolved channel name', { channel: conversationRef.channel, channel_name: resolvedChannelName }, LOG_TAG.CHAN);
      }
    } catch (chanErr: any) {
      log.warn('Failed to resolve channel name', {
        channel: conversationRef.channel,
        err_message: chanErr?.message || chanErr,
      }, LOG_TAG.CHAN);
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

  log.info('Incoming message', {
    channel: conversationRef.channel,
    text_preview: cleanedMessage.substring(0, 100),
    user: slackEvent.user,
  });

  try {
    log.info('Resolving profile for Slack user', {
      mock_active: Boolean(config.mockEmailAddress),
      user: slackEvent.user,
    }, LOG_TAG.AUTH);
    const profile = await resolveUserProfile(slackEvent.user, config.slackBotToken, config.mockEmailAddress);
    if (profile.name) {
      conversationRef.userName = profile.name;
      log.info('Resolved user name', { user_name: profile.name }, LOG_TAG.AUTH);
    }

    if (profile.email) {
      log.info('Resolved user email', { email: profile.email, mocked: Boolean(config.mockEmailAddress) }, LOG_TAG.AUTH);
      conversationRef.userEmail = profile.email;
      resolvedEmail = profile.email;
      const found = await findUserByEmail(profile.email, config.devrevEndpointInternal, config.serviceAccountToken);

      if (!found) {
        log.warn('User is not in DevRev org — rejecting', { email: profile.email }, LOG_TAG.AUTH);
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
      log.info('User verified in DevRev org, attempting act-as token', { devrev_user_id: devrevUserId }, LOG_TAG.AUTH);
      conversationRef.devrevUserId = devrevUserId;
      const actAsToken = await getOrCreateActAsToken(
        devrevUserId,
        config.devrevEndpointInternal,
        config.serviceAccountToken
      );
      if (actAsToken) {
        userToken = actAsToken;
        tokenType = 'act_as (user PAT)';
        log.info('Using act-as (user PAT) for user-scoped AI execution', { email: profile.email }, LOG_TAG.AUTH);
      } else {
        log.warn('act-as token failed, falling back to service account PAT', {}, LOG_TAG.AUTH);
      }
    } else {
      log.warn('Could not resolve email for Slack user — using service account PAT', { user: slackEvent.user }, LOG_TAG.AUTH);
    }
  } catch (authError: any) {
    log.warn('Auth lookup failed, using service account PAT', { err_message: authError.message }, LOG_TAG.AUTH);
  }

  log.info('Token selected', { token_type: tokenType }, LOG_TAG.AUTH);

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

  let sessionRecord: SessionRecord | null;
  try {
    sessionRecord = await resolveSession(
      storeConfig,
      timing,
      identity,
      userOverrides,
      isResetIntent ? 'reset' : 'message',
      requestId,
      isChannelMessageWithoutMention
    );
  } catch (resolveErr: any) {
    log.error('resolveSession failed', { err_message: resolveErr?.message || resolveErr }, LOG_TAG.SESSION);
    return { details: resolveErr?.message, reason: 'Failed to resolve session', status: 'error' };
  }

  if (!sessionRecord) {
    return { reason: 'Channel message outside of an active bot session', status: 'ignored' };
  }

  if (isResetIntent) {
    await sendMessage(
      conversationRef.channel,
      SESSION_RESET_CONFIRMATION_MESSAGE,
      config.slackBotToken,
      threadTs
    ).catch((error: any) => {
      log.warn('Failed to send new session confirmation', { err_message: error?.message ?? error });
    });
    return { mode: 'new_session', session_id: sessionRecord.sessionId, status: 'success' };
  }

  try {
    log.info('Sending initial searching message', { channel: conversationRef.channel, thread: threadTs }, LOG_TAG.SLACK);
    // PROGRESS_SEARCHING_MESSAGE is "⏳ Searching..." — sourced from config.
    const tempMessageTs = await sendMessage(conversationRef.channel, PROGRESS_SEARCHING_MESSAGE, config.slackBotToken, threadTs);
    log.info('Temp message sent', { ts: tempMessageTs }, LOG_TAG.SLACK);

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
      log.warn('touchSession failed (post-temp)', { err_message: touchErr?.message || touchErr }, LOG_TAG.STORE);
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
    log.info('session_object resolved', {
      object_type: sessionRecord.objectId ? 'conversation DON' : 'fallback session UUID',
      session_id: sessionRecord.sessionId,
      session_object: sessionObject,
    }, LOG_TAG.CONV);

    log.info('Sending message to agent', {
      agent_id: config.aiAgentId,
      message_preview: cleanedMessage.substring(0, 200),
      session_id: sessionRecord.sessionId,
      session_object: sessionObject,
      token_type: tokenType,
    }, LOG_TAG.AI);
    await callAIAgentAsync(cleanedMessage, sessionObject, sessionRecord.sessionId, conversationRef, config, userToken);
    log.info('Message submitted to AI Agent successfully', {}, LOG_TAG.AI);

    return {
      message: 'Request submitted, responses will be sent via ai_agent_response events',
      mode: 'async',
      session_id: sessionRecord.sessionId,
      session_object: sessionObject,
      status: 'success',
    };
  } catch (error: any) {
    log.error('Async API error', { err_message: error.message }, LOG_TAG.AI);

    if (config.slackBotToken) {
      await sendMessage(
        conversationRef.channel,
        'Sorry, I encountered an error processing your request. Please try again.',
        config.slackBotToken,
        threadTs
      ).catch(() => {
        /* swallow */
      });
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
 * Resolve the email + display name for a Slack user.
 * If mock_email_address is configured (testing), the email is overridden but
 * the real display name is still fetched from Slack.
 */
async function resolveUserProfile(
  slackUserId: string,
  slackBotToken: string,
  mockEmail: string | null
): Promise<{ email: string | null; name: string | null }> {
  const profile = await getUserProfile(slackUserId, slackBotToken);
  if (mockEmail) {
    return { email: mockEmail, name: profile.name };
  }
  return profile;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

  // Module-level logger — no requestId available at this call depth.
  const aiLog = createLogger(undefined, LOG_TAG.AI);
  aiLog.debug('Using endpoint', {
    endpoint: config.devrevEndpoint,
    token_type: token === config.serviceAccountToken ? 'service_account' : 'act_as',
  });
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
    aiLog.error('Async execution failed', {
      err_data: error.response?.data,
      err_status: error.response?.status,
    });
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
        createLogger(event.execution_metadata.request_id, LOG_TAG.MSG).error(
          'Error processing Slack message',
          { err_message: error.message }
        );
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
