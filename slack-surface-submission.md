# Snap-in Submission

**Name:** Slack AI Assistant

---

**Categories:**
Integration, AI/ML

---

**Tagline:**
Connect your Slack workspace to DevRev AI Agents for intelligent, conversational support in DMs.

---

**Summary:**
The Slack AI Assistant snap-in bridges Slack and DevRev AI Agents, letting your team have natural, context-aware conversations directly in Slack direct messages. Every message is routed to a DevRev AI Agent, processed asynchronously, and delivered back to the same Slack thread — with sessions, user attribution, and conversation history automatically managed in DevRev.

---

**Overview:**

### Description

The Slack AI Assistant snap-in brings DevRev AI Agent capabilities natively into Slack. Once installed, users can open a direct message with the bot and start a conversation immediately — no context switching, no separate portal. The snap-in handles the entire message lifecycle: it validates inbound Slack events, resolves the sender to a DevRev user, dispatches the message to the configured AI Agent via async execution, and posts the response back into the originating Slack thread.

Each conversation is backed by a DevRev conversation object, giving your team a full audit trail of every exchange. Sessions have configurable idle and absolute timeouts, and a background garbage collector automatically expires and deletes stale sessions on a 30-minute schedule. Users can also share feedback directly in Slack using Block Kit buttons, with ratings stored on the session record for downstream analysis.

This snap-in is designed for teams that want to give their Slack users direct access to DevRev AI Agents without building or maintaining a custom bot. It works with any DevRev AI Agent ID and requires only a Slack App with standard bot scopes — no custom infrastructure needed.

### Features

1. Route Slack direct messages and @mention events to any DevRev AI Agent with a single configuration field.
2. Deliver AI Agent responses asynchronously back to the originating Slack thread, keeping conversations contextually grouped.
3. Automatic session management — create, resume, and expire sessions backed by DevRev conversation objects, with configurable idle (default 8 h) and absolute (default 24 h) timeouts.
4. User impersonation via act-as tokens — executes AI Agent calls as the resolved DevRev user so responses are personalized and audit-attributed correctly.
5. Block Kit interactive feedback buttons — users rate AI responses (thumbs up/down) directly in Slack; ratings are persisted on the session record.
6. Full conversation timeline — every user message and AI response is appended as a timeline entry on the DevRev conversation object for complete auditability.
7. Automated garbage collection — a cron-driven session GC runs every 30 minutes to mark idle-expired sessions and permanently delete conversations past the absolute timeout.
8. Secure credential management via DevRev keyrings — Slack Bot Token and Signing Secret are never exposed in logs or snap-in outputs.

---

**Keywords:**
Slack, AI Agent, Chatbot, DM, Conversation, DevRev, Integration, AI, Automation, Session Management
