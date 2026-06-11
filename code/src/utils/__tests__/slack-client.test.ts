import axios from 'axios';
import {
  deleteMessage,
  getChannelName,
  getUserProfile,
  openView,
  postEphemeral,
  removeBotMention,
  sendBlocksMessage,
  sendMessage,
  updateMessage,
  updateView,
} from '../slack-client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('slack-client', () => {
  const botToken = 'xoxb-test-token';
  const channel = 'C0123456789';
  const ts = '1705315800.000100';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('sendMessage', () => {
    it('should send a message and return timestamp', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { ok: true, ts: '1705315801.000200' },
      });

      const result = await sendMessage(channel, 'Hello', botToken);
      expect(result).toBe('1705315801.000200');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://slack.com/api/chat.postMessage',
        { channel, text: 'Hello' },
        expect.objectContaining({
          headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
        })
      );
    });

    it('should include thread_ts when provided', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { ok: true, ts: '1705315801.000200' },
      });

      await sendMessage(channel, 'Reply', botToken, ts);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://slack.com/api/chat.postMessage',
        { channel, text: 'Reply', thread_ts: ts },
        expect.any(Object)
      );
    });

    it('should throw error when Slack API returns error', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { error: 'channel_not_found', ok: false },
      });

      await expect(sendMessage(channel, 'Hello', botToken)).rejects.toThrow('Slack API error: channel_not_found');
    });
  });

  describe('updateMessage', () => {
    it('should update a message', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { ok: true },
      });

      await updateMessage(channel, ts, 'Updated text', botToken);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://slack.com/api/chat.update',
        { channel, text: 'Updated text', ts },
        expect.objectContaining({
          headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
        })
      );
    });

    it('should throw error when update fails', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { error: 'message_not_found', ok: false },
      });

      await expect(updateMessage(channel, ts, 'Updated', botToken)).rejects.toThrow(
        'Slack API error: message_not_found'
      );
    });
  });

  describe('deleteMessage', () => {
    it('should delete a message', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { ok: true },
      });

      await deleteMessage(channel, ts, botToken);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://slack.com/api/chat.delete',
        { channel, ts },
        expect.objectContaining({
          headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
        })
      );
    });

    it('should not throw when message is already deleted', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { error: 'message_not_found', ok: false },
      });

      // Should not throw
      await deleteMessage(channel, ts, botToken);
    });
  });

  describe('getUserProfile', () => {
    it('returns email + name when both are present on the user', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          ok: true,
          user: {
            id: 'U0123456789',
            profile: { display_name: 'Test User', email: 'user@example.com' },
          },
        },
      });

      const result = await getUserProfile('U0123456789', botToken);
      expect(result).toEqual({ email: 'user@example.com', name: 'Test User' });
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://slack.com/api/users.info',
        expect.objectContaining({
          headers: { Authorization: `Bearer ${botToken}` },
          params: { user: 'U0123456789' },
        })
      );
    });

    it('returns null email when the profile lacks one', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: { ok: true, user: { id: 'U0123456789', profile: {} } },
      });
      const result = await getUserProfile('U0123456789', botToken);
      expect(result.email).toBeNull();
    });

    it('returns null email on API error', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockedAxios.get.mockResolvedValueOnce({
        data: { error: 'user_not_found', ok: false },
      });
      const result = await getUserProfile('U0123456789', botToken);
      expect(result.email).toBeNull();
      consoleSpy.mockRestore();
    });
  });

  describe('removeBotMention', () => {
    it('should remove bot mention from text', () => {
      const text = '<@U9876543210> hello world';
      const result = removeBotMention(text);
      expect(result).toBe('hello world');
    });

    it('should handle multiple mentions', () => {
      const text = '<@U123> <@U456> hello';
      const result = removeBotMention(text);
      expect(result).toBe('hello');
    });

    it('should handle text without mentions', () => {
      const text = 'hello world';
      const result = removeBotMention(text);
      expect(result).toBe('hello world');
    });

    it('should trim whitespace', () => {
      const text = '  <@U123>  hello  ';
      const result = removeBotMention(text);
      expect(result).toBe('hello');
    });
  });

  describe('sendBlocksMessage', () => {
    const blocks = [{ text: { text: 'hi', type: 'mrkdwn' }, type: 'section' }];

    it('posts blocks + fallback text and returns the message ts', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { ok: true, ts: '1705315900.000100' } });
      const result = await sendBlocksMessage(channel, 'fallback', blocks, botToken);
      expect(result).toBe('1705315900.000100');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://slack.com/api/chat.postMessage',
        { blocks, channel, text: 'fallback' },
        expect.any(Object)
      );
    });

    it('threads the message when threadTs is provided', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { ok: true, ts: '1705315900.000200' } });
      await sendBlocksMessage(channel, 'fallback', blocks, botToken, ts);
      const sentBody = mockedAxios.post.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(sentBody['thread_ts']).toBe(ts);
    });

    it('throws when Slack returns ok=false', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { error: 'invalid_blocks', ok: false } });
      await expect(sendBlocksMessage(channel, 'x', blocks, botToken)).rejects.toThrow(/Failed to send blocks/);
    });

    it('throws on axios rejection (network failure)', async () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockedAxios.post.mockRejectedValueOnce(new Error('socket hang up'));
      await expect(sendBlocksMessage(channel, 'x', blocks, botToken)).rejects.toThrow(/Failed to send blocks/);
      errSpy.mockRestore();
    });
  });

  describe('postEphemeral', () => {
    const user = 'U999';

    it('posts an ephemeral message scoped to the target user', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { ok: true } });
      await postEphemeral(channel, user, 'private', undefined, botToken);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://slack.com/api/chat.postEphemeral',
        { channel, text: 'private', user },
        expect.any(Object)
      );
    });

    it('attaches blocks when provided', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { ok: true } });
      const blocks = [{ text: { text: 'hi', type: 'mrkdwn' }, type: 'section' }];
      await postEphemeral(channel, user, 'private', blocks, botToken);
      const sentBody = mockedAxios.post.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(sentBody['blocks']).toEqual(blocks);
    });

    it('threads when threadTs is provided', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { ok: true } });
      await postEphemeral(channel, user, 'private', undefined, botToken, ts);
      const sentBody = mockedAxios.post.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(sentBody['thread_ts']).toBe(ts);
    });

    it('throws when Slack returns ok=false', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { error: 'channel_not_found', ok: false } });
      await expect(postEphemeral(channel, user, 'x', undefined, botToken)).rejects.toThrow(/ephemeral/);
    });
  });

  describe('openView', () => {
    const view = { callback_id: 'feedback', title: { text: 'Feedback' }, type: 'modal' };

    it('opens a view via views.open and returns the view id', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { ok: true, view: { id: 'V123' } } });
      const id = await openView('trig.123', view, botToken);
      expect(id).toBe('V123');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://slack.com/api/views.open',
        { trigger_id: 'trig.123', view },
        expect.any(Object)
      );
    });

    it('returns empty string when Slack omits view.id', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { ok: true, view: {} } });
      expect(await openView('trig.123', view, botToken)).toBe('');
    });

    it('throws when Slack returns ok=false (e.g. trigger_id expired)', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { error: 'invalid_trigger_id', ok: false } });
      await expect(openView('trig.expired', view, botToken)).rejects.toThrow(/Failed to open Slack view/);
    });

    it('throws on axios rejection', async () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockedAxios.post.mockRejectedValueOnce(new Error('boom'));
      await expect(openView('trig.123', view, botToken)).rejects.toThrow(/Failed to open Slack view/);
      errSpy.mockRestore();
    });
  });

  describe('updateView', () => {
    const view = { type: 'modal' };

    it('updates a modal via views.update', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { ok: true } });
      await expect(updateView('V123', view, botToken)).resolves.toBeUndefined();
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://slack.com/api/views.update',
        { view, view_id: 'V123' },
        expect.any(Object)
      );
    });

    it('throws when Slack returns ok=false', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { error: 'not_found', ok: false } });
      await expect(updateView('V123', view, botToken)).rejects.toThrow(/Failed to update Slack view/);
    });

    it('throws on axios rejection', async () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockedAxios.post.mockRejectedValueOnce(new Error('boom'));
      await expect(updateView('V123', view, botToken)).rejects.toThrow(/Failed to update Slack view/);
      errSpy.mockRestore();
    });
  });

  describe('getChannelName', () => {
    it('returns the channel name on success', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { channel: { name: 'general' }, ok: true } });
      expect(await getChannelName('C1', botToken)).toBe('general');
    });

    it('returns null for an empty channelId without making a request', async () => {
      const result = await getChannelName('', botToken);
      expect(result).toBeNull();
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('returns null when Slack returns ok=false (DMs have no name)', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      mockedAxios.get.mockResolvedValueOnce({ data: { error: 'channel_not_found', ok: false } });
      expect(await getChannelName('C1', botToken)).toBeNull();
      warnSpy.mockRestore();
    });

    it('returns null when channel object lacks a name (DMs)', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { channel: { id: 'D1' }, ok: true } });
      expect(await getChannelName('D1', botToken)).toBeNull();
    });

    it('returns null on axios rejection — best-effort, never throws', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      mockedAxios.get.mockRejectedValueOnce(new Error('network'));
      expect(await getChannelName('C1', botToken)).toBeNull();
      warnSpy.mockRestore();
    });
  });
});
