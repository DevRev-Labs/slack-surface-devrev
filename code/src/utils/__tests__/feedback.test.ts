import {
  buildFeedbackConfirmationBlocks,
  buildFeedbackModal,
  decodeContext,
  encodeContext,
  feedbackConfirmationFallbackText,
  FEEDBACK_ACTION_RATING,
  FEEDBACK_ACTION_TEXT,
  FEEDBACK_BLOCK_RATING,
  FEEDBACK_BLOCK_TEXT,
  FEEDBACK_VIEW_CALLBACK,
} from '../feedback';

describe('buildFeedbackModal', () => {
  test('contains a 1-5 static_select and a multiline plain_text_input', () => {
    const view = buildFeedbackModal({ channel: 'C2', sessionId: 's-2' });
    expect(view.type).toBe('modal');
    expect(view.callback_id).toBe(FEEDBACK_VIEW_CALLBACK);
    expect(view.submit?.text).toBe('Submit feedback');
    expect(view.close?.text).toBe('Cancel');

    const ratingBlock = view.blocks.find((b: any) => b.block_id === FEEDBACK_BLOCK_RATING);
    expect(ratingBlock?.element?.type).toBe('static_select');
    expect(ratingBlock?.element?.action_id).toBe(FEEDBACK_ACTION_RATING);
    expect(ratingBlock?.element?.options.map((o: any) => o.value)).toEqual(['1', '2', '3', '4', '5']);

    const textBlock = view.blocks.find((b: any) => b.block_id === FEEDBACK_BLOCK_TEXT);
    expect(textBlock?.element?.type).toBe('plain_text_input');
    expect(textBlock?.element?.action_id).toBe(FEEDBACK_ACTION_TEXT);
    expect(textBlock?.element?.multiline).toBe(true);
    expect(textBlock?.optional).toBe(true);

    expect(decodeContext(view.private_metadata)?.sessionId).toBe('s-2');
  });
});

describe('ephemeral confirmation blocks', () => {
  test('include star rating', () => {
    const text = buildFeedbackConfirmationBlocks(4, 'great help')[0].text.text;
    expect(text).toContain('★★★★☆');
    expect(text).toContain('4/5');
    expect(text).toMatch(/thank you/i);
  });

  test('have stars even when comment is empty', () => {
    const text = buildFeedbackConfirmationBlocks(5, '   ')[0].text.text;
    expect(text).toContain('★★★★★');
  });

  test('fallback text references the rating', () => {
    expect(feedbackConfirmationFallbackText(3)).toContain('3/5');
  });
});

describe('encodeContext / decodeContext', () => {
  test('round-trips routing context (with userId)', () => {
    const ctx = { channel: 'C9', sessionId: 'abc', threadTs: '123.45', userId: 'U7' };
    expect(decodeContext(encodeContext(ctx))).toEqual(ctx);
  });

  test('round-trips routing context (slash-command shape, no sessionId)', () => {
    const ctx = { channel: 'C9', sessionId: '', threadTs: undefined, userId: 'U7' };
    expect(decodeContext(encodeContext(ctx))).toEqual(ctx);
  });

  test('returns null on invalid input', () => {
    expect(decodeContext(undefined)).toBeNull();
    expect(decodeContext('not json')).toBeNull();
    expect(decodeContext('{}')).toBeNull();
  });
});
