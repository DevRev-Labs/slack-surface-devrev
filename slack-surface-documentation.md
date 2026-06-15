---
title: Slack Surface
description: Connect a Slack workspace to a DevRev AI Agent so users can chat with the agent from Slack channels, threads, and direct messages.
---

# Slack Surface

The **Slack Surface** snap-in connects a Slack workspace to a DevRev AI Agent. After activation, users mention the bot in a channel, reply in a thread, or send a direct message, and the AI Agent answers in the same Slack thread. The snap-in maps each Slack user to their DevRev identity by email, runs the AI Agent on that user's behalf, and persists the conversation as a DevRev `conversation` object so the timeline and the chat stay in sync.

## Table of contents

- [What this snap-in does](#what-this-snap-in-does)
- [End-to-end flow diagram](#end-to-end-flow-diagram)
- [External configuration (Slack App)](#external-configuration-slack-app)
- [Set up and deploy steps](#set-up-and-deploy-steps)
- [Configuration in DevRev](#configuration-in-devrev)
- [How to use the snap-in](#how-to-use-the-snap-in)
- [Result](#result)
- [Verifying the result](#verifying-the-result)
- [Limitations](#limitations)

## What this snap-in does

- Forwards Slack `app_mention` and direct-message events to the configured DevRev AI Agent.
- Replies in the same Slack thread with the agent's answer, and shows progress while the agent works.
- Mirrors every user message and every agent reply onto a DevRev `conversation` so the conversation is searchable inside DevRev.
- Resolves the Slack sender to a DevRev user by email and runs the agent on that user's behalf (act-as token), so the agent answers with that user's permissions.
- Provides a `/sda-agent-feedback` slash command that opens a private modal for rating and comments at the end of a conversation.
- Garbage-collects idle sessions automatically after a configurable timeout.

## End-to-end flow diagram

The chain is a horizontal loop. The DevRev snap-in is the first block: on activation it issues a webhook URL that is registered into a Slack App, which lives inside a Slack workspace. User events flow back the other way — the workspace delivers them to the Slack App, which forwards them to the snap-in's webhook in DevRev.

```
              ──────────── Agent response ────────────►
┌────────────────────┐       ┌────────────────────┐       ┌────────────────────┐
│   DevRev snap-in   │       │     Slack App      │       │  Slack workspace   │
│ (Slack Surface +   │──────►│  (api.slack.com:   │──────►│ (channels + DMs +  │
│  AI Agent +        │       │   scopes, slash,   │       │  slash command +   │
│  conversations)    │◄──────│   interactivity)   │◄──────│  buttons + modals) │
└────────────────────┘       └────────────────────┘       └────────────────────┘
              ◄──────────────── User query ────────────
```

### What each arrow means

- **User query (bottom, right-to-left arrows):** a Slack user `@mentions` the bot, sends a direct message, invokes `/sda-agent-feedback`, clicks a button, or submits a modal. The Slack App receives the interaction and forwards it to the snap-in's webhook in DevRev.
- **Agent response (top, left-to-right arrows):** the snap-in resolves the Slack user to a DevRev user, invokes the DevRev AI Agent, persists the conversation, and delivers the agent's response back through the Slack App into the originating Slack thread.

### Step-by-step

1. **Deploy the snap-in.** Activating the snap-in in DevRev produces a webhook URL the platform issues for this installation.
2. **Register the Slack App.** On api.slack.com/apps you create the app, configure bot token scopes (privileges), register the `/sda-agent-feedback` slash command, toggle Interactivity on, and paste the webhook URL into all three Request-URL fields (Event Subscriptions, Slash Commands, Interactivity & Shortcuts).
3. **Install the app to your workspace.** Slack issues an `xoxb-` Bot User OAuth Token. The user can now `@`-mention the bot, send DMs, run the slash command, and click buttons.
4. **Slack delivers events.** Every user action — `app_mention`, `message.im`, `/sda-agent-feedback`, button click, modal submit — is POSTed to the registered Request URL.
5. **The snap-in answers.** It verifies the Slack HMAC-SHA256 signature, resolves the Slack sender's email to a DevRev user, mints an impersonated (`act-as`) token, posts a "Searching…" placeholder, calls the AI Agent asynchronously, mirrors the exchange onto a DevRev `conversation`, and replaces the placeholder in-place with the final answer when the agent responds.

## External configuration (Slack App)

The snap-in receives every Slack event — bot mentions, direct messages, slash commands, and modal submissions — at one webhook URL that DevRev issues during activation. You wire that URL into Slack from three places: **Event Subscriptions**, **Slash Commands**, and **Interactivity & Shortcuts**.

1. **Register the Slack App.**
   a. Go to **api.slack.com/apps**.
   b. Click **Create New App** > **From scratch**.
   c. Name the app and select the target workspace.
2. **Configure bot token scopes (privileges)** under **OAuth & Permissions**:
   - `chat:write` — send and update messages, and post ephemeral feedback confirmations.
   - `users:read` — look up Slack user metadata for log and audit lines.
   - `users:read.email` — read the Slack user's email so it can be matched to a DevRev user.
   - `app_mentions:read` — receive `app_mention` events when the bot is `@`-mentioned in a channel.
   - `commands` — register and receive slash-command invocations (`/sda-agent-feedback`).
   - `im:history` — optional, required only if you also subscribe to `message.im` for DM support.
3. **Install the Slack App to the workspace** from the **Install App** page, and copy the **Bot User OAuth Token** (starts with `xoxb-`). This token is supplied to the snap-in during DevRev configuration.
4. **Capture the Signing Secret.** Open **Basic Information** and copy the **Signing Secret**. The snap-in uses this shared key to verify that incoming requests actually came from Slack.
5. **Subscribe to Slack events.**
   a. Go to **Event Subscriptions** and toggle **Enable Events** on.
   b. The **Request URL** field stays empty for now — paste the snap-in's webhook URL here after activation.
   c. Under **Subscribe to bot events**, add `app_mention` (required), and optionally add `message.im` to enable direct messages.
   d. Click **Save Changes**.
6. **Register the slash command.**
   a. Go to **Slash Commands** > **Create New Command**.
   b. Set **Command** to `/sda-agent-feedback`, **Short Description** to `Share feedback on the SDA Agent conversation`. Leave **Request URL** blank for now.
   c. Click **Save**.
7. **Toggle Interactivity on.**
   a. Go to **Interactivity & Shortcuts** and toggle **Interactivity** on.
   b. Leave the **Request URL** blank for now — the same webhook URL is pasted here after activation.
   c. Click **Save Changes**.

Steps 5, 6, and 7 all use the **same webhook URL** that DevRev issues during snap-in activation; come back to these three pages after activation to paste the URL.

## Set up and deploy steps

1. Install the **Slack Surface** snap-in from the DevRev marketplace.
2. Open the snap-in in DevRev and provide the inputs documented in [Configuration in DevRev](#configuration-in-devrev).
3. Click **Activate** on the snap-in.
4. Once the snap-in's state is **active**, open its setup instructions and copy the **Slack Events Webhook URL**.
5. Paste the same webhook URL into all three of the Slack-app pages set up earlier:
   a. **Event Subscriptions** > **Request URL** — Slack auto-verifies the URL with a one-time challenge. Click **Save Changes**.
   b. **Slash Commands** > edit `/sda-agent-feedback` > **Request URL** — paste the same URL. Click **Save**.
   c. **Interactivity & Shortcuts** > **Request URL** — paste the same URL. Click **Save Changes**.
6. If Slack prompts **Reinstall Required**, click it once and re-authorize the OAuth scopes so the new request URLs and command privileges take effect.

The same webhook URL is used everywhere — for events, slash commands, and interactivity — so a single deploy covers the whole snap-in.

## Configuration in DevRev

1. In DevRev, go to **Settings** > **Snap-ins** and locate the **Slack Surface** installation.
2. Provide the snap-in inputs:
   - **AI Agent ID** (required) — the DON of the DevRev AI Agent that answers Slack messages, for example `don:core:dvrv-us-1:devo/<org>:ai_agent/<id>`.
   - **Slack Bot Token** (required) — the `xoxb-` token from step 3 of External configuration.
   - **Slack Signing Secret** (required) — the signing secret from step 4 of External configuration.
   - **Mock Email Address (Testing)** (optional) — overrides the Slack sender's email with a fixed DevRev address for QA. Leave blank in production.
   - **Session idle timeout (minutes)** (optional, default 480) — minutes of inactivity before a session is marked idle-expired.
   - **Session absolute timeout (hours)** (optional, default 24) — maximum lifetime of a session regardless of activity.

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
