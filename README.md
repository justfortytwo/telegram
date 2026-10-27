# @justfortytwo/telegram

The **Telegram channel adapter** for [fortytwo](https://github.com/justfortytwo) — a
standalone, always-on **bridge** connecting a Telegram bot to persistent Claude
Code sessions through `@justfortytwo/runner`.

1. **Transport.** Each active authorized chat normally has one live RunnerSession.
   After authorization, attachment ingestion and optional journaling, input waits
   only for `session.send()` to write it. Polling continues while Claude works;
   another message goes to the same session immediately after preprocessing.
2. **Output and deferrals.** Complete assistant-message events are coalesced into
   an evolving Telegram reply, edited at most once per second during streaming.
   A result finalizes the reply; long replies use additional messages of at most
   4000 UTF-16 units. Typing refreshes while submitted inputs await results.
   Deferred results produce a plain notice: Telegram cannot authorize the action.
   Claude Code owns tool permissions; Gate is optional policy through Claude hooks/plugins.
3. **Scheduler separation.** Proactive wakes remain the responsibility of the
   external `@justfortytwo/scheduler` daemon.

## Release notes

### 1.0.0-6

Preserve Telegram photo and document captions in the same Claude turn as attachment
details and in inbound memory/journal text. Message text takes precedence when present.
Seven regression tests cover caption handling and existing attachment behavior.

## Session lifecycle and recovery

The bridge owns the chat-to-session mapping. Runner owns the Claude process and
stream-json transport; Claude Code owns the agent. Telegram makes no provider or
model decisions. The runner inherits process configuration and receives
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` explicitly, without changing `process.env`.
Persistent sessions have no default wall-clock turn timeout.

Claude stays alive between messages. When runner exposes a session ID, the bridge
writes it to `sessions` in `state/bridge-state.json`. Following a bridge restart,
the next authorized message lazily creates a session with `resumeSessionId`.
These IDs are recovery hints: the state file is not a transactional message queue,
and in-flight inputs, partial replies, or unobserved IDs can be lost on a crash.
Recovery also requires Claude Code's underlying session data to remain available.

An unexpected Claude exit removes the live mapping, retains the last known ID,
and reports an error if input was awaiting a result. The next message attempts
resumption; there is no automatic restart supervisor or input replay. Stderr is
logged locally. Asynchronous Telegram delivery failures are logged; there is no
new durable output queue. Assistant events are complete messages, not token-level
streaming, and concurrent inputs share the session's output stream.

SIGINT/SIGTERM abort polling, stop new session work and deterministically close
live RunnerSessions. `/logout` closes the chat's live process and removes its
binding, while retaining durable conversation IDs and tolerating inert legacy
approval-card state. The existing `ALLOWED_CHAT_IDS` bootstrap authorization still applies
independently of bindings.

The runner dependency is pinned to the published prerelease
`@justfortytwo/runner@1.0.0-0` (npm dist-tag `next`), the first release with
persistent sessions. Move to a stable `^1` range once runner publishes one.

### Manual check against a real Claude Code

The automated suite uses fake runners only. To verify concurrency end to end, run
the bridge with a test bot (`TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_IDS=<your chat>`,
`claude` on `PATH`), then:

1. Send a message that makes Claude work for a while (e.g. "count slowly to 20
   using a Bash `sleep 1` between numbers").
2. While typing is shown, send a second message. The bridge log should print the
   second `inbound` line immediately, and `ps` should show a single `claude` child.
3. Stop the bridge with Ctrl-C and confirm no `claude` process remains; restart
   it and send a message: the reply should continue the same conversation.

## Pairing / login binding model

The bot is **locked down**: an unbound sender that does not present a valid
`/login` gets **no response at all**. Access is earned through a
channel-agnostic challenge/verify pairing flow:

```
owner side:    adapter.issueChallenge(owner)  ->  { code, ttl }
channel side:  /login <code>                  ->  verify(chatId, code) -> binding
```

- `issueChallenge(owner)` mints a **single-use, short-TTL** code (default 6
  digits, 5 minutes). The owner relays it out-of-band to the chat they want to
  bind.
- `/login <code>` verifies the code and, on success, **persists a binding**
  `(channelType, channelUserId) -> owner`.
- `/logout` removes the binding and closes the live session (recovery IDs remain).
- Every inbound message is authorized against **persisted bindings ∪ the
  optional `ALLOWED_CHAT_IDS` bootstrap set**. The bootstrap set lets a chat
  reach the bridge without a binding; it is never required. On a fresh install
  (no `ALLOWED_CHAT_IDS`, no bindings) the bridge still starts, locked down, and
  the first chat pairs with `/login <code>` using a code from `fortytwo pair`.

Pending challenges are **persisted in the binding store** (not in process
memory), so a code minted by one process — e.g. the `fortytwo pair` CLI — is
redeemable by the separately-running bridge. They are single-use and short-TTL.

The contract is intentionally **channel-agnostic** (`ChannelAdapter` in
`src/adapter.ts`) so a future Slack / email / SMS adapter implements the same
`issueChallenge` / `verify` shape.

### Binding store

Authorization must work **even when the memory package is absent**, so the
binding store is **self-owned** and does not assume the `@justfortytwo/memory`
sqlite db exists:

- `SqliteBindingStore` — default; a tiny `better-sqlite3` db in its own file
  (`state/telegram-bindings.db` by default) holding **bindings + pending
  challenges**, so a CLI-issued pairing code reaches the bridge.
- `MemoryBindingStore` — in-process Map, for tests / ephemeral use.
- `BindingStore` — the injectable interface. Supply a memory-backed
  implementation later without touching the login flow.

> Cross-repo reconciliation: if fortytwo standardizes a shared identity
> table, swap the default store for a memory-backed `BindingStore`. The login
> flow is unaffected.

## fortytwo package dependencies

`@justfortytwo/gate` is a regular dependency: `attachments.ts` imports its
`createSourceEnvelope` provenance helper at runtime (gate has no dependencies of
its own). Using gate as a *policy hook* remains optional and is configured
separately. `@justfortytwo/memory` is an **optional peer**: it is loaded
dynamically, and it is also a devDependency so types and tests resolve.

| Package | Used for | Contract |
| --- | --- | --- |
| `@justfortytwo/memory` | Memory store, jobs, embeddings | `MEMORY_TOOL_CONTRACT_VERSION` (tools `mcp__fortytwo-memory__*`) |
| `@justfortytwo/transcript` | Conversation log (every inbound/outbound message) | `prepareTranscript`, `createTranscript` |
| `@justfortytwo/gate` | Provenance envelopes (policy hook configured separately) | `POLICY_SCHEMA_VERSION` |

Install memory alongside this package to enable persistence:

```sh
npm install @justfortytwo/telegram @justfortytwo/memory @justfortytwo/transcript
```

The **memory** data path is wired: the bridge opens + migrates the memory DB at
startup (used for the reply queue) and **writes each channel event** through
`@justfortytwo/transcript`'s conversation log; chat is no longer stored as memories.
Recall happens inside the headless `claude` turn via the Memory MCP tools. If the
memory or transcript peer is absent, the bridge degrades to **channel-only**
(messages relay but are not recorded) rather than refusing to start. A failing
log write is logged to stderr and never blocks a reply. Telegram does not record tool
authorizations or update Gate approval stores.

## Environment

| Var | Required | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | Bot token. The bridge is the **only** long-poller on this bot. |
| `ALLOWED_CHAT_IDS` | no | Comma-separated chat IDs authorized without a binding. Not needed for first pairing: `/login <code>` works with zero bindings. |
| `CLAUDE_BIN` | no | Path to the `claude` binary (default `claude`). |
| `TELEGRAM_BINDINGS_DB` | no | Path to the self-owned bindings db (default `state/telegram-bindings.db`). |
| `DB_PATH` | no | Path to the memory DB the bridge opens/migrates at startup (default `db/fortytwo.db`, relative to `FORTYTWO_ROOT`). |
| `EMBED_MODEL` | no | When set, the bridge uses the Ollama embedder for memory (otherwise a deterministic fallback). |
| `OLLAMA_BASE_URL` | no | Base URL for the Ollama embedder (default `http://localhost:11434`; may be remote). |
| `ASSISTANT_NAME` / `ASSISTANT_ACTOR` | no | Display name (default `Assistant`) + conversation-log actor label for replies (default `assistant`). |
| `OWNER_ACTOR` | no | Conversation-log actor label for inbound messages (default `owner`). **Keep it `owner`:** persona's Oneiros only treats transcript rows with actor exactly `owner` as owner evidence, so any other value means your Telegram messages never refine PROFILE. |
| `FORTYTWO_ROOT` | no | Working root for the headless `claude` process + state files. |

> `FORD_ROOT` remains a deprecated alias for `FORTYTWO_ROOT`.

> Proxy auth for the headless `claude` session is **not** read here — the
> `claude` CLI reads `ANTHROPIC_*` from its own config.

## Usage

### Prerequisites / first run

- The bridge **spawns the `claude` binary**, so Claude Code's `claude` must be on
  your `PATH` (or point `CLAUDE_BIN` at it).
- It loads `config/adapters.toml` from `$FORTYTWO_ROOT/config/`.
- It **requires** `TELEGRAM_BOT_TOKEN`. With no `ALLOWED_CHAT_IDS` and no
  bindings it starts locked down: every unbound sender is silently dropped, and
  only `/login <code>` with a valid pending challenge (mint one with
  `fortytwo pair`) creates the first binding. No pending challenge is needed for
  the bridge to keep running.

```sh
npm run build
node dist/bridge.js
```

Run it under a restart loop (tmux/systemd) so it survives transient errors and
crashes. Example launcher (adapted from the monolith's `wakeup.sh`):

```sh
set -a; source .env; set +a
while true; do
  node node_modules/@justfortytwo/telegram/dist/bridge.js
  echo "[telegram] bridge exited (rc=$?) — restarting in 3s"; sleep 3
done
```

## License

MIT © 2026 Enrico Deleo

---

Created and maintained by [**Enrico Deleo**](https://enricodeleo.com).

### Typing indicator lifecycle

Each chat owns one typing refresher while Claude is working on submitted input.
Sending a message turns it on; so does Claude consuming a queued input. Every
result turns it off before final-message delivery, so messages sent mid-turn
(steering, answered together in one result) cannot leave it stuck. Fatal
session errors, exit, closed-input retirement, logout and shutdown cancel it. A
rejected input releases typing only if it started it. Legacy approval callbacks
cannot restart typing. Non-fatal runner diagnostics do not end a turn.

Typing is not a turn timeout: silent but active work keeps refreshing, while
late output cannot restart typing after a result. Once no work is active, the
bridge sends no further typing refreshes; an action already sent can
remain visible briefly until Telegram expires it.

## Release notes — 1.0.0-4

Telegram no longer offers approval buttons for deferred tools. Claude Code's effective permissions remain authoritative for tool execution.
Gate enforcement is optional through an explicitly
configured Claude hook/plugin. Conversational confirmation is not durable tool authorization.

**Intentional public API change:** removed `approvalKeyboard`,
`ApprovalKeyboardOptions`, and `formatApprovalCard`. Consumers importing these
exports must remove those imports. Deferred-result recognition remains available.
The obsolete `FORTYTWO_BASH_ALLOW_TTL_HOURS` and `FORD_BASH_ALLOW_TTL_HOURS`
settings are no longer read.

Old buttons only report that the control is unsupported and no authorization was
recorded. They never submit a Claude turn or change approval state. Legacy
`pending` data is tolerated but never used for authorization. Bindings, session
IDs/resume, conversation history, and attachment provenance are preserved; the
Gate library dependency remains required for provenance. Gate's standalone
hook/plugin and memory's approval/audit schema are unchanged.
