/**
 * Feedback flow — Block-Kit modal definitions for the in-Slack
 * "rate this conversation" form.
 *
 * Trigger: a real Slack slash command (`/sda-agent-feedback`). Slack delivers the
 * slash-command form payload to our interactivity webhook with a fresh
 * `trigger_id`, so we open the modal directly via `views.open` — no
 * intermediate "click a button" hop.
 *
 * Submit: Slack delivers a `view_submission` payload. We persist the
 * rating + comment onto the active session's DevRev conversation custom
 * fields and post a thank-you reply.
 *
 * The session id is round-tripped through the modal's `private_metadata`.
 */

export const FEEDBACK_VIEW_CALLBACK = 'feedback_submit_view';
export const FEEDBACK_BLOCK_RATING = 'feedback_rating_block';
export const FEEDBACK_BLOCK_TEXT = 'feedback_text_block';
export const FEEDBACK_ACTION_RATING = 'rating';
export const FEEDBACK_ACTION_TEXT = 'comment';

// Slash command Slack delivers to the interactivity webhook. Configured
// in the Slack app's "Slash Commands" page; mirrored here so the
// dispatcher can reject other commands cleanly.
export const FEEDBACK_SLASH_COMMAND = '/sda-agent-feedback';

// action_id of the "Submit your feedback" button posted by session_gc
// when a session idle-expires. Click delivers a block_actions payload
// with a fresh trigger_id; slack_interactivity opens the modal pre-bound
// to the ended session id (carried via the button's `value`).
export const ACTION_OPEN_FEEDBACK_FROM_PROMPT = 'feedback_open_from_prompt';

export interface FeedbackContext {
  /**
   * The active session id at modal-open time. May be empty when the
   * modal is opened from a slash command — in that case, the
   * view_submission handler resolves the session by (channel, userId).
   */
  sessionId: string;
  channel: string;
  threadTs?: string;
  userId?: string;
}

// Centralised modal title — used across loading / form / error / thanks
// states for visual continuity. Slack caps modal titles at 24 chars.
const MODAL_TITLE = 'SDA Agent Feedback';

// Block-Kit shapes are recursive and finely typed in @slack/types,
// but we build literal objects here that get JSON-serialised — the
// alternative (fully typing every nested Block Kit element) would
// pull in @slack/types just for static check. We expose loose aliases
// and silence the rule once.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SlackView = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SlackBlock = any;

/**
 * The modal Slack opens when the user runs `/sda-agent-feedback`. Rating is a
 * static_select 1-5; comment is an optional multiline plain_text_input.
 * Slack auto-renders Submit/Cancel buttons from the view's `submit`/
 * `close` fields — they don't need to be blocks.
 */
export function buildFeedbackModal(ctx: FeedbackContext): SlackView {
  return {
    blocks: [
      {
        text: {
          text: 'Your feedback helps us improve the SDA Agent. It takes less than a minute.',
          type: 'mrkdwn',
        },
        type: 'section',
      },
      { type: 'divider' },
      {
        block_id: FEEDBACK_BLOCK_RATING,
        element: {
          action_id: FEEDBACK_ACTION_RATING,
          options: [1, 2, 3, 4, 5].map((n) => ({
            text: { text: ratingLabel(n), type: 'plain_text' },
            value: String(n),
          })),
          placeholder: { text: 'Select a rating', type: 'plain_text' },
          type: 'static_select',
        },
        label: { text: 'How would you rate this experience?', type: 'plain_text' },
        type: 'input',
      },
      {
        block_id: FEEDBACK_BLOCK_TEXT,
        element: {
          action_id: FEEDBACK_ACTION_TEXT,
          max_length: 2000,
          multiline: true,
          placeholder: {
            text: 'e.g. Accurate answers, but a bit slow on long queries.',
            type: 'plain_text',
          },
          type: 'plain_text_input',
        },
        hint: {
          text: 'Optional. Share what worked well or what we could improve.',
          type: 'plain_text',
        },
        label: { text: 'Additional comments', type: 'plain_text' },
        optional: true,
        type: 'input',
      },
    ],
    callback_id: FEEDBACK_VIEW_CALLBACK,
    close: { text: 'Cancel', type: 'plain_text' },
    private_metadata: encodeContext(ctx),
    submit: { text: 'Submit feedback', type: 'plain_text' },
    title: { text: MODAL_TITLE, type: 'plain_text' },
    type: 'modal',
  };
}

/**
 * Loading modal — opened synchronously on slash-command receipt so Slack's
 * trigger_id is consumed inside its 3s window. The async path then calls
 * views.update to swap this for the real form (or an error modal).
 *
 * The callback_id is set to FEEDBACK_VIEW_CALLBACK so that if the user
 * (somehow) submits while it's still loading, our submit handler matches
 * and surfaces a proper error.
 */
export function buildLoadingModal(): SlackView {
  return {
    blocks: [
      {
        text: {
          text: ':hourglass_flowing_sand: _Preparing the feedback form…_',
          type: 'mrkdwn',
        },
        type: 'section',
      },
    ],
    callback_id: FEEDBACK_VIEW_CALLBACK,
    close: { text: 'Close', type: 'plain_text' },
    title: { text: MODAL_TITLE, type: 'plain_text' },
    type: 'modal',
  };
}

/**
 * Error modal shown via views.update when something goes wrong building
 * the real form (e.g. no active session, DevRev call failed).
 */
export function buildErrorModal(message: string): SlackView {
  return {
    blocks: [{ text: { text: message, type: 'mrkdwn' }, type: 'section' }],
    callback_id: FEEDBACK_VIEW_CALLBACK,
    close: { text: 'Close', type: 'plain_text' },
    title: { text: MODAL_TITLE, type: 'plain_text' },
    type: 'modal',
  };
}

/**
 * Modal view shown via `response_action: 'update'` after successful
 * submit. Replaces the form contents in-place with a thank-you message
 * — fully private, since modals are only ever rendered to the user
 * who submitted.
 */
export function buildFeedbackThanksModal(rating: number, comment: string): SlackView {
  const stars = '★'.repeat(rating) + '☆'.repeat(Math.max(0, 5 - rating));
  const lines = ['*Thank you — your feedback has been recorded.*', `Rating: ${stars}  (${rating}/5)`];
  if (comment.trim()) {
    lines.push('', '*Your comment*', `> ${comment.trim().replace(/\n/g, '\n> ')}`);
  }
  lines.push('', '_We appreciate you taking the time to help us improve._');
  return {
    blocks: [{ text: { text: lines.join('\n'), type: 'mrkdwn' }, type: 'section' }],
    callback_id: FEEDBACK_VIEW_CALLBACK,
    close: { text: 'Close', type: 'plain_text' },
    title: { text: MODAL_TITLE, type: 'plain_text' },
    type: 'modal',
  };
}

/**
 * Confirmation blocks for the ephemeral thread-side note. Visible only
 * to the submitter; just a brief breadcrumb that feedback was captured.
 */
export function buildFeedbackConfirmationBlocks(rating: number, _comment: string): SlackBlock[] {
  const stars = '★'.repeat(rating) + '☆'.repeat(Math.max(0, 5 - rating));
  return [
    {
      text: {
        text: `*Thank you for your feedback.* Rating: ${stars}  (${rating}/5)`,
        type: 'mrkdwn',
      },
      type: 'section',
    },
  ];
}

/**
 * Block-Kit message posted by session_gc when a session idle-expires.
 * Carries a "Submit your feedback" button whose value is the ended
 * session's FeedbackContext, so the click handler can open the modal
 * pre-bound to that session (no active-session lookup needed).
 *
 * The same prompt is deleted on hard-expiry so it doesn't outlive the
 * underlying conversation.
 */
export function buildFeedbackPromptBlocks(ctx: FeedbackContext): SlackBlock[] {
  return [
    {
      text: {
        text:
          '*Your conversation with the SDA Agent has ended.*\n' +
          'Take a moment to share how it went — your feedback helps us improve.',
        type: 'mrkdwn',
      },
      type: 'section',
    },
    {
      block_id: 'feedback_prompt_actions',
      elements: [
        {
          action_id: ACTION_OPEN_FEEDBACK_FROM_PROMPT,
          style: 'primary',
          text: { text: '📝 Submit your feedback', type: 'plain_text' },
          type: 'button',
          value: encodeContext(ctx),
        },
      ],
      type: 'actions',
    },
  ];
}

export const FEEDBACK_PROMPT_FALLBACK_TEXT = 'Submit feedback on the SDA Agent.';

export function feedbackConfirmationFallbackText(rating: number): string {
  return `Feedback recorded — ${rating}/5 rating saved.`;
}

function ratingLabel(n: number): string {
  switch (n) {
    case 1:
      return '★☆☆☆☆  (1) Poor';
    case 2:
      return '★★☆☆☆  (2) Fair';
    case 3:
      return '★★★☆☆  (3) Good';
    case 4:
      return '★★★★☆  (4) Very good';
    case 5:
      return '★★★★★  (5) Excellent';
    default:
      return String(n);
  }
}

/**
 * Encode routing context as a compact JSON blob. Slack caps
 * `private_metadata` at 3000 chars; three short strings stay well under.
 */
export function encodeContext(ctx: FeedbackContext): string {
  return JSON.stringify({
    c: ctx.channel,
    s: ctx.sessionId,
    t: ctx.threadTs || '',
    u: ctx.userId || '',
  });
}

export function decodeContext(raw: string | undefined | null): FeedbackContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.s !== 'string') return null;
    return {
      channel: typeof parsed.c === 'string' ? parsed.c : '',
      sessionId: parsed.s,
      threadTs: typeof parsed.t === 'string' && parsed.t ? parsed.t : undefined,
      userId: typeof parsed.u === 'string' && parsed.u ? parsed.u : undefined,
    };
  } catch {
    return null;
  }
}
