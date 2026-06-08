import {
  ACTION_DISMISS_FEEDBACK_PROMPT,
  ACTION_OPEN_FEEDBACK,
  buildFeedbackConfirmationBlocks,
  buildFeedbackModal,
  buildFeedbackPromptBlocks,
  decodeContext,
  encodeContext,
  FEEDBACK_ACTION_RATING,
  FEEDBACK_ACTION_TEXT,
  FEEDBACK_BLOCK_RATING,
  FEEDBACK_BLOCK_TEXT,
  FEEDBACK_VIEW_CALLBACK,
  feedbackConfirmationFallbackText,
  isFeedbackIntent,
} from '../feedback';

describe('isFeedbackIntent', () => {
  test.each([
    'I want to give a feedback',
    'i want to give feedback',
    'I want to give a feedback...',
    'I would like to give feedback',
    'give feedback',
    '  Submit   feedback  ',
  ])('matches "%s"', (input) => {
    expect(isFeedbackIntent(input)).toBe(true);
  });

  test.each([
    '',
    'how do I export my data?',
    'feedback loop is broken',
    '/clear',
    'thanks for the feedback you gave me',
  ])('does not match "%s"', (input) => {
    expect(isFeedbackIntent(input)).toBe(false);
  });
});

describe('buildFeedbackPromptBlocks', () => {
  test('emits a section + actions block with open and dismiss buttons carrying ctx', () => {
    const blocks = buildFeedbackPromptBlocks({
      sessionId: 's-1',
      channel: 'C1',
      threadTs: 't-1',
      userId: 'U1',
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('section');
    expect(blocks[1].type).toBe('actions');
    const ids = blocks[1].elements.map((e: any) => e.action_id);
    expect(ids).toEqual([ACTION_OPEN_FEEDBACK, ACTION_DISMISS_FEEDBACK_PROMPT]);
    const openBtn = blocks[1].elements[0];
    const decoded = decodeContext(openBtn.value);
    expect(decoded).toEqual({
      sessionId: 's-1',
      channel: 'C1',
      threadTs: 't-1',
      userId: 'U1',
    });
  });
});

describe('buildFeedbackModal', () => {
  test('contains a 1-5 static_select and a multiline plain_text_input', () => {
    const view = buildFeedbackModal({ sessionId: 's-2', channel: 'C2' });
    expect(view.type).toBe('modal');
    expect(view.callback_id).toBe(FEEDBACK_VIEW_CALLBACK);
    expect(view.submit?.text).toBe('Submit');
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

describe('confirmation blocks', () => {
  test('include star rating and comment quote', () => {
    const text = buildFeedbackConfirmationBlocks(4, 'great help')[0].text.text;
    expect(text).toContain('★★★★☆');
    expect(text).toContain('4/5');
    expect(text).toContain('great help');
  });

  test('omit comment line when empty', () => {
    const text = buildFeedbackConfirmationBlocks(5, '   ')[0].text.text;
    expect(text).toContain('★★★★★');
    expect(text).not.toContain('>');
  });

  test('fallback text references the rating', () => {
    expect(feedbackConfirmationFallbackText(3)).toContain('3/5');
  });
});

describe('encodeContext / decodeContext', () => {
  test('round-trips routing context (with userId)', () => {
    const ctx = { sessionId: 'abc', channel: 'C9', threadTs: '123.45', userId: 'U7' };
    expect(decodeContext(encodeContext(ctx))).toEqual(ctx);
  });

  test('round-trips routing context (slash-command shape, no sessionId)', () => {
    const ctx = { sessionId: '', channel: 'C9', threadTs: undefined, userId: 'U7' };
    expect(decodeContext(encodeContext(ctx))).toEqual(ctx);
  });

  test('returns null on invalid input', () => {
    expect(decodeContext(undefined)).toBeNull();
    expect(decodeContext('not json')).toBeNull();
    expect(decodeContext('{}')).toBeNull();
  });
});
