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

---

## Part 1 — Slack App Setup

### Step 1: Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Name your app (e.g., "DevRev AI Bot") and select your workspace

### Step 2: Configure Bot Permissions

Go to **OAuth & Permissions** and add these Bot Token Scopes:

| Scope | Purpose |
|-------|---------|
| `chat:write` | Send and update messages |
| `users:read` | Get user info |
| `users:read.email` | Access user email addresses for DevRev mapping |
| `app_mentions:read` | Receive @mentions |

### Step 3: Enable Event Subscriptions

1. Go to **Event Subscriptions** and toggle **Enable Events**
2. You will set the Request URL after deploying the snap-in (Step 6 below)
3. Subscribe to bot events:
   - `app_mention` — required, triggers the bot when mentioned
   - `message.im` — optional, enables direct messages to the bot

### Step 4: Install App to Workspace

1. Go to **Install App** in the sidebar
2. Click **Install to Workspace** and authorize
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`) — you will need this later

### Step 5: Get the Signing Secret

1. Go to **Basic Information** in the sidebar
2. Under **App Credentials**, copy the **Signing Secret**

---

## Part 2 — DevRev Snap-in Deployment

### Step 6: Deploy the Snap-in

```bash
# Install dependencies
cd code && npm install

# Build and package
npm run package

# Deploy to DevRev (replace <version-id> with the current latest version DON)
cd .. && devrev snap_in_version upgrade <version-id> --force --manifest manifest.yaml --archive code/build.tar.gz

# Wait for state = ready, then create a draft snap-in
devrev snap_in draft --snap_in_version <new-version-id>
```

### Step 7: Configure the Snap-in

Go to **DevRev Settings → Snap-ins** and find the newly created snap-in. Set:

| Input | Required | Value |
|-------|----------|-------|
| **AI Agent ID** | Yes | Your DevRev AI Agent DON (e.g., `don:core:dvrv-us-1:devo/xxx:ai_agent/yyy`) |
| **Slack Bot Token** | Yes | The `xoxb-...` token from Step 4 |
| **Slack Signing Secret** | Yes | The signing secret from Step 5 |
| **Mock Email Address** | No | Optional — see Testing section below |

### Step 8: Set the Webhook URL in Slack

1. After activating the snap-in, copy the **Slack Events Webhook URL** from the snap-in's setup instructions
2. Go back to your Slack App → **Event Subscriptions**
3. Paste the URL into the **Request URL** field — Slack will verify it automatically
4. Click **Save Changes**

### Step 9: Activate

Click **Activate** on the snap-in. The bot is now live.

---

## Configuration Reference

| Input | Required | Description |
|-------|----------|-------------|
| `ai_agent_id` | Yes | The DevRev AI Agent ID to process messages |
| `slack_bot_token` | Yes | Slack Bot User OAuth Token (stored as keyring secret) |
| `slack_signing_secret` | Yes | Slack Signing Secret (stored as keyring secret) |
| `mock_email_address` | No | If you have a DevRev email ID which you wish to mock in any surface, enter it here. If it is a valid email address, it will appear as if messages are coming from you regardless of who sends in Slack. If not present or invalid format, this is ignored. |

---

## Mock Email Address — Behavior Matrix

| Config Email | Slack User | Result |
|---|---|---|
| Valid DevRev email (e.g. `vijay@devrev.ai`) | Any | ✅ Mock used — AI runs as the configured user |
| Non-DevRev email (e.g. `vijay@gmail.com`) | Any | ❌ Not authorized — bot replies with generic error |
| Invalid format (e.g. `notanemail`) | Any | ❌ Config error — bot replies with generic error, no fallback |
| Not set (blank) | DevRev user | ✅ Real Slack email lookup — AI runs as that Slack user |
| Not set (blank) | Non-DevRev user | ❌ Not authorized — bot replies with generic error |
| Not set (blank) | Slack API lookup fails | ⚠️ Falls back to service account token, AI still runs |

---

## How Email Lookup Works

1. **Get email from Slack** — The Slack user ID from the incoming event is passed to the `users.info` API using the bot token to retrieve the user's email address.
2. **Look up in DevRev** — That email is searched in your DevRev org via `devUsersList`. If no match, the request is rejected.
3. **Get act-as token** — If the user exists, an impersonation token is created so the AI Agent runs with that user's permissions.
4. **Fallback** — If act-as token creation fails (e.g. scope not yet granted), the service account token is used instead.

With **mock email** configured, step 1 is skipped entirely and the mock email goes straight to step 2.

---

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

---

## Logging

View logs in DevRev → Settings → Snap-ins → Logs (or via `devrev snap_in_package logs`).

| Log Tag | Description |
|---------|-------------|
| `[MSG]` | Incoming message details (user, channel, text) |
| `[AUTH]` | Email resolution, DevRev user lookup, token type selected (act-as PAT vs service account) |
| `[CONV]` | DevRev conversation creation and session object |
| `[AI]` | Message sent to AI Agent, agent ID, token type used |
| `[AI_RESP]` | AI Agent response received, formatted, sent to Slack |
| `[TIMELINE]` | Timeline entry fallback path (when ai_agent_response event is missing) |
| `[STORE]` | Conversation reference storage and retrieval |

---

## Troubleshooting

### Bot not responding in Slack
- Verify the Event Subscriptions URL is correct and verified in Slack App settings
- Check that the snap-in is in **Active** state
- Ensure the bot has been added to the channel
- Check snap-in logs for errors

### AI Agent not processing messages
- Verify the AI Agent ID is correct and the agent is active
- Check logs for `[AI]` tag errors

### Org queries returning no data (e.g. "list all users")
- Ensure the AI Agent has NLToSQL or HybridSearch skills enabled
- Verify the snap-in service account has sufficient permissions in the org

### User not being recognized / bot says something went wrong
- Ensure the Slack user's email matches their DevRev account email
- Verify the bot has `users:read.email` permission in Slack
- Check logs for `[AUTH]` tag details

### Mock email showing generic error
- Check logs — if `[CONFIG]` error appears, the `mock_email_address` has invalid format
- Fix or clear the value in snap-in settings and reactivate

### Response not sent back to Slack
- Verify the Slack Bot Token is valid
- Check that the bot has `chat:write` permission
- Ensure the bot is a member of the channel
