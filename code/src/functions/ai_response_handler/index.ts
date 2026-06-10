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
import { parseAgentResponseToBlocks } from '../../utils/format-text';
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
    !!sessionRecord && sessionRecord.messageCount > 0 && sessionRecord.lastDeliveredTurn >= sessionRecord.messageCount;

  if (turnAlreadyDelivered && agentResponseType !== 'error' && sessionRecord) {
    console.log(
      `[${requestId}] [AI_RESP] dropping duplicate event (type=${agentResponseType ?? 'final-message'}) for turn=${
        sessionRecord.messageCount
      } (already delivered)`
    );
    return { reason: 'Duplicate event for delivered turn', status: 'ignored' };
  }

  // Handle progress events — show ONLY the agent's reasoning ("thought").
  // Skill names, skill inputs, and result summaries are intentionally
  // suppressed; they leak internal tool names and add noise. Events that
  // carry no thought (e.g. skill_executed summaries with only a result)
  // don't touch the placeholder at all.
  if (agentResponseType === 'progress') {
    const progress = payload.ai_agent_response?.progress || payload.progress;
    console.log(
      `[${requestId}] [AI_RESP] progress state: ${progress?.progress_state}, keys: ${Object.keys(progress || {}).join(
        ', '
      )}`
    );
    if (progress) {
      const thought = extractThought(progress);
      if (!thought) {
        console.log(`[${requestId}] [AI_RESP] Progress event has no thought, skipping`);
        return { message: 'Progress event without thought ignored', status: 'ignored' };
      }
      const progressMessage = `🤔 ${thought}`;

      // Re-fetch the latest session row so a tempMessageTs that
      // slack_handler wrote *after* this handler's snapshot is
      // visible — without this, an early progress event posts a
      // duplicate "Searching…" before the original placeholder write
      // becomes readable.
      if (sessionRecord && !conversationRef.tempMessageTs) {
        try {
          const fresh = await getSessionById(storeConfig, sessionRecord.sessionId);
          if (fresh?.tempMessageTs) {
            conversationRef.tempMessageTs = fresh.tempMessageTs;
            sessionRecord = fresh;
            console.log(
              `[${requestId}] [AI_RESP] progress: picked up tempMessageTs=${fresh.tempMessageTs} from fresh session read`
            );
          }
        } catch (refetchErr: any) {
          console.warn(`[${requestId}] [AI_RESP] progress re-fetch failed: ${refetchErr?.message || refetchErr}`);
        }
      }

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

  // Handle final message — atomically replace the "Searching…" placeholder
  // with the agent reply (chat.update). Re-read the session immediately
  // before deciding so we don't race slack_handler's tempMessageTs write
  // — that race was producing one orphaned placeholder + a separate reply.
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

  // Re-read the latest session row to pick up tempMessageTs that was
  // written by slack_handler after the original conversationRef snapshot
  // was built.
  if (sessionRecord) {
    try {
      const fresh = await getSessionById(storeConfig, sessionRecord.sessionId);
      if (fresh) {
        sessionRecord = fresh;
        if (fresh.tempMessageTs && !conversationRef.tempMessageTs) {
          conversationRef.tempMessageTs = fresh.tempMessageTs;
          console.log(
            `[${requestId}] [AI_RESP] picked up tempMessageTs=${fresh.tempMessageTs} from fresh session read`
          );
        }
      }
    } catch (refetchErr: any) {
      console.warn(
        `[${requestId}] [AI_RESP] re-fetch of session before final send failed: ${refetchErr?.message || refetchErr}`
      );
    }
  }

  const threadTs = conversationRef.threadTs || conversationRef.messageTs;
  console.log(
    `[${requestId}] [AI_RESP] Sending final response, channel: ${conversationRef.channel}, threadTs: ${
      threadTs ?? 'none'
    }, tempMsgTs: ${conversationRef.tempMessageTs ?? 'none'}`
  );

  try {
    const { blocks, text: fallbackText } = parseAgentResponseToBlocks(responseText);
    const blocksForSlack = blocks.length > 0 ? blocks : undefined;
    console.log(
      `[${requestId}] [AI_RESP] Response from agent: "${responseText.substring(0, 200)}${
        responseText.length > 200 ? '...' : ''
      }"${blocksForSlack ? ` (${blocksForSlack.length} blocks)` : ''}`
    );

    if (conversationRef.tempMessageTs) {
      // chat.update replaces the placeholder atomically — no chance of an
      // orphaned "Searching…" message paired with a duplicate reply.
      try {
        await updateMessage(
          conversationRef.channel,
          conversationRef.tempMessageTs,
          fallbackText,
          slackBotToken,
          blocksForSlack
        );
        console.log(`[${requestId}] [AI_RESP] Final response replaced placeholder ts=${conversationRef.tempMessageTs}`);
      } catch (updateErr: any) {
        // Placeholder is gone or stale — fall through to sendMessage so the
        // user still sees the reply. Try a best-effort cleanup of the
        // orphan first.
        console.warn(
          `[${requestId}] [AI_RESP] chat.update failed (${updateErr?.message || updateErr}); sending fresh message`
        );
        await deleteMessage(conversationRef.channel, conversationRef.tempMessageTs, slackBotToken).catch(
          () => undefined
        );
        await sendMessage(conversationRef.channel, fallbackText, slackBotToken, threadTs, blocksForSlack);
      }
      sessionRecord = await safePatch(
        storeConfig,
        sessionRecord,
        { tempMessageTs: null },
        requestId,
        'final temp cleared'
      );
      conversationRef.tempMessageTs = undefined;
    } else {
      await sendMessage(conversationRef.channel, fallbackText, slackBotToken, threadTs, blocksForSlack);
    }

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

// Max characters kept per individual thought before truncation.
const THOUGHT_MAX_LENGTH = 250;

/**
 * Pull the AI Agent's reasoning ("thought") out of a progress object.
 * Returns null for events that carry no thought (e.g. skill_executed
 * result summaries) so the caller skips them entirely — the user only
 * sees genuine reasoning, not internal skill names or tool inputs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractThought(progress: any): string | null {
  if (!progress) return null;
  const thought = progress.skill_triggered?.thought || progress.skill_executed?.thought || progress.thought;
  if (!thought || typeof thought !== 'string') return null;
  const cleaned = thought.replace(/\n/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length <= THOUGHT_MAX_LENGTH ? cleaned : cleaned.substring(0, THOUGHT_MAX_LENGTH - 3) + '...';
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
