# @justfortytwo/babelfish

The **Telegram channel adapter** for [fortytwo](https://github.com/justfortytwo) — a
standalone, always-on **bridge** that connects a Telegram bot to a headless
[`claude`](https://docs.claude.com/en/docs/claude-code) turn loop.

It does three jobs:

1. **Turn loop.** Long-poll Telegram, and for each authorized inbound message
   drive a headless `claude -p --output-format json` turn (resuming the per-chat
   session), then transport the assistant's reply back.
2. **Approval UX.** When the safety gate defers an external/irreversible tool
   call, the turn ends with `stop_reason: tool_deferred`. The bridge surfaces an
   **inline-keyboard approval card** (Approve / Deny, plus "Allow _N_h" for exact
   Bash commands). The tap records the decision and resumes the turn so the
   one-shot allow fires.
3. **Proactive wakes.** A scheduler invokes `claude -p` at fixed cron-like slots
   (daily briefing, open-thread sweeps, weekly learn-review).

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
- `/logout` removes the binding.
- Every inbound message is authorized against **persisted bindings ∪ the
  optional `ALLOWED_CHAT_IDS` bootstrap set**. The bootstrap set lets the first
  owner chat reach the bridge before any binding exists; it is not required once
  bindings exist.

The contract is intentionally **channel-agnostic** (`ChannelAdapter` in
`src/adapter.ts`) so a future Slack / email / SMS adapter implements the same
`issueChallenge` / `verify` shape.

### Binding store

Authorization must work **even when the guide package is absent**, so the
binding store is **self-owned** and does not assume the `@justfortytwo/guide`
sqlite db exists:

- `SqliteBindingStore` — default; a tiny `better-sqlite3` table in its own db
  file (`state/telegram-bindings.db` by default).
- `MemoryBindingStore` — in-process Map, for tests / ephemeral use.
- `BindingStore` — the injectable interface. Supply a memory-backed
  implementation later without touching the login flow.

> Cross-repo reconciliation: if fortytwo standardizes a shared identity
> table, swap the default store for a memory-backed `BindingStore`. The login
> flow is unaffected.

## Peer dependencies

This package orchestrates two **peer** packages — they are referenced, not
bundled:

| Peer | Used for | Contract |
| --- | --- | --- |
| `@justfortytwo/guide` | Memory store, jobs, pending-decision records, embeddings | `GUIDE_TOOL_CONTRACT_VERSION` (tools `mcp__fortytwo-guide__*`) |
| `@justfortytwo/vogon` | Bash exact-command allowlist behind "Allow _N_h"; provenance envelopes | `POLICY_SCHEMA_VERSION` |

Install them alongside this package:

```sh
npm install @justfortytwo/babelfish @justfortytwo/guide @justfortytwo/vogon
```

The seams where these peers are wired are marked with `// TODO(wire):` in
`src/bridge.ts`, `src/attachments.ts`, and `src/adapters-config.ts`. Until they
are wired, the bridge runs **channel-only** (no memory/jobs) via no-op shims.

## Environment

| Var | Required | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | Bot token. The bridge is the **only** long-poller on this bot. |
| `ALLOWED_CHAT_IDS` | bootstrap | Comma-separated chat IDs allowed before any binding exists. Optional once bindings exist. |
| `CLAUDE_BIN` | no | Path to the `claude` binary (default `claude`). |
| `FORD_TURN_TIMEOUT` | no | Hard cap (seconds) on a single turn so a stalled model can't wedge the bridge (default 300). |
| `TELEGRAM_BINDINGS_DB` | no | Path to the self-owned bindings db (default `state/telegram-bindings.db`). |
| `ASSISTANT_NAME` / `ASSISTANT_ACTOR` / `OWNER_ACTOR` | no | Display name + journal actor labels. |
| `FORD_ROOT` | no | Working root for the headless `claude` process + state files. |

> Proxy auth for the headless `claude` session is **not** read here — the
> `claude` CLI reads `ANTHROPIC_*` from its own config.

## Usage

```sh
npm run build
node dist/bridge.js
```

Run it under a restart loop (tmux/systemd) so it survives transient errors and
crashes. Example launcher (adapted from the monolith's `wakeup.sh`):

```sh
set -a; source .env; set +a
while true; do
  node node_modules/@justfortytwo/babelfish/dist/bridge.js
  echo "[babelfish] bridge exited (rc=$?) — restarting in 3s"; sleep 3
done
```

## License

MIT © 2026 Enrico Deleo

---

Created and maintained by [**Enrico Deleo**](https://enricodeleo.com).
