import { createHash } from 'node:crypto';
// TODO(extract): SourceKind / SourceEnvelope / createSourceEnvelope are the
// provenance-envelope primitives owned by the gate/memory side (originally
// fortytwo/services/memory-mcp/src/policy.ts). They belong to a sibling package,
// NOT here. Once the gate package re-exports them, replace this local shim with:
//   import { createSourceEnvelope, type SourceEnvelope, type SourceKind } from '@justfortytwo/gate';
// For now we declare a minimal local shim so the attachment owner code compiles
// in isolation. The shape MUST match the gate contract on reconciliation.
import { createSourceEnvelope, type SourceEnvelope, type SourceKind } from './_peer-policy-shim.js';

export type AttachmentKind = 'image' | 'document' | 'audio' | 'other';

export interface Attachment {
  attachment_id: string;
  kind: AttachmentKind;
  mime: string;
  storage_ref: string;   // repo-relative path under the store dir
  byte_size: number;
  content_hash: string;  // sha256 of the bytes
  caption?: string;
  source_envelope: SourceEnvelope;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'application/pdf': 'pdf', 'text/plain': 'txt',
};

export function kindFromMime(mime: string): AttachmentKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || mime.startsWith('text/') || mime.startsWith('application/')) return 'document';
  return 'other';
}

export function extensionFor(mime: string, fileName?: string): string {
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  const dot = fileName ? fileName.lastIndexOf('.') : -1;
  if (fileName && dot >= 0 && dot < fileName.length - 1) {
    return fileName.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  }
  return 'bin';
}

export function inboxRelPath(storeDir: string, chatId: number, messageId: number, index: number, ext: string): string {
  const suffix = index > 0 ? `-${index}` : '';
  return `${storeDir}/${chatId}/${messageId}${suffix}.${ext}`;
}

export function withinSizeLimit(byteSize: number, maxBytes: number): boolean {
  return byteSize > 0 && byteSize <= maxBytes;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildAttachment(args: {
  bytes: Uint8Array;
  mime: string;
  sourceKind: SourceKind;
  storageRef: string;
  channel: string;
  actor?: string;
  caption?: string;
  fileName?: string;
}): Attachment {
  const contentHash = sha256Bytes(args.bytes);
  const envelope = createSourceEnvelope({
    source_kind: args.sourceKind,
    content: contentHash,
    actor: args.actor,
    channel: args.channel,
    metadata: { mime: args.mime, byte_size: args.bytes.length, storage_ref: args.storageRef, file_name: args.fileName },
  });
  return {
    attachment_id: envelope.source_id,
    kind: kindFromMime(args.mime),
    mime: args.mime,
    storage_ref: args.storageRef,
    byte_size: args.bytes.length,
    content_hash: contentHash,
    caption: args.caption,
    source_envelope: envelope,
  };
}
