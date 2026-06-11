---
title: Slack Surface
description: Connect a Slack workspace to a DevRev AI Agent so users can chat with the agent from Slack channels, threads, and direct messages.
---

# Slack Surface

The **Slack Surface** snap-in connects a Slack workspace to a DevRev AI Agent. After activation, users mention the bot in a channel, reply in a thread, or send a direct message, and the AI Agent answers in the same Slack thread. The snap-in maps each Slack user to their DevRev identity by email, runs the AI Agent on that user's behalf, and persists the conversation as a DevRev `conversation` object so the timeline and the chat stay in sync.

## What this snap-in does

- Forwards Slack `app_mention` and direct-message events to the configured DevRev AI Agent.
- Replies in the same Slack thread with the agent's answer, and shows progress while the agent works.
- Mirrors every user message and every agent reply onto a DevRev `conversation` so the conversation is searchable inside DevRev.
- Resolves the Slack sender to a DevRev user by email and runs the agent on that user's behalf (act-as token), so the agent answers with that user's permissions.
- Provides a `/sda-agent-feedback` slash command that opens a private modal for rating and comments at the end of a conversation.
- Garbage-collects idle sessions automatically after a configurable timeout.

## Installation

1. Install the **Slack Surface** snap-in from the DevRev marketplace.
2. Create a Slack App at **api.slack.com/apps**:
   a. Click **Create New App** > **From scratch**.
   b. Name the app and select the target workspace.
3. Configure the bot token scopes under **OAuth & Permissions**:
   - `chat:write` — send and update messages.
   - `users:read` — read user information.
   - `users:read.email` — read user email addresses for DevRev mapping.
   - `app_mentions:read` — receive `@mentions`.
   - `commands` — required for the `/sda-agent-feedback` slash command.
4. Install the Slack App to the workspace from the **Install App** page, and copy the **Bot User OAuth Token** (starts with `xoxb-`).
5. Open **Basic Information** and copy the **Signing Secret**.

The snap-in is now ready to be configured inside DevRev.

## Configuration

1. In DevRev, go to **Settings** > **Snap-ins** and locate the **Slack Surface** installation.
2. Provide the snap-in inputs:
   - **AI Agent ID** (required) — the DON of the DevRev AI Agent that answers Slack messages, for example `don:core:dvrv-us-1:devo/<org>:ai_agent/<id>`.
   - **Slack Bot Token** (required) — the `xoxb-` token from step 4 of Installation.
   - **Slack Signing Secret** (required) — the signing secret from step 5 of Installation.
   - **Mock Email Address (Testing)** (optional) — overrides the Slack sender's email with a fixed DevRev address for QA. Leave blank in production.
   - **Session idle timeout (minutes)** (optional, default 480) — minutes of inactivity before a session is marked idle-expired.
   - **Session absolute timeout (hours)** (optional, default 24) — maximum lifetime of a session regardless of activity.
3. Activate the snap-in. After activation, copy the **Slack Events Webhook URL** that DevRev issues; this URL is used for every Slack callback.
4. In the Slack App, paste the same webhook URL into:
   - **Event Subscriptions** > **Request URL** — and subscribe to the bot event `app_mention`. Optionally add `message.im` to enable direct messages.
   - **Slash Commands** > **Create New Command** — set **Command** to `/sda-agent-feedback` and the **Request URL** to the same webhook URL.
   - **Interactivity & Shortcuts** > toggle **Interactivity** on and paste the same **Request URL**.
5. Reinstall the Slack App to the workspace if Slack prompts to refresh permissions.

The same webhook URL is used everywhere — for events, slash commands, and interactivity — so a single setup covers the whole snap-in.

## How to use the snap-in

1. Invite the Slack bot to a channel by typing `/invite @<bot-name>` in that channel. Direct messages do not need an invite.
2. Mention the bot in a channel to start a new conversation, for example: `@<bot-name> show me my open tickets`.
3. Reply in the resulting thread to continue the same conversation. Threaded replies do not need to mention the bot again.
4. Send the bot a direct message to start a private conversation. Every message in a DM continues the same session until the idle timeout passes.
5. To end a conversation manually and start fresh, send `new session`.
6. To submit feedback on a conversation, run `/sda-agent-feedback` in the same channel or DM. A private modal opens for rating (1-5) and an optional comment.

## Result

After a successful conversation, the following happens:

- The user sees the AI Agent's reply posted in the originating Slack thread, with progress messages while the agent works (for example, "Searching..." or "Analyzing...").
- A DevRev `conversation` object is created (or reused) for the (channel, thread, user) tuple. Every user message and every agent reply is mirrored as a timeline entry on that conversation.
- The conversation is owned by the resolved DevRev user, not the snap-in service account, so the agent's answers reflect that user's permissions.
- Submitted feedback is stored on the same conversation as a rating and a comment, visible in the conversation's custom fields.
- The session expires automatically after the **Session idle timeout** elapses without activity; the conversation is deleted after the **Session absolute timeout** passes.

## Verifying the result

- **In Slack**: confirm that the bot replies in-thread and that progress messages appear and clear correctly. The `/sda-agent-feedback` modal opens within three seconds of the slash-command invocation.
- **In DevRev**: open **Conversations** and find the conversation whose source is **Slack**. The conversation's timeline contains alternating user-message and agent-reply entries that match the Slack thread.
- **Identity check**: the conversation's owner field shows the resolved DevRev user, not the service account. If the field shows the service account, the Slack sender's email could not be resolved to a DevRev user — confirm the email matches a DevRev account and that the Slack App has the `users:read.email` scope.
- **Feedback check**: submit a feedback rating via `/sda-agent-feedback`, then open the same conversation in DevRev and confirm that the **Feedback rating** and **Feedback text** custom fields are populated.

## Limitations

- The Slack Bot must be a member of the channel before it can respond. The bot does not auto-join channels.
- A Slack user without a matching DevRev email is rejected with a generic error message. Mock email is intended for testing only and bypasses this check.
- A Slack message has a 4000-character limit; agent replies longer than this are split into multiple messages.
- Slack rejects messages with more than 50 Block-Kit blocks; very long agent responses are truncated.
- The slash-command modal must open within three seconds of invocation, per Slack's `trigger_id` window. Network latency between DevRev and Slack can cause the modal to fail to open during periods of severe congestion.
- A session is bound to a single (channel, thread, user) tuple. The same user in two threads has two distinct sessions.
- Idle and absolute timeouts apply per session and are configured at the snap-in level, not per user.
