/**
 * AI Response Handler Function
 *
 * Handles async responses from DevRev AI Agents and sends them back to Slack.
 *
 * The AI Agent's session_object is the DevRev conversation DON that backs
 * the Slack session. We resolve the SessionRecord either by our UUID
 * (client_metadata.session_id) or by that conversation DON.
 */

import { FunctionInput } from '../../types';
import { ConversationReference } from '../../utils/conversation-store';
import { formatAgentResponseForSlack } from '../../utils/format-text';
import { readSessionTimingConfig } from '../../utils/session-config';
import {
  getSessionByConversationId,
  getSessionById,
  patchSession,
  recordToConversationReference,
  SessionRecord,
  StoreConfig,
} from '../../utils/session-store';
import { deleteMessage, sendMessage, updateMessage } from '../../utils/slack-client';
import { postTimelineComment } from '../../utils/timeline';

interface ResolvedSession {
  record: SessionRecord;
  ref: ConversationReference;
}

/**
 * Resolve the SessionRecord (and its corresponding ConversationReference) for
 * an inbound AI Agent response. Lookup priority:
 *   1. client_metadata.session_id (our UUID) → getSessionById
 *   2. payload.session_object — try as UUID, then as DevRev conversation DON
 */
async function resolveSessionFromResponse(
  storeConfig: StoreConfig,
  payload: any,
  requestId: string
): Promise<ResolvedSession | null> {
  const clientMetadata = payload.client_metadata || payload.ai_agent_response?.client_metadata || {};
  const candidates: { value: string; source: string }[] = [];
  if (clientMetadata.session_id) {
    candidates.push({ source: 'client_metadata.session_id', value: String(clientMetadata.session_id) });
  }
  const sessionObject = payload.session_object || payload.ai_agent_response?.session_object;
  if (sessionObject) {
    candidates.push({ source: 'payload.session_object', value: String(sessionObject) });
  }

  for (const { value, source } of candidates) {
    try {
      const byId = await getSessionById(storeConfig, value);
      if (byId) {
        console.log(`[${requestId}] [STORE] Session resolved by id via ${source}: ${byId.sessionId}`);
        return { record: byId, ref: recordToConversationReference(byId) };
      }
    } catch (err: any) {
      console.warn(`[${requestId}] [STORE] getSessionById(${source}) failed: ${err?.message || err}`);
    }

    if (typeof value === 'string' && value.includes(':conversation/')) {
      try {
        const byConv = await getSessionByConversationId(storeConfig, value);
        if (byConv) {
          console.log(`[${requestId}] [STORE] Session resolved by conversation DON via ${source}: ${byConv.sessionId}`);
          return { record: byConv, ref: recordToConversationReference(byConv) };
        }
      } catch (err: any) {
        console.warn(`[${requestId}] [STORE] getSessionByConversationId(${source}) failed: ${err?.message || err}`);
      }
    }
  }

  // Fallback: client_metadata.conversation_reference (legacy in-flight payloads).
  const fromMetadata = clientMetadata.conversation_reference;
  if (fromMetadata && typeof fromMetadata === 'object') {
    const meta = fromMetadata as any;
    const ref: ConversationReference = {
      ...(meta as ConversationReference),
      tempMessageTs: meta.tempMessageTs || meta.temp_message_ts || undefined,
      threadTs: meta.threadTs || meta.thread_ts || undefined,
      timestamp: meta.timestamp ?? Date.now(),
    };
    console.log(`[${requestId}] [STORE] Falling back to client_metadata.conversation_reference (no SessionRecord)`);
    return { record: null as unknown as SessionRecord, ref };
  }

  return null;
}

async function safePatch(
  storeConfig: StoreConfig,
  record: SessionRecord | null,
  patch: Parameters<typeof patchSession>[2],
  requestId: string,
  context: string
): Promise<SessionRecord | null> {
  if (!record) return null;
  try {
    return await patchSession(storeConfig, record, patch);
  } catch (err: any) {
    console.warn(`[${requestId}] [STORE] patchSession failed (${context}): ${err?.message || err}`);
    return record;
  }
}

/**
 * Mirror the AI Agent's final response onto the session's conversation
 * timeline. Authored by the snap-in service account so it appears as the
 * bot, not the user. Best-effort — failures are logged and swallowed.
 */
async function mirrorAgentResponseToTimeline(
  storeConfig: StoreConfig,
  record: SessionRecord | null,
  responseText: string,
  requestId: string
): Promise<void> {
  if (!record?.objectId || !responseText) return;
  await postTimelineComment({
    body: responseText,
    conversationId: record.objectId,
    devrevEndpoint: storeConfig.devrevEndpoint,
    externalRef: `slack-agent-${record.sessionId}-${record.messageCount}`,
    token: storeConfig.serviceAccountToken,
  }).catch((err: any) => {
    console.warn(`[${requestId}] [TIMELINE] mirror agent response failed: ${err?.message || err}`);
  });
}

/**
 * Main handler for AI Agent responses.
 */
async function handleAIResponse(event: FunctionInput): Promise<any> {
  const { payload, execution_metadata, input_data, context } = event;
  const requestId = execution_metadata.request_id;

  const storeConfig: StoreConfig = {
    devrevEndpoint: execution_metadata.devrev_endpoint.replace(/\/$/, ''),
    serviceAccountToken: context.secrets.service_account_token,
    timing: readSessionTimingConfig(input_data.global_values),
  };

  console.log(`[${requestId}] [AI_RESP] Raw payload keys: ${Object.keys(payload).join(', ')}`);

  const clientMetadata = payload.client_metadata || payload.ai_agent_response?.client_metadata || {};
  console.log(`[${requestId}] [AI_RESP] client_metadata keys: ${Object.keys(clientMetadata).join(', ')}`);

  const resolved = await resolveSessionFromResponse(storeConfig, payload, requestId);
  if (!resolved) {
    console.error(
      `[${requestId}] [STORE] FATAL: No session reference found. client_metadata: ${JSON.stringify(clientMetadata)}`
    );
    return { reason: 'Conversation reference not found', status: 'error' };
  }

  let sessionRecord: SessionRecord | null = resolved.record || null;
  const conversationRef: ConversationReference = resolved.ref;
  const sessionId = sessionRecord?.sessionId || clientMetadata.session_id || payload.session_object || 'unknown';

  console.log(
    `[${requestId}] [AI_RESP] Session resolved — sessionId: ${sessionId}, channel: ${conversationRef.channel}, user: ${
      conversationRef.userId
    }, tempMsgTs: ${conversationRef.tempMessageTs ?? 'none'}`
  );

  const slackBotToken = clientMetadata.slack_bot_token || input_data.keyrings['slack_bot_token'];

  if (!slackBotToken) {
    console.error(`[${requestId}] Slack Bot Token not configured`);
    return { reason: 'Slack Bot Token not configured', status: 'error' };
  }

  const agentResponseType = payload.ai_agent_response?.agent_response || payload.agent_response;
  console.log(`[${requestId}] [AI_RESP] agent_response type: ${agentResponseType ?? 'undefined'}`);
  console.log(
    `[${requestId}] [AI_RESP] full ai_agent_response keys: ${Object.keys(payload.ai_agent_response || {}).join(', ')}`
  );

  if (agentResponseType === 'suggestions' || payload.ai_agent_response?.suggestions) {
    console.log(`[${requestId}] [AI_RESP] Ignoring suggestions event`);
    return { reason: 'Suggestions event', status: 'ignored' };
  }

  // Per-turn dedup. The AI Agent occasionally emits a follow-up
  // `message` (and trailing `progress`) for the same user turn — Slack
  // would render each as a separate reply while DevRev's timeline
  // dedups via external_ref. Once we've delivered a final response for
  // the current turn (lastDeliveredTurn === messageCount), drop any
  // further `message`/`progress` and any final-message fall-through.
  // `error` events are still allowed through so users see failures.
  const turnAlreadyDelivered =
    !!sessionRecord &&
    sessionRecord.messageCount > 0 &&
    sessionRecord.lastDeliveredTurn >= sessionRecord.messageCount;

  if (turnAlreadyDelivered && agentResponseType !== 'error') {
    console.log(
      `[${requestId}] [AI_RESP] dropping duplicate event (type=${agentResponseType ?? 'final-message'}) for turn=${sessionRecord!.messageCount} (already delivered)`
    );
    return { reason: 'Duplicate event for delivered turn', status: 'ignored' };
  }

  // Handle progress events — update the temp message
  if (agentResponseType === 'progress') {
    const progress = payload.ai_agent_response?.progress || payload.progress;
    console.log(
      `[${requestId}] [AI_RESP] progress state: ${progress?.progress_state}, keys: ${Object.keys(progress || {}).join(
        ', '
      )}`
    );
    if (progress) {
      const progressMessage = getProgressMessage(progress);

      try {
        if (conversationRef.tempMessageTs) {
          try {
            await updateMessage(conversationRef.channel, conversationRef.tempMessageTs, progressMessage, slackBotToken);
          } catch (updateErr: any) {
            // Stale tempMessageTs (e.g. message_not_found) — send a new one
            console.warn(
              `[${requestId}] [AI_RESP] updateMessage failed (${updateErr.message}), sending new progress message`
            );
            const ts = await sendMessage(
              conversationRef.channel,
              progressMessage,
              slackBotToken,
              conversationRef.threadTs
            );
            conversationRef.tempMessageTs = ts;
            sessionRecord = await safePatch(
              storeConfig,
              sessionRecord,
              { tempMessageTs: ts },
              requestId,
              'progress retry'
            );
          }
        } else {
          const ts = await sendMessage(
            conversationRef.channel,
            progressMessage,
            slackBotToken,
            conversationRef.threadTs
          );
          conversationRef.tempMessageTs = ts;
          sessionRecord = await safePatch(
            storeConfig,
            sessionRecord,
            { tempMessageTs: ts },
            requestId,
            'progress send'
          );
        }
        return { message: 'Progress update sent to Slack', status: 'success' };
      } catch (error: any) {
        console.error(`[${requestId}] Failed to send progress update:`, error.message);
        return { reason: 'Failed to send progress', status: 'error' };
      }
    }
  }

  // Handle error events
  if (agentResponseType === 'error') {
    const errorMsg = payload.ai_agent_response?.error?.error || payload.error?.error || 'Unknown AI error';
    try {
      if (conversationRef.tempMessageTs) {
        await deleteMessage(conversationRef.channel, conversationRef.tempMessageTs, slackBotToken);
        conversationRef.tempMessageTs = undefined;
        sessionRecord = await safePatch(
          storeConfig,
          sessionRecord,
          { tempMessageTs: null },
          requestId,
          'error temp delete'
        );
      }

      await sendMessage(conversationRef.channel, `❌ Error: ${errorMsg}`, slackBotToken, conversationRef.threadTs);
      return { message: 'AI error sent to Slack', status: 'error' };
    } catch (error: any) {
      console.error(`[${requestId}] Failed to send error message:`, error.message);
      return { reason: 'Failed to send error message', status: 'error' };
    }
  }

  // Handle final message — delete temp message and send final response
  console.log(`[${requestId}] [AI_RESP] Extracting final response text from payload`);
  console.log(
    `[${requestId}] [AI_RESP] full payload: ${JSON.stringify(payload.ai_agent_response ?? null).substring(0, 500)}`
  );
  const responseText = extractResponseText(payload);

  if (!responseText) {
    console.warn(`[${requestId}] [AI_RESP] No response text found. Payload: ${JSON.stringify(payload)}`);
    return { reason: 'No response text from AI Agent', status: 'warning' };
  }
  console.log(`[${requestId}] [AI_RESP] Response text extracted, length: ${responseText.length}`);

  const threadTs = conversationRef.threadTs || conversationRef.messageTs;
  console.log(
    `[${requestId}] [AI_RESP] Sending final response, channel: ${conversationRef.channel}, threadTs: ${
      threadTs ?? 'none'
    }, tempMsgTs: ${conversationRef.tempMessageTs ?? 'none'}`
  );

  if (conversationRef.tempMessageTs) {
    try {
      await deleteMessage(conversationRef.channel, conversationRef.tempMessageTs, slackBotToken);
      conversationRef.tempMessageTs = undefined;
      sessionRecord = await safePatch(
        storeConfig,
        sessionRecord,
        { tempMessageTs: null },
        requestId,
        'final temp delete'
      );
    } catch (deleteErr: any) {
      console.warn(`[${requestId}] [AI_RESP] Failed to delete temp message (continuing):`, deleteErr.message);
    }
  }

  try {
    const formattedResponse = formatAgentResponseForSlack(responseText);
    console.log(
      `[${requestId}] [AI_RESP] Response from agent: "${responseText.substring(0, 200)}${
        responseText.length > 200 ? '...' : ''
      }"`
    );
    await sendMessage(conversationRef.channel, formattedResponse, slackBotToken, threadTs);
    console.log(
      `[${requestId}] [AI_RESP] Final response sent successfully to channel: ${conversationRef.channel}, thread: ${
        threadTs ?? 'none'
      }`
    );

    // Stamp the turn we just delivered so any follow-up `message` or
    // `progress` events for the same turn get dropped (see dedup at top).
    if (sessionRecord) {
      sessionRecord = await safePatch(
        storeConfig,
        sessionRecord,
        { lastDeliveredTurn: sessionRecord.messageCount },
        requestId,
        'mark turn delivered'
      );
    }

    // Mirror the agent reply onto the session's conversation timeline.
    await mirrorAgentResponseToTimeline(storeConfig, sessionRecord, responseText, requestId);

    return {
      message: 'AI response sent to Slack',
      session_id: sessionId,
      status: 'success',
    };
  } catch (error: any) {
    console.error(`[${requestId}] [AI_RESP] Failed to send response:`, error.message);
    return {
      details: error.message,
      reason: 'Failed to send response to Slack',
      status: 'error',
    };
  }
}

/**
 * Generate a progress message from an AI Agent progress object.
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

function formatSkillName(skillName: string | undefined): string {
  if (!skillName) return '';
  return skillName
    .replace(/[_-]/g, ' ')
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function truncateText(text: string, maxLength: number): string {
  if (!text) return '';
  const cleaned = text.replace(/\n/g, ' ').trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.substring(0, maxLength - 3) + '...';
}

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
    const value =
      typeof input[firstKey] === 'string'
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
    'text',
    'response',
    'message',
    'output',
    'result.text',
    'result.response',
    'result.message',
    'result',
    'data.text',
    'data.response',
    'data.message',
    'data',
    'execution_result.output',
    'execution_result.response',
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
 * Exported run function — entry point for the snap-in function.
 */
export const run = async (events: FunctionInput[]): Promise<any> => {
  const results = await Promise.all(
    events.map(async (event) => {
      try {
        return await handleAIResponse(event);
      } catch (error: any) {
        console.error(`[${event?.execution_metadata?.request_id ?? 'unknown'}] Error processing AI response:`, error);
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
