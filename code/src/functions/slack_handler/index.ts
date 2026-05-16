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
  storeConversationReference,
} from '../../utils/conversation-store';
import { sendMessage, getUserEmail, removeBotMention } from '../../utils/slack-client';
import { findUserByEmail, getOrCreateActAsToken } from '../../utils/devrev-auth';

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
  
  // Extract the Slack event from the event_callback payload
  const slackEvent = payload.event;
  
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

  const conversationRef = extractConversationReference(slackEvent);
  const sessionId = generateSessionId(slackEvent);
  
  // Determine thread_ts for replies - use existing thread or start a new one
  const threadTs = slackEvent.thread_ts || slackEvent.ts;

  // Store initial conversation reference
  storeConversationReference(sessionId, conversationRef);

  // Verify user is in DevRev org and get act-as token for user-scoped AI execution
  let userToken = config.serviceAccountToken;

  try {
    console.log(`[${requestId}] [AUTH] Looking up email for Slack user: ${slackEvent.user}`);
    const userEmail = await getUserEmail(slackEvent.user, config.slackBotToken);

    if (userEmail) {
      console.log(`[${requestId}] [AUTH] Found user email: ${userEmail}`);
      const devrevUserId = await findUserByEmail(userEmail, config.devrevEndpointInternal, config.serviceAccountToken);

      if (!devrevUserId) {
        console.warn(`[${requestId}] [AUTH] User ${userEmail} is not in DevRev org — rejecting`);
        await sendMessage(
          conversationRef.channel,
          `Sorry, your account (${userEmail}) is not part of the DevRev organization. Please contact your admin to get access.`,
          config.slackBotToken,
          slackEvent.thread_ts || undefined
        ).catch(() => {});
        return { status: 'ignored', reason: 'User not in DevRev org' };
      }

      console.log(`[${requestId}] [AUTH] User verified in org: ${devrevUserId}, trying act-as token`);
      const actAsToken = await getOrCreateActAsToken(devrevUserId, config.devrevEndpointInternal, config.serviceAccountToken);
      if (actAsToken) {
        userToken = actAsToken;
        console.log(`[${requestId}] [AUTH] Using act-as token for user-scoped AI execution`);
      } else {
        console.warn(`[${requestId}] [AUTH] act-as failed, falling back to service account token`);
      }
    } else {
      console.warn(`[${requestId}] [AUTH] Could not get user email from Slack for user: ${slackEvent.user}`);
    }
  } catch (authError: any) {
    console.warn(`[${requestId}] [AUTH] Auth lookup failed:`, authError.message);
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
    storeConversationReference(sessionId, conversationRef);
    console.log(`[${requestId}] [STORE] Conversation reference stored for session: ${sessionId}`);

    console.log(`[${requestId}] [AI] Calling AI Agent async, agentId: ${config.aiAgentId}, sessionId: ${sessionId}`);
    await callAIAgentAsync(cleanedMessage, sessionId, conversationRef, config, userToken);
    console.log(`[${requestId}] [AI] Async AI Agent call submitted successfully`);

    return {
      status: 'success',
      mode: 'async',
      session_id: sessionId,
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
  return {
    aiAgentId: input_data.global_values.ai_agent_id,
    slackBotToken: input_data.keyrings['slack_bot_token'],
    slackSigningSecret: input_data.keyrings['slack_signing_secret'],
    devrevEndpoint: execution_metadata.devrev_endpoint.replace(/\/$/, '').replace(/\/internal$/, ''),
    devrevEndpointInternal: execution_metadata.devrev_endpoint.replace(/\/$/, ''),
    serviceAccountToken: context.secrets.service_account_token,
    aiAgentEventsSourceId: input_data.event_sources?.['ai-agent-events'],
  };
}

/**
 * Call the AI Agent API asynchronously using the DevRev SDK.
 */
async function callAIAgentAsync(
  message: string,
  sessionId: string,
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
    session_object: sessionId,
    event: { input_message: { message } },
    client_metadata: {
      session_id: sessionId,
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
