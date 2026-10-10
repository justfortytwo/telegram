# AGENTS.md

Guidance for AI coding agents working in `@justfortytwo/telegram`.

## Purpose

The Telegram channel adapter for fortytwo. It is an always-on **bridge** process that:

1. Long-polls Telegram, authorizes each inbound message, and drives a persistent headless
   `claude` session per chat (via `@justfortytwo/runner`), sending the reply back.
2. Surfaces safety-gate deferrals (`stop_reason: tool_deferred`) as inline-keyboard approval
   cards (Approve / Deny / "Allow _N_h" for exact Bash commands), then resumes the turn.
3. Locks the bot down behind a challenge/verify **pairing** flow (`/login <code>`, `/logout`).
   Unbound senders get no response at all.

Proactive wakes are **not** handled here anymore; `@justfortytwo/scheduler` owns them and
uses this package's `telegramNotifier` export.

## Layout

```
src/
  index.ts           Public API (barrel). New public exports go here.
  bridge.ts          Bin entry (`fortytwo-telegram-bridge`) + turn loop, approval callbacks,
                     memory persistence, peer-package seams. Exported pure helpers are tested.
  chat-sessions.ts   ChatSessions: per-chat RunnerSession lifecycle, typing, output flushing.
  telegram.ts        Thin Telegram Bot API client, message types, HTML formatting, keyboards.
  adapter.ts         Channel-agnostic ChannelAdapter contract + TelegramAdapter (challenge/verify).
  bindings.ts        BindingStore interface, SqliteBindingStore (default), MemoryBindingStore.
  login.ts           /login, /logout handling and isAuthorized (bindings ∪ ALLOWED_CHAT_IDS).
  attachments.ts     Inbound photo/document handling (kind, extension, inbox path, size limit).
  adapters-config.ts Loads config/adapters.toml with a fallback TOML parser.
  notify.ts          Scheduler Notifier adapter (structural, no scheduler import) + enqueueReply.
  env.ts             envCompat(): FORTYTWO_* vars with deprecated FORD_* aliases.
test/                Vitest suites, `<module>.test.ts` (bridge-*.test.ts cover bridge.ts).
dist/                tsc output (gitignored, published).
```

## Commands

From `package.json` (Node >= 20, npm):

- `npm ci` / `npm install` - install deps.
- `npm run build` - `tsc` to `dist/` (strict, declarations + source maps).
- `npm test` - `vitest run`.
- `npx vitest run test/login.test.ts` - single test file.
- `npx tsc --noEmit` - typecheck only.
- `node dist/bridge.js` - run the bridge (needs `TELEGRAM_BOT_TOKEN`, plus `claude` on PATH or
  `CLAUDE_BIN`; `ALLOWED_CHAT_IDS` is optional).

No lint or format script is configured. CI (`.github/workflows/ci.yml`) calls the shared
reusable workflow `justfortytwo/.github/.github/workflows/node-ci.yml@main` with
`siblings: "gate memory"` (the sibling packages are checked out alongside).

## Conventions

- ESM (`"type": "module"`), `module`/`moduleResolution: NodeNext`: relative imports must use
  `.js` suffixes (`./telegram.js`).
- Two-space indent, single quotes, semicolons. Kebab-case filenames, camelCase functions,
  PascalCase types/classes.
- Keep logic testable by exporting pure helpers and injecting I/O (`send` callbacks,
  `BindingStore`, `EnqueueReplyDeps`, `AttachmentIo`, `TomlParser`).
- Commit messages follow `feat(telegram): ...`, `fix(...)`, `refactor(...)`, `docs:`,
  `deps:`, `release: telegram X.Y.Z ...`.
- Update README.md (env table, peer deps) when public behavior or env vars change.

## Architecture notes

- **Memory is optional; gate is a dependency.** `@justfortytwo/memory` is an optional
  `peerDependency` (plus a devDependency for types/tests). The bridge loads it dynamically
  (`loadMemoryEngine`); if it is absent or fails to open, it runs **channel-only** (relays,
  does not persist). Only types are imported statically from memory. `@justfortytwo/gate`
  is a regular dependency because `attachments.ts` imports `createSourceEnvelope` at runtime.
- **`// TODO(wire):` markers** mark seams still stubbed locally: the gate's exact-command
  bash allowlist (`appendExactBashAllowlistEntry`, `bashAllowlistPath`), recording the
  approval outcome on memory's pending decision, gate's `parseToml`, and provenance types in
  `attachments.ts`. Do not copy peer code in; wire to the peer's export.
- **Binding store is self-owned** (`state/telegram-bindings.db`, override with
  `TELEGRAM_BINDINGS_DB`) so auth works without memory. Pending pairing challenges are
  persisted there too, so a code minted by another process (installer's `fortytwo pair`)
  is redeemable by the running bridge. Keep that file path/schema compatible with
  `../installer/src/commands/pair.ts`.
- `ChannelAdapter` (`adapter.ts`) is intentionally channel-agnostic for future adapters.
- `notify.ts` duck-types scheduler's `Notifier`; do not add a scheduler dependency.
- Paths resolve from `FORTYTWO_ROOT` (fallback `FORD_ROOT`, else the package root):
  `config/adapters.toml`, `state/bridge-state.json`, `state/telegram-bindings.db`,
  `db/fortytwo.db` (`DB_PATH`). See README for the full env table.

## Gotchas

- `bridge.ts` evaluates env, paths and `config/adapters.toml` at **module load**, and only
  calls `main()` when invoked as the bin (`invokedAsBin()` realpath check). Keep side-effect
  free helpers in other modules (that is why `env.ts` exists). Tests that import `bridge.ts`
  mock `@justfortytwo/runner`, `@justfortytwo/memory` and parts of `node:fs` with `vi.mock`.
- Do not create the runner at import time (lazy init was a deliberate fix).
- The bridge must be the **only** long-poller on the bot token.
- With no `ALLOWED_CHAT_IDS` and no stored binding, `main()` still starts (locked down, logs
  `pairingOnlyStartupNotice`); the first chat pairs via `/login <code>`. Do not reintroduce an
  exit there: it breaks fresh-install pairing (`test/bridge-bootstrap.test.ts`).
- When adding env vars that replace legacy `FORD_*` names, read them through `envCompat`.
- `better-sqlite3` is a native module (^12 for Node 24 prebuilts).

## Sibling repos (`../`)

Each directory under `justfortytwo/` is a separate package/repo:

- `runner` - `@justfortytwo/runner`, headless `claude` lifecycle/JSONL transport (dependency).
- `memory` (optional peer), `gate` (dependency) - described above.
- `scheduler` - lazily imports this package (`Telegram`, `parseAllowed`, `telegramNotifier`)
  to deliver proactive notifications; its `invokedAsBin()` mirrors the one in `bridge.ts`.
- `installer` - depends on this package; `fortytwo pair` mints pairing codes into the
  bindings db.
- Also present: `persona`, `salience`, `marketplace`, `website`, `docs`.

Changing exports in `src/index.ts` or the bindings db can break `scheduler` / `installer`.

## fortytwo project context

This repository is part of **fortytwo**, a local-first personal-assistant spine built around existing agent runtimes and tool ecosystems.

The umbrella project is **fortytwo**. It is not intended to replace Claude Code, Codex, MCP servers, plugins, skills, or other agent runtimes. The project provides the durable personal-assistant infrastructure around them: memory, lifecycle, scheduling, channels, optional policy enforcement, and related supporting components.

Claude Code is currently the primary/reference runtime, but the architecture should avoid unnecessary coupling to a specific model provider. In particular, components should remain usable when Claude Code itself is configured against alternative compatible model providers.

The main bootstrap and lifecycle entry point is the **installer** repository (`justfortytwo/installer`).

### Canonical project locations

- Website: `forty-two.it`
- GitHub organization: `github.com/justfortytwo`
- Architecture/design documentation: `justfortytwo/docs`

### Repositories

The fortytwo project is intentionally split into small, focused repositories.

- **`justfortytwo/installer`**
  Main installer and lifecycle CLI (`create-fortytwo` / `fortytwo`). This is the primary bootstrap entry point for assembling a fortytwo installation.

- **`justfortytwo/runner`**
  Thin Claude Code process/session runtime. Owns process lifecycle and stream transport, including one-shot runs and persistent interactive sessions. It must not become an agent framework.

- **`justfortytwo/memory`**
  Durable semantic-memory MCP server backed by local storage and retrieval infrastructure.

- **`justfortytwo/scheduler`**
  Durable scheduling and proactive job execution. Owns *when* work should happen, not how the agent reasons about or performs that work.

- **`justfortytwo/telegram`**
  Telegram transport/channel adapter. Owns Telegram identity, pairing, message transport, attachment handling, and mapping chats to live agent sessions. It should delegate agent process lifecycle to `runner`.

- **`justfortytwo/persona`**
  Persona and context templates rendered by the installer into an individual fortytwo installation.

- **`justfortytwo/gate`**
  Optional external safety/policy enforcement layer for tool execution and approvals. Keep this separate from the agent runtime's own reasoning and permissions.

- **`justfortytwo/salience`**
  Optional model-driven salience extraction used to enrich durable memory.

- **`justfortytwo/marketplace`**
  Claude Code plugin marketplace and umbrella plugin used as a distribution surface for fortytwo components.

- **`justfortytwo/docs`**
  Cross-repository architecture, design, contracts, and project documentation.

- **`justfortytwo/website`**
  Public website for the project, served as `forty-two.it`.

- **`justfortytwo/.github`**
  GitHub organization metadata and shared organization-level project information.

### Cross-repository architecture

When changing one repository, treat the sibling repositories as parts of the same system.

The intended high-level ownership is:

```text
channels / scheduler
        |
        v
      runner
        |
        v
   agent runtime
  (Claude Code today)
        |
        +---- MCPs / plugins / skills / tools
        |
        +---- fortytwo memory

optional surrounding components:
- gate
- salience

bootstrap / distribution / documentation:
- installer
- persona
- marketplace
- docs
- website
```

A useful rule when deciding where code belongs:

> fortytwo should add continuity and infrastructure around an existing agent, not reimplement capabilities already owned by the agent runtime or its MCP/plugin ecosystem.

Examples:

- agent reasoning, planning, subagents, tools, MCP orchestration, and plugins belong to the agent runtime;
- Claude process/session lifecycle belongs to `runner`;
- durable memory belongs to `memory`;
- durable time and scheduled execution belong to `scheduler`;
- Telegram transport and Telegram identity belong to `telegram`;
- installation and lifecycle management belong to `installer`;
- browser automation should normally come from an existing MCP/plugin rather than a fortytwo-specific browser implementation.

Before introducing a new abstraction, check the relevant sibling repositories and the agent runtime's existing capabilities to avoid duplicating functionality elsewhere in the fortytwo stack.
