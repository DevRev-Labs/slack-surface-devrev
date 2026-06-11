## Name

Slack Surface

## Categories

Integration
Automation

## Tagline

Bring your DevRev AI Agent into Slack so every team conversation can resolve work without leaving the channel.

## Summary

Slack Surface lets users chat with a DevRev AI Agent directly from Slack channels, threads, and direct messages, with the agent responding in the same thread under each user's own DevRev permissions. Every conversation is mirrored into DevRev as a searchable record, complete with progress updates, an in-Slack feedback prompt, and automatic cleanup of inactive sessions.

## Overview

### Description

Slack Surface turns Slack into a front door for the work that already happens inside DevRev. When a teammate mentions the bot, replies in a thread, or sends a direct message, their question reaches the configured DevRev AI Agent and the answer comes back to the same Slack conversation moments later. Each request runs as the original Slack user, so the agent only sees what that user is allowed to see, and every exchange is automatically saved as a DevRev conversation that the team can revisit, search, or reference later.

The integration is designed to feel native to Slack while keeping DevRev as the single source of truth. Conversations stay tidy through clear progress messages and threaded replies, a built-in slash command lets users share private feedback after each interaction, and idle sessions are cleaned up on their own so channels never accumulate stale state. Configuration takes only a Slack app, a bot token, and an AI Agent ID — no custom code, no infrastructure, and no per-user setup.

### Features

1. Answer Slack `@mentions`, threaded replies, and direct messages with a DevRev AI Agent.
2. Run each request as the resolved DevRev user so answers respect that user's permissions.
3. Mirror every Slack message and agent reply onto a DevRev conversation timeline for searchable history.
4. Show real-time progress updates in Slack while the agent is working, then replace them cleanly with the final answer.
5. Support a `/sda-agent-feedback` slash command that opens a private rating-and-comment modal at the end of a conversation.
6. Reset a conversation on demand with a simple `new session` or `/clear` message, without leaving Slack.
7. Automatically expire idle sessions and delete stale conversations using configurable timeouts.
8. Install in minutes from the DevRev marketplace using nothing more than a Slack bot token, a signing secret, and an AI Agent ID.

## Keywords

Slack
AI Agent
Conversational AI
Automation
Integration
ChatOps
Productivity
Customer Support
