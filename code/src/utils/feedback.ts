/**
 * Feedback flow — Block-Kit modal definitions for the in-Slack
 * "rate this conversation" form.
 *
 * Trigger: a real Slack slash command (`/sda-feedback`). Slack delivers the
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

// Block-Kit action ids for the typed-text-triggered prompt buttons.
export const ACTION_OPEN_FEEDBACK = 'feedback_open';
export const ACTION_DISMISS_FEEDBACK_PROMPT = 'feedback_dismiss';

// Slash command Slack delivers to the interactivity webhook. Configured
// in the Slack app's "Slash Commands" page; mirrored here so the
// dispatcher can reject other commands cleanly.
export const FEEDBACK_SLASH_COMMAND = '/sda-feedback';

// Phrases that trigger the in-message feedback prompt. Match is exact
// (case-insensitive, punctuation-tolerant) on the cleaned message text
// (i.e. after the bot mention is stripped). Slash-command form
// (`/sda-feedback`) uses the slash-command path instead.
const FEEDBACK_INTENT_PHRASES: ReadonlyArray<string> = [
  'i want to give a feedback',
  'i want to give feedback',
  'i would like to give feedback',
  'i would like to give a feedback',
  'give feedback',
  'leave feedback',
  'submit feedback',
];

/**
 * True when the user's typed message expresses intent to leave feedback.
 * Used by slack_handler before invoking the AI Agent — when matched,
 * the handler short-circuits and posts the feedback button prompt.
 */
export function isFeedbackIntent(message: string): boolean {
  if (!message) return false;
  const normalized = message
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return FEEDBACK_INTENT_PHRASES.some(
    (phrase) => normalized === phrase || normalized.startsWith(`${phrase} `)
  );
}

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

/**
 * The modal Slack opens when the user runs `/sda-feedback`. Rating is a
 * static_select 1-5; comment is an optional multiline plain_text_input.
 * Slack auto-renders Submit/Cancel buttons from the view's `submit`/
 * `close` fields — they don't need to be blocks.
 */
export function buildFeedbackModal(ctx: FeedbackContext): any {
  return {
    type: 'modal',
    callback_id: FEEDBACK_VIEW_CALLBACK,
    private_metadata: encodeContext(ctx),
    title: { type: 'plain_text', text: 'Share your feedback' },
    submit: { type: 'plain_text', text: 'Submit' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'How would you rate this conversation?' },
      },
      {
        type: 'input',
        block_id: FEEDBACK_BLOCK_RATING,
        label: { type: 'plain_text', text: 'Rating (1 = poor, 5 = great)' },
        element: {
          type: 'static_select',
          action_id: FEEDBACK_ACTION_RATING,
          placeholder: { type: 'plain_text', text: 'Pick a rating' },
          options: [1, 2, 3, 4, 5].map((n) => ({
            text: { type: 'plain_text', text: ratingLabel(n) },
            value: String(n),
          })),
        },
      },
      {
        type: 'input',
        block_id: FEEDBACK_BLOCK_TEXT,
        optional: true,
        label: { type: 'plain_text', text: 'Tell us more (optional)' },
        element: {
          type: 'plain_text_input',
          action_id: FEEDBACK_ACTION_TEXT,
          multiline: true,
          max_length: 2000,
          placeholder: { type: 'plain_text', text: 'What worked well? What could be better?' },
        },
      },
    ],
  };
}

/**
 * Block-Kit message posted in-thread when the user types a feedback
 * intent ("I want to give a feedback"). Plain message events don't
 * carry a `trigger_id`, so we can't open a modal directly — we post
 * a button whose click WILL deliver a `trigger_id` to the interactivity
 * handler, which then opens the modal.
 *
 * The button's `value` carries the resolved session context so the
 * interactivity handler doesn't need a second DevRev round-trip.
 */
export function buildFeedbackPromptBlocks(ctx: FeedbackContext): any[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Share your feedback*\nWe would love to hear how this conversation went.',
      },
    },
    {
      type: 'actions',
      block_id: 'feedback_prompt_actions',
      elements: [
        {
          type: 'button',
          action_id: ACTION_OPEN_FEEDBACK,
          style: 'primary',
          text: { type: 'plain_text', text: '📝 Give Feedback' },
          value: encodeContext(ctx),
        },
        {
          type: 'button',
          action_id: ACTION_DISMISS_FEEDBACK_PROMPT,
          text: { type: 'plain_text', text: 'Not now' },
          value: encodeContext(ctx),
        },
      ],
    },
  ];
}

export const FEEDBACK_PROMPT_FALLBACK_TEXT =
  'We would love your feedback on this conversation.';

export function buildFeedbackDismissedBlocks(): any[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '_Feedback skipped — let me know if you change your mind._',
      },
    },
  ];
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
export function buildLoadingModal(): any {
  return {
    type: 'modal',
    callback_id: FEEDBACK_VIEW_CALLBACK,
    title: { type: 'plain_text', text: 'Share your feedback' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: ':hourglass_flowing_sand: _Loading the feedback form…_' },
      },
    ],
  };
}

/**
 * Error modal shown via views.update when something goes wrong building
 * the real form (e.g. no active session, DevRev call failed).
 */
export function buildErrorModal(message: string): any {
  return {
    type: 'modal',
    callback_id: FEEDBACK_VIEW_CALLBACK,
    title: { type: 'plain_text', text: 'Share your feedback' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: message } }],
  };
}

/**
 * Confirmation blocks posted in-thread after a successful submit.
 */
export function buildFeedbackConfirmationBlocks(rating: number, comment: string): any[] {
  const stars = '★'.repeat(rating) + '☆'.repeat(Math.max(0, 5 - rating));
  const lines = [`*Thanks for the feedback!*`, `Rating: ${stars} (${rating}/5)`];
  if (comment.trim()) {
    lines.push(`> ${comment.trim().replace(/\n/g, '\n> ')}`);
  }
  return [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }];
}

export function feedbackConfirmationFallbackText(rating: number): string {
  return `Thanks for the feedback — recorded a ${rating}/5 rating on your session.`;
}

function ratingLabel(n: number): string {
  switch (n) {
    case 1:
      return '1 — Poor';
    case 2:
      return '2 — Fair';
    case 3:
      return '3 — Good';
    case 4:
      return '4 — Very good';
    case 5:
      return '5 — Excellent';
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
    s: ctx.sessionId,
    c: ctx.channel,
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
      sessionId: parsed.s,
      channel: typeof parsed.c === 'string' ? parsed.c : '',
      threadTs: typeof parsed.t === 'string' && parsed.t ? parsed.t : undefined,
      userId: typeof parsed.u === 'string' && parsed.u ? parsed.u : undefined,
    };
  } catch {
    return null;
  }
}
