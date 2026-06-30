// @justfortytwo/telegram — public API.
//
// The Telegram channel adapter for fortytwo: a long-polling bridge that
// drives a headless `claude` turn loop per chat, surfaces gate approvals as
// inline keyboards, and gates inbound access behind a login/pairing binding flow.
//
// Peer packages (declared in peerDependencies, NOT bundled):
//   - @justfortytwo/memory  (MEMORY_TOOL_CONTRACT_VERSION, tools mcp__fortytwo-memory__*)
//   - @justfortytwo/gate  (POLICY_SCHEMA_VERSION)
// See src/bridge.ts for the `// TODO(wire):` seams where these are wired.

// --- Channel transport (owned) ---
export {
  Telegram,
  parseAllowed,
  approvalKeyboard,
  messageAttachmentSpecs,
  largestPhoto,
  formatTelegramHtml,
  type TgMessage,
  type TgUpdate,
  type PhotoSize,
  type TgDocument,
  type AttachmentSpec,
  type ApprovalKeyboardOptions,
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
  formatApprovalCard,
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
