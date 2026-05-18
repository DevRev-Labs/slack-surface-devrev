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

  // Handle timeline_entry_created fallback — catches agent replies posted to the conversation
  if (payload.timeline_entry_created) {
    return await handleTimelineEntry(event);
  }

  console.log(`[${requestId}] [AI_RESP] Raw payload keys: ${Object.keys(payload).join(', ')}`);

  const clientMetadata = payload.client_metadata || payload.ai_agent_response?.client_metadata || {};
  const sessionId = clientMetadata.session_id || payload.session_object || payload.ai_agent_response?.session_object;

  console.log(`[${requestId}] [AI_RESP] session_id resolved: ${sessionId}`);
  console.log(`[${requestId}] [AI_RESP] client_metadata keys: ${Object.keys(clientMetadata).join(', ')}`);

  if (!sessionId) {
    console.error(`[${requestId}] [AI_RESP] No session ID in AI response. Full payload: ${JSON.stringify(payload)}`);
    return { status: 'error', reason: 'No session ID in response' };
  }

  let conversationRef: ConversationReference | undefined = getConversationReference(sessionId);
  console.log(`[${requestId}] [STORE] Conversation ref from in-memory store: ${conversationRef ? 'FOUND' : 'NOT FOUND'}`);

  if (!conversationRef) {
    const fromMetadata = clientMetadata.conversation_reference;
    console.log(`[${requestId}] [STORE] Trying to recover from client_metadata.conversation_reference: ${fromMetadata ? 'FOUND' : 'NOT FOUND'}`);
    if (fromMetadata && typeof fromMetadata === 'object') {
      const meta = fromMetadata as any;
      conversationRef = {
        ...(meta as ConversationReference),
        timestamp: meta.timestamp ?? Date.now(),
        tempMessageTs: meta.tempMessageTs || meta.temp_message_ts || undefined,
        threadTs: meta.threadTs || meta.thread_ts || undefined,
      };
      storeConversationReference(sessionId, conversationRef);
      console.log(`[${requestId}] [STORE] Recovered conversation ref from metadata, channel: ${conversationRef.channel}, tempMsgTs: ${conversationRef.tempMessageTs ?? 'none'}, threadTs: ${conversationRef.threadTs ?? 'none'}`);
    }
  }

  if (!conversationRef) {
    console.error(`[${requestId}] [STORE] FATAL: No conversation reference found for session: ${sessionId}. client_metadata: ${JSON.stringify(clientMetadata)}`);
    return { status: 'error', reason: 'Conversation reference not found' };
  }

  console.log(`[${requestId}] [AI_RESP] Conversation ref resolved — channel: ${conversationRef.channel}, user: ${conversationRef.userId}, tempMsgTs: ${conversationRef.tempMessageTs ?? 'none'}`);

  // Get Slack bot token from client_metadata or keyrings
  const slackBotToken = clientMetadata.slack_bot_token || input_data.keyrings['slack_bot_token'];

  if (!slackBotToken) {
    console.error(`[${requestId}] Slack Bot Token not configured`);
    return { status: 'error', reason: 'Slack Bot Token not configured' };
  }

  const agentResponseType = payload.ai_agent_response?.agent_response || payload.agent_response;
  console.log(`[${requestId}] [AI_RESP] agent_response type: ${agentResponseType ?? 'undefined'}`);
  console.log(`[${requestId}] [AI_RESP] full ai_agent_response keys: ${Object.keys(payload.ai_agent_response || {}).join(', ')}`);

  if (agentResponseType === 'suggestions' || payload.ai_agent_response?.suggestions) {
    console.log(`[${requestId}] [AI_RESP] Ignoring suggestions event`);
    return { status: 'ignored', reason: 'Suggestions event' };
  }

  // Handle progress events - update the temp message
  if (agentResponseType === 'progress') {
    const progress = payload.ai_agent_response?.progress || payload.progress;
    console.log(`[${requestId}] [AI_RESP] progress state: ${progress?.progress_state}, keys: ${Object.keys(progress || {}).join(', ')}`);
    if (progress) {
      const progressMessage = getProgressMessage(progress);
      
      try {
        if (conversationRef.tempMessageTs) {
          try {
            await updateMessage(
              conversationRef.channel,
              conversationRef.tempMessageTs,
              progressMessage,
              slackBotToken
            );
          } catch (updateErr: any) {
            // Stale tempMessageTs (e.g. message_not_found) — send a new one
            console.warn(`[${requestId}] [AI_RESP] updateMessage failed (${updateErr.message}), sending new progress message`);
            delete conversationRef.tempMessageTs;
            const ts = await sendMessage(
              conversationRef.channel,
              progressMessage,
              slackBotToken,
              conversationRef.threadTs
            );
            conversationRef.tempMessageTs = ts;
            storeConversationReference(sessionId, conversationRef);
          }
        } else {
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
  console.log(`[${requestId}] [AI_RESP] Extracting final response text from payload`);
  console.log(`[${requestId}] [AI_RESP] full payload: ${JSON.stringify(payload.ai_agent_response).substring(0, 500)}`);
  const responseText = extractResponseText(payload);

  if (!responseText) {
    console.warn(`[${requestId}] [AI_RESP] No response text found. Payload: ${JSON.stringify(payload)}`);
    return { status: 'warning', reason: 'No response text from AI Agent' };
  }
  console.log(`[${requestId}] [AI_RESP] Response text extracted, length: ${responseText.length}`);

  const threadTs = conversationRef.threadTs || conversationRef.messageTs;
  console.log(`[${requestId}] [AI_RESP] Sending final response, channel: ${conversationRef.channel}, threadTs: ${threadTs ?? 'none'}, tempMsgTs: ${conversationRef.tempMessageTs ?? 'none'}`);

  // Delete the temporary "Searching..." message
  if (conversationRef.tempMessageTs) {
    try {
      await deleteMessage(conversationRef.channel, conversationRef.tempMessageTs, slackBotToken);
      delete conversationRef.tempMessageTs;
      storeConversationReference(sessionId, conversationRef);
    } catch (deleteErr: any) {
      console.warn(`[${requestId}] [AI_RESP] Failed to delete temp message (continuing):`, deleteErr.message);
    }
  }

  // Send the final response
  try {
    const formattedResponse = formatForSlack(responseText);
    console.log(`[${requestId}] [AI_RESP] Response from agent: "${responseText.substring(0, 200)}${responseText.length > 200 ? '...' : ''}"`);
    await sendMessage(conversationRef.channel, formattedResponse, slackBotToken, threadTs);
    console.log(`[${requestId}] [AI_RESP] Final response sent successfully to channel: ${conversationRef.channel}, thread: ${threadTs ?? 'none'}`);
    return {
      status: 'success',
      message: 'AI response sent to Slack',
      session_id: sessionId,
    };
  } catch (error: any) {
    console.error(`[${requestId}] [AI_RESP] Failed to send response:`, error.message);
    return {
      status: 'error',
      reason: 'Failed to send response to Slack',
      details: error.message,
    };
  }
}

/**
 * Handle timeline_entry_created events — forward agent-authored timeline comments to Slack.
 * This is the fallback path for when ai_agent_response events don't arrive.
 */
async function handleTimelineEntry(event: FunctionInput): Promise<any> {
  const { payload, execution_metadata, input_data } = event;
  const requestId = execution_metadata.request_id;

  const entry = payload.timeline_entry_created?.entry;
  if (!entry) {
    return { status: 'ignored', reason: 'No timeline entry in payload' };
  }

  // Only forward external-visibility comments
  if (entry.visibility !== 'external' && entry.visibility !== 'public') {
    console.log(`[${requestId}] [TIMELINE] Skipping non-external entry, visibility: ${entry.visibility}`);
    return { status: 'ignored', reason: 'Non-external timeline entry' };
  }

  // Skip entries not on a conversation
  const objectId: string | undefined = entry.object?.id ?? entry.object;
  if (!objectId || !objectId.includes(':conversation/')) {
    return { status: 'ignored', reason: 'Not a conversation timeline entry' };
  }

  // Look up conversation reference by conversation DON
  const conversationRef: ConversationReference | undefined = getConversationReference(objectId);
  if (!conversationRef) {
    console.log(`[${requestId}] [TIMELINE] No conversation ref for ${objectId}, ignoring`);
    return { status: 'ignored', reason: 'No conversation reference found for conversation' };
  }

  const body: string = entry.text || entry.body || '';
  if (!body.trim()) {
    return { status: 'ignored', reason: 'Empty timeline entry body' };
  }

  // Skip entries authored by the snap-in service account (avoid echo loop)
  const serviceAccountId: string | undefined = event.context?.service_account_id;
  const authorId: string | undefined = entry.created_by?.id;
  if (serviceAccountId && authorId && authorId === serviceAccountId) {
    console.log(`[${requestId}] [TIMELINE] Skipping self-authored timeline entry`);
    return { status: 'ignored', reason: 'Self-authored entry' };
  }

  const slackBotToken = input_data.keyrings['slack_bot_token'];
  if (!slackBotToken) {
    return { status: 'error', reason: 'Slack Bot Token not configured' };
  }

  const threadTs = conversationRef.threadTs || conversationRef.messageTs;

  // Delete temp "Searching..." message if present
  if (conversationRef.tempMessageTs) {
    try {
      await deleteMessage(conversationRef.channel, conversationRef.tempMessageTs, slackBotToken);
      delete conversationRef.tempMessageTs;
      storeConversationReference(objectId, conversationRef);
    } catch (e: any) {
      console.warn(`[${requestId}] [TIMELINE] Failed to delete temp message:`, e.message);
    }
  }

  try {
    await sendMessage(conversationRef.channel, toSlackMarkdown(body), slackBotToken, threadTs);
    console.log(`[${requestId}] [TIMELINE] Forwarded timeline entry to Slack`);
    return { status: 'success', message: 'Timeline entry forwarded to Slack' };
  } catch (error: any) {
    console.error(`[${requestId}] [TIMELINE] Failed to send to Slack:`, error.message);
    return { status: 'error', reason: 'Failed to send timeline entry to Slack' };
  }
}

/**
 * Convert standard markdown to Slack mrkdwn format.
 */
function toSlackMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<$2|$1>');
}

/**
 * Format an AI agent response for clean Slack display.
 * - Strips raw DevRev DON identifiers
 * - Converts markdown tables to plain text
 * - Converts markdown to Slack mrkdwn
 */
function formatForSlack(text: string): string {
  let formatted = text;

  // Remove DONs wrapped in [<don:...>] (with angle brackets)
  formatted = formatted.replace(/\s*\[<don:[^\]]+>\]/g, '');

  // Remove DONs wrapped in [don:...] (without angle brackets)
  formatted = formatted.replace(/\s*\[don:[^\]]+\]/g, '');

  // Remove bare inline DONs
  formatted = formatted.replace(/\bdon:[a-z0-9:/_-]+/g, '');

  // Convert markdown tables to readable plain text
  formatted = convertTableToText(formatted);

  // Clean up leftover empty parens and extra spaces
  formatted = formatted.replace(/\(\s*\)/g, '');
  formatted = formatted.replace(/  +/g, ' ');
  formatted = formatted.trim();

  return toSlackMarkdown(formatted);
}

/**
 * Convert a markdown table into a numbered list for Slack.
 * Input:  | # | Name | Email |
 *         |---|------|-------|
 *         | 1 | Alice | alice@x.com |
 * Output: 1. *Alice* — alice@x.com
 */
function convertTableToText(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let headers: string[] = [];
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (inTable) inTable = false;
      result.push(line);
      continue;
    }

    const cells = trimmed.split('|').map(c => c.trim()).filter(c => c.length > 0);

    // Separator row (---|---|---)
    if (cells.every(c => /^[-:]+$/.test(c))) {
      inTable = true;
      continue;
    }

    if (!inTable) {
      // This is the header row
      headers = cells;
      inTable = true;
      continue;
    }

    // Data row — format as "Field: Value, Field: Value"
    if (headers.length > 0) {
      const parts = cells.map((cell, i) => {
        const header = headers[i] || '';
        // Skip index/number columns (#, No, Index)
        if (/^#$|^no\.?$|^index$/i.test(header)) return null;
        if (!cell || cell === '-') return null;
        return header ? `${header}: ${cell}` : cell;
      }).filter(Boolean);
      result.push(`• ${parts.join(' | ')}`);
    } else {
      result.push(`• ${cells.join(' | ')}`);
    }
  }

  return result.join('\n');
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
    'ai_agent_response.message',
    'ai_agent_response.response.output_message.message',
    'ai_agent_response.text',
    'text', 'response', 'message', 'output',
    'result.text', 'result.response', 'result.message', 'result',
    'data.text', 'data.response', 'data.message', 'data',
    'execution_result.output', 'execution_result.response',
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
