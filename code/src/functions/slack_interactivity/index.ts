/**
 * Slack Interactivity + Slash Command Handler.
 *
 * One function, three event shapes — all delivered to the same Slack
 * "interactivity" webhook with `application/x-www-form-urlencoded` bodies:
 *
 *   1. Slash command (`/sda-feedback`)
 *      Form fields: command, user_id, channel_id, trigger_id, …
 *      → open the feedback modal directly with the slash command's
 *        trigger_id; resolves the active session via channel + user.
 *
 *   2. Block-Kit interaction (`payload=<JSON>` with type=block_actions)
 *      → reserved for future buttons (e.g. inline ratings).
 *
 *   3. Modal submission (`payload=<JSON>` with type=view_submission)
 *      → persist rating + comment onto the session's conversation
 *        custom fields and confirm in-thread.
 *
 * The Rego policy on `slack-interactivity-source` normalizes both shapes
 * (a slash-command form and the JSON-in-`payload` envelope) and forwards
 * a uniform `{ body, headers, body_raw }` structure. Signature checking
 * happens against `body_raw` exactly the same way as the events handler.
 */

import { FunctionInput } from '../../types';
import {
  ACTION_DISMISS_FEEDBACK_PROMPT,
  ACTION_OPEN_FEEDBACK,
  buildErrorModal,
  buildFeedbackConfirmationBlocks,
  buildFeedbackDismissedBlocks,
  buildFeedbackModal,
  buildLoadingModal,
  decodeContext,
  FEEDBACK_ACTION_RATING,
  FEEDBACK_ACTION_TEXT,
  FEEDBACK_BLOCK_RATING,
  FEEDBACK_BLOCK_TEXT,
  FEEDBACK_SLASH_COMMAND,
  FEEDBACK_VIEW_CALLBACK,
  FeedbackContext,
  feedbackConfirmationFallbackText,
} from '../../utils/feedback';
import { readSessionTimingConfig } from '../../utils/session-config';
import {
  getLatestActiveSessionForUserInChannel,
  getSessionById,
  patchSession,
  SessionRecord,
  StoreConfig,
} from '../../utils/session-store';
import {
  openView,
  sendBlocksMessage,
  updateMessageBlocks,
  updateView,
} from '../../utils/slack-client';
import { validateSlackSignature } from '../../utils/slack-signature-validator';

const FORBIDDEN_RESPONSE = { status: 'forbidden', status_code: 403 };

/**
 * Slash-command form payload (Rego forwards this verbatim under `body`
 * when the request body has a top-level `command` field).
 */
interface SlackSlashCommandPayload {
  command: string;
  text?: string;
  trigger_id: string;
  user_id: string;
  channel_id: string;
  team_id?: string;
  response_url?: string;
}

/**
 * Block-Kit / view interactivity payload (Rego forwards the JSON parsed
 * out of the `payload=…` form field).
 */
interface SlackInteractivityPayload {
  type: string;
  trigger_id?: string;
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string };
  container?: { channel_id?: string; message_ts?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, any>> };
  };
}

export const run = async (events: FunctionInput[]): Promise<any> => {
  const results = await Promise.all(
    events.map(async (event) => {
      try {
        return await handle(event);
      } catch (error: any) {
        console.error(
          `[${event?.execution_metadata?.request_id ?? 'unknown'}] [interactivity] error:`,
          error?.message || error
        );
        return { reason: error?.message || 'Unknown error', status: 'error' };
      }
    })
  );
  return results.length === 1 ? results[0] : results;
};

export default run;

async function handle(event: FunctionInput): Promise<any> {
  const requestId = event.execution_metadata.request_id;
  const payload = event.payload;

  // Visibility — log every invocation so we can confirm Slack reaches us.
  console.log(
    `[${requestId}] [interactivity] received payload keys: ${
      payload && typeof payload === 'object' ? Object.keys(payload).join(',') : typeof payload
    }`
  );

  const wrapped =
    payload && typeof payload === 'object' && 'body' in payload && 'headers' in payload ? payload : null;
  let body: any = wrapped ? wrapped.body : payload;
  const headers: Record<string, any> | undefined = wrapped ? wrapped.headers : undefined;
  const bodyRaw: string | undefined =
    wrapped && typeof (wrapped as any).body_raw === 'string' ? (wrapped as any).body_raw : undefined;

  // Diagnostic: show what the inner body looks like before normalization.
  // Slack form-encoded bodies sometimes arrive as parsed objects with the
  // form fields as keys (e.g. {command, trigger_id, user_id, …}); other
  // times as a string; other times empty with bytes only in body_raw.
  console.log(
    `[${requestId}] [interactivity] body type=${typeof body} keys=${
      body && typeof body === 'object' ? Object.keys(body).slice(0, 20).join(',') : '∅'
    } body_raw_len=${bodyRaw ? bodyRaw.length : 0}`
  );
  if (bodyRaw) {
    try {
      const decodedPreview = Buffer.from(bodyRaw, 'base64').toString('utf8').slice(0, 200);
      console.log(`[${requestId}] [interactivity] body_raw preview: ${decodedPreview}`);
    } catch {}
  }

  // Slack delivers slash commands and Block-Kit interactivity as
  // `application/x-www-form-urlencoded`. The DevRev gateway forwards
  // those bodies in unpredictable shapes — parsed object, raw string,
  // or even an empty object with the bytes in body_raw. Normalize.
  const bodyHasUsefulKey = (b: any): boolean =>
    !!b &&
    typeof b === 'object' &&
    (typeof b.type === 'string' || typeof b.command === 'string' || typeof b.payload === 'string');

  if (typeof body === 'string') {
    console.log(`[${requestId}] [interactivity] body is string (len=${body.length}) — parsing as form`);
    body = parseFormUrlEncoded(body);
  }

  // If body still doesn't have a discriminator field but body_raw is
  // present, decode body_raw (base64) and parse as form. Slack form
  // bodies always contain at least one '=' character.
  if (!bodyHasUsefulKey(body) && bodyRaw) {
    try {
      const decoded = Buffer.from(bodyRaw, 'base64').toString('utf8');
      console.log(
        `[${requestId}] [interactivity] body has no command/type/payload — parsing body_raw (decoded_len=${decoded.length})`
      );
      const parsed = parseFormUrlEncoded(decoded);
      if (Object.keys(parsed).length > 0) {
        body = parsed;
      }
    } catch (err: any) {
      console.warn(`[${requestId}] [interactivity] body_raw decode failed: ${err?.message || err}`);
    }
  }

  // If the parsed form has a `payload` field (Block-Kit interactivity),
  // the value is URL-encoded JSON — promote it to the body.
  if (body && typeof body === 'object' && typeof body.payload === 'string') {
    try {
      body = JSON.parse(body.payload);
    } catch (err: any) {
      console.warn(`[${requestId}] [interactivity] payload JSON parse failed: ${err?.message || err}`);
    }
  }

  const signingSecret = event.input_data.keyrings?.['slack_signing_secret'];
  const sigCheck = validateSlackSignature(signingSecret, headers, body, bodyRaw);
  if (!sigCheck.valid) {
    console.warn(`[${requestId}] [interactivity] signature rejected: ${sigCheck.reason}`);
    return FORBIDDEN_RESPONSE;
  }

  if (!body || typeof body !== 'object') {
    console.warn(`[${requestId}] [interactivity] empty/invalid body after normalization`);
    return { reason: 'Empty interactivity payload', status: 'ignored' };
  }

  const slackBotToken = event.input_data.keyrings['slack_bot_token'];
  if (!slackBotToken) {
    console.error(`[${requestId}] [interactivity] slack_bot_token missing`);
    return { reason: 'Slack Bot Token not configured', status: 'error' };
  }

  const storeConfig: StoreConfig = {
    devrevEndpoint: event.execution_metadata.devrev_endpoint.replace(/\/$/, ''),
    serviceAccountToken: event.context.secrets.service_account_token,
    timing: readSessionTimingConfig(event.input_data.global_values),
  };

  // Slash command bodies have a `command` field; interactivity payloads
  // have a `type` field. Use the discriminator to dispatch.
  if (typeof (body as any).command === 'string') {
    console.log(`[${requestId}] [interactivity] dispatch: slash command=${(body as any).command}`);
    return handleSlashCommand(body as SlackSlashCommandPayload, slackBotToken, storeConfig, requestId);
  }

  const interactivity = body as SlackInteractivityPayload;
  const type = interactivity.type;
  console.log(`[${requestId}] [interactivity] type=${type}`);

  if (type === 'view_submission') {
    return handleViewSubmission(interactivity, slackBotToken, storeConfig, requestId);
  }
  if (type === 'block_actions') {
    return handleBlockActions(interactivity, slackBotToken, requestId);
  }
  if (type === 'view_closed') {
    return { reason: `No-op for type ${type}`, status: 'ignored' };
  }
  return { reason: `Unsupported interactivity type: ${type}`, status: 'ignored' };
}

/**
 * Handle Block-Kit button clicks.
 *
 * Today the only buttons we render are the typed-text feedback prompt's
 * "Give Feedback" / "Not now" pair. Click → use the click's trigger_id
 * to open the modal directly (the prompt was posted with the resolved
 * sessionId baked into the button's `value`, so no DevRev round-trip
 * is needed during the 3s trigger_id window).
 */
async function handleBlockActions(
  payload: SlackInteractivityPayload,
  slackBotToken: string,
  requestId: string
): Promise<any> {
  const action = payload.actions?.[0];
  if (!action?.action_id) {
    return { reason: 'No action in block_actions payload', status: 'ignored' };
  }

  const channel = payload.container?.channel_id || payload.channel?.id;
  const messageTs = payload.container?.message_ts || payload.message?.ts;

  if (action.action_id === ACTION_OPEN_FEEDBACK) {
    const ctx = decodeContext(action.value);
    if (!ctx) {
      console.warn(`[${requestId}] [block_actions] invalid context on feedback button`);
      return { reason: 'Invalid feedback prompt value', status: 'error' };
    }
    if (!payload.trigger_id) {
      console.warn(`[${requestId}] [block_actions] missing trigger_id`);
      return { reason: 'Missing trigger_id', status: 'error' };
    }
    try {
      // Open the real form directly — sessionId is already in ctx.
      await openView(payload.trigger_id, buildFeedbackModal(ctx), slackBotToken);
      console.log(
        `[${requestId}] [block_actions] feedback modal opened session=${ctx.sessionId}`
      );
      return { mode: 'feedback_modal_opened', session_id: ctx.sessionId, status: 'success' };
    } catch (error: any) {
      console.error(`[${requestId}] [block_actions] views.open failed: ${error?.message || error}`);
      return { details: error?.message, reason: 'views.open failed', status: 'error' };
    }
  }

  if (action.action_id === ACTION_DISMISS_FEEDBACK_PROMPT) {
    if (channel && messageTs) {
      try {
        await updateMessageBlocks(
          channel,
          messageTs,
          'Feedback skipped.',
          buildFeedbackDismissedBlocks(),
          slackBotToken
        );
      } catch (error: any) {
        console.warn(`[${requestId}] [block_actions] dismiss update failed: ${error?.message || error}`);
      }
    }
    return { mode: 'feedback_prompt_dismissed', status: 'success' };
  }

  return { reason: `Unhandled action_id: ${action.action_id}`, status: 'ignored' };
}

/**
 * Handle `/sda-feedback`.
 *
 * Two-stage pattern (mirrors the marketplace Slack snap-in's create-ticket
 * flow):
 *
 *   1. Synchronously call views.open with a Loading modal — this consumes
 *      the trigger_id within Slack's ~3s window and gives the user
 *      immediate visual feedback.
 *
 *   2. Resolve the active session via DevRev (a list-and-filter call that
 *      can take 500ms-3s). Then call views.update to swap the loading
 *      modal for either the real form (with sessionId baked into
 *      private_metadata) or an error modal saying "no active session".
 *
 * Without stage 1, a slow stage 2 would let trigger_id expire and Slack
 * would show "/sda-feedback failed" with no modal at all.
 */
async function handleSlashCommand(
  cmd: SlackSlashCommandPayload,
  slackBotToken: string,
  storeConfig: StoreConfig,
  requestId: string
): Promise<any> {
  const command = (cmd.command || '').trim().toLowerCase();
  if (command !== FEEDBACK_SLASH_COMMAND) {
    console.log(`[${requestId}] [slash] ignored unknown command: ${command}`);
    return { reason: `Unknown slash command: ${command}`, status: 'ignored' };
  }

  if (!cmd.trigger_id) {
    console.warn(`[${requestId}] [slash] /sda-feedback missing trigger_id`);
    return { reason: 'Missing trigger_id', status: 'error' };
  }

  // Stage 1 — open Loading modal immediately. This MUST complete inside
  // Slack's 3s trigger_id window. No DevRev calls, no other awaits.
  let viewId: string;
  try {
    viewId = await openView(cmd.trigger_id, buildLoadingModal(), slackBotToken);
    console.log(
      `[${requestId}] [slash] /sda-feedback loading modal opened view_id=${viewId} channel=${cmd.channel_id} user=${cmd.user_id}`
    );
  } catch (error: any) {
    console.error(`[${requestId}] [slash] views.open (loading) failed: ${error?.message || error}`);
    return { details: error?.message, reason: 'views.open failed', status: 'error' };
  }

  if (!viewId) {
    console.warn(`[${requestId}] [slash] views.open returned no view id`);
    return { reason: 'No view id', status: 'error' };
  }

  // Stage 2 — resolve the active session and update the modal.
  let session: SessionRecord | null = null;
  try {
    session = await getLatestActiveSessionForUserInChannel(
      storeConfig,
      cmd.channel_id,
      cmd.user_id
    );
  } catch (error: any) {
    console.warn(`[${requestId}] [slash] active-session lookup failed: ${error?.message || error}`);
  }

  if (!session) {
    console.log(
      `[${requestId}] [slash] no active session for user=${cmd.user_id} channel=${cmd.channel_id} — showing error modal`
    );
    try {
      await updateView(
        viewId,
        buildErrorModal(
          "You don't have an active conversation here yet. Mention the bot or send a DM, then try `/sda-feedback` once you've chatted."
        ),
        slackBotToken
      );
    } catch (error: any) {
      console.warn(`[${requestId}] [slash] views.update (error) failed: ${error?.message || error}`);
    }
    return { mode: 'feedback_no_session', status: 'success' };
  }

  // Real form — sessionId baked into private_metadata so submit is direct.
  const ctx: FeedbackContext = {
    sessionId: session.sessionId,
    channel: session.channel,
    threadTs: session.threadTs || undefined,
    userId: cmd.user_id,
  };
  try {
    await updateView(viewId, buildFeedbackModal(ctx), slackBotToken);
    console.log(
      `[${requestId}] [slash] /sda-feedback form rendered for session=${session.sessionId}`
    );
    return { mode: 'feedback_modal_opened', session_id: session.sessionId, status: 'success' };
  } catch (error: any) {
    console.error(`[${requestId}] [slash] views.update failed: ${error?.message || error}`);
    return { details: error?.message, reason: 'views.update failed', status: 'error' };
  }
}

async function handleViewSubmission(
  payload: SlackInteractivityPayload,
  slackBotToken: string,
  storeConfig: StoreConfig,
  requestId: string
): Promise<any> {
  if (payload.view?.callback_id !== FEEDBACK_VIEW_CALLBACK) {
    return { reason: `Unhandled view callback_id: ${payload.view?.callback_id}`, status: 'ignored' };
  }

  const ctx = decodeContext(payload.view.private_metadata);
  if (!ctx) {
    console.warn(`[${requestId}] [feedback] submit: invalid private_metadata`);
    return responseActionErrors({
      [FEEDBACK_BLOCK_RATING]: 'We could not identify your session. Please try again.',
    });
  }

  const values = payload.view.state?.values || {};
  const rating = parseRating(values[FEEDBACK_BLOCK_RATING]?.[FEEDBACK_ACTION_RATING]);
  if (!rating) {
    return responseActionErrors({ [FEEDBACK_BLOCK_RATING]: 'Please pick a rating.' });
  }
  const comment =
    typeof values[FEEDBACK_BLOCK_TEXT]?.[FEEDBACK_ACTION_TEXT]?.value === 'string'
      ? values[FEEDBACK_BLOCK_TEXT][FEEDBACK_ACTION_TEXT].value
      : '';

  // Resolve the active session. Two paths:
  //  - sessionId in private_metadata (legacy / future flows that pre-resolved)
  //  - userId+channel in private_metadata (slash-command flow): look up
  //    the latest active session for this (channel, user) at submit time.
  let sessionRecord: SessionRecord | null = null;
  try {
    if (ctx.sessionId) {
      sessionRecord = await getSessionById(storeConfig, ctx.sessionId);
    } else if (ctx.userId && ctx.channel) {
      sessionRecord = await getLatestActiveSessionForUserInChannel(
        storeConfig,
        ctx.channel,
        ctx.userId
      );
    }
  } catch (error: any) {
    console.warn(`[${requestId}] [feedback] session lookup failed: ${error?.message || error}`);
  }

  if (!sessionRecord) {
    console.warn(
      `[${requestId}] [feedback] no active session for sessionId=${ctx.sessionId || '∅'} channel=${
        ctx.channel || '∅'
      } user=${ctx.userId || '∅'}`
    );
    return responseActionErrors({
      [FEEDBACK_BLOCK_RATING]:
        "We couldn't find an active conversation here. Mention the bot or send a DM, then try again.",
    });
  }

  const submittedAt = Date.now();
  try {
    await patchSession(storeConfig, sessionRecord, {
      feedbackRating: rating,
      feedbackText: comment,
      feedbackSubmittedAt: submittedAt,
    });
    console.log(
      `[${requestId}] [feedback] persisted session=${ctx.sessionId} rating=${rating} comment_chars=${comment.length}`
    );
  } catch (error: any) {
    console.error(`[${requestId}] [feedback] patchSession failed: ${error?.message || error}`);
    return responseActionErrors({
      [FEEDBACK_BLOCK_RATING]: 'Could not save your feedback. Please try again.',
    });
  }

  // Confirm in the same thread the session lives in. Best-effort.
  // Prefer the session's recorded thread, falling back to whatever
  // came in via private_metadata (modal opened in a thread).
  const confirmChannel = sessionRecord.channel || ctx.channel;
  const confirmThread = sessionRecord.threadTs || ctx.threadTs;
  if (confirmChannel) {
    try {
      await sendBlocksMessage(
        confirmChannel,
        feedbackConfirmationFallbackText(rating),
        buildFeedbackConfirmationBlocks(rating, comment),
        slackBotToken,
        confirmThread
      );
    } catch (err: any) {
      console.warn(`[${requestId}] [feedback] confirmation send failed: ${err?.message || err}`);
    }
  }

  // Slack expects an empty body to dismiss the modal cleanly.
  return {};
}

function parseRating(input: any): number | null {
  const raw = input?.selected_option?.value ?? input?.value ?? input;
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 5) return null;
  return Math.round(n);
}

/**
 * Slack-spec response for surfacing inline modal validation errors:
 * `{ response_action: "errors", errors: { block_id: "message" } }`.
 * Keeps the modal open so the user can correct.
 */
function responseActionErrors(errors: Record<string, string>): any {
  return { response_action: 'errors', errors };
}

/**
 * Parse application/x-www-form-urlencoded into a plain object.
 * Slack's slash-command and interactivity bodies arrive in this shape.
 */
function parseFormUrlEncoded(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const segment of input.split('&')) {
    if (!segment) continue;
    const eq = segment.indexOf('=');
    const k = eq >= 0 ? segment.slice(0, eq) : segment;
    const v = eq >= 0 ? segment.slice(eq + 1) : '';
    try {
      out[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      out[k] = v;
    }
  }
  return out;
}
