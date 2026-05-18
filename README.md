# Slack AI Integration Snap-in

A DevRev snap-in that integrates Slack with DevRev AI Agents. Receive messages from Slack, process them through AI Agents, and send intelligent responses back to your workspace.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│     Slack       │     │   DevRev        │     │   AI Agents     │
│   Workspace     │────>│   Snap-in       │────>│   API           │
│                 │     │                 │     │                 │
│                 │<────│                 │<────│                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

1. User mentions the bot in Slack (e.g., `@DevRev Bot what's the status of my ticket?`)
2. Snap-in receives the message via Slack Events API webhook
3. Snap-in sends a "Searching..." message and forwards the query to AI Agents
4. AI Agent processes the request asynchronously
5. Progress updates are shown as the AI works (Analyzing, Processing, etc.)
6. Final response is sent back to the Slack thread

## Features

- **User Impersonation**: Maps Slack users to DevRev users by email for personalized responses
- **Progress Updates**: Shows real-time progress as the AI Agent works
- **Thread Support**: Maintains conversation context within Slack threads
- **Clean UX**: Temporary messages are deleted when final response arrives
- **Mock Email (Testing)**: Override the sender identity for testing without a real Slack account

## Prerequisites

- DevRev organization with an AI Agent configured
- Slack workspace with admin access to create apps

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Name your app (e.g., "DevRev AI Bot") and select your workspace

### 2. Configure Bot Permissions

Go to **OAuth & Permissions** and add these Bot Token Scopes:
- `chat:write` - Send messages
- `users:read` - Get user info
- `users:read.email` - Access user email addresses
- `app_mentions:read` - Receive @mentions

### 3. Enable Event Subscriptions

1. Go to **Event Subscriptions** and toggle **Enable Events**
2. You'll set the Request URL after deploying the snap-in
3. Subscribe to bot events:
   - `app_mention` (required)
   - `message.im` (optional, for direct messages)

### 4. Install and Configure in DevRev

1. Go to DevRev Settings → Snap-ins
2. Find "Slack AI Integration" and click Install
3. Configure the required inputs:
   - **AI Agent ID**: Your DevRev AI Agent ID (e.g., `don:core:dvrv-us-1:devo/xxx:ai_agent/yyy`)
   - **Slack Bot Token**: The Bot User OAuth Token (starts with `xoxb-`)
   - **Slack Signing Secret**: From your Slack App's Basic Information page
4. Copy the **Slack Events Webhook URL** from the setup instructions
5. In Slack App settings, set this URL as the Event Subscriptions Request URL
6. Activate the snap-in

### 5. Install App to Slack Workspace

1. In your Slack App settings, go to **Install App**
2. Click **Install to Workspace**
3. You can now mention the bot in any channel!

## Configuration

| Input | Required | Description |
|-------|----------|-------------|
| `ai_agent_id` | Yes | The DevRev AI Agent ID to process messages |
| `slack_bot_token` | Yes | Slack Bot User OAuth Token (stored as keyring) |
| `slack_signing_secret` | Yes | Slack Signing Secret (stored as keyring) |
| `mock_email_address` | No | If you have a DevRev email ID which you wish to mock in any surface, enter it here. If it is a valid email address, it will appear as if messages are coming from you regardless of who sends in Slack. If not present or invalid format, this is ignored. |

## Mock Email Address — Behavior Matrix

| Config Email | Slack User | Result |
|---|---|---|
| Valid DevRev email (e.g. `vijay@devrev.ai`) | Any | ✅ Mock used — AI runs as the configured user |
| Non-DevRev email (e.g. `vijay@gmail.com`) | Any | ❌ User not found in DevRev org — request rejected with error message |
| Invalid format (e.g. `notanemail`) | Any | ❌ Config error — bot replies immediately with format error, no fallback |
| Not set (blank) | DevRev user | ✅ Real Slack email lookup — AI runs as that Slack user |
| Not set (blank) | Non-DevRev user | ❌ User not found in DevRev org — request rejected with error message |
| Not set (blank) | Slack API lookup fails | ⚠️ Falls back to service account token, AI still runs |

## How Email Lookup Works

1. **Get email from Slack** — The Slack user ID from the incoming event is passed to `users.info` API using the bot token to retrieve the user's email address.
2. **Look up in DevRev** — That email is searched in your DevRev org via `devUsersList`. If no match, the request is rejected.
3. **Get act-as token** — If the user exists, an impersonation token is created so the AI Agent runs with that user's permissions.
4. **Fallback** — If act-as token creation fails (e.g. scope not yet granted), the service account token is used instead.

With **mock email** configured, step 1 is skipped entirely and the mock email goes straight to step 2.

## Event Sources

| Source | Description |
|--------|-------------|
| `slack-webhook-source` | Receives events from Slack Events API |
| `ai-agent-events` | Receives async AI Agent responses and timeline entries |

## Functions

| Function | Description |
|----------|-------------|
| `slack_handler` | Processes incoming Slack messages, creates DevRev conversation, calls AI Agent |
| `ai_response_handler` | Receives AI responses and timeline entries, formats and sends back to Slack |

## Logging

The snap-in emits structured logs at each key step. View them in DevRev → Settings → Snap-ins → Logs.

| Log Tag | Description |
|---------|-------------|
| `[MSG]` | Incoming message details (user, channel, text) |
| `[AUTH]` | Email resolution, DevRev user lookup, token type selected (act-as PAT vs service account) |
| `[CONV]` | DevRev conversation creation and session object |
| `[AI]` | Message sent to AI Agent, agent ID, token type used |
| `[AI_RESP]` | AI Agent response received, formatted, sent to Slack |
| `[TIMELINE]` | Timeline entry fallback path (when ai_agent_response event is missing) |
| `[STORE]` | Conversation reference storage and retrieval |

## Troubleshooting

### Bot not responding in Slack
- Verify the Event Subscriptions URL is correct and verified
- Check that the snap-in is in "Active" state
- Ensure the bot has been added to the channel
- Look at snap-in logs in DevRev for errors

### AI Agent not processing messages
- Verify the AI Agent ID is correct
- Check that the AI Agent is active and configured
- Look for errors in the snap-in logs

### Org queries returning no data (e.g. "list all users")
- Ensure the AI Agent has NLToSQL or HybridSearch skills enabled
- Verify the snap-in service account has sufficient permissions in the org
- Check that the DevRev org has data to query

### User not being recognized
- Ensure the Slack user's email matches their DevRev account email
- Verify the bot has `users:read.email` permission
- Check that the DevRev user exists and is active

### Mock email configuration error
- If the bot replies with a config error message, the `mock_email_address` field contains an invalid email format
- Fix or clear the value in snap-in settings

### Response not sent back to Slack
- Verify the Slack Bot Token is valid
- Check that the bot has `chat:write` permission
- Ensure the bot is a member of the channel
