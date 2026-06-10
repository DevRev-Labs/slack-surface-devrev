/**
 * Slack Interactivity + Slash Command Handler.
 *
 * Two event shapes, both delivered to the same Slack interactivity
 * webhook with `application/x-www-form-urlencoded` bodies:
 *
 *   1. Slash command (`/sda-feedback`) — form fields: command,
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
import { LOG_TAG } from '../../config';
import { FunctionInput } from '../../types';
import { createLogger } from '../../utils/logger';
import {
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
import { readSessionTimingConfig } from '../../utils/session-config';
import {
  getLatestActiveSessionForUserInChannel,
  getSessionById,
  patchSession,
  SessionRecord,
  StoreConfig,
} from '../../utils/session-store';
import { openView, postEphemeral, updateView } from '../../utils/slack-client';
import { validateSlackSignature } from '../../utils/slack-signature-validator';
/* eslint-enable simple-import-sort/imports */

const FORBIDDEN_RESPONSE = { status: 'forbidden', status_code: 403 };

/** Extract a string from `catch (e: unknown)` for log/return without `any`. */
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}

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
        createLogger(event?.execution_metadata?.request_id ?? 'unknown', LOG_TAG.INTERACTIVITY).error(
          'Unhandled interactivity error',
          { err_message: errMsg(error) }
        );
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
  // Per-request logger scoped to the interactivity subsystem.
  const log = createLogger(requestId, LOG_TAG.INTERACTIVITY);

  // Visibility — log every invocation so we can confirm Slack reaches us.
  log.info('received payload', {
    keys: payload && typeof payload === 'object' ? Object.keys(payload).join(',') : typeof payload,
  });

  const wrapped = payload && typeof payload === 'object' && 'body' in payload && 'headers' in payload ? payload : null;
  let body: any = wrapped ? wrapped.body : payload;
  const headers: Record<string, any> | undefined = wrapped ? wrapped.headers : undefined;
  const bodyRaw: string | undefined =
    wrapped && typeof (wrapped as any).body_raw === 'string' ? (wrapped as any).body_raw : undefined;

  // Diagnostic: show what the inner body looks like before normalization.
  // Slack form-encoded bodies sometimes arrive as parsed objects with the
  // form fields as keys (e.g. {command, trigger_id, user_id, …}); other
  // times as a string; other times empty with bytes only in body_raw.
  log.debug('body shape before normalization', {
    body_keys: body && typeof body === 'object' ? Object.keys(body).slice(0, 20).join(',') : '∅',
    body_raw_len: bodyRaw ? bodyRaw.length : 0,
    body_type: typeof body,
  });
  if (bodyRaw) {
    try {
      const decodedPreview = Buffer.from(bodyRaw, 'base64').toString('utf8').slice(0, 200);
      log.debug('body_raw preview', { preview: decodedPreview });
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
    log.debug('body is string — parsing as form', { length: body.length });
    body = parseFormUrlEncoded(body);
  }

  // If body still doesn't have a discriminator field but body_raw is
  // present, decode body_raw (base64) and parse as form. Slack form
  // bodies always contain at least one '=' character.
  if (!bodyHasUsefulKey(body) && bodyRaw) {
    try {
      const decoded = Buffer.from(bodyRaw, 'base64').toString('utf8');
      log.debug('body has no command/type/payload — parsing body_raw', { decoded_len: decoded.length });
      const parsed = parseFormUrlEncoded(decoded);
      if (Object.keys(parsed).length > 0) {
        body = parsed;
      }
    } catch (err: unknown) {
      log.warn('body_raw decode failed', { err_message: errMsg(err) });
    }
  }

  // If the parsed form has a `payload` field (Block-Kit interactivity),
  // the value is URL-encoded JSON — promote it to the body.
  if (body && typeof body === 'object' && typeof body.payload === 'string') {
    try {
      body = JSON.parse(body.payload);
    } catch (err: unknown) {
      log.warn('payload JSON parse failed', { err_message: errMsg(err) });
    }
  }

  const signingSecret = event.input_data.keyrings?.['slack_signing_secret'];
  const sigCheck = validateSlackSignature(signingSecret, headers, body, bodyRaw);
  if (!sigCheck.valid) {
    log.warn('signature rejected', { reason: sigCheck.reason }, LOG_TAG.AUTH);
    return FORBIDDEN_RESPONSE;
  }

  if (!body || typeof body !== 'object') {
    log.warn('empty/invalid body after normalization');
    return { reason: 'Empty interactivity payload', status: 'ignored' };
  }

  const slackBotToken = event.input_data.keyrings['slack_bot_token'];
  if (!slackBotToken) {
    log.error('slack_bot_token missing');
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
    log.info('dispatch: slash command', { command: (body as any).command });
    return handleSlashCommand(body as SlackSlashCommandPayload, slackBotToken, storeConfig, requestId);
  }

  const interactivity = body as SlackInteractivityPayload;
  const type = interactivity.type;
  log.info('dispatch: interactivity type', { type });

  if (type === 'view_submission') {
    return handleViewSubmission(interactivity, slackBotToken, storeConfig, requestId);
  }
  if (type === 'view_closed' || type === 'block_actions') {
    return { reason: `No-op for type ${type}`, status: 'ignored' };
  }
  return { reason: `Unsupported interactivity type: ${type}`, status: 'ignored' };
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
  const log = createLogger(requestId, LOG_TAG.SLASH);
  const command = (cmd.command || '').trim().toLowerCase();
  if (command !== FEEDBACK_SLASH_COMMAND) {
    log.info('ignored unknown command', { command });
    return { reason: `Unknown slash command: ${command}`, status: 'ignored' };
  }

  if (!cmd.trigger_id) {
    log.warn('/sda-feedback missing trigger_id');
    return { reason: 'Missing trigger_id', status: 'error' };
  }

  // Stage 1 — open Loading modal immediately. This MUST complete inside
  // Slack's 3s trigger_id window. No DevRev calls, no other awaits.
  let viewId: string;
  try {
    viewId = await openView(cmd.trigger_id, buildLoadingModal(), slackBotToken);
    log.info('/sda-feedback loading modal opened', { channel: cmd.channel_id, user: cmd.user_id, view_id: viewId });
  } catch (error: unknown) {
    log.error('views.open (loading) failed', { err_message: errMsg(error) });
    return { details: errMsg(error), reason: 'views.open failed', status: 'error' };
  }

  if (!viewId) {
    log.warn('views.open returned no view id');
    return { reason: 'No view id', status: 'error' };
  }

  // Stage 2 — resolve the active session and update the modal.
  let session: SessionRecord | null = null;
  try {
    session = await getLatestActiveSessionForUserInChannel(storeConfig, cmd.channel_id, cmd.user_id);
  } catch (error: unknown) {
    log.warn('active-session lookup failed', { err_message: errMsg(error) });
  }

  if (!session) {
    log.info('no active session — showing error modal', { channel: cmd.channel_id, user: cmd.user_id });
    try {
      await updateView(
        viewId,
        buildErrorModal(
          'No active SDA Agent conversation was found in this channel.\n\nStart a conversation by mentioning the bot or sending a direct message, then run `/sda-feedback` again to share your feedback.'
        ),
        slackBotToken
      );
    } catch (error: unknown) {
      log.warn('views.update (error modal) failed', { err_message: errMsg(error) });
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
    log.info('/sda-feedback form rendered', { session_id: session.sessionId });
    return { mode: 'feedback_modal_opened', session_id: session.sessionId, status: 'success' };
  } catch (error: unknown) {
    log.error('views.update (feedback form) failed', { err_message: errMsg(error) });
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
  const log = createLogger(requestId, LOG_TAG.FEEDBACK);
  if (payload.view?.callback_id !== FEEDBACK_VIEW_CALLBACK) {
    return { reason: `Unhandled view callback_id: ${payload.view?.callback_id}`, status: 'ignored' };
  }

  const ctx = decodeContext(payload.view.private_metadata);
  if (!ctx) {
    log.warn('submit: invalid private_metadata');
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
    log.warn('session lookup failed', { err_message: errMsg(error) });
  }

  if (!sessionRecord) {
    log.warn('no active session found', {
      channel: ctx.channel || '∅',
      session_id: ctx.sessionId || '∅',
      user: ctx.userId || '∅',
    });
    return responseActionErrors({
      [FEEDBACK_BLOCK_RATING]:
        'No active SDA Agent conversation was found in this channel. Start a conversation with the bot, then try again.',
    });
  }

  const submittedAt = Date.now();
  try {
    await patchSession(storeConfig, sessionRecord, {
      feedbackRating: rating,
      feedbackSubmittedAt: submittedAt,
      feedbackText: comment,
    });
    log.info('persisted feedback', { comment_chars: comment.length, rating, session_id: ctx.sessionId });
  } catch (error: unknown) {
    log.error('patchSession failed', { err_message: errMsg(error) });
    return responseActionErrors({
      [FEEDBACK_BLOCK_RATING]: 'We could not save your feedback right now. Please try again.',
    });
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
      log.warn('ephemeral confirmation send failed', { err_message: errMsg(err) });
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
