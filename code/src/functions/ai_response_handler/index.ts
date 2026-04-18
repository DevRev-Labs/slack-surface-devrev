/**
 * AI Response Handler Function
 * 
 * Handles async responses from DevRev AI Agents and sends them back to Slack.
 */

import { FunctionInput } from '../../types';
import { ConversationReference, getConversationReference, storeConversationReference } from '../../utils/conversation-store';
import { sendMessage, updateMessage, deleteMessage } from '../../utils/slack-client';

/**
 * Main handler for AI Agent responses.
 * 
 * Purpose: Processes asynchronous responses from DevRev AI Agents and forwards them back to the original Slack conversation.
 * Input Definitions:
 *  - event: The function input containing the AI response payload, execution metadata, and global configuration.
 * Output Definitions:
 *  - Promise<any>: A status object indicating success or failure of the message delivery.
 */
async function handleAIResponse(event: FunctionInput): Promise<any> {
  const { payload, execution_metadata, input_data } = event;
  const requestId = execution_metadata.request_id;
  
  const clientMetadata = payload.client_metadata || payload.ai_agent_response?.client_metadata || {};
  const sessionId = clientMetadata.session_id || payload.session_object || payload.ai_agent_response?.session_object;
  
  if (!sessionId) {
    console.error(`[${requestId}] No session ID in AI response. Payload:`, JSON.stringify(payload));
    return { status: 'error', reason: 'No session ID in response' };
  }

  let conversationRef: ConversationReference | undefined = getConversationReference(sessionId);
  if (!conversationRef) {
    const fromMetadata = clientMetadata.conversation_reference;
    if (fromMetadata && typeof fromMetadata === 'object') {
      conversationRef = {
        ...(fromMetadata as ConversationReference),
        timestamp: (fromMetadata as any).timestamp ?? Date.now(),
      };
      storeConversationReference(sessionId, conversationRef);
    }
  }

  if (!conversationRef) {
    console.error(`[${requestId}] No conversation reference found for session: ${sessionId}`);
    return { status: 'error', reason: 'Conversation reference not found' };
  }

  // Get Slack bot token from client_metadata or keyrings
  const slackBotToken = clientMetadata.slack_bot_token || input_data.keyrings['slack_bot_token'];

  if (!slackBotToken) {
    console.error(`[${requestId}] Slack Bot Token not configured`);
    return { status: 'error', reason: 'Slack Bot Token not configured' };
  }

  const agentResponseType = payload.ai_agent_response?.agent_response || payload.agent_response;

  // Ignore suggestions events
  if (agentResponseType === 'suggestions' || payload.ai_agent_response?.suggestions) {
    return { status: 'ignored', reason: 'Suggestions event' };
  }

  // Handle progress events - update the temp message
  if (agentResponseType === 'progress') {
    const progress = payload.ai_agent_response?.progress || payload.progress;
    if (progress) {
      const progressMessage = getProgressMessage(progress);
      
      try {
        if (conversationRef.tempMessageTs) {
          await updateMessage(
            conversationRef.channel,
            conversationRef.tempMessageTs,
            progressMessage,
            slackBotToken
          );
        } else {
          // No temp message, send a new one
          const ts = await sendMessage(
            conversationRef.channel,
            progressMessage,
            slackBotToken,
            conversationRef.threadTs
          );
          conversationRef.tempMessageTs = ts;
          storeConversationReference(sessionId, conversationRef);
        }
        return { status: 'success', message: 'Progress update sent to Slack' };
      } catch (error: any) {
        console.error(`[${requestId}] Failed to send progress update:`, error.message);
        return { status: 'error', reason: 'Failed to send progress' };
      }
    }
  }

  // Handle error events
  if (agentResponseType === 'error') {
    const errorMsg = payload.ai_agent_response?.error?.error || payload.error?.error || 'Unknown AI error';
    try {
      // Delete temp message and send error as new message
      if (conversationRef.tempMessageTs) {
        await deleteMessage(conversationRef.channel, conversationRef.tempMessageTs, slackBotToken);
        delete conversationRef.tempMessageTs;
        storeConversationReference(sessionId, conversationRef);
      }
      
      await sendMessage(
        conversationRef.channel,
        `❌ Error: ${errorMsg}`,
        slackBotToken,
        conversationRef.threadTs
      );
      return { status: 'error', message: 'AI error sent to Slack' };
    } catch (error: any) {
      console.error(`[${requestId}] Failed to send error message:`, error.message);
      return { status: 'error', reason: 'Failed to send error message' };
    }
  }

  // Handle final message - delete temp message and send final response
  const responseText = extractResponseText(payload);
  
  if (!responseText) {
    console.warn(`[${requestId}] No response text from AI Agent`);
    return { status: 'warning', reason: 'No response text from AI Agent' };
  }

  try {
    // Delete the temporary "Searching..." message
    if (conversationRef.tempMessageTs) {
      await deleteMessage(conversationRef.channel, conversationRef.tempMessageTs, slackBotToken);
      delete conversationRef.tempMessageTs;
      storeConversationReference(sessionId, conversationRef);
    }

    // Send the final response as a new message
    await sendMessage(
      conversationRef.channel,
      responseText,
      slackBotToken,
      conversationRef.threadTs
    );

    return {
      status: 'success',
      message: 'AI response sent to Slack',
      session_id: sessionId,
    };
  } catch (error: any) {
    console.error(`[${requestId}] Failed to send response to Slack:`, error.message);

    // Try to send as a new message if delete/send failed
    try {
      await sendMessage(conversationRef.channel, responseText, slackBotToken, conversationRef.threadTs);
      return {
        status: 'success',
        message: 'AI response sent to Slack (fallback)',
        session_id: sessionId,
      };
    } catch (fallbackErr: any) {
      return {
        status: 'error',
        reason: 'Failed to send response to Slack',
        details: fallbackErr?.message ?? error.message,
      };
    }
  }
}

/**
 * Generate a progress message from an AI Agent progress object.
 * Uses Slack mrkdwn formatting.
 */
function getProgressMessage(progress: any): string {
  if (!progress) return '⏳ _Working..._';
  
  const state = progress.progress_state;
  const skillTriggered = progress.skill_triggered;
  const skillExecuted = progress.skill_executed;
  const skill = skillTriggered?.skill_name || skillExecuted?.skill_name;
  
  const thought = skillTriggered?.thought || skillExecuted?.thought || progress.thought;
  const skillInput = skillTriggered?.skill_input || skillExecuted?.skill_input;
  
  let message = '';
  
  switch (state) {
    case 'skill_triggered':
      message = `🔍 *Analyzing: ${formatSkillName(skill) || 'data'}*`;
      if (thought) {
        message += `\n> _${truncateText(thought, 200)}_`;
      }
      if (skillInput && typeof skillInput === 'object') {
        const inputPreview = formatSkillInput(skillInput);
        if (inputPreview) {
          message += `\n\`${inputPreview}\``;
        }
      }
      break;
      
    case 'skill_executed':
      message = `⚡ *Processing: ${formatSkillName(skill) || 'results'}*`;
      const resultSummary = skillExecuted?.result_summary || skillExecuted?.skill_output_summary;
      if (resultSummary) {
        message += `\n> _${truncateText(resultSummary, 150)}_`;
      }
      break;
      
    case 'thinking':
    case 'reasoning':
      message = `🤔 *Thinking...*`;
      if (thought) {
        message += `\n> _${truncateText(thought, 250)}_`;
      }
      break;
      
    case 'evaluating':
      message = `📝 *Preparing response...*`;
      break;
      
    default:
      message = `⏳ _Processing request..._`;
      if (thought) {
        message += `\n> _${truncateText(thought, 200)}_`;
      }
  }
  
  return message;
}

/**
 * Format skill name to be more readable.
 */
function formatSkillName(skillName: string | undefined): string {
  if (!skillName) return '';
  return skillName
    .replace(/[_-]/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Truncate text to a maximum length, adding ellipsis if truncated.
 */
function truncateText(text: string, maxLength: number): string {
  if (!text) return '';
  const cleaned = text.replace(/\n/g, ' ').trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.substring(0, maxLength - 3) + '...';
}

/**
 * Format skill input for display (show key parameters).
 */
function formatSkillInput(input: any): string {
  if (!input) return '';
  
  if (input.query) {
    return `Query: ${truncateText(input.query, 100)}`;
  }
  if (input.search_query) {
    return `Search: ${truncateText(input.search_query, 100)}`;
  }
  if (input.sql || input.sql_query) {
    return `SQL: ${truncateText(input.sql || input.sql_query, 100)}`;
  }
  if (input.question) {
    return `Question: ${truncateText(input.question, 100)}`;
  }
  
  const keys = Object.keys(input);
  if (keys.length > 0) {
    const firstKey = keys[0];
    const value = typeof input[firstKey] === 'string' 
      ? truncateText(input[firstKey], 80)
      : JSON.stringify(input[firstKey]).substring(0, 80);
    return `${firstKey}: ${value}`;
  }
  
  return '';
}

/**
 * Extract the response text from an AI Agent response payload.
 */
function extractResponseText(payload: any): string | null {
  if (!payload) return null;

  const fields = [
    'text', 'response', 'message', 'output',
    'result.text', 'result.response', 'result.message', 'result',
    'data.text', 'data.response', 'data.message', 'data',
    'execution_result.output', 'execution_result.response',
    'ai_agent_response.message', 'ai_agent_response.text'
  ];

  for (const field of fields) {
    const value = field.split('.').reduce((obj, key) => obj?.[key], payload);
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  if (typeof payload === 'object') {
    for (const key of Object.keys(payload)) {
      if (typeof payload[key] === 'string' && payload[key].length > 10) {
        return payload[key];
      }
    }
  }

  return null;
}

/**
 * Exported run function - entry point for the snap-in function.
 */
export const run = async (events: FunctionInput[]): Promise<any> => {
  const results = await Promise.all(
    events.map(async (event) => {
      try {
        return await handleAIResponse(event);
      } catch (error: any) {
        console.error(`[${event?.execution_metadata?.request_id ?? 'unknown'}] Error processing AI response:`, error);
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
