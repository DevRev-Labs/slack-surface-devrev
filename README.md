# Slack Surface Snap-in

A DevRev snap-in that integrates Slack with DevRev AI Agents. Receive messages from Slack, process them through AI Agents, and send intelligent responses back to your workspace.

## Table of Contents

- [What this snap-in does](#what-this-snap-in-does)
- [End-to-end flow diagram](#end-to-end-flow-diagram)
- [External configuration (Slack App)](#external-configuration-slack-app)
- [Set up and deploy steps](#set-up-and-deploy-steps)
  - [Quick deploy with the DevRev CLI](#quick-deploy-with-the-devrev-cli)
  - [Step-by-step deploy](#step-by-step-deploy)
- [Project structure](#project-structure)
- [Dependencies](#dependencies)
- [Configuration reference](#configuration-reference)
- [Configuration via environment variables](#configuration-via-environment-variables)
- [Mock email address — behavior matrix](#mock-email-address--behavior-matrix)
- [How email lookup works](#how-email-lookup-works)
- [Event sources](#event-sources)
- [Functions](#functions)
- [Logging](#logging)
- [Troubleshooting](#troubleshooting)

---

## What this snap-in does

**What it is.** A TypeScript-based DevRev snap-in (server-side function bundle) that bridges a Slack workspace to a DevRev AI Agent. Slack events arrive over the Slack Events API → the snap-in resolves the Slack user to a DevRev user, mints an impersonated (`act-as`) token, and submits the message to the AI Agent. Async AI responses arrive via a DevRev webhook and get rendered back into the originating Slack thread.

**What's included.**
- `slack_handler` — entry point for `app_mention`, DM, and channel messages.
- `ai_response_handler` — receives async AI Agent responses and replies in Slack.
- `slack_interactivity` — slash command (`/sda-agent-feedback`) + modal submissions.
- `session_gc` — cron-driven idle / hard-expiry cleanup.
- `ensure_session_state_schema` — activate-hook that registers the custom-fields schema.

**Features.**
- **User Impersonation**: Maps Slack users to DevRev users by email for personalized responses.
- **Progress Updates**: Shows real-time progress as the AI Agent works.
- **Thread Support**: Maintains conversation context within Slack threads.
- **Clean UX**: Temporary messages are deleted when the final response arrives.
- **Mock Email (Testing)**: Override the sender identity for testing without a real Slack account.

---

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
2. **Register the Slack App.** On api.slack.com/apps you create the app, configure bot token scopes, register the `/sda-agent-feedback` slash command, toggle Interactivity on, and paste the webhook URL into all three Request-URL fields (Event Subscriptions, Slash Commands, Interactivity & Shortcuts).
3. **Install the app to your workspace.** Slack issues an `xoxb-` Bot User OAuth Token. The user can now `@`-mention the bot, send DMs, run the slash command, and click buttons.
4. **Slack delivers events.** Every user action is POSTed back through the Slack App to the registered Request URL.
5. **The snap-in answers.** It verifies the Slack HMAC-SHA256 signature, resolves the Slack sender's email to a DevRev user, mints an impersonated (`act-as`) token, posts a "Searching…" placeholder, calls the AI Agent asynchronously, mirrors the exchange onto a DevRev `conversation`, and replaces the placeholder in-place with the final answer when the agent responds.

---

## External configuration (Slack App)

The snap-in receives every Slack event — bot mentions, direct messages, slash commands, button clicks, modal submissions — at one webhook URL that DevRev issues during activation. You wire that URL into Slack from three places: **Event Subscriptions**, **Slash Commands**, and **Interactivity & Shortcuts**.

### Step 1: Register the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps).
2. Click **Create New App** → **From scratch**.
3. Name your app (e.g., "DevRev AI Bot") and select your workspace.

### Step 2: Configure bot token scopes (privileges)

Go to **OAuth & Permissions** and add these **Bot Token Scopes**:

| Scope | Purpose |
|-------|---------|
| `chat:write` | Send and update messages, and post ephemeral feedback confirmations. |
| `users:read` | Look up Slack user metadata (display name) for log + audit lines. |
| `users:read.email` | Read the Slack user's email so it can be matched to a DevRev user. |
| `app_mentions:read` | Receive `app_mention` events when the bot is `@`-mentioned in a channel. |
| `commands` | Register and receive slash-command invocations (`/sda-agent-feedback`). |
| `im:history` | Optional — required only if you also subscribe to `message.im` for DM support. |

### Step 3: Install the app to your workspace

1. Go to **Install App** in the sidebar.
2. Click **Install to Workspace** and authorize the OAuth scopes.
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`). You will paste it into the snap-in in Step 9.

### Step 4: Capture the Signing Secret

1. Go to **Basic Information** in the sidebar.
2. Under **App Credentials**, copy the **Signing Secret**. This is the shared key the snap-in uses to verify that incoming requests really came from Slack.

### Step 5: Subscribe to Slack events

1. Go to **Event Subscriptions** and toggle **Enable Events** on.
2. You will paste the snap-in's webhook URL into **Request URL** after activating the snap-in (Step 10 below). Slack auto-verifies the URL with a one-time `url_verification` challenge.
3. Under **Subscribe to bot events**, add:
   - `app_mention` — required, triggers the bot when it is `@`-mentioned in a channel.
   - `message.im` — optional, enables direct messages to the bot.
4. Click **Save Changes**.

### Step 6: Register the slash command

1. Go to **Slash Commands** > **Create New Command**.
2. Set the fields:
   - **Command**: `/sda-agent-feedback`
   - **Request URL**: (will be the same snap-in webhook URL from Step 10 below)
   - **Short Description**: `Share feedback on the SDA Agent conversation`
   - **Usage Hint**: leave blank.
3. Click **Save**. Reinstall the app to the workspace if Slack prompts to refresh permissions.

### Step 7: Toggle Interactivity on and submit the webhook URL

1. Go to **Interactivity & Shortcuts** and toggle **Interactivity** on.
2. Paste the snap-in's webhook URL (from Step 10) into the **Request URL** field. The same URL is used for the slash-command response, button clicks, and modal submissions.
3. Click **Save Changes**.

> **Note**: Steps 5, 6, and 7 all use the **same webhook URL** that DevRev issues during snap-in activation (Step 10). Come back to these three pages after activation to paste the URL.

---

## Set up and deploy steps

### Quick deploy with the DevRev CLI

For a TL;DR using only the DevRev CLI, after you have the Slack tokens (Steps 1–5):

```bash
# 0. Authenticate (one-time per shell)
devrev profiles authenticate --org <your-org-slug> --usr <your-email>

# 1. Build + package the snap-in (run from the repo root)
cd code && npm install && npm run package && cd ..
#   → produces code/build.tar.gz

# 2. Create a brand-new snap-in package + version
devrev snap_in_package create-one --slug slack-surface
devrev snap_in_version create-one \
    --package <package-id-from-previous-step> \
    --manifest manifest.yaml \
    --archive code/build.tar.gz
#   → wait until the version's `state` shows `ready`

# 3. Create a draft snap-in from that version, then activate it
devrev snap_in draft --snap_in_version <version-id-from-step-2>
devrev snap_in update --snap_in <snap-in-id> \
    --keyring slack_bot_token=<xoxb-...> \
    --keyring slack_signing_secret=<...> \
    --inputs ai_agent_id=<don:core:dvrv-us-1:devo/...:ai_agent/...>
devrev snap_in activate --snap_in <snap-in-id>

# 4. Iterating: push a new build to an existing version (no new draft needed)
cd code && npm run package && cd ..
devrev snap_in_version upgrade <version-id> \
    --force --manifest manifest.yaml --archive code/build.tar.gz

# 5. Tail logs
devrev snap_in_package logs --snap_in_package <package-id>
```

The `<...>` placeholders are returned by the previous command's JSON output. After `devrev snap_in activate`, copy the **Slack Events Webhook URL** the platform issues and paste it into your Slack App's **Event Subscriptions**, **Slash Commands**, and **Interactivity & Shortcuts** Request URL fields — see [Step 11: Submit the webhook URL into Slack](#step-11-submit-the-webhook-url-into-slack-three-places).

### Step-by-step deploy

#### Step 8: Build, package, and upload the snap-in

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

#### Step 9: Configure the snap-in inputs

Go to **DevRev Settings → Snap-ins** and find the newly created snap-in. Set:

| Input | Required | Value |
|-------|----------|-------|
| **AI Agent ID** | Yes | Your DevRev AI Agent DON (e.g., `don:core:dvrv-us-1:devo/xxx:ai_agent/yyy`) |
| **Slack Bot Token** | Yes | The `xoxb-...` token from Step 3 |
| **Slack Signing Secret** | Yes | The signing secret from Step 4 |
| **Mock Email Address** | No | Optional — see Mock Email behavior matrix below |

#### Step 10: Activate the snap-in and capture the webhook URL

1. Click **Activate** on the snap-in.
2. Once `state = active`, open the snap-in's setup instructions and copy the **Slack Events Webhook URL** that DevRev shows.

#### Step 11: Submit the webhook URL into Slack (three places)

Paste the webhook URL captured in Step 10 into all three of the Slack-app pages registered earlier:

1. **Event Subscriptions** > **Request URL** — Slack auto-verifies with a one-time challenge. Click **Save Changes**.
2. **Slash Commands** > edit `/sda-agent-feedback` > **Request URL** — paste the same URL. Click **Save**.
3. **Interactivity & Shortcuts** > **Request URL** — paste the same URL. Click **Save Changes**.

If Slack prompts to **Reinstall Required**, click it once and re-authorize so the new request URLs and command privileges take effect. The bot is now live.

---

## Project structure

```
slack-surface-devrev/
├── manifest.yaml                  # DevRev snap-in manifest (functions, sources, inputs)
├── README.md
├── .env.example                   # Environment-variable template (see below)
├── .gitignore                     # Repo-root ignore patterns
└── code/
    ├── package.json               # npm scripts: build, lint, lint:check, typecheck, test
    ├── tsconfig.json
    ├── jest.config.js
    ├── .eslintrc.js
    └── src/
        ├── main.ts                # CLI entry for local fixture-driven runs
        ├── function-factory.ts    # Registry of every function name → handler
        ├── types.ts               # Shared FunctionInput envelope type
        ├── config/
        │   └── defaults.ts        # Centralized env-driven runtime config
        ├── functions/
        │   ├── slack_handler/             # Inbound Slack events
        │   ├── ai_response_handler/       # Async AI Agent responses
        │   ├── slack_interactivity/       # Slash commands + modal submissions
        │   ├── session_gc/                # Cron-driven session GC
        │   └── ensure_session_state_schema/   # Activate-hook schema setup
        ├── utils/
        │   ├── logger.ts                  # Leveled logger (LOG_LEVEL env var)
        │   ├── slack-client.ts            # Slack Web API wrappers
        │   ├── slack-signature-validator.ts   # HMAC-SHA256 verification
        │   ├── devrev-auth.ts             # DevRev act-as / webhook helpers
        │   ├── session-store.ts           # Session persistence in conversations
        │   ├── session-fields.ts          # Custom-field name constants
        │   ├── session-config.ts          # Session timing config
        │   ├── conversation-store.ts      # ConversationReference helpers
        │   ├── feedback.ts                # Feedback modal Block Kit builders
        │   ├── format-text.ts             # Markdown → Block Kit conversion
        │   ├── timeline.ts                # Conversation timeline_comment helper
        │   └── errors.ts                  # Type-safe error utilities
        └── fixtures/                      # Local-test event payloads
```

---

## Dependencies

**Runtime**
- `@devrev/typescript-sdk` — DevRev API client (act-as tokens, webhooks, custom schema, conversations).
- `axios` — HTTP client for Slack Web API + a few DevRev endpoints not yet on the SDK.
- `protobufjs` — used transitively by the SDK for snap-ins serialization.

**Dev / build**
- `typescript`, `ts-node`, `rimraf` — compile + clean.
- `jest`, `ts-jest`, `babel-jest` — unit tests (153+ tests across handlers and utils).
- `eslint` (+ `@typescript-eslint`, `prettier`, `import`, `simple-import-sort`, `unused-imports`, `sort-keys-fix`) — linting / formatting.
- `dotenv` — local `.env` loading for the fixture runner only.

Concrete versions are pinned in [`code/package.json`](code/package.json) — keep them current via `npm audit` and minor-version bumps; major bumps to `@devrev/typescript-sdk` need to track DevRev platform compatibility.

---

## Configuration reference

| Input | Required | Description |
|-------|----------|-------------|
| `ai_agent_id` | Yes | The DevRev AI Agent ID to process messages |
| `slack_bot_token` | Yes | Slack Bot User OAuth Token (stored as keyring secret) |
| `slack_signing_secret` | Yes | Slack Signing Secret (stored as keyring secret) |
| `mock_email_address` | No | If you have a DevRev email ID which you wish to mock in any surface, enter it here. If it is a valid email address, it will appear as if messages are coming from you regardless of who sends in Slack. If not present or invalid format, this is ignored. |

---

## Configuration via environment variables

Most operator-tunable knobs live in [`code/src/config/defaults.ts`](code/src/config/defaults.ts) and read from `process.env` at startup. Copy `.env.example` to `.env` for local development:

```bash
cp .env.example .env
```

Common variables:

| Variable | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug`. Use `debug` only when triaging. |
| `WEBHOOK_MAX_WAIT_MS` | `10000` | How long to wait for a fresh DevRev webhook to go active. |
| `WEBHOOK_POLL_INTERVAL_MS` | `500` | Webhook-status polling interval. |
| `ACT_AS_TOKEN_TTL_MINUTES` | `30` | act-as token cache lifetime. |
| `SESSION_IDLE_TIMEOUT_MINUTES` | `480` | Override session idle TTL (also accepted via global_values). |
| `SESSION_ABSOLUTE_TIMEOUT_HOURS` | `24` | Absolute session lifetime ceiling. |
| `BLOCK_KIT_MAX_BLOCKS` | `50` | Slack hard-rejects messages with more blocks than this. |

In production, deliver these to the snap-in via the platform's secret manager / global_values — never check in a real `.env`.

---

## Mock email address — behavior matrix

| Config Email | Slack User | Result |
|---|---|---|
| Valid DevRev email (e.g. `alice@devrev.ai`) | Any | ✅ Mock used — AI runs as the configured user |
| Non-DevRev email (e.g. `alice@gmail.com`) | Any | ❌ Not authorized — bot replies with generic error |
| Invalid format (e.g. `notanemail`) | Any | ❌ Config error — bot replies with generic error, no fallback |
| Not set (blank) | DevRev user | ✅ Real Slack email lookup — AI runs as that Slack user |
| Not set (blank) | Non-DevRev user | ❌ Not authorized — bot replies with generic error |
| Not set (blank) | Slack API lookup fails | ⚠️ Falls back to service account token, AI still runs |

---

## How email lookup works

1. **Get email from Slack** — The Slack user ID from the incoming event is passed to the `users.info` API using the bot token to retrieve the user's email address.
2. **Look up in DevRev** — That email is searched in your DevRev org via `devUsersList`. If no match, the request is rejected.
3. **Get act-as token** — If the user exists, an impersonation token is created so the AI Agent runs with that user's permissions.
4. **Fallback** — If act-as token creation fails (e.g. scope not yet granted), the service account token is used instead.

With **mock email** configured, step 1 is skipped entirely and the mock email goes straight to step 2.

---

## Event sources

| Source | Description |
|--------|-------------|
| `slack-webhook-source` | Receives events from Slack Events API |
| `ai-agent-events` | Receives async AI Agent responses and timeline entries |

---

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
