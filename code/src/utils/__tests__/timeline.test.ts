/**
 * Unit tests for the timeline helper (src/utils/timeline.ts).
 *
 * Tests cover:
 *   - Successful creation returns the new timeline entry ID.
 *   - Optional externalRef is included when provided.
 *   - Returns null when any required argument is missing.
 *   - Returns null (and does NOT throw) when the API call fails.
 *   - Correct HTTP headers and payload shape are sent.
 */

import axios from 'axios';
import { postTimelineComment } from '../timeline';

// Mock axios so no real HTTP requests are made.
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const BASE_ARGS = {
  body: 'User said: hello',
  conversationId: 'don:core:dvrv-us-1:devo/x:conversation/123',
  devrevEndpoint: 'https://api.devrev.ai',
  token: 'svc-token',
};

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('postTimelineComment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the new timeline entry ID on success', async () => {
    // Arrange: API returns a valid timeline entry.
    mockedAxios.post.mockResolvedValueOnce({
      data: { timeline_entry: { id: 'ti-001' } },
    });

    // Act
    const result = await postTimelineComment(BASE_ARGS);

    // Assert
    expect(result).toBe('ti-001');
  });

  it('sends correct URL, headers, and base payload', async () => {
    // Arrange
    mockedAxios.post.mockResolvedValueOnce({
      data: { timeline_entry: { id: 'ti-002' } },
    });

    // Act
    await postTimelineComment(BASE_ARGS);

    // Assert: one call was made to the expected endpoint.
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, payload, options] = mockedAxios.post.mock.calls[0];

    expect(url).toBe('https://api.devrev.ai/timeline-entries.create');
    expect(payload).toMatchObject({
      body: BASE_ARGS.body,
      body_type: 'text',
      object: BASE_ARGS.conversationId,
      type: 'timeline_comment',
    });
    expect(options).toMatchObject({
      headers: {
        Authorization: `Bearer ${BASE_ARGS.token}`,
        'Content-Type': 'application/json',
      },
    });
  });

  it('includes external_ref in the payload when provided', async () => {
    // Arrange
    mockedAxios.post.mockResolvedValueOnce({
      data: { timeline_entry: { id: 'ti-003' } },
    });

    // Act
    await postTimelineComment({ ...BASE_ARGS, externalRef: 'slack-user-ts-1234' });

    // Assert: external_ref key is present.
    const payload = mockedAxios.post.mock.calls[0][1] as Record<string, unknown>;
    expect(payload['external_ref']).toBe('slack-user-ts-1234');
  });

  it('omits external_ref from the payload when not provided', async () => {
    // Arrange: no externalRef passed.
    mockedAxios.post.mockResolvedValueOnce({
      data: { timeline_entry: { id: 'ti-004' } },
    });

    // Act
    await postTimelineComment(BASE_ARGS);

    // Assert: external_ref key is absent.
    const payload = mockedAxios.post.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('external_ref');
  });

  it('returns null without calling the API when devrevEndpoint is empty', async () => {
    const result = await postTimelineComment({ ...BASE_ARGS, devrevEndpoint: '' });
    expect(result).toBeNull();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('returns null without calling the API when token is empty', async () => {
    const result = await postTimelineComment({ ...BASE_ARGS, token: '' });
    expect(result).toBeNull();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('returns null without calling the API when conversationId is empty', async () => {
    const result = await postTimelineComment({ ...BASE_ARGS, conversationId: '' });
    expect(result).toBeNull();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('returns null without calling the API when body is empty', async () => {
    const result = await postTimelineComment({ ...BASE_ARGS, body: '' });
    expect(result).toBeNull();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('returns null (does not throw) when the API call rejects', async () => {
    // Arrange: API fails.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockedAxios.post.mockRejectedValueOnce({ response: { data: 'error', status: 500 } });

    // Act: must not throw.
    const result = await postTimelineComment(BASE_ARGS);

    // Assert
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('returns null when API response has no timeline_entry.id', async () => {
    // Arrange: success response but no id field.
    mockedAxios.post.mockResolvedValueOnce({ data: {} });
    const result = await postTimelineComment(BASE_ARGS);
    expect(result).toBeNull();
  });
});
