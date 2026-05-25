/**
 * Slack Handler Function
 * 
 * Handles incoming messages from Slack and forwards them to DevRev AI Agents.
 */

import { betaSDK, client } from '@devrev/typescript-sdk';
import { FunctionInput } from '../../types';
import {
  extractConversationReference,
  generateSessionId,
  ConversationReference,
} from '../../utils/conversation-store';
import { storeConversationReference, StoreConfig } from '../../utils/session-store';
import { readSessionTimingConfig } from '../../utils/session-config';
import { sendMessage, getUserProfile, getChannelName, removeBotMention } from '../../utils/slack-client';
import { findUserByEmail, getOrCreateActAsToken } from '../../utils/devrev-auth';
import { validateSlackSignature } from '../../utils/slack-signature-validator';

const FORBIDDEN_RESPONSE = { status: 'forbidden', status_code: 403 };

/**
 * Main handler for Slack messages.
 * 
 * Purpose: Processes incoming messages from Slack, stores conversation context, and invokes the AI Agent.
 * Input Definitions:
 *  - event: The function input containing the Slack event payload, execution metadata, and global configuration.
 * Output Definitions:
 *  - Promise<any>: A status object indicating success or failure of the message processing.
 */
async function handleSlackMessage(event: FunctionInput): Promise<any> {
  const payload = event.payload;
  const requestId = event.execution_metadata.request_id;

  // The Rego policy now wraps inbound requests as { body, headers } so the
  // function can verify the Slack signature. Older payload shape (the parsed
  // Slack event directly) is preserved for backwards-compatible test fixtures.
  const wrapped =
    payload && typeof payload === 'object' && 'body' in payload && 'headers' in payload
      ? payload
      : null;
  const slackBody = wrapped ? wrapped.body : payload;
  const requestHeaders: Record<string, any> | undefined = wrapped ? wrapped.headers : undefined;
  const bodyRaw: string | undefined =
    wrapped && typeof (wrapped as any).body_raw === 'string' ? (wrapped as any).body_raw : undefined;

  const signingSecret = event.input_data.keyrings?.['slack_signing_secret'];
  const sigCheck = validateSlackSignature(signingSecret, requestHeaders, slackBody, bodyRaw);
  if (!sigCheck.valid) {
    console.warn(`[${requestId}] [auth] Slack signature rejected: ${sigCheck.reason}`);
    return FORBIDDEN_RESPONSE;
  }

  // Extract the Slack event from the event_callback payload
  const slackEvent = slackBody?.event;

  if (!slackEvent) {
    return { status: 'ignored', reason: 'No event in payload' };
  }

  // Only handle app_mention and message events
  if (slackEvent.type !== 'app_mention' && slackEvent.type !== 'message') {
    return { status: 'ignored', reason: `Unsupported event type: ${slackEvent.type}` };
  }

  // Skip bot messages to avoid loops
  if (slackEvent.bot_id || slackEvent.subtype === 'bot_message') {
    return { status: 'ignored', reason: 'Bot message' };
  }

  const messageText = slackEvent.text?.trim();
  if (!messageText) {
    return { status: 'ignored', reason: 'Empty message' };
  }

  const cleanedMessage = removeBotMention(messageText);
  if (!cleanedMessage) {
    return { status: 'ignored', reason: 'Empty message after removing mention' };
  }

  const config = extractConfig(event);
  
  if (!config.aiAgentId) {
    console.error(`[${requestId}] AI Agent ID not configured`);
    return { status: 'error', reason: 'AI Agent ID not configured' };
  }

  if (!config.slackBotToken) {
    console.error(`[${requestId}] Slack Bot Token not configured`);
    return { status: 'error', reason: 'Slack Bot Token not configured' };
  }

  // If mock email was entered but has invalid format, reject immediately — don't silently fall back
  if (config.mockEmailRaw && !config.mockEmailAddress) {
    console.error(`[${requestId}] [CONFIG] Mock email address has invalid format: "${config.mockEmailRaw}"`);
    await sendMessage(
      extractConversationReference(slackEvent).channel,
      `Sorry, something went wrong. Please try again or contact your admin.`,
      config.slackBotToken,
      slackEvent.thread_ts || undefined
    ).catch(() => {});
    return { status: 'error', reason: 'Invalid mock email address format in config' };
  }

  const conversationRef = extractConversationReference(slackEvent);
  const sessionId = generateSessionId(slackEvent);

  if (!conversationRef.channelName && conversationRef.channel) {
    try {
      const resolvedChannelName = await getChannelName(conversationRef.channel, config.slackBotToken);
      if (resolvedChannelName) {
        conversationRef.channelName = resolvedChannelName;
        console.log(`[${requestId}] [CHAN] Resolved channel name: ${resolvedChannelName} for ${conversationRef.channel}`);
      }
    } catch (chanErr: any) {
      console.warn(`[${requestId}] [CHAN] Failed to resolve channel name for ${conversationRef.channel}: ${chanErr?.message || chanErr}`);
    }
  }

  // Determine thread_ts for replies - use existing thread or start a new one
  const threadTs = slackEvent.thread_ts || slackEvent.ts;

  const storeConfig: StoreConfig = {
    devrevEndpoint: config.devrevEndpointInternal,
    serviceAccountToken: config.serviceAccountToken,
    timing: readSessionTimingConfig(event.input_data.global_values),
  };

  // Stamp the bot user id (the recipient of the @mention) onto the ref so it
  // ends up on the persisted custom object. Slack puts the bot in
  // event.authorizations[0].user_id for events the bot was authorized for.
  const botUserId =
    slackBody?.authorizations?.[0]?.user_id ||
    slackBody?.api_app_id ||
    undefined;
  if (botUserId) {
    conversationRef.botUserId = botUserId;
  }

  // Verify user is in DevRev org and get act-as token for user-scoped AI execution
  let userToken = config.serviceAccountToken;
  let tokenType = 'service_account';

  console.log(`[${requestId}] [MSG] Incoming message from Slack user: ${slackEvent.user}, channel: ${conversationRef.channel}, text: "${cleanedMessage.substring(0, 100)}"`);

  try {
    console.log(`[${requestId}] [AUTH] Resolving profile for Slack user: ${slackEvent.user}${config.mockEmailAddress ? ' (mock email override active)' : ''}`);
    const profile = await resolveUserProfile(slackEvent.user, config.slackBotToken, config.mockEmailAddress);
    const userEmail = profile.email;
    if (profile.name) {
      conversationRef.userName = profile.name;
      console.log(`[${requestId}] [AUTH] Resolved user name: ${profile.name}`);
    }

    if (userEmail) {
      console.log(`[${requestId}] [AUTH] Resolved user email: ${userEmail}${config.mockEmailAddress ? ' [MOCKED]' : ''}`);
      conversationRef.userEmail = userEmail;
      const devrevUserId = await findUserByEmail(userEmail, config.devrevEndpointInternal, config.serviceAccountToken);

      if (!devrevUserId) {
        console.warn(`[${requestId}] [AUTH] User ${userEmail} is not in DevRev org — rejecting`);
        await sendMessage(
          conversationRef.channel,
          `Sorry, something went wrong. Please try again or contact your admin.`,
          config.slackBotToken,
          slackEvent.thread_ts || undefined
        ).catch(() => {});
        return { status: 'ignored', reason: 'User not in DevRev org' };
      }

      console.log(`[${requestId}] [AUTH] User verified in DevRev org: ${devrevUserId}, attempting act-as token`);
      conversationRef.devrevUserId = devrevUserId;
      const actAsToken = await getOrCreateActAsToken(devrevUserId, config.devrevEndpointInternal, config.serviceAccountToken);
      if (actAsToken) {
        userToken = actAsToken;
        tokenType = 'act_as (user PAT)';
        console.log(`[${requestId}] [AUTH] Using act-as (user PAT) for user-scoped AI execution: ${userEmail}`);
      } else {
        console.warn(`[${requestId}] [AUTH] act-as token failed, falling back to service account PAT`);
      }
    } else {
      console.warn(`[${requestId}] [AUTH] Could not resolve email for Slack user: ${slackEvent.user} — using service account PAT`);
    }
  } catch (authError: any) {
    console.warn(`[${requestId}] [AUTH] Auth lookup failed, using service account PAT:`, authError.message);
  }

  console.log(`[${requestId}] [AUTH] Token selected: ${tokenType}`);

  // Persist the initial session record now that identity (email / devrev user)
  // is resolved. Best-effort — failures don't block message delivery.
  try {
    await storeConversationReference(storeConfig, sessionId, conversationRef);
  } catch (storeErr: any) {
    console.warn(`[${requestId}] [STORE] Initial reference persist failed: ${storeErr?.message || storeErr}`);
  }

  try {
    console.log(`[${requestId}] [SLACK] Sending initial 'Searching...' message to channel: ${conversationRef.channel}, thread: ${threadTs}`);
    const tempMessageTs = await sendMessage(
      conversationRef.channel,
      '⏳ Searching...',
      config.slackBotToken,
      threadTs
    );
    console.log(`[${requestId}] [SLACK] Temp message sent, ts: ${tempMessageTs}`);

    conversationRef.tempMessageTs = tempMessageTs;
    conversationRef.threadTs = threadTs;

    // Create a real DevRev conversation so the AI agent has org context for data queries
    console.log(`[${requestId}] [CONV] Creating DevRev conversation for org context`);
    const devrevConversationId = await createDevRevConversation(
      cleanedMessage,
      config.devrevEndpoint,
      config.serviceAccountToken
    );
    const sessionObject = devrevConversationId || sessionId;
    console.log(`[${requestId}] [CONV] session_object: ${sessionObject} (${devrevConversationId ? 'conversation DON' : 'fallback session id'})`);

    try {
      await storeConversationReference(storeConfig, sessionObject, conversationRef);
      console.log(`[${requestId}] [STORE] Conversation reference stored for session: ${sessionObject}`);
    } catch (storeErr: any) {
      console.warn(`[${requestId}] [STORE] Persist for sessionObject failed: ${storeErr?.message || storeErr}`);
    }

    console.log(`[${requestId}] [AI] Sending message to agent: agentId=${config.aiAgentId}, sessionObject=${sessionObject}, tokenType=${tokenType}`);
    console.log(`[${requestId}] [AI] Message to agent: "${cleanedMessage.substring(0, 200)}"`);
    await callAIAgentAsync(cleanedMessage, sessionObject, conversationRef, config, userToken);
    console.log(`[${requestId}] [AI] Message submitted to AI Agent successfully`);

    return {
      status: 'success',
      mode: 'async',
      session_id: sessionObject,
      message: 'Request submitted, responses will be sent via ai_agent_response events',
    };
  } catch (error: any) {
    console.error(`[${requestId}] [AI] Async API error: ${error.message}`);

    if (config.slackBotToken) {
      await sendMessage(
        conversationRef.channel,
        'Sorry, I encountered an error processing your request. Please try again.',
        config.slackBotToken,
        threadTs
      ).catch(() => {});
    }

    return {
      status: 'error',
      reason: 'Failed to get AI Agent response',
      details: error.message,
    };
  }
}

/**
 * Extract configuration from event.
 *
 * Purpose: Gathers all necessary IDs, tokens, and endpoints from the function input metadata and global configuration.
 */
function extractConfig(event: FunctionInput): any {
  const { input_data, execution_metadata, context } = event;
  const mockEmail = (input_data.global_values['mock_email_address'] || '').trim();
  return {
    aiAgentId: input_data.global_values.ai_agent_id,
    slackBotToken: input_data.keyrings['slack_bot_token'],
    slackSigningSecret: input_data.keyrings['slack_signing_secret'],
    devrevEndpoint: execution_metadata.devrev_endpoint.replace(/\/$/, '').replace(/\/internal$/, ''),
    devrevEndpointInternal: execution_metadata.devrev_endpoint.replace(/\/$/, ''),
    serviceAccountToken: context.secrets.service_account_token,
    aiAgentEventsSourceId: input_data.event_sources?.['ai-agent-events'],
    mockEmailRaw: mockEmail || null,
    mockEmailAddress: isValidEmail(mockEmail) ? mockEmail : null as string | null,
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
 * Create a DevRev support conversation so the AI agent has org context.
 * Returns the conversation DON or null if creation fails.
 */
async function createDevRevConversation(
  message: string,
  endpoint: string,
  token: string
): Promise<string | null> {
  try {
    const sdk = client.setupBeta({ endpoint, token });
    const response = await sdk.conversationsCreate({
      title: message.substring(0, 100),
      type: betaSDK.ConversationsCreateRequestTypeValue.Support,
    });
    const id = response.data?.conversation?.id ?? null;
    if (!id) return null;
    console.log(`[Conversation] Created conversation: ${id}`);

    // Post the message as a timeline entry so the AI agent has context
    await sdk.timelineEntriesCreate({
      object: id,
      type: betaSDK.TimelineEntriesCreateRequestType.TimelineComment,
      body: message,
      visibility: betaSDK.TimelineEntryVisibility.External,
    });
    console.log(`[Conversation] Posted message to timeline`);

    return id;
  } catch (error: any) {
    console.error('[Conversation] Failed to create conversation:', error.response?.data || error.message);
    return null;
  }
}

/**
 * Call the AI Agent API asynchronously using the DevRev SDK.
 */
async function callAIAgentAsync(
  message: string,
  sessionObject: string,
  conversationRef: ConversationReference,
  config: any,
  token: string
): Promise<void> {
  if (!config.aiAgentEventsSourceId) {
    throw new Error('ai-agent-events event source ID not available');
  }

  console.log(`[AI Agent] Using endpoint: ${config.devrevEndpoint}, token type: ${token === config.serviceAccountToken ? 'service_account' : 'act_as'}`);
  const sdk = client.setupBeta({ endpoint: config.devrevEndpoint, token });

  const payload: any = {
    agent: config.aiAgentId,
    session_object: sessionObject,
    event: { input_message: { message } },
    client_metadata: {
      session_id: sessionObject,
      slack_bot_token: config.slackBotToken,
      conversation_reference: conversationRef,
    },
    event_source_target: {
      event_source: config.aiAgentEventsSourceId,
    },
    target: 'event_source_target',
  };

  try {
    await sdk.aiAgentEventsExecuteAsync(payload);
  } catch (error: any) {
    console.error(`[AI Agent Error Async] Status: ${error.response?.status}`);
    console.error(`[AI Agent Error Response] ${JSON.stringify(error.response?.data, null, 2)}`);
    throw error;
  }
}

/**
 * Exported run function - entry point for the snap-in function.
 */
export const run = async (events: FunctionInput[]): Promise<any> => {
  const results = await Promise.all(
    events.map(async (event) => {
      try {
        return await handleSlackMessage(event);
      } catch (error: any) {
        console.error(`[${event.execution_metadata.request_id}] Error processing Slack message:`, error);
        return {
          status: 'error',
          reason: error.message || 'Unknown error',
        };
      }
    })
  );
  
  return results.length === 1 ? results[0] : results;
};

export default run;
