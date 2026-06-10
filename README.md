# Slack Surface Snap-in

A DevRev snap-in that connects Slack with DevRev AI Agents. Users mention the bot (or DM it) in Slack, the snap-in routes the query to a DevRev AI Agent, and the response is delivered back inside the same Slack thread — with real-time progress updates while the agent works.

---

## Table of Contents

1. [Background](#background)
2. [Architecture](#architecture)
3. [Slack App Setup](#slack-app-setup)
4. [Snap-in Deployment](#snap-in-deployment)
5. [Configuration Options](#configuration-options)
6. [User Impersonation](#user-impersonation)
7. [Session Lifecycle](#session-lifecycle)
8. [Adding Widgets and Buttons to Slack](#adding-widgets-and-buttons-to-slack)
9. [Logging Reference](#logging-reference)
10. [Troubleshooting](#troubleshooting)

---

## Background

DevRev AI Agents can answer questions about your org's tickets, issues, conversations, and customers — but they live inside DevRev. This snap-in brings that intelligence directly into Slack so your team never has to leave their primary workspace.

**What it does end-to-end:**

1. A user types `@DevRev Bot what is the status of TKT-123?` in any channel the bot is in, or sends it a direct message.
2. The snap-in verifies the Slack request signature, resolves the sender's email to a DevRev user, and creates (or reuses) a DevRev `conversation` object as the AI session backing store.
3. A temporary `⏳ Searching...` message is posted immediately so the user knows the bot received their request.
4. The query is forwarded to the configured DevRev AI Agent. While the agent works, progress updates (`🔍 Analyzing...`, `⚡ Processing...`) replace the placeholder.
5. The agent's final answer is delivered back as a Slack reply in the same thread. The placeholder is deleted first.
6. Every user query and every AI response is mirrored as a timeline entry on the backing DevRev conversation, giving your team a full audit trail inside DevRev.

**Key capabilities:**

| Feature | Description |
|---|---|
| User impersonation | Resolves Slack email → DevRev user → act-as token so the AI runs with that user's permissions |
| Thread-aware sessions | Channel threads and DMs each maintain their own session with full conversation history |
| Session expiry | Idle (8 h default) and absolute (24 h default) timeouts, configurable per snap-in install |
| `/sda-feedback` slash command | Opens a Block-Kit rating modal; stores 1–5 star rating + comment on the DevRev conversation |
| Mock email (testing) | Override the sender identity without a real Slack account |
| Session reset | User can type `new session` or `/clear` to start a fresh AI conversation |
| Block-Kit UI | Extensible: add buttons, dropdowns, and modals to any AI response |

---

## Architecture

```
Slack Workspace
      │
      │  Events API (app_mention, message.im)
      │  Slash commands (/sda-feedback)
      │  Block-Kit interactivity (button clicks, modal submits)
      ▼
┌──────────────────────────────────────────────────────┐
│                   DevRev Snap-in                     │
│                                                      │
│  slack-webhook-source  ──►  slack_handler            │
│  (Rego policy routes)  ──►  slack_interactivity      │
│                                                      │
│  ai-agent-events       ──►  ai_response_handler      │
│                                                      │
│  session-gc-timer      ──►  session_gc  (every 30m)  │
│                                                      │
│  activate hook         ──►  ensure_session_state_schema │
└──────────────────────────────────────────────────────┘
      │                         │
      │                         │
      ▼                         ▼
 DevRev AI Agent          DevRev conversations
 (processes queries)      (session + timeline store)
```

### Request routing (Rego policy)

The single `slack-webhook-source` webhook handles three payload shapes:

| Slack payload type | Routed to | Function |
|---|---|---|
| `type == "url_verification"` | Answered inline by Rego | — |
| `type == "event_callback"` | `custom:slack-message` | `slack_handler` |
| Everything else (slash commands, Block-Kit) | `custom:slack-interactivity` | `slack_interactivity` |

---

## Slack App Setup

### Step 1 — Create the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.
2. Name your app (e.g. `DevRev AI Bot`) and select your workspace.

### Step 2 — Configure Bot Token Scopes

**OAuth & Permissions** → **Bot Token Scopes**:

| Scope | Purpose |
|---|---|
| `chat:write` | Send, update, and delete messages |
| `users:read` | Fetch user info |
| `users:read.email` | Resolve user email for DevRev identity mapping |
| `app_mentions:read` | Receive `@mentions` |
| `commands` | Required for the `/sda-feedback` slash command |

### Step 3 — Enable Event Subscriptions

1. **Event Subscriptions** → toggle **Enable Events**.
2. Paste the snap-in webhook URL (available after deploy — see Step 6).
3. Subscribe to bot events:
   - `app_mention` — required; triggers on every `@mention`.
   - `message.im` — optional; enables direct messages to the bot.

### Step 4 — Add the Slash Command

**Slash Commands** → **Create New Command**:

| Field | Value |
|---|---|
| Command | `/sda-feedback` |
| Request URL | Same snap-in webhook URL |
| Short description | `Share feedback on the AI Agent` |

### Step 5 — Enable Interactivity

**Interactivity & Shortcuts** → toggle **Interactivity ON** → paste the same webhook URL.

### Step 6 — Install to Workspace

**Install App** → **Install to Workspace** → authorize.

Copy the **Bot User OAuth Token** (`xoxb-…`) and the **Signing Secret** from **Basic Information** → **App Credentials**.

---

## Snap-in Deployment

```bash
# 1. Install dependencies
cd code && npm install

# 2. Build and package
npm run package

# 3. Deploy (replace <version-id> with the current version DON)
cd ..
devrev snap_in_version upgrade <version-id> --force \
  --manifest manifest.yaml \
  --archive code/build.tar.gz

# 4. Wait for state=ready, then draft
devrev snap_in draft --snap_in_version <new-version-id>
```

After drafting, go to **DevRev Settings → Snap-ins**, find the snap-in, fill in the configuration (see below), then click **Activate**.

Once active, copy the **Slack Events Webhook URL** from the snap-in's setup instructions and paste it into Slack's **Event Subscriptions**, **Slash Commands**, and **Interactivity** pages.

---

## Configuration Options

| Input | Required | Default | Description |
|---|---|---|---|
| `ai_agent_id` | Yes | — | DevRev AI Agent DON (e.g. `don:core:dvrv-us-1:devo/x:ai_agent/y`) |
| `mock_email_address` | No | — | Override sender identity for testing. See [User Impersonation](#user-impersonation). |
| `session_idle_timeout_minutes` | No | `480` (8 h) | Minutes of inactivity before a session is marked idle-expired. The user is told their session expired; the conversation is retained until the absolute timeout. |
| `session_absolute_timeout_hours` | No | `24` (1 day) | Absolute session lifetime in hours. The DevRev conversation is deleted after this regardless of activity. |

**Keyrings** (stored as snap-in secrets, never in plain config):

| Keyring | Description |
|---|---|
| `slack_bot_token` | Bot User OAuth Token (`xoxb-…`) from Slack App → Install App |
| `slack_signing_secret` | Signing Secret from Slack App → Basic Information |

---

## User Impersonation

The snap-in can run the AI Agent as the actual Slack sender rather than a generic service account. This means the agent respects the user's DevRev permissions — they only see data they are authorized to view.

### How it works

```
Slack event arrives
      │
      ▼
1. Get user email via Slack users.info API
      │
      ▼  (or skip to step 2 if mock_email_address is set)
2. Look up email in DevRev via /dev-users.list?email=
      │
      ├── Not found → reject with "something went wrong" message to user
      │
      └── Found → get DevRev user DON
                        │
                        ▼
              3. Mint act-as token via /dev-users.identities.create
                        │
                        ├── Success → AI Agent runs as that DevRev user
                        │
                        └── Failure → fall back to service account token
```

### Mock email — behavior matrix

Use `mock_email_address` during development to test without a real Slack account:

| Config value | Result |
|---|---|
| Valid DevRev email (`alice@yourorg.ai`) | All messages act as if sent by that user |
| Non-DevRev email (`alice@gmail.com`) | Rejected — bot replies with a generic error |
| Invalid format (`notanemail`) | Config error — bot replies with generic error, no fallback |
| Not set — Slack user has a DevRev account | Resolved normally — AI runs as that user |
| Not set — Slack user is not in DevRev | Rejected — bot replies with generic error |
| Not set — Slack `users.info` call fails | Fallback to service account token; AI still runs |

### Service account scopes

The snap-in's service account needs these scopes in your DevRev org:

```yaml
self:
  - dev_user:read          # Resolve Slack email → DevRev user
  - ai_agent:execute       # Fallback AI execution when no user is resolved
  - tenant_fragment:write  # Register the tnt__ custom schema on activate
  - conversation:read      # Look up sessions
  - conversation:write     # Create / update / delete session conversations

impersonate:
  - act_as: all_devusers
    - ai_agent:execute     # Run AI as the resolved user
    - conversation:read
    - conversation:write
```

---

## Session Lifecycle

Each Slack session is backed by a DevRev `conversation` object. The conversation's DON is passed to the AI Agent as its `session_object`, giving it server-side context across multiple turns.

```
createSession ──► active ──► touchSession (each message, rolls idle TTL)
                    │
                    ├── idle timeout elapsed    ──► expired (notify user)
                    ├── absolute timeout elapsed ──► expired (notify user)
                    ├── user types "new session" ──► ended  (rotate)
                    └── admin manual end        ──► ended  (rotate)
                                                        │
                                              createSession (generation+1)
                                              with previousSessionId linkage
```

**Session reset:** A user can start a fresh AI conversation at any time by typing `new session` or `/clear`. The old session is ended with reason `user_reset` and a new one is created in the same thread.

**Garbage collection** runs every 30 minutes via a timer event:
- Sessions past their **idle timeout** are marked `expired` and the user is notified.
- Sessions past their **absolute timeout** are deleted from DevRev entirely.

---

## Adding Widgets and Buttons to Slack

The snap-in uses Slack's **Block Kit** for all structured UI: the feedback modal, loading states, and confirmation messages. You can use the same patterns to add interactive elements to AI responses or build new slash commands.

### Understanding Block Kit

Slack Block Kit replaces plain text with composable UI blocks. A message's `blocks` array controls layout; `text` is the plain-text fallback for notifications.

```
Message payload
├── text      (fallback for push notifications / accessibility)
└── blocks[]
    ├── section   (text + optional accessory: button, image, overflow menu)
    ├── divider   (horizontal rule)
    ├── actions   (row of buttons or select menus)
    ├── input     (form fields — modals only)
    ├── context   (small grey helper text / images)
    └── image     (standalone image block)
```

### Extending `sendMessage` to support blocks

The current `sendMessage` helper in `code/src/utils/slack-client.ts` sends plain text. To send Block Kit messages, add a `blocks` parameter:

```typescript
// code/src/utils/slack-client.ts

export async function sendMessage(
  channel: string,
  text: string,
  botToken: string,
  threadTs?: string,
  blocks?: object[]   // <-- add this
): Promise<string> {
  const payload: any = { channel, text };
  if (threadTs) payload.thread_ts = threadTs;
  if (blocks && blocks.length > 0) payload.blocks = blocks;

  const response = await axios.post<SlackMessageResponse>(
    `${SLACK_API_BASE}/chat.postMessage`,
    payload,
    { headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' } }
  );
  if (!response.data.ok) throw new Error(`Slack API error: ${response.data.error}`);
  return response.data.ts ?? '';
}
```

### Block Kit examples

#### Example 1 — Simple message with a button

```typescript
await sendMessage(
  channel,
  'Ticket TKT-456 was created.',   // plain-text fallback
  slackBotToken,
  threadTs,
  [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Ticket TKT-456* has been created for your request.',
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'View in DevRev' },
        url: 'https://app.devrev.ai/your-org/works/TKT-456',
        action_id: 'view_ticket',
      },
    },
  ]
);
```

**Result in Slack:**
```
┌──────────────────────────────────────────────┐
│ Ticket TKT-456 has been created for your     │
│ request.                     [View in DevRev]│
└──────────────────────────────────────────────┘
```

#### Example 2 — Confirmation card with status fields

```typescript
await sendMessage(
  channel,
  'Ticket summary',
  slackBotToken,
  threadTs,
  [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*TKT-456 — Login page broken on Safari*' },
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Status:*\nIn Progress' },
        { type: 'mrkdwn', text: '*Priority:*\nHigh' },
        { type: 'mrkdwn', text: '*Assignee:*\nAlice' },
        { type: 'mrkdwn', text: '*Part:*\nCheckout Flow' },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Ticket' },
          url: 'https://app.devrev.ai/your-org/works/TKT-456',
          action_id: 'view_ticket',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Assign to me' },
          style: 'primary',
          action_id: 'assign_to_me',
          value: 'TKT-456',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Close' },
          style: 'danger',
          action_id: 'close_ticket',
          value: 'TKT-456',
          confirm: {
            title: { type: 'plain_text', text: 'Close this ticket?' },
            text: { type: 'mrkdwn', text: 'This will mark the ticket as closed.' },
            confirm: { type: 'plain_text', text: 'Yes, close it' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
      ],
    },
  ]
);
```

**Result in Slack:**
```
┌──────────────────────────────────────────────────────┐
│ TKT-456 — Login page broken on Safari                │
│ ───────────────────────────────────────────────────  │
│ Status:        Priority:                             │
│ In Progress    High                                  │
│                                                      │
│ Assignee:      Part:                                 │
│ Alice          Checkout Flow                         │
│ ───────────────────────────────────────────────────  │
│ [View Ticket]  [Assign to me]  [Close]               │
└──────────────────────────────────────────────────────┘
```

#### Example 3 — Overflow menu (compact actions list)

```typescript
{
  type: 'section',
  text: { type: 'mrkdwn', text: '*ISS-88 — API timeout under load*' },
  accessory: {
    type: 'overflow',
    action_id: 'issue_actions',
    options: [
      { text: { type: 'plain_text', text: '📋 Copy DON' },      value: 'copy_don' },
      { text: { type: 'plain_text', text: '✏️ Edit priority' }, value: 'edit_priority' },
      { text: { type: 'plain_text', text: '🔗 Link to ticket' }, value: 'link_ticket' },
      { text: { type: 'plain_text', text: '🗑️ Delete' },         value: 'delete' },
    ],
  },
}
```

#### Example 4 — Static select dropdown

```typescript
{
  type: 'section',
  text: { type: 'mrkdwn', text: 'Change the priority of TKT-456:' },
  accessory: {
    type: 'static_select',
    action_id: 'set_priority',
    placeholder: { type: 'plain_text', text: 'Select priority' },
    options: [
      { text: { type: 'plain_text', text: 'P0 — Critical' }, value: 'p0' },
      { text: { type: 'plain_text', text: 'P1 — High'     }, value: 'p1' },
      { text: { type: 'plain_text', text: 'P2 — Medium'   }, value: 'p2' },
      { text: { type: 'plain_text', text: 'P3 — Low'      }, value: 'p3' },
    ],
  },
}
```

#### Example 5 — Context block (helper text / metadata)

```typescript
{
  type: 'context',
  elements: [
    {
      type: 'mrkdwn',
      text: ':robot_face: Answered by DevRev AI Agent  •  Session ID: `sess-abc123`  •  3 turns',
    },
  ],
}
```

#### Example 6 — Full modal with a slash command

This is the pattern already used by `/sda-feedback`. To add a new slash command (e.g. `/create-ticket`):

**1. Register the command** in Slack App → Slash Commands pointing at the same webhook URL.

**2. Open a loading modal immediately** (within Slack's 3-second trigger_id window):

```typescript
// In slack_interactivity/index.ts, add a new case:
if (command === '/create-ticket') {
  const viewId = await openView(cmd.trigger_id, buildCreateTicketLoadingModal(), slackBotToken);
  // ... async work, then update the modal
  await updateView(viewId, buildCreateTicketModal(), slackBotToken);
  return { status: 'success' };
}
```

**3. Build the modal view:**

```typescript
export function buildCreateTicketModal(): SlackView {
  return {
    type: 'modal',
    callback_id: 'create_ticket_view',
    title: { type: 'plain_text', text: 'Create Ticket' },
    submit: { type: 'plain_text', text: 'Create' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'title_block',
        label: { type: 'plain_text', text: 'Title' },
        element: {
          type: 'plain_text_input',
          action_id: 'title',
          placeholder: { type: 'plain_text', text: 'Short description of the issue' },
        },
      },
      {
        type: 'input',
        block_id: 'description_block',
        label: { type: 'plain_text', text: 'Description' },
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'description',
          multiline: true,
          max_length: 3000,
          placeholder: { type: 'plain_text', text: 'Steps to reproduce, expected vs actual…' },
        },
      },
      {
        type: 'input',
        block_id: 'priority_block',
        label: { type: 'plain_text', text: 'Priority' },
        element: {
          type: 'static_select',
          action_id: 'priority',
          placeholder: { type: 'plain_text', text: 'Select priority' },
          options: [
            { text: { type: 'plain_text', text: 'P0 — Critical' }, value: 'p0' },
            { text: { type: 'plain_text', text: 'P1 — High'     }, value: 'p1' },
            { text: { type: 'plain_text', text: 'P2 — Medium'   }, value: 'p2' },
            { text: { type: 'plain_text', text: 'P3 — Low'      }, value: 'p3' },
          ],
        },
      },
    ],
  };
}
```

**4. Handle the submission** in `handleViewSubmission`:

```typescript
if (payload.view?.callback_id === 'create_ticket_view') {
  const values = payload.view.state?.values || {};
  const title    = values['title_block']?.['title']?.value || '';
  const desc     = values['description_block']?.['description']?.value || '';
  const priority = values['priority_block']?.['priority']?.selected_option?.value || 'p2';

  // Call your DevRev API / AI Agent to create the ticket...

  return {
    response_action: 'update',
    view: {
      type: 'modal',
      callback_id: 'create_ticket_view',
      title: { type: 'plain_text', text: 'Create Ticket' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Ticket created!*\n*TKT-789* — ${title}` },
        },
      ],
    },
  };
}
```

### Handling button clicks

Slack delivers button-click payloads as `type: "block_actions"` to the interactivity webhook. The snap-in's `slack_interactivity` function receives these via the `custom:slack-interactivity` automation.

```typescript
if (type === 'block_actions') {
  const action = interactivity.actions?.[0];
  const actionId = action?.action_id;
  const value    = action?.value;
  const userId   = interactivity.user?.id;
  const channel  = interactivity.container?.channel_id;
  const messageTs = interactivity.container?.message_ts;

  if (actionId === 'assign_to_me') {
    // Call DevRev API to reassign the ticket identified by `value`
    // Then update the original message to reflect the new state
  }
}
```

### Slack mrkdwn quick reference

The AI response formatter (`format-text.ts`) converts standard markdown to Slack's `mrkdwn` dialect automatically. When writing Block Kit text blocks by hand, use `mrkdwn` syntax directly:

| Effect | mrkdwn syntax |
|---|---|
| **Bold** | `*bold text*` |
| _Italic_ | `_italic text_` |
| ~~Strikethrough~~ | `~strikethrough~` |
| `Inline code` | `` `inline code` `` |
| Code block | ` ```code block``` ` |
| Blockquote | `> quoted text` |
| Link | `<https://url\|label>` |
| User mention | `<@U0123456789>` |
| Channel link | `<#C0123456789>` |
| Emoji | `:white_check_mark:` |

---

## Logging Reference

View logs in DevRev → Settings → Snap-ins → Logs.

| Tag | Function | Description |
|---|---|---|
| `[MSG]` | `slack_handler` | Incoming message: user, channel, text |
| `[AUTH]` | `slack_handler` | Email resolution, DevRev lookup, token type (act-as PAT vs service account) |
| `[CHAN]` | `slack_handler` | Channel name resolution |
| `[CONV]` | `slack_handler` | Session creation and backing conversation DON |
| `[AI]` | `slack_handler` | Async agent call dispatched |
| `[AI_RESP]` | `ai_response_handler` | Response/progress/error event received and forwarded to Slack |
| `[TIMELINE]` | `ai_response_handler` | AI reply mirrored to DevRev conversation timeline |
| `[STORE]` | both handlers | Session read/write/cache operations |
| `[session]` | `slack_handler` | Session lifecycle events (created, reused, rotated) |
| `[interactivity]` | `slack_interactivity` | Slash commands and Block-Kit interactions |
| `[slash]` | `slack_interactivity` | `/sda-feedback` command handling |
| `[feedback]` | `slack_interactivity` | Modal submit, rating persist |
| `[CONFIG]` | `slack_handler` | Invalid `mock_email_address` format detected |

---

## Troubleshooting

### Bot not responding in Slack

- Verify the Event Subscriptions URL is correct and verified in Slack App settings.
- Check that the snap-in is in **Active** state in DevRev.
- Ensure the bot has been added to the channel (invite it with `/invite @YourBotName`).
- Check snap-in logs for `[AUTH]` or `[MSG]` errors.

### AI Agent not processing messages

- Verify the `ai_agent_id` is a valid DON and the agent is active in DevRev.
- Check logs for `[AI]` tag errors, particularly `ai-agent-events event source ID not available`.

### Org queries returning no data (e.g. "list all users")

- Ensure the AI Agent has NLToSQL or HybridSearch skills enabled.
- Verify the snap-in service account has sufficient permissions in the org.

### User not recognized / bot says "something went wrong"

- Ensure the Slack user's email matches their DevRev account email exactly.
- Verify the bot has `users:read.email` scope in Slack.
- Check `[AUTH]` logs: look for `User ... is not in DevRev org`.

### Mock email showing generic error

- Check logs for `[CONFIG]` — if present, `mock_email_address` has an invalid format.
- Fix or clear the value in snap-in settings and reactivate.

### `/sda-feedback` shows "no active session"

- The slash command looks up the most recently active session for that user in that channel.
- Start a conversation with the bot first, then run `/sda-feedback`.

### Response not sent back to Slack

- Verify the `slack_bot_token` keyring is set and the token is valid (`xoxb-…`).
- Check that `chat:write` is in the bot's OAuth scopes.
- Ensure the bot is a member of the channel.

### Block Kit buttons not working

- Confirm **Interactivity & Shortcuts** is enabled in the Slack App and points at the same webhook URL.
- Confirm the `commands` scope is in the bot's OAuth scopes.
- Check `[interactivity]` logs to verify the payload is reaching the snap-in.
