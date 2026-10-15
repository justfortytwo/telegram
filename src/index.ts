// @justfortytwo/telegram — public API.
//
// The Telegram channel adapter for fortytwo: a long-polling bridge that
// maintains a persistent Claude Code session per active chat and authorizes inbound
// access through login/pairing. Tool permissions belong to Claude Code.
//
// fortytwo packages (referenced, NOT bundled):
//   - @justfortytwo/memory  optional peer (MEMORY_TOOL_CONTRACT_VERSION, tools mcp__fortytwo-memory__*)
//   - @justfortytwo/gate    dependency: provenance envelopes (POLICY_SCHEMA_VERSION)

// --- Channel transport (owned) ---
export {
  Telegram,
  parseAllowed,
  messageAttachmentSpecs,
  largestPhoto,
  formatTelegramHtml,
  type TgMessage,
  type TgUpdate,
  type PhotoSize,
  type TgDocument,
  type AttachmentSpec,
} from './telegram.js';

// --- Attachments (owned; depends on @justfortytwo/gate's provenance contract) ---
export {
  buildAttachment,
  kindFromMime,
  extensionFor,
  inboxRelPath,
  withinSizeLimit,
  type Attachment,
  type AttachmentKind,
} from './attachments.js';

// --- Adapter config (owned) ---
export {
  loadAdaptersConfig,
  type AdaptersConfig,
  type TomlParser,
} from './adapters-config.js';

// --- Binding contract + store (owned) ---
export {
  TelegramAdapter,
  type ChannelAdapter,
  type Challenge,
  type ChallengeOptions,
} from './adapter.js';
export {
  MemoryBindingStore,
  SqliteBindingStore,
  type BindingStore,
  type Binding,
  type ChannelType,
} from './bindings.js';

// --- Login / authorization flow (owned) ---
export {
  handleAuthCommand,
  isAuthorized,
  isAuthCommand,
  type AuthContext,
  type LoginAction,
} from './login.js';

// --- Scheduler notifier adapter + deduped reply enqueuer ---
export {
  telegramNotifier,
  enqueueReply,
  type TelegramNotifierInstance,
  type Notification,
  type EnqueueReplyDeps,
} from './notify.js';

// --- Bridge turn-loop primitives (owned; pure decision logic is testable) ---
export {
  interpretResult,
  telegramSourceKind,
  hasHandleableContent,
  telegramCommandReply,
  buildInboundPrompt,
  ingestMessageAttachments,
  mapChannelEventToMemoryInput,
  type DeferredTool,
  type Interpreted,
  type AttachmentIo,
} from './bridge.js';
