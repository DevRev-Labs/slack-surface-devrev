import axios from 'axios';
import { deleteMessage, getUserProfile, removeBotMention, sendMessage, updateMessage } from '../slack-client';

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
});
