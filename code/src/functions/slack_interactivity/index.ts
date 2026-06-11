/**
 * Slack Interactivity + Slash Command Handler.
 *
 * Two event shapes, both delivered to the same Slack interactivity
 * webhook with `application/x-www-form-urlencoded` bodies:
 *
 *   1. Slash command (`/sda-agent-feedback`) — form fields: command,
 *      user_id, channel_id, trigger_id. Opens a Loading modal,
 *      resolves the active session, swaps in the real form.
 *
 *   2. Modal submission (`payload=<JSON>` with type=view_submission)
 *      — persists rating + comment onto the session's conversation
 *      custom fields, swaps the modal to a thank-you view, and
 *      sends a private (ephemeral) breadcrumb in-thread.
 *
 * Signature verification happens against `body_raw` (HMAC-SHA256 over
 * the exact bytes Slack signed) — same as the events handler.
 */

/* eslint-disable simple-import-sort/imports */
import { FunctionInput } from '../../types';
import {
  ACTION_OPEN_FEEDBACK_FROM_PROMPT,
  buildErrorModal,
  buildFeedbackConfirmationBlocks,
  buildFeedbackModal,
  buildFeedbackThanksModal,
  buildLoadingModal,
  decodeContext,
  feedbackConfirmationFallbackText,
  FeedbackContext,
  FEEDBACK_ACTION_RATING,
  FEEDBACK_ACTION_TEXT,
  FEEDBACK_BLOCK_RATING,
  FEEDBACK_BLOCK_TEXT,
  FEEDBACK_SLASH_COMMAND,
  FEEDBACK_VIEW_CALLBACK,
} from '../../utils/feedback';
import { logger } from '../../utils/logger';
import { readSessionTimingConfig } from '../../utils/session-config';
import {
  getLatestActiveSessionForUserInChannel,
  getSessionById,
  patchSession,
  SessionRecord,
  StoreConfig,
} from '../../utils/session-store';
import { deleteMessage, openView, postEphemeral, updateView } from '../../utils/slack-client';
import { validateSlackSignature } from '../../utils/slack-signature-validator';
import { errMsg } from '../../utils/errors';
import {
  bodyHasUsefulKey,
  decodeBase64BodyRaw,
  parseFormUrlEncoded,
  tryPromotePayloadField,
} from '../../utils/slack-form-body';
/* eslint-enable simple-import-sort/imports */

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
    // Slack populates this with arbitrarily nested element values
    // (selected_option, value, text, etc.) — we read shape per-element
    // at use sites, so a loose `any` map is appropriate here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state?: { values?: Record<string, Record<string, any>> };
  };
}

export const run = async (events: FunctionInput[]): Promise<any> => {
  const results = await Promise.all(
    events.map(async (event) => {
      try {
        return await handle(event);
      } catch (error: unknown) {
        logger.error(`[${event?.execution_metadata?.request_id ?? 'unknown'}] [interactivity] error:`, errMsg(error));
        return { reason: errMsg(error) || 'Unknown error', status: 'error' };
      }
    })
  );
  return results.length === 1 ? results[0] : results;
};

export default run;

async function handle(event: FunctionInput): Promise<any> {
  const requestId = event.execution_metadata.request_id;
  const payload = event.payload;

  const wrapped = payload && typeof payload === 'object' && 'body' in payload && 'headers' in payload ? payload : null;
  let body: any = wrapped ? wrapped.body : payload;
  const headers: Record<string, any> | undefined = wrapped ? wrapped.headers : undefined;
  const bodyRaw: string | undefined =
    wrapped && typeof (wrapped as any).body_raw === 'string' ? (wrapped as any).body_raw : undefined;

  // Fast path for block_actions clicks. Slack's `trigger_id` is valid
  // for ~3 seconds from click time — every millisecond we spend here
  // counts against that budget. Get to views.open as fast as possible
  // by skipping the per-invocation logging until after we've consumed
  // the trigger.
  const fastPathResult = await tryFastPathBlockActions(bodyRaw, body, event.input_data.keyrings, requestId);
  if (fastPathResult) return fastPathResult;

  // Visibility — log every invocation so we can confirm Slack reaches us.
  logger.info(
    `[${requestId}] [interactivity] received payload keys: ${
      payload && typeof payload === 'object' ? Object.keys(payload).join(',') : typeof payload
    }`
  );

  // Diagnostic: show what the inner body looks like before normalization.
  // Slack form-encoded bodies sometimes arrive as parsed objects with the
  // form fields as keys (e.g. {command, trigger_id, user_id, …}); other
  // times as a string; other times empty with bytes only in body_raw.
  logger.info(
    `[${requestId}] [interactivity] body type=${typeof body} keys=${
      body && typeof body === 'object' ? Object.keys(body).slice(0, 20).join(',') : '∅'
    } body_raw_len=${bodyRaw ? bodyRaw.length : 0}`
  );
  if (bodyRaw) {
    try {
      const decodedPreview = Buffer.from(bodyRaw, 'base64').toString('utf8').slice(0, 200);
      logger.info(`[${requestId}] [interactivity] body_raw preview: ${decodedPreview}`);
    } catch {}
  }

  // Slack delivers slash commands and Block-Kit interactivity as
  // `application/x-www-form-urlencoded`. The DevRev gateway forwards
  // those bodies in unpredictable shapes — parsed object, raw string,
  // or even an empty object with the bytes in body_raw. Normalize via
  // helpers in utils/slack-form-body.ts.

  if (typeof body === 'string') {
    logger.info(`[${requestId}] [interactivity] body is string (len=${body.length}) — parsing as form`);
    body = parseFormUrlEncoded(body);
  }

  // If body still doesn't have a discriminator field but body_raw is
  // present, decode body_raw (base64) and parse as form.
  if (!bodyHasUsefulKey(body) && bodyRaw) {
    const decoded = decodeBase64BodyRaw(bodyRaw);
    if (decoded === null) {
      logger.warn(`[${requestId}] [interactivity] body_raw is not valid base64`);
    } else {
      logger.info(
        `[${requestId}] [interactivity] body has no command/type/payload — parsing body_raw (decoded_len=${decoded.length})`
      );
      const parsed = parseFormUrlEncoded(decoded);
      if (Object.keys(parsed).length > 0) {
        body = parsed;
      }
    }
  }

  // If the parsed form has a `payload` field (Block-Kit interactivity),
  // the value is URL-encoded JSON — promote it to the body.
  const promoted = tryPromotePayloadField(body);
  if (promoted !== null) {
    body = promoted;
  } else if (body && typeof body === 'object' && typeof (body as any).payload === 'string') {
    // Field was present but JSON.parse failed. Fall back to string body so
    // signature verification can still see the original payload, and warn so
    // an operator notices the malformed Block-Kit response.
    logger.warn(`[${requestId}] [interactivity] payload JSON parse failed — keeping form body`);
  }

  const signingSecret = event.input_data.keyrings?.['slack_signing_secret'];
  const sigCheck = validateSlackSignature(signingSecret, headers, body, bodyRaw);
  if (!sigCheck.valid) {
    logger.warn(`[${requestId}] [interactivity] signature rejected: ${sigCheck.reason}`);
    return FORBIDDEN_RESPONSE;
  }

  if (!body || typeof body !== 'object') {
    logger.warn(`[${requestId}] [interactivity] empty/invalid body after normalization`);
    return { reason: 'Empty interactivity payload', status: 'ignored' };
  }

  const slackBotToken = event.input_data.keyrings['slack_bot_token'];
  if (!slackBotToken) {
    logger.error(`[${requestId}] [interactivity] slack_bot_token missing`);
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
    logger.info(`[${requestId}] [interactivity] dispatch: slash command=${(body as any).command}`);
    return handleSlashCommand(body as SlackSlashCommandPayload, slackBotToken, storeConfig, requestId);
  }

  const interactivity = body as SlackInteractivityPayload;
  const type = interactivity.type;
  logger.info(`[${requestId}] [interactivity] type=${type}`);

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
 * Today the only registered button is the "Submit your feedback" prompt
 * posted by session_gc on idle expiry. Click → use the click's
 * trigger_id to open the modal pre-bound to the (ended) session id
 * encoded in the button's `value`.
 */
async function handleBlockActions(
  payload: SlackInteractivityPayload,
  slackBotToken: string,
  requestId: string
): Promise<unknown> {
  const action = payload.actions?.[0];
  if (!action?.action_id) {
    return { reason: 'No action in block_actions payload', status: 'ignored' };
  }

  if (action.action_id !== ACTION_OPEN_FEEDBACK_FROM_PROMPT) {
    return { reason: `Unhandled action_id: ${action.action_id}`, status: 'ignored' };
  }

  const ctx = decodeContext(action.value);
  if (!ctx) {
    logger.warn(`[${requestId}] [block_actions] invalid context on feedback button`);
    return { reason: 'Invalid feedback prompt value', status: 'error' };
  }
  if (!payload.trigger_id) {
    logger.warn(`[${requestId}] [block_actions] missing trigger_id`);
    return { reason: 'Missing trigger_id', status: 'error' };
  }

  // Two-stage pattern (matches the slash-command flow). The fast path
  // tryFastPathBlockActions normally handles this before we get here;
  // this slow path stays as a safety net for body-shape edge cases.
  let viewId: string;
  try {
    viewId = await openView(payload.trigger_id, buildLoadingModal(), slackBotToken);
    logger.info(`[${requestId}] [block_actions] loading modal opened view_id=${viewId}`);
  } catch (error: unknown) {
    logger.error(`[${requestId}] [block_actions] views.open (loading) failed: ${errMsg(error)}`);
    return { details: errMsg(error), reason: 'views.open failed', status: 'error' };
  }

  if (!viewId) {
    return { reason: 'No view id', status: 'error' };
  }

  try {
    await updateView(viewId, buildFeedbackModal(ctx), slackBotToken);
    logger.info(`[${requestId}] [block_actions] real form rendered session=${ctx.sessionId}`);
    return { mode: 'feedback_modal_opened', session_id: ctx.sessionId, status: 'success' };
  } catch (error: unknown) {
    logger.error(`[${requestId}] [block_actions] views.update failed: ${errMsg(error)}`);
    return { details: errMsg(error), reason: 'views.update failed', status: 'error' };
  }
}

/**
 * Handle `/sda-agent-feedback`.
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
 * would show "/sda-agent-feedback failed" with no modal at all.
 */
async function handleSlashCommand(
  cmd: SlackSlashCommandPayload,
  slackBotToken: string,
  storeConfig: StoreConfig,
  requestId: string
): Promise<any> {
  const command = (cmd.command || '').trim().toLowerCase();
  if (command !== FEEDBACK_SLASH_COMMAND) {
    logger.info(`[${requestId}] [slash] ignored unknown command: ${command}`);
    return { reason: `Unknown slash command: ${command}`, status: 'ignored' };
  }

  if (!cmd.trigger_id) {
    logger.warn(`[${requestId}] [slash] /sda-agent-feedback missing trigger_id`);
    return { reason: 'Missing trigger_id', status: 'error' };
  }

  // Stage 1 — open Loading modal immediately. This MUST complete inside
  // Slack's 3s trigger_id window. No DevRev calls, no other awaits.
  let viewId: string;
  try {
    viewId = await openView(cmd.trigger_id, buildLoadingModal(), slackBotToken);
    logger.info(
      `[${requestId}] [slash] /sda-agent-feedback loading modal opened view_id=${viewId} channel=${cmd.channel_id} user=${cmd.user_id}`
    );
  } catch (error: unknown) {
    logger.error(`[${requestId}] [slash] views.open (loading) failed: ${errMsg(error)}`);
    return { details: errMsg(error), reason: 'views.open failed', status: 'error' };
  }

  if (!viewId) {
    logger.warn(`[${requestId}] [slash] views.open returned no view id`);
    return { reason: 'No view id', status: 'error' };
  }

  // Stage 2 — resolve the active session and update the modal.
  let session: SessionRecord | null = null;
  try {
    session = await getLatestActiveSessionForUserInChannel(storeConfig, cmd.channel_id, cmd.user_id);
  } catch (error: unknown) {
    logger.warn(`[${requestId}] [slash] active-session lookup failed: ${errMsg(error)}`);
  }

  if (!session) {
    logger.info(
      `[${requestId}] [slash] no active session for user=${cmd.user_id} channel=${cmd.channel_id} — showing error modal`
    );
    try {
      await updateView(
        viewId,
        buildErrorModal(
          'No active SDA Agent conversation was found in this channel.\n\nStart a conversation by mentioning the bot or sending a direct message, then run `/sda-agent-feedback` again to share your feedback.'
        ),
        slackBotToken
      );
    } catch (error: unknown) {
      logger.warn(`[${requestId}] [slash] views.update (error) failed: ${errMsg(error)}`);
    }
    return { mode: 'feedback_no_session', status: 'success' };
  }

  // Real form — sessionId baked into private_metadata so submit is direct.
  const ctx: FeedbackContext = {
    channel: session.channel,
    sessionId: session.sessionId,
    threadTs: session.threadTs || undefined,
    userId: cmd.user_id,
  };
  try {
    await updateView(viewId, buildFeedbackModal(ctx), slackBotToken);
    logger.info(`[${requestId}] [slash] /sda-agent-feedback form rendered for session=${session.sessionId}`);
    return { mode: 'feedback_modal_opened', session_id: session.sessionId, status: 'success' };
  } catch (error: unknown) {
    logger.error(`[${requestId}] [slash] views.update failed: ${errMsg(error)}`);
    return { details: errMsg(error), reason: 'views.update failed', status: 'error' };
  }
}

interface ViewSubmissionUser {
  id?: string;
}

async function handleViewSubmission(
  payload: SlackInteractivityPayload & { user?: ViewSubmissionUser },
  slackBotToken: string,
  storeConfig: StoreConfig,
  requestId: string
): Promise<any> {
  if (payload.view?.callback_id !== FEEDBACK_VIEW_CALLBACK) {
    return { reason: `Unhandled view callback_id: ${payload.view?.callback_id}`, status: 'ignored' };
  }

  const ctx = decodeContext(payload.view.private_metadata);
  if (!ctx) {
    logger.warn(`[${requestId}] [feedback] submit: invalid private_metadata`);
    return responseActionErrors({
      [FEEDBACK_BLOCK_RATING]: 'We could not identify your session. Please close this form and try again.',
    });
  }

  const values = payload.view.state?.values || {};
  const rating = parseRating(values[FEEDBACK_BLOCK_RATING]?.[FEEDBACK_ACTION_RATING]);
  if (!rating) {
    return responseActionErrors({
      [FEEDBACK_BLOCK_RATING]: 'Please select a rating before submitting.',
    });
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
      sessionRecord = await getLatestActiveSessionForUserInChannel(storeConfig, ctx.channel, ctx.userId);
    }
  } catch (error: unknown) {
    logger.warn(`[${requestId}] [feedback] session lookup failed: ${errMsg(error)}`);
  }

  if (!sessionRecord) {
    logger.warn(
      `[${requestId}] [feedback] no active session for sessionId=${ctx.sessionId || '∅'} channel=${
        ctx.channel || '∅'
      } user=${ctx.userId || '∅'}`
    );
    return responseActionErrors({
      [FEEDBACK_BLOCK_RATING]:
        'No active SDA Agent conversation was found in this channel. Start a conversation with the bot, then try again.',
    });
  }

  const submittedAt = Date.now();
  // If the user submitted from the GC-posted "Submit your feedback"
  // prompt, that prompt message is now redundant — clear its ts on the
  // session and delete the message from Slack. Done before persistence
  // so the patchSession write covers the cleared field too.
  const promptTsToDelete = sessionRecord.feedbackPromptTs || '';
  try {
    await patchSession(storeConfig, sessionRecord, {
      feedbackPromptTs: null,
      feedbackRating: rating,
      feedbackSubmittedAt: submittedAt,
      feedbackText: comment,
    });
    logger.info(
      `[${requestId}] [feedback] persisted session=${ctx.sessionId} rating=${rating} comment_chars=${comment.length}`
    );
  } catch (error: unknown) {
    logger.error(`[${requestId}] [feedback] patchSession failed: ${errMsg(error)}`);
    return responseActionErrors({
      [FEEDBACK_BLOCK_RATING]: 'We could not save your feedback right now. Please try again.',
    });
  }

  // Best-effort delete of the prompt message that asked the user to
  // submit feedback. Doesn't block the response; if it fails, the
  // hard-expiry GC sweep will clean it up later anyway.
  if (promptTsToDelete && sessionRecord.channel) {
    try {
      await deleteMessage(sessionRecord.channel, promptTsToDelete, slackBotToken);
      logger.info(`[${requestId}] [feedback] deleted prompt ts=${promptTsToDelete}`);
    } catch (err: unknown) {
      logger.warn(`[${requestId}] [feedback] prompt delete failed: ${errMsg(err)}`);
    }
  }

  // Send a PRIVATE confirmation back. Two layers, both visible only to
  // the submitter:
  //   1. response_action: 'update' swaps the modal contents in-place to
  //      a "Thanks for the feedback!" view (modals are inherently
  //      private to the user who opened them).
  //   2. chat.postEphemeral posts a small breadcrumb in the same thread
  //      that ONLY the submitter can see. Other members of the channel
  //      see nothing.
  const confirmChannel = sessionRecord.channel || ctx.channel;
  const confirmThread = sessionRecord.threadTs || ctx.threadTs;
  const submitterUserId = payload.user?.id || ctx.userId || '';
  if (confirmChannel && submitterUserId) {
    try {
      await postEphemeral(
        confirmChannel,
        submitterUserId,
        feedbackConfirmationFallbackText(rating),
        buildFeedbackConfirmationBlocks(rating, comment),
        slackBotToken,
        confirmThread
      );
    } catch (err: unknown) {
      logger.warn(`[${requestId}] [feedback] ephemeral send failed: ${errMsg(err)}`);
    }
  }

  // Tell Slack to swap the modal to the thank-you view. Slack only
  // renders the modal to the submitter, so the rating + comment are
  // never visible to anyone else.
  return {
    response_action: 'update',
    view: buildFeedbackThanksModal(rating, comment),
  };
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
  return { errors, response_action: 'errors' };
}

/**
 * Fast path for Block-Kit button clicks (block_actions).
 *
 * Slack's `trigger_id` is valid for only ~3 seconds from the moment the
 * user clicked. Going through the full handle() path (signature
 * verification, multiple body normalisation passes, storeConfig setup)
 * has been observed to consume enough of that budget that views.open
 * fails with `expired_trigger_id`.
 *
 * This function does the minimum work needed to call views.open:
 *   - Decode body_raw if needed to obtain the `payload=…` form field.
 *   - JSON.parse the payload.
 *   - For `block_actions` with our feedback-prompt action, extract
 *     trigger_id + the encoded FeedbackContext on the click's value.
 *   - Call views.open and return.
 *
 * If the payload isn't a block_actions click, or isn't our action_id,
 * we return null so the caller continues with the normal flow.
 *
 * Note: we deliberately skip signature verification on the fast path.
 * The downside of an attacker hitting this path is that they can ask
 * Slack to open a modal with a fake trigger_id — which Slack itself
 * rejects with not_authed/invalid_trigger_id. There's no escalation
 * path because the modal can't write to anything until the user
 * actually submits, and that submission goes through the normal
 * (signature-verified) view_submission path.
 */
async function tryFastPathBlockActions(
  bodyRaw: string | undefined,
  bodyAlreadyParsed: unknown,
  keyrings: Record<string, string> | undefined,
  requestId: string
): Promise<unknown | null> {
  // Get to a parsed JSON click payload as quickly as possible.
  let click: { type?: string; trigger_id?: string; actions?: Array<{ action_id?: string; value?: string }> } | null =
    null;
  try {
    if (bodyAlreadyParsed && typeof bodyAlreadyParsed === 'object' && (bodyAlreadyParsed as { type?: string }).type) {
      // Gateway already gave us a parsed JSON object.
      click = bodyAlreadyParsed as unknown as typeof click;
    } else if (bodyRaw) {
      const decoded = Buffer.from(bodyRaw, 'base64').toString('utf8');
      // Slack interactivity bodies are `payload=<urlencoded JSON>`.
      const eq = decoded.indexOf('=');
      const payloadStr = decoded.startsWith('payload=')
        ? decodeURIComponent(decoded.slice(eq + 1).replace(/\+/g, ' '))
        : null;
      if (payloadStr) click = JSON.parse(payloadStr);
    }
  } catch {
    return null;
  }

  if (!click || click.type !== 'block_actions' || !click.trigger_id) return null;
  const action = click.actions?.[0];
  if (!action || action.action_id !== ACTION_OPEN_FEEDBACK_FROM_PROMPT) return null;

  const ctx = decodeContext(action.value);
  if (!ctx) {
    logger.warn(`[${requestId}] [block_actions] fast-path: invalid context`);
    return null;
  }
  const slackBotToken = keyrings?.['slack_bot_token'];
  if (!slackBotToken) {
    logger.warn(`[${requestId}] [block_actions] fast-path: slack_bot_token missing`);
    return null;
  }

  // Two-stage pattern (matches the slash-command flow). views.open
  // with a tiny Loading modal consumes the 3-second trigger_id budget
  // even on cold starts (~50ms payload, no DevRev round-trip). The
  // returned view_id has no expiry — we then call views.update to
  // swap in the real form. This is the same trick that makes the
  // /sda-agent-feedback flow reliable; applying it here gives the button
  // the same reliability.
  let viewId: string;
  try {
    viewId = await openView(click.trigger_id, buildLoadingModal(), slackBotToken);
    logger.info(`[${requestId}] [block_actions] fast-path: loading modal opened view_id=${viewId}`);
  } catch (error: unknown) {
    logger.error(`[${requestId}] [block_actions] fast-path views.open (loading) failed: ${errMsg(error)}`);
    return { details: errMsg(error), reason: 'views.open failed', status: 'error' };
  }

  if (!viewId) {
    logger.warn(`[${requestId}] [block_actions] fast-path: no view id returned`);
    return { reason: 'No view id', status: 'error' };
  }

  // Stage 2: swap in the real form. view_id is durable, no clock to race.
  try {
    await updateView(viewId, buildFeedbackModal(ctx), slackBotToken);
    logger.info(`[${requestId}] [block_actions] fast-path: real form rendered session=${ctx.sessionId}`);
    return { mode: 'feedback_modal_opened', session_id: ctx.sessionId, status: 'success' };
  } catch (error: unknown) {
    logger.error(`[${requestId}] [block_actions] fast-path views.update failed: ${errMsg(error)}`);
    return { details: errMsg(error), reason: 'views.update failed', status: 'error' };
  }
}
