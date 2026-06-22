// TODO(extract): TEMPORARY local shim for the provenance-envelope primitives.
//
// These types/functions are NOT owned by @justfortytwo/telegram. They originate
// in fortytwo/services/memory-mcp/src/policy.ts and belong to the gate/memory
// side. This shim exists ONLY so the telegram package's owned attachment code
// (attachments.ts) compiles in isolation during the decomposition.
//
// RECONCILIATION: when @justfortytwo/gate (POLICY_SCHEMA_VERSION) re-exports
// `createSourceEnvelope`, `SourceEnvelope`, and `SourceKind`, DELETE this file
// and import from the peer package instead:
//   import { createSourceEnvelope, type SourceEnvelope, type SourceKind } from '@justfortytwo/gate';
//
// The shapes below are intentionally minimal and MUST be verified against the
// real gate contract — do not treat the `source_id` derivation here as canonical.

import { createHash } from 'node:crypto';

export type SourceKind =
  | 'owner_direct'
  | 'quoted_text'
  | 'telegram_message'
  | 'telegram_photo'
  | 'telegram_document'
  | 'document'
  | string;

export interface SourceEnvelopeInput {
  source_kind: SourceKind;
  content: string;
  actor?: string;
  channel?: string;
  metadata?: Record<string, unknown>;
}

export interface SourceEnvelope {
  source_id: string;
  source_kind: SourceKind;
  actor?: string;
  channel?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Placeholder envelope builder. Derives a deterministic source_id from the
 * envelope inputs. The REAL implementation (gate) is authoritative — this is a
 * compile-time stand-in only.
 */
export function createSourceEnvelope(input: SourceEnvelopeInput): SourceEnvelope {
  const source_id = createHash('sha256')
    .update(`${input.source_kind}:${input.channel ?? ''}:${input.actor ?? ''}:${input.content}`)
    .digest('hex')
    .slice(0, 32);
  return {
    source_id,
    source_kind: input.source_kind,
    actor: input.actor,
    channel: input.channel,
    metadata: input.metadata,
  };
}
