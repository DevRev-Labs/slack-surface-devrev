/**
 * Slack Handler Function
 * 
 * Handles incoming messages from Slack and forwards them to DevRev AI Agents.
 */

import axios from 'axios';
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

  // Get user token (try email-based auth, fall back to service account)
  let userToken = config.serviceAccountToken;

  try {
    const userEmail = await getUserEmail(slackEvent.user, config.slackBotToken);
    
    if (userEmail) {
      console.log(`[${requestId}] Found user email: ${userEmail}`);
      
      const devrevUserId = await findUserByEmail(userEmail, config.devrevEndpoint, config.serviceAccountToken);
      
      if (devrevUserId) {
        const actAsToken = await getOrCreateActAsToken(devrevUserId, config.devrevEndpoint, config.serviceAccountToken);
        if (actAsToken) {
          userToken = actAsToken;
          console.log(`[${requestId}] Using act-as token for user`);
        }
      } else {
        console.warn(`[${requestId}] No DevRev user found for email: ${userEmail}`);
      }
    } else {
      console.warn(`[${requestId}] Could not get user email from Slack`);
    }
  } catch (authError: any) {
    console.warn(`[${requestId}] Failed to perform email-based auth, falling back to service account:`, authError.message);
  }

  try {
    // Send initial "Searching..." message
    const tempMessageTs = await sendMessage(
      conversationRef.channel,
      '⏳ Searching...',
      config.slackBotToken,
      threadTs
    );

    // Update conversation reference with temp message ts
    conversationRef.tempMessageTs = tempMessageTs;
    conversationRef.threadTs = threadTs;
    storeConversationReference(sessionId, conversationRef);

    // Call AI Agent asynchronously
    await callAIAgentAsync(cleanedMessage, sessionId, conversationRef, config, userToken);

    return {
      status: 'success',
      mode: 'async',
      session_id: sessionId,
      message: 'Request submitted, responses will be sent via ai_agent_response events',
    };
  } catch (error: any) {
    console.error(`[${requestId}] Async API error:`, error.message);
    
    // Try sync fallback
    try {
      const agentResponse = await callAIAgentSync(cleanedMessage, sessionId, config, userToken);

      if (agentResponse && config.slackBotToken) {
        // If we have a temp message, update it; otherwise send new message
        if (conversationRef.tempMessageTs) {
          const { updateMessage } = await import('../../utils/slack-client');
          await updateMessage(
            conversationRef.channel,
            conversationRef.tempMessageTs,
            agentResponse,
            config.slackBotToken
          );
        } else {
          await sendMessage(conversationRef.channel, agentResponse, config.slackBotToken, threadTs);
        }
      }

      return {
        status: 'success',
        mode: 'sync_fallback',
        session_id: sessionId,
        response_preview: agentResponse?.substring(0, 100),
      };
    } catch (syncError: any) {
      console.error(`[${requestId}] Sync fallback error:`, syncError.message);
      
      // Send error message to Slack
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
        details: syncError.message,
      };
    }
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
    devrevEndpoint: execution_metadata.devrev_endpoint.replace(/\/$/, ''),
    serviceAccountToken: context.secrets.service_account_token,
    aiAgentEventsSourceId: input_data.event_sources?.['ai-agent-events'],
  };
}

/**
 * Call the AI Agent API synchronously.
 */
async function callAIAgentSync(message: string, sessionId: string, config: any, token: string): Promise<string> {
  const apiUrl = `${config.devrevEndpoint}/internal/ai-agents.events.execute-sync`;
  
  const payload = {
    agent: config.aiAgentId,
    session_object: sessionId,
    event: { input_message: { message } },
  };

  try {
    const response = await axios.post(apiUrl, payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    });
    return parseAgentResponse(response.data);
  } catch (error: any) {
    console.error(`[AI Agent Error Sync] Status: ${error.response?.status}`);
    console.error(`[AI Agent Error Response] ${JSON.stringify(error.response?.data, null, 2)}`);
    throw error;
  }
}

/**
 * Call the AI Agent API asynchronously with event_source_target.
 */
async function callAIAgentAsync(
  message: string,
  sessionId: string,
  conversationRef: ConversationReference,
  config: any,
  token: string
): Promise<void> {
  const apiUrl = `${config.devrevEndpoint}/internal/ai-agents.events.execute-async`;
  
  if (!config.aiAgentEventsSourceId) {
    throw new Error('ai-agent-events event source ID not available');
  }
  
  const payload: any = {
    agent: config.aiAgentId,
    session_object: sessionId,
    event: { input_message: { message } },
    client_metadata: {
      session_id: sessionId,
      slack_bot_token: config.slackBotToken,
      conversation_reference: conversationRef,
    },
    target: 'event_source_target',
    event_source_target: {
      event_source: config.aiAgentEventsSourceId,
    },
  };

  try {
    await axios.post(apiUrl, payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  } catch (error: any) {
    console.error(`[AI Agent Error Async] Status: ${error.response?.status}`);
    console.error(`[AI Agent Error Response] ${JSON.stringify(error.response?.data, null, 2)}`);
    throw error;
  }
}

/**
 * Parse AI Agent response (handles SSE and JSON formats).
 */
function parseAgentResponse(data: any): string {
  const responseText = typeof data === 'string' ? data : JSON.stringify(data);

  if (responseText.includes('data:')) {
    const lines = responseText.split('\n');
    for (const line of lines) {
      if (!line.trim().startsWith('data:')) continue;

      try {
        const jsonStr = line.replace('data:', '').trim();
        if (!jsonStr) continue;

        const parsed = JSON.parse(jsonStr);
        const msg = parsed.response === 'message' ? parsed.message : (parsed.output_message?.message || parsed.message);
        if (msg) return msg;
      } catch {
        continue;
      }
    }
    return responseText;
  }

  try {
    const jsonData = typeof data === 'object' ? data : JSON.parse(responseText);
    return jsonData.message || jsonData.output_message?.message || responseText;
  } catch {
    return responseText;
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
