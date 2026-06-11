/**
 * Tests for postTimelineComment — the thin wrapper around DevRev's
 * /timeline-entries.create endpoint.
 *
 * Behavior contract:
 *  - Returns the new entry id on success.
 *  - Returns null when any required arg is missing (defensive guard).
 *  - Returns null on axios failure (best-effort — must NEVER throw, since
 *    a timeline failure is not allowed to block the actual Slack reply).
 *  - Passes externalRef through when supplied.
 */

import axios from 'axios';

import { postTimelineComment } from '../timeline';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('postTimelineComment', () => {
  const baseArgs = {
    body: 'hello there',
    conversationId: 'don:core:dvrv-us-1:devo/abc:conversation/123',
    devrevEndpoint: 'https://api.devrev.ai',
    token: 'service-token',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the timeline entry id on a successful create', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { timeline_entry: { id: 'don:core:dvrv-us-1:devo/abc:timeline_entry/te1' } },
    });

    const id = await postTimelineComment(baseArgs);
    expect(id).toBe('don:core:dvrv-us-1:devo/abc:timeline_entry/te1');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.devrev.ai/timeline-entries.create',
      expect.objectContaining({
        body: 'hello there',
        body_type: 'text',
        object: baseArgs.conversationId,
        type: 'timeline_comment',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer service-token' }),
      })
    );
  });

  it('attaches external_ref when supplied so DevRev can dedup', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { timeline_entry: { id: 'te2' } } });
    await postTimelineComment({ ...baseArgs, externalRef: 'slack-msg-T1.001' });
    expect(mockedAxios.post.mock.calls).toHaveLength(1);
    const sentPayload = mockedAxios.post.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sentPayload['external_ref']).toBe('slack-msg-T1.001');
  });

  it('omits external_ref when not supplied', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { timeline_entry: { id: 'te3' } } });
    await postTimelineComment(baseArgs);
    expect(mockedAxios.post.mock.calls).toHaveLength(1);
    const sentPayload = mockedAxios.post.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sentPayload['external_ref']).toBeUndefined();
  });

  it('returns null when devrevEndpoint is missing', async () => {
    expect(await postTimelineComment({ ...baseArgs, devrevEndpoint: '' })).toBeNull();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('returns null when token is missing', async () => {
    expect(await postTimelineComment({ ...baseArgs, token: '' })).toBeNull();
  });

  it('returns null when conversationId is missing', async () => {
    expect(await postTimelineComment({ ...baseArgs, conversationId: '' })).toBeNull();
  });

  it('returns null when body is empty', async () => {
    expect(await postTimelineComment({ ...baseArgs, body: '' })).toBeNull();
  });

  it('returns null and warns on axios failure (best-effort, never throws)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockedAxios.post.mockRejectedValueOnce({
      message: 'connection refused',
      response: { data: { error: 'unauthorized' }, status: 401 },
    });

    const result = await postTimelineComment(baseArgs);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns null when the response shape lacks timeline_entry.id', async () => {
    // DevRev sometimes returns a 200 with a slightly different envelope on
    // dedup hits — guard against accidentally returning undefined.
    mockedAxios.post.mockResolvedValueOnce({ data: {} });
    expect(await postTimelineComment(baseArgs)).toBeNull();
  });

  it('does not throw if the underlying axios error has no .response', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockedAxios.post.mockRejectedValueOnce(new Error('socket hang up'));
    const result = await postTimelineComment(baseArgs);
    expect(result).toBeNull();
    warnSpy.mockRestore();
  });
});
