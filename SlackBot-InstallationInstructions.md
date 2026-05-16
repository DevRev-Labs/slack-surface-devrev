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
6. Final response replaces the temporary message in Slack

## Features

- **User Impersonation**: Maps Slack users to DevRev users by email for personalized responses
- **Progress Updates**: Shows real-time progress as the AI Agent works
- **Thread Support**: Maintains conversation context within Slack threads
- **Clean UX**: Temporary messages are deleted when final response arrives

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

| Input | Description |
|-------|-------------|
| `ai_agent_id` | The DevRev AI Agent ID to process messages |
| `slack_bot_token` | Slack Bot User OAuth Token (stored as keyring) |
| `slack_signing_secret` | Slack Signing Secret (stored as keyring) |

## Event Sources

| Source | Description |
|--------|-------------|
| `slack-webhook-source` | Receives events from Slack Events API |
| `ai-agent-events` | Receives async responses from AI Agents |

## Functions

| Function | Description |
|----------|-------------|
| `slack_handler` | Processes incoming Slack messages, forwards to AI Agent |
| `ai_response_handler` | Receives AI responses, sends back to Slack |

## User Mapping

The snap-in automatically maps Slack users to DevRev users:

1. When a message is received, the snap-in fetches the user's email from Slack
2. It looks up the corresponding DevRev user by email
3. An impersonation token is created for that user
4. The AI Agent executes with the user's permissions

This enables personalized responses based on the user's permissions from source systems.

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

### User not being recognized
- Ensure the Slack user's email matches their DevRev account email
- Verify the bot has `users:read.email` permission
- Check that the DevRev user exists and is active

### Response not sent back to Slack
- Verify the Slack Bot Token is valid
- Check that the bot has `chat:write` permission
- Ensure the bot is a member of the channel

