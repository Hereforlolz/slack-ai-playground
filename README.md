# Slack Role Onboard Agent

An AI-powered, stateful onboarding agent for Slack. When a new member joins a workspace, the agent greets them, asks their role, searches real workspace history via Slack's Real-time Search API, and generates a personalised briefing using LLaMA 3.3 70B via Groq — grounded in actual messages, real people, and real channels. A `/ask` command lets them keep querying the workspace anytime, with full context awareness across the session.

Built for the **Slack Agent Builder Challenge 2026**.

---

## How it works

```
Member joins channel
       │
       ▼
Bot sends DM with role selector (Engineer / PM / Designer / Other)
       │
       ▼
User picks role  →  RTS searches workspace messages + users + channels
       │
       ▼
Groq (LLaMA 3.3 70B) generates personalised briefing, grounded in real results
       │
       ▼
Briefing posted with cited source permalinks + Refresh button
       │
       ▼
/ask <question>  →  RTS search  →  Groq answer with citations  →  context updated
```

---

## Features

- **Automatic new-member detection** via `member_joined_channel`
- **Role-aware onboarding** — Engineer, PM, Designer, or Other, each mapped to different RTS search terms for better recall
- **Real-time workspace search** via `assistant.search.context` (Slack's RTS API) — searches actual messages, users, and channels, not a static knowledge base
- **Semantic query rewriting** — bare keyword queries like `rate limiting` are rewritten to `What is the latest on rate limiting?` to trigger RTS semantic mode; OR-operator queries are left as-is for keyword recall
- **Context message inclusion** — RTS returns surrounding messages before and after each result, giving the LLM conversation-level understanding, not just isolated snippets
- **Cited sources** — every briefing and `/ask` response includes permalink-backed source citations so users can jump directly to the original messages
- **Stateful per-user context** — tracks role, topics covered, and questions asked across the session; the LLM is explicitly told not to repeat topics already covered
- **`/ask` slash command** — follow-up questions anytime, with the same RTS + Groq pipeline and session context
- **Refresh briefing** button — clears state and restarts the onboarding flow
- **Graceful sparse-workspace handling** — if RTS returns no users or channels (expected in sandboxes with limited history), the LLM is prompted to say so honestly rather than hallucinate people or channel names

---

## Tech stack

| Layer | Technology |
|---|---|
| Slack framework | Slack Bolt for JavaScript (Socket Mode) |
| AI model | Groq API — LLaMA 3.3 70B Versatile |
| Workspace search | Slack `assistant.search.context` (RTS API) |
| Transport | Socket Mode — no public URL or ngrok needed |
| State | In-memory per-user context store |
| Auth | Bot token (`xoxb-`) for Bolt; User token (`xoxp-`) for RTS |

---

## RTS API — what's actually happening

The bot makes three distinct uses of `assistant.search.context`:

**1. Role-aware message search**
On role selection, the bot expands the role into an OR-query (e.g. `engineering OR backend OR infrastructure OR deployment OR architecture` for Engineer) and searches `messages` with `include_context_messages: true`. This gives the LLM conversation threads, not just isolated messages.

**2. User and channel discovery**
A second parallel call searches `users` and `channels` with the same role-expanded query, surfacing real people and channels to name-check in the briefing. Note: in sparse sandboxes (few members, little channel history), this legitimately returns empty — the prompt handles this gracefully.

**3. Semantic `/ask` search**
The `/ask` command rewrites bare queries into natural-language questions before passing them to RTS, nudging the API toward semantic retrieval. Question-phrased and OR-style queries are passed through unchanged.

**User token rationale:** RTS calls use the `xoxp-` user token. Bot-token RTS calls require an `action_token` (only available from button/shortcut events), which a slash command doesn't provide. The user token is the correct approach, not a workaround.

### Verified test output (sandbox workspace)

```
Test 1 (message search):   ✅  5 messages returned across #all-ai-playground, #design, #engineering
Test 2 (user/channel):     ⚠️  Empty — expected in sparse sandbox (RTS known behaviour)
Test 3 (semantic + ctx):   ✅  5 messages with full before/after context threads
```

---

## Project structure

```
├── index.js            # Main bot — all event handlers, RTS calls, Groq prompts
├── test_rts.sh         # Standalone RTS smoke tester (run before deploying)
├── .env                # Secrets (not committed)
├── package.json
└── README.md
```

---

## Setup

### 1. Create a Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app **from scratch**.

**OAuth scopes (Bot Token):**
```
channels:history
channels:read
chat:write
commands
groups:history
groups:read
im:write
users:read
```

**OAuth scopes (User Token):**
```
search:read
```

**Event subscriptions** (enable Socket Mode first):
```
member_joined_channel
message.im
```

**Slash commands:** Create `/ask`.

**App-level token:** Create one with `connections:write` scope — this is your `SLACK_APP_TOKEN`.

### 2. Clone and install

```bash
git clone <repo-url>
cd slack-role-onboard-agent
npm install
```

### 3. Configure environment

Create a `.env` file:

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_USER_TOKEN=xoxp-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...
GROQ_API_KEY=...
```

### 4. Smoke-test RTS before starting the bot

```bash
chmod +x test_rts.sh
./test_rts.sh
```

This runs three RTS calls directly against your workspace and pretty-prints the JSON. Confirm Test 1 and Test 3 return messages before proceeding. Test 2 returning empty in a new workspace is normal.

### 5. Start the bot

```bash
node index.js
```

You should see:
```
⚡ Stateful Role Onboard Agent is running!
```

---

## Usage

**Onboarding flow:**
1. Add the bot to a channel
2. When any user joins that channel, they receive a DM with role selection buttons
3. After selecting a role, they receive a personalised briefing within a few seconds
4. They can click **🔄 Refresh my briefing** at any time to restart

**Follow-up questions:**
```
/ask what is the engineering team working on?
/ask who owns the mobile redesign?
/ask what happened in the last sprint?
```

The bot remembers what it has already told the user and won't repeat covered topics.

---

## Environment variables reference

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-` token — Bolt framework auth |
| `SLACK_USER_TOKEN` | `xoxp-` token — RTS API calls |
| `SLACK_SIGNING_SECRET` | Request verification |
| `SLACK_APP_TOKEN` | `xapp-` token — Socket Mode connection |
| `GROQ_API_KEY` | Groq API key for LLaMA 3.3 inference |

---

## Known limitations

- **State is in-memory** — context resets on process restart. A Redis or SQLite layer would make it persistent across deployments.
- **User/channel discovery** returns empty in sparse workspaces — this is an RTS API behaviour, not a bug. The LLM prompt handles it honestly.
- **Single workspace** — the user token is workspace-scoped. Multi-workspace support would require per-installation token storage.
- **No file search** — `assistant.search.context` supports `files` as a content type but the bot currently searches `messages`, `users`, and `channels` only.